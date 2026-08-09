import { handleMeshingRequest } from "./meshing-worker.js";
import {
  meshingRequestTransfer,
  parseMeshingResponseMessage,
  type MeshingWorkerRequestMessage,
} from "./worker-protocol.js";
import type {
  MeshingExecutor,
  MeshingJob,
  MeshingOutcome,
} from "./meshing-pool.js";

/**
 * Meshing executors (plan S6.6, ticket #23): the two concrete ways a
 * meshing job runs.
 *
 * - The in-process executor computes on the caller's stack — the headless
 *   and test path. It still receives only copied immutable input and its
 *   result still flows through the pool's stale/cancel/retry lifecycle.
 * - The worker executor posts a transferred request to a real Web Worker
 *   and resolves through its messages. The worker's scope glue lives in
 *   `meshing-worker.ts`; the desktop composition root supplies the worker
 *   so the renderer package stays environment-agnostic.
 */

/** Error message for a response that failed protocol validation. */
const MALFORMED_RESPONSE = "Malformed or out-of-bounds worker response";

/** Executor that computes synchronously on the calling thread. */
export function createInProcessMeshingExecutor(): MeshingExecutor {
  return {
    start(job: MeshingJob, finish: (outcome: MeshingOutcome) => void): void {
      try {
        finish({ ok: true, result: handleMeshingRequest(job.input) });
      } catch (error: unknown) {
        finish({ ok: false, error });
      }
    },
    dispose(): void {
      // Nothing to release: computation is pure and synchronous.
    },
  };
}

/** The minimal worker surface the executor drives. */
export interface MeshingWorkerLike {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  terminate(): void;
}

/**
 * Executor that posts transferred jobs to a Web Worker. Responses are
 * validated against the stored request (identity tags must match exactly)
 * before they resolve; unknown or cancelled request ids are dropped.
 */
export function createWorkerMeshingExecutor(
  worker: MeshingWorkerLike,
): MeshingExecutor {
  const pending = new Map<
    number,
    {
      readonly request: MeshingWorkerRequestMessage;
      readonly finish: (outcome: MeshingOutcome) => void;
    }
  >();

  worker.onmessage = (event: { readonly data: unknown }): void => {
    const data = event.data;
    if (typeof data !== "object" || data === null) return;
    const message = data as Record<string, unknown>;
    if (
      (message.kind !== "meshing-result" && message.kind !== "meshing-error") ||
      typeof message.requestId !== "number"
    ) {
      return;
    }
    const entry = pending.get(message.requestId);
    if (entry === undefined) return; // cancelled or unknown: drop.
    const parsed = parseMeshingResponseMessage(data, entry.request);
    pending.delete(message.requestId);
    if (parsed === undefined) {
      entry.finish({ ok: false, error: new Error(MALFORMED_RESPONSE) });
      return;
    }
    if (parsed.kind === "meshing-result") {
      entry.finish({ ok: true, result: parsed.result });
    } else {
      entry.finish({ ok: false, error: new Error(parsed.message) });
    }
  };

  return {
    start(job: MeshingJob, finish: (outcome: MeshingOutcome) => void): void {
      const request: MeshingWorkerRequestMessage = {
        kind: "meshing-request",
        requestId: job.requestId,
        input: job.input,
      };
      pending.set(job.requestId, { request, finish });
      worker.postMessage(request, meshingRequestTransfer(job.input));
    },
    dispose(): void {
      worker.onmessage = null;
      worker.terminate();
    },
  };
}
