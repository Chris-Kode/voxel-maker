import { describe, expect, it } from "vitest";
import { createInspectionStore } from "../fixtures.js";
import { createPreviewRegistry } from "../registry.js";
import { createPreviewSession, previewSessionId } from "../preview.js";
import { commandId } from "@voxel-maker/shared";
import { createFakeEvidenceCapture } from "./test-fixtures.js";
import {
  DEFAULT_REFINEMENT_POLICY,
  evaluateRefinement,
  imageSimilarity,
  resolveRefinementPolicy,
  type RefinementEvaluation,
} from "./evaluation.js";
import { measureStructure } from "./structural.js";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { VisualEvidenceSet } from "./evidence.js";

/**
 * Refinement evaluation tests (plan S15.8/S15.9, ticket #40): the gate
 * compares structural AND visual outcomes before/after refinement and
 * prevents promotion when a regression or oscillation was detected.
 */

function capture(store: DocumentStoreRead): VisualEvidenceSet {
  return createFakeEvidenceCapture().captureEvidence({
    store,
    source: "preview",
    sessionId: "preview:eval",
  });
}

function stagedWithFill(
  fill: {
    min: [number, number, number];
    max: [number, number, number];
  },
  type: "voxel.fillBox" | "voxel.deleteRegion" = "voxel.fillBox",
): {
  baseline: ReturnType<typeof measureStructure>;
  refined: ReturnType<typeof measureStructure>;
  baselineEvidence: VisualEvidenceSet;
  refinedEvidence: VisualEvidenceSet;
} {
  const { handle } = createInspectionStore();
  const registry = createPreviewRegistry();
  const session = createPreviewSession({
    live: handle.store,
    registry,
    sessionId: previewSessionId("preview:eval:staged"),
  });
  const command =
    type === "voxel.fillBox"
      ? {
          id: commandId("cmd:eval:fill"),
          type: "voxel.fillBox" as const,
          schemaVersion: 1,
          payload: { volumeId: "volume:main", region: fill, material: 1 },
        }
      : {
          id: commandId("cmd:eval:delete"),
          type: "voxel.deleteRegion" as const,
          schemaVersion: 1,
          payload: { volumeId: "volume:main", region: fill },
        };
  const staged = session.stage(command);
  if (!staged.ok) throw new Error(`stage failed: ${staged.error.code}`);
  const baseline = measureStructure(handle.store);
  const refined = measureStructure(session);
  return {
    baseline,
    refined,
    baselineEvidence: capture(handle.store),
    refinedEvidence: capture(session),
  };
}

describe("imageSimilarity", () => {
  it("returns 1 for identical buffers and 0 for inverted ones", () => {
    const a = new Uint8Array(16).fill(7);
    const b = new Uint8Array(16).fill(7);
    const same = imageSimilarity(a, b, 2, 2);
    expect(same.similarity).toBe(1);
    expect(same.changedPixelFraction).toBe(0);
    const c = new Uint8Array(16).fill(255);
    const inverted = imageSimilarity(a, c, 2, 2);
    expect(inverted.similarity).toBeCloseTo(1 - 248 / 255, 5);
    expect(inverted.changedPixelFraction).toBe(1);
  });

  it("rejects mismatched buffer sizes", () => {
    expect(() =>
      imageSimilarity(new Uint8Array(8), new Uint8Array(16), 2, 2),
    ).toThrow();
  });
});

describe("resolveRefinementPolicy", () => {
  it("clamps overrides into the hard defaults", () => {
    expect(resolveRefinementPolicy(undefined)).toEqual(DEFAULT_REFINEMENT_POLICY);
    const policy = resolveRefinementPolicy({
      minOccupiedRetention: 2,
      maxOccupiedGrowthFactor: 0,
      maxBoundsGrowthFactor: NaN,
    });
    expect(policy.minOccupiedRetention).toBe(1);
    expect(policy.maxOccupiedGrowthFactor).toBe(1);
    expect(policy.maxBoundsGrowthFactor).toBe(
      DEFAULT_REFINEMENT_POLICY.maxBoundsGrowthFactor,
    );
  });
});

describe("evaluateRefinement", () => {
  it("promotes a small non-regressing refinement", () => {
    const { baseline, refined, baselineEvidence, refinedEvidence } =
      stagedWithFill({ min: [0, 0, 0], max: [2, 2, 2] });
    const evaluation = evaluateRefinement({
      baseline: { structure: baseline, evidence: baselineEvidence },
      refined: { structure: refined, evidence: refinedEvidence },
    });
    expect(evaluation.regressions).toEqual([]);
    expect(evaluation.promotable).toBe(true);
    expect(evaluation.structural.occupiedVoxels).toBeGreaterThan(0);
    expect(evaluation.overallSimilarity).toBeLessThan(1);
    expect(evaluation.visual.length).toBe(4);
  });

  it("flags occupied-voxel loss beyond the retention floor", () => {
    const { baseline, refined, baselineEvidence, refinedEvidence } =
      stagedWithFill(
        { min: [0, 0, 0], max: [2, 2, 2] },
        "voxel.deleteRegion",
      );
    // Deleting the whole occupied region drops 4 -> 0 voxels (100% loss).
    const evaluation = evaluateRefinement({
      baseline: { structure: baseline, evidence: baselineEvidence },
      refined: { structure: refined, evidence: refinedEvidence },
      policy: { minOccupiedRetention: 0.5 },
    });
    expect(evaluation.regressions).toContain("occupied-voxel-loss");
    expect(evaluation.promotable).toBe(false);
  });

  it("flags runaway growth beyond the growth factor", () => {
    const { baseline, refined, baselineEvidence, refinedEvidence } =
      stagedWithFill({ min: [0, 0, 0], max: [2, 2, 2] });
    const evaluation = evaluateRefinement({
      baseline: { structure: baseline, evidence: baselineEvidence },
      refined: { structure: refined, evidence: refinedEvidence },
      policy: { maxOccupiedGrowthFactor: 1.5 },
    });
    expect(evaluation.regressions).toContain("occupied-voxel-growth");
    expect(evaluation.promotable).toBe(false);
  });

  it("flags oscillation and refuses promotion", () => {
    const { baseline, refined, baselineEvidence, refinedEvidence } =
      stagedWithFill({ min: [0, 0, 0], max: [2, 2, 2] });
    const evaluation: RefinementEvaluation = evaluateRefinement({
      baseline: { structure: baseline, evidence: baselineEvidence },
      refined: { structure: refined, evidence: refinedEvidence },
      oscillationDetected: true,
    });
    expect(evaluation.oscillationDetected).toBe(true);
    expect(evaluation.promotable).toBe(false);
  });

  it("handles empty documents without a regression flag", () => {
    const { handle } = createInspectionStore();
    const evaluation = evaluateRefinement({
      baseline: { structure: measureStructure(handle.store) },
      refined: { structure: measureStructure(handle.store) },
    });
    expect(evaluation.regressions).toEqual([]);
    expect(evaluation.promotable).toBe(true);
    expect(evaluation.visual).toEqual([]);
    expect(evaluation.overallSimilarity).toBe(1);
  });
});
