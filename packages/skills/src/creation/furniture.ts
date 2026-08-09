import type { SkillManifest } from "../manifest.js";
import { CREATION_TOOLS } from "./define.js";

/**
 * Furniture creation skill (plan S14.6, ticket #38): fixed instructions,
 * allowed tools, compatible generators, constraints, provenance, and
 * evaluation metadata for the furniture asset category. All commands
 * the skill proposes are generic voxel/region/scene commands; the skill
 * itself is removable versioned knowledge that no saved document
 * depends on (plan S14.9). The manifest is authored plain and validated
 * by the registry at catalog load.
 */

const INSTRUCTIONS: string =
  "You are creating a representative furniture piece in a voxel document. Work only with the allowed inspection and mutation tools; never invent tools or write state directly.\n\nPlan the piece as generic parts: seat/surface slabs, legs or supports, backrests, armrests, and rails. Keep the piece inside the build region whose min corner is the origin (extent at most 16 voxels per axis) and aligned to the voxel grid.\n\nBuild order: (1) inspect the selection and summary; (2) create or reuse one material per visible part (frame, cushion, accent); (3) fill the main slab with fillBox; (4) place symmetric legs with generator.mirror or generator.linearRepeat when the layout repeats; (5) add backrest and armrests as separate boxes;  Inspect the staged result with queryVoxels/inspectBounds and fix only what differs from the plan.\n\nPrefer coarse commands over per-voxel edits. Use symmetry and repetition generators instead of manual mirrored fills. Keep the piece one connected volume where possible. Do not modify anything outside the build region.";
const FIXED_PROMPT: string =
  "Create a simple wooden chair: four legs, a square seat, and a backrest, in the build region.";
const GENERATORS: readonly string[] = Object.freeze([
  "generator.mirror",
  "generator.linearRepeat",
  "generator.radialRepeat",
]);
const CONSTRAINTS = Object.freeze({
  maxRoundsPerRun: 12,
  maxToolCallsPerRun: 40,
  maxCommandsPerRun: 128,
  maxCommandsPerProposal: 64,
  maxVoxelsPerProposal: 250000,
} as const);
const EFFICIENCY = Object.freeze({
  goldenToolCalls: 24,
  goldenRounds: 8,
  goldenCommands: 64,
  maxToolCalls: 40,
  maxRounds: 12,
  maxCommands: 128,
} as const);
const STRUCTURAL_CHECKS: SkillManifest["evaluation"]["structuralChecks"] =
  Object.freeze([
    Object.freeze({
      name: "occupied-voxel-count-in-range",
      description: "The chair is a solid, non-trivial object.",
      options: {
        region: { min: [0, 0, 0], max: [16, 16, 16] },
        min: 100,
        max: 60000,
      },
    } as const),
    Object.freeze({
      name: "region-nonempty",
      description: "The seat area contains geometry.",
      options: { region: { min: [0, 0, 0], max: [8, 8, 8] } },
    } as const),
    Object.freeze({
      name: "node-count-in-range",
      description: "The piece stays a small scene.",
      options: { min: 1, max: 32 },
    } as const),
  ]);
const VISUAL_BASELINES: SkillManifest["evaluation"]["visualBaselines"] =
  Object.freeze([
    Object.freeze({
      view: "perspective",
      description: "The chair fills a visible share of the frame.",
      minSilhouetteRatio: 0.03,
      maxSilhouetteRatio: 0.9,
    } as const),
    Object.freeze({
      view: "front",
      description: "The front view shows the seat and legs.",
      minSilhouetteRatio: 0.02,
      maxSilhouetteRatio: 0.9,
    } as const),
    Object.freeze({
      view: "side",
      description: "The side view shows seat depth and backrest height.",
      minSilhouetteRatio: 0.02,
      maxSilhouetteRatio: 0.9,
    } as const),
  ]);

const MANIFEST: SkillManifest = {
  manifestVersion: 1,
  name: "skill.furniture",
  version: "1.0.0",
  description:
    "Creation skill for representative furniture pieces: chairs, tables, benches, and beds built from generic voxel/region commands and deterministic generators.",
  category: "furniture",
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
    scenarioId: "skill-furniture-create-v1",
    fixedPrompt: FIXED_PROMPT,
    structuralChecks: STRUCTURAL_CHECKS,
    visualBaselines: VISUAL_BASELINES,
    efficiency: EFFICIENCY,
  },
};

/** The authored furniture creation-skill manifest (validated on load). */
export const FURNITURE_SKILL_MANIFEST: SkillManifest = Object.freeze(MANIFEST);
