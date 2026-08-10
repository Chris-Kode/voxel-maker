import type {
  AtomicWritePhase,
  AtomicWriteResult,
  ProjectStoragePort,
} from "./port.js";
import { IO_ERROR_CODES, storageIoError } from "./port.js";

/**
 * One snapshot replacement for a document path (ticket #51). Snapshot
 * replacements are revision-tagged: the captured state's document revision
 * lets the gate fence a stale write whose captured revision is older than
 * the snapshot already installed at that path.
 */
export interface SnapshotWriteRequest {
  readonly path: string;
  /** Canonical project bytes of the captured snapshot. */
  readonly bytes: Uint8Array;
  /** Revision of the captured state these bytes describe. */
  readonly revision: number;
  /** Cooperative cancellation, forwarded to the atomic write. */
  readonly signal?: AbortSignal;
  /** Per-phase progress, forwarded to the atomic write. */
  readonly onPhase?: (phase: AtomicWritePhase) => void;
}

/**
 * Outcome of one gated snapshot write: the bytes were installed, or the
 * write was fenced because a snapshot with a strictly newer revision is
 * already durable at the same path.
 */
export type SnapshotWriteStatus = "installed" | "superseded";

export interface SnapshotWriteOutcome {
  readonly status: SnapshotWriteStatus;
  readonly path: string;
  readonly revision: number;
  /** Atomic-write result; present exactly when `status` is "installed". */
  readonly result?: AtomicWriteResult;
}

/**
 * Shared serialization/fencing owner for snapshot replacements of one open
 * document (ticket #51). The save coordinator and the recovery journal's
 * compaction both write the project path; without a shared owner, a slow
 * save captured at an older revision can finish after compaction installed
 * a newer snapshot and overwrite it, leaving a stale snapshot beside a
 * newer journal anchor that recovery then rejects.
 *
 * - Writes are serialized per path: one atomic write runs at a time and
 *   later requests queue in submission order, so an older captured
 *   revision can never finish last and regress the durable snapshot.
 * - Stale-write fencing: a queued write whose revision is strictly older
 *   than the snapshot already installed at that path is skipped with
 *   `superseded` instead of touching the port.
 * - `dispose()` rejects queued writes; an in-flight write completes
 *   normally (a resolved port write means the replace committed).
 *
 * The gate owns no semantic state: it never parses or validates bytes and
 * never decides which revision is correct; it only orders and fences
 * replacements for a path.
 */
export interface SnapshotWriteGate {
  write(request: SnapshotWriteRequest): Promise<SnapshotWriteOutcome>;
  /** Rejects queued writes and stops accepting new ones. */
  dispose(): void;
}

interface QueuedSnapshotWrite extends SnapshotWriteRequest {
  readonly resolve: (outcome: SnapshotWriteOutcome) => void;
  readonly reject: (error: unknown) => void;
}

class SnapshotWriteGateImpl implements SnapshotWriteGate {
  readonly #port: ProjectStoragePort;
  readonly #queues = new Map<string, QueuedSnapshotWrite[]>();
  readonly #inflight = new Set<string>();
  /** Newest revision installed per path (undefined before the first write). */
  readonly #lastInstalled = new Map<string, number>();
  #disposed = false;

  constructor(port: ProjectStoragePort) {
    this.#port = port;
  }

  write(request: SnapshotWriteRequest): Promise<SnapshotWriteOutcome> {
    if (this.#disposed) {
      return Promise.reject(
        storageIoError(
          IO_ERROR_CODES.writeFailed,
          "The snapshot write gate is disposed",
          { path: request.path },
        ),
      );
    }
    let queue = this.#queues.get(request.path);
    if (queue === undefined) {
      queue = [];
      this.#queues.set(request.path, queue);
    }
    return new Promise<SnapshotWriteOutcome>((resolve, reject) => {
      queue.push({ ...request, resolve, reject });
      void this.#pump(request.path);
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [path, queue] of this.#queues) {
      const error = storageIoError(
        IO_ERROR_CODES.writeInterrupted,
        "The snapshot write gate was disposed",
        { path },
      );
      for (const request of queue.splice(0)) request.reject(error);
    }
  }

  async #pump(path: string): Promise<void> {
    if (this.#disposed || this.#inflight.has(path)) return;
    const queue = this.#queues.get(path);
    const request = queue?.shift();
    if (request === undefined) return;
    const lastInstalled = this.#lastInstalled.get(path);
    if (lastInstalled !== undefined && request.revision < lastInstalled) {
      // Stale-write fencing: the captured revision is already covered by a
      // strictly newer durable snapshot at this path. Installing the older
      // bytes would regress the durable state, so the write is skipped.
      request.resolve({
        status: "superseded",
        path: request.path,
        revision: request.revision,
      });
      void this.#pump(path);
      return;
    }
    this.#inflight.add(path);
    try {
      const result = await this.#port.writeProjectAtomic(path, request.bytes, {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onPhase === undefined ? {} : { onPhase: request.onPhase }),
      });
      this.#lastInstalled.set(path, request.revision);
      request.resolve({
        status: "installed",
        path: request.path,
        revision: request.revision,
        result,
      });
    } catch (error) {
      request.reject(error);
    } finally {
      this.#inflight.delete(path);
      void this.#pump(path);
    }
  }
}

/** Creates the shared snapshot-write gate for one open document. */
export function createSnapshotWriteGate(
  port: ProjectStoragePort,
): SnapshotWriteGate {
  return new SnapshotWriteGateImpl(port);
}
