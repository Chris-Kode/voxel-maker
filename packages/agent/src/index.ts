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
  ADD_CONSTRAINT_CONTRACT,
  ADD_NODE_JOINT_CONTRACT,
  ADD_TRACK_CONTRACT,
  CREATE_ANIMATION_CONTRACT,
  CREATE_MATERIAL_CONTRACT,
  CREATE_NODE_CONTRACT,
  CREATE_VOLUME_CONTRACT,
  DELETE_ANIMATION_CONTRACT,
  DELETE_KEYFRAME_CONTRACT,
  DELETE_MATERIAL_CONTRACT,
  DELETE_NODE_CONTRACT,
  DELETE_REGION_CONTRACT,
  DELETE_VOLUME_CONTRACT,
  FILL_BOX_CONTRACT,
  FILL_CYLINDER_CONTRACT,
  FILL_SPHERE_CONTRACT,
  MIRROR_REGION_CONTRACT,
  MOVE_KEYFRAME_CONTRACT,
  REMOVE_CONSTRAINT_CONTRACT,
  REMOVE_NODE_JOINT_CONTRACT,
  REMOVE_NODE_PIVOT_CONTRACT,
  REMOVE_TRACK_CONTRACT,
  REMOVE_VOXEL_BATCH_CONTRACT,
  RENAME_NODE_CONTRACT,
  REPARENT_NODE_CONTRACT,
  REPLACE_VOXEL_MATERIAL_CONTRACT,
  ROTATE_REGION_CONTRACT,
  SET_CONSTRAINT_CONTRACT,
  SET_KEYFRAME_CONTRACT,
  SET_NODE_COMPONENTS_CONTRACT,
  SET_NODE_METADATA_CONTRACT,
  SET_NODE_PIVOT_CONTRACT,
  SET_NODE_TRANSFORM_CONTRACT,
  SET_TRACK_INTERPOLATION_CONTRACT,
  SET_VOXEL_BATCH_CONTRACT,
  TRANSLATE_REGION_CONTRACT,
  UPDATE_ANIMATION_CONTRACT,
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

export {
  animationContextRecipe,
  composeAgentContextBlock,
  rigContextRecipe,
  resolveRecipeOptions,
  type AgentContextBlock,
  type AnimationContextRecipe,
  type RecipeOptions,
  type RigContextRecipe,
} from "./recipes.js";
export {
  AGENT_SYSTEM_PROMPT,
  DEFAULT_CRITIQUE_PROMPT,
  createAgentSession,
  type AgentEvent,
  type AgentLoopOptions,
  type AgentRunReason,
  type AgentRunResult,
  type AgentSession,
  type VisualRefinementConfig,
} from "./agent/loop.js";
export {
  AGENT_STATES,
  AgentStateMachine,
  TERMINAL_STATES,
  TRANSITIONS,
  type AgentState,
} from "./agent/state.js";
export {
  DEFAULT_AGENT_BUDGETS,
  BudgetLedger,
  budgetLimitError,
  resolveAgentBudgets,
  type AgentBudgets,
  type AnimationReservation,
} from "./agent/budgets.js";
export {
  AgentTranscript,
  type RetentionDays,
  type TranscriptEntry,
  type TranscriptOptions,
  type TranscriptSnapshot,
} from "./agent/transcript.js";
export {
  DEFAULT_RETRY_POLICY,
  ProviderError,
  chatResponse,
  estimateImageTokens,
  estimateRequestTokens,
  estimateTextTokens,
  type ChatImage,
  isProviderError,
  isRetryable,
  shouldRetry,
  streamToResponse,
  validateToolCall,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderChatRequest,
  type ProviderErrorData,
  type ProviderErrorFamily,
  type ProviderEvent,
  type ProviderFinishReason,
  type ProviderUsage,
  type RetryPolicy,
  type ToolCall,
  type ToolCallResult,
} from "./provider/types.js";
export {
  DeterministicProvider,
  type DeterministicProviderOptions,
  type DeterministicStep,
} from "./provider/deterministic.js";
export {
  OpenAIProvider,
  type OpenAIAdapterOptions,
} from "./provider/openai.js";
export {
  CONSENT_VERSION,
  DEFAULT_CONSENT_DURATION_MS,
  DISCLOSURE_CATEGORIES,
  MemoryConsentStore,
  consentCovers,
  consentExpired,
  consentRequiredError,
  createConsent,
  type ConsentInput,
  type ConsentStore,
  type DisclosureCategory,
  type ProviderConsent,
} from "./provider/consent.js";
export {
  KEYCHAIN_SERVICE,
  MemoryCredentialStore,
  Secret,
  secret,
  type CredentialReference,
  type CredentialStore,
} from "./provider/credentials.js";
export {
  REDACTION_MARKER,
  isRedacted,
  redactDiagnostics,
  redactJson,
  redactProviderPayload,
  redactSecrets,
} from "./provider/redact.js";
export {
  buildSessionDiagnostics,
  type SessionDiagnostics,
  type SessionDiagnosticsInput,
} from "./diagnostics.js";
export {
  OPENAI_ALLOWED_MODELS,
  OPENAI_MODEL_PRICES,
  estimateCostUsd,
  estimateReservedCostUsd,
  priceForModel,
  type ModelPrice,
} from "./provider/cost.js";

export {
  DEFAULT_EVIDENCE_SIZE,
  MAX_EVIDENCE_DIMENSION,
  MAX_EVIDENCE_IMAGES,
  MAX_EVIDENCE_PIXELS,
  STANDARD_VIEWS,
  buildEvidenceSet,
  maxPngBytes,
  validateEvidenceRequest,
  validateEvidenceSet,
  type EvidenceCapture,
  type EvidenceCaptureRequest,
  type StandardViewId,
  type VisualEvidenceImage,
  type VisualEvidenceSet,
} from "./vision/evidence.js";
export {
  measureStructure,
  structuralDelta,
  type StructuralBounds,
  type StructuralDelta,
  type StructuralMetrics,
} from "./vision/structural.js";
export {
  CRITIQUE_CATEGORIES,
  critiqueFromText,
  parseVisualCritique,
  type CritiqueCategory,
  type VisualCritique,
} from "./vision/critique.js";
export {
  DEFAULT_IMAGE_CONSENT_DURATION_MS,
  IMAGE_CONSENT_VERSION,
  MAX_IMAGES_PER_SESSION,
  MAX_VISUAL_ITERATIONS_PER_SESSION,
  MemoryImageConsentStore,
  PROVIDER_PRIVACY_POLICY,
  createImageConsent,
  createVisualRefinementPlan,
  estimateImagePassCostUsd,
  imageConsentCovers,
  imageConsentExpired,
  imageConsentRequiredError,
  planCoveredByConsent,
  type ImageConsentInput,
  type ImageConsentStore,
  type ImageTransmissionConsent,
  type ImageTransmissionRequest,
  type VisualRefinementPlan,
  type VisualRefinementPlanInput,
} from "./vision/image-consent.js";
export {
  DEFAULT_REFINEMENT_POLICY,
  evaluateRefinement,
  imageSimilarity,
  resolveRefinementPolicy,
  type EvaluationInput,
  type ImageSimilarity,
  type RefinementEvaluation,
  type RefinementPolicy,
  type ViewVisualComparison,
} from "./vision/evaluation.js";
export {
  createFakeEvidenceCapture,
  fakeSemanticHash,
} from "./vision/test-fixtures.js";
