import type {
  BenchmarkReport,
  FlattenedValues,
  HardwareInfo,
} from "./report.js";

/**
 * Retained trend evidence (ticket #45 AC): every full benchmark run
 * flattens its gate-relevant measurements into one trend row keyed by
 * `<kind>.<size>.<metric>`, appended to a retained JSON history. The
 * next scheduled run compares against the latest row on the same named
 * hardware and fails when a value regresses beyond tolerance, so
 * regressions are detected against retained evidence rather than only
 * against absolute thresholds.
 */

/** The latest trend history file format. */
export interface BenchmarkTrendHistory {
  readonly schemaVersion: 1;
  /** Rows in chronological order; the last row is the latest baseline. */
  readonly rows: readonly TrendRow[];
}

/** One appended benchmark row. */
export interface TrendRow {
  readonly date: string;
  readonly hardware: HardwareInfo;
  readonly values: FlattenedValues;
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

/** One compared value of the latest baseline. */
export interface TrendComparison {
  readonly key: string;
  readonly previous: number;
  readonly current: number;
  /** Relative change of current vs previous (positive = slower/worse). */
  readonly deltaPct: number;
  readonly regressed: boolean;
}

/** Every measurement value a trend row retains, by stable key. */
export const TREND_METRIC_KEYS = Object.freeze([
  "command.p95",
  "remesh.p95",
  "queueWait.p95",
  "flush.p95",
  "meshSettleMs",
  "save.p95",
  "load.p95",
  "export.p95",
  "memory.rssMiB",
] as const);

/** Flattens one report into trend values (same keys on every run). */
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
  if (previous === 0) return current > tolerance.absoluteFloorMs * 5;
  const delta = current - previous;
  if (delta <= tolerance.absoluteFloorMs) return false;
  return delta / previous > tolerance.relative;
}

/** Compares a report against the latest row of a trend history. */
export function compareWithTrends(
  report: BenchmarkReport,
  history: BenchmarkTrendHistory,
  tolerance: TrendTolerance = DEFAULT_TREND_TOLERANCE,
): readonly TrendComparison[] {
  const latest = history.rows[history.rows.length - 1];
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

/** Appends one report row to a trend history (immutable copy). */
export function appendTrendRow(
  history: BenchmarkTrendHistory,
  report: BenchmarkReport,
): BenchmarkTrendHistory {
  const row: TrendRow = {
    date: report.date,
    hardware: report.hardware,
    values: flattenReport(report),
  };
  return {
    schemaVersion: 1,
    rows: [...history.rows, row],
  };
}

/** The empty trend history. */
export function emptyTrendHistory(): BenchmarkTrendHistory {
  return { schemaVersion: 1, rows: [] };
}
