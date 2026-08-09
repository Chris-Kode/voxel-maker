/**
 * Statistical summaries of benchmark samples (plan S6.14, ticket #45):
 * percentile summaries (p50/p90/p95/p99) with deterministic definitions,
 * so gate thresholds and trend comparisons always read the same number.
 * p95 is the ADR-0008 gate percentile for frame, latency, and budget
 * measurements; at least 100 samples are required where a p95 gate is
 * asserted (ADR-0008 measurement method).
 */

/** One summarized sample distribution. */
export interface SampleSummary {
  readonly samples: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
}

/**
 * Nearest-rank percentile of sorted ascending samples (the same
 * definition used by ADR-0008 gate reporting). Returns 0 for an empty
 * sample set. `p` is a fraction in [0, 1]; 0.95 is the gate percentile.
 */
export function percentile(
  samples: readonly number[],
  p: number,
): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(0, Math.min(1, p)) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower] as number;
  const fraction = rank - lower;
  return (
    (sorted[lower] as number) * (1 - fraction) +
    (sorted[upper] as number) * fraction
  );
}

/** Summarizes one sample distribution with the gate percentiles. */
export function summarize(samples: readonly number[]): SampleSummary {
  if (samples.length === 0) {
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
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    samples: sorted.length,
    mean: total / sorted.length,
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}
