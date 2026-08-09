/**
 * Public entry point of the agent package: bounded, provider-neutral AI
 * inspection tools (plan S11.1-S11.4, S11.9, S11.10, S11.12, S11.14;
 * ticket #31). The surface is deterministic, versioned by JSON-Schema
 * contracts, resource-bounded, authorized separately from mutation, and
 * testable headless without an LLM.
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
  isValidValue,
  schemaErrors,
  validateValue,
  type JsonSchema,
  type JsonSchemaType,
} from "./schema.js";
export type {
  EditorContextPort,
  EditorSelection,
  EditorSelectionSnapshot,
} from "./port.js";
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
