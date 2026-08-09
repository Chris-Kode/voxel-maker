import type { SkillManifest } from "../manifest.js";
import { RIGGING_TOOLS } from "./define.js";

/**
 * Wings-Rig rigging skill (plan S14.7, ticket #39): fixed instructions,
 * allowed tools, constraints, provenance, and evaluation metadata for
 * rigging paired wings on a body. All commands the skill proposes are generic
 * hierarchy/pivot/joint/constraint commands; the skill itself is
 * removable versioned knowledge that no saved document depends on
 * (plan S14.9). The manifest is authored plain and validated by the
 * registry at catalog load.
 */

const INSTRUCTIONS: string =
  "You are rigging paired wings in a voxel document. Work only with the allowed inspection and mutation tools; never invent tools or write state directly. Never change voxels.\n\nPlan: (1) inspect the hierarchy and the rig state; (2) keep the body as the root and parent each wing to the body; (3) place a pivot at each wing root derived from the wing bounds; (4) add a joint at each wing root; (5) constrain each wing to a bounded flap range so wings cannot twist through the body; (6) verify with inspectHierarchy/inspectRigging and fix only what differs from the plan.\n\nPrefer a minimal rig: only the wings and the body, each wing one articulated node.";
const FIXED_PROMPT: string =
  "Rig the paired wings: keep the body as the root, parent each wing to the body, place a pivot at each wing root, add a joint at each wing root, and constrain each wing to a bounded flap range.";
const CONSTRAINTS = Object.freeze({
  maxRoundsPerRun: 12,
  maxToolCallsPerRun: 40,
  maxCommandsPerRun: 96,
  maxCommandsPerProposal: 64,
  maxVoxelsPerProposal: 100000,
} as const);
const EFFICIENCY = Object.freeze({
  goldenToolCalls: 10,
  goldenRounds: 4,
  goldenCommands: 6,
  maxToolCalls: 40,
  maxRounds: 12,
  maxCommands: 96,
} as const);
const STRUCTURAL_CHECKS: SkillManifest["evaluation"]["structuralChecks"] =
  Object.freeze([
    Object.freeze({
      name: "pivot-count-in-range",
      description: "Each wing has a pivot at its root.",
      options: { min: 2, max: 6 },
    } as const),
    Object.freeze({
      name: "joint-count-in-range",
      description: "Each wing has a joint at its root.",
      options: { min: 2, max: 6 },
    } as const),
    Object.freeze({
      name: "constraint-count-in-range",
      description: "Each wing carries a bounded flap range.",
      options: { min: 1, max: 4 },
    } as const),
    Object.freeze({
      name: "parented-node-count-in-range",
      description: "The wings hang off the body.",
      options: { min: 1, max: 6 },
    } as const),
    Object.freeze({
      name: "node-count-in-range",
      description: "The creature stays one small scene.",
      options: { min: 2, max: 8 },
    } as const),
    Object.freeze({
      name: "node-present",
      description: "The body node exists.",
      options: { nodeId: "node:rig:wings:body" },
    } as const),
  ]);

const MANIFEST: SkillManifest = {
  manifestVersion: 1,
  name: "skill.wings-rig",
  version: "1.0.0",
  description: "paired wings on a body",
  kind: "rigging",
  category: "wings",
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
    scenarioId: "skill-wings-rig-v1",
    fixtureId: "rig-wings",
    fixedPrompt: FIXED_PROMPT,
    structuralChecks: STRUCTURAL_CHECKS,
    visualBaselines: [],
    efficiency: EFFICIENCY,
  },
};

/** The authored skill.wings-rig rigging-skill manifest (validated on load). */
export const WINGS_RIG_SKILL_MANIFEST = Object.freeze(MANIFEST);
