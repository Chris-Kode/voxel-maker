import {
  WorkspaceError,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import { validateDocument, type VoxelDocument } from "@voxel-maker/model";
import type {
  DocumentCommitted,
  DocumentStore,
  DocumentStoreRead,
  StagedState,
} from "@voxel-maker/document";
import {
  VoxelVolume,
  type VoxelVolumeReadView,
  type VoxelWriteCapability,
} from "@voxel-maker/voxel";
import { deepFreeze } from "./freeze.js";

/**
 * Copy-on-write preview store (plan S11.15, ticket #32): the private
 * `DocumentStore` behind one preview session. Committed state starts as a
 * cloned document at the session's base revision; volumes are cloned from
 * the live store lazily on first touch, so an untouched volume is never
 * copied and staged reads fall through to live data. Commits install only
 * into the preview store and emit only to preview listeners; the live
 * store, its revision, its history, and its subscribers are never touched.
 */

export class PreviewStore implements DocumentStore {
  readonly #live: DocumentStoreRead;
  readonly #capability: VoxelWriteCapability;
  #document: VoxelDocument;
  /** Volumes cloned from live on first touch (copy-on-write). */
  readonly #cloned = new Map<VolumeId, VoxelVolume>();
  readonly #listeners = new Set<(event: DocumentCommitted) => void>();

  constructor(
    live: DocumentStoreRead,
    document: VoxelDocument,
    capability: VoxelWriteCapability,
  ) {
    this.#live = live;
    this.#capability = capability;
    this.#document = deepFreeze(document);
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
    const cloned = this.#cloned.get(volumeId);
    if (cloned !== undefined) return cloned;
    return this.#live.getVolume(volumeId);
  }

  getVoxel(volumeId: VolumeId, coordinate: Vec3i): MaterialId {
    const cloned = this.#cloned.get(volumeId);
    if (cloned !== undefined) return cloned.getVoxel(coordinate);
    return this.#live.getVoxel(volumeId, coordinate);
  }

  subscribe(listener: (event: DocumentCommitted) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  stageVolume(volumeId: VolumeId): VoxelVolume | undefined {
    const existing = this.#cloned.get(volumeId);
    if (existing !== undefined) return existing;
    const view = this.#live.getVolume(volumeId);
    if (view === undefined) return undefined;
    const seeds = view.chunkCoordinates().map((coordinate) => ({
      coordinate,
      values: view.getChunk(coordinate) ?? new Uint16Array(0),
    }));
    const clone = VoxelVolume.fromChunks(
      volumeId,
      this.#live.volumeLimits,
      this.#capability,
      seeds,
    );
    this.#cloned.set(volumeId, clone);
    return clone;
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
      this.#cloned.set(volumeId, volume);
    }
    for (const volumeId of staged.removedVolumes) {
      this.#cloned.delete(volumeId);
    }
    this.#emit(deepFreeze(event));
  }

  /** Releases every preview resource (volume clones and listeners). */
  release(): void {
    this.#cloned.clear();
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
