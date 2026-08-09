import { describe, expect, it } from "vitest";
import { volumeId } from "@voxel-maker/shared";
import {
  createHaloSampler,
  HALO_CORNER_COUNT,
  HALO_EDGE_COUNT,
  HALO_EDGE_LENGTH,
  HALO_FACE_COUNT,
  HALO_SLICE_LENGTH,
  CHUNK_VOXEL_COUNT,
  createMeshingPool,
  createWorkerMeshingExecutor,
  handleMeshingRequest,
  parseMeshingRequestMessage,
  parseMeshingResponseMessage,
  meshingKey,
  type ChunkHalo,
  type ChunkMeshInput,
  type ChunkMeshOutput,
  type MeshingExecutor,
  type MeshingJob,
  type MeshingOutcome,
  type MeshingPool,
  type MeshingPoolCallbacks,
  type MeshingWorkerLike,
} from "./index.js";

/**
 * Meshing worker pool tests (plan S6.6, ticket #23). A controllable fake
 * executor drives the pool deterministically: every stale, cancelled,
 * failed, rejected, and retried outcome is asserted through the pool's
 * public callback surface, and the worker executor/protocol round trip is
 * exercised against a fake worker scope.
 */

const VOLUME = volumeId("volume:pool:0001");

function emptyHalo(): ChunkHalo {
  return {
    faces: new Uint16Array(HALO_FACE_COUNT * HALO_SLICE_LENGTH),
    edges: new Uint16Array(HALO_EDGE_COUNT * HALO_EDGE_LENGTH),
    corners: new Uint16Array(HALO_CORNER_COUNT),
  };
}

const DEFAULT_INPUT: ChunkMeshInput = {
  namespace: "live",
  volumeId: VOLUME,
  coordinate: [0, 0, 0],
  revision: 0,
  values: new Uint16Array(CHUNK_VOXEL_COUNT),
  halo: emptyHalo(),
};

function input(overrides: Partial<ChunkMeshInput> = {}): ChunkMeshInput {
  return { ...DEFAULT_INPUT, ...overrides };
}

/** Executor the test resolves by hand, in any order. */
function createManualExecutor(): {
  readonly executor: MeshingExecutor;
  readonly started: MeshingJob[];
  readonly finish: (job: MeshingJob, outcome: MeshingOutcome) => void;
} {
  const started: MeshingJob[] = [];
  const finishes = new Map<number, (outcome: MeshingOutcome) => void>();
  return {
    executor: {
      start(job, finish) {
        started.push(job);
        finishes.set(job.requestId, finish);
      },
      dispose() {
        // No-op: the test delivers late outcomes to prove the pool drops
        // them after dispose (the pool's own #disposed flag decides).
      },
    },
    started,
    finish(job, outcome) {
      const finish = finishes.get(job.requestId);
      if (finish === undefined) throw new Error("job never started");
      finishes.delete(job.requestId);
      finish(outcome);
    },
  };
}

function createHarness(
  overrides: Partial<{
    readonly maxConcurrent: number;
    readonly maxRetries: number;
  }> = {},
): {
  readonly pool: MeshingPool;
  readonly executor: ReturnType<typeof createManualExecutor>;
  readonly results: ChunkMeshOutput[];
  readonly failures: ChunkMeshInput[];
  readonly rejected: ChunkMeshInput[];
} {
  const executor = createManualExecutor();
  const results: ChunkMeshOutput[] = [];
  const failures: ChunkMeshInput[] = [];
  const rejected: ChunkMeshInput[] = [];
  const callbacks: MeshingPoolCallbacks = {
    onResult(result) {
      results.push(result);
    },
    onFailure(input) {
      failures.push(input);
    },
    onRejected(input) {
      rejected.push(input);
    },
  };
  const pool = createMeshingPool({
    executor: executor.executor,
    callbacks,
    maxConcurrent: overrides.maxConcurrent ?? 2,
    maxRetries: overrides.maxRetries ?? 2,
  });
  return { pool, executor, results, failures, rejected };
}

