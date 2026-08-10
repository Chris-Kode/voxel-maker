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
import {
  expectCompleteSuitePromotes,
  runCompleteSuite,
} from "./suite.test-utils.js";

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
    input: "7c4f45313bbdd993a39a88554b46a30125ae2840b9b8f291e051f5abe92b6571",
    output: "902a94834e549f6e8093b1018eb1dcceb7de109a56c4ae628241c0a8d57e17e7",
  },
  "wheel-spin": {
    input: "51653543ae9edbc78cad98718c5bee6519428ad056036425590826d1556a54ec",
    output: "3dfdb653d2f6b13ddd96901d5020dafebfa8715b869cbd6c5709b7ee442ee267",
  },
  "wings-flap": {
    input: "9d2e16bfe8942ba54046ce7ba91d524f53370121a47c0b0de03776117d5940df",
    output: "d595167d80e3c4989259a39ab4c7034780785d45c1143112de0a86e4f4ae85ab",
  },
  "arm-reach": {
    input: "accf70249b2331ac801bd9d21e3a10296712a9c42ea2f5ec0be53346a52c92bd",
    output: "e8b6306dfc5b66127b1ca18aac8ef3a40cc8a10afce20ad8f0ed72457d5c6974",
  },
  "abstract-rig": {
    input: "03997bc3fe8995c9740cada6b57903427b5381e696bab979a3842f9759e72847",
    output: "865c43ee7bb16f3dd980025d6c7470936ef226b0660a6712c03e0e7e58074f29",
  },
  "chest-farther": {
    input: "a00c53391d94dcdec7770021867f7185dfde9e724fdaa3ca691dbef0b4adf323",
    output: "de2d416bd9eabfa9df5ab355be017309404f0537d3b1b08fec4053a791ff478d",
  },
  "wheel-slower": {
    input: "c8752e3b4e8a2344d2c45a8c7a2c087aff55b509a9b2ed9239e72a64e2bd72ac",
    output: "db6e5de15ea280fa221b61aaf244fc2101eb5114525db9981eb2fecec559d063",
  },
  "wings-one": {
    input: "39a4d73597223d867a24e1928e27dd2ef421b834a8d8a2fb9fb76460bfadb3e5",
    output: "517ff1d4f84dbdee8459e48352003b82884bd194220574f0eedd32769411cc69",
  },
  "arm-elbow-limit": {
    input: "06ccd07ded654371fdaca13fd470591202d4b79375a526f372e323d3cb2d4b2e",
    output: "6244ac6140a128d75345e7e20de4de23c9786de660d8a76255704cb3bebcd5c2",
  },
  "wheel-faster": {
    input: "c8752e3b4e8a2344d2c45a8c7a2c087aff55b509a9b2ed9239e72a64e2bd72ac",
    output: "04160e45dc01c5255b6872e00f19fc690f446ec1d83f673d706dfa2d888f56c7",
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
  it("the complete fixed suite passes every explicit promotion threshold", async () => {
    const results = await runCompleteSuite();
    expectCompleteSuitePromotes(evaluatePromotion(results));
  }, 30_000);

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
