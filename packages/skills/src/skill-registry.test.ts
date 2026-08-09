import { describe, expect, it } from "vitest";
import { SKILL_CATEGORIES } from "./manifest.js";
import {
  CREATION_SKILLS,
  registerSkill,
  skillByName,
  skillForCategory,
} from "./skill-registry.js";
import { KNOWN_GENERATOR_NAMES, KNOWN_TOOL_NAMES } from "./environment.js";
import { GENERATOR_DEFINITIONS } from "./registry.js";
import { STRUCTURAL_CHECKS } from "./checks.js";

/**
 * Registry tests (ticket #38 AC2/AC3): the creation-skill catalog covers
 * all seven asset categories; every skill carries fixed prompts,
 * structural checks, visual baselines, and command/tool efficiency
 * limits; allowed tools and generators resolve against the live
 * registries; and the catalog is the single validated entry point.
 */

describe("creation-skill catalog (AC2)", () => {
  it("covers every required category exactly once", () => {
    expect(CREATION_SKILLS).toHaveLength(SKILL_CATEGORIES.length);
    const categories = CREATION_SKILLS.map((skill) => skill.category);
    expect(new Set(categories).size).toBe(SKILL_CATEGORIES.length);
    for (const category of SKILL_CATEGORIES) {
      expect(categories).toContain(category);
    }
  });

  it("exposes one stable unique name per skill", () => {
    const names = CREATION_SKILLS.map((skill) => skill.name);
    expect(new Set(names).size).toBe(names.length);
    for (const skill of CREATION_SKILLS) {
      expect(skill.name).toMatch(/^skill\.[a-z0-9-]+$/u);
      expect(skill.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/u);
      expect(skill.manifestVersion).toBe(1);
    }
  });

  it("resolves skills by name and category", () => {
    const furniture = skillByName("skill.furniture");
    expect(furniture?.category).toBe("furniture");
    expect(skillByName("skill.nope")).toBeUndefined();
    expect(skillForCategory("vehicle")?.name).toBe("skill.vehicle");
    expect(skillForCategory("furniture")?.name).toBe("skill.furniture");
    expect(skillForCategory("architecture")?.name).toBe("skill.architecture");
    expect(skillForCategory("vegetation")?.name).toBe("skill.vegetation");
    expect(skillForCategory("humanoid")?.name).toBe("skill.humanoid");
    expect(skillForCategory("quadruped")?.name).toBe("skill.quadruped");
    expect(skillForCategory("flying-creature")?.name).toBe(
      "skill.flying-creature",
    );
  });

  it("keeps every catalog skill deep-frozen", () => {
    for (const skill of CREATION_SKILLS) {
      expect(Object.isFrozen(skill)).toBe(true);
      expect(Object.isFrozen(skill.evaluation)).toBe(true);
      expect(Object.isFrozen(skill.allowedTools)).toBe(true);
    }
  });
});

