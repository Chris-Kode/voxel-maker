/**
 * Public entry point of the skills package: removable versioned domain
 * knowledge above the generic engine (plan S14, tickets #37 and #38).
 * The surface ships deterministic procedural generators (each versioned
 * definition maps validated parameters plus an explicit seed to a
 * bounded list of proposed generic commands with a preflighted voxel
 * cost) and the versioned creation-skill catalog: validated manifests
 * with fixed instructions, allowed tools, constraints, generator
 * compatibility, provenance, and evaluation metadata (fixed prompts,
 * structural checks, visual baselines, command/tool efficiency limits).
 * Skills know nothing about renderers or the document; proposals are
 * staged, inspected, applied, discarded, undone, saved, and replayed
 * through the existing agent preview session and command bus seams, and
 * no saved document ever depends on the skill catalog (plan S14.9).
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

export {
  SKILL_MANIFEST_VERSION,
  SKILL_CATEGORIES,
  BASELINE_VIEWS,
  SKILL_CONSTRAINT_CAPS,
  INVALID_SKILL_MANIFEST_CODE,
  SKILL_MANIFEST_VERSION_CODE,
  SKILL_NAME_CODE,
  SKILL_VERSION_CODE,
  SKILL_INSTRUCTIONS_CODE,
  SKILL_TOOLS_CODE,
  SKILL_CONSTRAINTS_CODE,
  SKILL_GENERATOR_CODE,
  SKILL_PROVENANCE_CODE,
  SKILL_EVALUATION_CODE,
  validateSkillManifest,
  type BaselineView,
  type SkillCategory,
  type SkillConstraints,
  type SkillEfficiencyLimits,
  type SkillEnvironment,
  type SkillEvaluationMetadata,
  type SkillManifest,
  type SkillProvenance,
  type SkillStructuralCheck,
  type SkillVisualBaseline,
} from "./manifest.js";
export {
  STRUCTURAL_CHECKS,
  UNKNOWN_STRUCTURAL_CHECK_CODE,
  INVALID_CHECK_OPTIONS_CODE,
  regionOption,
  runStructuralChecks,
  structuralCheckByName,
  validateStructuralCheck,
  type CheckContext,
  type CheckResult,
  type StructuralCheckDefinition,
} from "./checks.js";
export {
  evaluateVisualBaselines,
  baselinesPassed,
  type BaselineEvidence,
  type BaselineResult,
} from "./baselines.js";
export {
  checkEfficiency,
  type EfficiencyDimension,
  type EfficiencyReport,
  type SkillRunStats,
} from "./efficiency.js";
export {
  SKILL_PROVENANCE_PREFIX,
  applyWithProvenance,
  parseProvenanceLabel,
  provenanceCorrelationId,
  provenanceLabel,
} from "./provenance.js";
export {
  CREATION_SKILLS,
  KNOWN_GENERATOR_NAMES,
  KNOWN_TOOL_NAMES,
  SKILL_ENVIRONMENT,
  registerSkill,
  skillByName,
  skillForCategory,
} from "./skill-registry.js";
export { CREATION_TOOLS } from "./creation/define.js";
export { FURNITURE_SKILL_MANIFEST } from "./creation/furniture.js";
export { ARCHITECTURE_SKILL_MANIFEST } from "./creation/architecture.js";
export { VEGETATION_SKILL_MANIFEST } from "./creation/vegetation.js";
export { VEHICLE_SKILL_MANIFEST } from "./creation/vehicle.js";
export { HUMANOID_SKILL_MANIFEST } from "./creation/humanoid.js";
export { QUADRUPED_SKILL_MANIFEST } from "./creation/quadruped.js";
export { FLYING_CREATURE_SKILL_MANIFEST } from "./creation/flying-creature.js";
