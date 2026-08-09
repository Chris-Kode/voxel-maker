import type { MaterialId, NodeId, VolumeId } from "@voxel-maker/shared";
import type { Quat, Vec3 } from "@voxel-maker/math";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";

/**
 * Shared types for the glTF 2.0 / GLB exporter (ADR-0011, plan
 * S16.1-S16.4, tickets #41/#42). The exporter works directly on the
 * frozen document and the session volume read views; it never touches
 * renderer objects (plan S16.2 "renderer-independent mesh DTO").
 */

/** glTF 2.0 asset version written by every export. */
export const GLTF_JSON_VERSION = "2.0";

/** Deterministic generator string (ADR-0011 deterministic naming). */
export const GLTF_GENERATOR = "voxel-maker";

/** One voxel edge maps to one meter (ADR-0011). */
export const GLTF_METERS_PER_VOXEL = 1;

/** glTF accessor componentType values emitted by the exporter. */
export const GLTF_COMPONENT_FLOAT = 5126;
export const GLTF_COMPONENT_UNSIGNED_INT = 5125;

/** glTF bufferView targets emitted by the exporter. */
export const GLTF_TARGET_ARRAY_BUFFER = 34962;
export const GLTF_TARGET_ELEMENT_ARRAY_BUFFER = 34963;

/** glTF primitive mode: triangles. */
export const GLTF_MODE_TRIANGLES = 4;

/** Stable error codes thrown by the exporter (family "limit"/"validation"). */
export const GLTF_ERROR_CODES = {
  faceLimit: "GLTF_FACE_LIMIT",
  fileTooLarge: "GLTF_FILE_TOO_LARGE",
} as const;

/** Resource limits for one glTF export (ADR-0009 escalation policy). */
export interface GltfExportLimits {
  /**
   * Hard cap on emitted faces for one volume. The mesher counts faces as it
   * emits and throws `GLTF_FACE_LIMIT` at the cap, so hostile or sparse
   * content can never allocate unbounded geometry.
   */
  readonly maxFacesPerVolume: number;
  /** Hard cap on emitted faces across all volumes of one export. */
  readonly maxTotalFaces: number;
  /** Hard cap on encoded output bytes (JSON + buffer) of one export. */
  readonly maxTotalBytes: number;
  /**
   * Hard cap on interior linear samples emitted per segment when a
   * smoothstep track is baked to LINEAR (ADR-0011); callers may only
   * lower the default, which trades fidelity for output size.
   */
  readonly maxSmoothstepSamplesPerSegment: number;
}

/** ADR-0009-style hard defaults for one glTF export; callers may only lower. */
export const DEFAULT_GLTF_EXPORT_LIMITS: GltfExportLimits = Object.freeze({
  maxFacesPerVolume: 1_000_000,
  maxTotalFaces: 4_000_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxSmoothstepSamplesPerSegment: 16,
});

/** Stable export loss codes (ADR-0011 loss report). */
export const GLTF_EXPORT_LOSSES = {
  noVolumes: "GLTF_LOSS_NO_VOLUMES",
  missingVolume: "GLTF_LOSS_MISSING_VOLUME",
  clips: "GLTF_LOSS_CLIPS",
  clipLoop: "GLTF_LOSS_CLIP_LOOP",
  smoothstep: "GLTF_LOSS_SMOOTHSTEP",
  constraints: "GLTF_LOSS_CONSTRAINTS",
  joints: "GLTF_LOSS_JOINTS",
  metadata: "GLTF_LOSS_METADATA",
  emptyVolume: "GLTF_LOSS_EMPTY_VOLUME",
} as const;

/** One reported export loss; `blocked` losses abort the export. */
export interface GltfExportLoss {
  readonly code: string;
  readonly message: string;
  /** "bake" losses are applied and reported; "block" losses abort. */
  readonly severity: "bake" | "block";
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

/** Result of the export preflight: either a loss report or a block. */
export type GltfExportPreflight =
  | { readonly ok: true; readonly losses: readonly GltfExportLoss[] }
  | { readonly ok: false; readonly blocked: readonly GltfExportLoss[] };

/** Volume read access used by the export preflight and plan. */
export type GltfVolumeAccess = (
  volumeId: VolumeId,
) => VoxelVolumeReadView | undefined;

/**
 * One contiguous index range rendered with one material (plan S6.5
 * convention). `start`/`count` index into `GltfMeshData.indices`.
 */
export interface GltfMeshMaterialGroup {
  readonly materialId: MaterialId;
  readonly start: number;
  readonly count: number;
}

/**
 * Renderer-independent indexed triangle mesh of one Voxel Volume (plan
 * S16.2): freshly allocated typed arrays in editor-space meters, plus
 * ascending contiguous material groups. No `BufferGeometry` dependency.
 */
export interface GltfMeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly materialGroups: readonly GltfMeshMaterialGroup[];
  readonly voxelCount: number;
  readonly faceCount: number;
}

