import {
  WorkspaceError,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import { validateDocument, type VoxelDocument } from "@voxel-maker/model";
import type {
  DocumentCommitted,
  DocumentStoreRead,
} from "@voxel-maker/document";
import type {
  DocumentStore,
  StagedState,
} from "@voxel-maker/document/internal";
import {
  VoxelVolume,
  type VoxelVolumeLimits,
  type VoxelVolumeReadView,
  type VoxelWriteCapability,
} from "@voxel-maker/voxel";
import { deepFreeze } from "./freeze.js";

/**
 * Copy-on-write preview store (plan S11.15, ticket #32, issue #116): the
 * private `DocumentStore` behind one preview session. At creation the
 * store captures an immutable base-revision snapshot: the committed
 * document plus a deep clone of every volume, all tagged at the session's
 * base revision. Reads and first clones always come from that snapshot —
 * never from the moving live store — so a concurrent live commit can never
 * drift preview reads, staged overlays, or inspection evidence onto newer
 * voxels (issue #116). Staging clones the snapshot copy-on-write, commits
 * install only into the preview store and emit only to preview listeners;
 * the live store, its revision, its history, and its subscribers are never
 * touched.
 */

export class PreviewStore implements DocumentStore {
  readonly #live: DocumentStoreRead;
  readonly #capability: VoxelWriteCapability;
  #document: VoxelDocument;
  /**
   * Base-revision volume snapshots plus volumes installed by preview
   * commits (copy-on-write overlay). Never mutated by handlers: staging
   * clones before touching.
   */
  readonly #volumes = new Map<VolumeId, VoxelVolume>();
  readonly #listeners = new Set<(event: DocumentCommitted) => void>();

  constructor(
    live: DocumentStoreRead,
    document: VoxelDocument,
    capability: VoxelWriteCapability,
  ) {
    this.#live = live;
    this.#capability = capability;
    this.#document = deepFreeze(document);
    // Issue #116: snapshot every base-revision volume at creation. The
    // live store mutates chunk data in place, so any read that falls
    // through to it would silently drift onto newer live voxels while the
    // preview document stays tagged at its base revision. The preview must
    // remain byte-identical at the base revision until discard/reinspect.
    for (const volumeId of Object.keys(document.volumes) as VolumeId[]) {
      const view = live.getVolume(volumeId);
      if (view === undefined) continue;
      this.#volumes.set(
        volumeId,
        cloneReadView(view, live.volumeLimits, capability),
      );
    }
  }

  get revision(): number {
    return this.#document.revision;
  }

  get limits() {
    return this.#live.limits;
  }

  get volumeLimits() {
    return this.#live.volumeLimits;
  }

  getDocument(): VoxelDocument {
    return this.#document;
  }

  getVolume(volumeId: VolumeId): VoxelVolumeReadView | undefined {
    return this.#volumes.get(volumeId);
  }

  getVoxel(volumeId: VolumeId, coordinate: Vec3i): MaterialId {
    return (
      this.#volumes.get(volumeId)?.getVoxel(coordinate) ?? (0 as MaterialId)
    );
  }

  subscribe(listener: (event: DocumentCommitted) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  stageVolume(volumeId: VolumeId): VoxelVolume | undefined {
    // COW staging: return a fresh clone so a rejected transaction leaves
    // the committed snapshot bytes untouched (same contract as the live
    // store). The clone always seeds from the base-revision snapshot,
    // never from the moving live store (issue #116).
    return this.#volumes.get(volumeId)?.clone();
  }

  commit(
    staged: StagedState,
    event: DocumentCommitted,
    capability: VoxelWriteCapability,
  ): void {
    if (capability !== this.#capability) {
      throw new WorkspaceError({
        family: "internal",
        code: "WRITE_CAPABILITY_REQUIRED",
        message:
          "Preview commit requires the preview store write capability held by the preview command bus",
      });
    }
    if (staged.document.documentId !== this.#document.documentId) {
      throw new WorkspaceError({
        family: "validation",
        code: "DOCUMENT_ID_MISMATCH",
        message: "Staged document belongs to a different document",
        context: { documentId: staged.document.documentId },
      });
    }
    if (staged.document.revision !== this.#document.revision + 1) {
      throw new WorkspaceError({
        family: "conflict",
        code: "REVISION_CONFLICT",
        message:
          "Staged document revision must be exactly current revision + 1",
        context: {
          expected: this.#document.revision + 1,
          actual: staged.document.revision,
        },
      });
    }
    if (
      event.revisionBefore !== this.#document.revision ||
      event.revisionAfter !== staged.document.revision
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_EVENT_REVISION",
        message: "Event revisions must match the committed revision transition",
        context: {
          revisionBefore: event.revisionBefore,
          revisionAfter: event.revisionAfter,
        },
      });
    }
    const issues = validateDocument(staged.document, this.#live.limits);
    if (issues[0] !== undefined) {
      throw new WorkspaceError({
        family: issues[0].family,
        code: issues[0].code,
        message: issues[0].message,
        path: issues[0].path,
      });
    }
    for (const volumeId of staged.volumes.keys()) {
      if (staged.document.volumes[volumeId] === undefined) {
        throw new WorkspaceError({
          family: "validation",
          code: "MISSING_VOLUME",
          message: "Staged volume is not part of the document",
          context: { volumeId },
        });
      }
    }
    for (const volumeId of staged.removedVolumes) {
      if (this.#document.volumes[volumeId] === undefined) {
        throw new WorkspaceError({
          family: "validation",
          code: "MISSING_VOLUME",
          message: "Removed volume is not part of the committed document",
          context: { volumeId },
        });
      }
      if (staged.document.volumes[volumeId] !== undefined) {
        throw new WorkspaceError({
          family: "validation",
          code: "REMOVED_VOLUME_KEPT",
          message: "Removed volume must be absent from the staged document",
          context: { volumeId },
        });
      }
    }
    this.#document = deepFreeze(staged.document);
    for (const [volumeId, volume] of staged.volumes) {
      this.#volumes.set(volumeId, volume);
    }
    for (const volumeId of staged.removedVolumes) {
      this.#volumes.delete(volumeId);
    }
    this.#emit(deepFreeze(event));
  }

  /** Releases every preview resource (volume snapshots and listeners). */
  release(): void {
    this.#volumes.clear();
    this.#listeners.clear();
  }

  #emit(event: DocumentCommitted): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Subscriber exceptions are isolated and never break the commit.
      }
    }
  }
}

/** Deep clone of one committed read view (issue #116). */
function cloneReadView(
  view: VoxelVolumeReadView,
  limits: VoxelVolumeLimits,
  capability: VoxelWriteCapability,
): VoxelVolume {
  const seeds = view.chunkCoordinates().map((coordinate) => ({
    coordinate,
    values: view.getChunk(coordinate) ?? new Uint16Array(0),
  }));
  return VoxelVolume.fromChunks(view.volumeId, limits, capability, seeds);
}
