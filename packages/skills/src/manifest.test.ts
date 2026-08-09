import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  INVALID_SKILL_MANIFEST_CODE,
  SKILL_CATEGORY_CODE,
  SKILL_KIND_CODE,
  SKILL_CONSTRAINTS_CODE,
  SKILL_DESCRIPTION_CODE,
  SKILL_EVALUATION_CODE,
  SKILL_GENERATOR_CODE,
  SKILL_INSTRUCTIONS_CODE,
  SKILL_MANIFEST_VERSION_CODE,
  SKILL_NAME_CODE,
  SKILL_PROVENANCE_CODE,
  SKILL_TOOLS_CODE,
  SKILL_VERSION_CODE,
  SKILL_MANIFEST_VERSION,
  validateSkillManifest,
} from "./manifest.js";
import {
  KNOWN_GENERATOR_NAMES,
  KNOWN_TOOL_NAMES,
  SKILL_ENVIRONMENT,
} from "./environment.js";

/**
 * Manifest validation tests (ticket #38 AC1): the registry validates
 * manifest version, instructions, allowed tools, constraints, generator
 * compatibility, provenance, and evaluation metadata, each with its own
 * stable error code. A valid manifest passes and comes back deep-frozen;
 * every invalid dimension is rejected without a partial manifest.
 */

/**
 * Mutable JSON-safe shape of a manifest used to author valid and
 * mutated fixtures (the validated manifest itself is immutable).
 */
interface MutableManifest {
  manifestVersion: number;
  name: string;
  version: string;
  description: string;
  kind: string;
  category: string;
  instructions: string;
  allowedTools: string[];
  generators: string[];
  constraints: {
    maxRoundsPerRun: number;
    maxToolCallsPerRun: number;
    maxCommandsPerRun: number;
    maxCommandsPerProposal: number;
    maxVoxelsPerProposal: number;
  };
  provenance: {
    author: string;
    source: string;
    license: string;
    created: string;
  };
  evaluation: {
    scenarioId: string;
    fixtureId?: string;
    fixedPrompt: string;
    structuralChecks: { name: string; description: string; options: unknown }[];
    visualBaselines: {
      view: string;
      description: string;
      minSilhouetteRatio?: number;
      maxSilhouetteRatio?: number;
    }[];
    efficiency: {
      goldenToolCalls: number;
      goldenRounds: number;
      goldenCommands: number;
      maxToolCalls: number;
      maxRounds: number;
      maxCommands: number;
    };
  };
}

function validManifest(): MutableManifest {
  return {
    manifestVersion: SKILL_MANIFEST_VERSION,
    name: "skill.test",
    version: "1.0.0",
    description: "test skill",
    kind: "creation",
    category: "furniture",
    instructions: "Build the thing with the allowed tools.",
    allowedTools: [...KNOWN_TOOL_NAMES].slice(0, 4),
    generators: [...KNOWN_GENERATOR_NAMES].slice(0, 2),
    constraints: {
      maxRoundsPerRun: 8,
      maxToolCallsPerRun: 24,
      maxCommandsPerRun: 64,
      maxCommandsPerProposal: 32,
      maxVoxelsPerProposal: 100_000,
    },
    provenance: {
      author: "test",
      source: "voxel-maker/skills",
      license: "UNLICENSED",
      created: "2026-08-09",
    },
    evaluation: {
      scenarioId: "test-create-v1",
      fixedPrompt: "Create a test thing.",
      structuralChecks: [
        {
          name: "occupied-voxel-count-in-range",
          description: "non-trivial object",
          options: {
            region: { min: [0, 0, 0], max: [16, 16, 16] },
            min: 10,
            max: 10_000,
          },
        },
        {
          name: "region-nonempty",
          description: "core region filled",
          options: { region: { min: [0, 0, 0], max: [4, 4, 4] } },
        },
      ],
      visualBaselines: [
        {
          view: "perspective",
          description: "visible",
          minSilhouetteRatio: 0.02,
          maxSilhouetteRatio: 0.9,
        },
      ],
      efficiency: {
        goldenToolCalls: 12,
        goldenRounds: 4,
        goldenCommands: 20,
        maxToolCalls: 24,
        maxRounds: 8,
        maxCommands: 64,
      },
    },
  };
}

