import type { SkillManifest, SkillKind } from "./manifest.js";
import { validateSkillManifest } from "./manifest.js";
import { defineCreationSkill } from "./creation/define.js";
import { FURNITURE_SKILL_MANIFEST } from "./creation/furniture.js";
import { ARCHITECTURE_SKILL_MANIFEST } from "./creation/architecture.js";
import { VEGETATION_SKILL_MANIFEST } from "./creation/vegetation.js";
import { VEHICLE_SKILL_MANIFEST } from "./creation/vehicle.js";
import { HUMANOID_SKILL_MANIFEST } from "./creation/humanoid.js";
import { QUADRUPED_SKILL_MANIFEST } from "./creation/quadruped.js";
import { FLYING_CREATURE_SKILL_MANIFEST } from "./creation/flying-creature.js";
import { defineRiggingSkill } from "./rigging/define.js";
import { BIPED_RIG_SKILL_MANIFEST } from "./rigging/biped.js";
import { QUADRUPED_RIG_SKILL_MANIFEST } from "./rigging/quadruped.js";
import { WINGS_RIG_SKILL_MANIFEST } from "./rigging/wings.js";
import { MECHANICAL_LINKAGE_RIG_SKILL_MANIFEST } from "./rigging/mechanical-linkage.js";
import { defineMotionSkill } from "./motion/define.js";
import { WALK_SKILL_MANIFEST } from "./motion/walk.js";
import { RUN_SKILL_MANIFEST } from "./motion/run.js";
import { JUMP_SKILL_MANIFEST } from "./motion/jump.js";
import { IDLE_SKILL_MANIFEST } from "./motion/idle.js";
import { FLY_SKILL_MANIFEST } from "./motion/fly.js";
import { MECHANICAL_MOTION_SKILL_MANIFEST } from "./motion/mechanical.js";
import { SKILL_ENVIRONMENT } from "./environment.js";

/**
 * Skill registry (plan S14.1/S14.2/S14.6-S14.8, tickets #38 and #39):
 * the removable versioned skill catalog — creation, rigging, and motion
 * skills. Every skill is a frozen manifest validated against the live
 * tool and generator registries at catalog load (manifest version, kind,
 * instructions, allowed tools, constraints, generator compatibility,
 * provenance, evaluation metadata), so a broken skill fails fast at
 * import. The catalog is removable: no other package depends on it and
 * no document references it (plan S14.9 boundary test).
 */

/** Every creation skill of the v1 catalog, validated in stable order. */
export const CREATION_SKILLS: readonly SkillManifest[] = Object.freeze([
  defineCreationSkill(FURNITURE_SKILL_MANIFEST),
  defineCreationSkill(ARCHITECTURE_SKILL_MANIFEST),
  defineCreationSkill(VEGETATION_SKILL_MANIFEST),
  defineCreationSkill(VEHICLE_SKILL_MANIFEST),
  defineCreationSkill(HUMANOID_SKILL_MANIFEST),
  defineCreationSkill(QUADRUPED_SKILL_MANIFEST),
  defineCreationSkill(FLYING_CREATURE_SKILL_MANIFEST),
]);

/**
 * Every rigging skill of the v1 catalog (plan S14.7, ticket #39):
 * generic biped, quadruped, wings, and mechanical-linkage rigging
 * recipes over the hierarchy/pivot/joint/constraint surface.
 */
export const RIGGING_SKILLS: readonly SkillManifest[] = Object.freeze([
  defineRiggingSkill(BIPED_RIG_SKILL_MANIFEST),
  defineRiggingSkill(QUADRUPED_RIG_SKILL_MANIFEST),
  defineRiggingSkill(WINGS_RIG_SKILL_MANIFEST),
  defineRiggingSkill(MECHANICAL_LINKAGE_RIG_SKILL_MANIFEST),
]);

/**
 * Every motion skill of the v1 catalog (plan S14.8, ticket #39): walk,
 * run, jump, idle, fly, and mechanical-motion knowledge expressed as
 * generic clips/tracks/keyframes over existing rigs.
 */
export const MOTION_SKILLS: readonly SkillManifest[] = Object.freeze([
  defineMotionSkill(WALK_SKILL_MANIFEST),
  defineMotionSkill(RUN_SKILL_MANIFEST),
  defineMotionSkill(JUMP_SKILL_MANIFEST),
  defineMotionSkill(IDLE_SKILL_MANIFEST),
  defineMotionSkill(FLY_SKILL_MANIFEST),
  defineMotionSkill(MECHANICAL_MOTION_SKILL_MANIFEST),
]);

/** Every v1 skill of every knowledge kind, in stable kind order. */
export const ALL_SKILLS: readonly SkillManifest[] = Object.freeze([
  ...CREATION_SKILLS,
  ...RIGGING_SKILLS,
  ...MOTION_SKILLS,
]);

/** Looks up one skill by its stable name (any knowledge kind). */
export function skillByName(name: string): SkillManifest | undefined {
  return ALL_SKILLS.find((skill) => skill.name === name);
}

/** Looks up the skills of one knowledge kind. */
export function skillsByKind(kind: SkillKind): readonly SkillManifest[] {
  switch (kind) {
    case "creation":
      return CREATION_SKILLS;
    case "rigging":
      return RIGGING_SKILLS;
    case "motion":
      return MOTION_SKILLS;
  }
}

/** Looks up the skill of one category (any knowledge kind). */
export function skillForCategory(
  category: SkillManifest["category"],
): SkillManifest | undefined {
  return ALL_SKILLS.find((skill) => skill.category === category);
}

/**
 * Registers one new skill manifest: validates it against the live tool
 * and generator registries and returns the deep-frozen manifest, or
 * throws the stable validation error naming the failing dimension.
 */
export function registerSkill(value: unknown): SkillManifest {
  return validateSkillManifest(value, SKILL_ENVIRONMENT);
}
