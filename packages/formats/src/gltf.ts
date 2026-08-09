import { WorkspaceError } from "@voxel-maker/shared";
import {
  DEFAULT_GLTF_EXPORT_LIMITS,
  GLTF_COMPONENT_FLOAT,
  GLTF_COMPONENT_UNSIGNED_INT,
  GLTF_ERROR_CODES,
  GLTF_GENERATOR,
  GLTF_JSON_VERSION,
  GLTF_MODE_TRIANGLES,
  GLTF_TARGET_ARRAY_BUFFER,
  GLTF_TARGET_ELEMENT_ARRAY_BUFFER,
  type GltfExportLimits,
  type GltfSceneGraph,
} from "./gltf-types.js";

/**
 * Deterministic glTF 2.0 / GLB encoder (plan S16.3, ADR-0011, ticket #41).
 * The encoder turns the frozen export scene graph into stable bytes: the
 * JSON key order, accessor layout, buffer layout, and padding are fixed,
 * so the same document always produces the same file. `encodeGltfJson`
 * embeds the buffer as a base64 data URI (a single self-contained `.gltf`
 * file); `encodeGlb` produces the binary GLB container. Both honor the
 * `maxTotalBytes` resource limit and throw a structured `limit`-family
 * error before any file is written.
 */

/** Base64 alphabet (RFC 4648) for the embedded `.gltf` buffer. */
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const base64Char = (index: number): string => BASE64_ALPHABET[index] as string;

/** Deterministic base64 of a byte buffer (no Buffer/DOM dependency). */
function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const b0 = bytes[offset] ?? 0;
    const b1 = bytes[offset + 1] ?? 0;
    const b2 = bytes[offset + 2] ?? 0;
    out += base64Char(b0 >> 2);
    out += base64Char(((b0 & 0x03) << 4) | (b1 >> 4));
    out +=
      offset + 1 < bytes.byteLength
        ? base64Char(((b1 & 0x0f) << 2) | (b2 >> 6))
        : "=";
    out += offset + 2 < bytes.byteLength ? base64Char(b2 & 0x3f) : "=";
  }
  return out;
}

/** One accessor in deterministic JSON form. */
interface AccessorExport {
  readonly bufferView: number;
  readonly byteOffset: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: "VEC3" | "SCALAR" | "VEC4";
  readonly min?: readonly number[];
  readonly max?: readonly number[];
}

/** One bufferView in deterministic JSON form; `target` is omitted for data views. */
interface BufferViewExport {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly target?: number;
}

/** Accessor indices for one mesh (position, normal, one per primitive). */
interface MeshAccessorPlan {
  readonly positionAccessor: number;
  readonly normalAccessor: number;
  readonly primitiveAccessors: readonly number[];
}

/** Accessor indices for one animation sampler (input times, output values). */
interface SamplerAccessorPlan {
  readonly inputAccessor: number;
  readonly outputAccessor: number;
}

/** Accessor plans for one animation, aligned with its sampler order. */
interface AnimationAccessorPlan {
  readonly samplers: readonly SamplerAccessorPlan[];
}

/** The assembled binary buffer plus its accessor/bufferView plans. */
interface BuiltBuffer {
  readonly bytes: Uint8Array;
  readonly accessors: readonly AccessorExport[];
  readonly bufferViews: readonly BufferViewExport[];
  readonly meshes: readonly MeshAccessorPlan[];
  readonly animations: readonly AnimationAccessorPlan[];
}

const minOf = (values: Float32Array, width: number): number[] => {
  const min = Array.from({ length: width }, () => Number.POSITIVE_INFINITY);
  for (let i = 0; i < values.length; i += 1) {
    const component = i % width;
    const value = values[i] as number;
    if (value < (min[component] as number)) min[component] = value;
  }
  return min;
};

const maxOf = (values: Float32Array, width: number): number[] => {
  const max = Array.from({ length: width }, () => Number.NEGATIVE_INFINITY);
  for (let i = 0; i < values.length; i += 1) {
    const component = i % width;
    const value = values[i] as number;
    if (value > (max[component] as number)) max[component] = value;
  }
  return max;
};

/**
 * Assembles the single binary buffer and the accessor/bufferView plans in
 * deterministic order: per mesh, positions, normals, then one index range
 * per primitive. Every element is 4-byte aligned (float32/uint32), so the
 * byte offsets need no alignment padding.
 */
