/**
 * Public entry point for the renderer package: the disposable Three.js
 * scene projection (plan S6.3/S6.7), the face-culling mesher (S6.5), the
 * chunk mesh DTOs (S6.4), the material adapter (S6.9), and deterministic
 * viewport picking plus world-bounds queries (S6.12, ADR-0005). Core
 * semantic packages never import this module.
 */
export {
  createMaterialAdapter,
  type MaterialAdapter,
} from "./material-adapter.js";
export { buildChunkMesh, CHUNK_EDGE, CHUNK_VOXEL_COUNT } from "./mesher.js";
export {
  createSceneAdapter,
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
