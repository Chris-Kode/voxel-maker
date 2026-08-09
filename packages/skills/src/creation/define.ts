import type { SkillManifest, SkillEnvironment } from "../manifest.js";
import { validateSkillManifest } from "../manifest.js";

/**
 * Creation-skill authoring helper (plan S14.6, ticket #38): every
 * creation skill is authored as one plain JSON-safe manifest and frozen
 * through the shared validator at module load, so a broken skill fails
 * fast at import time instead of at use time. The helper also carries
 * the shared allowed-tool set of the v1 creation surface.
 */

/** The shared allowed-tool set of the v1 creation skills. */
export const CREATION_TOOLS: readonly string[] = Object.freeze([
  // Inspection: bounded selection-first reads (plan S11.1-S11.4).
  "inspectSummary",
  "getSelection",
  "inspectHierarchy",
  "inspectNode",
  "inspectMaterials",
  "inspectBounds",
  "queryVoxels",
  "raycast",
  "searchNodes",
  "measureDistance",
  // Mutation: scene and material construction (plan S11.5/S11.6).
  "createNode",
  "deleteNode",
  "renameNode",
  "reparentNode",
  "setNodeTransform",
  "setNodeComponents",
  "setNodeMetadata",
  "createVolume",
  "deleteVolume",
  "createMaterial",
  "updateMaterial",
  "deleteMaterial",
  // Mutation: coarse generic geometry (never per-voxel streams).
  "fillBox",
  "fillSphere",
  "fillCylinder",
  "setVoxelBatch",
  "removeVoxelBatch",
  "replaceVoxelMaterial",
  "copyRegion",
  "deleteRegion",
  "translateRegion",
  "rotateRegion",
  "mirrorRegion",
]);

/** Validates and deep-freezes one creation-skill manifest. */
export function defineCreationSkill(
  manifest: SkillManifest,
  environment: SkillEnvironment,
): SkillManifest {
  return validateSkillManifest(manifest, environment);
}
