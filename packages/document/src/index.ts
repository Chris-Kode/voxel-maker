export {
  createDocumentStore,
  validateChunkMaterialReferences,
  type ChangedChunk,
  type ChangedVolume,
  type CreateDocumentStoreInput,
  type DocumentCommitted,
  type DocumentStoreRead,
  type Source,
} from "./store.js";
export { VoxelRepository } from "./repository.js";

export { nodesReferencingVolume, worldTransformMatrix } from "./hierarchy.js";

export {
  canonicalAssetSemanticBytes,
  canonicalAssetSemanticHash,
} from "./semantic.js";
