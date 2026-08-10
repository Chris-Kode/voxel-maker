export {
  createDocumentStore,
  validateChunkMaterialReferences,
  type ChangedChunk,
  type ChangedVolume,
  type CreateDocumentStoreInput,
  type DocumentCommitted,
  type DocumentStore,
  type DocumentStoreHandle,
  type DocumentStoreRead,
  type Source,
  type StagedState,
} from "./store.js";
export { VoxelRepository } from "./repository.js";

export { nodesReferencingVolume, worldTransformMatrix } from "./hierarchy.js";

export {
  canonicalAssetSemanticBytes,
  canonicalAssetSemanticHash,
} from "./semantic.js";
