import type { BenchmarkReport, HardwareInfo, TierName } from "./report.js";

/**
 * Hardware tiers and gate thresholds (ADR-0008, ticket #45). The named
 * reference tier is a 2020 Apple M1 Mac mini (16 GiB); the named low
 * tier is a Windows 10 laptop with an Intel Core i5-8250U, 8 GiB, Intel
 * UHD 620. Any other machine is "ci-smoke": broad thresholds that detect
 * gross regressions without claiming reference-tier numbers. The tier is
 * resolved from the CPU model name when the hardware is named, and can
 * always be forced explicitly for a qualification run.
 */

/** Threshold units for readable gate reports. */
export type GateUnit = "ms" | "s" | "MiB" | "bytes" | "count" | "boolean";

/** One asserted gate: a measured value must not exceed `limit`. */
export interface GateDefinition {
  readonly id: string;
  readonly label: string;
  readonly unit: GateUnit;
  readonly limit: number;
  /** Extracts the measured value; undefined means "not applicable". */
  readonly measure: (report: BenchmarkReport) => number | undefined;
}

/** The outcome of one gate on one report. */
export interface GateResult {
  readonly id: string;
  readonly label: string;
  readonly tier: TierName;
  readonly unit: GateUnit;
  readonly limit: number;
  /** Measured value; undefined when the measurement was skipped. */
  readonly measured: number | undefined;
  /** True when measured <= limit (or the gate was skipped). */
  readonly pass: boolean;
  readonly skipped: boolean;
}

/** Summary of a gate evaluation. */
export interface GateSummary {
  readonly tier: TierName;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly allPass: boolean;
}

/** Reads a p95 summary value of one scene metric. */
function sceneP95(
  report: BenchmarkReport,
  kind: string,
  size: number,
  metric: "command" | "remesh" | "queueWait" | "flush" | "preview",
): number | undefined {
  const scenes = report.scenes[kind as keyof typeof report.scenes];
  const scene = scenes[String(size)];
  const summary = scene?.[metric];
  return summary === undefined ? undefined : summary.p95;
}

/** Mean over all measured kinds of one size of one metric percentile. */
function meanScenePercentile(
  report: BenchmarkReport,
  size: number,
  metric: "command" | "remesh" | "queueWait" | "flush",
  percentileName: "p95" | "p99",
): number | undefined {
  let total = 0;
  let count = 0;
  for (const kind of Object.keys(report.scenes)) {
    const scenes = report.scenes[kind as keyof typeof report.scenes];
    const scene = scenes[String(size)];
    const summary = scene?.[metric];
    const value = summary?.[percentileName];
    if (value !== undefined) {
      total += value;
      count += 1;
    }
  }
  return count === 0 ? undefined : total / count;
}

/** Mean p95 over all measured kinds of one size of one metric. */
function meanSceneP95(
  report: BenchmarkReport,
  size: number,
  metric: "command" | "remesh" | "queueWait" | "flush",
): number | undefined {
  return meanScenePercentile(report, size, metric, "p95");
}

/** Mean save or load p95 over measured kinds of one size. */
function meanSaveLoadP95(
  report: BenchmarkReport,
  size: number,
  metric: "save" | "load",
): number | undefined {
  let total = 0;
  let count = 0;
  for (const kind of Object.keys(report.scenes)) {
    const scene =
      report.scenes[kind as keyof typeof report.scenes][String(size)];
    if (scene !== undefined) {
      total += scene[metric].summary.p95;
      count += 1;
    }
  }
  return count === 0 ? undefined : total / count;
}

/** Peak RSS over every measured scene (MiB). */
function peakRssMiB(report: BenchmarkReport): number | undefined {
  let peak: number | undefined;
  for (const kind of Object.keys(report.scenes)) {
    const scenes = report.scenes[kind as keyof typeof report.scenes];
    for (const size of Object.keys(scenes)) {
      const scene = scenes[size];
      if (scene === undefined) continue;
      const rss = scene.memory.rssMiB;
      if (peak === undefined || rss > peak) peak = rss;
    }
  }
  return peak;
}

