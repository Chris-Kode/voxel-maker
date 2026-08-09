import type { SkillManifest } from "../manifest.js";
import { RIGGING_TOOLS } from "./define.js";

/**
 * Mechanical-Linkage-Rig rigging skill (plan S14.7, ticket #39): fixed instructions,
 * allowed tools, constraints, provenance, and evaluation metadata for
 * rigging mechanical linkages. All commands the skill proposes are generic
 * hierarchy/pivot/joint/constraint commands; the skill itself is
 * removable versioned knowledge that no saved document depends on
 * (plan S14.9). The manifest is authored plain and validated by the
 * registry at catalog load.
 */

const INSTRUCTIONS: string =
  "You are rigging a mechanical linkage in a voxel document. Work only with the allowed inspection and mutation tools; never invent tools or write state directly. Never change voxels.\n\nPlan: (1) inspect the hierarchy and the rig state; (2) keep the base as the root and parent each link to the previous link so the chain is one hierarchy; (3) place a pivot at each link root derived from the link bounds; (4) add a joint at each link root; (5) constrain the intermediate joints with a bounded sweep range so the linkage cannot fold through itself; (6) verify with inspectHierarchy/inspectRigging and fix only what differs from the plan.\n\nPrefer a minimal rig: each moving link is one articulated node in the chain.";
const FIXED_PROMPT: string =
  "Rig the mechanical linkage: keep the base as the root, parent each link to the previous one, place a pivot at each link root, add a joint at each link root, and constrain the elbow and wrist joints to a bounded sweep range.";
const CONSTRAINTS = Object.freeze({
  maxRoundsPerRun: 12,
  maxToolCallsPerRun: 40,
  maxCommandsPerRun: 96,
  maxCommandsPerProposal: 64,
  maxVoxelsPerProposal: 100000,
} as const);
const EFFICIENCY = Object.freeze({
  goldenToolCalls: 12,
  goldenRounds: 4,
  goldenCommands: 8,
  maxToolCalls: 40,
  maxRounds: 12,
  maxCommands: 96,
} as const);
const STRUCTURAL_CHECKS: SkillManifest["evaluation"]["structuralChecks"] =
  Object.freeze([
    Object.freeze({
      name: "pivot-count-in-range",
      description: "Every link has a pivot at its root.",
      options: { min: 3, max: 8 },
    } as const),
    Object.freeze({
      name: "joint-count-in-range",
      description: "Every link has a joint at its root.",
      options: { min: 3, max: 8 },
    } as const),
    Object.freeze({
      name: "constraint-count-in-range",
      description: "The joints carry bounded sweep ranges.",
      options: { min: 1, max: 6 },
    } as const),
    Object.freeze({
      name: "parented-node-count-in-range",
      description: "The links form one chain.",
      options: { min: 2, max: 10 },
    } as const),
    Object.freeze({
      name: "node-count-in-range",
      description: "The linkage stays one small scene.",
      options: { min: 3, max: 10 },
    } as const),
    Object.freeze({
      name: "node-present",
      description: "The base node exists.",
      options: { nodeId: "node:rig:link:base" },
    } as const),
  ]);

const MANIFEST: SkillManifest = {
  manifestVersion: 1,
  name: "skill.mechanical-linkage-rig",
  version: "1.0.0",
  description: "mechanical linkages",
  kind: "rigging",
  category: "mechanical-linkage",
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
    scenarioId: "skill-mechanical-linkage-rig-v1",
    fixtureId: "rig-linkage",
    fixedPrompt: FIXED_PROMPT,
    structuralChecks: STRUCTURAL_CHECKS,
    visualBaselines: [],
    efficiency: EFFICIENCY,
  },
};

/** The authored skill.mechanical-linkage-rig rigging-skill manifest (validated on load). */
export const MECHANICAL_LINKAGE_RIG_SKILL_MANIFEST = Object.freeze(MANIFEST);
