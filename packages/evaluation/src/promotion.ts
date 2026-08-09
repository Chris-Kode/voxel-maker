import type { GeometryEvalResult } from "./harness.js";

/**
 * Promotion gates of the fixed evaluation suite (plan S12.3, ticket #35
 * AC): explicit thresholds plus the recorded baselines of the first
 * golden run. The thresholds mirror the plan's proposed promotion floors
 * — 100% safety/integrity cases, zero partial commits, >=95% schema-valid
 * tool calls, >=90% task-invariant success, zero over-budget runs —
 * plus a minimal-diff floor that blocks statistically meaningful
 * regression in unrelated changes and tool efficiency. Any result below
 * a recorded baseline requires an approved eval report (the
 * changed-baseline review process); the thresholds themselves are only
 * adjustable through an approved evaluation report.
 */

/** Minimal-diff promotion floors (plan 12.3). */
export interface MinimalDiffThresholds {
  readonly unrelatedChangesFloor: number;
  readonly efficiencyFloor: number;
}

/** Explicit promotion thresholds (plan 12.3, ticket #35 AC). */
export interface PromotionThresholds {
  /** 100% of safety/integrity cases must pass; zero partial commits. */
  readonly safetyAndIntegrity: number;
  /** Fraction of schema-valid tool calls across the suite. */
  readonly schemaValidToolCalls: number;
  /** Minimum per-scenario and suite-average task completion. */
  readonly taskSuccess: number;
  /** Zero over-budget (limit-failure) runs. */
  readonly overBudgetRuns: number;
  /** Minimal-diff floors: no regression vs the recorded baselines. */
  readonly minimalDiff: MinimalDiffThresholds;
  /** A score more than this far below its recorded baseline blocks. */
  readonly baselineRegressionTolerance: number;
}

/** Explicit promotion thresholds (plan 12.3, ticket #35 AC). */
export const PROMOTION_THRESHOLDS: PromotionThresholds = Object.freeze({
  /** 100% of safety/integrity cases must pass; zero partial commits. */
  safetyAndIntegrity: 1,
  /** Fraction of schema-valid tool calls across the suite. */
  schemaValidToolCalls: 0.95,
  /** Minimum per-scenario and suite-average task completion. */
  taskSuccess: 0.9,
  /** Zero over-budget (limit-failure) runs. */
  overBudgetRuns: 0,
  /** Minimal-diff floors: no regression vs the recorded baselines. */
  minimalDiff: Object.freeze({
    unrelatedChangesFloor: 0.95,
    efficiencyFloor: 0.9,
  }),
  /** A score more than this far below its recorded baseline blocks. */
  baselineRegressionTolerance: 0.05,
});

/** One recorded baseline score of the golden run (captured at v1). */
export interface BaselineRecord {
  readonly scenarioId: string;
  readonly dimension:
    | "taskCompletion"
    | "unrelatedChanges"
    | "efficiency"
    | "invalidCalls"
    | "limitFailures"
    | "semanticStructure"
    | "renderedPreviews";
  readonly score: number;
  /** Version of the evaluation suite the baseline was recorded under. */
  readonly recordedAtVersion: string;
}

const BASELINE_DIMENSIONS = [
  "taskCompletion",
  "unrelatedChanges",
  "efficiency",
  "invalidCalls",
  "limitFailures",
  "semanticStructure",
  "renderedPreviews",
] as const;

function suiteBaselines(
  scenarioId: string,
): readonly BaselineRecord[] {
  return BASELINE_DIMENSIONS.map((dimension) => ({
    scenarioId,
    dimension,
    score: 1,
    recordedAtVersion: "geometry-eval-v1",
  }));
}

/**
 * Baselines captured from the first golden harness run (geometry-eval-v1):
 * every golden trace scores 1.0 on every dimension by construction, and
 * the suite locks them so any future regression is detected instead of
 * silently absorbed into a new "looks good".
 */
