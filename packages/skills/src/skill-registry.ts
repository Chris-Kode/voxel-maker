import { TOOL_DEFINITIONS, MUTATION_TOOL_CONTRACTS } from "@voxel-maker/agent";
import type { SkillEnvironment, SkillManifest } from "./manifest.js";
import { validateSkillManifest } from "./manifest.js";
import { GENERATOR_DEFINITIONS } from "./registry.js";
import { defineCreationSkill } from "./creation/define.js";
import { FURNITURE_SKILL_MANIFEST } from "./creation/furniture.js";
import { ARCHITECTURE_SKILL_MANIFEST } from "./creation/architecture.js";
import { VEGETATION_SKILL_MANIFEST } from "./creation/vegetation.js";
import { VEHICLE_SKILL_MANIFEST } from "./creation/vehicle.js";
import { HUMANOID_SKILL_MANIFEST } from "./creation/humanoid.js";
import { QUADRUPED_SKILL_MANIFEST } from "./creation/quadruped.js";
import { FLYING_CREATURE_SKILL_MANIFEST } from "./creation/flying-creature.js";

/**
 * Creation-skill registry (plan S14.1/S14.2/S14.6, ticket #38): the
 * removable versioned creation-skill catalog. Every skill is a frozen
 * manifest validated against the live tool and generator registries at
 * catalog load (manifest version, instructions, allowed tools,
 * constraints, generator compatibility, provenance, evaluation
 * metadata), so a broken skill fails fast at import. The catalog is
 * removable: no other package depends on it and no document references
 * it (plan S14.9 boundary test).
 */

/** Every registered agent tool name (inspection + mutation surface). */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    ...TOOL_DEFINITIONS.map((definition) => definition.contract.name),
    ...MUTATION_TOOL_CONTRACTS.map((contract) => contract.name),
  ]),
);

/** Every registered generator name. */
export const KNOWN_GENERATOR_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(GENERATOR_DEFINITIONS.map((definition) => definition.name)),
);

/** The skill environment the v1 catalog is validated against. */
export const SKILL_ENVIRONMENT: SkillEnvironment = Object.freeze({
  knownTools: KNOWN_TOOL_NAMES,
  knownGenerators: KNOWN_GENERATOR_NAMES,
});

/** Every creation skill of the v1 catalog, validated in stable order. */
export const CREATION_SKILLS: readonly SkillManifest[] = Object.freeze([
  defineCreationSkill(FURNITURE_SKILL_MANIFEST, SKILL_ENVIRONMENT),
  defineCreationSkill(ARCHITECTURE_SKILL_MANIFEST, SKILL_ENVIRONMENT),
  defineCreationSkill(VEGETATION_SKILL_MANIFEST, SKILL_ENVIRONMENT),
  defineCreationSkill(VEHICLE_SKILL_MANIFEST, SKILL_ENVIRONMENT),
  defineCreationSkill(HUMANOID_SKILL_MANIFEST, SKILL_ENVIRONMENT),
  defineCreationSkill(QUADRUPED_SKILL_MANIFEST, SKILL_ENVIRONMENT),
  defineCreationSkill(FLYING_CREATURE_SKILL_MANIFEST, SKILL_ENVIRONMENT),
]);

/** Looks up one creation skill by its stable name. */
export function skillByName(name: string): SkillManifest | undefined {
  return CREATION_SKILLS.find((skill) => skill.name === name);
}

/** Looks up the creation skill of one asset category. */
export function skillForCategory(
  category: SkillManifest["category"],
): SkillManifest | undefined {
  return CREATION_SKILLS.find((skill) => skill.category === category);
}

/**
 * Registers one new skill manifest: validates it against the live tool
 * and generator registries and returns the deep-frozen manifest, or
 * throws the stable validation error naming the failing dimension.
 */
export function registerSkill(value: unknown): SkillManifest {
  return validateSkillManifest(value, SKILL_ENVIRONMENT);
}
