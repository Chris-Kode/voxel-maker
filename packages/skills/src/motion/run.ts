import type { SkillManifest } from "../manifest.js";
import { MOTION_TOOLS } from "./define.js";

/**
 * Run motion skill (plan S14.8, ticket #39): fixed instructions,
 * allowed tools, constraints, provenance, and evaluation metadata for
 * locomotion of a rigged biped. All commands the skill proposes are generic
 * clips/tracks/keyframes commands on the existing rig; the skill itself
 * is removable versioned knowledge that no saved document depends on
 * (plan S14.9). The manifest is authored plain and validated by the
 * registry at catalog load.
 */

const INSTRUCTIONS: string =
  "You are animating an already-rigged asset in a voxel document. Work only with the allowed inspection and mutation tools; never invent tools or write state directly. Never change voxels, hierarchy, pivots, joints, or constraints.\n\nPlan: (1) inspect the rig and the existing clips; (2) reuse the rigged nodes as track targets, never create throwaway nodes; (3) create one animation with a valid finite duration and the declared loop policy; (4) add one track per moving node and set typed keyframes (rotation values as quaternions, translation/scale as vectors); (5) follow the looping endpoint policy: a looping clip starts and ends at the same value at time 0 and at the duration; (6) verify with inspectClips/inspectTracks/inspectKeyframes and fix only what differs from the plan.\n\nGait: a one-second seamless loop with a deeper stride than walk (thigh and shin tracks on both legs, keyframes at 0, mid-cycle, and duration with equal endpoint values).";
const FIXED_PROMPT: string =
  "Make the humanoid run in place: a fast, seamless looping stride of the thighs and shins.";
const CONSTRAINTS = Object.freeze({
  maxRoundsPerRun: 12,
  maxToolCallsPerRun: 40,
  maxCommandsPerRun: 96,
  maxCommandsPerProposal: 64,
  maxVoxelsPerProposal: 100000,
} as const);
const EFFICIENCY = Object.freeze({
  goldenToolCalls: 25,
  goldenRounds: 6,
  goldenCommands: 17,
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
      description: "The clip moves the declared nodes.",
      options: { min: 4, max: 12 },
    } as const),
    Object.freeze({
      name: "keyframe-count-in-range",
      description: "The clip carries a bounded keyframe set.",
      options: { min: 8, max: 48 },
    } as const),
    Object.freeze({
      name: "animation-duration-in-range",
      description: "The clip duration matches the gait.",
      options: { min: 0.5, max: 1.5 },
    } as const),
    Object.freeze({
      name: "animation-loop-policy",
      description: "The clip uses the declared loop policy.",
      options: { policy: "loop" },
    } as const),
    Object.freeze({
      name: "pivot-count-in-range",
      description: "The figure stays rigged.",
      options: { min: 8, max: 12 },
    } as const),
    Object.freeze({
      name: "joint-count-in-range",
      description: "The figure stays rigged.",
      options: { min: 8, max: 12 },
    } as const),
    Object.freeze({
      name: "node-present",
      description: "The left thigh node exists.",
      options: { nodeId: "node:rig:biped:leg-thigh-left" },
    } as const),
  ]);

const MANIFEST: SkillManifest = {
  manifestVersion: 1,
  name: "skill.run",
  version: "1.0.0",
  description: "locomotion of a rigged biped",
  kind: "motion",
  category: "run",
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
    scenarioId: "skill-run-v1",
    fixtureId: "motion-run",
    fixedPrompt: FIXED_PROMPT,
    structuralChecks: STRUCTURAL_CHECKS,
    visualBaselines: [],
    efficiency: EFFICIENCY,
  },
};

/** The authored skill.run motion-skill manifest (validated on load). */
export const RUN_SKILL_MANIFEST = Object.freeze(MANIFEST);