function expectCode(value: unknown, code: string): WorkspaceError {
  let caught: unknown;
  try {
    validateSkillManifest(value, SKILL_ENVIRONMENT);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkspaceError);
  const error = caught as WorkspaceError;
  expect(error.code).toBe(code);
  return error;
}

describe("valid manifests (AC1)", () => {
  it("accepts a fully specified manifest and deep-freezes it", () => {
    const manifest = validateSkillManifest(validManifest(), SKILL_ENVIRONMENT);
    expect(manifest.name).toBe("skill.test");
    expect(manifest.manifestVersion).toBe(SKILL_MANIFEST_VERSION);
    expect(manifest.allowedTools.length).toBeGreaterThan(0);
    expect(manifest.generators.length).toBeGreaterThan(0);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.evaluation)).toBe(true);
    expect(Object.isFrozen(manifest.evaluation.structuralChecks)).toBe(true);
    expect(Object.isFrozen(manifest.allowedTools)).toBe(true);
    // Mutating the validated manifest must fail (frozen).
    expect(() => {
      (manifest as { name: string }).name = "skill.hacked";
    }).toThrow();
  });

  it("deep-freezes structural-check options (fixed checks, AC3)", () => {
    const manifest = validateSkillManifest(validManifest(), SKILL_ENVIRONMENT);
    const check = manifest.evaluation.structuralChecks[0] as {
      readonly options: { readonly region?: object; readonly min?: number };
    };
    expect(Object.isFrozen(check.options)).toBe(true);
    const options = check.options as { region?: object; min?: number };
    expect(Object.isFrozen(options.region)).toBe(true);
    // Mutating a nested option value must fail.
    expect(() => {
      (check.options as { min: number }).min = 999;
    }).toThrow();
    expect(() => {
      (options.region as { min: number[] }).min[0] = 999;
    }).toThrow();
  });

  it("accepts baseline ratio defaults (unbounded sides)", () => {
    const manifest = validManifest();
    manifest.evaluation.visualBaselines = [
      { view: "top", description: "footprint visible" },
    ];
    const validated = validateSkillManifest(manifest, SKILL_ENVIRONMENT);
    expect(
      validated.evaluation.visualBaselines[0]?.minSilhouetteRatio,
    ).toBeUndefined();
    expect(
      validated.evaluation.visualBaselines[0]?.maxSilhouetteRatio,
    ).toBeUndefined();
  });
});

describe("manifest version and shape (AC1)", () => {
  it("rejects a non-object manifest", () => {
    expectCode("nope", INVALID_SKILL_MANIFEST_CODE);
    expectCode(null, INVALID_SKILL_MANIFEST_CODE);
    expectCode([], INVALID_SKILL_MANIFEST_CODE);
  });

  it("rejects an unsupported manifest version", () => {
    const manifest = validManifest();
    manifest.manifestVersion = 2;
    expectCode(manifest, SKILL_MANIFEST_VERSION_CODE);
  });

  it("rejects invalid names and versions", () => {
    const badName = validManifest();
    badName.name = "Furniture";
    expectCode(badName, SKILL_NAME_CODE);
    const badVersion = validManifest();
    badVersion.version = "1.0";
    expectCode(badVersion, SKILL_VERSION_CODE);
    const badCategory = validManifest();
    badCategory.category = "robot";
    expectCode(badCategory, SKILL_CATEGORY_CODE);
    const badDescription = validManifest();
    badDescription.description = "";
    expectCode(badDescription, SKILL_DESCRIPTION_CODE);
  });
});

