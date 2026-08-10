import { TOOL_DEFINITIONS, MUTATION_TOOL_CONTRACTS } from "@voxel-maker/agent";
import type { SkillEnvironment } from "./manifest.js";
import { GENERATOR_DEFINITIONS } from "./registry.js";
import { RIG_MOTION_FIXTURES } from "./rig-motion-fixtures.js";
import { ReadonlySetView } from "./readonly-collections.js";

/**
 * The live skill environment (plan S14.2, tickets #38 and #39): the
 * known agent tool names, generator names, and fixed evaluation fixture
 * ids the manifest validator resolves against. Kept in its own module
 * so the catalog, the authoring helper, and the registry share one
 * frozen environment without import cycles.
 *
 * The authoritative lookup collections are private to this module; the
 * exported values are read-only facade views over them (issue #108), so
 * a consumer can read the registered names but a mutation attempt can
 * never rewrite the validation decisions.
 */

/** Every registered agent tool name (inspection + mutation surface). */
const toolNames = new Set([
  ...TOOL_DEFINITIONS.map((definition) => definition.contract.name),
  ...MUTATION_TOOL_CONTRACTS.map((contract) => contract.name),
]);

/** Every registered generator name. */
const generatorNames = new Set(
  GENERATOR_DEFINITIONS.map((definition) => definition.name),
);

/** Every registered fixed evaluation fixture id (plan S14.10). */
const fixtureIds = new Set(RIG_MOTION_FIXTURES.map((fixture) => fixture.id));

/** Read-only view of the registered agent tool names. */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = Object.freeze(
  new ReadonlySetView(toolNames),
);

/** Read-only view of the registered generator names. */
export const KNOWN_GENERATOR_NAMES: ReadonlySet<string> = Object.freeze(
  new ReadonlySetView(generatorNames),
);

/** Read-only view of the registered fixed evaluation fixture ids. */
export const KNOWN_FIXTURE_IDS: ReadonlySet<string> = Object.freeze(
  new ReadonlySetView(fixtureIds),
);

/** The skill environment the v1 catalog is validated against. */
export const SKILL_ENVIRONMENT: SkillEnvironment = Object.freeze({
  knownTools: KNOWN_TOOL_NAMES,
  knownGenerators: KNOWN_GENERATOR_NAMES,
  knownFixtureIds: KNOWN_FIXTURE_IDS,
});
