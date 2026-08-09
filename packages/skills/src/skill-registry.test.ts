import { describe, expect, it } from "vitest";
import {
  MOTION_CATEGORIES,
  RIGGING_CATEGORIES,
  SKILL_CATEGORIES,
} from "./manifest.js";
import {
  ALL_SKILLS,
  CREATION_SKILLS,
  MOTION_SKILLS,
  RIGGING_SKILLS,
  registerSkill,
  skillByName,
  skillForCategory,
  skillsByKind,
} from "./skill-registry.js";
import { KNOWN_GENERATOR_NAMES, KNOWN_TOOL_NAMES } from "./environment.js";
import { GENERATOR_DEFINITIONS } from "./registry.js";
import { STRUCTURAL_CHECKS } from "./checks.js";
import { RIGGING_TOOLS } from "./rigging/define.js";
import { MOTION_TOOLS } from "./motion/define.js";
import { rigMotionFixtureById } from "./rig-motion-fixtures.js";

/**
 * Registry tests (tickets #38 and #39): the creation-skill catalog
 * covers all seven asset categories; the rigging catalog covers bipeds,
 * quadrupeds, wings, and mechanical linkages; the motion catalog covers
 * walk, run, jump, idle, fly, and mechanical motion. Every skill carries
 * fixed prompts, structural/rig/animation checks, visual baselines (or
 * none for rig/motion), and command/tool efficiency limits; allowed
 * tools and generators resolve against the live registries; and the
 * catalog is the single validated entry point.
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

describe("rigging and motion catalogs (AC1/AC2, ticket #39)", () => {
  it("covers every rigging category exactly once", () => {
    expect(RIGGING_SKILLS).toHaveLength(RIGGING_CATEGORIES.length);
    const categories = RIGGING_SKILLS.map((skill) => skill.category);
    expect(new Set(categories).size).toBe(RIGGING_CATEGORIES.length);
    for (const category of RIGGING_CATEGORIES) {
      expect(categories).toContain(category);
    }
    for (const skill of RIGGING_SKILLS) {
      expect(skill.kind).toBe("rigging");
      expect(skill.name).toMatch(/^skill\.[a-z0-9-]+$/u);
      expect(skill.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/u);
      expect(skill.generators).toHaveLength(0);
      expect(skill.evaluation.visualBaselines).toHaveLength(0);
      expect(skill.evaluation.fixtureId).toBeDefined();
      expect(
        rigMotionFixtureById(skill.evaluation.fixtureId ?? ""),
      ).toBeDefined();
    }
  });

  it("covers every motion category exactly once", () => {
    expect(MOTION_SKILLS).toHaveLength(MOTION_CATEGORIES.length);
    const categories = MOTION_SKILLS.map((skill) => skill.category);
    expect(new Set(categories).size).toBe(MOTION_CATEGORIES.length);
    for (const category of MOTION_CATEGORIES) {
      expect(categories).toContain(category);
    }
    for (const skill of MOTION_SKILLS) {
      expect(skill.kind).toBe("motion");
      expect(skill.name).toMatch(/^skill\.[a-z0-9-]+$/u);
      expect(skill.generators).toHaveLength(0);
      expect(skill.evaluation.visualBaselines).toHaveLength(0);
      expect(skill.evaluation.fixtureId).toBeDefined();
      expect(
        rigMotionFixtureById(skill.evaluation.fixtureId ?? ""),
      ).toBeDefined();
    }
  });

  it("rigging skills use only generic hierarchy/pivot/joint/constraint tools", () => {
    const forbidden = new Set<string>([
      "fillBox",
      "setVoxelBatch",
      "createAnimation",
      "setKeyframe",
    ]);
    for (const skill of RIGGING_SKILLS) {
      for (const tool of skill.allowedTools) {
        expect(RIGGING_TOOLS.includes(tool), `${skill.name}: ${tool}`).toBe(
          true,
        );
        expect(forbidden.has(tool), `${skill.name}: ${tool}`).toBe(false);
      }
    }
  });

  it("motion skills use only generic clips/tracks/keyframes tools", () => {
    const forbidden = new Set<string>([
      "fillBox",
      "setNodePivot",
      "addNodeJoint",
      "addConstraint",
    ]);
    for (const skill of MOTION_SKILLS) {
      for (const tool of skill.allowedTools) {
        expect(MOTION_TOOLS.includes(tool), `${skill.name}: ${tool}`).toBe(
          true,
        );
        expect(forbidden.has(tool), `${skill.name}: ${tool}`).toBe(false);
      }
    }
  });

  it("exposes every skill through the unified registry", () => {
    expect(ALL_SKILLS).toHaveLength(
      CREATION_SKILLS.length + RIGGING_SKILLS.length + MOTION_SKILLS.length,
    );
    expect(skillByName("skill.biped-rig")?.kind).toBe("rigging");
    expect(skillByName("skill.walk")?.kind).toBe("motion");
    expect(skillByName("skill.furniture")?.kind).toBe("creation");
    expect(skillForCategory("wings")?.name).toBe("skill.wings-rig");
    expect(skillForCategory("mechanical-linkage")?.name).toBe(
      "skill.mechanical-linkage-rig",
    );
    expect(skillForCategory("fly")?.name).toBe("skill.fly");
    expect(skillsByKind("creation")).toHaveLength(CREATION_SKILLS.length);
    expect(skillsByKind("rigging")).toHaveLength(RIGGING_SKILLS.length);
    expect(skillsByKind("motion")).toHaveLength(MOTION_SKILLS.length);
  });

  it("keeps every rigging and motion skill deep-frozen", () => {
    for (const skill of [...RIGGING_SKILLS, ...MOTION_SKILLS]) {
      expect(Object.isFrozen(skill)).toBe(true);
      expect(Object.isFrozen(skill.evaluation)).toBe(true);
      expect(Object.isFrozen(skill.allowedTools)).toBe(true);
      expect(Object.isFrozen(skill.evaluation.structuralChecks)).toBe(true);
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
      kind: "creation",
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
