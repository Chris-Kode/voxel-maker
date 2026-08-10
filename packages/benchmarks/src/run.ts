import {
  ANIMATION_TRACK_COUNTS,
  BENCHMARK_SCENE_KINDS,
  BENCHMARK_SIZES,
  createBenchmarkFixture,
  type BenchmarkSceneKind,
} from "./fixtures.js";
import {
  QUALIFICATION_MIN_ANIMATION_FRAMES,
  QUALIFICATION_MIN_SAMPLES,
  QUALIFICATION_MIN_SAVE_LOAD_RUNS,
  detectHardware,
  evaluateGates,
  resolveTier,
  summarizeGates,
  type GateResult,
} from "./gates.js";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  collectGarbage,
  measureAnimationScale,
  measureCommandLatency,
  measureExportGltf,
  measurePreviewLatency,
  measureRemeshAndPipeline,
  measureSaveLoad,
  memorySnapshot,
} from "./measure.js";
import { summarize } from "./stats.js";
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

/**
 * The effective fixture/sample matrix of one invocation (defaults
 * applied), validated against the resolved tier before any measurement
 * (issue #72).
 */
export interface QualificationMatrix {
  readonly sizes: readonly number[];
  readonly kinds: readonly BenchmarkSceneKind[];
  readonly samples: number;
  readonly saveLoadRuns: number;
  readonly animationFrames: number;
}

/**
 * Stable error code of the pre-flight qualification rejection (issue
 * #72): a named-tier invocation whose fixture/sample matrix cannot
 * produce protocol-compliant evidence for every mandatory gate. The
 * code is part of the CLI contract, so tests and scripts assert on the
 * exported constant instead of a literal string.
 */
export const INCOMPLETE_BENCHMARK_MATRIX = "INCOMPLETE_BENCHMARK_MATRIX";

/**
 * Required fixture matrix per tier (ADR-0008, issue #72). The named
 * reference tier qualifies the full 100k/500k/1M matrix in all three
 * surface classes; the named low tier qualifies the 100k interactive
 * target (the 1M fixture is a reference-tier viewability gate, not a
 * low-tier promise). The ci-smoke tier is explicitly non-qualifying:
 * it never constrains the matrix, so exploratory and CI smoke runs stay
 * possible with any fixture/sample selection.
 */
export interface TierMatrixRequirement {
  /** Sizes a named-tier qualification must measure. */
  readonly sizes: readonly number[];
  /** Kinds a named-tier qualification must measure. */
  readonly kinds: readonly BenchmarkSceneKind[];
  /** Minimum latency samples per p95 gate (ADR-0008: >= 100). */
  readonly minSamples: number;
  /** Minimum save/load repetitions (ADR-0008: five runs). */
  readonly minSaveLoadRuns: number;
  /** Minimum animation evaluation frames (ADR-0008: >= 100 samples). */
  readonly minAnimationFrames: number;
}

/** The ADR-0008 qualification matrix requirements per tier. */
export const TIER_MATRIX_REQUIREMENTS: Readonly<
  Record<TierName, TierMatrixRequirement>
> = Object.freeze({
  reference: Object.freeze({
    sizes: Object.freeze([100_000, 500_000, 1_000_000]),
    kinds: BENCHMARK_SCENE_KINDS,
    minSamples: QUALIFICATION_MIN_SAMPLES,
    minSaveLoadRuns: QUALIFICATION_MIN_SAVE_LOAD_RUNS,
    minAnimationFrames: QUALIFICATION_MIN_ANIMATION_FRAMES,
  }),
  low: Object.freeze({
    sizes: Object.freeze([100_000]),
    kinds: BENCHMARK_SCENE_KINDS,
    minSamples: QUALIFICATION_MIN_SAMPLES,
    minSaveLoadRuns: QUALIFICATION_MIN_SAVE_LOAD_RUNS,
    minAnimationFrames: QUALIFICATION_MIN_ANIMATION_FRAMES,
  }),
  "ci-smoke": Object.freeze({
    sizes: Object.freeze([]),
    kinds: Object.freeze([]),
    minSamples: 0,
    minSaveLoadRuns: 0,
    minAnimationFrames: 0,
  }),
});

/**
 * Problems that make a named-tier invocation non-qualifying (issue #72):
 * missing required sizes/kinds or below-protocol sample/run/frame
 * counts. The ci-smoke tier is explicitly non-qualifying and never
 * reports problems. An empty result means the matrix can qualify.
 */