export const RECORDED_BASELINES: readonly BaselineRecord[] = Object.freeze([
  ...suiteBaselines("chair-create"),
  ...suiteBaselines("shorter-legs"),
  ...suiteBaselines("red-seat"),
  ...suiteBaselines("mirror-left"),
]);

/** Baseline lookup: recorded score of one scenario dimension. */
export function recordedBaseline(
  scenarioId: string,
  dimension: BaselineRecord["dimension"],
): number | undefined {
  const record = RECORDED_BASELINES.find(
    (entry) =>
      entry.scenarioId === scenarioId && entry.dimension === dimension,
  );
  return record?.score;
}

/** One threshold check result. */
export interface ThresholdResult {
  readonly name: string;
  readonly threshold: number;
  readonly value: number;
  readonly passed: boolean;
}

/** One baseline regression entry (score below the recorded baseline). */
export interface BaselineRegression {
  readonly scenarioId: string;
  readonly dimension: BaselineRecord["dimension"];
  readonly baseline: number;
  readonly current: number;
  readonly delta: number;
  /** True when the delta exceeds the review tolerance. */
  readonly requiresReview: boolean;
}

/** The promotion report of one suite run. */
export interface PromotionReport {
  readonly promotable: boolean;
  readonly blocks: readonly string[];
  readonly thresholdResults: readonly ThresholdResult[];
  readonly baselineRegressions: readonly BaselineRegression[];
}

function dimensionScore(
  result: GeometryEvalResult,
  dimension: BaselineRecord["dimension"],
): number {
  switch (dimension) {
    case "taskCompletion":
      return result.scores.taskCompletion.score;
    case "unrelatedChanges":
      return result.scores.unrelatedChanges.score;
    case "efficiency":
      return result.scores.efficiency.score;
    case "invalidCalls":
      return result.scores.invalidCalls.score;
    case "limitFailures":
      return result.scores.limitFailures.score;
    case "semanticStructure":
      return result.scores.semanticStructure.score;
    case "renderedPreviews":
      return result.scores.renderedPreviews.score;
  }
}

/**
 * Evaluates one suite run against the explicit thresholds and the
 * recorded baselines. Returns the promotion decision plus every block
 * with its evidence.
 */
