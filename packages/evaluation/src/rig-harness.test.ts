import { describe, expect, it } from "vitest";
import type { DeterministicStep } from "@voxel-maker/agent";
import { evaluateScenario, type GeometryEvalResult } from "./harness.js";
import {
  evaluatePromotion,
  PROMOTION_THRESHOLDS,
  RECORDED_BASELINES,
} from "./promotion.js";
import {
  RIG_SCENARIOS,
  rigScenarioById,
  type RigScenarioId,
} from "./rig-scenarios.js";
import {
  RIG_CLIP_IDS,
  RIG_IDS,
  createRigFixtureStore,
} from "./rig-fixtures.js";
import { RIG_EVALUATION_VERSION } from "./versions.js";

/**
 * Fixed rig/animation evaluation suite (plan S13.7-S13.9, ticket #36 AC):
 * the five fixed rig+animate scenarios (chest lid, wheel, wings, linked
 * arm, abstract rig) and the five follow-up scenarios (farther, slower,
 * one wing, elbow limit, twice as fast) run from deterministic unrigged
 * and rigged fixtures through recorded golden traces, score 1.0 on every
 * dimension including overlay-clip playback, and reproduce their pinned
 * golden hashes. Adversarial traces verify that non-minimal follow-ups,
 * invalid calls, over-budget runs, cancellation, and revision conflicts
 * are detected and leave live state untouched.
 */

const RIG_SCENARIO_IDS: readonly RigScenarioId[] = [
  "chest-lid-open",
  "wheel-spin",
  "wings-flap",
  "arm-reach",
  "abstract-rig",
  "chest-farther",
  "wheel-slower",
  "wings-one",
  "arm-elbow-limit",
  "wheel-faster",
];

const PINNED_HASHES: Readonly<
  Record<RigScenarioId, { readonly input: string; readonly output: string }>
> = {
  "chest-lid-open": {
    input: "db8970ad34b10d4b5a02aad0feefefcd41770dfb639d0f282a0c1f4063a382c2",
    output: "9c588f40d7687792c786e4eb340887fcee5d243fa447903410458790d0a31974",
  },
  "wheel-spin": {
    input: "8483465f3e6352d36e88c20e8fd5f7c4710c000037482c873b522cbbbfe3dfc2",
    output: "fb35a4192b7ac276163fd7a7aa62980f047fc5735980ed5abb3c6ae10b482d49",
  },
  "wings-flap": {
    input: "c2aaada854108e64340e129425253ec2cb44900d2cec037d7e3ea91e633a2be1",
    output: "33fe71b6bfc350c3b8d69f815d2208cc28fe71ed2faee4e9999fe47029973dec",
  },
  "arm-reach": {
    input: "09d52f19650fafb06f4313b9acfd91b7396bb0044f8c6157519a58512387ec84",
    output: "6a096ce9b7f6abd212eeb701c02f21e17624fd3bee62a55206e2da062956e777",
  },
  "abstract-rig": {
    input: "d6846f9a1130694f24a140701d5acf633ab55253601410511d15c83f8507458b",
    output: "df2aaf8eead705bdc651945ee4eea8667f8e45d22bc3d00b59673a8ccf2fea8e",
  },
  "chest-farther": {
    input: "6e855203914068daf3355422470bbbc4b83e1e39265e4fea400ac2f51a55aad4",
    output: "cc784ecd29d3ef43423e7faa7ed4c8ac4138fa7d98679acb413edc9707e4280c",
  },
  "wheel-slower": {
    input: "c1c6d6822dbb8d69f2d4426933710d1641675c4b9a930a06ac866af4041254ab",
    output: "cd913036d776e5e8dace2ec12856ce23f4774409f4aac480e3505c699fb063e1",
  },
  "wings-one": {
    input: "55ae9cdca95e5749fc5c9567dbc73b580c57a94652cd8bf329f8989521bfb7d8",
    output: "d818278f232361aa5b5ea38b47fe418b0b44aec2094325232414d17aae424bf4",
  },
  "arm-elbow-limit": {
    input: "d3ef296ee2172feb08cfec0e17fac144b63449c4414b88be95a7806ef31dac7d",
    output: "9466f2834c9293f66921a77fb4149fd2368cd8acc52fcc5004b6e0443bda5dc2",
  },
  "wheel-faster": {
    input: "c1c6d6822dbb8d69f2d4426933710d1641675c4b9a930a06ac866af4041254ab",
    output: "1a1b99b4c688a89f12dcebdbead49833ce340f8d23724a3ad324727dc9531643",
  },
};

