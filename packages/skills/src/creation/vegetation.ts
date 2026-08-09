import type { SkillManifest } from "../manifest.js";
import { CREATION_TOOLS } from "./define.js";

/**
 * Vegetation creation skill (plan S14.6, ticket #38): fixed instructions,
 * allowed tools, compatible generators, constraints, provenance, and
 * evaluation metadata for the vegetation asset category. All commands
 * the skill proposes are generic voxel/region/scene commands; the skill
 * itself is removable versioned knowledge that no saved document
 * depends on (plan S14.9). The manifest is authored plain and validated
 * by the registry at catalog load.
 */

const INSTRUCTIONS: string =
  "You are creating representative vegetation in a voxel document. Work only with the allowed inspection and mutation tools; never invent tools or write state directly.\n\nPlan the piece as generic parts: a trunk or stem, a canopy or crown, and optional branches. Keep the piece inside the build region whose min corner is the origin (extent at most 24 voxels per axis) and aligned to the voxel grid.\n\nBuild order: (1) inspect the selection and summary; (2) create or reuse materials for trunk or bark and foliage; (3) fill the trunk with fillBox, or generator.branches when branching structure is wanted; (4) build the canopy with generator.branches, generator.radialRepeat, or stacked boxes; (5) add bush clumps with generator.linearRepeat;  Inspect the staged result with queryVoxels/inspectBounds and fix only what differs from the plan.\n\nPrefer coarse commands over per-voxel edits. Prefer generator.branches and the repetition generators over manual scattered voxels. Keep foliage one material unless the plan asks for variety. Do not modify anything outside the build region.";
const FIXED_PROMPT: string =
  "Create a tree: a short trunk and a round leafy canopy made of several branch clumps, rooted on the build floor.";
const GENERATORS: readonly string[] = Object.freeze([
  "generator.branches",
  "generator.radialRepeat",
  "generator.linearRepeat",
  "generator.mirror",
]);
const CONSTRAINTS = Object.freeze({
  maxRoundsPerRun: 10,
  maxToolCallsPerRun: 32,
  maxCommandsPerRun: 96,
  maxCommandsPerProposal: 64,
  maxVoxelsPerProposal: 250000,
} as const);
const EFFICIENCY = Object.freeze({
  goldenToolCalls: 18,
  goldenRounds: 6,
  goldenCommands: 48,
  maxToolCalls: 32,
  maxRounds: 10,
  maxCommands: 96,
} as const);
const STRUCTURAL_CHECKS: SkillManifest["evaluation"]["structuralChecks"] =
  Object.freeze([
    Object.freeze({
      name: "occupied-voxel-count-in-range",
      description: "The plant is a solid, non-trivial object.",
      options: {
        region: { min: [0, 0, 0], max: [24, 24, 24] },
        min: 100,
        max: 80000,
      },
    } as const),
    Object.freeze({
      name: "region-nonempty",
      description: "The canopy band contains geometry.",
      options: { region: { min: [0, 8, 0], max: [16, 16, 16] } },
    } as const),
    Object.freeze({
      name: "node-count-in-range",
      description: "The plant stays a small scene.",
      options: { min: 1, max: 16 },
    } as const),
  ]);
const VISUAL_BASELINES: SkillManifest["evaluation"]["visualBaselines"] =
  Object.freeze([
    Object.freeze({
      view: "perspective",
      description: "The plant fills a visible share of the frame.",
      minSilhouetteRatio: 0.03,
      maxSilhouetteRatio: 0.9,
    } as const),
    Object.freeze({
      view: "front",
      description: "The front view shows trunk and canopy.",
      minSilhouetteRatio: 0.02,
      maxSilhouetteRatio: 0.9,
    } as const),
  ]);

const MANIFEST: SkillManifest = {
  manifestVersion: 1,
  name: "skill.vegetation",
  version: "1.0.0",
  description:
    "Creation skill for representative vegetation: trees with trunks and canopies, bushes, and branching plants built from generic repetition and branching generators.",

  kind: "creation",
  category: "vegetation",
  instructions: INSTRUCTIONS,
  allowedTools: CREATION_TOOLS,
  generators: GENERATORS,
  constraints: CONSTRAINTS,
  provenance: {
    author: "voxel-maker",
    source: "voxel-maker/skills",
    license: "UNLICENSED",
    created: "2026-08-09",
  },
  evaluation: {
    scenarioId: "skill-vegetation-create-v1",
    fixedPrompt: FIXED_PROMPT,
    structuralChecks: STRUCTURAL_CHECKS,
    visualBaselines: VISUAL_BASELINES,
    efficiency: EFFICIENCY,
  },
};

/** The authored vegetation creation-skill manifest (validated on load). */
export const VEGETATION_SKILL_MANIFEST: SkillManifest = Object.freeze(MANIFEST);
