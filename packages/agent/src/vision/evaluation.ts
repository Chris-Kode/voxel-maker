import {
  structuralDelta,
  type StructuralDelta,
  type StructuralMetrics,
} from "./structural.js";
import type { VisualEvidenceSet } from "./evidence.js";

/**
 * Refinement evaluation (plan S15.8/S15.9, ticket #40): compares the
 * structural and visual outcomes of a document before and after a
 * refinement (or one critique iteration) and decides whether the
 * refinement may be promoted. Regressions are never silent: every
 * detected violation is reported with a stable code, and `promotable`
 * is false while any regression or oscillation is flagged. The gate is
 * deterministic and pure; the desktop still leaves the final Apply
 * decision to the human (ADR-0007), but automated promotion and the
 * refinement loop itself refuse regressing work.
 */

/** Deterministic visual similarity of two same-size RGBA images. */
export interface ImageSimilarity {
  /** 1 when identical, 0 when maximally different. */
  readonly similarity: number;
  /** Fraction of pixels whose RGBA bytes differ. */
  readonly changedPixelFraction: number;
  /** Mean absolute channel delta over RGBA in [0, 255]. */
  readonly meanAbsChannelDelta: number;
}

/**
 * Compares two same-size RGBA buffers pixel by pixel. Deterministic and
 * allocation-bounded: it streams one pass and only accumulates three
 * counters. Different dimensions are an invalid comparison (callers
 * capture before/after evidence with the same spec).
 */
export function imageSimilarity(
  before: Uint8Array,
  after: Uint8Array,
  width: number,
  height: number,
): ImageSimilarity {
  const expected = width * height * 4;
  if (before.byteLength !== expected || after.byteLength !== expected) {
    throw new Error(
      `Image similarity needs two ${String(width)}x${String(height)} RGBA buffers`,
    );
  }
  let changedPixels = 0;
  let totalDelta = 0;
  for (let i = 0; i < expected; i += 4) {
    const delta =
      Math.abs((before[i] as number) - (after[i] as number)) +
      Math.abs((before[i + 1] as number) - (after[i + 1] as number)) +
      Math.abs((before[i + 2] as number) - (after[i + 2] as number)) +
      Math.abs((before[i + 3] as number) - (after[i + 3] as number));
    totalDelta += delta;
    if (delta !== 0) changedPixels += 1;
  }
  const pixelCount = width * height;
  const changedPixelFraction = changedPixels / pixelCount;
  const meanAbsChannelDelta = totalDelta / expected;
  return Object.freeze({
    similarity: Math.max(0, 1 - meanAbsChannelDelta / 255),
    changedPixelFraction,
    meanAbsChannelDelta,
  });
}

/** One per-view visual comparison of a refinement. */
export interface ViewVisualComparison {
  readonly view: string;
  readonly similarity: number;
  readonly changedPixelFraction: number;
}

/** Fixed regression policy of the refinement gate (S15.9). */
export interface RefinementPolicy {
  /**
   * Minimum fraction of baseline occupied voxels the refined state must
   * retain; a larger loss is flagged as an occupied-voxel regression.
   */
  readonly minOccupiedRetention: number;
  /**
   * Maximum growth factor of occupied voxels vs. the baseline; larger
   * growth is flagged as runaway correction.
   */
  readonly maxOccupiedGrowthFactor: number;
  /**
   * Maximum growth factor of the occupied-bounds diagonal; larger growth
   * is flagged as an exploded silhouette.
   */
  readonly maxBoundsGrowthFactor: number;
  /** Maximum distinct-material loss before a material regression is flagged. */
  readonly maxMaterialLoss: number;
}

/** ADR-0009-aligned default refinement gate policy. */
export const DEFAULT_REFINEMENT_POLICY: RefinementPolicy = Object.freeze({
  minOccupiedRetention: 0.5,
  maxOccupiedGrowthFactor: 4,
  maxBoundsGrowthFactor: 8,
  maxMaterialLoss: 2,
});

/** Merges and clamps caller overrides into the hard defaults. */
export function resolveRefinementPolicy(
  overrides: Partial<RefinementPolicy> | undefined,
): RefinementPolicy {
  const merged = { ...DEFAULT_REFINEMENT_POLICY, ...overrides };
  const clamp = (
    key: keyof RefinementPolicy,
    min: number,
    max: number,
  ): number => {
    const value = merged[key];
    return typeof value === "number" && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : DEFAULT_REFINEMENT_POLICY[key];
  };
  return Object.freeze({
    minOccupiedRetention: clamp("minOccupiedRetention", 0, 1),
    maxOccupiedGrowthFactor: clamp("maxOccupiedGrowthFactor", 1, 1000),
    maxBoundsGrowthFactor: clamp("maxBoundsGrowthFactor", 1, 1000),
    maxMaterialLoss: clamp("maxMaterialLoss", 0, 4096),
  });
}

