import { TOOL_DEFINITIONS, MUTATION_TOOL_CONTRACTS } from "@voxel-maker/agent";
import type { SkillEnvironment } from "./manifest.js";
import { GENERATOR_DEFINITIONS } from "./registry.js";
import { RIG_MOTION_FIXTURES } from "./rig-motion-fixtures.js";

/**
 * The live skill environment (plan S14.2, tickets #38 and #39): the
 * known agent tool names, generator names, and fixed evaluation fixture
 * ids the manifest validator resolves against. Kept in its own module
 * so the catalog, the authoring helper, and the registry share one
 * frozen environment without import cycles.
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

/** Every registered fixed evaluation fixture id (plan S14.10). */
export const KNOWN_FIXTURE_IDS: ReadonlySet<string> = Object.freeze(
  new Set(RIG_MOTION_FIXTURES.map((fixture) => fixture.id)),
);

/** The skill environment the v1 catalog is validated against. */
export const SKILL_ENVIRONMENT: SkillEnvironment = Object.freeze({
  knownTools: KNOWN_TOOL_NAMES,
  knownGenerators: KNOWN_GENERATOR_NAMES,
  knownFixtureIds: KNOWN_FIXTURE_IDS,
});
