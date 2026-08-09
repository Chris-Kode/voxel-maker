import { describe, expect, it } from "vitest";
import type { DeterministicStep } from "@voxel-maker/agent";
import {
  evaluateScenario,
  type GeometryEvalResult,
} from "./harness.js";
import {
  evaluatePromotion,
  PROMOTION_THRESHOLDS,
  RECORDED_BASELINES,
} from "./promotion.js";
import {
  GEOMETRY_SCENARIOS,
  scenarioById,
  type ScenarioId,
} from "./scenarios.js";
import {
  EVALUATION_VERSION,
  PROVIDER_VERSION,
  SYSTEM_PROMPT_VERSION,
} from "./versions.js";
import { redPixelRatio } from "./previews.js";
import { EVAL_RED_COLOR } from "./fixtures.js";

/**
 * Fixed geometry evaluation suite (plan S12.12/S12.13, ticket #35 AC):
 * the four fixed scenarios (chair creation, shorter legs, red seat,
 * left-side mirroring) run from deterministic starting documents and
 * selections through recorded golden traces, are scored on all seven
 * dimensions with all versions recorded, and must pass the explicit
 * promotion thresholds. Adversarial recorded traces (invalid calls,
 * over-budget, sloppy minimal diff, revision conflict) verify that the
 * scoring and integrity evidence detect failures instead of only
 * celebrating golden runs.
 */

const SCENARIO_IDS: readonly ScenarioId[] = [
  "chair-create",
  "shorter-legs",
  "red-seat",
  "mirror-left",
];

describe("fixed geometry evaluation: golden scenarios", () => {
  it.each(SCENARIO_IDS)(
    "%s: golden trace approves, applies, and scores 1.0 on every dimension",
    async (scenarioId) => {
      const scenario = scenarioById(scenarioId);
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
      expect(result.scores.unrelatedChanges.nodeScore).toBe(1);
      expect(result.scores.efficiency.score).toBe(1);
      expect(result.scores.invalidCalls.score).toBe(1);
      expect(result.scores.invalidCalls.invalidCalls).toBe(0);
      expect(result.scores.limitFailures.limitFailure).toBe(false);
      expect(result.scores.semanticStructure.score).toBe(1);
      expect(result.scores.semanticStructure.issues).toEqual([]);
      expect(result.scores.renderedPreviews.score).toBe(1);
      expect(result.scores.renderedPreviews.failures).toEqual([]);
      // Integrity: exactly one live revision transition via Apply, one
      // labeled history entry, no partial commit.
      expect(result.integrity.partialCommit).toBe(false);
      expect(result.integrity.revisionAfter).toBe(
        result.integrity.revisionBefore + 1,
      );
      expect(result.integrity.historyAfter).toBe(
        result.integrity.historyBefore + 1,
      );
      expect(result.run.applyLabel).toBe(`AI eval: ${scenario.name}`);
      // Rendered preview evidence: all four standard views completed.
      expect(result.previews.before.completed).toBe(true);
      expect(result.previews.after.completed).toBe(true);
      if (scenarioId !== "chair-create") {
        // Follow-up scenarios start from a populated chair document.
        expect(result.previews.before.silhouettePixels).toBeGreaterThan(0);
      } else {
        // The create scenario starts from the empty scaffold.
        expect(result.previews.before.silhouettePixels).toBe(0);
      }
      expect(result.previews.after.silhouettePixels).toBeGreaterThan(0);
      // Input and output hashes are recorded and differ.
      expect(result.hashes.input).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.hashes.output).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.hashes.output).not.toBe(result.hashes.input);
    },
  );

  it("records provider, model, prompt, tool-schema, fixture, and budget versions", async () => {
    for (const scenarioId of SCENARIO_IDS) {
      const result = await evaluateScenario({ scenarioId });
      const versions = result.versions;
      expect(versions.evaluation).toBe(EVALUATION_VERSION);
      expect(versions.provider.id).toBe("deterministic");
      expect(versions.provider.version).toBe(PROVIDER_VERSION);
      expect(versions.provider.model).toBe("deterministic-model");
      expect(versions.prompt.systemVersion).toBe(SYSTEM_PROMPT_VERSION);
      expect(versions.prompt.scenarioVersion).toMatch(/^[0-9a-f]{16}$/u);
      expect(versions.toolSchema.inspection).toBeGreaterThan(0);
      expect(versions.toolSchema.mutation).toBeGreaterThan(0);
      expect(versions.fixture.version).toBe("v1");
      expect(versions.fixture.inputDocumentHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(versions.budget.version).toBe("agent-budgets-default-v1");
      expect(versions.budget.hash).toMatch(/^[0-9a-f]{16}$/u);
    }
  });

  it("is fully deterministic: repeated runs produce identical hashes and evidence", async () => {
    const first = await evaluateScenario({ scenarioId: "red-seat" });
    const second = await evaluateScenario({ scenarioId: "red-seat" });
    expect(second.hashes.input).toBe(first.hashes.input);
    expect(second.hashes.output).toBe(first.hashes.output);
    expect(second.versions.fixture.inputDocumentHash).toBe(
      first.versions.fixture.inputDocumentHash,
    );
    expect(second.scores).toEqual(first.scores);
    for (const view of Object.keys(first.previews.before.views)) {
      const key = view as keyof typeof first.previews.before.views;
      expect(second.previews.before.views[key].pixelHash).toBe(
        first.previews.before.views[key].pixelHash,
      );
      expect(second.previews.after.views[key].pixelHash).toBe(
        first.previews.after.views[key].pixelHash,
      );
    }
  });

  it("records red rendered pixels and #ff0000 material evidence for the red seat", async () => {
    const result = await evaluateScenario({ scenarioId: "red-seat" });
    // Task evidence: the red material exists, the seat uses it, and the
    // legs/backrest keep the wood material.
    expect(result.scores.taskCompletion.score).toBe(1);
    // Rendered evidence: at least one standard view contains red pixels
    // after the edit (top view shows the seat top face lit to > 200 red).
    const views = result.previews.after.views;
    const redView = Object.values(views).find(
      (view) => redPixelRatio(view.rgba) > 0,
    );
    expect(redView, "no rendered view contains red pixels").toBeDefined();
    // The before render must not contain red pixels (wood is not red).
    const redBefore = Object.values(result.previews.before.views).some(
      (view) => redPixelRatio(view.rgba) > 0,
    );
    expect(redBefore).toBe(false);
  });
});

