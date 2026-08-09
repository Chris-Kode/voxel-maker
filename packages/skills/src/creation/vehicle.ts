import type { SkillManifest } from "../manifest.js";
import { CREATION_TOOLS } from "./define.js";

/**
 * Vehicle creation skill (plan S14.6, ticket #38): fixed instructions,
 * allowed tools, compatible generators, constraints, provenance, and
 * evaluation metadata for the vehicle asset category. All commands
 * the skill proposes are generic voxel/region/scene commands; the skill
 * itself is removable versioned knowledge that no saved document
 * depends on (plan S14.9). The manifest is authored plain and validated
 * by the registry at catalog load.
 */

const INSTRUCTIONS: string =
  "You are creating a representative vehicles in a voxel document. Work only with the allowed inspection and mutation tools; never invent tools or write state directly.\n\nPlan the piece as generic parts: a body slab, a cabin or cargo area, and four wheels. Keep the piece inside the build region whose min corner is the origin (extent at most 24 voxels per axis) and aligned to the voxel grid.\n\nBuild order: (1) inspect the selection and summary; (2) create or reuse materials for body, windows, and wheels; (3) fill the body with fillBox; (4) add the cabin with a second box; (5) place wheels with generator.wheel, mirrored to the other side with generator.mirror;  Inspect the staged result with queryVoxels/inspectBounds and fix only what differs from the plan.\n\nPrefer coarse commands over per-voxel edits. Prefer coarse commands and generators (wheel, mirror, linearRepeat) over manual per-voxel edits. Keep the vehicle symmetric along its long axis unless the plan says otherwise. Do not modify anything outside the build region.";
const FIXED_PROMPT: string =
  "Create a small cart: a rectangular cargo body, four wheels at the corners, and a pull handle at the front.";
const GENERATORS: readonly string[] = Object.freeze([
  "generator.wheel",
  "generator.mirror",
  "generator.linearRepeat",
  "generator.radialRepeat",
]);
const CONSTRAINTS = Object.freeze({
  maxRoundsPerRun: 12,
  maxToolCallsPerRun: 40,
  maxCommandsPerRun: 128,
  maxCommandsPerProposal: 64,
  maxVoxelsPerProposal: 400000,
} as const);
const EFFICIENCY = Object.freeze({
  goldenToolCalls: 22,
  goldenRounds: 8,
  goldenCommands: 60,
  maxToolCalls: 40,
  maxRounds: 12,
  maxCommands: 128,
} as const);
const STRUCTURAL_CHECKS: SkillManifest["evaluation"]["structuralChecks"] =
  Object.freeze([
    Object.freeze({
      name: "occupied-voxel-count-in-range",
      description: "The vehicle is a solid, non-trivial object.",
      options: {
        region: { min: [0, 0, 0], max: [24, 16, 24] },
        min: 150,
        max: 100000,
      },
    } as const),
    Object.freeze({
      name: "region-nonempty",
      description: "The body band contains geometry.",
      options: { region: { min: [0, 4, 0], max: [20, 12, 16] } },
    } as const),
    Object.freeze({
      name: "node-count-in-range",
      description: "The vehicle stays a small scene.",
      options: { min: 1, max: 24 },
    } as const),
  ]);
const VISUAL_BASELINES: SkillManifest["evaluation"]["visualBaselines"] =
  Object.freeze([
    Object.freeze({
      view: "perspective",
      description: "The vehicle fills a visible share of the frame.",
      minSilhouetteRatio: 0.03,
      maxSilhouetteRatio: 0.9,
    } as const),
    Object.freeze({
      view: "side",
      description: "The side view shows body and wheels.",
      minSilhouetteRatio: 0.02,
      maxSilhouetteRatio: 0.9,
    } as const),
    Object.freeze({
      view: "top",
      description: "The top view shows the footprint.",
      minSilhouetteRatio: 0.02,
      maxSilhouetteRatio: 0.9,
    } as const),
  ]);

const MANIFEST: SkillManifest = {
  manifestVersion: 1,
  name: "skill.vehicle",
  version: "1.0.0",
  description:
    "Creation skill for representative vehicles: wheeled carts and cars with body, cabin, and wheels built from generic symmetry and wheel generators.",
  category: "vehicle",
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
    scenarioId: "skill-vehicle-create-v1",
    fixedPrompt: FIXED_PROMPT,
    structuralChecks: STRUCTURAL_CHECKS,
    visualBaselines: VISUAL_BASELINES,
    efficiency: EFFICIENCY,
  },
};

/** The authored vehicle creation-skill manifest (validated on load). */
export const VEHICLE_SKILL_MANIFEST: SkillManifest = Object.freeze(MANIFEST);
