/**
 * Public entry point of the skills package: removable versioned domain
 * knowledge above the generic engine (plan S14, ticket #37). This
 * surface ships deterministic procedural generators: each versioned
 * definition maps validated parameters plus an explicit seed to a
 * bounded list of proposed generic commands with a preflighted voxel
 * cost. Generators know nothing about renderers or asset categories and
 * emit only registered generic voxel/region commands, so proposals can
 * be previewed, inspected, applied, discarded, undone, saved, and
 * replayed through the existing agent preview session and command bus
 * seams.
 */
export {
  GENERATOR_CONTRACT_VERSION,
  DEFAULT_GENERATOR_LIMITS,
  UNKNOWN_GENERATOR_CODE,
  INVALID_GENERATOR_PARAMS_CODE,
  INVALID_GENERATOR_CONTEXT_CODE,
  GENERATOR_COMMAND_LIMIT_CODE,
  GENERATOR_VOXEL_LIMIT_CODE,
  assembleProposal,
  createCommandFactory,
  parseGeneratorParams,
  proposalCommandId,
  proposalFingerprint,
  resolveGeneratorLimits,
  unknownGenerator,
  validateGeneratorContext,
  type GeneratorCommandFactory,
  type GeneratorContext,
  type GeneratorDefinition,
  type GeneratorLimits,
  type GeneratorProposal,
} from "./generator.js";
export {
  GENERATOR_DEFINITIONS,
  generatorByName,
  proposeGenerator,
} from "./registry.js";
export { estimateCommandVoxels, estimateCommandsVoxels } from "./estimate.js";
export type { IntAabb, ShapeAxis, Vec3i } from "./geometry.js";
export { digestHex } from "./hash.js";

export type { MirrorParams } from "./patterns/mirror.js";
export type { LinearRepeatParams } from "./patterns/linear-repeat.js";
export type { RadialRepeatParams } from "./patterns/radial-repeat.js";
export type { StairsParams } from "./patterns/stairs.js";
export type { WallParams } from "./patterns/wall.js";
export type { RoofParams, RoofStyle } from "./patterns/roof.js";
export type { BranchesParams } from "./patterns/branches.js";
export type { WheelParams } from "./patterns/wheel.js";
export type { LinkageParams, LinkagePattern } from "./patterns/linkage.js";
