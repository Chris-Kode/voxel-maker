import type {
  BaselineView,
  SkillVisualBaseline,
} from "./manifest.js";

/**
 * Visual-baseline evaluation (plan S14.10, ticket #38): each creation
 * skill fixes rendered-preview baselines over the standard preview
 * views. The skills package never renders (no renderer dependency); the
 * deterministic renderer evidence — one non-background silhouette share
 * per view — is supplied by the evaluation harness, and this module
 * decides pass/fail against the skill's fixed ratio intervals.
 */

/** Evidence the evaluation harness supplies per standard view. */
export interface BaselineEvidence {
  /** Non-background pixel share per view (0..1, or absent). */
  readonly silhouetteRatios: Readonly<Partial<Record<BaselineView, number>>>;
}

/** Result of one visual baseline. */
export interface BaselineResult {
  readonly view: BaselineView;
  readonly passed: boolean;
  /** Measured silhouette share (undefined when the view has no evidence). */
  readonly ratio: number | undefined;
  /** Inclusive bounds of the baseline (defaults 0..1). */
  readonly minRatio: number;
  readonly maxRatio: number;
  readonly evidence: string;
}

/**
 * Evaluates every visual baseline of a skill against the rendered
 * evidence. A baseline passes only when the view has evidence and the
 * measured share lies inside the fixed interval. Results are frozen and
 * in manifest order.
 */
export function evaluateVisualBaselines(
  baselines: readonly SkillVisualBaseline[],
  evidence: BaselineEvidence,
): readonly BaselineResult[] {
  return Object.freeze(
    baselines.map((baseline) => {
      const minRatio = baseline.minSilhouetteRatio ?? 0;
      const maxRatio = baseline.maxSilhouetteRatio ?? 1;
      const ratio = evidence.silhouetteRatios[baseline.view];
      const passed =
        ratio !== undefined && ratio >= minRatio && ratio <= maxRatio;
      return Object.freeze({
        view: baseline.view,
        passed,
        ratio,
        minRatio,
        maxRatio,
        evidence:
          ratio === undefined
            ? `no silhouette evidence for view ${baseline.view}`
            : `silhouette=${ratio.toFixed(4)} expected [${minRatio.toFixed(4)},${maxRatio.toFixed(4)}]`,
      });
    }),
  );
}

/** True when every visual baseline of the skill passed. */
export function baselinesPassed(
  results: readonly BaselineResult[],
): boolean {
  return results.every((result) => result.passed);
}
