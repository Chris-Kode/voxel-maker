import { describe, expect, it } from "vitest";
import { CREATION_SKILLS } from "./skill-registry.js";
import {
  baselinesPassed,
  evaluateVisualBaselines,
  type BaselineEvidence,
} from "./baselines.js";
import { checkEfficiency } from "./efficiency.js";
import { runStructuralChecks } from "./checks.js";
import { createGeneratorFixture, FIXTURE_IDS } from "./fixtures.js";
import { proposeGenerator } from "./registry.js";
import { createPreviewSession } from "@voxel-maker/agent";
import { fillBoxCommand } from "@voxel-maker/commands";
import { commandId, transactionId } from "@voxel-maker/shared";

/**
 * Evaluation-metadata execution tests (ticket #38 AC3): the fixed
 * structural checks, visual baselines, and efficiency limits every
 * skill ships are executable — checks run against real documents,
 * baselines decide pass/fail from rendered evidence, and efficiency
 * limits judge actual run counts.
 */

const CONTEXT = {
  volumeId: FIXTURE_IDS.volume,
  material: FIXTURE_IDS.material,
  seed: "evaluation-seed",
};

describe("visual baselines (AC3)", () => {
  it("passes when every view has evidence inside the fixed interval", () => {
    const skill = CREATION_SKILLS[0] as (typeof CREATION_SKILLS)[number];
    const evidence: BaselineEvidence = {
      silhouetteRatios: { perspective: 0.3, front: 0.2, side: 0.2 },
    };
    const results = evaluateVisualBaselines(
      skill.evaluation.visualBaselines,
      evidence,
    );
    expect(results).toHaveLength(skill.evaluation.visualBaselines.length);
    expect(baselinesPassed(results)).toBe(true);
    for (const result of results) {
      expect(result.passed).toBe(true);
      expect(result.ratio).toBeDefined();
    }
  });

  it("fails when a view lacks evidence or leaves the interval", () => {
    const skill = CREATION_SKILLS[0] as (typeof CREATION_SKILLS)[number];
    const missing = evaluateVisualBaselines(skill.evaluation.visualBaselines, {
      silhouetteRatios: { perspective: 0.3 },
    });
    expect(baselinesPassed(missing)).toBe(false);
    const missingResult = missing.find((result) => result.view === "front");
    expect(missingResult?.passed).toBe(false);
    expect(missingResult?.evidence).toContain("no silhouette evidence");

    const outOfRange = evaluateVisualBaselines(
      skill.evaluation.visualBaselines,
      { silhouetteRatios: { perspective: 0.3, front: 0.95, side: 0.2 } },
    );
    expect(baselinesPassed(outOfRange)).toBe(false);
  });

  it("treats the declared intervals as inclusive bounds", () => {
    const result = evaluateVisualBaselines(
      [
        {
          view: "front",
          description: "at the upper bound",
          minSilhouetteRatio: 0.5,
          maxSilhouetteRatio: 0.5,
        },
      ],
      { silhouetteRatios: { front: 0.5 } },
    );
    expect(result[0]?.passed).toBe(true);
  });
});

describe("efficiency limits (AC3)", () => {
  it("reports golden and absolute limit compliance per dimension", () => {
    const skill = CREATION_SKILLS[0] as (typeof CREATION_SKILLS)[number];
    const limits = skill.evaluation.efficiency;
    const clean = checkEfficiency(limits, {
      toolCalls: limits.goldenToolCalls,
      rounds: limits.goldenRounds,
      commands: limits.goldenCommands,
    });
    expect(clean.withinGolden).toBe(true);
    expect(clean.withinLimits).toBe(true);

    const atMax = checkEfficiency(limits, {
      toolCalls: limits.maxToolCalls,
      rounds: limits.maxRounds,
      commands: limits.maxCommands,
    });
    expect(atMax.withinGolden).toBe(false);
    expect(atMax.withinLimits).toBe(true);

    const over = checkEfficiency(limits, {
      toolCalls: limits.maxToolCalls + 1,
      rounds: limits.maxRounds,
      commands: limits.maxCommands,
    });
    expect(over.withinLimits).toBe(false);
    const dimension = over.dimensions.find((d) => d.name === "toolCalls");
    expect(dimension?.withinLimit).toBe(false);
    expect(dimension?.actual).toBe(limits.maxToolCalls + 1);
  });

  it("every catalog skill allows a clean run under its goldens", () => {
    for (const skill of CREATION_SKILLS) {
      const limits = skill.evaluation.efficiency;
      const report = checkEfficiency(limits, {
        toolCalls: limits.goldenToolCalls,
        rounds: limits.goldenRounds,
        commands: limits.goldenCommands,
      });
      expect(report.withinGolden, skill.name).toBe(true);
      expect(report.withinLimits, skill.name).toBe(true);
    }
  });
});