/** One glTF material in deterministic export form (ADR-0011 mapping). */
export interface GltfMaterialExport {
  readonly name: string;
  /** `[r, g, b, a]` in 0..1; alpha below 1 selects `BLEND`. */
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly emissiveFactor: readonly [number, number, number];
  readonly alphaMode: "OPAQUE" | "BLEND";
}

/** One primitive of a mesh: a material group's index slice. */
export interface GltfPrimitiveExport {
  readonly materialIndex: number;
  /** A subarray view of the mesh indices (never a copy). */
  readonly indices: Uint32Array;
}

/** glTF animation sampler interpolation modes emitted by the exporter. */
export const GLTF_INTERPOLATION_STEP = "STEP";
export const GLTF_INTERPOLATION_LINEAR = "LINEAR";

/** One glTF animation channel target path (a TRS property). */
export type GltfAnimationChannelPath = "translation" | "rotation" | "scale";

/** One channel: one sampler applied to one TRS property of one node. */
export interface GltfAnimationChannel {
  readonly sampler: number;
  readonly node: number;
  readonly path: GltfAnimationChannelPath;
}

/**
 * One animation sampler: typed keyframe data plus the deterministic
 * interpolation mode. `input` holds strictly increasing times in seconds
 * (SCALAR float accessor with min/max); `output` holds one `outputType`
 * value per input sample (VEC3 translation/scale, VEC4 rotation). All
 * values are authored or baked canonical values (ADR-0011).
 */
export interface GltfAnimationSampler {
  readonly input: Float32Array;
  readonly output: Float32Array;
  readonly interpolation: "STEP" | "LINEAR";
  readonly outputType: "VEC3" | "VEC4";
}

/**
 * One glTF animation: a named clip mapped to channels plus samplers
 * (ADR-0011). Channels reference samplers by index within this animation.
 */
export interface GltfAnimationExport {
  readonly name: string;
  readonly channels: readonly GltfAnimationChannel[];
  readonly samplers: readonly GltfAnimationSampler[];
}

/** One mesh: shared positions/normals plus one primitive per material. */
export interface GltfMeshExport {
  readonly name: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly primitives: readonly GltfPrimitiveExport[];
}

/** One glTF node in deterministic export form; absent fields use defaults. */
export interface GltfNodeExport {
  readonly name: string;
  readonly translation?: Vec3;
  readonly rotation?: Quat;
  readonly scale?: Vec3;
  readonly mesh?: number;
  readonly children?: readonly number[];
}

/** Helper identity for one pivoted document node (ADR-0011 export metadata). */
export interface GltfPivotHelperReport {
  readonly nodeId: NodeId;
  readonly name: string;
  readonly helperNodes: readonly string[];
}

/** Deterministic export metadata returned with every export. */
export interface GltfExportMetadata {
  readonly generator: string;
  readonly metersPerVoxel: 1;
  readonly pivotHelpers: readonly GltfPivotHelperReport[];
  readonly nodes: number;
  readonly meshes: number;
  readonly materials: number;
  readonly faces: number;
  readonly voxels: number;
  /** Number of exported clips (glTF animations). */
  readonly clips: number;
}

/**
 * The complete export scene graph: glTF-shaped nodes, meshes, materials,
 * animations, the scene root indices, export metadata, and the applied
 * loss report. The encoder turns this into deterministic glTF JSON and a
 * binary buffer without touching the document again. `animations` is
 * absent for static-only scene graphs (the JSON key is then omitted).
 */
export interface GltfSceneGraph {
  readonly sceneNodes: readonly number[];
  readonly nodes: readonly GltfNodeExport[];
  readonly meshes: readonly GltfMeshExport[];
  readonly materials: readonly GltfMaterialExport[];
  readonly animations?: readonly GltfAnimationExport[];
  readonly metadata: GltfExportMetadata;
  readonly losses: readonly GltfExportLoss[];
}