function buildBuffer(sceneGraph: GltfSceneGraph): BuiltBuffer {
  const parts: Uint8Array[] = [];
  const accessors: AccessorExport[] = [];
  const bufferViews: BufferViewExport[] = [];
  const meshPlans: MeshAccessorPlan[] = [];
  let offset = 0;

  const pushView = (
    bytes: Uint8Array,
    target: number | undefined,
  ): { readonly viewIndex: number; readonly byteOffset: number } => {
    parts.push(bytes);
    const byteOffset = offset;
    bufferViews.push({
      byteOffset,
      byteLength: bytes.byteLength,
      ...(target !== undefined ? { target } : {}),
    });
    offset += bytes.byteLength;
    return { viewIndex: bufferViews.length - 1, byteOffset };
  };

  for (const mesh of sceneGraph.meshes) {
    const positionBytes = new Uint8Array(
      mesh.positions.buffer,
      mesh.positions.byteOffset,
      mesh.positions.byteLength,
    );
    const normalBytes = new Uint8Array(
      mesh.normals.buffer,
      mesh.normals.byteOffset,
      mesh.normals.byteLength,
    );
    const position = pushView(positionBytes, GLTF_TARGET_ARRAY_BUFFER);
    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: position.viewIndex,
      byteOffset: 0,
      componentType: GLTF_COMPONENT_FLOAT,
      count: mesh.positions.length / 3,
      type: "VEC3",
      min: minOf(mesh.positions, 3),
      max: maxOf(mesh.positions, 3),
    });
    const normal = pushView(normalBytes, GLTF_TARGET_ARRAY_BUFFER);
    const normalAccessor = accessors.length;
    accessors.push({
      bufferView: normal.viewIndex,
      byteOffset: 0,
      componentType: GLTF_COMPONENT_FLOAT,
      count: mesh.normals.length / 3,
      type: "VEC3",
    });
    const primitiveAccessors: number[] = [];
    for (const primitive of mesh.primitives) {
      const indexBytes = new Uint8Array(
        primitive.indices.buffer,
        primitive.indices.byteOffset,
        primitive.indices.byteLength,
      );
      const indexView = pushView(indexBytes, GLTF_TARGET_ELEMENT_ARRAY_BUFFER);
      primitiveAccessors.push(accessors.length);
      accessors.push({
        bufferView: indexView.viewIndex,
        byteOffset: 0,
        componentType: GLTF_COMPONENT_UNSIGNED_INT,
        count: primitive.indices.length,
        type: "SCALAR",
      });
    }
    meshPlans.push({
      positionAccessor,
      normalAccessor,
      primitiveAccessors,
    });
  }

  // Animation data: per animation, per sampler in order, the input times
  // (SCALAR float with min/max) then the output values (VEC3/VEC4 float).
  // Every element is 4-byte aligned, so no alignment padding is needed.
  const animationPlans: AnimationAccessorPlan[] = [];
  for (const animation of sceneGraph.animations ?? []) {
    const samplerPlans: SamplerAccessorPlan[] = [];
    for (const sampler of animation.samplers) {
      const timeBytes = new Uint8Array(
        sampler.input.buffer,
        sampler.input.byteOffset,
        sampler.input.byteLength,
      );
      const timeView = pushView(timeBytes, undefined);
      const inputAccessor = accessors.length;
      accessors.push({
        bufferView: timeView.viewIndex,
        byteOffset: 0,
        componentType: GLTF_COMPONENT_FLOAT,
        count: sampler.input.length,
        type: "SCALAR",
        min: minOf(sampler.input, 1),
        max: maxOf(sampler.input, 1),
      });
      const valueBytes = new Uint8Array(
        sampler.output.buffer,
        sampler.output.byteOffset,
        sampler.output.byteLength,
      );
      const valueView = pushView(valueBytes, undefined);
      samplerPlans.push({
        inputAccessor,
        outputAccessor: accessors.length,
      });
      accessors.push({
        bufferView: valueView.viewIndex,
        byteOffset: 0,
        componentType: GLTF_COMPONENT_FLOAT,
        count: sampler.output.length / (sampler.outputType === "VEC4" ? 4 : 3),
        type: sampler.outputType,
      });
    }
    animationPlans.push({ samplers: samplerPlans });
  }

  const bytes = new Uint8Array(offset);
  let target = 0;
  for (const part of parts) {
    bytes.set(part, target);
    target += part.byteLength;
  }
  return { bytes, accessors, bufferViews, meshes: meshPlans, animations: animationPlans };
}

