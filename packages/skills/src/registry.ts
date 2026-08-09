import type {
  GeneratorContext,
  GeneratorDefinition,
  GeneratorProposal,
} from "./generator.js";
import {
  assembleProposal,
  parseGeneratorParams,
  unknownGenerator,
} from "./generator.js";
import { MIRROR_GENERATOR } from "./patterns/mirror.js";
import { LINEAR_REPEAT_GENERATOR } from "./patterns/linear-repeat.js";
import { RADIAL_REPEAT_GENERATOR } from "./patterns/radial-repeat.js";
import { STAIRS_GENERATOR } from "./patterns/stairs.js";
import { WALL_GENERATOR } from "./patterns/wall.js";
import { ROOF_GENERATOR } from "./patterns/roof.js";
import { BRANCHES_GENERATOR } from "./patterns/branches.js";
import { WHEEL_GENERATOR } from "./patterns/wheel.js";
import { LINKAGE_GENERATOR } from "./patterns/linkage.js";

/**
 * Generator registry (plan S14.3, ticket #37): the versioned v1
 * generator surface. Every definition is registered in stable order and
 * reached through one facade that validates params, derives
 * deterministic ids, preflights cost, and bounds the proposal.
 */

/** Every v1 generator definition in stable registry order. */
export const GENERATOR_DEFINITIONS: readonly GeneratorDefinition[] =
  Object.freeze([
    MIRROR_GENERATOR,
    LINEAR_REPEAT_GENERATOR,
    RADIAL_REPEAT_GENERATOR,
    STAIRS_GENERATOR,
    WALL_GENERATOR,
    ROOF_GENERATOR,
    BRANCHES_GENERATOR,
    WHEEL_GENERATOR,
    LINKAGE_GENERATOR,
  ]);

/** Looks up one generator definition by name. */
export function generatorByName(name: string): GeneratorDefinition | undefined {
  return GENERATOR_DEFINITIONS.find((definition) => definition.name === name);
}

/**
 * One-shot proposal facade: validates the raw params against the named
 * generator's versioned contract, maps them plus the explicit seed to
 * bounded generic commands, preflights the cumulative voxel cost, and
 * returns the frozen proposal. Throws `WorkspaceError` with stable codes
 * for unknown generators, invalid params, invalid context, and exceeded
 * budgets; never constructs partial or unbounded proposals.
 */
export function proposeGenerator(
  name: string,
  rawParams: unknown,
  context: GeneratorContext,
): GeneratorProposal {
  const definition = generatorByName(name);
  if (definition === undefined) unknownGenerator(name);
  const params = parseGeneratorParams(definition, rawParams);
  return assembleProposal(definition, params, context);
}
