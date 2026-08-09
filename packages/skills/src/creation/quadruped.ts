import type { SkillManifest } from "../manifest.js";
import { CREATION_TOOLS } from "./define.js";

/**
 * Quadruped creation skill (plan S14.6, ticket #38): fixed instructions,
 * allowed tools, compatible generators, constraints, provenance, and
 * evaluation metadata for the quadruped asset category. All commands
 * the skill proposes are generic voxel/region/scene commands; the skill
 * itself is removable versioned knowledge that no saved document
 * depends on (plan S14.9). The manifest is authored plain and validated
 * by the registry at catalog load.
 */

const INSTRUCTIONS: string = "You are creating a representative four-legged animals in a voxel document. Work only with the allowed inspection and mutation tools; never invent tools or write state directly.\n\nPlan the piece as generic parts: body, head, four legs, and a tail. Keep the piece inside the build region whose min corner is the origin (extent at most 24 voxels per axis) and aligned to the voxel grid.\n\nBuild order: (1) inspect the selection and summary; (2) create or reuse materials for body and accents; (3) fill the body with fillBox; (4) add the head at the front; (5) place the four legs with generator.linearRepeat or generator.mirror; (6) add the tail with generator.branches or a small box;  Inspect the staged result with queryVoxels/inspectBounds and fix only what differs from the plan.\n\nPrefer coarse commands over per-voxel edits. Prefer coarse commands and generators (mirror, linearRepeat, linkage, branches) over manual per-voxel edits. Keep the animal symmetric across the sagittal plane (x = 12). Do not modify anything outside the build region.";
const FIXED_PROMPT: string = "Create a small quadruped animal: an elongated body, a head at the front, four legs, and a short tail.";
const GENERATORS: readonly string[] = Object.freeze(["generator.mirror", "generator.linearRepeat", "generator.linkage", "generator.branches"]);
const CONSTRAINTS = Object.freeze({"maxRoundsPerRun": 14, "maxToolCallsPerRun": 48, "maxCommandsPerRun": 192, "maxCommandsPerProposal": 96, "maxVoxelsPerProposal": 400000} as const);
const EFFICIENCY = Object.freeze({"goldenToolCalls": 26, "goldenRounds": 9, "goldenCommands": 80, "maxToolCalls": 48, "maxRounds": 14, "maxCommands": 192} as const);
const STRUCTURAL_CHECKS: SkillManifest['evaluation']['structuralChecks'] = Object.freeze([
  Object.freeze({"name": "occupied-voxel-count-in-range", "description": "The animal is a solid, non-trivial object.", "options": {"region": {"min": [0, 0, 0], "max": [24, 16, 24]}, "min": 150, "max": 80000}} as const),
  Object.freeze({"name": "symmetric-along-axis", "description": "The animal is symmetric across the sagittal plane.", "options": {"axis": "x", "plane": 12, "region": {"min": [0, 0, 0], "max": [24, 16, 24]}}} as const),
  Object.freeze({"name": "node-count-in-range", "description": "The animal stays a small scene.", "options": {"min": 1, "max": 24}} as const)]);
const VISUAL_BASELINES: SkillManifest['evaluation']['visualBaselines'] = Object.freeze([
  Object.freeze({"view": "perspective", "description": "The animal fills a visible share of the frame.", "minSilhouetteRatio": 0.05, "maxSilhouetteRatio": 0.9} as const),
  Object.freeze({"view": "side", "description": "The side view shows the whole animal.", "minSilhouetteRatio": 0.04, "maxSilhouetteRatio": 0.9} as const),
  Object.freeze({"view": "top", "description": "The top view shows the body.", "minSilhouetteRatio": 0.02, "maxSilhouetteRatio": 0.9} as const)]);

const MANIFEST: SkillManifest = {
  manifestVersion: 1,
  name: "skill.quadruped",
  version: "1.0.0",
  description: "Creation skill for representative four-legged animals: body, head, four legs, and a tail built from generic symmetry and limb-chain generators.",
  category: "quadruped",
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
    scenarioId: "skill-quadruped-create-v1",
    fixedPrompt: FIXED_PROMPT,
    structuralChecks: STRUCTURAL_CHECKS,
    visualBaselines: VISUAL_BASELINES,
    efficiency: EFFICIENCY,
  },
};

/** The authored quadruped creation-skill manifest (validated on load). */
export const QUADRUPED_SKILL_MANIFEST: SkillManifest = Object.freeze(MANIFEST);