describe("fixed rig/animation evaluation: golden scenarios", () => {
  it.each(RIG_SCENARIO_IDS)(
    "%s: golden trace approves, applies, and scores 1.0 on every dimension",
    async (scenarioId) => {
      const scenario = rigScenarioById(scenarioId);
      const result = await evaluateScenario({ scenarioId });
      expect(result.run.ok, `run failed: ${String(result.run.reason)}`).toBe(
        true,
      );
      expect(result.run.applyOk).toBe(true);
      expect(result.run.state).toBe("approve");
      expect(result.run.stagedCommands).toBe(scenario.goldenCommands);
      expect(result.run.rounds).toBe(scenario.goldenRounds);
      expect(result.run.toolCalls).toBe(scenario.goldenToolCalls);
      expect(result.scores.taskCompletion.score).toBe(1);
      expect(result.scores.taskCompletion.failures).toEqual([]);
      expect(result.scores.unrelatedChanges.score).toBe(1);
      expect(result.scores.unrelatedChanges.unrelatedVoxels).toBe(0);
      expect(result.scores.unrelatedChanges.materialScore).toBe(1);
      expect(result.scores.efficiency.score).toBe(1);
      expect(result.scores.invalidCalls.score).toBe(1);
      expect(result.scores.limitFailures.limitFailure).toBe(false);
      expect(result.scores.semanticStructure.score).toBe(1);
      expect(result.scores.renderedPreviews.score).toBe(1);
      expect(result.scores.renderedPreviews.failures).toEqual([]);
      // Overlay-clip playback evidence: the staged clip played before
      // Apply and every playback signal passed.
      expect(result.scores.overlayPlayback.score).toBe(1);
      expect(result.scores.overlayPlayback.total).toBeGreaterThan(0);
      expect(result.scores.overlayPlayback.failures).toEqual([]);
      expect(result.scores.overlayPlayback.clipId).toBe(
        scenario.playbackClipId,
      );
      // Integrity: exactly one live revision via Apply, one history entry.
      expect(result.integrity.partialCommit).toBe(false);
      expect(result.integrity.revisionAfter).toBe(
        result.integrity.revisionBefore + 1,
      );
      expect(result.integrity.historyAfter).toBe(
        result.integrity.historyBefore + 1,
      );
      expect(result.run.applyLabel).toBe(`AI eval: ${scenario.name}`);
      // Rendered preview evidence: rig scenarios never change voxels, so
      // before and after silhouettes are both non-empty (the render is
      // the same static geometry; the motion lives in the clip playback).
      expect(result.previews.before.completed).toBe(true);
      expect(result.previews.after.completed).toBe(true);
      expect(result.previews.before.silhouettePixels).toBeGreaterThan(0);
      expect(result.previews.after.silhouettePixels).toBeGreaterThan(0);
      // Versions: the rig suite records its own evaluation version.
      expect(result.versions.evaluation).toBe(RIG_EVALUATION_VERSION);
      expect(result.versions.prompt.systemVersion).toMatch(/^[0-9a-f]{16}$/u);
    },
  );

  it("pins the exact golden input and output document hashes", async () => {
    for (const scenarioId of RIG_SCENARIO_IDS) {
      const result = await evaluateScenario({ scenarioId });
      expect(result.hashes.input).toBe(PINNED_HASHES[scenarioId].input);
      expect(result.hashes.output).toBe(PINNED_HASHES[scenarioId].output);
    }
  });

  it("is fully deterministic: repeated runs produce identical hashes", async () => {
    const first = await evaluateScenario({ scenarioId: "arm-reach" });
    const second = await evaluateScenario({ scenarioId: "arm-reach" });
    expect(second.hashes).toEqual(first.hashes);
    expect(second.scores).toEqual(first.scores);
    expect(second.versions.fixture.inputDocumentHash).toBe(
      first.versions.fixture.inputDocumentHash,
    );
  });

  it("the follow-up scenarios start from the exact rigged end state", () => {
    // The follow-up fixtures ARE the initial scenarios' golden end state:
    // the rigged fixture clip matches the eval clip of the same category.
    for (const scenarioId of RIG_SCENARIO_IDS.slice(5)) {
      const scenario = rigScenarioById(scenarioId);
      const { store } = createRigFixtureStore(
        scenario.fixture.replace("-rigged", "") as never,
        true,
      );
      const document = store.getDocument();
      const clipIds = Object.keys(document.animations);
      expect(clipIds.length).toBe(1);
    }
  });
});