/** Animation frame p95 at one track count. */
function animationP95(
  report: BenchmarkReport,
  trackCount: number,
): number | undefined {
  const row = report.animation.find((entry) => entry.trackCount === trackCount);
  return row === undefined ? undefined : row.frameMs.p95;
}

/** Revision-stability gate value: 0 when state stayed unchanged, else 1. */
function revisionStability(report: BenchmarkReport): number | undefined {
  const row = report.animation.find((entry) => entry.trackCount === 10_000);
  if (row === undefined) return undefined;
  const stable =
    row.revisionBefore === row.revisionAfter &&
    row.historyBefore === row.historyAfter &&
    row.semanticHashBefore === row.semanticHashAfter;
  return stable ? 0 : 1;
}

/** The ADR-0008 reference-tier gates (Apple M1/16 GiB). */
const REFERENCE_GATES: readonly GateDefinition[] = Object.freeze([
  // One-voxel Transaction commit, p95 under 8 ms on the 100k fixture.
  ...(["compact", "sparse", "checkerboard"] as const).map(
    (kind) =>
      Object.freeze({
        id: `commit.p95.100k.${kind}`,
        label: `one-voxel commit p95 (100k ${kind})`,
        unit: "ms",
        limit: 8,
        measure: (report: BenchmarkReport) =>
          sceneP95(report, kind, 100_000, "command"),
      }) as GateDefinition,
  ),
  // Localized face-cull remesh p95 under 30 ms in a worker.
  ...(["compact", "sparse", "checkerboard"] as const).map(
    (kind) =>
      Object.freeze({
        id: `remesh.p95.100k.${kind}`,
        label: `localized remesh p95 (100k ${kind})`,
        unit: "ms",
        limit: 30,
        measure: (report: BenchmarkReport) =>
          sceneP95(report, kind, 100_000, "remesh"),
      }) as GateDefinition,
  ),
  // Main-thread per-frame pipeline cost stays inside the 16.7 ms frame
  // budget (the headless proxy of the 60 FPS viewport gate).
  ...(["compact", "sparse", "checkerboard"] as const).map(
    (kind) =>
      Object.freeze({
        id: `flush.p95.100k.${kind}`,
        label: `per-frame pipeline p95 (100k ${kind})`,
        unit: "ms",
        limit: 16.7,
        measure: (report: BenchmarkReport) =>
          sceneP95(report, kind, 100_000, "flush"),
      }) as GateDefinition,
  ),
  // Input-to-preview composite p95: the headless viewport pipeline
  // (commit + remesh + flush). The GPU viewport render is qualified on
  // the named desktop tiers; the deterministic software preview render
  // is reported separately (it is the preview-export pipeline, not the
  // viewport path).
  ...(["compact", "sparse", "checkerboard"] as const).map(
    (kind) =>
      Object.freeze({
        id: `inputToPreview.p95.100k.${kind}`,
        label: `input-to-preview p95 (100k ${kind})`,
        unit: "ms",
        limit: 50,
        measure: (report: BenchmarkReport) => {
          const scene = report.scenes[kind]["100000"];
          return scene === undefined ? undefined : scene.inputToPreview95Ms;
        },
      }) as GateDefinition,
  ),
  // Canonical 100k save and load within 2 seconds each.
  Object.freeze({
    id: "save.p95.100k",
    label: "canonical 100k save p95",
    unit: "s",
    limit: 2,
    measure: (report: BenchmarkReport) => {
      const ms = meanSaveLoadP95(report, 100_000, "save");
      return ms === undefined ? undefined : ms / 1000;
    },
  }) as GateDefinition,
  Object.freeze({
    id: "load.p95.100k",
    label: "canonical 100k load p95",
    unit: "s",
    limit: 2,
    measure: (report: BenchmarkReport) => {
      const ms = meanSaveLoadP95(report, 100_000, "load");
      return ms === undefined ? undefined : ms / 1000;
    },
  }) as GateDefinition,
  // Editing produces no repeated main-thread task longer than 50 ms on
  // the 100k interactive target (ADR-0008).
  ...(["compact", "sparse", "checkerboard"] as const).map(
    (kind) =>
      Object.freeze({
        id: `flush.p99.100k.${kind}`,
        label: `no repeated main-thread task > 50 ms (100k ${kind})`,
        unit: "ms",
        limit: 50,
        measure: (report: BenchmarkReport) => {
          const scene = report.scenes[kind]["100000"];
          return scene === undefined ? undefined : scene.flush.p99;
        },
      }) as GateDefinition,
  ),
  // 500k fixture stays inside a 30 FPS frame budget.
  Object.freeze({
    id: "flush.p95.500k",
    label: "per-frame pipeline p95 (500k mean)",
    unit: "ms",
    limit: 33.3,
    measure: (report: BenchmarkReport) =>
      meanSceneP95(report, 500_000, "flush"),
  }) as GateDefinition,
  Object.freeze({
    id: "flush.p99.500k",
    label: "no repeated main-thread task > 50 ms (500k mean)",
    unit: "ms",
    limit: 50,
    measure: (report: BenchmarkReport) =>
      meanScenePercentile(report, 500_000, "flush", "p99"),
  }) as GateDefinition,
  // 1M fixture: opens within 10 seconds, navigable at 20 FPS, memory < 2 GiB.
  Object.freeze({
    id: "save.p95.1m",
    label: "canonical 1M save p95",
    unit: "s",
    limit: 10,
    measure: (report: BenchmarkReport) => {
      const ms = meanSaveLoadP95(report, 1_000_000, "save");
      return ms === undefined ? undefined : ms / 1000;
    },
  }) as GateDefinition,
  Object.freeze({
    id: "load.p95.1m",
    label: "canonical 1M load p95",
    unit: "s",
    limit: 10,
    measure: (report: BenchmarkReport) => {
      const ms = meanSaveLoadP95(report, 1_000_000, "load");
      return ms === undefined ? undefined : ms / 1000;
    },
  }) as GateDefinition,
  Object.freeze({
    id: "flush.p95.1m",
    label: "per-frame pipeline p95 (1M mean)",
    unit: "ms",
    limit: 50,
    measure: (report: BenchmarkReport) =>
      meanSceneP95(report, 1_000_000, "flush"),
  }) as GateDefinition,
  Object.freeze({
    id: "memory.peak.1m",
    label: "1M process memory peak",
    unit: "MiB",
    limit: 2048,
    measure: peakRssMiB,
  }) as GateDefinition,
  // 10,000 active tracks within the 16.7 ms p95 frame budget.
  Object.freeze({
    id: "animation.frame.p95.10k",
    label: "10k-track animation frame p95",
    unit: "ms",
    limit: 16.7,
    measure: (report: BenchmarkReport) => animationP95(report, 10_000),
  }) as GateDefinition,
  Object.freeze({
    id: "animation.frame.p99.10k",
    label: "10k-track animation: no repeated frame stall > 50 ms",
    unit: "ms",
    limit: 50,
    measure: (report: BenchmarkReport) => {
      const row = report.animation.find((entry) => entry.trackCount === 10_000);
      return row === undefined ? undefined : row.frameMs.p99;
    },
  }) as GateDefinition,
  Object.freeze({
    id: "animation.noMutation.10k",
    label: "10k-track playback never mutates persistent state",
    unit: "boolean",
    limit: 0,
    measure: revisionStability,
  }) as GateDefinition,
]);