export function qualificationProblems(
  matrix: QualificationMatrix,
  tier: TierName,
): readonly string[] {
  const requirement = TIER_MATRIX_REQUIREMENTS[tier];
  const problems: string[] = [];
  for (const size of requirement.sizes) {
    if (!matrix.sizes.includes(size)) {
      problems.push(`missing required size ${String(size)} (${tier} tier)`);
    }
  }
  for (const kind of requirement.kinds) {
    if (!matrix.kinds.includes(kind)) {
      problems.push(`missing required kind ${kind} (${tier} tier)`);
    }
  }
  if (matrix.samples < requirement.minSamples) {
    problems.push(
      `samples ${String(matrix.samples)} < ${String(requirement.minSamples)} (ADR-0008 requires at least ${String(requirement.minSamples)} p95 samples)`,
    );
  }
  if (matrix.saveLoadRuns < requirement.minSaveLoadRuns) {
    problems.push(
      `save-load-runs ${String(matrix.saveLoadRuns)} < ${String(requirement.minSaveLoadRuns)} (ADR-0008 requires five save/load runs)`,
    );
  }
  if (matrix.animationFrames < requirement.minAnimationFrames) {
    problems.push(
      `animation-frames ${String(matrix.animationFrames)} < ${String(requirement.minAnimationFrames)} (ADR-0008 requires at least ${String(requirement.minAnimationFrames)} frame samples)`,
    );
  }
  return problems;
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
  // The defaults are the ADR-0008 protocol minimums, so a default
  // invocation on a named tier is a compliant qualification run.
  const samples = options.samples ?? QUALIFICATION_MIN_SAMPLES;
  const saveLoadRuns = options.saveLoadRuns ?? QUALIFICATION_MIN_SAVE_LOAD_RUNS;
  const previewSamples = options.previewSamples ?? 10;
  const previewSize = options.previewSize ?? 256;
  const animationFrames =
    options.animationFrames ?? QUALIFICATION_MIN_ANIMATION_FRAMES;
  const full = options.full ?? false;
  const tier = resolveTier(
    options.tier ?? "auto",
    options.hardwareInput?.cpuModel ?? "unknown",
  );
  // Pre-flight qualification check (issue #72): a named-tier invocation
  // that cannot produce protocol-compliant evidence for every mandatory
  // gate fails with a structured error BEFORE any fixture allocation or
  // measurement, so a partial matrix can never be reported as a
  // successful qualification.
  const problems = qualificationProblems(
    { sizes, kinds, samples, saveLoadRuns, animationFrames },
    tier,
  );
  if (problems.length > 0) {
    throw new WorkspaceError({
      family: "validation",
      code: INCOMPLETE_BENCHMARK_MATRIX,
      message: `incomplete benchmark matrix for ${tier} qualification: ${problems.join("; ")}`,
      context: { tier, problems: [...problems] },
    });
  }
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

      progress(options.onProgress, `  measuring save/load`);
      const saveLoad = measureSaveLoad(fixture, saveLoadRuns);

      // The interactive memory gate measures the editor footprint: the
      // open fixture plus installed meshes. Export and preview allocate
      // large transient buffers, so their memory is reported separately
      // (`export.peakRssMiB`) and never distorts the ADR-0008
      // open/navigate memory gate.
      collectGarbage();
      const snapshots: MemorySnapshot[] = [memorySnapshot()];

      progress(options.onProgress, `  measuring command latency`);
      const command = measureCommandLatency(fixture, samples);

      progress(options.onProgress, `  measuring remesh + frame pipeline`);
      const remesh = await measureRemeshAndPipeline(fixture, samples);
      collectGarbage();
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
          summary: summarize([]),
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
  // pipeline). Fixtures are deterministically REBUILT here rather than
  // retained, so the phase-1 memory gate always reflects one open
  // scene, never a cumulative multi-fixture footprint.
  for (const kind of kinds) {
    for (const size of sizes) {
      progress(
        options.onProgress,
        `  building ${kind} ${String(size)} for phase 2`,
      );
      const fixture = createBenchmarkFixture(kind, size);
      progress(options.onProgress, `  exporting ${kind} ${String(size)}`);
      const current = scenes[kind][String(size)];
      if (current === undefined) continue;
      // Export intermediates scale with the scene's voxel count (the
      // export service builds per-voxel box geometry before the byte
      // limits apply), so large exports are measured only when the
      // named machine can hold them; otherwise they are skipped and
      // reported with zero samples. 100k is always exported (the
      // interactive reference size). The per-voxel estimate is
      // per-kind: compact boxes are cheaper than high-surface
      // checkerboards (measured ~8-20 KB/voxel).
      const exportBytesPerVoxel =
        kind === "compact" ? 12_000 : kind === "sparse" ? 16_000 : 24_000;
      const estimatedExportBytes = size * exportBytesPerVoxel;
      const canHoldExport =
        size === 100_000 ||
        (full && hardware.totalMemoryGiB * 1024 ** 3 >= estimatedExportBytes);
      const exportMeasurement = canHoldExport
        ? await measureExportGltf(fixture)
        : {
            summary: summarize([]),
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
  // The full track matrix runs only in full mode; smoke runs keep the
  // 100-track sanity row plus the ADR-0008 10k-track gate row.
  const trackCounts = full ? ANIMATION_TRACK_COUNTS : [100, 10_000];
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
