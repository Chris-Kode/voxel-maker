import type {
  BenchmarkReport,
  FlattenedValues,
  HardwareInfo,
} from "./report.js";

/**
 * Retained trend evidence (ticket #45 AC): every full benchmark run
 * flattens its gate-relevant measurements into one trend row keyed by
 * `<kind>.<size>.<metric>`, appended to a retained JSON history. The
 * next scheduled run compares against the latest PASSING row on the
 * same named hardware and fails when a value regresses beyond
 * tolerance, so regressions are detected against retained evidence
 * rather than only against absolute thresholds.
 *
 * Baseline promotion (issue #73): a row records whether the run that
 * produced it passed (`passed: true`). Failed rows stay in the history
 * as evidence but never become a comparison baseline, so one regressed
 * run cannot promote itself to the next accepted baseline; the baseline
 * advances only when a run passes.
 */

/** The latest trend history file format. */
export interface BenchmarkTrendHistory {
  readonly schemaVersion: 2;
  /**
   * Rows in chronological order; the newest PASSING row on the same
   * named hardware is the comparison baseline (issue #73). Failed rows
   * are retained evidence only.
   */
  readonly rows: readonly TrendRow[];
}

/** One appended benchmark row. */
export interface TrendRow {
  readonly date: string;
  readonly hardware: HardwareInfo;
  readonly values: FlattenedValues;
  /**
   * True when the run that produced this row passed its gates and trend
   * comparisons. Only passed rows are eligible as comparison baselines;
   * a failed row is retained as evidence but never promoted (issue #73).
   */
  readonly passed: boolean;
}

/** Tolerance policy for trend regression detection. */
export interface TrendTolerance {
  /** Relative regression tolerated (fraction; 0.2 = +20%). */
  readonly relative: number;
  /** Absolute floor in ms below which only relative regression matters. */
  readonly absoluteFloorMs: number;
}

/** Default tolerance: regress only when the value grows >20% and >2 ms. */
export const DEFAULT_TREND_TOLERANCE: TrendTolerance = Object.freeze({
  relative: 0.2,
  absoluteFloorMs: 2,
});

/** One compared value of the newest same-named-hardware baseline. */
export interface TrendComparison {
  readonly key: string;
  readonly previous: number;
  readonly current: number;
  /** Relative change of current vs previous (positive = slower/worse). */
  readonly deltaPct: number;
  readonly regressed: boolean;
}

/**
 * Flattens one report into trend values (same stable keys on every run:
 * `<kind>.<size>.<metric>` plus `animation.<tracks>.frameMs.p95`).
 */
export function flattenReport(report: BenchmarkReport): FlattenedValues {
  const values: Record<string, number> = {};
  for (const kind of Object.keys(report.scenes)) {
    const scenes = report.scenes[kind as keyof typeof report.scenes];
    for (const size of Object.keys(scenes)) {
      const scene = scenes[size];
      if (scene === undefined) continue;
      const prefix = `${kind}.${size}.`;
      values[`${prefix}command.p95`] = scene.command.p95;
      values[`${prefix}remesh.p95`] = scene.remesh.p95;
      values[`${prefix}queueWait.p95`] = scene.queueWait.p95;
      values[`${prefix}flush.p95`] = scene.flush.p95;
      values[`${prefix}meshSettleMs`] = scene.meshSettleMs;
      values[`${prefix}save.p95`] = scene.save.summary.p95;
      values[`${prefix}load.p95`] = scene.load.summary.p95;
      values[`${prefix}export.p95`] = scene.export.summary.p95;
      values[`${prefix}memory.rssMiB`] = scene.memory.rssMiB;
    }
  }
  for (const row of report.animation) {
    values[`animation.${String(row.trackCount)}.frameMs.p95`] = row.frameMs.p95;
  }
  return values;
}

/** True when the current value regressed beyond tolerance. */
export function isTrendRegression(
  previous: number,
  current: number,
  tolerance: TrendTolerance = DEFAULT_TREND_TOLERANCE,
): boolean {
  // A zero baseline (e.g. a previously skipped metric) can never prove
  // a ratio; tolerate up to five absolute-floor units of growth so a
  // first measured value is not instantly a regression.
  if (previous === 0) return current > tolerance.absoluteFloorMs * 5;
  const delta = current - previous;
  if (delta <= tolerance.absoluteFloorMs) return false;
  return delta / previous > tolerance.relative;
}

