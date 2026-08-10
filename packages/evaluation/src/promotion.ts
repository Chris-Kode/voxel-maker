import { EVALUATION_VERSION, RIG_EVALUATION_VERSION } from "./versions.js";
import { SCORE_DIMENSIONS, type ScoreDimension } from "./score.js";
import type { GeometryEvalResult } from "./harness.js";
import { EVALUATION_SUITE_MANIFEST, suiteCaseById } from "./suite.js";

/**
 * Promotion gates of the fixed evaluation suite (plan S12.3, ticket #35
 * AC): the versioned suite manifest (issue #76), explicit thresholds
 * plus the recorded baselines of the first golden run. The thresholds
 * mirror the plan's proposed promotion floors — 100% safety/integrity
 * cases, zero partial commits, >=95% schema-valid tool calls, >=90%
 * task-invariant success, zero over-budget runs — plus a minimal-diff
 * floor that blocks statistically meaningful regression in unrelated
 * changes and tool efficiency. The floors measure the positive lane
 * (apply cases); the safety lane (fail-closed rejected traces) is gated
 * by its expected outcomes and integrity assertions instead, because
 * those traces are intentionally invalid or over-budget. Any result
 * below a recorded baseline requires an approved eval report (the
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
  readonly dimension: ScoreDimension;
  readonly score: number;
  /** Version of the evaluation suite the baseline was recorded under. */
  readonly recordedAtVersion: string;
}

function suiteBaselines(
  scenarioId: string,
  version: string = EVALUATION_VERSION,
): readonly BaselineRecord[] {
  return SCORE_DIMENSIONS.map((dimension) => ({
    scenarioId,
    dimension,
    score: 1,
    recordedAtVersion: version,
  }));
}

/**
 * Pinned v1 baselines: the golden suite is DESIGNED to score 1.0 on
 * every dimension (the recorded traces are the perfect executions), and
 * the suite test re-runs the golden scenarios and asserts the measured
 * scores reproduce these records exactly, so any future drift is
 * detected instead of silently absorbed into a new "looks good".
 */
export const RECORDED_BASELINES: readonly BaselineRecord[] = Object.freeze([
  ...suiteBaselines("chair-create"),
  ...suiteBaselines("shorter-legs"),
  ...suiteBaselines("red-seat"),
  ...suiteBaselines("mirror-left"),
  ...suiteBaselines("chest-lid-open", RIG_EVALUATION_VERSION),
  ...suiteBaselines("wheel-spin", RIG_EVALUATION_VERSION),
  ...suiteBaselines("wings-flap", RIG_EVALUATION_VERSION),
  ...suiteBaselines("arm-reach", RIG_EVALUATION_VERSION),
  ...suiteBaselines("abstract-rig", RIG_EVALUATION_VERSION),
  ...suiteBaselines("chest-farther", RIG_EVALUATION_VERSION),
  ...suiteBaselines("wheel-slower", RIG_EVALUATION_VERSION),
  ...suiteBaselines("wings-one", RIG_EVALUATION_VERSION),
  ...suiteBaselines("arm-elbow-limit", RIG_EVALUATION_VERSION),
  ...suiteBaselines("wheel-faster", RIG_EVALUATION_VERSION),
]);

