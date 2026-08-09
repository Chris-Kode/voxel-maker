import type { SkillManifest } from "../manifest.js";
import { CREATION_TOOLS } from "./define.js";

/**
 * Architecture creation skill (plan S14.6, ticket #38): fixed instructions,
 * allowed tools, compatible generators, constraints, provenance, and
 * evaluation metadata for the architecture asset category. All commands
 * the skill proposes are generic voxel/region/scene commands; the skill
 * itself is removable versioned knowledge that no saved document
 * depends on (plan S14.9). The manifest is authored plain and validated
 * by the registry at catalog load.
 */

const INSTRUCTIONS: string =
  "You are creating a small architectural structure in a voxel document. Work only with the allowed inspection and mutation tools; never invent tools or write state directly.\n\nPlan the piece as generic parts: walls, floors, openings (doors and windows), stairs, and a roof. Keep the piece inside the build region whose min corner is the origin (extent at most 32 voxels per axis) and aligned to the voxel grid.\n\nBuild order: (1) inspect the selection and summary; (2) create or reuse materials for walls, roof, and floor; (3) lay the floor slab with fillBox; (4) raise walls with generator.wall, leaving openings where the plan requires; (5) add stairs with generator.stairs where levels change; (6) cap the structure with generator.roof;  Inspect the staged result with queryVoxels/inspectBounds and fix only what differs from the plan.\n\nPrefer coarse commands over per-voxel edits. Prefer the structural generators (wall, stairs, roof, linearRepeat) over manual fills. Keep walls one voxel thick unless the plan says otherwise. Do not modify anything outside the build region.";
const FIXED_PROMPT: string =
  "Create a small house: four walls with a door and two window openings, a flat roof, and two steps at the entrance.";
const GENERATORS: readonly string[] = Object.freeze([
  "generator.stairs",
  "generator.wall",
  "generator.roof",
  "generator.linearRepeat",
  "generator.mirror",
]);
const CONSTRAINTS = Object.freeze({
  maxRoundsPerRun: 14,
  maxToolCallsPerRun: 48,
  maxCommandsPerRun: 256,
  maxCommandsPerProposal: 128,
  maxVoxelsPerProposal: 500000,
} as const);
const EFFICIENCY = Object.freeze({
  goldenToolCalls: 28,
  goldenRounds: 10,
  goldenCommands: 120,
  maxToolCalls: 48,
  maxRounds: 14,
  maxCommands: 256,
} as const);
const STRUCTURAL_CHECKS: SkillManifest["evaluation"]["structuralChecks"] =
  Object.freeze([
    Object.freeze({
      name: "occupied-voxel-count-in-range",
      description: "The structure is a solid, non-trivial object.",
      options: {
        region: { min: [0, 0, 0], max: [32, 32, 32] },
        min: 500,
        max: 250000,
      },
    } as const),
    Object.freeze({
      name: "region-nonempty",
      description: "The wall band contains geometry.",
      options: { region: { min: [0, 0, 0], max: [16, 8, 16] } },
    } as const),
    Object.freeze({
      name: "node-count-in-range",
      description: "The structure stays a small scene.",
      options: { min: 1, max: 32 },
    } as const),
  ]);
const VISUAL_BASELINES: SkillManifest["evaluation"]["visualBaselines"] =
  Object.freeze([
    Object.freeze({
      view: "perspective",
      description: "The structure fills a visible share of the frame.",
      minSilhouetteRatio: 0.05,
      maxSilhouetteRatio: 0.95,
    } as const),
    Object.freeze({
      view: "front",
      description: "The front view shows walls and openings.",
      minSilhouetteRatio: 0.04,
      maxSilhouetteRatio: 0.95,
    } as const),
    Object.freeze({
      view: "top",
      description: "The top view shows the footprint.",
      minSilhouetteRatio: 0.04,
      maxSilhouetteRatio: 0.95,
    } as const),
  ]);

const MANIFEST: SkillManifest = {
  manifestVersion: 1,
  name: "skill.architecture",
  version: "1.0.0",
  description:
    "Creation skill for small architectural structures: houses, walls with openings, stairs, roofs, and courtyards built from generic structural generators.",

  kind: "creation",
  category: "architecture",
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
    scenarioId: "skill-architecture-create-v1",
    fixedPrompt: FIXED_PROMPT,
    structuralChecks: STRUCTURAL_CHECKS,
    visualBaselines: VISUAL_BASELINES,
    efficiency: EFFICIENCY,
  },
};

/** The authored architecture creation-skill manifest (validated on load). */
export const ARCHITECTURE_SKILL_MANIFEST: SkillManifest =
  Object.freeze(MANIFEST);
