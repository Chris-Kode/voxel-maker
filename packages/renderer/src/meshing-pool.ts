import type { ChunkMeshInput, ChunkMeshOutput } from "./types.js";
import { meshingKey } from "./worker-protocol.js";

/**
 * Meshing worker pool (plan S6.6, ticket #23): bounded execution of
 * copied-immutable chunk meshing jobs with explicit stale, cancelled,
 * failed, live, and preview behavior.
 *
 * The pool is deliberately small — the scheduler owns priority, dedupe,
 * and install budgets; the pool owns execution and result trust:
 *
 * - Jobs carry `{namespace, volumeId, coordinate, revision}`; a result
 *   may only be delivered when it still matches the LATEST submitted job
 *   for that identity. Submitting a newer job for the same chunk cancels
 *   the older one, so a slow worker result can never win (ADR-0005:
 *   completion order never decides visible state).
 * - Only `maxConcurrent` jobs run at once. When every slot is busy the
 *   pool rejects the submit through `onRejected`; the scheduler keeps the
 *   chunk pending and retries on a later frame, so the in-flight set is
 *   always bounded.
 * - A failed job retries up to `maxRetries` times, then reports through
 *   `onFailure` and leaves the chunk unmeshed (never a partial mesh).
 * - `cancel()` marks a job cancelled; its late result is dropped. The
 *   pool is executor-agnostic: a synchronous in-process executor (tests,
 *   headless), a real Web Worker executor (desktop), and fake executors
 *   (deterministic race tests) all share the same lifecycle.
 */

/** One running meshing job. */
export interface MeshingJob {
  readonly requestId: number;
  readonly input: ChunkMeshInput;
  cancelled: boolean;
  /** Set once the job reached its terminal outcome (or was cancelled). */
  done: boolean;
  retries: number;
}

/** Outcome of one executor run. */
export type MeshingOutcome =
  | { readonly ok: true; readonly result: ChunkMeshOutput }
  | { readonly ok: false; readonly error: unknown };

/**
 * Executes one job. `finish` must be called exactly once, at most once
 * per `start`. Executors never decide staleness or cancellation — the
 * pool drops late outcomes itself.
 */
export interface MeshingExecutor {
  start(job: MeshingJob, finish: (outcome: MeshingOutcome) => void): void;
  dispose(): void;
}

/** Pool counters for diagnostics (plan S6.14, ticket #23). */
export interface MeshingPoolDiagnostics {
  /** Jobs currently executing (bounded by `maxConcurrent`). */
  readonly inFlight: number;
  /** Total jobs ever submitted. */
  readonly dispatched: number;
  /** Results delivered to the scene. */
  readonly completed: number;
  /** Late results dropped because the job was cancelled. */
  readonly cancelled: number;
  /** Late results dropped because a newer job superseded them. */
  readonly staleDropped: number;
  /** Jobs rejected while every slot was busy (scheduler retries). */
  readonly rejected: number;
  /** Jobs that exhausted their retries. */
  readonly failed: number;
  /** Wall time of the most recent completed mesh, in milliseconds. */
  readonly lastMeshMs: number;
  /** Mean mesh time over completed meshes, in milliseconds. */
  readonly averageMeshMs: number;
}

/** Handle returned by `MeshingPool.submit`; cancels the job. */
export interface MeshingJobHandle {
  readonly requestId: number;
  cancel(): void;
}

/** Callbacks the pool drives. */
export interface MeshingPoolCallbacks {
  /** A fresh, trusted result matching the latest request for its chunk. */
  onResult(result: ChunkMeshOutput): void;
  /** A job exhausted its retries; the chunk stays unmeshed. */
  onFailure(input: ChunkMeshInput, error: unknown): void;
  /** A submit was rejected because every slot was busy. */
  onRejected(input: ChunkMeshInput): void;
}

export interface MeshingPoolOptions {
  readonly executor: MeshingExecutor;
  readonly callbacks: MeshingPoolCallbacks;
  /** Maximum simultaneously executing jobs (default 2). */
  readonly maxConcurrent?: number;
  /** Retries before a job fails (default 2). */
  readonly maxRetries?: number;
}

export interface MeshingPool {
  /**
   * Submits one job. When a job for the same chunk identity is already
   * pending, it is cancelled first — the newest request always wins. When
   * every slot is busy, `onRejected` fires and the caller should retry
   * later.
   */
  submit(input: ChunkMeshInput): MeshingJobHandle;
  /** Cancels the job; a late result is dropped, never delivered. */
  cancel(handle: MeshingJobHandle): void;
  /** Cancels every job and releases the executor. */
  dispose(): void;
  /** Live diagnostics counters (plan S6.14). */
  readonly diagnostics: MeshingPoolDiagnostics;
}

class MeshingPoolImpl implements MeshingPool {
  readonly #executor: MeshingExecutor;
  readonly #callbacks: MeshingPoolCallbacks;
  readonly #maxConcurrent: number;
  readonly #maxRetries: number;
  readonly #inFlight = new Map<number, MeshingJob>();
  /** Latest submitted job per chunk identity (queued or in flight). */
  readonly #latestByKey = new Map<string, MeshingJob>();
  #nextRequestId = 0;
  #dispatched = 0;
  #completed = 0;
  #cancelled = 0;
  #staleDropped = 0;
  #rejected = 0;
  #failed = 0;
  #lastMeshMs = 0;
  #meshMsTotal = 0;
  #meshMsSamples = 0;
  #disposed = false;

