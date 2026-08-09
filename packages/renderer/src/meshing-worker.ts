import { buildChunkMesh } from "./mesher.js";
import { createHaloSampler } from "./halo.js";
import type { ChunkMeshInput, ChunkMeshOutput } from "./types.js";
import {
  meshingResultTransfer,
  parseMeshingRequestMessage,
} from "./worker-protocol.js";

/**
 * Meshing worker compute entry (plan S6.6, ticket #23).
 *
 * `handleMeshingRequest` is the pure, node-testable worker half: it
 * builds a deterministic face-culled mesh from the copied immutable
 * chunk-and-halo buffers and tags the result with the request's
 * namespace, volume, coordinate, and revision. It never touches
 * authoritative state — everything it needs arrived in the message.
 *
 * `createMeshingWorkerScope` installs the thin message glue onto any
 * worker-like scope (a real `WorkerGlobalScope` in the app, or a fake in
 * tests): parse-and-bound the request, compute, transfer the geometry
 * back. The desktop app's worker entry is a one-liner that calls it.
 */

/**
 * Computes one chunk mesh from copied immutable input. Throws only for
 * malformed input (never for semantic conditions); the pool turns throws
 * into a bounded retry/error lifecycle.
 */
export function handleMeshingRequest(input: ChunkMeshInput): ChunkMeshOutput {
  const geometry = buildChunkMesh(
    input.values,
    createHaloSampler(input.values, input.halo),
  );
  return {
    namespace: input.namespace,
    volumeId: input.volumeId,
    coordinate: input.coordinate,
    revision: input.revision,
    ...geometry,
  };
}

/** Minimal worker scope surface used by the message glue (testable). */
export interface MeshingWorkerScope {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
}

/** Human-readable failure for a malformed request (no requestId available). */
const MALFORMED_MESSAGE = "Malformed or out-of-bounds meshing request";

/**
 * Installs the request/response glue on `scope` and returns an uninstall
 * function. Every request is parsed and bounded before compute; results
 * are transferred back with the request's identity tags intact.
 */
export function createMeshingWorkerScope(
  scope: MeshingWorkerScope,
): () => void {
  const handleMessage = (event: { readonly data: unknown }): void => {
    const request = parseMeshingRequestMessage(event.data);
    if (request === undefined) {
      scope.postMessage({
        kind: "meshing-error",
        requestId: -1,
        message: MALFORMED_MESSAGE,
      });
      return;
    }
    try {
      const result = handleMeshingRequest(request.input);
      scope.postMessage(
        { kind: "meshing-result", requestId: request.requestId, result },
        meshingResultTransfer(result),
      );
    } catch (error) {
      scope.postMessage({
        kind: "meshing-error",
        requestId: request.requestId,
        message:
          error instanceof Error ? error.message : "Meshing worker failure",
      });
    }
  };
  scope.onmessage = handleMessage;
  return () => {
    if (scope.onmessage === handleMessage) scope.onmessage = null;
  };
}