/** The ADR-0008 low-tier gates (i5-8250U / UHD 620 / 8 GiB). */
const LOW_GATES: readonly GateDefinition[] = Object.freeze([
  Object.freeze({
    id: "flush.p95.100k.low",
    label: "per-frame pipeline p95 (100k mean, 30 FPS)",
    unit: "ms",
    limit: 33.3,
    measure: (report: BenchmarkReport) =>
      meanSceneP95(report, 100_000, "flush"),
  }) as GateDefinition,
  Object.freeze({
    id: "inputToPreview.p95.100k.low",
    label: "input-to-preview p95 (100k mean)",
    unit: "ms",
    limit: 100,
    measure: (report: BenchmarkReport) => {
      let total = 0;
      let count = 0;
      for (const kind of Object.keys(report.scenes)) {
        const value =
          report.scenes[kind as keyof typeof report.scenes]["100000"]
            ?.inputToPreview95Ms;
        if (value !== undefined) {
          total += value;
          count += 1;
        }
      }
      return count === 0 ? undefined : total / count;
    },
  }) as GateDefinition,
  Object.freeze({
    id: "save.p95.100k.low",
    label: "canonical 100k save p95",
    unit: "s",
    limit: 5,
    measure: (report: BenchmarkReport) => {
      const ms = meanSaveLoadP95(report, 100_000, "save");
      return ms === undefined ? undefined : ms / 1000;
    },
  }) as GateDefinition,
  Object.freeze({
    id: "load.p95.100k.low",
    label: "canonical 100k load p95",
    unit: "s",
    limit: 5,
    measure: (report: BenchmarkReport) => {
      const ms = meanSaveLoadP95(report, 100_000, "load");
      return ms === undefined ? undefined : ms / 1000;
    },
  }) as GateDefinition,
  Object.freeze({
    id: "memory.peak.low",
    label: "process memory peak",
    unit: "MiB",
    limit: 1536,
    measure: peakRssMiB,
  }) as GateDefinition,
]);

