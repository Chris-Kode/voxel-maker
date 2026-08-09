/**
 * Public entry point of the agent package: bounded, provider-neutral AI
 * tool surfaces. Inspection tools (plan S11.1-S11.4, S11.9, S11.10,
 * S11.12, S11.14; ticket #31) read the live document; mutation tools
 * (plan S11.5/S11.6, ticket #32) construct registered commands, and the
 * copy-on-write preview session (plan S11.11/S11.15, ticket #32) stages
 * them against an isolated overlay before one optimistic Apply. The whole
 * surface is deterministic, versioned by JSON-Schema contracts,
 * resource-bounded, authorized by capability, and testable headless
 * without an LLM.
 */
export {
  createInspector,
  type InspectionResult,
  type Inspector,
  type InspectorOptions,
} from "./inspector.js";
export {
  authorizeTools,
  contractByName,
  INSPECTION_CAPABILITY,
  INSPECTION_TOOL_CONTRACTS,
  TOOL_NOT_AUTHORIZED_CODE,
  UNKNOWN_TOOL_CODE,
} from "./registry.js";
export {
  BASE_RESPONSE_PROPERTIES,
  BASE_RESPONSE_REQUIRED,
  COORDINATE_CONVENTIONS,
  INSPECTION_CONTRACT_VERSION,
  INVALID_ARGUMENT_CODE,
  outputSchema,
  type ToolCapability,
  type ToolContract,
  type ToolError,
} from "./contract.js";
export {
  DEFAULT_INSPECTION_LIMITS,
  resolveInspectionLimits,
  type InspectionLimits,
} from "./limits.js";
export {
  ResponseBudget,
  boundedEmit,
  clampString,
  jsonUnits,
} from "./budget.js";
export {
  TOOL_DEFINITIONS,
  type ToolDefinition,
  type ToolHandler,
} from "./tools/definitions.js";
export {
  isValidValue,
  schemaErrors,
  validateValue,
  type JsonSchema,
  type JsonSchemaType,
} from "./schema.js";
export type { EditorContextPort, EditorSelectionSnapshot } from "./port.js";
export {
  createMutator,
  type ConstructedCommand,
  type MutationResult,
  type Mutator,
  type MutatorOptions,
} from "./mutator.js";
export {
  createPreviewSession,
  previewSessionId,
  type ApplyOptions,
  type DiffResult,
  type PreviewDiff,
  type PreviewSession,
  type PreviewSessionId,
  type PreviewSessionOptions,
  type StageManyResult,
  type StageResult,
  type StagedEntry,
} from "./preview.js";
export {
  MUTATION_CAPABILITY,
  MUTATION_TOOL_CONTRACTS,
  createPreviewRegistry,
} from "./registry.js";
export {
  DEFAULT_MUTATION_LIMITS,
  resolveMutationLimits,
  type MutationLimits,
} from "./limits.js";
export {
  MUTATION_CONTRACT_VERSION,
  MUTATION_LIMIT_CODE,
  mutationLimit,
  mutationOutputSchema,
} from "./contract.js";
export {
  CREATE_MATERIAL_CONTRACT,
  CREATE_NODE_CONTRACT,
  CREATE_VOLUME_CONTRACT,
  DELETE_MATERIAL_CONTRACT,
  DELETE_NODE_CONTRACT,
  DELETE_REGION_CONTRACT,
  DELETE_VOLUME_CONTRACT,
  FILL_BOX_CONTRACT,
  FILL_CYLINDER_CONTRACT,
  FILL_SPHERE_CONTRACT,
  MIRROR_REGION_CONTRACT,
  REMOVE_VOXEL_BATCH_CONTRACT,
  RENAME_NODE_CONTRACT,
  REPARENT_NODE_CONTRACT,
  REPLACE_VOXEL_MATERIAL_CONTRACT,
  ROTATE_REGION_CONTRACT,
  SET_NODE_COMPONENTS_CONTRACT,
  SET_NODE_METADATA_CONTRACT,
  SET_NODE_TRANSFORM_CONTRACT,
  SET_VOXEL_BATCH_CONTRACT,
  TRANSLATE_REGION_CONTRACT,
  UPDATE_MATERIAL_CONTRACT,
} from "./mutation/index.js";
export {
  INSPECT_SUMMARY_CONTRACT,
  GET_SELECTION_CONTRACT,
  INSPECT_HIERARCHY_CONTRACT,
  INSPECT_NODE_CONTRACT,
  INSPECT_MATERIALS_CONTRACT,
  INSPECT_BOUNDS_CONTRACT,
  QUERY_VOXELS_CONTRACT,
  RAYCAST_CONTRACT,
  INSPECT_RIGGING_CONTRACT,
  INSPECT_CLIPS_CONTRACT,
  INSPECT_TRACKS_CONTRACT,
  INSPECT_KEYFRAMES_CONTRACT,
  SEARCH_NODES_CONTRACT,
  MEASURE_DISTANCE_CONTRACT,
} from "./tools/index.js";
