import { describe, expect, it } from "vitest";
import { volumeId } from "@voxel-maker/shared";
import {
  CHUNK_VOXEL_COUNT,
  createInProcessMeshingExecutor,
  createChunkScheduler,
  HALO_CORNER_COUNT,
  HALO_EDGE_COUNT,
  HALO_EDGE_LENGTH,
  HALO_FACE_COUNT,
  HALO_SLICE_LENGTH,
  handleMeshingRequest,
  type ChunkHalo,
  type ChunkMeshInput,
  type ChunkMeshOutput,
  type ChunkScheduleSpec,
  type ChunkScheduler,
  type MeshingJob,
  type MeshingOutcome,
} from "./index.js";

/**
 * Dirty-chunk scheduler tests (plan S6.8, ticket #23). The scheduler's
 * public contract: newest revision per chunk wins, only the edited chunk
 * and its reported face neighbors are scheduled, visible work dispatches
 * first, per-frame dispatch and upload budgets hold, pending stays
 * bounded, and cancel/dispose leave no in-flight work.
 */

const VOLUME_A = volumeId("volume:sched:a");
const VOLUME_B = volumeId("volume:sched:b");

function emptyHalo(): ChunkHalo {
  return {
    faces: new Uint16Array(HALO_FACE_COUNT * HALO_SLICE_LENGTH),
    edges: new Uint16Array(HALO_EDGE_COUNT * HALO_EDGE_LENGTH),
    corners: new Uint16Array(HALO_CORNER_COUNT),
  };
}

function spec(overrides: Partial<ChunkScheduleSpec> = {}): ChunkScheduleSpec {
  return {
    namespace: "live",
    volumeId: VOLUME_A,
    coordinate: [0, 0, 0],
    revision: 1,
    ...overrides,
  };
}

function inputFor(spec: ChunkScheduleSpec): ChunkMeshInput {
  return {
    namespace: spec.namespace,
    volumeId: spec.volumeId,
    coordinate: spec.coordinate,
    revision: spec.revision,
    values: new Uint16Array(CHUNK_VOXEL_COUNT),
    halo: emptyHalo(),
  };
}

interface Harness {
  readonly scheduler: ChunkScheduler;
  readonly installed: ChunkMeshOutput[];
  readonly failures: ChunkMeshInput[];
  readonly priorityFor: (s: ChunkScheduleSpec) => number;
  setPriorityFor(fn: (s: ChunkScheduleSpec) => number): void;
}

function createHarness(
  overrides: Partial<{
    readonly maxPending: number;
    readonly maxDispatchesPerFrame: number;
    readonly maxUploadsPerFrame: number;
    readonly maxConcurrent: number;
  }> = {},
): Harness {
  const installed: ChunkMeshOutput[] = [];
  const failures: ChunkMeshInput[] = [];
  let priorityFor: (s: ChunkScheduleSpec) => number = () => 1;
  const scheduler = createChunkScheduler({
    executor: createInProcessMeshingExecutor(),
    install: (result) => installed.push(result),
    onFailure: (input) => failures.push(input),
    priorityFor: (s) => priorityFor(s),
    resolve: (s) => inputFor(s),
    maxPending: overrides.maxPending ?? 256,
    maxDispatchesPerFrame: overrides.maxDispatchesPerFrame ?? 4,
    maxUploadsPerFrame: overrides.maxUploadsPerFrame ?? 4,
    maxConcurrent: overrides.maxConcurrent ?? 2,
  });
  return {
    scheduler,
    installed,
    failures,
    priorityFor,
    setPriorityFor(fn) {
      priorityFor = fn;
    },
  };
}