/** Broad regression-detection thresholds for CI runners (no named tier). */
const CI_SMOKE_GATES: readonly GateDefinition[] = Object.freeze([
  Object.freeze({
    id: "commit.p95.100k.smoke",
    label: "one-voxel commit p95 (100k mean)",
    unit: "ms",
    limit: 200,
    measure: (report: BenchmarkReport) =>
      meanSceneP95(report, 100_000, "command"),
  }) as GateDefinition,
  Object.freeze({
    id: "remesh.p95.100k.smoke",
    label: "localized remesh p95 (100k mean)",
    unit: "ms",
    limit: 1000,
    measure: (report: BenchmarkReport) =>
      meanSceneP95(report, 100_000, "remesh"),
  }) as GateDefinition,
  Object.freeze({
    id: "flush.p95.100k.smoke",
    label: "per-frame pipeline p95 (100k mean)",
    unit: "ms",
    limit: 200,
    measure: (report: BenchmarkReport) =>
      meanSceneP95(report, 100_000, "flush"),
  }) as GateDefinition,
  Object.freeze({
    id: "save.p95.100k.smoke",
    label: "canonical 100k save p95",
    unit: "s",
    limit: 60,
    measure: (report: BenchmarkReport) => {
      const ms = meanSaveLoadP95(report, 100_000, "save");
      return ms === undefined ? undefined : ms / 1000;
    },
  }) as GateDefinition,
  Object.freeze({
    id: "load.p95.100k.smoke",
    label: "canonical 100k load p95",
    unit: "s",
    limit: 60,
    measure: (report: BenchmarkReport) => {
      const ms = meanSaveLoadP95(report, 100_000, "load");
      return ms === undefined ? undefined : ms / 1000;
    },
  }) as GateDefinition,
  Object.freeze({
    id: "export.p95.100k.smoke",
    label: "glTF export p95 (100k mean)",
    unit: "s",
    limit: 60,
    measure: (report: BenchmarkReport) => {
      let total = 0;
      let count = 0;
      for (const kind of Object.keys(report.scenes)) {
        const exportMs =
          report.scenes[kind as keyof typeof report.scenes]["100000"]?.export
            .summary.p95;
        if (exportMs !== undefined) {
          total += exportMs;
          count += 1;
        }
      }
      return count === 0 ? undefined : total / count / 1000;
    },
  }) as GateDefinition,
  Object.freeze({
    id: "memory.peak.smoke",
    label: "process memory peak",
    unit: "MiB",
    limit: 6144,
    measure: peakRssMiB,
  }) as GateDefinition,
  Object.freeze({
    id: "meshing.failures.smoke",
    label: "zero failed meshing jobs across scenes",
    unit: "count",
    limit: 0,
    measure: (report: BenchmarkReport) => {
      let failures = 0;
      for (const kind of Object.keys(report.scenes)) {
        const scenes = report.scenes[kind as keyof typeof report.scenes];
        for (const size of Object.keys(scenes)) {
          failures += scenes[size]?.meshing.failed ?? 0;
        }
      }
      return failures;
    },
  }) as GateDefinition,
  Object.freeze({
    id: "animation.frame.p95.10k.smoke",
    label: "10k-track animation frame p95",
    unit: "ms",
    limit: 200,
    measure: (report: BenchmarkReport) => animationP95(report, 10_000),
  }) as GateDefinition,
  Object.freeze({
    id: "animation.noMutation.smoke",
    label: "playback never mutates persistent state",
    unit: "boolean",
    limit: 0,
    measure: revisionStability,
  }) as GateDefinition,
]);

