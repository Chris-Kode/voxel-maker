import type { MaterialId, VolumeId } from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import type { ChunkHalo } from "./halo.js";

/**
 * Scene namespace (plan S6.4, ADR-0005): the live document or an isolated
 * `preview:<session>` overlay. Results from one namespace can never update
 * another.
 */
export type ChunkNamespace = "live" | `preview:${string}`;

/**
 * Immutable mesh request/transfer DTO (plan S6.4, ticket #23). Both
 * buffers are always COPIES of authoritative storage — the 4096 core
 * values plus the one-voxel halo — never backing memory, so workers can
 * compute over them without touching semantic state. The DTO is fully
 * transferable: `values` and `halo` typed arrays can be moved into a
 * worker without copying.
 */
export interface ChunkMeshInput {
  readonly namespace: ChunkNamespace;
  readonly volumeId: VolumeId;
  readonly coordinate: Vec3i;
  /** In-session chunk revision at dispatch; stale results must be rejected. */
  readonly revision: number;
  /** 4096 X-fastest material values (0 = empty) copied from the chunk. */
  readonly values: Uint16Array;
  /** Copied one-voxel halo around the chunk (see `halo.ts` layout). */
  readonly halo: ChunkHalo;
}

/**
 * One contiguous index range rendered with one material (plan S6.5
 * "material groups"). `start`/`count` index into `ChunkMeshOutput.indices`.
 */
export interface MeshMaterialGroup {
  readonly materialId: MaterialId;
  readonly start: number;
  readonly count: number;
}

/**
 * Deterministic face-culled mesh output (plan S6.4/S6.5). Typed arrays are
 * freshly allocated per chunk; groups cover every emitted index exactly
 * once, in ascending order.
 */
export interface ChunkMeshOutput {
  readonly namespace: ChunkNamespace;
  readonly volumeId: VolumeId;
  readonly coordinate: Vec3i;
  readonly revision: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly materialGroups: readonly MeshMaterialGroup[];
  readonly voxelCount: number;
  readonly faceCount: number;
}

/**
 * The pure geometry half of a chunk mesh: typed arrays plus material
 * groups. Callers compose it with namespace/identity/revision tags into a
 * full `ChunkMeshOutput` DTO.
 */
export interface ChunkMeshGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly materialGroups: readonly MeshMaterialGroup[];
  readonly voxelCount: number;
  readonly faceCount: number;
}

/**
 * Local-coordinate material sampler over a chunk including the one-voxel
 * halo (`[-1, 16)` per axis). Returns 0 for empty space. The renderer
 * supplies a volume-backed sampler; workers receive copied data.
 */
export type ChunkSampler = (
  localX: number,
  localY: number,
  localZ: number,
) => MaterialId;

/** Identity of one chunk in one namespace, used for stale-result checks. */
export interface ChunkMeshKey {
  readonly namespace: ChunkNamespace;
  readonly volumeId: VolumeId;
  readonly coordinate: Vec3i;
}

/**
 * Stale-result predicate (plan S6.4, ADR-0005): a worker result may update
 * the scene only when namespace, volume, coordinate, and revision all still
 * match the latest request. Completion order never decides visible state.
 */
export function isChunkMeshStale(
  request: ChunkMeshKey & { readonly revision: number },
  latest: ChunkMeshKey & { readonly revision: number },
): boolean {
  return (
    request.namespace !== latest.namespace ||
    request.volumeId !== latest.volumeId ||
    request.coordinate[0] !== latest.coordinate[0] ||
    request.coordinate[1] !== latest.coordinate[1] ||
    request.coordinate[2] !== latest.coordinate[2] ||
    request.revision !== latest.revision
  );
}
