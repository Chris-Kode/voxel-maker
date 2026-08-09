/**
 * Public entry point for the renderer package: the disposable Three.js
 * scene projection (plan S6.3/S6.7), the incremental meshing pipeline
 * (copied chunk-and-halo DTOs S6.4, worker pool S6.6, dirty-chunk
 * scheduler S6.8, worker protocol and scope glue), the face-culling
 * mesher (S6.5), the material adapter (S6.9), viewport diagnostics
 * (S6.14), deterministic viewport picking plus world-bounds queries
 * (S6.12, ADR-0005), and the standard preview render protocol with a
 * deterministic software renderer (S8.5/S15.1/S15.2, ticket #25). Core
 * semantic packages never import this module.
 */
export {
  createMaterialAdapter,
  type MaterialAdapter,
} from "./material-adapter.js";
export {
  createMeshingPool,
  type MeshingExecutor,
  type MeshingJob,
  type MeshingJobHandle,
  type MeshingOutcome,
  type MeshingPool,
  type MeshingPoolCallbacks,
  type MeshingPoolDiagnostics,
  type MeshingPoolOptions,
} from "./meshing-pool.js";
export {
  createInProcessMeshingExecutor,
  createWorkerMeshingExecutor,
  type MeshingWorkerLike,
} from "./meshing-executors.js";
export {
  createMeshingWorkerScope,
  handleMeshingRequest,
  type MeshingWorkerScope,
} from "./meshing-worker.js";
export {
  createChunkScheduler,
  type ChunkScheduleSpec,
  type ChunkScheduler,
  type ChunkSchedulerDiagnostics,
  type ChunkSchedulerOptions,
} from "./chunk-scheduler.js";
export {
  meshingKey,
  meshingRequestTransfer,
  meshingResultTransfer,
  parseMeshingRequestMessage,
  parseMeshingResponseMessage,
  type MeshingWorkerRequestMessage,
  type MeshingWorkerResponseMessage,
} from "./worker-protocol.js";
export {
  createChunkHalo,
  createHaloSampler,
  HALO_CORNER_COUNT,
  HALO_EDGE_COUNT,
  HALO_EDGE_LENGTH,
  HALO_FACE_COUNT,
  HALO_SLICE_LENGTH,
  HALO_VALUE_COUNT,
  type ChunkHalo,
} from "./halo.js";
export { buildChunkMesh, CHUNK_EDGE, CHUNK_VOXEL_COUNT } from "./mesher.js";
export {
  createSceneAdapter,
  type RendererDiagnostics,
  type SceneAdapter,
  type SceneAdapterOptions,
} from "./scene-adapter.js";
export {
  isChunkMeshStale,
  type ChunkMeshGeometry,
  type ChunkMeshInput,
  type ChunkMeshKey,
  type ChunkMeshOutput,
  type ChunkNamespace,
  type ChunkSampler,
  type MeshMaterialGroup,
} from "./types.js";
export {
  PICK_BOUNDARY_EPSILON,
  PICK_DIRECTION_EPSILON,
  PICK_DISTANCE_EPSILON,
  nodeWorldMatrices,
  pickScene,
  worldBoundsForNodes,
  worldContentBounds,
  type PickOptions,
  type PickRay,
  type VoxelPickHit,
  type WorldBounds,
} from "./pick.js";
export {
  DEFAULT_PREVIEW_SIZE,
  MAX_PREVIEW_DIMENSION,
  MAX_PREVIEW_PIXELS,
  PREVIEW_AMBIENT,
  PREVIEW_BACKGROUND,
  PREVIEW_DIFFUSE,
  PREVIEW_FAR,
  PREVIEW_FOV_Y,
  PREVIEW_FRAME_MARGIN,
  PREVIEW_LIGHT_DIRECTION,
  PREVIEW_MISSING_MATERIAL,
  PREVIEW_NEAR,
  PREVIEW_ORTHO_DISTANCE,
  PREVIEW_ORTHO_FAR,
  PREVIEW_ORTHO_NEAR,
  STANDARD_PREVIEW_VIEWS,
  frameStandardView,
  validatePreviewSpec,
  type PreviewFraming,
  type PreviewProjection,
  type PreviewSpec,
  type PreviewViewId,
} from "./preview/preview-protocol.js";
export {
  PreviewCancelledError,
  renderStandardPreview,
  type PreviewRenderOptions,
  type PreviewRenderResult,
} from "./preview/preview-renderer.js";
