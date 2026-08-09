import type { SkillManifest } from "../manifest.js";
import { RIGGING_TOOLS } from "./define.js";

/**
 * Biped-Rig rigging skill (plan S14.7, ticket #39): fixed instructions,
 * allowed tools, constraints, provenance, and evaluation metadata for
 * rigging biped figures. All commands the skill proposes are generic
 * hierarchy/pivot/joint/constraint commands; the skill itself is
 * removable versioned knowledge that no saved document depends on
 * (plan S14.9). The manifest is authored plain and validated by the
 * registry at catalog load.
 */

const INSTRUCTIONS: string =
  "You are rigging a biped figure in a voxel document. Work only with the allowed inspection and mutation tools; never invent tools or write state directly. Never change voxels.\n\nPlan: (1) inspect the hierarchy and the rig state; (2) separate movable geometry minimally: head, upper arms, forearms, thighs, and shins must each be their own node; (3) parent every part correctly so each limb hangs from the torso; (4) place each pivot at the joint location derived from the part bounds; (5) add a joint at every articulation; (6) constrain the elbows and knees with a bounded rotation range so the limbs cannot fold backwards; (7) verify with inspectHierarchy/inspectRigging and fix only what differs from the plan.\n\nPrefer a minimal rig over extra nodes: only parts that move get their own node, pivot, and joint.";
const FIXED_PROMPT: string =
  "Rig the humanoid figure: separate the head, upper arms, forearms, thighs, and shins into their own nodes, place pivots at the neck, shoulders, elbows, hips, and knees, add a joint at each articulation, and constrain the elbows and knees to a limited rotation range.";
const CONSTRAINTS = Object.freeze({
  maxRoundsPerRun: 12,
  maxToolCallsPerRun: 40,
  maxCommandsPerRun: 96,
  maxCommandsPerProposal: 64,
  maxVoxelsPerProposal: 100000,
} as const);
const EFFICIENCY = Object.freeze({
  goldenToolCalls: 24,
  goldenRounds: 7,
  goldenCommands: 22,
  maxToolCalls: 40,
  maxRounds: 12,
  maxCommands: 96,
} as const);
const STRUCTURAL_CHECKS: SkillManifest["evaluation"]["structuralChecks"] =
  Object.freeze([
    Object.freeze({
      name: "pivot-count-in-range",
      description: "Every articulation of the figure has a pivot.",
      options: { min: 8, max: 12 },
    } as const),
    Object.freeze({
      name: "joint-count-in-range",
      description: "Every articulation of the figure has a joint.",
      options: { min: 8, max: 12 },
    } as const),
    Object.freeze({
      name: "constraint-count-in-range",
      description: "The elbows and knees carry rotation limits.",
      options: { min: 2, max: 8 },
    } as const),
    Object.freeze({
      name: "parented-node-count-in-range",
      description: "The movable parts hang off the torso hierarchy.",
      options: { min: 8, max: 16 },
    } as const),
    Object.freeze({
      name: "node-count-in-range",
      description: "The figure stays one small scene.",
      options: { min: 8, max: 16 },
    } as const),
    Object.freeze({
      name: "node-present",
      description: "The torso node exists.",
      options: { nodeId: "node:rig:biped:torso" },
    } as const),
  ]);

const MANIFEST: SkillManifest = {
  manifestVersion: 1,
  name: "skill.biped-rig",
  version: "1.0.0",
  description: "biped figures",
  kind: "rigging",
  category: "biped",
  instructions: INSTRUCTIONS,
  allowedTools: RIGGING_TOOLS,
  generators: [],
  constraints: CONSTRAINTS,
  provenance: {
    author: "voxel-maker",
    source: "voxel-maker/skills",
    license: "UNLICENSED",
    created: "2026-08-09",
  },
  evaluation: {
    scenarioId: "skill-biped-rig-v1",
    fixtureId: "rig-biped",
    fixedPrompt: FIXED_PROMPT,
    structuralChecks: STRUCTURAL_CHECKS,
    visualBaselines: [],
    efficiency: EFFICIENCY,
  },
};

/** The authored skill.biped-rig rigging-skill manifest (validated on load). */
export const BIPED_RIG_SKILL_MANIFEST = Object.freeze(MANIFEST);