describe("structural checks run against real documents (AC3)", () => {
  it("a catalog skill's checks pass on a plausible committed result", () => {
    // Build a small chair-like result: seat slab + four legs + backrest.
    const fixture = createGeneratorFixture();
    const commands = [
      fillBoxCommand(commandId("command:chair:seat"), {
        volumeId: FIXTURE_IDS.volume,
        region: { min: [1, 4, 1], max: [7, 6, 7] },
        material: FIXTURE_IDS.material,
      }),
      fillBoxCommand(commandId("command:chair:leg1"), {
        volumeId: FIXTURE_IDS.volume,
        region: { min: [1, 0, 1], max: [2, 4, 2] },
        material: FIXTURE_IDS.material,
      }),
      fillBoxCommand(commandId("command:chair:leg2"), {
        volumeId: FIXTURE_IDS.volume,
        region: { min: [6, 0, 1], max: [7, 4, 2] },
        material: FIXTURE_IDS.material,
      }),
      fillBoxCommand(commandId("command:chair:leg3"), {
        volumeId: FIXTURE_IDS.volume,
        region: { min: [1, 0, 6], max: [2, 4, 7] },
        material: FIXTURE_IDS.material,
      }),
      fillBoxCommand(commandId("command:chair:leg4"), {
        volumeId: FIXTURE_IDS.volume,
        region: { min: [6, 0, 6], max: [7, 4, 7] },
        material: FIXTURE_IDS.material,
      }),
      fillBoxCommand(commandId("command:chair:back"), {
        volumeId: FIXTURE_IDS.volume,
        region: { min: [1, 6, 1], max: [7, 10, 2] },
        material: FIXTURE_IDS.material,
      }),
    ];
    const result = fixture.bus.executeTransaction(commands, {
      transactionId: transactionId("transaction:chair:0001"),
      expectedRevision: 0,
      source: "ui",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const skill = CREATION_SKILLS[0] as (typeof CREATION_SKILLS)[number];
    const results = runStructuralChecks(
      skill.evaluation.structuralChecks,
      fixture.store,
      CONTEXT,
    );
    for (const check of results) {
      expect(check.passed, `${check.name}: ${check.evidence}`).toBe(true);
    }
  });

  it("an empty document fails a catalog skill's occupancy checks", () => {
    const fixture = createGeneratorFixture();
    const skill = CREATION_SKILLS[0] as (typeof CREATION_SKILLS)[number];
    const results = runStructuralChecks(
      skill.evaluation.structuralChecks,
      fixture.store,
      CONTEXT,
    );
    const occupancyChecks = results.filter(
      (check) => check.name !== "node-count-in-range",
    );
    for (const check of occupancyChecks) {
      expect(check.passed, check.name).toBe(false);
    }
    // The scaffold itself always has its nodes (structure, not content).
    const nodeCount = results.find(
      (check) => check.name === "node-count-in-range",
    );
    expect(nodeCount?.passed).toBe(true);
  });
});

describe("generator proposals stay within catalog skill caps (AC3)", () => {
  it("a representative proposal never exceeds any skill's per-proposal caps", () => {
    const fixture = createGeneratorFixture();
    const representative: Readonly<Record<string, unknown>> = {
      "generator.mirror": {
        region: { min: [0, 0, 0], max: [8, 8, 8] },
        axis: "x",
      },
      "generator.linearRepeat": {
        source: { min: [0, 0, 0], max: [2, 1, 1] },
        count: 3,
        delta: [0, 0, 4],
      },
      "generator.radialRepeat": {
        source: { min: [0, 0, 0], max: [2, 2, 2] },
        center: [10, 0, 10],
        axis: "y",
        count: 4,
        radius: 8,
      },
      "generator.stairs": {
        start: [0, 0, 0],
        count: 3,
        width: 4,
        depth: 2,
        stepHeight: 1,
        axis: "x",
      },
      "generator.wall": {
        min: [0, 0, 0],
        size: [10, 4, 1],
        opening: { min: [2, 0, 0], max: [4, 2, 1] },
      },
      "generator.roof": {
        min: [0, 5, 0],
        width: 6,
        depth: 4,
        style: "gable",
        thickness: 1,
      },
      "generator.branches": {
        base: [0, 0, 0],
        trunkHeight: 6,
        trunkSize: 2,
        levels: 2,
        branchLength: 4,
        branchSize: 1,
        rise: 3,
      },
      "generator.wheel": {
        center: [0, 0, 0],
        axis: "y",
        radius: 4,
        thickness: 2,
        hubRadius: 1,
        spokeCount: 4,
        spokeWidth: 1,
      },
      "generator.linkage": {
        start: [0, 0, 0],
        axis: "x",
        count: 5,
        segmentLength: 4,
        thickness: 2,
        pattern: "zigzag",
      },
    };
    for (const skill of CREATION_SKILLS) {
      for (const generator of skill.generators) {
        const proposal = proposeGenerator(
          generator,
          representative[generator],
          CONTEXT,
        );
        expect(
          proposal.commandCount,
          `${skill.name}/${generator}`,
        ).toBeLessThanOrEqual(skill.constraints.maxCommandsPerProposal);
        expect(
          proposal.voxelEstimate,
          `${skill.name}/${generator}`,
        ).toBeLessThanOrEqual(skill.constraints.maxVoxelsPerProposal);
        // Proposals stage through the generic preview registry seam.
        const preview = createPreviewSession({ live: fixture.store });
        const staged = preview.stageMany(proposal.commands);
        expect(staged.ok, `${skill.name}/${generator}`).toBe(true);
        preview.discard();
      }
    }
  });
});
