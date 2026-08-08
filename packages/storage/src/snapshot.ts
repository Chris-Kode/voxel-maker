import {
  canonicalAssetSemanticHash,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import { volumeId, type VolumeId } from "@voxel-maker/shared";
import type { VoxelDocument } from "@voxel-maker/model";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";

/**
 * Immutable revision snapshot captured for an asynchronous writer (plan
 * S5.14, ticket #13). `document` is the deep-frozen committed document and
 * every `volumes` entry is the committed copy-on-write volume read view at
 * capture time; later commits install fresh documents and volumes and never
 * mutate retained objects, so a writer can finish after arbitrary later
 * edits and still emit exactly the captured state.
 */
export interface RevisionSnapshot {
  /** Committed document revision captured (`R` in ADR-0004). */
  readonly revision: number;
  /** Semantic hash of the captured state (`H_R` in ADR-0004). */
  readonly semanticHash: string;
  readonly document: VoxelDocument;
  readonly volumes: ReadonlyMap<VolumeId, VoxelVolumeReadView>;
}

/**
 * Captures `(revision R, semantic hash H_R)` plus the immutable document
 * and volume read views of a store. The hash covers the document and every
 * non-empty chunk stream (ADR-0004 `canonicalAssetSemanticBytes`); volumes
 * missing from the store are skipped exactly as the canonical hasher does.
 */
export function captureRevisionSnapshot(
  store: DocumentStoreRead,
): RevisionSnapshot {
  const document = store.getDocument();
  const volumes = new Map<VolumeId, VoxelVolumeReadView>();
  for (const volumeIdText of Object.keys(document.volumes)) {
    const id = volumeId(volumeIdText);
    const view = store.getVolume(id);
    if (view !== undefined) volumes.set(id, view);
  }
  return {
    revision: store.revision,
    semanticHash: canonicalAssetSemanticHash(document, volumes),
    document,
    volumes,
  };
}
