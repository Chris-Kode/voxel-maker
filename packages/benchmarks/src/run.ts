import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import {
  ANIMATION_TRACK_COUNTS,
  BENCHMARK_SCENE_KINDS,
  BENCHMARK_SIZES,
  createBenchmarkFixture,
  type BenchmarkSceneKind,
} from "./fixtures.js";
import {
  detectHardware,
  evaluateGates,
  resolveTier,
  summarizeGates,
  type GateResult,
} from "./gates.js";
import {
  measureAnimationScale,
  measureCommandLatency,
  measureExportGltf,
  measurePreviewLatency,
  measureRemeshAndPipeline,
  measureSaveLoad,
  memorySnapshot,
} from "./measure.js";
import type {
  BenchmarkReport,
  HardwareInfo,
  MemorySnapshot,
  SceneMeasurements,
  TierName,
} from "./report.js";

/**
 * Benchmark runner (ticket #45, ADR-0008): builds the deterministic
 * 100k/500k/1M fixture matrix, measures every gate metric headlessly
 * through the real command bus, scheduler, mesher, container codecs, and
 * export service, then evaluates the named-tier gates and returns the
 * full report. The runner never needs a GPU: the desktop frame gate is
 * represented by the measured main-thread pipeline cost (scheduler
 * flush) plus the animation frame budget, documented in
 * docs/performance.md.
 */

/** Options of one benchmark run. */
export interface RunBenchmarksOptions {
  readonly sizes?: readonly number[];
  readonly kinds?: readonly BenchmarkSceneKind[];
  readonly tier?: TierName | "auto";
  /** Latency samples per metric (ADR-0008: >=100 for p95 gates). */
  readonly samples?: number;
  /** Save/load repetitions (ADR-0008: five runs). */
  readonly saveLoadRuns?: number;
  /** Preview render samples (100k scenes only). */
  readonly previewSamples?: number;
  readonly previewSize?: number;
  /** Animation evaluation frames per track count. */
  readonly animationFrames?: number;
  /** Include export measurements for every size (default: 100k only). */
  readonly full?: boolean;
  readonly onProgress?: (message: string) => void;
}

/** One benchmark run result: report plus gate verdicts. */
export interface BenchmarkRunOutcome {
  readonly report: BenchmarkReport;
  readonly gates: readonly GateResult[];
  readonly gatesPass: boolean;
}

const progress = (
  onProgress: ((message: string) => void) | undefined,
  message: string,
): void => {
  onProgress?.(message);
};

/** Peak of several memory snapshots, per metric. */
function peakMemory(snapshots: readonly MemorySnapshot[]): MemorySnapshot {
  return {
    rssMiB: Math.max(...snapshots.map((s) => s.rssMiB)),
    heapUsedMiB: Math.max(...snapshots.map((s) => s.heapUsedMiB)),
    heapTotalMiB: Math.max(...snapshots.map((s) => s.heapTotalMiB)),
    arrayBuffersMiB: Math.max(...snapshots.map((s) => s.arrayBuffersMiB)),
  };
}

