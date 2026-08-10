import type { Vec3i } from "@voxel-maker/math";
import type { VolumeId } from "@voxel-maker/shared";
import type {
  ChunkMeshInput,
  ChunkMeshOutput,
  ChunkNamespace,
} from "./types.js";
import {
  createMeshingPool,
  type MeshingExecutor,
  type MeshingJobHandle,
  type MeshingPool,
  type MeshingPoolDiagnostics,
} from "./meshing-pool.js";
import { meshingKey } from "./worker-protocol.js";

/**
 * Dirty-chunk scheduler (plan S6.8, ticket #23).
 *
 * The scheduler turns commit events into bounded, prioritized meshing
 * work without ever touching the scene:
 *
 * - `schedule` records exactly the chunks a commit invalidated — the
 *   edited chunk plus the face neighbors the voxel layer reports — and
 *   keeps only the NEWEST revision per chunk. An older pending or
 *   in-flight job for the same chunk is cancelled, so a slow result can
 *   never overwrite a newer edit. At dispatch time `resolve` copies the
 *   current chunk-and-halo buffers on the main thread (bounded per
 *   frame), so workers always receive copied immutable data.
 * - `flush` runs once per animation frame: it installs at most
 *   `maxUploadsPerFrame` completed meshes (the main-thread upload
 *   budget) and dispatches at most `maxDispatchesPerFrame` pending jobs,
 *   visible chunks first (`priorityFor` answers the frustum test; lower
 *   numbers are more important). Dispatches the pool rejects stay
 *   pending and retry on a later frame.
 * - The pending set is bounded (`maxPending`); on overflow the least
 *   important pending chunk moves to a deferred dirty source (one entry
 *   per chunk, never dropped) and `flush` re-enqueues deferred chunks
 *   whenever capacity frees up, so every invalidated chunk eventually
 *   meshes (issue #59). The deferred queue is the bounded dirty source
 *   plan S6.8 implies: its memory is bounded by the number of dirty
 *   chunks and it drains at the per-frame dispatch rate.
 *
 * The scheduler is Three-free: scene concerns (frustum, geometry, GPU
 * disposal) live in the scene adapter, which supplies `install` and
 * `priorityFor`.
 */

/** Identity + revision of one chunk that needs a mesh. */
export interface ChunkScheduleSpec {
  readonly namespace: ChunkNamespace;
  readonly volumeId: VolumeId;
  readonly coordinate: Vec3i;
  readonly revision: number;
}

/** One entry of the bounded pending set. */
interface PendingEntry {
  spec: ChunkScheduleSpec;
  /** Priority from the last flush (lower = more important). */
  priority: number;
}

/**
 * One dispatched job, tracked so it can be cancelled. `handle` is filled
 * synchronously right after `submit` returns; a synchronous executor may
 * complete (and remove the entry) before that assignment, so it is
 * nullable and cancellation guards it.
 */
interface SubmittedEntry {
  readonly spec: ChunkScheduleSpec;
  handle: MeshingJobHandle | undefined;
}

export interface ChunkSchedulerOptions {
  /** Executor that actually computes meshes (worker or in-process). */
  readonly executor: MeshingExecutor;
  /**
   * Copies the current chunk-and-halo data for one scheduled chunk at
   * dispatch time (main thread, bounded by `maxDispatchesPerFrame`).
   * Returns undefined when the chunk no longer exists; the job is then
   * dropped silently. The returned buffers must be fresh copies — they
   * are transferred to the worker and detached.
   */
  readonly resolve: (spec: ChunkScheduleSpec) => ChunkMeshInput | undefined;
  /**
   * Installs one fresh result into the scene. Called at most
   * `maxUploadsPerFrame` times per flush; the adapter re-verifies the
   * result is still current before touching GPU resources.
   */
  readonly install: (result: ChunkMeshOutput) => void;
  /**
   * Called when a chunk's mesh exhausted its retries; the chunk stays
   * unmeshed and the previous geometry (if any) remains visible.
   */
  readonly onFailure?: (input: ChunkMeshInput) => void;
  /**
   * Visibility priority for a pending chunk; lower = more important.
   * Called once per pending entry per flush, so it may read the camera
   * frustum. Defaults to 1 for every chunk.
   */
  readonly priorityFor?: (spec: ChunkScheduleSpec) => number;
  /**
   * Bounded pending set; on overflow the least important chunk defers to
   * the dirty source and is re-enqueued on a later flush (default 256).
   */
  readonly maxPending?: number;
  /** Pending jobs dispatched per flush (default 4). */
  readonly maxDispatchesPerFrame?: number;
  /** Completed meshes installed per flush (default 4). */
  readonly maxUploadsPerFrame?: number;
  /** Maximum simultaneously executing pool jobs (default 2). */
  readonly maxConcurrent?: number;
  /** Pool retries before a job fails (default 2). */
  readonly maxRetries?: number;
}