  constructor(options: MeshingPoolOptions) {
    this.#executor = options.executor;
    this.#callbacks = options.callbacks;
    this.#maxConcurrent = options.maxConcurrent ?? 2;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  get diagnostics(): MeshingPoolDiagnostics {
    return {
      inFlight: this.#inFlight.size,
      dispatched: this.#dispatched,
      completed: this.#completed,
      cancelled: this.#cancelled,
      staleDropped: this.#staleDropped,
      rejected: this.#rejected,
      failed: this.#failed,
      lastMeshMs: this.#lastMeshMs,
      averageMeshMs:
        this.#meshMsSamples === 0 ? 0 : this.#meshMsTotal / this.#meshMsSamples,
    };
  }

  submit(input: ChunkMeshInput): MeshingJobHandle {
    const job: MeshingJob = {
      requestId: this.#nextRequestId,
      input,
      cancelled: false,
      done: false,
      retries: 0,
    };
    this.#nextRequestId += 1;

    if (this.#disposed) {
      // A disposed pool accepts nothing; the caller's chunk stays pending
      // until the scene is cleared, which is the lifecycle contract.
      this.#callbacks.onRejected(input);
      return { requestId: job.requestId, cancel: () => undefined };
    }

    const key = meshingKey(input.namespace, input.volumeId, input.coordinate);
    const previous = this.#latestByKey.get(key);
    if (previous !== undefined) {
      // Newest request wins: cancel the older job. Its result, if it
      // already left for the worker, is dropped when it arrives.
      this.#cancelJob(previous);
    }
    this.#latestByKey.set(key, job);

    if (this.#inFlight.size >= this.#maxConcurrent) {
      // Bounded execution: reject and let the scheduler retry later.
      this.#latestByKey.delete(key);
      this.#rejected += 1;
      this.#callbacks.onRejected(input);
      return { requestId: job.requestId, cancel: () => undefined };
    }

    this.#dispatched += 1;
    this.#start(job);
    return {
      requestId: job.requestId,
      cancel: () => {
        this.#cancelJob(job);
      },
    };
  }

  cancel(handle: MeshingJobHandle): void {
    const job = this.#inFlight.get(handle.requestId);
    if (job === undefined) return;
    this.#cancelJob(job);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const job of [...this.#inFlight.values()]) {
      this.#cancelJob(job);
    }
    // The executor is gone, so no finish callbacks will ever arrive;
    // drop the bookkeeping now instead of reporting phantom work.
    this.#inFlight.clear();
    this.#latestByKey.clear();
    this.#executor.dispose();
  }

  #start(job: MeshingJob): void {
    this.#inFlight.set(job.requestId, job);
    const startedAt = performance.now();
    this.#executor.start(job, (outcome) => {
      this.#finish(job, outcome, startedAt);
    });
  }

  #finish(job: MeshingJob, outcome: MeshingOutcome, startedAt: number): void {
    if (this.#disposed) return;
    this.#inFlight.delete(job.requestId);
    job.done = true;

    if (job.cancelled) {
      // Explicit cancellation: the result is dropped and never delivered.
      // The cancellation was already counted when `cancel` ran.
      return;
    }

    const key = meshingKey(
      job.input.namespace,
      job.input.volumeId,
      job.input.coordinate,
    );
    if (this.#latestByKey.get(key) !== job) {
      // A newer job for the same chunk superseded this one.
      this.#staleDropped += 1;
      return;
    }

    if (!outcome.ok) {
      if (job.retries < this.#maxRetries) {
        job.retries += 1;
        this.#dispatched += 1;
        this.#start(job);
        return;
      }
      this.#latestByKey.delete(key);
      this.#failed += 1;
      this.#callbacks.onFailure(job.input, outcome.error);
      return;
    }

    this.#latestByKey.delete(key);
    this.#completed += 1;
    const elapsedMs = performance.now() - startedAt;
    this.#lastMeshMs = elapsedMs;
    this.#meshMsTotal += elapsedMs;
    this.#meshMsSamples += 1;
    this.#callbacks.onResult(outcome.result);
  }

  #cancelJob(job: MeshingJob): void {
    if (job.cancelled || job.done) return;
    job.cancelled = true;
    job.done = true;
    const key = meshingKey(
      job.input.namespace,
      job.input.volumeId,
      job.input.coordinate,
    );
    if (this.#latestByKey.get(key) === job) {
      this.#latestByKey.delete(key);
    }
    // The in-flight entry stays until the executor's finish arrives; the
    // finish handler drops it through the cancelled flag. Cancellation is
    // counted exactly once, at cancel time.
    this.#cancelled += 1;
  }
}

/** Creates a pool bound to `executor` (see module doc for semantics). */
export function createMeshingPool(options: MeshingPoolOptions): MeshingPool {
  return new MeshingPoolImpl(options);
}