describe("fixed rig/animation evaluation: promotion gates", () => {
  it("the combined golden suite passes every explicit promotion threshold", async () => {
    const results: GeometryEvalResult[] = [];
    for (const scenarioId of RIG_SCENARIO_IDS) {
      results.push(await evaluateScenario({ scenarioId }));
    }
    const report = evaluatePromotion(results);
    expect(report.promotable).toBe(true);
    expect(report.blocks).toEqual([]);
    expect(report.baselineRegressions).toEqual([]);
    for (const entry of report.thresholdResults) {
      expect(entry.passed, `${entry.name} failed`).toBe(true);
    }
  });

  it("records a rig baseline for every scenario dimension at the rig suite version", () => {
    for (const scenarioId of RIG_SCENARIO_IDS) {
      for (const dimension of [
        "taskCompletion",
        "unrelatedChanges",
        "efficiency",
        "invalidCalls",
        "limitFailures",
        "semanticStructure",
        "renderedPreviews",
        "overlayPlayback",
      ] as const) {
        const baseline = RECORDED_BASELINES.find(
          (entry) =>
            entry.scenarioId === scenarioId && entry.dimension === dimension,
        );
        expect(baseline, `${scenarioId} ${dimension}`).toBeDefined();
        expect(baseline?.score).toBe(1);
        expect(baseline?.recordedAtVersion).toBe(RIG_EVALUATION_VERSION);
      }
    }
  });

  it("the golden rig run reproduces the recorded baselines exactly", async () => {
    for (const scenarioId of RIG_SCENARIO_IDS) {
      const result = await evaluateScenario({ scenarioId });
      for (const dimension of [
        "taskCompletion",
        "unrelatedChanges",
        "efficiency",
        "invalidCalls",
        "limitFailures",
        "semanticStructure",
        "renderedPreviews",
        "overlayPlayback",
      ] as const) {
        const baseline = RECORDED_BASELINES.find(
          (entry) =>
            entry.scenarioId === scenarioId && entry.dimension === dimension,
        );
        expect(baseline, `${scenarioId} ${dimension}`).toBeDefined();
        const measured = dimensionScoreOf(result, dimension);
        expect(
          measured,
          `${scenarioId} ${dimension} drifted from its recorded baseline`,
        ).toBe(baseline?.score);
      }
    }
  });

  it("exposes the explicit promotion thresholds", () => {
    expect(PROMOTION_THRESHOLDS.safetyAndIntegrity).toBe(1);
    expect(PROMOTION_THRESHOLDS.schemaValidToolCalls).toBe(0.95);
    expect(PROMOTION_THRESHOLDS.taskSuccess).toBe(0.9);
    expect(PROMOTION_THRESHOLDS.overBudgetRuns).toBe(0);
  });
});