/**
 * True when two runs share the same named-hardware identity (CPU model,
 * platform, arch, cores, memory, Node version — the fields a trend row
 * records). The tier alone is NOT the identity: on a shared CI pool the
 * same tier (e.g. ci-smoke) is served by different CPU generations, and
 * comparing across them would report hardware noise as regressions.
 */
export function sameNamedHardware(a: HardwareInfo, b: HardwareInfo): boolean {
  return (
    a.cpuModel === b.cpuModel &&
    a.platform === b.platform &&
    a.arch === b.arch &&
    a.cores === b.cores &&
    a.totalMemoryGiB === b.totalMemoryGiB &&
    a.nodeVersion === b.nodeVersion
  );
}

/**
 * Finds the newest row whose named-hardware identity matches the given
 * hardware, searching backward through the chronological history (issue
 * #64). Rows from other machines (e.g. a rotated CI runner CPU) never
 * become a baseline, so alternating hardware cannot bypass retained
 * trend comparisons; a fresh baseline starts only when no matching row
 * exists. Pass status is ignored: this finds the latest evidence row,
 * failed or not.
 */
export function latestSameHardwareRow(
  history: BenchmarkTrendHistory,
  hardware: HardwareInfo,
): TrendRow | undefined {
  return latestSameHardwareRowWhere(history, hardware, () => true);
}

/**
 * Finds the newest PASSING row whose named-hardware identity matches
 * the given hardware (issue #73). Failed rows are retained evidence
 * but never baselines: a regressed run must not promote itself to the
 * next accepted baseline, so repeated regressed runs keep failing until
 * a passing run advances the baseline.
 */
export function latestPassingSameHardwareRow(
  history: BenchmarkTrendHistory,
  hardware: HardwareInfo,
): TrendRow | undefined {
  return latestSameHardwareRowWhere(history, hardware, (row) => row.passed);
}

/** Backward search over the chronological history with a row predicate. */
function latestSameHardwareRowWhere(
  history: BenchmarkTrendHistory,
  hardware: HardwareInfo,
  predicate: (row: TrendRow) => boolean,
): TrendRow | undefined {
  for (let i = history.rows.length - 1; i >= 0; i -= 1) {
    const row = history.rows[i];
    if (
      row !== undefined &&
      predicate(row) &&
      sameNamedHardware(hardware, row.hardware)
    ) {
      return row;
    }
  }
  return undefined;
}

/**
 * Compares a report against the newest PASSING row on the same named
 * hardware (issue #73). A different machine class (CPU model, platform,
 * cores, ...) gets a fresh baseline, never a false regression against
 * unrelated hardware; the tier is not enough because ci-smoke covers
 * every runner CPU. When rows alternate between machines, the newest
 * matching passing row is still found, so a severe regression is never
 * skipped just because a newer row came from another machine. Failed
 * rows never become the baseline, so a regressed run cannot promote
 * itself: the identical regression keeps failing until a passing run
 * advances the baseline.
 */
export function compareWithTrends(
  report: BenchmarkReport,
  history: BenchmarkTrendHistory,
  tolerance: TrendTolerance = DEFAULT_TREND_TOLERANCE,
): readonly TrendComparison[] {
  const latest = latestPassingSameHardwareRow(history, report.hardware);
  if (latest === undefined) return [];
  const current = flattenReport(report);
  const comparisons: TrendComparison[] = [];
  for (const key of Object.keys(latest.values)) {
    const previous = latest.values[key];
    const currentValue = current[key];
    if (previous === undefined || currentValue === undefined) continue;
    comparisons.push({
      key,
      previous,
      current: currentValue,
      deltaPct: previous === 0 ? 0 : (currentValue - previous) / previous,
      regressed: isTrendRegression(previous, currentValue, tolerance),
    });
  }
  return comparisons;
}

/**
 * Appends one report row to a trend history (immutable copy). `passed`
 * records whether the run that produced the row passed its gates and
 * trend comparisons (issue #73): failed rows are retained as evidence
 * but never become a comparison baseline.
 */
