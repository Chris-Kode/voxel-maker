import type { SkillManifest } from "../manifest.js";
import { validateSkillManifest } from "../manifest.js";
import { SKILL_ENVIRONMENT } from "../environment.js";

/**
 * Rigging-skill authoring helper (plan S14.7, ticket #39): every
 * rigging skill is authored as one plain JSON-safe manifest and frozen
 * through the shared validator at module load, so a broken skill fails
 * fast at import time. The helper also carries the shared allowed-tool
 * set of the v1 rigging surface: generic hierarchy, pivot, joint, and
 * constraint tools plus the rigging inspection reads — and nothing else
 * (ticket #39 AC: rigging skills use only generic articulation tools,
 * never voxel or animation mutation).
 */

/** The shared allowed-tool set of the v1 rigging skills. */
export const RIGGING_TOOLS: readonly string[] = Object.freeze([
  // Inspection: bounded selection-first reads (plan S11.1-S11.4).
  "inspectSummary",
  "getSelection",
  "inspectHierarchy",
  "inspectNode",
  "inspectBounds",
  "inspectRigging",
  // Mutation: generic hierarchy (plan S11.5).
  "createNode",
  "deleteNode",
  "renameNode",
  "reparentNode",
  "setNodeTransform",
  "setNodeComponents",
  "setNodeMetadata",
  // Mutation: generic articulation surface (plan S13).
  "setNodePivot",
  "removeNodePivot",
  "addNodeJoint",
  "removeNodeJoint",
  "addConstraint",
  "setConstraint",
  "removeConstraint",
]);

/** Validates and deep-freezes one rigging-skill manifest. */
export function defineRiggingSkill(manifest: SkillManifest): SkillManifest {
  return validateSkillManifest(manifest, SKILL_ENVIRONMENT);
}