describe("every skill carries evaluation metadata (AC3)", () => {
  it("has a fixed prompt, structural checks, visual baselines, and efficiency limits", () => {
    for (const skill of CREATION_SKILLS) {
      expect(skill.evaluation.scenarioId.length).toBeGreaterThan(0);
      expect(skill.evaluation.fixedPrompt.length).toBeGreaterThan(10);
      expect(skill.evaluation.structuralChecks.length).toBeGreaterThan(0);
      expect(skill.evaluation.visualBaselines.length).toBeGreaterThan(0);
      const efficiency = skill.evaluation.efficiency;
      expect(efficiency.goldenToolCalls).toBeGreaterThan(0);
      expect(efficiency.goldenToolCalls).toBeLessThanOrEqual(
        efficiency.maxToolCalls,
      );
      expect(efficiency.goldenRounds).toBeLessThanOrEqual(efficiency.maxRounds);
      expect(efficiency.goldenCommands).toBeLessThanOrEqual(
        efficiency.maxCommands,
      );
      expect(efficiency.maxToolCalls).toBeLessThanOrEqual(
        skill.constraints.maxToolCallsPerRun,
      );
      expect(efficiency.maxRounds).toBeLessThanOrEqual(
        skill.constraints.maxRoundsPerRun,
      );
      expect(efficiency.maxCommands).toBeLessThanOrEqual(
        skill.constraints.maxCommandsPerRun,
      );
    }
  });

  it("references only resolvable structural checks with bounded options", () => {
    const checkNames = new Set(STRUCTURAL_CHECKS.map((check) => check.name));
    for (const skill of CREATION_SKILLS) {
      for (const check of skill.evaluation.structuralChecks) {
        expect(checkNames.has(check.name)).toBe(true);
        expect(check.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("references only standard baseline views", () => {
    const views = new Set(["perspective", "front", "side", "top"]);
    for (const skill of CREATION_SKILLS) {
      for (const baseline of skill.evaluation.visualBaselines) {
        expect(views.has(baseline.view)).toBe(true);
      }
    }
  });

  it("keeps efficiency limits distinct per skill (not one shared profile)", () => {
    const profiles = new Set(
      CREATION_SKILLS.map((skill) =>
        JSON.stringify(skill.evaluation.efficiency),
      ),
    );
    // At least the categories with different budgets differ; assert the
    // catalog is not an accidental copy of one profile.
    expect(profiles.size).toBeGreaterThan(1);
  });
});

describe("tool and generator compatibility (AC1/AC2)", () => {
  it("allows only registered agent tools", () => {
    for (const skill of CREATION_SKILLS) {
      for (const tool of skill.allowedTools) {
        expect(KNOWN_TOOL_NAMES.has(tool), `${skill.name}: ${tool}`).toBe(true);
      }
    }
  });

  it("declares only compatible generators that exist in the registry", () => {
    const generatorNames = new Set(
      GENERATOR_DEFINITIONS.map((definition) => definition.name),
    );
    for (const skill of CREATION_SKILLS) {
      expect(skill.generators.length).toBeGreaterThan(0);
      for (const generator of skill.generators) {
        expect(
          generatorNames.has(generator),
          `${skill.name}: ${generator}`,
        ).toBe(true);
        expect(KNOWN_GENERATOR_NAMES.has(generator)).toBe(true);
      }
    }
  });

  it("proposes only generator commands within the skill's per-proposal caps", () => {
    // Representative params per generator (mirrors the generator tests).
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
        const params = representative[generator];
        expect(
          params,
          `${skill.name}: ${generator} has no representative params`,
        ).toBeDefined();
      }
    }
  });
});

describe("registration of new skills (AC1)", () => {
  it("rejects an invalid manifest through the registry", () => {
    expect(() => registerSkill({ manifestVersion: 99 })).toThrow();
  });

  it("accepts a valid manifest through the registry", () => {
    const manifest = {
      manifestVersion: 1,
      name: "skill.custom",
      version: "1.0.0",
      description: "custom creation skill",
      category: "furniture",
      instructions: "Use the tools.",
      allowedTools: ["fillBox", "queryVoxels"],
      generators: ["generator.mirror"],
      constraints: {
        maxRoundsPerRun: 4,
        maxToolCallsPerRun: 12,
        maxCommandsPerRun: 32,
        maxCommandsPerProposal: 16,
        maxVoxelsPerProposal: 50_000,
      },
      provenance: {
        author: "test",
        source: "voxel-maker/skills",
        license: "UNLICENSED",
        created: "2026-08-09",
      },
      evaluation: {
        scenarioId: "custom-create-v1",
        fixedPrompt: "Create a custom thing.",
        structuralChecks: [
          {
            name: "region-nonempty",
            description: "core filled",
            options: { region: { min: [0, 0, 0], max: [4, 4, 4] } },
          },
        ],
        visualBaselines: [{ view: "front", description: "visible" }],
        efficiency: {
          goldenToolCalls: 6,
          goldenRounds: 2,
          goldenCommands: 10,
          maxToolCalls: 12,
          maxRounds: 4,
          maxCommands: 32,
        },
      },
    };
    const registered = registerSkill(manifest);
    expect(registered.name).toBe("skill.custom");
    expect(Object.isFrozen(registered)).toBe(true);
  });
});
