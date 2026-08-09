import type { SkillManifest } from "../manifest.js";
import { CREATION_TOOLS } from "./define.js";

/**
 * Flying creature creation skill (plan S14.6, ticket #38): fixed instructions,
 * allowed tools, compatible generators, constraints, provenance, and
 * evaluation metadata for the flying-creature asset category. All commands
 * the skill proposes are generic voxel/region/scene commands; the skill
 * itself is removable versioned knowledge that no saved document
 * depends on (plan S14.9). The manifest is authored plain and validated
 * by the registry at catalog load.
 */

const INSTRUCTIONS: string =
  "You are creating a flying creature in a voxel document. Work only with the allowed inspection and mutation tools; never invent tools or write state directly.\n\nPlan the piece as generic parts: body, head, two wings, and a tail. Keep the piece inside the build region whose min corner is the origin (extent at most 24 voxels per axis) and aligned to the voxel grid.\n\nBuild order: (1) inspect the selection and summary; (2) create or reuse materials for body and wings; (3) fill the body with fillBox; (4) add the head; (5) place the two wings with generator.mirror so both sides match, using generator.branches for feathered or membrane structure; (6) add the tail;  Inspect the staged result with queryVoxels/inspectBounds and fix only what differs from the plan.\n\nPrefer coarse commands over per-voxel edits. Prefer coarse commands and generators (mirror, branches, linearRepeat, linkage) over manual per-voxel edits. Keep the creature symmetric across the sagittal plane (x = 12). Do not modify anything outside the build region.";
const FIXED_PROMPT: string =
  "Create a small flying creature: an oval body, a head, two spread wings, and a short tail.";
const GENERATORS: readonly string[] = Object.freeze([
  "generator.mirror",
  "generator.branches",
  "generator.linearRepeat",
  "generator.linkage",
]);
const CONSTRAINTS = Object.freeze({
  maxRoundsPerRun: 12,
  maxToolCallsPerRun: 40,
  maxCommandsPerRun: 160,
  maxCommandsPerProposal: 80,
  maxVoxelsPerProposal: 300000,
} as const);
const EFFICIENCY = Object.freeze({
  goldenToolCalls: 22,
  goldenRounds: 8,
  goldenCommands: 64,
  maxToolCalls: 40,
  maxRounds: 12,
  maxCommands: 160,
} as const);
const STRUCTURAL_CHECKS: SkillManifest["evaluation"]["structuralChecks"] =
  Object.freeze([
    Object.freeze({
      name: "occupied-voxel-count-in-range",
      description: "The creature is a solid, non-trivial object.",
      options: {
        region: { min: [0, 0, 0], max: [24, 16, 24] },
        min: 120,
        max: 80000,
      },
    } as const),
    Object.freeze({
      name: "symmetric-along-axis",
      description: "The creature is symmetric across the sagittal plane.",
      options: {
        axis: "x",
        plane: 12,
        region: { min: [0, 0, 0], max: [24, 16, 24] },
      },
    } as const),
    Object.freeze({
      name: "node-count-in-range",
      description: "The creature stays a small scene.",
      options: { min: 1, max: 24 },
    } as const),
  ]);
const VISUAL_BASELINES: SkillManifest["evaluation"]["visualBaselines"] =
  Object.freeze([
    Object.freeze({
      view: "perspective",
      description: "The creature fills a visible share of the frame.",
      minSilhouetteRatio: 0.04,
      maxSilhouetteRatio: 0.9,
    } as const),
    Object.freeze({
      view: "front",
      description: "The front view shows both wings.",
      minSilhouetteRatio: 0.03,
      maxSilhouetteRatio: 0.9,
    } as const),
    Object.freeze({
      view: "top",
      description: "The top view shows the wingspan.",
      minSilhouetteRatio: 0.03,
      maxSilhouetteRatio: 0.9,
    } as const),
  ]);

const MANIFEST: SkillManifest = {
  manifestVersion: 1,
  name: "skill.flying-creature",
  version: "1.0.0",
  description:
    "Creation skill for representative flying creatures: body, head, two wings, and a tail built from generic symmetry and branch generators.",
  category: "flying-creature",
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
    scenarioId: "skill-flying-creature-create-v1",
    fixedPrompt: FIXED_PROMPT,
    structuralChecks: STRUCTURAL_CHECKS,
    visualBaselines: VISUAL_BASELINES,
    efficiency: EFFICIENCY,
  },
};

/** The authored flying-creature creation-skill manifest (validated on load). */
export const FLYING_CREATURE_SKILL_MANIFEST: SkillManifest =
  Object.freeze(MANIFEST);
