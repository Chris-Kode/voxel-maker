/**
 * Public entry point of the fixed geometry evaluation package (plan
 * S12.12, ticket #35): the deterministic harness that validates initial
 * AI geometry workflows — chair creation, shorter legs, a red seat, and
 * left-side mirroring — from fixed starting documents and selections,
 * using recorded tool traces through the deterministic provider. Each
 * result records provider/model/prompt/tool-schema/fixture/budget
 * versions, scores seven dimensions (task completion, unrelated changes,
 * command/tool efficiency, invalid calls, limit failures, semantic
 * structure, rendered previews), and is gated by explicit promotion
 * thresholds plus a changed-baseline review process.
 */
export {
  EVALUATION_BUDGETS,
  EVALUATION_VERSION,
  PROVIDER_VERSION,
  SYSTEM_PROMPT_VERSION,
  TOOL_SCHEMA_VERSIONS,
  budgetHash,
  evaluationVersions,
  promptVersion,
  type EvaluationVersions,
} from "./versions.js";
export {
  CHAIR_LEGS,
  CHAIR_REGIONS,
  CHAIR_SHAPE,
  CHAIR_SHAPE_WITH_ARMREST,
  EVAL_IDS,
  EVAL_RED_COLOR,
  EVAL_WOOD_COLOR,
  commitFixtureVoxels,
  createChairDocument,
  createChairStore,
  createEmptyScaffoldDocument,
  createEmptyScaffoldStore,
  createEvalSelectionPort,
  regionCoordinates,
  regionSelection,
  shapeEntries,
} from "./fixtures.js";
export {
  changedMaterials,
  changedNodes,
  changedVoxels,
  colorUsed,
  occupiedMetrics,
  regionEmpty,
  regionFilled,
  regionHasMaterial,
  structuralIssues,
  symmetryScore,
  type OccupiedMetrics,
} from "./metrics.js";
export {
  EVAL_PREVIEW_SIZE,
  changedPixelRatio,
  redPixelRatio,
  renderPreviewEvidence,
  silhouetteCount,
  silhouetteOverlap,
  silhouetteSimilarity,
  type PreviewEvidenceSet,
  type RenderedPreviewEvidence,
} from "./previews.js";
export {
  GEOMETRY_SCENARIOS,
  scenarioById,
  type GeometryScenario,
  type PreviewSignal,
  type ScenarioId,
  type ScenarioShape,
  type TaskCheck,
} from "./scenarios.js";
export {
  computeScores,
  type EfficiencyScore,
  type GeometryEvalScores,
  type InvalidCallsScore,
  type LimitFailuresScore,
  type RenderedPreviewsScore,
  type SemanticStructureScore,
  type TaskCompletionScore,
  type ToolLogEntry,
  type UnrelatedChangesScore,
} from "./score.js";
export {
  VirtualClock,
  evaluateScenario,
  type EvaluateScenarioOptions,
  type GeometryEvalResult,
  type IntegrityReport,
  type RunReport,
} from "./harness.js";
export {
  PROMOTION_THRESHOLDS,
  RECORDED_BASELINES,
  evaluatePromotion,
  recordedBaseline,
  type BaselineRecord,
  type BaselineRegression,
  type PromotionReport,
  type ThresholdResult,
} from "./promotion.js";
export {
  EVALUATION_SUITE_MANIFEST,
  suiteCaseById,
  type ExpectedOutcome,
  type SuiteCase,
  type SuiteManifest,
} from "./suite.js";