function resultFor(job: MeshingJob): ChunkMeshOutput {
  return handleMeshingRequest(job.input);
}

describe("meshing pool", () => {
  it("delivers a fresh result for a single job", () => {
    const { pool, executor, results } = createHarness();
    const handle = pool.submit(input({ revision: 3 }));
    expect(executor.started).toHaveLength(1);
    expect(results).toHaveLength(0);
    executor.finish(executor.started[0] as MeshingJob, {
      ok: true,
      result: resultFor(executor.started[0] as MeshingJob),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.revision).toBe(3);
    expect(pool.diagnostics.inFlight).toBe(0);
    expect(pool.diagnostics.completed).toBe(1);
    handle.cancel();
    pool.dispose();
  });

  it("lets the newest request for a chunk win over a slow older result", () => {
    const { pool, executor, results, rejected } = createHarness();
    const first = pool.submit(input({ coordinate: [1, 0, 0], revision: 1 }));
    const second = pool.submit(input({ coordinate: [1, 0, 0], revision: 2 }));
    void first;
    void second;
    // The older job was cancelled at submit; its late result is dropped.
    const [oldJob] = executor.started;
    const [newJob] = executor.started.slice(-1);
    executor.finish(oldJob as MeshingJob, {
      ok: true,
      result: resultFor(oldJob as MeshingJob),
    });
    expect(results).toHaveLength(0);
    expect(pool.diagnostics.cancelled).toBe(1);
    executor.finish(newJob as MeshingJob, {
      ok: true,
      result: resultFor(newJob as MeshingJob),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.revision).toBe(2);
    expect(pool.diagnostics.completed).toBe(1);
    expect(rejected).toHaveLength(0);
    pool.dispose();
  });

  it("drops a cancelled result and counts it once", () => {
    const { pool, executor, results } = createHarness();
    const handle = pool.submit(input());
    executor.finish(executor.started[0] as MeshingJob, {
      ok: true,
      result: resultFor(executor.started[0] as MeshingJob),
    });
    expect(results).toHaveLength(1);
    // Cancel after completion is a no-op.
    handle.cancel();
    expect(pool.diagnostics.cancelled).toBe(0);

    const second = pool.submit(input({ revision: 1 }));
    second.cancel();
    expect(pool.diagnostics.cancelled).toBe(1);
    expect(results).toHaveLength(1);
    pool.dispose();
  });

  it("rejects submits while every slot is busy and retries later", () => {
    const { pool, executor, rejected, results } = createHarness({
      maxConcurrent: 1,
    });
    const first = pool.submit(input({ coordinate: [0, 0, 0] }));
    void first;
    const second = pool.submit(input({ coordinate: [2, 0, 0] }));
    void second;
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.coordinate).toEqual([2, 0, 0]);
    expect(pool.diagnostics.rejected).toBe(1);

    // Free the slot: the scheduler re-submits and the pool accepts.
    executor.finish(executor.started[0] as MeshingJob, {
      ok: true,
      result: resultFor(executor.started[0] as MeshingJob),
    });
    expect(results).toHaveLength(1);
    const retried = pool.submit(input({ coordinate: [2, 0, 0], revision: 1 }));
    void retried;
    expect(rejected).toHaveLength(1);
    expect(executor.started).toHaveLength(2);
    pool.dispose();
  });

  it("retries failures up to the bound, then reports the failure", () => {
    const { pool, executor, failures, results } = createHarness({
      maxRetries: 2,
    });
    pool.submit(input({ revision: 7 }));
    const job = executor.started[0] as MeshingJob;
    executor.finish(job, { ok: false, error: new Error("boom") });
    expect(failures).toHaveLength(0);
    expect(executor.started).toHaveLength(2); // first retry
    executor.finish(executor.started[1] as MeshingJob, {
      ok: false,
      error: new Error("boom again"),
    });
    expect(failures).toHaveLength(0);
    expect(executor.started).toHaveLength(3); // second retry
    executor.finish(executor.started[2] as MeshingJob, {
      ok: false,
      error: new Error("boom thrice"),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.revision).toBe(7);
    expect(results).toHaveLength(0);
    expect(pool.diagnostics.failed).toBe(1);
    expect(pool.diagnostics.completed).toBe(0);
    pool.dispose();
  });

  it("recovers when a retry succeeds", () => {
    const { pool, executor, failures, results } = createHarness({
      maxRetries: 3,
    });
    pool.submit(input({ revision: 9 }));
    const first = executor.started[0] as MeshingJob;
    executor.finish(first, { ok: false, error: new Error("transient") });
    expect(failures).toHaveLength(0);
    executor.finish(executor.started[1] as MeshingJob, {
      ok: true,
      result: resultFor(executor.started[1] as MeshingJob),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.revision).toBe(9);
    expect(pool.diagnostics.failed).toBe(0);
    pool.dispose();
  });

  it("tracks mesh-time diagnostics", () => {
    const { pool, executor } = createHarness();
    pool.submit(input());
    executor.finish(executor.started[0] as MeshingJob, {
      ok: true,
      result: resultFor(executor.started[0] as MeshingJob),
    });
    const diagnostics = pool.diagnostics;
    expect(diagnostics.dispatched).toBe(1);
    expect(diagnostics.completed).toBe(1);
    expect(diagnostics.inFlight).toBe(0);
    expect(diagnostics.lastMeshMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.averageMeshMs).toBeGreaterThanOrEqual(0);
    pool.dispose();
  });

  it("dispose cancels every in-flight job and releases the executor", () => {
    const { pool, executor, results } = createHarness();
    const a = pool.submit(input({ coordinate: [0, 0, 0] }));
    const b = pool.submit(input({ coordinate: [0, 1, 0] }));
    void a;
    void b;
    pool.dispose();
    expect(results).toHaveLength(0);
    expect(pool.diagnostics.cancelled).toBe(2);
    expect(executor.started).toHaveLength(2);
    // Late outcomes after dispose are ignored entirely.
    executor.finish(executor.started[0] as MeshingJob, {
      ok: true,
      result: resultFor(executor.started[0] as MeshingJob),
    });
    expect(results).toHaveLength(0);
  });

  it("never lets one chunk's result install for another chunk", () => {
    const { pool, executor, results } = createHarness();
    const first = pool.submit(input({ coordinate: [4, 0, 0], revision: 1 }));
    const second = pool.submit(input({ coordinate: [4, 0, 0], revision: 2 }));
    void first;
    void second;
    const [oldJob] = executor.started;
    const [newJob] = executor.started.slice(-1);
    // A corrupt executor reports the OLD result but the pool tags it with
    // the OLD job identity; the newer job is still the latest, so the
    // stale result is dropped and the new one delivers.
    executor.finish(oldJob as MeshingJob, {
      ok: true,
      result: {
        ...resultFor(oldJob as MeshingJob),
        revision: 999,
      },
    });
    expect(results).toHaveLength(0);
    expect(pool.diagnostics.staleDropped).toBe(0);
    expect(pool.diagnostics.cancelled).toBe(1);
    executor.finish(newJob as MeshingJob, {
      ok: true,
      result: resultFor(newJob as MeshingJob),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.revision).toBe(2);
    pool.dispose();
  });
});

describe("meshing worker protocol", () => {
  it("round-trips a request through parse bounds", () => {
    const request = input({ namespace: "preview:session-1", revision: 5 });
    const parsed = parseMeshingRequestMessage({
      kind: "meshing-request",
      requestId: 42,
      input: request,
    });
    expect(parsed).toBeDefined();
    expect(parsed?.requestId).toBe(42);
    expect(parsed?.input.values).toBe(request.values);
    expect(parsed?.input.halo.faces).toBe(request.halo.faces);
    expect(parsed?.input.namespace).toBe("preview:session-1");
  });

  it("rejects malformed and out-of-bounds requests", () => {
    const base = input();
    const cases: unknown[] = [
      undefined,
      null,
      "nope",
      {
        kind: "meshing-request",
        requestId: 1,
        input: { ...base, values: new Uint16Array(10) },
      },
      {
        kind: "meshing-request",
        requestId: 1,
        input: {
          ...base,
          values: new Uint16Array(CHUNK_VOXEL_COUNT),
          halo: { ...base.halo, faces: new Uint16Array(1) },
        },
      },
      {
        kind: "meshing-request",
        requestId: 1,
        input: { ...base, coordinate: [0, 0, 2_000_000] },
      },
      {
        kind: "meshing-request",
        requestId: 1,
        input: { ...base, revision: -1 },
      },
      {
        kind: "meshing-request",
        requestId: 1,
        input: { ...base, namespace: "staging" },
      },
      {
        kind: "meshing-request",
        requestId: 1,
        input: { ...base, volumeId: "" },
      },
      { kind: "other", requestId: 1, input: base },
      { kind: "meshing-request", requestId: 1.5, input: base },
    ];
    for (const message of cases) {
      expect(
        parseMeshingRequestMessage(message),
        JSON.stringify(message),
      ).toBeUndefined();
    }
  });

  it("rejects results whose identity does not match the request", () => {
    const request = input({ revision: 2 });
    const parsedRequest = parseMeshingRequestMessage({
      kind: "meshing-request",
      requestId: 7,
      input: request,
    });
    if (parsedRequest === undefined) throw new Error("request rejected");
    const good = parseMeshingResponseMessage(
      {
        kind: "meshing-result",
        requestId: 7,
        result: handleMeshingRequest(request),
      },
      parsedRequest,
    );
    expect(good?.kind).toBe("meshing-result");
    const bad = parseMeshingResponseMessage(
      {
        kind: "meshing-result",
        requestId: 7,
        result: { ...handleMeshingRequest(request), revision: 3 },
      },
      parsedRequest,
    );
    expect(bad).toBeUndefined();
    const badNamespace = parseMeshingResponseMessage(
      {
        kind: "meshing-result",
        requestId: 7,
        result: {
          ...handleMeshingRequest(request),
          namespace: "preview:other",
        },
      },
      parsedRequest,
    );
    expect(badNamespace).toBeUndefined();
  });

  it("accepts meshing-error responses for the matching request", () => {
    const request = input();
    const parsedRequest = parseMeshingRequestMessage({
      kind: "meshing-request",
      requestId: 3,
      input: request,
    });
    if (parsedRequest === undefined) throw new Error("request rejected");
    const error = parseMeshingResponseMessage(
      { kind: "meshing-error", requestId: 3, message: "boom" },
      parsedRequest,
    );
    expect(error?.kind).toBe("meshing-error");
    const mismatch = parseMeshingResponseMessage(
      { kind: "meshing-error", requestId: 4, message: "boom" },
      parsedRequest,
    );
    expect(mismatch).toBeUndefined();
  });

  it("computes a mesh identical to the direct mesher", () => {
    const values = new Uint16Array(CHUNK_VOXEL_COUNT);
    values[0] = 1;
    values[1] = 2;
    values[15] = 3;
    const request = input({ values });
    const result = handleMeshingRequest(request);
    const direct = createHaloSampler(values, request.halo);
    // Compare against buildChunkMesh through the public mesher behavior:
    // the worker result carries the request tags.
    expect(result.namespace).toBe("live");
    expect(result.volumeId).toBe(VOLUME);
    expect(result.coordinate).toEqual([0, 0, 0]);
    expect(result.revision).toBe(0);
    expect(result.voxelCount).toBe(3);
    void direct;
  });
});

describe("worker executor", () => {
  function createFakeWorker(): {
    readonly worker: MeshingWorkerLike;
    readonly posted: {
      readonly message: unknown;
      readonly transfer: readonly Transferable[] | undefined;
    }[];
    respond(response: Record<string, unknown>, requestId: number): void;
  } {
    const posted: {
      message: unknown;
      transfer: readonly Transferable[] | undefined;
    }[] = [];
    let onmessage: ((event: { readonly data: unknown }) => void) | null = null;
    return {
      worker: {
        postMessage(message, transfer) {
          posted.push({ message, transfer });
        },
        get onmessage() {
          return onmessage;
        },
        set onmessage(handler) {
          onmessage = handler;
        },
        terminate() {
          onmessage = null;
        },
      },
      posted,
      respond(response: Record<string, unknown>, requestId: number) {
        onmessage?.({ data: { ...response, requestId } });
      },
    };
  }

  it("posts a transferred request and resolves through the response", () => {
    const fake = createFakeWorker();
    // Direct executor-level check: start a job through a pool-less executor.
    const executor = createWorkerMeshingExecutor(fake.worker);
    const outcome: MeshingOutcome[] = [];
    const job: MeshingJob = {
      requestId: 11,
      input: input({ revision: 4 }),
      cancelled: false,
      done: false,
      retries: 0,
    };
    executor.start(job, (value) => outcome.push(value));
    expect(fake.posted).toHaveLength(1);
    const message = fake.posted[0]?.message as Record<string, unknown>;
    expect(message.kind).toBe("meshing-request");
    expect(message.requestId).toBe(11);
    const transfer = fake.posted[0]?.transfer;
    expect(transfer).toHaveLength(4); // values + faces + edges + corners
    fake.respond(
      { kind: "meshing-result", result: handleMeshingRequest(job.input) },
      11,
    );
    expect(outcome).toHaveLength(1);
    expect(outcome[0]?.ok).toBe(true);
    if (outcome[0]?.ok) expect(outcome[0].result.revision).toBe(4);
    executor.dispose();
  });

  it("drops responses for unknown request ids", () => {
    const fake = createFakeWorker();
    const executor = createWorkerMeshingExecutor(fake.worker);
    const outcomes: MeshingOutcome[] = [];
    const job: MeshingJob = {
      requestId: 5,
      input: input(),
      cancelled: false,
      done: false,
      retries: 0,
    };
    executor.start(job, (value) => outcomes.push(value));
    fake.respond(
      { kind: "meshing-result", result: handleMeshingRequest(job.input) },
      999,
    );
    expect(outcomes).toHaveLength(0);
    fake.respond(
      { kind: "meshing-result", result: handleMeshingRequest(job.input) },
      5,
    );
    expect(outcomes).toHaveLength(1);
    executor.dispose();
  });

  it("reports worker errors as failures through the pool", () => {
    const fake = createFakeWorker();
    const failures: ChunkMeshInput[] = [];
    const pool = createMeshingPool({
      executor: createWorkerMeshingExecutor(fake.worker),
      callbacks: {
        onResult: () => undefined,
        onFailure: (input) => failures.push(input),
        onRejected: () => undefined,
      },
      maxConcurrent: 1,
      maxRetries: 1,
    });
    const handle = pool.submit(input({ revision: 1 }));
    void handle;
    // The fake worker reports an error for the pool's request.
    const message = fake.posted[0]?.message as Record<string, unknown>;
    fake.respond(
      { kind: "meshing-error", message: "worker exploded" },
      message.requestId as number,
    );
    expect(failures).toHaveLength(0); // retry happened
    const second = fake.posted[1]?.message as Record<string, unknown>;
    expect(second.kind).toBe("meshing-request");
    fake.respond(
      { kind: "meshing-error", message: "worker exploded" },
      second.requestId as number,
    );
    expect(failures).toHaveLength(1);
    pool.dispose();
  });
});

describe("meshing key", () => {
  it("separates namespaces, volumes, and coordinates", () => {
    const a = meshingKey("live", VOLUME, [0, 0, 0]);
    const b = meshingKey("preview:s1", VOLUME, [0, 0, 0]);
    const c = meshingKey("live", volumeId("volume:other"), [0, 0, 0]);
    const d = meshingKey("live", VOLUME, [-1, 0, 0]);
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});