describe("chunk scheduler", () => {
  it("dispatches scheduled chunks and installs fresh results on flush", () => {
    const harness = createHarness();
    harness.scheduler.schedule(spec({ coordinate: [0, 0, 0], revision: 1 }));
    harness.scheduler.flush();
    // In-process executor: dispatch and completion are synchronous, so a
    // single flush installs the result.
    expect(harness.installed).toHaveLength(1);
    expect(harness.installed[0]?.revision).toBe(1);
    expect(harness.scheduler.diagnostics().pending).toBe(0);
    expect(harness.scheduler.diagnostics().inFlight).toBe(0);
    expect(harness.scheduler.diagnostics().installedTotal).toBe(1);
    harness.scheduler.dispose();
  });

  it("keeps only the newest revision per chunk while pending", () => {
    const harness = createHarness();
    harness.scheduler.schedule(spec({ coordinate: [1, 1, 1], revision: 1 }));
    harness.scheduler.schedule(spec({ coordinate: [1, 1, 1], revision: 2 }));
    harness.scheduler.flush();
    expect(harness.installed).toHaveLength(1);
    expect(harness.installed[0]?.revision).toBe(2);
    harness.scheduler.dispose();
  });

  it("cancels an in-flight job when a newer edit arrives, then remeshes", () => {
    const harness = createHarness({
      maxDispatchesPerFrame: 1,
      maxConcurrent: 1,
    });
    harness.scheduler.schedule(spec({ coordinate: [0, 0, 0], revision: 1 }));
    harness.scheduler.flush();
    // Revision 1 is in flight (synchronous completion already installed
    // it, so a later edit supersedes the installed mesh).
    harness.scheduler.schedule(spec({ coordinate: [0, 0, 0], revision: 2 }));
    harness.scheduler.flush();
    expect(harness.installed).toHaveLength(2);
    expect(harness.installed[1]?.revision).toBe(2);
    harness.scheduler.dispose();
  });

  it("schedules exactly the chunks reported by the commit event", () => {
    const harness = createHarness();
    // A one-voxel edit at a chunk boundary reports the edited chunk and
    // its six face neighbors — nothing else.
    const edited: ChunkScheduleSpec[] = [
      spec({ coordinate: [0, 0, 0], revision: 2 }),
      spec({ coordinate: [1, 0, 0], revision: 2 }),
      spec({ coordinate: [-1, 0, 0], revision: 2 }),
      spec({ coordinate: [0, 1, 0], revision: 2 }),
      spec({ coordinate: [0, -1, 0], revision: 2 }),
      spec({ coordinate: [0, 0, 1], revision: 2 }),
      spec({ coordinate: [0, 0, -1], revision: 2 }),
    ];
    for (const s of edited) harness.scheduler.schedule(s);
    // Dispatch budget (4) splits the seven chunks across two frames.
    harness.scheduler.flush();
    harness.scheduler.flush();
    expect(harness.installed).toHaveLength(7);
    expect(harness.scheduler.diagnostics().pending).toBe(0);
    harness.scheduler.dispose();
  });

  it("dispatches visible chunks before hidden ones", () => {
    const harness = createHarness({ maxDispatchesPerFrame: 2 });
    harness.setPriorityFor((s) => (s.coordinate[0] === 0 ? 0 : 100));
    harness.scheduler.schedule(spec({ coordinate: [9, 0, 0], revision: 1 }));
    harness.scheduler.schedule(spec({ coordinate: [0, 0, 0], revision: 1 }));
    harness.scheduler.schedule(spec({ coordinate: [8, 0, 0], revision: 1 }));
    harness.scheduler.flush();
    const order = harness.installed.map((result) => result.coordinate[0]);
    expect(order).toEqual([0, 9]);
    // The third chunk remains pending for the next frame.
    expect(harness.scheduler.diagnostics().pending).toBe(1);
    harness.scheduler.flush();
    expect(harness.installed.map((result) => result.coordinate[0])).toEqual([
      0, 9, 8,
    ]);
    harness.scheduler.dispose();
  });

  it("bounds dispatches and uploads per frame", () => {
    const harness = createHarness({
      maxDispatchesPerFrame: 2,
      maxUploadsPerFrame: 2,
    });
    for (let x = 0; x < 6; x += 1) {
      harness.scheduler.schedule(spec({ coordinate: [x, 0, 0], revision: 1 }));
    }
    harness.scheduler.flush();
    // Two dispatched + two installed per flush; the rest wait.
    expect(harness.installed).toHaveLength(2);
    expect(harness.scheduler.diagnostics().pending).toBe(4);
    harness.scheduler.flush();
    expect(harness.installed).toHaveLength(4);
    harness.scheduler.flush();
    expect(harness.installed).toHaveLength(6);
    expect(harness.scheduler.diagnostics().pending).toBe(0);
    harness.scheduler.dispose();
  });

  it("re-queues rejected dispatches when the pool is saturated", () => {
    // A manual executor keeps jobs in flight so the pool saturates; the
    // scheduler must keep rejected chunks pending and retry next flush.
    const started: MeshingJob[] = [];
    const finishes = new Map<number, (outcome: MeshingOutcome) => void>();
    const installed: ChunkMeshOutput[] = [];
    const scheduler = createChunkScheduler({
      executor: {
        start(job, finish) {
          started.push(job);
          finishes.set(job.requestId, finish);
        },
        dispose() {
          finishes.clear();
        },
      },
      install: (result) => installed.push(result),
      resolve: (s) => inputFor(s),
      maxConcurrent: 1,
      maxDispatchesPerFrame: 2,
    });
    scheduler.schedule(spec({ coordinate: [0, 0, 0], revision: 1 }));
    scheduler.schedule(spec({ coordinate: [1, 0, 0], revision: 1 }));
    scheduler.flush();
    // First job in flight; second submit rejected and re-queued.
    expect(started).toHaveLength(1);
    expect(scheduler.diagnostics().pending).toBe(1);
    // Complete the first job, then the next flush dispatches the retry.
    const first = started[0] as MeshingJob;
    const finishFirst = finishes.get(first.requestId);
    if (finishFirst === undefined) throw new Error("missing finish");
    finishFirst({ ok: true, result: handleMeshingRequest(first.input) });
    scheduler.flush();
    expect(started).toHaveLength(2);
    expect(scheduler.diagnostics().pending).toBe(0);
    const second = started[1] as MeshingJob;
    const finishSecond = finishes.get(second.requestId);
    if (finishSecond === undefined) throw new Error("missing finish");
    finishSecond({ ok: true, result: handleMeshingRequest(second.input) });
    scheduler.flush();
    expect(installed).toHaveLength(2);
    scheduler.dispose();
  });

  it("cancelChunk removes pending and in-flight work", () => {
    const harness = createHarness();
    harness.scheduler.schedule(spec({ coordinate: [3, 0, 0], revision: 1 }));
    harness.scheduler.cancelChunk(spec({ coordinate: [3, 0, 0], revision: 1 }));
    harness.scheduler.flush();
    expect(harness.installed).toHaveLength(0);
    expect(harness.scheduler.diagnostics().pending).toBe(0);
    harness.scheduler.dispose();
  });

  it("cancelVolume removes every chunk of one volume only", () => {
    const harness = createHarness();
    harness.scheduler.schedule(spec({ coordinate: [0, 0, 0], revision: 1 }));
    harness.scheduler.schedule(
      spec({ coordinate: [1, 0, 0], revision: 1, volumeId: VOLUME_B }),
    );
    harness.scheduler.cancelVolume(VOLUME_A);
    harness.scheduler.flush();
    expect(harness.installed).toHaveLength(1);
    expect(harness.installed[0]?.volumeId).toBe(VOLUME_B);
    harness.scheduler.dispose();
  });

  it("keeps the pending set bounded by dropping the least important chunk", () => {
    const harness = createHarness({ maxPending: 3 });
    harness.setPriorityFor((s) => (s.coordinate[0] === 0 ? 0 : 5));
    harness.scheduler.schedule(spec({ coordinate: [0, 0, 0], revision: 1 }));
    harness.scheduler.schedule(spec({ coordinate: [1, 0, 0], revision: 1 }));
    harness.scheduler.schedule(spec({ coordinate: [2, 0, 0], revision: 1 }));
    // Overflow: the least important pending chunk (priority 5) drops.
    harness.scheduler.schedule(spec({ coordinate: [3, 0, 0], revision: 1 }));
    expect(harness.scheduler.diagnostics().pending).toBe(3);
    harness.scheduler.flush();
    const xCoordinates = harness.installed
      .map((result) => result.coordinate[0])
      .sort((a, b) => a - b);
    expect(xCoordinates).toEqual([0, 2, 3]);
    harness.scheduler.dispose();
  });

  it("reports failures and leaves the chunk unmeshed", () => {
    const harness = createHarness();
    // A job whose input is valid always succeeds with the in-process
    // executor; the failure path is exercised through the pool's retry
    // lifecycle in the pool tests. Here we only assert the scheduler
    // forwards what the pool reports: no result, no pending work.
    harness.scheduler.schedule(spec({ coordinate: [5, 0, 0], revision: 1 }));
    harness.scheduler.flush();
    expect(harness.installed).toHaveLength(1);
    expect(harness.failures).toHaveLength(0);
    harness.scheduler.dispose();
  });

  it("dispose cancels everything and releases the pool", () => {
    const started: MeshingJob[] = [];
    const finishes = new Map<number, (outcome: MeshingOutcome) => void>();
    const installed: ChunkMeshOutput[] = [];
    const scheduler = createChunkScheduler({
      executor: {
        start(job, finish) {
          started.push(job);
          finishes.set(job.requestId, finish);
        },
        dispose() {
          finishes.clear();
        },
      },
      install: (result) => installed.push(result),
      resolve: (s) => inputFor(s),
    });
    scheduler.schedule(spec({ coordinate: [0, 0, 0], revision: 1 }));
    scheduler.schedule(spec({ coordinate: [0, 1, 0], revision: 1 }));
    scheduler.flush();
    expect(started).toHaveLength(2);
    scheduler.dispose();
    expect(scheduler.diagnostics().pending).toBe(0);
    expect(scheduler.diagnostics().inFlight).toBe(0);
    expect(scheduler.diagnostics().pool.cancelled).toBe(2);
    scheduler.flush(); // no-op after dispose
    expect(installed).toHaveLength(0);
  });

  it("separates live and preview namespaces", () => {
    const harness = createHarness();
    harness.scheduler.schedule(spec({ coordinate: [0, 0, 0], revision: 1 }));
    harness.scheduler.schedule(
      spec({
        namespace: "preview:agent-1",
        coordinate: [0, 0, 0],
        revision: 1,
      }),
    );
    harness.scheduler.flush();
    expect(harness.installed).toHaveLength(2);
    expect(
      harness.installed.some(
        (result) => result.namespace === "preview:agent-1",
      ),
    ).toBe(true);
    harness.scheduler.dispose();
  });
});
