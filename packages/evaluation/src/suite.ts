import { EVALUATION_VERSION, RIG_EVALUATION_VERSION } from "./versions.js";
import type { ScenarioId } from "./scenarios.js";
import type { RigScenarioId } from "./rig-scenarios.js";

/**
 * Versioned manifest of the complete fixed evaluation suite (issue #76,
 * plan 12.3): the required-case definition the promotion gate enforces.
 * Every case names the scenario it runs, the suite version it belongs
 * to, and its expected outcome — "apply" for the positive lane (golden
 * workflows) or "fail-closed" for the safety lane (deterministic
 * rejected traces: invalid calls, stale revisions, over-budget runs,
 * cancellations, prompt-injection metadata). Promotion may only pass
 * when every manifest case is supplied exactly once, no unknown case is
 * added, and each case meets its expected outcome and integrity
 * assertions.
 */

/** Expected outcome of one required evaluation case (plan 12.3 lanes). */
export type ExpectedOutcome = "apply" | "fail-closed";

/** One required case of the fixed evaluation suite manifest. */
export interface SuiteCase {
  /**
   * Stable case id: the scenario id for golden cases, a suffixed id for
   * the adversarial traces that reuse a scenario with a rejected script.
   */
  readonly id: string;
  /** The scenario the case runs. */
  readonly scenarioId: ScenarioId | RigScenarioId;
  /** Expected outcome: apply (positive lane) or fail-closed (safety lane). */
  readonly expectedOutcome: ExpectedOutcome;
  /** Suite version the case belongs to. */
  readonly suiteVersion: string;
}

/** Versioned manifest of the complete fixed evaluation suite. */
export interface SuiteManifest {
  readonly version: string;
  readonly cases: readonly SuiteCase[];
}

/** The complete fixed evaluation suite (geometry + rig, both lanes). */
const SUITE_CASES: readonly SuiteCase[] = Object.freeze([
  // Geometry positive lane (plan S12.13, ticket #35).
  {
    id: "chair-create",
    scenarioId: "chair-create",
    expectedOutcome: "apply",
    suiteVersion: EVALUATION_VERSION,
  },
  {
    id: "shorter-legs",
    scenarioId: "shorter-legs",
    expectedOutcome: "apply",
    suiteVersion: EVALUATION_VERSION,
  },
  {
    id: "red-seat",
    scenarioId: "red-seat",
    expectedOutcome: "apply",
    suiteVersion: EVALUATION_VERSION,
  },
  {
    id: "mirror-left",
    scenarioId: "mirror-left",
    expectedOutcome: "apply",
    suiteVersion: EVALUATION_VERSION,
  },
  // Geometry safety lane (plan 12.3 rejected traces).
  {
    id: "red-seat-invalid-trace",
    scenarioId: "red-seat",
    expectedOutcome: "fail-closed",
    suiteVersion: EVALUATION_VERSION,
  },
  {
    id: "mirror-left-stale-revision",
    scenarioId: "mirror-left",
    expectedOutcome: "fail-closed",
    suiteVersion: EVALUATION_VERSION,
  },
  {
    id: "shorter-legs-over-budget",
    scenarioId: "shorter-legs",
    expectedOutcome: "fail-closed",
    suiteVersion: EVALUATION_VERSION,
  },
  {
    id: "chair-create-cancel",
    scenarioId: "chair-create",
    expectedOutcome: "fail-closed",
    suiteVersion: EVALUATION_VERSION,
  },
  {
    id: "chair-create-prompt-injection",
    scenarioId: "chair-create",
    expectedOutcome: "fail-closed",
    suiteVersion: EVALUATION_VERSION,
  },
  // Rig positive lane (ticket #36).
  {
    id: "chest-lid-open",
    scenarioId: "chest-lid-open",
    expectedOutcome: "apply",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  {
    id: "wheel-spin",
    scenarioId: "wheel-spin",
    expectedOutcome: "apply",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  {
    id: "wings-flap",
    scenarioId: "wings-flap",
    expectedOutcome: "apply",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  {
    id: "arm-reach",
    scenarioId: "arm-reach",
    expectedOutcome: "apply",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  {
    id: "abstract-rig",
    scenarioId: "abstract-rig",
    expectedOutcome: "apply",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  {
    id: "chest-farther",
    scenarioId: "chest-farther",
    expectedOutcome: "apply",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  {
    id: "wheel-slower",
    scenarioId: "wheel-slower",
    expectedOutcome: "apply",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  {
    id: "wings-one",
    scenarioId: "wings-one",
    expectedOutcome: "apply",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  {
    id: "arm-elbow-limit",
    scenarioId: "arm-elbow-limit",
    expectedOutcome: "apply",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  {
    id: "wheel-faster",
    scenarioId: "wheel-faster",
    expectedOutcome: "apply",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  // Rig safety lane (plan 12.3 rejected traces).
  {
    id: "wheel-spin-invalid-trace",
    scenarioId: "wheel-spin",
    expectedOutcome: "fail-closed",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  {
    id: "abstract-rig-over-budget",
    scenarioId: "abstract-rig",
    expectedOutcome: "fail-closed",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  {
    id: "wheel-faster-stale-revision",
    scenarioId: "wheel-faster",
    expectedOutcome: "fail-closed",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
  {
    id: "arm-reach-cancel",
    scenarioId: "arm-reach",
    expectedOutcome: "fail-closed",
    suiteVersion: RIG_EVALUATION_VERSION,
  },
]);

/** The complete fixed evaluation suite (geometry + rig, both lanes). */
export const EVALUATION_SUITE_MANIFEST: SuiteManifest = Object.freeze({
  version: "evaluation-suite-v1",
  cases: SUITE_CASES,
});

/** Manifest case lookup by id (stable). */
export function suiteCaseById(id: string): SuiteCase | undefined {
  return EVALUATION_SUITE_MANIFEST.cases.find((entry) => entry.id === id);
}