describe("skill kind and category (AC1, ticket #39)", () => {
  it("rejects an unknown skill kind", () => {
    const manifest = validManifest();
    manifest.kind = "baking";
    expectCode(manifest, SKILL_KIND_CODE);
  });

  it("rejects a category outside the kind's category set", () => {
    const manifest = validManifest();
    manifest.kind = "rigging";
    manifest.category = "furniture";
    expectCode(manifest, SKILL_CATEGORY_CODE);
  });

  it("accepts a rigging skill with a rigging category", () => {
    const manifest = validManifest();
    manifest.kind = "rigging";
    manifest.category = "wings";
    manifest.generators = [];
    manifest.evaluation.fixtureId = "rig-wings";
    manifest.evaluation.visualBaselines = [];
    manifest.evaluation.structuralChecks = [
      {
        name: "pivot-count-in-range",
        description: "pivots",
        options: { min: 1, max: 4 },
      },
    ];
    const registered = validateSkillManifest(manifest, SKILL_ENVIRONMENT);
    expect(registered.kind).toBe("rigging");
    expect(registered.category).toBe("wings");
    expect(registered.evaluation.fixtureId).toBe("rig-wings");
  });

  it("accepts a motion skill with a motion category", () => {
    const manifest = validManifest();
    manifest.kind = "motion";
    manifest.category = "walk";
    manifest.generators = [];
    manifest.evaluation.fixtureId = "motion-walk";
    manifest.evaluation.visualBaselines = [];
    manifest.evaluation.structuralChecks = [
      {
        name: "animation-count-in-range",
        description: "one clip",
        options: { min: 1, max: 2 },
      },
    ];
    const registered = validateSkillManifest(manifest, SKILL_ENVIRONMENT);
    expect(registered.kind).toBe("motion");
    expect(registered.category).toBe("walk");
  });

  it("requires a fixture id for rigging and motion skills", () => {
    const manifest = validManifest();
    manifest.kind = "motion";
    manifest.category = "idle";
    manifest.generators = [];
    manifest.evaluation.visualBaselines = [];
    expectCode(manifest, SKILL_EVALUATION_CODE);
  });

  it("rejects generators and visual baselines on rigging and motion skills", () => {
    const manifest = validManifest();
    manifest.kind = "rigging";
    manifest.category = "biped";
    manifest.evaluation.fixtureId = "rig-biped";
    manifest.evaluation.visualBaselines = [];
    expectCode(manifest, SKILL_GENERATOR_CODE);

    const withBaselines = validManifest();
    withBaselines.kind = "motion";
    withBaselines.category = "run";
    withBaselines.generators = [];
    withBaselines.evaluation.fixtureId = "motion-run";
    withBaselines.evaluation.visualBaselines = [
      { view: "front", description: "visible" },
    ];
    expectCode(withBaselines, SKILL_EVALUATION_CODE);
  });
});

describe("instructions (AC1)", () => {
  it("rejects empty or oversized instructions", () => {
    const empty = validManifest();
    empty.instructions = "";
    expectCode(empty, SKILL_INSTRUCTIONS_CODE);
    const huge = validManifest();
    huge.instructions = "x".repeat(20_000);
    expectCode(huge, SKILL_INSTRUCTIONS_CODE);
  });
});

describe("allowed tools (AC1)", () => {
  it("rejects unknown tools", () => {
    const manifest = validManifest();
    manifest.allowedTools = ["fillBox", "inspectNothing"];
    expectCode(manifest, SKILL_TOOLS_CODE);
  });

  it("rejects empty or duplicate tool lists", () => {
    const empty = validManifest();
    empty.allowedTools = [];
    expectCode(empty, SKILL_TOOLS_CODE);
    const duplicate = validManifest();
    duplicate.allowedTools = ["fillBox", "fillBox"];
    expectCode(duplicate, SKILL_TOOLS_CODE);
  });
});

describe("constraints (AC1)", () => {
  it("rejects zero, non-integer, and over-cap constraints", () => {
    const zero = validManifest();
    zero.constraints.maxToolCallsPerRun = 0;
    expectCode(zero, SKILL_CONSTRAINTS_CODE);
    const fractional = validManifest();
    fractional.constraints.maxCommandsPerRun = 12.5;
    expectCode(fractional, SKILL_CONSTRAINTS_CODE);
    const overCap = validManifest();
    overCap.constraints.maxToolCallsPerRun = 100; // agent budget cap is 64
    expectCode(overCap, SKILL_CONSTRAINTS_CODE);
  });
});