/** Scheduler counters for diagnostics (plan S6.14). */
export interface ChunkSchedulerDiagnostics {
  /** Dirty chunks waiting to be dispatched. */
  readonly pending: number;
  /** Evicted dirty chunks waiting for pending capacity (issue #59). */
  readonly deferred: number;
  /** Jobs currently executing in the pool. */
  readonly inFlight: number;
  /** Fresh results waiting for the main-thread upload budget. */
  readonly completedQueue: number;
  /** Installs performed by the most recent flush. */
  readonly uploadsThisFrame: number;
  /** Total jobs ever dispatched. */
  readonly dispatchedTotal: number;
  /** Total meshes ever installed. */
  readonly installedTotal: number;
  /** Pool-level counters (mesh times, stale/cancel/fail). */
  readonly pool: MeshingPoolDiagnostics;
}

export interface ChunkScheduler {
  /**
   * Records one invalidated chunk (edited chunk + face neighbors from the
   * commit event). Newer revisions supersede older pending work for the
   * same chunk.
   */
  schedule(spec: ChunkScheduleSpec): void;
  /**
   * Cancels pending and in-flight work for one chunk; its result, if it
   * already left for the worker, is dropped by the pool.
   */
  cancelChunk(spec: ChunkScheduleSpec): void;
  /** Cancels every pending and in-flight job of one volume. */
  cancelVolume(volumeId: VolumeId): void;
  /**
   * Cancels every pending and in-flight job of one volume within one
   * namespace only (plan S12.15): preview projections share this
   * scheduler, so volume-scoped cancellation must never cross namespaces.
   */
  cancelNamespaceVolume(namespace: ChunkNamespace, volumeId: VolumeId): void;
  /** Cancels every pending and in-flight job of one namespace. */
  cancelNamespaceAll(namespace: ChunkNamespace): void;
  /** Cancels every pending and in-flight job (lifecycle replacement). */
  cancelAll(): void;
  /**
   * Per-frame step: install completed meshes within the upload budget,
   * then dispatch pending jobs within the dispatch budget, visible
   * chunks first.
   */
  flush(): void;
  /** Cancels everything and releases the pool. */
  dispose(): void;
  /** Live diagnostics (plan S6.14). */
  diagnostics(): ChunkSchedulerDiagnostics;
}

class ChunkSchedulerImpl implements ChunkScheduler {
  readonly #install: (result: ChunkMeshOutput) => void;
  readonly #resolve: (spec: ChunkScheduleSpec) => ChunkMeshInput | undefined;
  readonly #onFailure: ((input: ChunkMeshInput) => void) | undefined;
  readonly #priorityFor: ((spec: ChunkScheduleSpec) => number) | undefined;
  readonly #maxPending: number;
  readonly #maxDispatchesPerFrame: number;
  readonly #maxUploadsPerFrame: number;
  readonly #pool: MeshingPool;
  /** Dirty chunks awaiting dispatch, by identity key. */
  readonly #pending = new Map<string, PendingEntry>();
  /**
   * Dirty source for chunks evicted from the bounded pending set (issue
   * #59): one spec per chunk, keyed by identity. Never dropped — eviction
   * only defers, and `flush` re-enqueues from here when capacity frees.
   */
  readonly #deferred = new Map<string, ChunkScheduleSpec>();
  /** FIFO order of deferred keys, so evicted chunks drain oldest first. */
  readonly #deferredOrder: string[] = [];
  /** Jobs dispatched to the pool, by identity key. */
  readonly #submitted = new Map<string, SubmittedEntry>();
  /** Fresh results awaiting the upload budget, in completion order. */
  readonly #completed: ChunkMeshOutput[] = [];
  #uploadsThisFrame = 0;
  #dispatchedTotal = 0;
  #installedTotal = 0;
  #disposed = false;