const nodeToJson = (
  node: GltfSceneGraph["nodes"][number],
): Record<string, unknown> => {
  const out: Record<string, unknown> = { name: node.name };
  if (node.translation !== undefined) out.translation = [...node.translation];
  if (node.rotation !== undefined) out.rotation = [...node.rotation];
  if (node.scale !== undefined) out.scale = [...node.scale];
  if (node.mesh !== undefined) out.mesh = node.mesh;
  if (node.children !== undefined) out.children = [...node.children];
  return out;
};

const materialToJson = (
  material: GltfSceneGraph["materials"][number],
): Record<string, unknown> => ({
  name: material.name,
  pbrMetallicRoughness: {
    baseColorFactor: [...material.baseColorFactor],
    metallicFactor: material.metallicFactor,
    roughnessFactor: material.roughnessFactor,
  },
  emissiveFactor: [...material.emissiveFactor],
  alphaMode: material.alphaMode,
});

const accessorToJson = (accessor: AccessorExport): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    bufferView: accessor.bufferView,
    componentType: accessor.componentType,
    count: accessor.count,
    type: accessor.type,
  };
  if (accessor.byteOffset !== 0) out.byteOffset = accessor.byteOffset;
  if (accessor.min !== undefined) out.min = [...accessor.min];
  if (accessor.max !== undefined) out.max = [...accessor.max];
  return out;
};

const bufferViewToJson = (view: BufferViewExport): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    buffer: 0,
    byteLength: view.byteLength,
  };
  if (view.target !== undefined) out.target = view.target;
  if (view.byteOffset !== 0) out.byteOffset = view.byteOffset;
  return out;
};

/**
 * Builds the deterministic glTF JSON document. `bufferUri` is the data URI
 * for `.gltf` output and undefined for GLB (whose buffer is the BIN chunk).
 */
function buildGltfJson(
  sceneGraph: GltfSceneGraph,
  built: BuiltBuffer,
  bufferUri: string | undefined,
): string {
  const meshes = sceneGraph.meshes.map((mesh, meshIndex) => {
    const plan = built.meshes[meshIndex];
    if (plan === undefined) {
      throw new WorkspaceError({
        family: "internal",
        code: "GLTF_ACCESSOR_MISSING",
        message: "Mesh missing from the buffer plan",
        context: { mesh: meshIndex },
      });
    }
    const positionAccessor = plan.positionAccessor;
    const normalAccessor = plan.normalAccessor;
    return {
      name: mesh.name,
      primitives: mesh.primitives.map((primitive, primitiveIndex) => ({
        attributes: {
          POSITION: positionAccessor,
          NORMAL: normalAccessor,
        },
        indices: plan.primitiveAccessors[primitiveIndex],
        material: primitive.materialIndex,
        mode: GLTF_MODE_TRIANGLES,
      })),
    };
  });

  const buffers = built.bytes.byteLength;
  const buffersJson: Record<string, unknown>[] =
    bufferUri === undefined
      ? [{ byteLength: buffers }]
      : [{ uri: bufferUri, byteLength: buffers }];

  const animations = sceneGraph.animations ?? [];
  const animationsJson = animations.map((animation, animationIndex) => {
    const plan = built.animations[animationIndex];
    if (plan === undefined) {
      throw new WorkspaceError({
        family: "internal",
        code: "GLTF_ANIMATION_MISSING",
        message: "Animation missing from the buffer plan",
        context: { animation: animationIndex },
      });
    }
    return {
      name: animation.name,
      channels: animation.channels.map((channel) => ({
        sampler: channel.sampler,
        target: { node: channel.node, path: channel.path },
      })),
      samplers: animation.samplers.map((sampler, samplerIndex) => {
        const samplerPlan = plan.samplers[samplerIndex];
        if (samplerPlan === undefined) {
          throw new WorkspaceError({
            family: "internal",
            code: "GLTF_ANIMATION_MISSING",
            message: "Animation sampler missing from the buffer plan",
            context: { animation: animationIndex, sampler: samplerIndex },
          });
        }
        return {
          input: samplerPlan.inputAccessor,
          output: samplerPlan.outputAccessor,
          interpolation: sampler.interpolation,
        };
      }),
    };
  });

  const json: Record<string, unknown> = {
    asset: { version: GLTF_JSON_VERSION, generator: GLTF_GENERATOR },
    scene: 0,
    scenes: [{ nodes: [...sceneGraph.sceneNodes] }],
    nodes: sceneGraph.nodes.map(nodeToJson),
    meshes,
    materials: sceneGraph.materials.map(materialToJson),
    ...(animationsJson.length > 0 ? { animations: animationsJson } : {}),
    accessors: built.accessors.map(accessorToJson),
    bufferViews: built.bufferViews.map(bufferViewToJson),
    buffers: buffersJson,
  };
  return JSON.stringify(json);
}

