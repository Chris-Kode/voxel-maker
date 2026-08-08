import type { DocumentStoreRead } from "@voxel-maker/document";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  IO_ERROR_CODES,
  IO_ERROR_MESSAGES,
  storageIoError,
  type ProjectStoragePort,
} from "./port.js";
import { captureRevisionSnapshot, type RevisionSnapshot } from "./snapshot.js";
import type { ProjectEncoder } from "./encoder.js";

/** Outcome of one completed save request. */
export interface SaveOutcome {
  readonly status: "saved" | "unchanged";
  /** Revision of the snapshot written (or already durable). */
  readonly revision: number;
  /** Semantic hash of the snapshot written (or already durable). */
  readonly semanticHash: string;
  readonly path: string;
}

/**
 * Runtime save projection events (plan S5.8 "failure notification";
 * `Dirty flags are consumer-specific events` in ARCHITECTURE.md). Events are
 * frozen and best-effort: a throwing listener never breaks the coordinator.
 */
export type SaveCoordinatorEvent =
  | {
      readonly kind: "save-started";
      readonly path: string;
      readonly revision: number;
    }
  | {
      readonly kind: "save-completed";
      readonly path: string;
      readonly revision: number;
      /** True when live state moved past the captured snapshot. */
      readonly stale: boolean;
    }
  | {
      readonly kind: "save-failed";
      readonly path: string;
      readonly error: WorkspaceError;
    }
  | { readonly kind: "dirty-changed"; readonly dirty: boolean };

/**
 * Serializes project saves for one open document (plan S5.14, ticket #13).
 *
 * - `capture()` freezes an immutable `(revision R, semantic hash H_R)`
 *   snapshot; asynchronous writers retain it while later edits proceed.
 * - Saves never overlap: one write runs at a time and later requests queue
 *   in order.
 * - Completion records `R` as the durable snapshot and marks the project
 *   clean only when the live semantic hash still equals the captured `H_R`.
 *   A stale completion therefore cannot clear dirty state (acceptance
 *   criterion of ticket #13).
 * - `cancel()` interrupts the in-flight write at the next phase boundary
 *   and rejects queued requests with `IO_WRITE_INTERRUPTED`. An abort
 *   observed before the atomic replace leaves destination and backup
 *   untouched; if the replace already committed, the save completes
 *   normally. `dispose()` cancels and stops observing the store.
 *
 * Dirty state is runtime projection, never persisted semantic state: the
 * project is dirty exactly when the live semantic hash differs from the
 * hash of the last completed save. Because the document revision is part of
 * the ADR-0004 semantic identity, any committed transaction since the last
 * completed save keeps the project dirty — even an undo that restores the
 * saved voxel content.
 */
export interface SaveCoordinator {
  /** True when live state differs from the last completed save. */
  isDirty(): boolean;
  /** Revision of the last completed save; undefined before the first save. */
  lastDurableRevision(): number | undefined;
  /** Semantic hash of the last completed save; undefined before the first. */
  lastDurableHash(): string | undefined;
  /** Immutable snapshot of the current store state (no I/O). */
  capture(): RevisionSnapshot;
  /**
   * Saves the current state asynchronously. When a write is already in
   * flight the request queues; writes always run in order and never
   * overlap. Resolves `unchanged` without touching the port when the
   * requested state is already durable at the same path.
   */
  save(path: string): Promise<SaveOutcome>;
  /** Interrupts the in-flight write and rejects queued requests. */
  cancel(): void;
  /** Subscribes to save and dirty events; returns an unsubscribe function. */
  subscribe(listener: (event: SaveCoordinatorEvent) => void): () => void;
  /** Stops observing the store and releases the coordinator. */
  dispose(): void;
}

export interface SaveCoordinatorOptions {
  readonly store: DocumentStoreRead;
  readonly port: ProjectStoragePort;
  readonly encoder: ProjectEncoder;
}

interface PendingSave {
  readonly path: string;
  readonly snapshot: RevisionSnapshot;
  readonly controller: AbortController;
  readonly resolve: (outcome: SaveOutcome) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Creates the save coordinator for one open document. The store is read
 * through its immutable read surface only; the coordinator never mutates
 * semantic state.
 */
export function createSaveCoordinator(
  options: SaveCoordinatorOptions,
): SaveCoordinator {
  return new SaveCoordinatorImpl(options.store, options.port, options.encoder);
}

class SaveCoordinatorImpl implements SaveCoordinator {
  readonly #store: DocumentStoreRead;
  readonly #port: ProjectStoragePort;
  readonly #encoder: ProjectEncoder;
  readonly #listeners = new Set<(event: SaveCoordinatorEvent) => void>();
  readonly #queue: PendingSave[] = [];
  #inflight: PendingSave | undefined;
  #disposed = false;
  #durable:
    | {
        readonly revision: number;
        readonly hash: string;
        readonly path: string;
      }
    | undefined;
  /** Live semantic hash cache, invalidated by every committed transaction. */
  #liveHashCache: string | undefined;
  /**
   * Cached dirty state. `isDirty()`/completion recompute it from the live
   * hash and emit `dirty-changed` only when it transitions, so listeners
   * observe changes without polling while queries stay cheap.
   */
  #dirty: boolean | undefined;
  readonly #unsubscribeStore: () => void;