/** Runs the benchmark matrix and evaluates the resolved tier gates. */
export async function runBenchmarks(
  options: RunBenchmarksOptions = {},
): Promise<BenchmarkRunOutcome> {
  const started = performance.now();
  const sizes = options.sizes ?? BENCHMARK_SIZES;
  const kinds = options.kinds ?? BENCHMARK_SCENE_KINDS;
  const samples = options.samples ?? 100;
  const saveLoadRuns = options.saveLoadRuns ?? 5;
  const previewSamples = options.previewSamples ?? 10;
  const previewSize = options.previewSize ?? 256;
  const animationFrames = options.animationFrames ?? 60;
  const full = options.full ?? false;
  const tier = resolveTier(options.tier ?? "auto", cpus()[0]?.model ?? "");
  const hardware: HardwareInfo = detectHardware(tier);

  progress(options.onProgress, `tier resolved: ${tier} (${hardware.cpuModel})`);

  const scenes: Record<
    BenchmarkSceneKind,
    Record<string, SceneMeasurements>
  > = {
    compact: {},
    sparse: {},
    checkerboard: {},
  };
  for (const kind of kinds) {
    for (const size of sizes) {
      progress(options.onProgress, `building fixture ${kind} ${String(size)}`);
      const buildStart = performance.now();
      const fixture = createBenchmarkFixture(kind, size);
      const buildMs = performance.now() - buildStart;
      progress(
        options.onProgress,
        `  built ${String(fixture.occupiedCount)} voxels in ${buildMs.toFixed(1)} ms`,
      );

      // Order matters: save/load, export, and preview measure the
      // pristine fixture; command latency and the remesh pipeline are
      // the last measurements because they mutate the store.
      progress(options.onProgress, `  measuring save/load`);
      const saveLoad = measureSaveLoad(fixture, saveLoadRuns);

      // The interactive memory gate measures the editor footprint: the
      // open fixture plus installed meshes. Export and preview allocate
      // large transient buffers, so their memory is reported separately
      // (`export.peakRssMiB`, preview documented) and never distorts the
      // ADR-0008 open/navigate memory gate.
      const snapshots: MemorySnapshot[] = [memorySnapshot()];

      progress(options.onProgress, `  measuring command latency`);
      const command = measureCommandLatency(fixture, samples);

      progress(options.onProgress, `  measuring remesh + frame pipeline`);
      const remesh = await measureRemeshAndPipeline(fixture, samples);
      snapshots.push(memorySnapshot());

      const exportMeasurement =
        full || size === 100_000
          ? await measureExportGltf(fixture)
          : { summary: emptySummary(), bytes: 0, peakRssMiB: 0 };

      // Preview renders are software-rasterized: measure them on the 100k
      // interactive target only (larger scenes gate on the frame pipeline).
      const preview =
        size === 100_000
          ? measurePreviewLatency(fixture, previewSamples, previewSize)
          : undefined;

      const inputToPreview95Ms =
        preview === undefined
          ? command.p95 + remesh.remesh.p95 + remesh.flush.p95
          : command.p95 +
            remesh.remesh.p95 +
            remesh.flush.p95 +
            preview.p95;

      scenes[kind][String(size)] = {
        buildMs,
        command,
        remesh: remesh.remesh,
        queueWait: remesh.queueWait,
        flush: remesh.flush,
        meshSettleMs: remesh.meshSettleMs,
        meshing: remesh.meshing,
        save: saveLoad.save,
        load: saveLoad.load,
        export: exportMeasurement,
        ...(preview === undefined ? {} : { preview }),
        inputToPreview95Ms,
        memory: peakMemory(snapshots),
      } satisfies SceneMeasurements;
    }
  }

  progress(options.onProgress, `measuring animation scaling`);
  const trackCounts =
    full || samples >= 60 ? ANIMATION_TRACK_COUNTS : [100, 10_000];
  const animation = [];
  for (const trackCount of trackCounts) {
    progress(
      options.onProgress,
      `  ${String(trackCount)} tracks x ${String(animationFrames)} frames`,
    );
    animation.push(measureAnimationScale(trackCount, animationFrames));
  }

  const report: BenchmarkReport = {
    schemaVersion: 1,
    benchmarkVersion: "1.0.0",
    date: new Date().toISOString(),
    hardware,
    options: {
      sizes,
      kinds,
      samples,
      saveLoadRuns,
      full,
    },
    scenes,
    animation,
    durationMs: performance.now() - started,
  };

  const gates = evaluateGates(report, tier);
  const summary = summarizeGates(tier, gates);
  progress(
    options.onProgress,
    `gates: ${String(summary.passed)} passed, ${String(summary.failed)} failed, ${String(summary.skipped)} skipped`,
  );
  return { report, gates, gatesPass: summary.allPass };
}

/** Empty summary for skipped export measurements. */
function emptySummary() {
  return {
    samples: 0,
    mean: 0,
    min: 0,
    max: 0,
    p50: 0,
    p90: 0,
    p95: 0,
    p99: 0,
  };
}