  constructor(options: ChunkSchedulerOptions) {
    this.#install = options.install;
    this.#resolve = options.resolve;
    this.#onFailure = options.onFailure;
    this.#priorityFor = options.priorityFor;
    this.#maxPending = options.maxPending ?? 256;
    this.#maxDispatchesPerFrame = options.maxDispatchesPerFrame ?? 4;
    this.#maxUploadsPerFrame = options.maxUploadsPerFrame ?? 4;
    this.#pool = createMeshingPool({
      executor: options.executor,
      maxConcurrent: options.maxConcurrent ?? 2,
      maxRetries: options.maxRetries ?? 2,
      callbacks: {
        onResult: (result) => {
          // The pool already verified this is the latest job for its
          // chunk; `install` re-verifies against the scene's latest
          // revision map before touching GPU resources.
          this.#submitted.delete(
            meshingKey(result.namespace, result.volumeId, result.coordinate),
          );
          this.#completed.push(result);
        },
        onFailure: (input) => {
          this.#submitted.delete(
            meshingKey(input.namespace, input.volumeId, input.coordinate),
          );
          this.#onFailure?.(input);
        },
        onRejected: (input) => {
          // The pool is saturated; re-queue the chunk so the next flush
          // retries it. `submit` reports rejection synchronously, so the
          // flush loop observes the re-queued entry and stops.
          const key = meshingKey(
            input.namespace,
            input.volumeId,
            input.coordinate,
          );
          if (!this.#pending.has(key)) {
            this.#pending.set(key, { spec: input, priority: 1 });
          }
        },
      },
    });
  }

  schedule(spec: ChunkScheduleSpec): void {
    if (this.#disposed) return;
    const key = meshingKey(spec.namespace, spec.volumeId, spec.coordinate);
    const previous = this.#pending.get(key);
    if (previous !== undefined) {
      // Newest revision wins while still pending.
      previous.spec = { ...previous.spec, revision: spec.revision };
      return;
    }
    const deferred = this.#deferred.get(key);
    if (deferred !== undefined) {
      // Newest revision wins while deferred (keeps its FIFO position).
      this.#deferred.set(key, { ...deferred, revision: spec.revision });
      return;
    }
    const submitted = this.#submitted.get(key);
    if (submitted !== undefined) {
      // A newer edit invalidated the in-flight mesh: cancel the job and
      // re-queue; the pool drops the late result.
      if (submitted.handle !== undefined) {
        this.#pool.cancel(submitted.handle);
      }
      this.#submitted.delete(key);
    }
    const entry: PendingEntry = {
      spec,
      priority: this.#priorityFor?.(spec) ?? 1,
    };
    this.#pending.set(key, entry);

    // Bound the pending set: defer the least important pending chunk to
    // the dirty source. Eviction is never completion (issue #59) — the
    // chunk is re-enqueued on a later flush, so its latest revision
    // still meshes.
    if (this.#pending.size > this.#maxPending) {
      let evictKey: string | undefined;
      let evictPriority = Number.NEGATIVE_INFINITY;
      for (const [candidateKey, candidate] of this.#pending) {
        if (candidate.priority > evictPriority) {
          evictKey = candidateKey;
          evictPriority = candidate.priority;
        }
      }
      if (evictKey !== undefined) {
        const evicted = this.#pending.get(evictKey);
        this.#pending.delete(evictKey);
        if (evicted !== undefined) {
          this.#deferred.set(evictKey, evicted.spec);
          this.#deferredOrder.push(evictKey);
        }
      }
    }
  }

  cancelChunk(spec: ChunkScheduleSpec): void {
    if (this.#disposed) return;
    const key = meshingKey(spec.namespace, spec.volumeId, spec.coordinate);
    this.#pending.delete(key);
    if (this.#deferred.delete(key)) {
      this.#deferredOrder.splice(this.#deferredOrder.indexOf(key), 1);
    }
    const submitted = this.#submitted.get(key);
    if (submitted !== undefined) {
      if (submitted.handle !== undefined) {
        this.#pool.cancel(submitted.handle);
      }
      this.#submitted.delete(key);
    }
  }

  /** Removes deferred entries matching `predicate`, keeping FIFO order. */
  #removeDeferred(predicate: (spec: ChunkScheduleSpec) => boolean): void {
    const survivors: string[] = [];
    for (const key of this.#deferredOrder) {
      const spec = this.#deferred.get(key);
      if (spec !== undefined && !predicate(spec)) {
        survivors.push(key);
      } else {
        this.#deferred.delete(key);
      }
    }
    this.#deferredOrder.length = 0;
    this.#deferredOrder.push(...survivors);
  }

  cancelVolume(volumeId: VolumeId): void {
    if (this.#disposed) return;
    for (const [key, entry] of [...this.#pending]) {
      if (entry.spec.volumeId === volumeId) this.#pending.delete(key);
    }
    this.#removeDeferred((spec) => spec.volumeId === volumeId);
    for (const [key, entry] of [...this.#submitted]) {
      if (entry.spec.volumeId === volumeId) {
        if (entry.handle !== undefined) {
          this.#pool.cancel(entry.handle);
        }
        this.#submitted.delete(key);
      }
    }
  }

  cancelNamespaceVolume(namespace: ChunkNamespace, volumeId: VolumeId): void {
    if (this.#disposed) return;
    for (const [key, entry] of [...this.#pending]) {
      if (
        entry.spec.namespace === namespace &&
        entry.spec.volumeId === volumeId
      ) {
        this.#pending.delete(key);
      }
    }
    this.#removeDeferred(
      (spec) => spec.namespace === namespace && spec.volumeId === volumeId,
    );
    for (const [key, entry] of [...this.#submitted]) {
      if (
        entry.spec.namespace === namespace &&
        entry.spec.volumeId === volumeId
      ) {
        if (entry.handle !== undefined) {
          this.#pool.cancel(entry.handle);
        }
        this.#submitted.delete(key);
      }
    }
  }

  cancelNamespaceAll(namespace: ChunkNamespace): void {
    if (this.#disposed) return;
    for (const [key, entry] of [...this.#pending]) {
      if (entry.spec.namespace === namespace) this.#pending.delete(key);
    }
    this.#removeDeferred((spec) => spec.namespace === namespace);
    for (const [key, entry] of [...this.#submitted]) {
      if (entry.spec.namespace === namespace) {
        if (entry.handle !== undefined) {
          this.#pool.cancel(entry.handle);
        }
        this.#submitted.delete(key);
      }
    }
    // Completed results of this namespace still waiting for the upload
    // budget belong to a disposed overlay; drop them so no stale mesh
    // installs later.
    for (let index = this.#completed.length - 1; index >= 0; index -= 1) {
      const result = this.#completed[index];
      if (result !== undefined && result.namespace === namespace) {
        this.#completed.splice(index, 1);
      }
    }
  }

  cancelAll(): void {
    if (this.#disposed) return;
    this.#pending.clear();
    this.#deferred.clear();
    this.#deferredOrder.length = 0;
    for (const entry of this.#submitted.values()) {
      if (entry.handle !== undefined) {
        this.#pool.cancel(entry.handle);
      }
    }
    this.#submitted.clear();
    // Completed results still waiting for the upload budget belong to the
    // replaced document; drop them so no stale mesh installs later.
    this.#completed.length = 0;
  }

  flush(): void {
    if (this.#disposed) return;
    this.#uploadsThisFrame = 0;

    // 1. Refresh priorities from the camera frustum, then dispatch the
    // most important pending chunks within the dispatch budget. The
    // submitted entry is tracked BEFORE `submit` so a synchronous
    // executor's immediate completion cannot leak a stale entry.
    for (const entry of this.#pending.values()) {
      entry.priority = this.#priorityFor?.(entry.spec) ?? 1;
    }
    const ordered = [...this.#pending.entries()].sort(
      (a, b) => a[1].priority - b[1].priority,
    );
    let dispatched = 0;
    for (const [key, entry] of ordered) {
      if (dispatched >= this.#maxDispatchesPerFrame) break;
      if (this.#pending.get(key) !== entry) continue; // cancelled meanwhile
      this.#pending.delete(key);
      const input = this.#resolve(entry.spec);
      if (input === undefined) {
        // The chunk vanished (deleted or emptied) between scheduling and
        // dispatch; the scene adapter already disposed its geometry.
        continue;
      }
      const submitted: SubmittedEntry = { spec: entry.spec, handle: undefined };
      this.#submitted.set(key, submitted);
      submitted.handle = this.#pool.submit(input);
      if (this.#pending.has(key)) {
        // Rejected synchronously: onRejected re-queued it; the pool is
        // saturated, so further submits would reject too.
        this.#submitted.delete(key);
        break;
      }
      this.#dispatchedTotal += 1;
      dispatched += 1;
    }

    // 2. Top the pending set back up from the deferred dirty source so
    // evicted chunks (issue #59) re-enter dispatch on the next flush.
    // FIFO order keeps every deferred chunk moving toward meshing, and
    // the pending bound still holds: capacity just freed by dispatch.
    while (
      this.#pending.size < this.#maxPending &&
      this.#deferredOrder.length > 0
    ) {
      const deferredKey = this.#deferredOrder.shift();
      if (deferredKey === undefined) break;
      const deferredSpec = this.#deferred.get(deferredKey);
      if (deferredSpec !== undefined) {
        this.#deferred.delete(deferredKey);
        this.#pending.set(deferredKey, {
          spec: deferredSpec,
          priority: this.#priorityFor?.(deferredSpec) ?? 1,
        });
      }
    }

    // 3. Install fresh results within the upload budget. With a
    // synchronous executor this installs the work dispatched above; with
    // a worker it installs whatever completed since the last frame.
    while (
      this.#uploadsThisFrame < this.#maxUploadsPerFrame &&
      this.#completed.length > 0
    ) {
      const result = this.#completed.shift();
      if (result === undefined) break;
      this.#install(result);
      this.#uploadsThisFrame += 1;
      this.#installedTotal += 1;
    }
  }

  diagnostics(): ChunkSchedulerDiagnostics {
    return {
      pending: this.#pending.size,
      deferred: this.#deferred.size,
      inFlight: this.#pool.diagnostics.inFlight,
      completedQueue: this.#completed.length,
      uploadsThisFrame: this.#uploadsThisFrame,
      dispatchedTotal: this.#dispatchedTotal,
      installedTotal: this.#installedTotal,
      pool: this.#pool.diagnostics,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pending.clear();
    this.#deferred.clear();
    this.#deferredOrder.length = 0;
    for (const entry of this.#submitted.values()) {
      if (entry.handle !== undefined) {
        this.#pool.cancel(entry.handle);
      }
    }
    this.#submitted.clear();
    this.#completed.length = 0;
    this.#pool.dispose();
  }
}

/** Creates a dirty-chunk scheduler (see module doc for semantics). */
export function createChunkScheduler(
  options: ChunkSchedulerOptions,
): ChunkScheduler {
  return new ChunkSchedulerImpl(options);
}
