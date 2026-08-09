import type { VolumeId } from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import { CHUNK_VOXEL_COUNT } from "./mesher.js";
import {
  HALO_CORNER_COUNT,
  HALO_EDGE_COUNT,
  HALO_EDGE_LENGTH,
  HALO_FACE_COUNT,
  HALO_SLICE_LENGTH,
} from "./halo.js";
import type { ChunkMeshInput, ChunkMeshOutput } from "./types.js";

/**
 * Meshing worker message protocol (plan S6.4/S6.6, ticket #23).
 *
 * The pool posts one `MeshingWorkerRequestMessage` per job and the worker
 * answers with exactly one `MeshingWorkerResponseMessage`. Typed-array
 * payloads are transferred (never copied) in both directions: the request
 * moves the copied core + halo buffers into the worker, and the result
 * moves the freshly built geometry back to the main thread.
 *
 * Both directions are parsed with `parse...` helpers that bound every
 * field before use — a worker never trusts message shape, and the pool
 * never trusts worker output — and results must reproduce the request's
 * namespace/volume/coordinate/revision tag before they may update the
 * scene.
 */

/** Bounded request wire shape (`parseMeshingRequestMessage` validates). */
export interface MeshingWorkerRequestMessage {
  readonly kind: "meshing-request";
  readonly requestId: number;
  readonly input: ChunkMeshInput;
}

/** Bounded response wire shape (`parseMeshingResponseMessage` validates). */
export type MeshingWorkerResponseMessage =
  | {
      readonly kind: "meshing-result";
      readonly requestId: number;
      readonly result: ChunkMeshOutput;
    }
  | {
      readonly kind: "meshing-error";
      readonly requestId: number;
      readonly message: string;
    };

/** Max absolute signed coordinate value accepted by the protocol. */
const MAX_PROTOCOL_COORDINATE = 1_048_576;

/** Accepted namespace shapes: the live document or `preview:<session>`.
 * Preview session ids are `preview:<documentId>:<baseRevision>:<seq>`
 * (document ids contain colons), so the tail is bounded but broad. */
const NAMESPACE_PATTERN = /^live$|^preview:[A-Za-z0-9_:.-]{1,96}$/;

/** True when `value` is a finite integer within the protocol bounds. */
function isBoundedInt(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** True when `value` is an integer equal to the expected coordinate. */
function isMatchingCoordinate(
  value: unknown,
  expected: number,
): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value === expected
  );
}

/** True when `value` is a Uint16Array of exactly `length`. */
function isUint16Array(value: unknown, length: number): value is Uint16Array {
  return (
    value instanceof Uint16Array &&
    value.byteLength === length * Uint16Array.BYTES_PER_ELEMENT
  );
}

/**
 * True when `value` is a Float32Array with a whole number of triples. An
 * empty mesh is legitimate: a chunk whose last voxels were removed meshes
 * to nothing and the scene disposes its geometry.
 */
function isFloat32Triples(value: unknown): value is Float32Array {
  return value instanceof Float32Array && value.length % 3 === 0;
}

/**
 * Parses and bounds one worker request message. Returns undefined for any
 * malformed or out-of-bounds message; the worker rejects those instead of
 * computing over them.
 */
export function parseMeshingRequestMessage(
  data: unknown,
): MeshingWorkerRequestMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Record<string, unknown>;
  if (message.kind !== "meshing-request") return undefined;
  if (!isBoundedInt(message.requestId, 0, 2_147_483_647)) return undefined;
  const input = message.input;
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;

  if (typeof record.namespace !== "string") return undefined;
  if (!NAMESPACE_PATTERN.test(record.namespace)) return undefined;
  if (typeof record.volumeId !== "string" || record.volumeId.length === 0) {
    return undefined;
  }
  const coordinate = record.coordinate;
  if (!Array.isArray(coordinate) || coordinate.length !== 3) {
    return undefined;
  }
  const parts: readonly unknown[] = coordinate;
  const coordinateX = parts[0];
  const coordinateY = parts[1];
  const coordinateZ = parts[2];
  if (
    !isBoundedInt(
      coordinateX,
      -MAX_PROTOCOL_COORDINATE,
      MAX_PROTOCOL_COORDINATE,
    ) ||
    !isBoundedInt(
      coordinateY,
      -MAX_PROTOCOL_COORDINATE,
      MAX_PROTOCOL_COORDINATE,
    ) ||
    !isBoundedInt(
      coordinateZ,
      -MAX_PROTOCOL_COORDINATE,
      MAX_PROTOCOL_COORDINATE,
    )
  ) {
    return undefined;
  }
  if (!isBoundedInt(record.revision, 0, 2_147_483_647)) return undefined;
  if (!isUint16Array(record.values, CHUNK_VOXEL_COUNT)) return undefined;

  const halo = record.halo;
  if (typeof halo !== "object" || halo === null) return undefined;
  const haloRecord = halo as Record<string, unknown>;
  if (!isUint16Array(haloRecord.faces, HALO_FACE_COUNT * HALO_SLICE_LENGTH)) {
    return undefined;
  }
  if (!isUint16Array(haloRecord.edges, HALO_EDGE_COUNT * HALO_EDGE_LENGTH)) {
    return undefined;
  }
  if (!isUint16Array(haloRecord.corners, HALO_CORNER_COUNT)) return undefined;

  return {
    kind: "meshing-request",
    requestId: message.requestId,
    input: {
      namespace: record.namespace as ChunkMeshInput["namespace"],
      volumeId: record.volumeId as VolumeId,
      coordinate: [coordinateX, coordinateY, coordinateZ],
      revision: record.revision,
      values: record.values,
      halo: {
        faces: haloRecord.faces,
        edges: haloRecord.edges,
        corners: haloRecord.corners,
      },
    },
  };
}