/** Baseline lookup: recorded score of one scenario dimension. */
export function recordedBaseline(
  scenarioId: string,
  dimension: BaselineRecord["dimension"],
): number | undefined {
  const record = RECORDED_BASELINES.find(
    (entry) => entry.scenarioId === scenarioId && entry.dimension === dimension,
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
  /** Version of the suite manifest the gate enforced (issue #76). */
  readonly manifestVersion: string;
}

const DIMENSION_SCORES: Readonly<
  Record<ScoreDimension, (result: GeometryEvalResult) => number>
> = {
  taskCompletion: (result) => result.scores.taskCompletion.score,
  unrelatedChanges: (result) => result.scores.unrelatedChanges.score,
  efficiency: (result) => result.scores.efficiency.score,
  invalidCalls: (result) => result.scores.invalidCalls.score,
  limitFailures: (result) => result.scores.limitFailures.score,
  semanticStructure: (result) => result.scores.semanticStructure.score,
  renderedPreviews: (result) => result.scores.renderedPreviews.score,
  overlayPlayback: (result) => result.scores.overlayPlayback.score,
};

/**
 * Evaluates one suite run against the versioned suite manifest (issue
 * #76), the explicit thresholds, and the recorded baselines. Returns the
 * promotion decision plus every block with its evidence.
 *
 * The manifest gate makes promotion prove the WHOLE fixed suite ran:
 * every required case must be supplied exactly once, no unknown case
 * may be added, each result must carry the suite version its case
 * belongs to, and each case must meet its expected outcome — "apply"
 * for the positive lane, "fail-closed" (rejected safely, zero live
 * state change) for the safety lane. Thresholds and baseline review
 * apply to the positive lane only; the safety lane is gated by its
 * expected outcomes.
 */
export function evaluatePromotion(
  results: readonly GeometryEvalResult[],
): PromotionReport {
  const blocks: string[] = [];
  const thresholdResults: ThresholdResult[] = [];
  const baselineRegressions: BaselineRegression[] = [];

  // 0. Suite manifest gate: every required case exactly once, no
  //    unknown cases, matching scenario and suite version per case.
  const byCaseId = new Map<string, GeometryEvalResult>();
  for (const result of results) {
    if (byCaseId.has(result.caseId)) {
      blocks.push(`duplicate case ${result.caseId}: supplied more than once`);
      continue;
    }
    byCaseId.set(result.caseId, result);
  }
  for (const suiteCase of EVALUATION_SUITE_MANIFEST.cases) {
    const result = byCaseId.get(suiteCase.id);
    if (result === undefined) {
      blocks.push(`missing required case ${suiteCase.id}`);
      continue;
    }
    if (result.scenarioId !== suiteCase.scenarioId) {
      blocks.push(
        `case ${suiteCase.id}: result ran scenario ${result.scenarioId}, manifest requires ${suiteCase.scenarioId}`,
      );
    }
    if (result.versions.evaluation !== suiteCase.suiteVersion) {
      blocks.push(
        `case ${suiteCase.id}: result recorded under suite version ${result.versions.evaluation}, manifest requires ${suiteCase.suiteVersion}`,
      );
    }
  }
  for (const result of results) {
    if (suiteCaseById(result.caseId) === undefined) {
      blocks.push(`unknown case ${result.caseId}: not in the suite manifest`);
    }
  }

  // 1. Safety and integrity: every case must reach its expected outcome
  //    with no partial commit and zero live state change on failure.
  //    Unknown cases are excluded from the threshold (already blocked).
  let integrityPassed = 0;
  let integrityTotal = 0;
  for (const result of results) {
    const suiteCase = suiteCaseById(result.caseId);
    if (suiteCase === undefined) continue; // unknown case already blocked
    integrityTotal += 1;
    const intact =
      !result.integrity.partialCommit &&
      result.integrity.zeroStateChangeOnFailure;
    if (intact) integrityPassed += 1;
    if (suiteCase.expectedOutcome === "apply") {
      if (!result.run.applyOk) {
        blocks.push(
          `${result.caseId}: proposal was not applied (run ok: ${String(result.run.ok)}, apply ok: ${String(result.run.applyOk)})`,
        );
      }
    } else if (result.run.applyOk) {
      blocks.push(
        `${result.caseId}: expected fail-closed but the proposal was applied`,
      );
    }
    // Rejected traces must leave the live document untouched: the
    // revision counter only advances on a commit, so revision equality
    // (zeroStateChangeOnFailure) is the content-level "exact expected
    // hash" of the safety lane (plan 12.3).
    if (result.integrity.partialCommit) {
      blocks.push(`${result.caseId}: partial commit detected`);
    }
    if (!result.integrity.zeroStateChangeOnFailure) {
      blocks.push(`${result.caseId}: failed run changed live state`);
    }
  }
  thresholdResults.push({
    name: "safety and integrity (100%)",
    threshold: PROMOTION_THRESHOLDS.safetyAndIntegrity,
    value: integrityPassed / Math.max(1, integrityTotal),
    passed: integrityPassed === integrityTotal,
  });

  // The remaining floors measure the positive lane (apply cases); the
  // safety lane is gated by its expected outcomes above.
  const applyResults = results.filter(
    (result) => suiteCaseById(result.caseId)?.expectedOutcome === "apply",
  );

  // 2. Schema-valid tool calls across the positive lane (>= 95%).
  let validCalls = 0;
  let totalCalls = 0;
  for (const result of applyResults) {
    validCalls +=
      result.scores.invalidCalls.totalCalls -
      result.scores.invalidCalls.invalidCalls;
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
  const taskScores = applyResults.map(
    (result) => result.scores.taskCompletion.score,
  );
  const averageTask =
    taskScores.reduce((sum, score) => sum + score, 0) /
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

  // 4. Zero over-budget runs in the positive lane.
  const overBudget = applyResults.filter(
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
  for (const result of applyResults) {
    const unrelated = result.scores.unrelatedChanges.score;
    const efficiency = result.scores.efficiency.score;
    if (unrelated < PROMOTION_THRESHOLDS.minimalDiff.unrelatedChangesFloor) {
      blocks.push(
        `${result.caseId}: unrelated-changes score ${unrelated.toFixed(3)} below the ${String(PROMOTION_THRESHOLDS.minimalDiff.unrelatedChangesFloor)} floor`,
      );
    }
    if (efficiency < PROMOTION_THRESHOLDS.minimalDiff.efficiencyFloor) {
      blocks.push(
        `${result.caseId}: efficiency score ${efficiency.toFixed(3)} below the ${String(PROMOTION_THRESHOLDS.minimalDiff.efficiencyFloor)} floor`,
      );
    }
  }

  // 6. Changed-baseline review: any score below its recorded baseline
  //    requires an approved evaluation report before promotion.
  for (const result of applyResults) {
    for (const dimension of SCORE_DIMENSIONS) {
      const baseline = recordedBaseline(result.scenarioId, dimension);
      if (baseline === undefined) continue;
      const current = DIMENSION_SCORES[dimension](result);
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
          `${result.caseId} ${dimension}: ${current.toFixed(3)} below the recorded baseline ${baseline.toFixed(3)} — changed baseline requires an approved eval report`,
        );
      }
    }
  }

  return {
    promotable: blocks.length === 0,
    blocks,
    thresholdResults,
    baselineRegressions,
    manifestVersion: EVALUATION_SUITE_MANIFEST.version,
  };
}