/** Throws the structured byte-limit error when the output is too large. */
function assertWithinByteLimit(
  jsonBytes: number,
  bufferBytes: number,
  limits: GltfExportLimits,
): void {
  const total = jsonBytes + bufferBytes;
  if (total > limits.maxTotalBytes) {
    throw new WorkspaceError({
      family: "limit",
      code: GLTF_ERROR_CODES.fileTooLarge,
      message: "glTF export exceeds the output byte limit",
      context: { bytes: total, limit: limits.maxTotalBytes },
    });
  }
}

/** Result of a `.gltf` (JSON) encoding. */
export interface GltfJsonEncoded {
  /** The complete `.gltf` JSON text including the embedded data URI. */
  readonly json: string;
  /** The raw binary buffer (the data URI payload). */
  readonly buffer: Uint8Array;
}

/**
 * Encodes the scene graph as self-contained glTF 2.0 JSON with the buffer
 * embedded as a base64 `data:` URI, so one scoped atomic write produces a
 * complete `.gltf` file (ADR-0011 scoped atomic write policy).
 */
export function encodeGltfJson(
  sceneGraph: GltfSceneGraph,
  limits: GltfExportLimits = DEFAULT_GLTF_EXPORT_LIMITS,
): GltfJsonEncoded {
  const built = buildBuffer(sceneGraph);
  const json = buildGltfJson(
    sceneGraph,
    built,
    `data:application/octet-stream;base64,${encodeBase64(built.bytes)}`,
  );
  assertWithinByteLimit(
    new TextEncoder().encode(json).byteLength,
    built.bytes.byteLength,
    limits,
  );
  return { json, buffer: built.bytes };
}

const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_HEADER_BYTES = 8;
const GLB_JSON_TYPE = 0x4e4f534a; // "JSON"
const GLB_BIN_TYPE = 0x004e4942; // "BIN "

const padTo = (
  bytes: Uint8Array,
  multiple: number,
  fill: number,
): Uint8Array => {
  const remainder = bytes.byteLength % multiple;
  if (remainder === 0) return bytes;
  const padded = new Uint8Array(bytes.byteLength + (multiple - remainder));
  padded.set(bytes, 0);
  padded.fill(fill, bytes.byteLength);
  return padded;
};

/**
 * Encodes the scene graph as a binary GLB container (glTF 2.0): 12-byte
 * header, JSON chunk padded with spaces, BIN chunk padded with zeros. The
 * buffer's `byteLength` is the unpadded binary length.
 */
export function encodeGlb(
  sceneGraph: GltfSceneGraph,
  limits: GltfExportLimits = DEFAULT_GLTF_EXPORT_LIMITS,
): Uint8Array {
  const built = buildBuffer(sceneGraph);
  const json = buildGltfJson(sceneGraph, built, undefined);
  const jsonBytes = new TextEncoder().encode(json);
  assertWithinByteLimit(jsonBytes.byteLength, built.bytes.byteLength, limits);
  const jsonPadded = padTo(jsonBytes, 4, 0x20);
  const binPadded = padTo(built.bytes, 4, 0x00);
  const total =
    GLB_HEADER_BYTES +
    GLB_CHUNK_HEADER_BYTES +
    jsonPadded.byteLength +
    GLB_CHUNK_HEADER_BYTES +
    binPadded.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0] = 0x67; // "g"
  out[1] = 0x6c; // "l"
  out[2] = 0x54; // "T"
  out[3] = 0x46; // "F"
  view.setUint32(4, 2, true); // glTF 2.0
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.byteLength, true);
  view.setUint32(16, GLB_JSON_TYPE, true);
  out.set(jsonPadded, 20);
  const binStart = 20 + jsonPadded.byteLength;
  view.setUint32(binStart, binPadded.byteLength, true);
  view.setUint32(binStart + 4, GLB_BIN_TYPE, true);
  out.set(binPadded, binStart + 8);
  return out;
}
