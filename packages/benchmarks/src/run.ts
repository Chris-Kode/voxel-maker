import {
  ANIMATION_TRACK_COUNTS,
  BENCHMARK_SCENE_KINDS,
  BENCHMARK_SIZES,
  createBenchmarkFixture,
  type BenchmarkFixture,
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
  /** OS facts from the app's node:os introspection (named hardware). */
  readonly hardwareInput?: import("./gates.js").HardwareInput;
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
  const tier = resolveTier(
    options.tier ?? "auto",
    options.hardwareInput?.cpuModel ?? "unknown",
  );
  const hardware: HardwareInfo = detectHardware(tier, options.hardwareInput);

  progress(options.onProgress, `tier resolved: ${tier} (${hardware.cpuModel})`);

  const scenes: Record<
    BenchmarkSceneKind,
    Record<string, SceneMeasurements>
  > = {
    compact: {},
    sparse: {},
    checkerboard: {},
  };
  // Phase 1 — interactive footprint: every scene is built and measured
  // (save/load, command latency, remesh + frame pipeline) BEFORE any
  // transient-heavy operation runs, so export/preview garbage from one
  // scene can never pollute another scene's memory gate.
  const fixtures: BenchmarkFixture[] = [];
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
      fixtures.push(fixture);

      progress(options.onProgress, `  measuring save/load`);
      const saveLoad = measureSaveLoad(fixture, saveLoadRuns);

      // The interactive memory gate measures the editor footprint: the
      // open fixture plus installed meshes. Export and preview allocate
      // large transient buffers, so their memory is reported separately
      // (`export.peakRssMiB`) and never distorts the ADR-0008
      // open/navigate memory gate.
      const snapshots: MemorySnapshot[] = [memorySnapshot()];

      progress(options.onProgress, `  measuring command latency`);
      const command = measureCommandLatency(fixture, samples);

      progress(options.onProgress, `  measuring remesh + frame pipeline`);
      const remesh = await measureRemeshAndPipeline(fixture, samples);
      snapshots.push(memorySnapshot());

      // Composite headless input-to-preview proxy: commit + remesh +
      // flush + (preview, added in phase 2). Preview is rendered in
      // phase 2; the composite is finalized there.
      const inputToPreview95Ms =
        command.p95 + remesh.remesh.p95 + remesh.flush.p95;

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
        export: {
          summary: emptySummary(),
          bytes: 0,
          peakRssMiB: 0,
          blocked: undefined,
        },
        inputToPreview95Ms,
        memory: peakMemory(snapshots),
      } satisfies SceneMeasurements;
    }
  }

  // Phase 2 — transient operations: glTF export and software preview
  // renders, which allocate large short-lived buffers. Export peak RSS
  // is sampled during the export itself; preview latency is measured on
  // the 100k interactive target only (larger scenes gate on the frame
  // pipeline).
  for (const kind of kinds) {
    for (const size of sizes) {
      const fixture = fixtures.find(
        (candidate) =>
          candidate.kind === kind && candidate.targetOccupied === size,
      );
      if (fixture === undefined) continue;
      progress(options.onProgress, `  exporting ${kind} ${String(size)}`);
      const current = scenes[kind][String(size)];
      if (current === undefined) continue;
      // Export intermediates scale with the scene's voxel count (the
      // export service builds per-voxel box geometry before the byte
      // limits apply), so large exports are measured only when the
      // named machine can hold them; otherwise they are skipped and
      // reported with zero samples. 100k is always exported (the
      // interactive reference size).
      const estimatedExportBytes = size * 24_000;
      const canHoldExport =
        size === 100_000 ||
        (full && hardware.totalMemoryGiB * 1024 ** 3 >= estimatedExportBytes);
      const exportMeasurement = canHoldExport
        ? await measureExportGltf(fixture)
        : {
            summary: emptySummary(),
            bytes: 0,
            peakRssMiB: 0,
            blocked: undefined,
          };
      scenes[kind][String(size)] = { ...current, export: exportMeasurement };

      if (size === 100_000) {
        progress(options.onProgress, `  rendering preview ${kind}`);
        const preview = measurePreviewLatency(
          fixture,
          previewSamples,
          previewSize,
        );
        const withExport = scenes[kind][String(size)];
        if (withExport === undefined) continue;
        scenes[kind][String(size)] = { ...withExport, preview };
      }
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