describe("fixed geometry evaluation: promotion gates", () => {
  it("the golden suite passes every explicit promotion threshold", async () => {
    const results: GeometryEvalResult[] = [];
    for (const scenarioId of SCENARIO_IDS) {
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

  it("records a baseline for every scenario dimension at the suite version", () => {
    for (const scenarioId of SCENARIO_IDS) {
      for (const dimension of [
        "taskCompletion",
        "unrelatedChanges",
        "efficiency",
        "invalidCalls",
        "limitFailures",
        "semanticStructure",
        "renderedPreviews",
      ] as const) {
        const baseline = RECORDED_BASELINES.find(
          (entry) =>
            entry.scenarioId === scenarioId &&
            entry.dimension === dimension,
        );
        expect(baseline, `${scenarioId} ${dimension}`).toBeDefined();
        expect(baseline?.score).toBe(1);
        expect(baseline?.recordedAtVersion).toBe("geometry-eval-v1");
      }
    }
  });

  it("exposes the explicit thresholds of plan 12.3", () => {
    expect(PROMOTION_THRESHOLDS.safetyAndIntegrity).toBe(1);
    expect(PROMOTION_THRESHOLDS.schemaValidToolCalls).toBe(0.95);
    expect(PROMOTION_THRESHOLDS.taskSuccess).toBe(0.9);
    expect(PROMOTION_THRESHOLDS.overBudgetRuns).toBe(0);
    expect(PROMOTION_THRESHOLDS.minimalDiff.unrelatedChangesFloor).toBe(0.95);
    expect(PROMOTION_THRESHOLDS.minimalDiff.efficiencyFloor).toBe(0.9);
  });
});

describe("fixed geometry evaluation: scoring detects failures", () => {
  it("scores invalid tool calls by category and still guarantees integrity", async () => {
    const script: readonly DeterministicStep[] = [
      {
        text: "trying an unknown tool",
        toolCalls: [
          { id: "call_unknown", name: "deleteEverything", arguments: {} },
        ],
      },
      {
        text: "trying malformed arguments",
        toolCalls: [
          {
            id: "call_bad",
            name: "inspectSummary",
            arguments: { includeSelection: "yes" },
          },
        ],
      },
      { text: "I understand; nothing to change." },
    ];
    const result = await evaluateScenario({ scenarioId: "red-seat", script });
    // The run itself still approves (recovery), but stages nothing; the
    // empty proposal has nothing to apply, so Apply reports NOTHING_TO_APPLY
    // and the live store must stay untouched.
    expect(result.run.ok).toBe(true);
    expect(result.run.applyOk).toBe(false);
    expect(result.run.stagedCommands).toBe(0);
    expect(result.scores.invalidCalls.invalidCalls).toBe(2);
    expect(result.scores.invalidCalls.totalCalls).toBe(2);
    expect(result.scores.invalidCalls.categories).toMatchObject({
      UNKNOWN_TOOL: 1,
      INVALID_ARGUMENT: 1,
    });
    expect(result.scores.invalidCalls.score).toBeLessThan(1);
    // The untouched document keeps its invariant checks (wood materials
    // intact, occupancy unchanged) but fails the red-material checks.
    expect(result.scores.taskCompletion.score).toBeLessThan(1);
    expect(
      result.scores.taskCompletion.failures.some((failure) =>
        failure.includes("red material"),
      ),
    ).toBe(true);
    // Zero live changes (the apply was rejected with nothing staged).
    expect(result.integrity.partialCommit).toBe(false);
    expect(result.integrity.revisionAfter).toBe(
      result.integrity.revisionBefore,
    );
    expect(result.integrity.zeroStateChangeOnFailure).toBe(true);
    const report = evaluatePromotion([result]);
    expect(report.promotable).toBe(false);
    expect(
      report.blocks.some((block) => block.includes("schema-valid tool call")),
    ).toBe(true);
    expect(report.blocks.some((block) => block.includes("not applied"))).toBe(
      true,
    );
  });

  it("records limit failures and leaves zero live state change", async () => {
    const script: readonly DeterministicStep[] = [
      {
        text: "exceeding the token budget",
        usage: { inputTokens: 200_000, outputTokens: 0 },
      },
    ];
    const result = await evaluateScenario({
      scenarioId: "shorter-legs",
      script,
    });
    expect(result.run.ok).toBe(false);
    expect(result.run.reason).toBe("limit");
    expect(result.scores.limitFailures.limitFailure).toBe(true);
    expect(result.scores.limitFailures.score).toBe(0);
    expect(result.integrity.partialCommit).toBe(false);
    expect(result.integrity.revisionAfter).toBe(
      result.integrity.revisionBefore,
    );
    expect(result.integrity.zeroStateChangeOnFailure).toBe(true);
    const report = evaluatePromotion([result]);
    expect(report.promotable).toBe(false);
    expect(report.blocks.some((block) => block.includes("over-budget"))).toBe(
      true,
    );
  });

  it("detects unrelated changes and task failure in a sloppy minimal-diff edit", async () => {
    // Wrong approach: repaint the shared wood material red instead of
    // creating a dedicated red material for the seat only.
    const script: readonly DeterministicStep[] = [
      {
        text: "inspect",
        toolCalls: [
          { id: "call_summary", name: "inspectSummary", arguments: {} },
        ],
      },
      {
        text: "repaint the wood material",
        toolCalls: [
          {
            id: "call_update",
            name: "updateMaterial",
            arguments: { materialId: 1, color: EVAL_RED_COLOR },
          },
        ],
      },
      {
        text: "verify",
        toolCalls: [
          { id: "call_summary2", name: "inspectSummary", arguments: {} },
        ],
      },
      { text: "done" },
    ];
    const result = await evaluateScenario({ scenarioId: "red-seat", script });
    expect(result.run.ok).toBe(true);
    expect(result.run.applyOk).toBe(true);
    // Task failure: the seat is not painted with a dedicated red material
    // and the legs/backrest changed appearance.
    expect(result.scores.taskCompletion.score).toBeLessThan(1);
    expect(
      result.scores.taskCompletion.failures.some((failure) =>
        failure.includes("red material"),
      ),
    ).toBe(true);
    // Unrelated change: the shared wood material record was updated.
    expect(result.scores.unrelatedChanges.score).toBeLessThan(1);
    expect(
      result.scores.unrelatedChanges.materialChanges.some(
        (change) => change.materialId === "1" && change.kind === "updated",
      ),
    ).toBe(true);
    expect(result.scores.unrelatedChanges.unrelatedMaterialChanges).toBe(1);
    const report = evaluatePromotion([result]);
    expect(report.promotable).toBe(false);
  });

  it("records a revision-conflict run with zero live changes", async () => {
    const result = await evaluateScenario({
      scenarioId: "mirror-left",
      isLiveCurrent: () => false,
    });
    expect(result.run.ok).toBe(false);
    expect(result.run.reason).toBe("conflict");
    expect(result.integrity.partialCommit).toBe(false);
    expect(result.integrity.revisionAfter).toBe(
      result.integrity.revisionBefore,
    );
    const report = evaluatePromotion([result]);
    expect(report.promotable).toBe(false);
    expect(report.blocks.some((block) => block.includes("not applied"))).toBe(
      true,
    );
  });

  it("registers every scenario with a fixture, selection, and golden trace", () => {
    expect(GEOMETRY_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "chair-create",
      "shorter-legs",
      "red-seat",
      "mirror-left",
    ]);
    for (const scenario of GEOMETRY_SCENARIOS) {
      expect(scenario.prompt.length).toBeGreaterThan(0);
      expect(scenario.goldenTrace.length).toBeGreaterThan(0);
      expect(scenario.taskChecks.length).toBeGreaterThan(0);
      expect(scenario.previewSignals.length).toBeGreaterThan(0);
      expect(scenario.goldenRounds).toBe(scenario.goldenTrace.length);
    }
  });
});
