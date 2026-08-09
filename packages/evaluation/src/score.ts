import type { AgentRunReason } from "@voxel-maker/agent";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { MaterialId } from "@voxel-maker/shared";
import type { GeometryScenario } from "./scenarios.js";
import { EVAL_IDS, regionCoordinates, voxelKey } from "./fixtures.js";
import {
  changedMaterials,
  changedNodes,
  changedVoxels,
  structuralIssues,
  type OccupiedMetrics,
} from "./metrics.js";
import type { PreviewEvidenceSet } from "./previews.js";

/**
 * Scoring of the fixed evaluation suite (plan S12.2, ticket #35 AC):
 * seven dimensions — task completion, unrelated changes, command/tool
 * efficiency, invalid calls, limit failures, semantic structure, and
 * rendered previews. Every dimension is a 0..1 score plus the evidence
 * that produced it, so a promotion report states exactly why a run
 * passed or failed.
 */

/** One recorded tool call of a run. */
export interface ToolLogEntry {
  readonly tool: string;
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly errorFamily?: string;
}

export interface TaskCompletionScore {
  readonly score: number;
  readonly passed: number;
  readonly total: number;
  readonly failures: readonly string[];
}

export interface UnrelatedChangesScore {
  readonly score: number;
  readonly changedVoxels: number;
  readonly unrelatedVoxels: number;
  readonly voxelScore: number;
  readonly materialChanges: readonly {
    readonly materialId: string;
    readonly kind: "added" | "removed" | "updated";
  }[];
  readonly unrelatedMaterialChanges: number;
  readonly materialScore: number;
  readonly changedNodeIds: readonly string[];
  readonly nodeScore: number;
}

export interface EfficiencyScore {
  readonly score: number;
  readonly toolCalls: number;
  readonly rounds: number;
  readonly commands: number;
  readonly goldenToolCalls: number;
  readonly goldenRounds: number;
  readonly goldenCommands: number;
  /** Proposed voxel changes reserved by the staged commands. */
  readonly voxelEstimate: number;
  /** Effective voxel changes of the applied document (before -> after). */
  readonly effectiveChangedVoxels: number;
  /**
   * 1 when the estimate bounds the effective change; partial credit when
   * the proposal under-estimates its real footprint (an unsafe planning
   * signal). Conservative over-estimation is not penalized: coarse
   * operations (for example a copy whose target overlaps existing
   * same-material voxels) legitimately reserve more than the final diff.
   */
  readonly estimateBoundCompliance: number;
}

export interface InvalidCallsScore {
  readonly score: number;
  readonly invalidCalls: number;
  readonly totalCalls: number;
  /** error code -> count (UNKNOWN_TOOL, INVALID_ARGUMENT, ...). */
  readonly categories: Readonly<Record<string, number>>;
}

export interface LimitFailuresScore {
  readonly score: number;
  readonly limitFailure: boolean;
  readonly runReason: AgentRunReason | undefined;
  readonly errorCode: string | undefined;
}

export interface SemanticStructureScore {
  readonly score: number;
  readonly passed: number;
  readonly total: number;
  readonly issues: readonly string[];
}

export interface RenderedPreviewsScore {
  readonly score: number;
  readonly passed: number;
  readonly total: number;
  readonly failures: readonly string[];
}

/** The seven scoring dimensions, in canonical order. */
export const SCORE_DIMENSIONS = [
  "taskCompletion",
  "unrelatedChanges",
  "efficiency",
  "invalidCalls",
  "limitFailures",
  "semanticStructure",
  "renderedPreviews",
] as const;

/** One scoring dimension id. */
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

/** All seven scoring dimensions of one run. */
export interface GeometryEvalScores {
  readonly taskCompletion: TaskCompletionScore;
  readonly unrelatedChanges: UnrelatedChangesScore;
  readonly efficiency: EfficiencyScore;
  readonly invalidCalls: InvalidCallsScore;
  readonly limitFailures: LimitFailuresScore;
  readonly semanticStructure: SemanticStructureScore;
  readonly renderedPreviews: RenderedPreviewsScore;
}

/** Inputs every score dimension needs. */
export interface ScoreInputs {
  readonly scenario: GeometryScenario;
  readonly runOk: boolean;
  readonly runReason: AgentRunReason | undefined;
  readonly applyOk: boolean;
  readonly toolLog: readonly ToolLogEntry[];
  readonly rounds: number;
  readonly toolCalls: number;
  readonly commands: number;
  readonly voxelEstimate: number;
  readonly effectiveChangedVoxels: number;
  readonly before: DocumentStoreRead;
  readonly after: DocumentStoreRead;
  readonly beforeMetrics: OccupiedMetrics;
  readonly afterMetrics: OccupiedMetrics;
  readonly beforePreviews: PreviewEvidenceSet;
  readonly afterPreviews: PreviewEvidenceSet;
  readonly limitErrorCode: string | undefined;
}