/** True when `value` is a non-negative integer index into `groups`. */
function isGroupIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Parses and bounds one worker response message. The result's identity
 * tags must match `request` exactly (namespace, volume, coordinate,
 * revision); anything else is a stale or corrupt response and is
 * rejected. Typed arrays must be non-empty whole triples/indices, and
 * material groups must be non-negative integers.
 */
export function parseMeshingResponseMessage(
  data: unknown,
  request: MeshingWorkerRequestMessage,
): MeshingWorkerResponseMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Record<string, unknown>;
  if (message.kind === "meshing-error") {
    if (message.requestId !== request.requestId) return undefined;
    if (typeof message.message !== "string") return undefined;
    return {
      kind: "meshing-error",
      requestId: request.requestId,
      message: message.message,
    };
  }
  if (message.kind !== "meshing-result") return undefined;
  if (message.requestId !== request.requestId) return undefined;
  const result = message.result;
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;

  if (record.namespace !== request.input.namespace) return undefined;
  if (record.volumeId !== request.input.volumeId) return undefined;
  const coordinate = record.coordinate;
  if (!Array.isArray(coordinate) || coordinate.length !== 3) {
    return undefined;
  }
  const parts: readonly unknown[] = coordinate;
  const coordinateX = parts[0];
  const coordinateY = parts[1];
  const coordinateZ = parts[2];
  if (
    !isMatchingCoordinate(coordinateX, request.input.coordinate[0]) ||
    !isMatchingCoordinate(coordinateY, request.input.coordinate[1]) ||
    !isMatchingCoordinate(coordinateZ, request.input.coordinate[2])
  ) {
    return undefined;
  }
  if (record.revision !== request.input.revision) return undefined;
  if (!isFloat32Triples(record.positions)) return undefined;
  if (
    !isBoundedInt(record.voxelCount, 0, CHUNK_VOXEL_COUNT) ||
    !isBoundedInt(record.faceCount, 0, 2_147_483_647)
  ) {
    return undefined;
  }
  if (!isFloat32Triples(record.normals)) return undefined;
  if (
    !(record.indices instanceof Uint32Array) ||
    record.indices.length % 3 !== 0
  ) {
    return undefined;
  }
  // Every index must reference an emitted vertex, so a corrupt response
  // can never install out-of-range geometry.
  const positions = record.positions;
  const indices = record.indices;
  const vertexCount = positions.length / 3;
  for (let index = 0; index < indices.length; index += 1) {
    if ((indices[index] as number) >= vertexCount) return undefined;
  }
  if (!Array.isArray(record.materialGroups)) return undefined;
  for (const group of record.materialGroups) {
    if (typeof group !== "object" || group === null) return undefined;
    const groupRecord = group as Record<string, unknown>;
    if (!isBoundedInt(groupRecord.materialId, 1, 65_535)) return undefined;
    if (!isGroupIndex(groupRecord.start)) return undefined;
    if (!isGroupIndex(groupRecord.count)) return undefined;
    const start = groupRecord.start;
    const count = groupRecord.count;
    if (start + count > record.indices.length) {
      return undefined;
    }
  }
  return {
    kind: "meshing-result",
    requestId: request.requestId,
    result: {
      namespace: record.namespace as ChunkMeshOutput["namespace"],
      volumeId: record.volumeId as VolumeId,
      coordinate: [coordinateX, coordinateY, coordinateZ],
      revision: record.revision,
      positions: record.positions,
      normals: record.normals,
      indices: record.indices,
      materialGroups:
        record.materialGroups as ChunkMeshOutput["materialGroups"],
      voxelCount: record.voxelCount,
      faceCount: record.faceCount,
    },
  };
}

/** Transfer list for a request: every copied input buffer moves to the worker. */
export function meshingRequestTransfer(input: ChunkMeshInput): Transferable[] {
  return [input.values, input.halo.faces, input.halo.edges, input.halo.corners];
}

/** Transfer list for a result: the freshly built geometry moves back. */
export function meshingResultTransfer(result: ChunkMeshOutput): Transferable[] {
  return [result.positions, result.normals, result.indices];
}

/** Stable human-readable key for one chunk identity (protocol errors). */
export function meshingKey(
  namespace: ChunkMeshInput["namespace"],
  volumeId: VolumeId,
  coordinate: Vec3i,
): string {
  return `${namespace}:${volumeId}:${String(coordinate[0])},${String(
    coordinate[1],
  )},${String(coordinate[2])}`;
}