/** Gate sets per tier (ADR-0008 plus CI smoke). */
const GATES_BY_TIER: Readonly<Record<TierName, readonly GateDefinition[]>> =
  Object.freeze({
    reference: REFERENCE_GATES,
    low: LOW_GATES,
    "ci-smoke": CI_SMOKE_GATES,
  });

/**
 * Detects the running hardware: CPU model string (the named-hardware
 * identity), platform, arch, core count, total memory, and Node version.
 */
/**
 * The OS facts the app composition root injects (the package stays
 * import-clean for the browser-bundle entrypoint check; node:os lives
 * in the CLI app).
 */
export interface HardwareInput {
  readonly cpuModel?: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly cores?: number;
  readonly totalMemoryGiB?: number;
  readonly nodeVersion?: string;
}

/**
 * Records the running hardware: CPU model string (the named-hardware
 * identity), platform, arch, core count, total memory, and Node version.
 * Platform/arch/version fall back to Node globals; the CPU model and
 * total memory come from the app's node:os introspection.
 */
export function detectHardware(
  tier: TierName,
  input: HardwareInput = {},
): HardwareInfo {
  return {
    tier,
    cpuModel: input.cpuModel ?? "unknown",
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    cores: input.cores ?? 1,
    totalMemoryGiB: input.totalMemoryGiB ?? 0,
    nodeVersion: input.nodeVersion ?? process.version,
  };
}

/**
 * Resolves the benchmark tier. An explicit tier always wins; otherwise
 * the CPU model names ADR-0008's tiers (Apple M1 = reference,
 * i5-8250U = low); any other machine is the CI smoke tier.
 */
export function resolveTier(
  explicit: TierName | "auto" | undefined,
  cpuModel: string,
): TierName {
  if (explicit !== undefined && explicit !== "auto") return explicit;
  const model = cpuModel.toLowerCase();
  if (model.includes("apple m1")) return "reference";
  if (model.includes("i5-8250u")) return "low";
  return "ci-smoke";
}

/** Evaluates every gate of one tier against one report. */
export function evaluateGates(
  report: BenchmarkReport,
  tier: TierName,
): readonly GateResult[] {
  const definitions = GATES_BY_TIER[tier];
  return definitions.map((gate) => {
    const measured = gate.measure(report);
    const skipped = measured === undefined;
    return {
      id: gate.id,
      label: gate.label,
      tier,
      unit: gate.unit,
      limit: gate.limit,
      measured,
      pass: skipped || measured <= gate.limit,
      skipped,
    };
  });
}

/** Summarizes one gate evaluation. */
export function summarizeGates(
  tier: TierName,
  results: readonly GateResult[],
): GateSummary {
  const passed = results.filter((result) => result.pass).length;
  const failed = results.filter(
    (result) => !result.pass && !result.skipped,
  ).length;
  const skipped = results.filter((result) => result.skipped).length;
  return {
    tier,
    total: results.length,
    passed,
    failed,
    skipped,
    allPass: failed === 0,
  };
}