export function appendTrendRow(
  history: BenchmarkTrendHistory,
  report: BenchmarkReport,
  passed: boolean,
): BenchmarkTrendHistory {
  const row: TrendRow = {
    date: report.date,
    hardware: report.hardware,
    values: flattenReport(report),
    passed,
  };
  return {
    schemaVersion: 2,
    rows: [...history.rows, row],
  };
}

/** The empty trend history. */
export function emptyTrendHistory(): BenchmarkTrendHistory {
  return { schemaVersion: 2, rows: [] };
}

/**
 * Parses and validates a trend history file payload, migrating the v1
 * format (rows without a pass marker) to v2. v1 rows carry no pass
 * marker and may include failed runs that the old format wrongly
 * promoted to baselines (issue #73), so they migrate as non-baselines
 * (`passed: false`): the next passing run on each named hardware
 * re-establishes the baseline. Unsupported or malformed payloads throw;
 * the payload is untrusted file input, never a programmer error.
 */
export function parseTrendHistory(parsed: unknown): BenchmarkTrendHistory {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("trend history must be a JSON object");
  }
  const candidate = parsed as {
    readonly schemaVersion?: unknown;
    readonly rows?: unknown;
  };
  if (candidate.schemaVersion === 1) {
    const rows = candidate.rows;
    if (!Array.isArray(rows)) {
      throw new Error("trend history rows must be an array");
    }
    return {
      schemaVersion: 2,
      rows: rows.map((row) => ({
        ...validateTrendRow(row, false),
        passed: false,
      })),
    };
  }
  if (candidate.schemaVersion !== 2) {
    throw new Error(
      `unsupported trend schema version ${String(candidate.schemaVersion)}; expected 1 or 2`,
    );
  }
  if (!Array.isArray(candidate.rows)) {
    throw new Error("trend history rows must be an array");
  }
  return {
    schemaVersion: 2,
    rows: candidate.rows.map((row) => validateTrendRow(row, true)),
  };
}

/**
 * Bounds one untrusted trend row before it is used: every field the
 * comparison path reads must be present with the right primitive type,
 * so a malformed file fails with a stable error instead of a raw
 * TypeError mid-comparison.
 */
function validateTrendRow(row: unknown, requirePassed: boolean): TrendRow {
  if (typeof row !== "object" || row === null) {
    throw new Error("trend history row must be a JSON object");
  }
  const candidate = row as {
    readonly date?: unknown;
    readonly hardware?: unknown;
    readonly values?: unknown;
    readonly passed?: unknown;
  };
  if (typeof candidate.date !== "string") {
    throw new Error("trend history row must declare a string date");
  }
  if (candidate.passed !== undefined && typeof candidate.passed !== "boolean") {
    throw new Error("trend history row must declare a boolean passed marker");
  }
  if (requirePassed && candidate.passed === undefined) {
    throw new Error("trend history row must declare a boolean passed marker");
  }
  const hardware = candidate.hardware;
  if (typeof hardware !== "object" || hardware === null) {
    throw new Error("trend history row must declare a hardware object");
  }
  const hardwareInfo = hardware as {
    readonly tier?: unknown;
    readonly cpuModel?: unknown;
    readonly platform?: unknown;
    readonly arch?: unknown;
    readonly cores?: unknown;
    readonly totalMemoryGiB?: unknown;
    readonly nodeVersion?: unknown;
  };
  if (
    typeof hardwareInfo.tier !== "string" ||
    typeof hardwareInfo.cpuModel !== "string" ||
    typeof hardwareInfo.platform !== "string" ||
    typeof hardwareInfo.arch !== "string" ||
    typeof hardwareInfo.cores !== "number" ||
    typeof hardwareInfo.totalMemoryGiB !== "number" ||
    typeof hardwareInfo.nodeVersion !== "string"
  ) {
    throw new Error("trend history row must declare complete named hardware");
  }
  const values = candidate.values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Error("trend history row must declare a values object");
  }
  for (const value of Object.values(values)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("trend history values must be finite numbers");
    }
  }
  return {
    date: candidate.date,
    hardware: hardwareInfo as HardwareInfo,
    values: values as FlattenedValues,
    passed: candidate.passed ?? false,
  };
}
