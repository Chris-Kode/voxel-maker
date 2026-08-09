import type { SkillManifest } from "../manifest.js";
import { validateSkillManifest } from "../manifest.js";
import { SKILL_ENVIRONMENT } from "../environment.js";

/**
 * Motion-skill authoring helper (plan S14.8, ticket #39): every motion
 * skill is authored as one plain JSON-safe manifest and frozen through
 * the shared validator at module load, so a broken skill fails fast at
 * import time. The helper also carries the shared allowed-tool set of
 * the v1 motion surface: generic clips/tracks/keyframes mutation tools
 * plus the clip/track/keyframe inspection reads — and nothing else
 * (ticket #39 AC: motion skills use only generic animation tools,
 * never voxel, geometry, or rigging mutation).
 */

/** The shared allowed-tool set of the v1 motion skills. */
export const MOTION_TOOLS: readonly string[] = Object.freeze([
  // Inspection: bounded selection-first reads (plan S11.1-S11.4) plus
  // the clip/track/keyframe summaries (plan S13.2).
  "inspectSummary",
  "getSelection",
  "inspectHierarchy",
  "inspectNode",
  "inspectRigging",
  "inspectClips",
  "inspectTracks",
  "inspectKeyframes",
  // Mutation: generic animation surface (plan S10/S13.4).
  "createAnimation",
  "updateAnimation",
  "deleteAnimation",
  "addTrack",
  "removeTrack",
  "setTrackInterpolation",
  "setKeyframe",
  "moveKeyframe",
  "deleteKeyframe",
]);

/** Validates and deep-freezes one motion-skill manifest. */
export function defineMotionSkill(manifest: SkillManifest): SkillManifest {
  return validateSkillManifest(manifest, SKILL_ENVIRONMENT);
}