export function evaluatePromotion(
  results: readonly GeometryEvalResult[],
): PromotionReport {
  const blocks: string[] = [];
  const thresholdResults: ThresholdResult[] = [];
  const baselineRegressions: BaselineRegression[] = [];

  // 1. Safety and integrity: every run must reach approve+apply and no
  //    partial commit may occur; failed runs leave zero live changes.
  let integrityPassed = 0;
  let integrityTotal = 0;
  for (const result of results) {
    integrityTotal += 1;
    const intact =
      !result.integrity.partialCommit &&
      result.integrity.zeroStateChangeOnFailure;
    if (intact) integrityPassed += 1;
    if (!result.run.applyOk) {
      blocks.push(
        `${result.scenarioId}: proposal was not applied (run ok: ${String(result.run.ok)}, apply ok: ${String(result.run.applyOk)})`,
      );
    }
    if (result.integrity.partialCommit) {
      blocks.push(`${result.scenarioId}: partial commit detected`);
    }
    if (!result.integrity.zeroStateChangeOnFailure) {
      blocks.push(`${result.scenarioId}: failed run changed live state`);
    }
  }
  thresholdResults.push({
    name: "safety and integrity (100%)",
    threshold: PROMOTION_THRESHOLDS.safetyAndIntegrity,
    value: integrityPassed / Math.max(1, integrityTotal),
    passed: integrityPassed === integrityTotal,
  });

  // 2. Schema-valid tool calls across the suite (>= 95%).
  let validCalls = 0;
  let totalCalls = 0;
  for (const result of results) {
    validCalls +=
      result.scores.invalidCalls.totalCalls - result.scores.invalidCalls.invalidCalls;
    totalCalls += result.scores.invalidCalls.totalCalls;
  }
  const validRate = totalCalls === 0 ? 1 : validCalls / totalCalls;
  thresholdResults.push({
    name: "schema-valid tool calls (>= 95%)",
    threshold: PROMOTION_THRESHOLDS.schemaValidToolCalls,
    value: validRate,
    passed: validRate >= PROMOTION_THRESHOLDS.schemaValidToolCalls,
  });
  if (validRate < PROMOTION_THRESHOLDS.schemaValidToolCalls) {
    blocks.push(
      `schema-valid tool call rate ${validRate.toFixed(3)} below ${String(PROMOTION_THRESHOLDS.schemaValidToolCalls)}`,
    );
  }

  // 3. Task-invariant success (>= 90% per scenario and on average).
  const taskScores = results.map((result) => result.scores.taskCompletion.score);
  const averageTask = taskScores.reduce((sum, score) => sum + score, 0) /
    Math.max(1, taskScores.length);
  const allTasksPass = taskScores.every(
    (score) => score >= PROMOTION_THRESHOLDS.taskSuccess,
  );
  thresholdResults.push({
    name: "task completion per scenario (>= 90%)",
    threshold: PROMOTION_THRESHOLDS.taskSuccess,
    value: Math.min(...taskScores, 1),
    passed: allTasksPass,
  });
  thresholdResults.push({
    name: "task completion average (>= 90%)",
    threshold: PROMOTION_THRESHOLDS.taskSuccess,
    value: averageTask,
    passed: averageTask >= PROMOTION_THRESHOLDS.taskSuccess,
  });
  if (!allTasksPass) {
    blocks.push("one or more scenarios scored below the 90% task floor");
  }
  if (averageTask < PROMOTION_THRESHOLDS.taskSuccess) {
    blocks.push("suite-average task completion below the 90% floor");
  }

  // 4. Zero over-budget runs.
  const overBudget = results.filter(
    (result) => result.scores.limitFailures.limitFailure,
  ).length;
  thresholdResults.push({
    name: "zero over-budget runs",
    threshold: PROMOTION_THRESHOLDS.overBudgetRuns,
    value: overBudget,
    passed: overBudget === 0,
  });
  if (overBudget > 0) {
    blocks.push(`${String(overBudget)} over-budget run(s) detected`);
  }

  // 5. Minimal-diff floors (unrelated changes and efficiency).
  for (const result of results) {
    const unrelated = result.scores.unrelatedChanges.score;
    const efficiency = result.scores.efficiency.score;
    if (unrelated < PROMOTION_THRESHOLDS.minimalDiff.unrelatedChangesFloor) {
      blocks.push(
        `${result.scenarioId}: unrelated-changes score ${unrelated.toFixed(3)} below the ${String(PROMOTION_THRESHOLDS.minimalDiff.unrelatedChangesFloor)} floor`,
      );
    }
    if (efficiency < PROMOTION_THRESHOLDS.minimalDiff.efficiencyFloor) {
      blocks.push(
        `${result.scenarioId}: efficiency score ${efficiency.toFixed(3)} below the ${String(PROMOTION_THRESHOLDS.minimalDiff.efficiencyFloor)} floor`,
      );
    }
  }

  // 6. Changed-baseline review: any score below its recorded baseline
  //    requires an approved evaluation report before promotion.
  for (const result of results) {
    for (const dimension of BASELINE_DIMENSIONS) {
      const baseline = recordedBaseline(result.scenarioId, dimension);
      if (baseline === undefined) continue;
      const current = dimensionScore(result, dimension);
      const delta = baseline - current;
      if (delta <= 0) continue;
      const requiresReview =
        delta > PROMOTION_THRESHOLDS.baselineRegressionTolerance;
      baselineRegressions.push({
        scenarioId: result.scenarioId,
        dimension,
        baseline,
        current,
        delta,
        requiresReview,
      });
      if (requiresReview) {
        blocks.push(
          `${result.scenarioId} ${dimension}: ${current.toFixed(3)} below the recorded baseline ${baseline.toFixed(3)} — changed baseline requires an approved eval report`,
        );
      }
    }
  }

  return {
    promotable: blocks.length === 0,
    blocks,
    thresholdResults,
    baselineRegressions,
  };
}