/** The complete before/after refinement evaluation. */
export interface RefinementEvaluation {
  readonly baseline: StructuralMetrics;
  readonly refined: StructuralMetrics;
  readonly structural: StructuralDelta;
  /** Per-view visual comparison in canonical view order. */
  readonly visual: readonly ViewVisualComparison[];
  /** Mean similarity across compared views (1 when no views). */
  readonly overallSimilarity: number;
  /** Stable regression codes; empty when no regression was detected. */
  readonly regressions: readonly string[];
  /** True when the refined state repeated a previously seen state. */
  readonly oscillationDetected: boolean;
  /** True when automated promotion is allowed. */
  readonly promotable: boolean;
}

export interface EvaluationInput {
  readonly baseline: {
    readonly structure: StructuralMetrics;
    readonly evidence?: VisualEvidenceSet;
  };
  readonly refined: {
    readonly structure: StructuralMetrics;
    readonly evidence?: VisualEvidenceSet;
  };
  readonly policy?: Partial<RefinementPolicy>;
  /** Known oscillation (repeated state signature); default false. */
  readonly oscillationDetected?: boolean;
}

function compareEvidence(
  baseline: VisualEvidenceSet | undefined,
  refined: VisualEvidenceSet | undefined,
): readonly ViewVisualComparison[] {
  if (baseline === undefined || refined === undefined) {
    return Object.freeze([]);
  }
  const comparisons: ViewVisualComparison[] = [];
  for (const before of baseline.images) {
    const after = refined.images.find((image) => image.view === before.view);
    if (after === undefined) continue;
    if (
      after.width !== before.width ||
      after.height !== before.height
    ) {
      continue;
    }
    const result = imageSimilarity(
      before.rgbaBytes,
      after.rgbaBytes,
      before.width,
      before.height,
    );
    comparisons.push(
      Object.freeze({
        view: before.view,
        similarity: result.similarity,
        changedPixelFraction: result.changedPixelFraction,
      }),
    );
  }
  return Object.freeze(comparisons);
}

/**
 * Evaluates one refinement against its baseline: structural deltas plus
 * per-view visual similarity of the rendered evidence, with every
 * policy violation reported as a stable regression code. `promotable`
 * is false when any regression or oscillation was detected.
 */
export function evaluateRefinement(
  input: EvaluationInput,
): RefinementEvaluation {
  const policy = resolveRefinementPolicy(input.policy);
  const delta = structuralDelta(input.baseline.structure, input.refined.structure);
  const regressions: string[] = [];
  const baselineOccupied = input.baseline.structure.occupiedVoxels;
  const refinedOccupied = input.refined.structure.occupiedVoxels;
  if (
    baselineOccupied > 0 &&
    refinedOccupied < baselineOccupied * policy.minOccupiedRetention
  ) {
    regressions.push("occupied-voxel-loss");
  }
  if (
    baselineOccupied > 0 &&
    refinedOccupied > baselineOccupied * policy.maxOccupiedGrowthFactor
  ) {
    regressions.push("occupied-voxel-growth");
  }
  const boundsFactor = delta.boundsDiagonalFactor;
  if (Number.isFinite(boundsFactor) && boundsFactor > policy.maxBoundsGrowthFactor) {
    regressions.push("bounds-growth");
  }
  if (delta.materialCount < -policy.maxMaterialLoss) {
    regressions.push("material-loss");
  }
  const visual = compareEvidence(input.baseline.evidence, input.refined.evidence);
  const overallSimilarity =
    visual.length === 0
      ? 1
      : visual.reduce((sum, entry) => sum + entry.similarity, 0) /
        visual.length;
  const oscillationDetected = input.oscillationDetected ?? false;
  const promotable = regressions.length === 0 && !oscillationDetected;
  return Object.freeze({
    baseline: input.baseline.structure,
    refined: input.refined.structure,
    structural: delta,
    visual,
    overallSimilarity,
    regressions: Object.freeze(regressions),
    oscillationDetected,
    promotable,
  });
}
