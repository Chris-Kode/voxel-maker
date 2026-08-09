import type { SkillManifest } from "../manifest.js";
import { MOTION_TOOLS } from "./define.js";

/**
 * Mechanical-Motion motion skill (plan S14.8, ticket #39): fixed instructions,
 * allowed tools, constraints, provenance, and evaluation metadata for
 * locomotion of a rigged biped. All commands the skill proposes are generic
 * clips/tracks/keyframes commands on the existing rig; the skill itself
 * is removable versioned knowledge that no saved document depends on
 * (plan S14.9). The manifest is authored plain and validated by the
 * registry at catalog load.
 */

const INSTRUCTIONS: string =
  "You are animating an already-rigged asset in a voxel document. Work only with the allowed inspection and mutation tools; never invent tools or write state directly. Never change voxels, hierarchy, pivots, joints, or constraints.\n\nPlan: (1) inspect the rig and the existing clips; (2) reuse the rigged nodes as track targets, never create throwaway nodes; (3) create one animation with a valid finite duration and the declared loop policy; (4) add one track per moving node and set typed keyframes (rotation values as quaternions, translation/scale as vectors); (5) follow the looping endpoint policy: a looping clip starts and ends at the same value at time 0 and at the duration; (6) verify with inspectClips/inspectTracks/inspectKeyframes and fix only what differs from the plan.\n\nMechanical motion: a two-second seamless loop where the second and third links sweep alternately about their joints (keyframes at 0, mid-cycle, and duration with equal endpoint values).";
const FIXED_PROMPT: string =
  "Make the mechanical linkage sweep: the intermediate links rotate alternately in a seamless looping clip.";
const CONSTRAINTS = Object.freeze({
  maxRoundsPerRun: 12,
  maxToolCallsPerRun: 40,
  maxCommandsPerRun: 96,
  maxCommandsPerProposal: 64,
  maxVoxelsPerProposal: 100000,
} as const);
const EFFICIENCY = Object.freeze({
  goldenToolCalls: 16,
  goldenRounds: 5,
  goldenCommands: 9,
  maxToolCalls: 40,
  maxRounds: 12,
  maxCommands: 96,
} as const);
const STRUCTURAL_CHECKS: SkillManifest["evaluation"]["structuralChecks"] =
  Object.freeze([
    Object.freeze({
      name: "animation-count-in-range",
      description: "The run stages exactly one clip.",
      options: { min: 1, max: 2 },
    } as const),
    Object.freeze({
      name: "track-count-in-range",
      description: "The moving links are tracked.",
      options: { min: 2, max: 8 },
    } as const),
    Object.freeze({
      name: "keyframe-count-in-range",
      description: "The clip carries a bounded keyframe set.",
      options: { min: 4, max: 24 },
    } as const),
    Object.freeze({
      name: "animation-duration-in-range",
      description: "The sweep duration matches the machine cycle.",
      options: { min: 1, max: 4 },
    } as const),
    Object.freeze({
      name: "animation-loop-policy",
      description: "The machine cycle loops.",
      options: { policy: "loop" },
    } as const),
    Object.freeze({
      name: "pivot-count-in-range",
      description: "The linkage stays rigged.",
      options: { min: 3, max: 8 },
    } as const),
    Object.freeze({
      name: "joint-count-in-range",
      description: "The linkage stays rigged.",
      options: { min: 3, max: 8 },
    } as const),
    Object.freeze({
      name: "node-present",
      description: "The second link node exists.",
      options: { nodeId: "node:rig:link:link2" },
    } as const),
  ]);

const MANIFEST: SkillManifest = {
  manifestVersion: 1,
  name: "skill.mechanical-motion",
  version: "1.0.0",
  description: "motion of a rigged mechanical linkage",
  kind: "motion",
  category: "mechanical",
  instructions: INSTRUCTIONS,
  allowedTools: MOTION_TOOLS,
  generators: [],
  constraints: CONSTRAINTS,
  provenance: {
    author: "voxel-maker",
    source: "voxel-maker/skills",
    license: "UNLICENSED",
    created: "2026-08-09",
  },
  evaluation: {
    scenarioId: "skill-mechanical-motion-v1",
    fixtureId: "motion-mechanical",
    fixedPrompt: FIXED_PROMPT,
    structuralChecks: STRUCTURAL_CHECKS,
    visualBaselines: [],
    efficiency: EFFICIENCY,
  },
};

/** The authored skill.mechanical-motion motion-skill manifest (validated on load). */
export const MECHANICAL_MOTION_SKILL_MANIFEST = Object.freeze(MANIFEST);