  constructor(
    store: DocumentStoreRead,
    port: ProjectStoragePort,
    encoder: ProjectEncoder,
  ) {
    this.#store = store;
    this.#port = port;
    this.#encoder = encoder;
    this.#unsubscribeStore = store.subscribe(() => {
      this.#liveHashCache = undefined;
    });
  }

  isDirty(): boolean {
    this.#updateDirty();
    return this.#dirty === true;
  }

  lastDurableRevision(): number | undefined {
    return this.#durable?.revision;
  }

  lastDurableHash(): string | undefined {
    return this.#durable?.hash;
  }

  capture(): RevisionSnapshot {
    return captureRevisionSnapshot(this.#store);
  }

  save(path: string): Promise<SaveOutcome> {
    if (this.#disposed) {
      return Promise.reject(
        storageIoError(
          IO_ERROR_CODES.writeFailed,
          "The save coordinator is disposed",
          { path },
        ),
      );
    }
    if (path.length === 0) {
      return Promise.reject(
        storageIoError(
          IO_ERROR_CODES.writeFailed,
          "The project path is empty",
          {
            path: "",
          },
        ),
      );
    }
    const snapshot = captureRevisionSnapshot(this.#store);
    const durable = this.#durable;
    if (
      durable !== undefined &&
      durable.path === path &&
      durable.hash === snapshot.semanticHash
    ) {
      return Promise.resolve({
        status: "unchanged",
        revision: snapshot.revision,
        semanticHash: snapshot.semanticHash,
        path,
      });
    }
    return new Promise<SaveOutcome>((resolve, reject) => {
      const request: PendingSave = {
        path,
        snapshot,
        controller: new AbortController(),
        resolve,
        reject,
      };
      this.#queue.push(request);
      if (this.#inflight === undefined) this.#startNext();
    });
  }

  cancel(): void {
    const inflight = this.#inflight;
    if (inflight !== undefined) {
      inflight.controller.abort();
    }
    for (const request of this.#queue.splice(0)) {
      request.reject(
        storageIoError(
          IO_ERROR_CODES.writeInterrupted,
          IO_ERROR_MESSAGES.interrupted,
          { path: request.path },
        ),
      );
    }
  }

  subscribe(listener: (event: SaveCoordinatorEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancel();
    this.#unsubscribeStore();
    this.#listeners.clear();
  }

  #startNext(): void {
    const request = this.#queue.shift();
    if (request === undefined) return;
    this.#inflight = request;
    this.#emit({
      kind: "save-started",
      path: request.path,
      revision: request.snapshot.revision,
    });
    void this.#run(request);
  }

  async #run(request: PendingSave): Promise<void> {
    try {
      const bytes = await this.#encoder.encodeProject(request.snapshot);
      // The port observes the signal at every phase boundary and rejects
      // with IO_WRITE_INTERRUPTED when an abort lands before the atomic
      // replace. A resolved port write means the replace committed: an
      // abort that races the rename must not turn a durable save into a
      // reported failure, so no post-write abort check happens here.
      await this.#port.writeProjectAtomic(request.path, bytes, {
        signal: request.controller.signal,
      });
      // Completion records R as the durable snapshot and marks the project
      // clean only when the live semantic hash still equals captured H_R
      // (ADR-0004, plan S5.14); it never compares a hash with a Revision.
      this.#durable = {
        revision: request.snapshot.revision,
        hash: request.snapshot.semanticHash,
        path: request.path,
      };
      const stale = this.#computeLiveHash() !== request.snapshot.semanticHash;
      this.#emit({
        kind: "save-completed",
        path: request.path,
        revision: request.snapshot.revision,
        stale,
      });
      this.#updateDirty();
      request.resolve({
        status: "saved",
        revision: request.snapshot.revision,
        semanticHash: request.snapshot.semanticHash,
        path: request.path,
      });
    } catch (error) {
      const wrapped =
        error instanceof WorkspaceError
          ? error
          : storageIoError(
              IO_ERROR_CODES.writeFailed,
              IO_ERROR_MESSAGES.writeFailed,
              { path: request.path },
              error,
            );
      this.#emit({ kind: "save-failed", path: request.path, error: wrapped });
      request.reject(wrapped);
    } finally {
      this.#inflight = undefined;
      this.#startNext();
    }
  }

  #updateDirty(): void {
    const dirty =
      this.#durable === undefined ||
      this.#computeLiveHash() !== this.#durable.hash;
    if (dirty !== this.#dirty) {
      this.#dirty = dirty;
      this.#emit({ kind: "dirty-changed", dirty });
    }
  }

  #computeLiveHash(): string {
    const cached = this.#liveHashCache;
    if (cached !== undefined) return cached;
    const hash = captureRevisionSnapshot(this.#store).semanticHash;
    this.#liveHashCache = hash;
    return hash;
  }

  #emit(event: SaveCoordinatorEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Listener exceptions are isolated and never break the coordinator.
      }
    }
  }
}