function scoreOf(passed: number, total: number): number {
  return total === 0 ? 1 : passed / total;
}

/** Task completion: fraction of semantic checks that pass. */
function scoreTaskCompletion(
  scenario: GeometryScenario,
  after: DocumentStoreRead,
): TaskCompletionScore {
  const failures: string[] = [];
  let passed = 0;
  for (const check of scenario.taskChecks) {
    if (check.check(after)) {
      passed += 1;
    } else {
      failures.push(check.name);
    }
  }
  return {
    score: scoreOf(passed, scenario.taskChecks.length),
    passed,
    total: scenario.taskChecks.length,
    failures,
  };
}

/** Unrelated changes: voxel, material, and node diffs outside allowances. */
function scoreUnrelatedChanges(
  scenario: GeometryScenario,
  before: DocumentStoreRead,
  after: DocumentStoreRead,
): UnrelatedChangesScore {
  const changed = changedVoxels(
    before,
    after,
    EVAL_IDS.volumeMain,
    scenario.scanRegion,
  );
  const allowed = new Set(
    regionCoordinates(scenario.allowedChangedRegion).map(voxelKey),
  );
  const expected = new Set<string>();
  for (const region of scenario.expectedShape) {
    for (const coordinate of regionCoordinates(region)) {
      expected.add(voxelKey(coordinate));
    }
  }
  // Voxel changes outside the allowed region are unrelated. For
  // create-from-scaffold every change is allowed, so the expected shape
  // acts as the allowance: voxels occupied outside the chair shape are
  // unrelated extras.
  let unrelated = 0;
  for (const coordinate of changed) {
    const key = voxelKey(coordinate);
    if (!allowed.has(key)) {
      unrelated += 1;
      continue;
    }
    if (scenario.strictShape && !expected.has(key)) {
      unrelated += 1;
    }
  }
  const voxelScore = changed.length === 0 ? 1 : 1 - unrelated / changed.length;

  const materialChanges = changedMaterials(
    before.getDocument(),
    after.getDocument(),
  );
  const allowedAdded = new Set(
    scenario.allowedAddedMaterials.map((id: MaterialId) => String(id)),
  );
  const unrelatedMaterialChanges = materialChanges.filter(
    (change) =>
      !(change.kind === "added" && allowedAdded.has(change.materialId)),
  ).length;
  const materialScore =
    materialChanges.length === 0
      ? 1
      : 1 - unrelatedMaterialChanges / materialChanges.length;

  const changedNodeIds = changedNodes(
    before.getDocument(),
    after.getDocument(),
  );
  const nodeScore = changedNodeIds.length === 0 ? 1 : 0;

  return {
    score: voxelScore * materialScore * nodeScore,
    changedVoxels: changed.length,
    unrelatedVoxels: unrelated,
    voxelScore,
    materialChanges,
    unrelatedMaterialChanges,
    materialScore,
    changedNodeIds,
    nodeScore,
  };
}

/** Ratio of golden to actual counts; zero work scores 0 (not 1). */
function ratioOf(golden: number, actual: number): number {
  if (golden <= 0) return actual <= 0 ? 1 : 0;
  if (actual <= 0) return 0;
  return Math.min(1, golden / actual);
}

/** Efficiency: tool-call, round, and command counts vs the golden trace. */
function scoreEfficiency(
  scenario: GeometryScenario,
  rounds: number,
  toolCalls: number,
  commands: number,
  voxelEstimate: number,
  effectiveChangedVoxels: number,
): EfficiencyScore {
  const toolRatio = ratioOf(scenario.goldenToolCalls, toolCalls);
  const roundRatio = ratioOf(scenario.goldenRounds, rounds);
  const commandRatio = ratioOf(scenario.goldenCommands, commands);
  const estimateBoundCompliance =
    effectiveChangedVoxels <= voxelEstimate
      ? 1
      : Math.max(
          0,
          1 -
            (effectiveChangedVoxels - voxelEstimate) /
              Math.max(1, effectiveChangedVoxels),
        );
  return {
    score:
      0.35 * toolRatio +
      0.25 * roundRatio +
      0.25 * commandRatio +
      0.15 * estimateBoundCompliance,
    toolCalls,
    rounds,
    commands,
    goldenToolCalls: scenario.goldenToolCalls,
    goldenRounds: scenario.goldenRounds,
    goldenCommands: scenario.goldenCommands,
    voxelEstimate,
    effectiveChangedVoxels,
    estimateBoundCompliance,
  };
}