describe("generator compatibility (AC1)", () => {
  it("rejects unknown generators", () => {
    const manifest = validManifest();
    manifest.generators = ["generator.mirror", "generator.teleport"];
    expectCode(manifest, SKILL_GENERATOR_CODE);
  });

  it("rejects an empty generator list", () => {
    const manifest = validManifest();
    manifest.generators = [];
    expectCode(manifest, SKILL_GENERATOR_CODE);
  });
});

describe("provenance (AC1)", () => {
  it("rejects missing provenance fields and malformed dates", () => {
    const missingAuthor = validManifest();
    missingAuthor.provenance = {
      author: "",
      source: "s",
      license: "l",
      created: "2026-08-09",
    };
    expectCode(missingAuthor, SKILL_PROVENANCE_CODE);
    const badDate = validManifest();
    badDate.provenance = {
      author: "a",
      source: "s",
      license: "l",
      created: "yesterday",
    };
    expectCode(badDate, SKILL_PROVENANCE_CODE);
  });
});

describe("evaluation metadata (AC1)", () => {
  it("rejects an empty fixed prompt", () => {
    const manifest = validManifest();
    manifest.evaluation.fixedPrompt = "";
    expectCode(manifest, SKILL_EVALUATION_CODE);
  });

  it("rejects unknown structural checks and invalid check options", () => {
    const unknownCheck = validManifest();
    unknownCheck.evaluation.structuralChecks = [
      { name: "has-wings", description: "d", options: {} },
    ];
    expectCode(unknownCheck, SKILL_EVALUATION_CODE);
    const badOptions = validManifest();
    badOptions.evaluation.structuralChecks = [
      {
        name: "occupied-voxel-count-in-range",
        description: "d",
        options: { region: { min: [0, 0, 0], max: [16, 16, 16] } }, // min/max missing
      },
    ];
    expectCode(badOptions, SKILL_EVALUATION_CODE);
  });

  it("rejects unbounded scan regions", () => {
    const manifest = validManifest();
    manifest.evaluation.structuralChecks = [
      {
        name: "occupied-voxel-count-in-range",
        description: "d",
        options: {
          region: { min: [0, 0, 0], max: [2_048, 2_048, 2_048] }, // 8.6B voxels
          min: 0,
          max: 100,
        },
      },
    ];
    expectCode(manifest, SKILL_EVALUATION_CODE);
  });

  it("rejects unknown or duplicate baseline views", () => {
    const unknownView = validManifest();
    unknownView.evaluation.visualBaselines = [
      { view: "bird", description: "d" },
    ];
    expectCode(unknownView, SKILL_EVALUATION_CODE);
    const duplicateView = validManifest();
    duplicateView.evaluation.visualBaselines = [
      { view: "front", description: "d1" },
      { view: "front", description: "d2" },
    ];
    expectCode(duplicateView, SKILL_EVALUATION_CODE);
  });

  it("rejects out-of-range and inverted ratio intervals", () => {
    const outOfRange = validManifest();
    outOfRange.evaluation.visualBaselines = [
      { view: "front", description: "d", minSilhouetteRatio: 1.5 },
    ];
    expectCode(outOfRange, SKILL_EVALUATION_CODE);
    const inverted = validManifest();
    inverted.evaluation.visualBaselines = [
      {
        view: "front",
        description: "d",
        minSilhouetteRatio: 0.9,
        maxSilhouetteRatio: 0.1,
      },
    ];
    expectCode(inverted, SKILL_EVALUATION_CODE);
  });

  it("rejects efficiency limits above skill constraints and golden above max", () => {
    const aboveConstraints = validManifest();
    aboveConstraints.evaluation.efficiency.maxToolCalls = 100; // constraint cap 24
    expectCode(aboveConstraints, SKILL_EVALUATION_CODE);
    const goldenAboveMax = validManifest();
    goldenAboveMax.evaluation.efficiency.goldenToolCalls = 50; // max 24
    expectCode(goldenAboveMax, SKILL_EVALUATION_CODE);
  });
});