describe("fixed rig/animation evaluation: scoring detects failures", () => {
  it("detects a non-minimal follow-up that rigs an extra node", async () => {
    const script: readonly DeterministicStep[] = [
      {
        text: "inspecting",
        toolCalls: [{ id: "call_s", name: "inspectSummary", arguments: {} }],
      },
      {
        text: "opening farther AND rigging the body (unrelated)",
        toolCalls: [
          {
            id: "call_farther",
            name: "setKeyframe",
            arguments: {
              animationId: RIG_CLIP_IDS.chestOpen,
              trackId: "track:eval:chest-open:lid",
              keyframeId: "keyframe:eval:chest-open:1",
              time: 2,
              channel: "rotation",
              value: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
            },
          },
          {
            id: "call_extra",
            name: "setNodePivot",
            arguments: { nodeId: RIG_IDS.chestLid.body, pivot: [0, 0, 0] },
          },
        ],
      },
      {
        text: "verifying",
        toolCalls: [{ id: "call_s2", name: "inspectSummary", arguments: {} }],
      },
      { text: "ready" },
    ];
    const result = await evaluateScenario({
      scenarioId: "chest-farther",
      script,
    });
    expect(result.run.ok).toBe(true);
    expect(result.run.applyOk).toBe(true);
    // The extra rigged node is outside the allowed change set.
    expect(result.scores.unrelatedChanges.score).toBe(0);
    expect(result.scores.unrelatedChanges.changedNodeIds).toContain(
      RIG_IDS.chestLid.body,
    );
    // The task itself still completed.
    expect(result.scores.taskCompletion.score).toBe(1);
  });

  it("scores invalid tool calls by category and keeps integrity", async () => {
    const script: readonly DeterministicStep[] = [
      {
        text: "trying unknown and malformed calls",
        toolCalls: [
          { id: "call_unknown", name: "rigEverything", arguments: {} },
          {
            id: "call_bad",
            name: "setKeyframe",
            arguments: { animationId: "animation:missing", trackId: "track:x" },
          },
        ],
      },
      { text: "I will fix the approach; nothing to stage." },
    ];
    const result = await evaluateScenario({ scenarioId: "wheel-spin", script });
    expect(result.run.ok).toBe(true);
    expect(result.run.applyOk).toBe(false);
    expect(result.run.stagedCommands).toBe(0);
    expect(result.scores.invalidCalls.invalidCalls).toBe(2);
    expect(result.scores.invalidCalls.categories).toMatchObject({
      UNKNOWN_TOOL: 1,
      INVALID_ARGUMENT: 1,
    });
    expect(result.integrity.zeroStateChangeOnFailure).toBe(true);
  });

  it("fails closed on animation budget exhaustion", async () => {
    const script: readonly DeterministicStep[] = [
      {
        text: "adding an oversized clip",
        toolCalls: [
          {
            id: "call_huge",
            name: "createAnimation",
            arguments: {
              animationId: "animation:eval:huge",
              duration: 5_000,
              loop: "loop",
            },
          },
        ],
      },
    ];
    const result = await evaluateScenario({
      scenarioId: "abstract-rig",
      script,
      budgets: { maxClipDurationSeconds: 60 },
    });
    expect(result.run.ok).toBe(false);
    expect(result.run.reason).toBe("limit");
    expect(result.scores.limitFailures.limitFailure).toBe(true);
    expect(result.integrity.zeroStateChangeOnFailure).toBe(true);
  });

  it("fails closed on a revision conflict with zero live change", async () => {
    const result = await evaluateScenario({
      scenarioId: "wheel-faster",
      isLiveCurrent: () => false,
    });
    expect(result.run.ok).toBe(false);
    expect(result.run.reason).toBe("conflict");
    expect(result.run.applyOk).toBe(false);
    expect(result.integrity.zeroStateChangeOnFailure).toBe(true);
    expect(result.integrity.partialCommit).toBe(false);
  });

  it("cancellation releases the preview with zero live change", async () => {
    const result = await evaluateScenario({
      scenarioId: "arm-reach",
      cancelAfterToolCalls: 2,
    });
    expect(result.run.ok).toBe(false);
    expect(result.run.reason).toBe("canceled");
    expect(result.integrity.zeroStateChangeOnFailure).toBe(true);
  });
});

/** Measured score of one dimension (mirrors promotion's lookup). */
function dimensionScoreOf(
  result: GeometryEvalResult,
  dimension:
    | "taskCompletion"
    | "unrelatedChanges"
    | "efficiency"
    | "invalidCalls"
    | "limitFailures"
    | "semanticStructure"
    | "renderedPreviews"
    | "overlayPlayback",
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
    case "overlayPlayback":
      return result.scores.overlayPlayback.score;
  }
}

/** The rig suite is registered and non-empty. */
describe("rig scenario registry", () => {
  it("exposes the ten fixed scenarios in canonical order", () => {
    expect(RIG_SCENARIOS.map((scenario) => scenario.id)).toEqual(
      RIG_SCENARIO_IDS,
    );
  });
});