/** Invalid calls: schema-invalid and unknown tool calls over the run. */
function scoreInvalidCalls(
  toolLog: readonly ToolLogEntry[],
): InvalidCallsScore {
  const invalid = toolLog.filter((entry) => !entry.ok);
  const categories: Record<string, number> = {};
  for (const entry of invalid) {
    const code = entry.errorCode ?? "UNKNOWN_ERROR";
    categories[code] = (categories[code] ?? 0) + 1;
  }
  return {
    score: toolLog.length === 0 ? 1 : 1 - invalid.length / toolLog.length,
    invalidCalls: invalid.length,
    totalCalls: toolLog.length,
    categories,
  };
}

/** Limit failures: any budget/limit error surfaced during the run. */
function scoreLimitFailures(
  runOk: boolean,
  runReason: AgentRunReason | undefined,
  toolLog: readonly ToolLogEntry[],
  limitErrorCode: string | undefined,
): LimitFailuresScore {
  const toolLimit = toolLog.some(
    (entry) => !entry.ok && entry.errorFamily === "limit",
  );
  const limitFailure = !runOk && runReason === "limit";
  return {
    score: limitFailure || toolLimit ? 0 : 1,
    limitFailure: limitFailure || toolLimit,
    runReason,
    errorCode: limitErrorCode,
  };
}

/** Semantic structure: validity, references, bounds, and material usage. */
function scoreSemanticStructure(
  after: DocumentStoreRead,
  afterMetrics: OccupiedMetrics,
): SemanticStructureScore {
  const issues = [...structuralIssues(after)];
  const checks: { name: string; ok: boolean }[] = [
    {
      name: "document structure validates with no issues",
      ok: issues.length === 0,
    },
    {
      name: "occupied bounds stay inside the volume bounds",
      ok: boundsInsideVolume(after, afterMetrics),
    },
    {
      name: "every used material exists in the document",
      ok: usedMaterialsExist(after, afterMetrics),
    },
  ];
  const passed = checks.filter((check) => check.ok).length;
  return {
    score: scoreOf(passed, checks.length),
    passed,
    total: checks.length,
    issues,
  };
}

function boundsInsideVolume(
  after: DocumentStoreRead,
  afterMetrics: OccupiedMetrics,
): boolean {
  const bounds = afterMetrics.bounds;
  if (bounds === undefined) return true;
  const volume = after.getDocument().volumes[afterMetrics.volumeId];
  if (volume === undefined || volume.bounds === undefined) return false;
  const declared = volume.bounds;
  return (
    bounds.min[0] >= declared.min[0] &&
    bounds.min[1] >= declared.min[1] &&
    bounds.min[2] >= declared.min[2] &&
    bounds.max[0] <= declared.max[0] &&
    bounds.max[1] <= declared.max[1] &&
    bounds.max[2] <= declared.max[2]
  );
}

function usedMaterialsExist(
  after: DocumentStoreRead,
  afterMetrics: OccupiedMetrics,
): boolean {
  const materials = after.getDocument().materials;
  for (const key of Object.keys(afterMetrics.materialCounts)) {
    if (materials[key as unknown as MaterialId] === undefined) return false;
  }
  return true;
}

/** Rendered previews: the scenario's signals over before/after evidence. */
function scoreRenderedPreviews(
  scenario: GeometryScenario,
  beforePreviews: PreviewEvidenceSet,
  afterPreviews: PreviewEvidenceSet,
): RenderedPreviewsScore {
  const failures: string[] = [];
  let passed = 0;
  for (const signal of scenario.previewSignals) {
    if (signal.check(beforePreviews, afterPreviews)) {
      passed += 1;
    } else {
      failures.push(signal.name);
    }
  }
  return {
    score: scoreOf(passed, scenario.previewSignals.length),
    passed,
    total: scenario.previewSignals.length,
    failures,
  };
}

/** Computes every scoring dimension for one scenario run. */
export function computeScores(inputs: ScoreInputs): GeometryEvalScores {
  const taskCompletion = scoreTaskCompletion(inputs.scenario, inputs.after);
  const unrelatedChanges = scoreUnrelatedChanges(
    inputs.scenario,
    inputs.before,
    inputs.after,
  );
  const efficiency = scoreEfficiency(
    inputs.scenario,
    inputs.rounds,
    inputs.toolCalls,
    inputs.commands,
    inputs.voxelEstimate,
    inputs.effectiveChangedVoxels,
  );
  const invalidCalls = scoreInvalidCalls(inputs.toolLog);
  const limitFailures = scoreLimitFailures(
    inputs.runOk,
    inputs.runReason,
    inputs.toolLog,
    inputs.limitErrorCode,
  );
  const semanticStructure = scoreSemanticStructure(
    inputs.after,
    inputs.afterMetrics,
  );
  const renderedPreviews = scoreRenderedPreviews(
    inputs.scenario,
    inputs.beforePreviews,
    inputs.afterPreviews,
  );
  return {
    taskCompletion,
    unrelatedChanges,
    efficiency,
    invalidCalls,
    limitFailures,
    semanticStructure,
    renderedPreviews,
  };
}
