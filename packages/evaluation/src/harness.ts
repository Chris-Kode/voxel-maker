import { CommandBus } from "@voxel-maker/commands";
import {
  canonicalAssetSemanticHash,
  type DocumentStoreHandle,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import {
  estimateCostUsd,
  resolveAgentBudgets,
  type AgentBudgets,
  type ProviderUsage,
} from "@voxel-maker/agent";
import {
  createAgentSession,
  createConsent,
  createInspector,
  createMutator,
  createPreviewRegistry,
  createPreviewSession,
  DeterministicProvider,
  DISCLOSURE_CATEGORIES,
  previewSessionId,
  type AgentEvent,
  type AgentLoopOptions,
  type AgentRunReason,
  type DeterministicStep,
  type ProviderConsent,
} from "@voxel-maker/agent";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import { canonicalDocumentJson } from "@voxel-maker/model";
import { WorkspaceError, type VolumeId } from "@voxel-maker/shared";
import type { IntAabb } from "@voxel-maker/math";
import {
  createChairStore,
  createEmptyScaffoldStore,
  createEvalSelectionPort,
  EVAL_IDS,
} from "./fixtures.js";
import { createRigFixtureStore } from "./rig-fixtures.js";
import {
  changedVoxels,
  occupiedMetrics,
  structuralIssues,
  type OccupiedMetrics,
} from "./metrics.js";
import { renderPreviewEvidence, type PreviewEvidenceSet } from "./previews.js";
import {
  computeScores,
  type GeometryEvalScores,
  type ToolLogEntry,
} from "./score.js";
import {
  evaluationVersions,
  RIG_EVALUATION_VERSION,
  type EvaluationVersions,
} from "./versions.js";
import {
  scenarioById,
  type ScenarioId,
  type ScenarioShape,
} from "./scenarios.js";
import {
  RIG_SCENARIOS,
  rigScenarioById,
  type RigScenarioId,
} from "./rig-scenarios.js";

/**
 * Fixed geometry evaluation harness (plan S12.12, ticket #35): runs one
 * scenario end to end — deterministic fixture store, injected selection
 * port, isolated preview session, recorded tool trace through the
 * DeterministicProvider, bounded agent loop, explicit Apply, structural
 * metrics, rendered previews, and the seven scoring dimensions. The
 * harness is deterministic: no network, no wall clock, no live model.
 */

/** Virtual clock whose sleep advances synchronously (deterministic runs). */
export class VirtualClock {
  #now = 0;
  now = (): number => this.#now;
  sleep = (ms: number): Promise<void> => {
    this.#now += ms;
    return Promise.resolve();
  };
}

/** Integrity evidence: live state must change only via one Apply. */
export interface IntegrityReport {
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly historyBefore: number;
  readonly historyAfter: number;
  /** True when live state changed although Apply failed or was skipped. */
  readonly partialCommit: boolean;
  /** Failed/skipped runs must leave the live store unchanged. */
  readonly zeroStateChangeOnFailure: boolean;
}

/** Run counters and proposal facts of one evaluation run. */
export interface RunReport {
  readonly ok: boolean;
  readonly state: string;
  readonly reason: AgentRunReason | undefined;
  readonly errorCode: string | undefined;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly stagedCommands: number;
  readonly voxelEstimate: number;
  readonly usage: ProviderUsage;
  readonly applyOk: boolean;
  readonly applyLabel: string | undefined;
  /**
   * Commands executed by the applied transaction (0 when nothing was
   * applied). Ticket #45 AC: evaluations track commands.
   */
  readonly appliedCommands: number;
  /**
   * Effective voxels changed by the applied proposal (ticket #45 AC).
   * Mirrors the efficiency score's effectiveChangedVoxels evidence; the
   * run report carries it so every eval tracks modified voxels directly.
   */
  readonly modifiedVoxels: number;
  /** Canonical output document JSON bytes after apply (ticket #45 AC). */
  readonly outputBytes: number;
  /** Virtual-clock duration of the run in ms (ticket #45 AC). */
  readonly durationMs: number;
  /** Estimated spend in USD when the provider model is priced. */
  readonly costUsd: number | undefined;
}

/** The complete recorded result of one scenario evaluation. */
export interface GeometryEvalResult {
  /**
   * Suite-manifest case id this result belongs to (issue #76): the
   * scenario id for golden cases, a suffixed id for adversarial traces.
   */
  readonly caseId: string;
  readonly scenarioId: ScenarioId | RigScenarioId;
  readonly scenario: ScenarioShape;
  readonly versions: EvaluationVersions;
  readonly run: RunReport;
  readonly scores: GeometryEvalScores;
  readonly toolLog: readonly ToolLogEntry[];
  readonly integrity: IntegrityReport;
  readonly metrics: {
    readonly before: OccupiedMetrics;
    readonly after: OccupiedMetrics;
    readonly structuralIssues: readonly string[];
  };
  readonly previews: {
    readonly before: PreviewEvidenceSet;
    readonly after: PreviewEvidenceSet;
  };
  readonly hashes: {
    readonly input: string;
    readonly output: string;
  };
}

export interface EvaluateScenarioOptions {
  readonly scenarioId: ScenarioId | RigScenarioId;
  /**
   * Suite-manifest case id of this run (issue #76); defaults to the
   * scenario id, i.e. the golden case of that scenario.
   */
  readonly caseId?: string;
  /** Recorded trace; defaults to the scenario's golden trace. */
  readonly script?: readonly DeterministicStep[];
  /** Optional lowerings of the fixed budget profile. */
  readonly budgets?: Partial<AgentBudgets>;
  /** Revision-conflict guard override (default: live stays current). */
  readonly isLiveCurrent?: () => boolean;
  /** Optional progress projection (headless UI). */
  readonly onEvent?: (event: AgentEvent) => void;
  /**
   * Cancels the run after this many executed tool calls (deterministic
   * cancellation trace; 0 = cancel before the first round).
   */
  readonly cancelAfterToolCalls?: number;
}

/** Builds a committed fixture store of a scenario. */
function createFixtureStore(scenario: ScenarioShape): {
  readonly store: DocumentStoreRead;
  readonly handle: DocumentStoreHandle;
} {
  switch (scenario.fixture) {
    case "empty-scaffold":
      return createEmptyScaffoldStore();
    case "chair":
      return createChairStore(false);
    case "chair-armrest":
      return createChairStore(true);
    case "chest-lid":
      return createRigFixtureStore("chest-lid", false);
    case "wheel":
      return createRigFixtureStore("wheel", false);
    case "wings":
      return createRigFixtureStore("wings", false);
    case "linked-arm":
      return createRigFixtureStore("linked-arm", false);
    case "abstract":
      return createRigFixtureStore("abstract", false);
    case "chest-lid-rigged":
      return createRigFixtureStore("chest-lid", true);
    case "wheel-rigged":
      return createRigFixtureStore("wheel", true);
    case "wings-rigged":
      return createRigFixtureStore("wings", true);
    case "linked-arm-rigged":
      return createRigFixtureStore("linked-arm", true);
    case "abstract-rigged":
      return createRigFixtureStore("abstract", true);
  }
}

/** The voxel scan volumes of a scenario (defaults to volume:main). */
function scanVolumesOf(
  scenario: ScenarioShape,
): readonly { readonly volumeId: VolumeId; readonly region: IntAabb }[] {
  return (
    scenario.scanVolumes ?? [
      { volumeId: EVAL_IDS.volumeMain, region: scenario.scanRegion },
    ]
  );
}

/** Canonical semantic hash of a committed store. */
function semanticHashOf(store: DocumentStoreRead): string {
  const document = store.getDocument();
  const volumes = new Map<VolumeId, VoxelVolumeReadView>();
  for (const key of Object.keys(document.volumes)) {
    const volumeId = key as VolumeId;
    const volume = store.getVolume(volumeId);
    if (volume !== undefined) volumes.set(volumeId, volume);
  }
  return canonicalAssetSemanticHash(document, volumes);
}

/** The fixed consent record of the deterministic suite provider. */
function suiteConsent(providerId: string, model: string): ProviderConsent {
  return createConsent({
    providerId,
    model,
    categories: DISCLOSURE_CATEGORIES,
    consentedAt: 0,
    expiresAt: 1_000_000_000_000,
  });
}

/** Routes a scenario id to the geometry or rig/animation suite. */
function scenarioByIdOrRig(id: ScenarioId | RigScenarioId): ScenarioShape {
  if (RIG_SCENARIOS.some((scenario) => scenario.id === id)) {
    return rigScenarioById(id as RigScenarioId);
  }
  return scenarioById(id as ScenarioId);
}

/** Runs one fixed scenario and returns the complete scored result. */
export async function evaluateScenario(
  options: EvaluateScenarioOptions,
): Promise<GeometryEvalResult> {
  const scenario = scenarioByIdOrRig(options.scenarioId);
  const clock = new VirtualClock();
  // The reference "before" state: a second identical fixture commit, so
  // the diff evidence never aliases the live store mutated by Apply.
  const beforeStore = createFixtureStore(scenario).store;
  const { handle } = createFixtureStore(scenario);
  const revisionBefore = handle.store.revision;
  const registry = createPreviewRegistry();
  const bus = new CommandBus(handle.store, registry, handle.writeCapability);
  const historyBefore = bus.historySnapshot().past.length;
  const preview = createPreviewSession({
    live: handle.store,
    applyBus: bus,
    sessionId: previewSessionId(`preview:eval:${scenario.id}`),
  });
  const inspector = createInspector({
    store: preview,
    capabilities: ["inspect"],
    port: createEvalSelectionPort(scenario.selection),
  });
  const mutator = createMutator({
    store: preview,
    registry,
    session: preview,
    capabilities: ["mutate"],
  });
  const provider = new DeterministicProvider({
    script: options.script ?? scenario.goldenTrace,
    providerId: "deterministic",
    model: "deterministic-model",
    clock,
    sleep: clock.sleep,
  });
  const consent = suiteConsent(provider.providerId, provider.defaultModel);
  const toolLog: ToolLogEntry[] = [];
  let executedToolCalls = 0;
  let cancelRequested = false;
  const onEvent = (event: AgentEvent): void => {
    if (event.kind === "tool") {
      executedToolCalls += 1;
      if (
        !cancelRequested &&
        options.cancelAfterToolCalls !== undefined &&
        executedToolCalls > options.cancelAfterToolCalls
      ) {
        cancelRequested = true;
        sessionHolder.session?.cancel();
      }
    }
    if (event.kind !== "tool") return;
    toolLog.push({
      tool: event.tool,
      ok: event.result.ok,
      ...(event.result.ok
        ? {}
        : {
            errorCode: event.result.error.code,
            errorFamily: event.result.error.family,
          }),
    });
    options.onEvent?.(event);
  };
  const sessionHolder: { session?: ReturnType<typeof createAgentSession> } = {};
  // Resolve/clamp the effective budget profile ONCE (issue #77): the
  // same immutable profile is enforced by the agent session and hashed
  // into the recorded versions, so provenance matches enforcement.
  const effectiveBudgets = resolveAgentBudgets(options.budgets);
  const loopOptions: AgentLoopOptions = {
    provider,
    inspector,
    mutator,
    preview,
    consent,
    userPrompt: scenario.prompt,
    clock,
    sleep: clock.sleep,
    budgets: effectiveBudgets,
    onEvent,
    ...(options.isLiveCurrent === undefined
      ? {}
      : { isLiveCurrent: options.isLiveCurrent }),
  };
  sessionHolder.session = createAgentSession(loopOptions);
  const inputHash = semanticHashOf(handle.store);
  const scans = scanVolumesOf(scenario);
  const primaryScan = scans[0] ?? {
    volumeId: EVAL_IDS.volumeMain,
    region: scenario.scanRegion,
  };
  const beforeMetrics = occupiedMetrics(
    beforeStore,
    primaryScan.volumeId,
    primaryScan.region,
  );
  const beforePreviews = renderPreviewEvidence(beforeStore);

  const result = await sessionHolder.session.run();
  const durationMs = clock.now();
  // Capture the staged proposal facts BEFORE apply (apply closes the
  // preview and releases its counters).
  const stagedCommands = result.ok ? result.stagedCommands : 0;
  const voxelEstimate = result.ok ? preview.voxelEstimate : 0;
  const usage = result.ok ? result.usage : { inputTokens: 0, outputTokens: 0 };
  // Overlay-clip playback evidence (plan S13.5): the staged clip is read
  // from the preview session and played (evaluated) BEFORE Apply; the
  // live store is never touched by playback. Apply closes the preview,
  // so the signals are evaluated here, before the live transaction.
  const playback =
    result.ok && scenario.playbackClipId !== undefined
      ? (() => {
          const clip = preview.overlayClip(scenario.playbackClipId);
          if (clip === undefined) return undefined;
          const failures: string[] = [];
          let passed = 0;
          for (const signal of scenario.playbackSignals ?? []) {
            if (signal.check(preview, clip)) {
              passed += 1;
            } else {
              failures.push(signal.name);
            }
          }
          return {
            clipId: clip.animationId,
            passed,
            failures,
            total: (scenario.playbackSignals ?? []).length,
          };
        })()
      : undefined;
  let applyOk = false;
  let applyLabel: string | undefined;
  let appliedCommands = 0;
  if (result.ok) {
    const applied = sessionHolder.session.apply({
      label: `AI eval: ${scenario.name}`,
    });
    applyOk = applied.ok;
    applyLabel = applied.ok ? `AI eval: ${scenario.name}` : undefined;
    if (applied.ok) {
      appliedCommands = applied.value.event.commandIds.length;
    }
  }
  const revisionAfter = handle.store.revision;
  const historyAfter = bus.historySnapshot().past.length;
  const effectiveChangedVoxels = scans.reduce(
    (sum, scan) =>
      sum +
      changedVoxels(beforeStore, handle.store, scan.volumeId, scan.region)
        .length,
    0,
  );
  const afterMetrics = occupiedMetrics(
    handle.store,
    primaryScan.volumeId,
    primaryScan.region,
  );
  const afterPreviews = renderPreviewEvidence(handle.store);
  const afterIssues = structuralIssues(handle.store);
  const scores = computeScores({
    scenario,
    runOk: result.ok,
    runReason: result.ok ? undefined : result.reason,
    applyOk,
    toolLog,
    rounds: result.ok ? result.rounds : 0,
    toolCalls: result.ok ? result.toolCalls : toolLog.length,
    commands: result.ok ? result.stagedCommands : 0,
    voxelEstimate,
    effectiveChangedVoxels,
    before: beforeStore,
    after: handle.store,
    beforeMetrics,
    afterMetrics,
    beforePreviews,
    afterPreviews,
    limitErrorCode: result.ok ? undefined : errorCodeOf(result.error),
    playback,
  });

  return {
    caseId: options.caseId ?? scenario.id,
    scenarioId: scenario.id as ScenarioId | RigScenarioId,
    scenario,
    versions: evaluationVersions({
      scenarioPrompt: scenario.prompt,
      fixtureVersion: scenario.fixtureVersion,
      inputDocumentHash: inputHash,
      providerId: provider.providerId,
      model: provider.defaultModel,
      budgets: effectiveBudgets,
      ...(scenario.playbackClipId === undefined
        ? {}
        : { evaluationVersion: RIG_EVALUATION_VERSION }),
    }),
    run: {
      ok: result.ok,
      state: result.state,
      reason: result.ok ? undefined : result.reason,
      errorCode: result.ok ? undefined : errorCodeOf(result.error),
      rounds: result.ok ? result.rounds : 0,
      toolCalls: result.ok ? result.toolCalls : toolLog.length,
      stagedCommands,
      voxelEstimate,
      usage,
      applyOk,
      applyLabel,
      appliedCommands,
      modifiedVoxels: effectiveChangedVoxels,
      outputBytes: new TextEncoder().encode(
        canonicalDocumentJson(handle.store.getDocument()),
      ).byteLength,
      durationMs,
      costUsd: estimateCostUsd(provider.defaultModel, usage),
    },
    scores,
    toolLog,
    integrity: {
      revisionBefore,
      revisionAfter,
      historyBefore,
      historyAfter,
      partialCommit: !applyOk && revisionAfter !== revisionBefore,
      zeroStateChangeOnFailure: applyOk || revisionAfter === revisionBefore,
    },
    metrics: {
      before: beforeMetrics,
      after: afterMetrics,
      structuralIssues: afterIssues,
    },
    previews: { before: beforePreviews, after: afterPreviews },
    hashes: {
      input: inputHash,
      output: semanticHashOf(handle.store),
    },
  };
}

function errorCodeOf(error: Error): string | undefined {
  if (error instanceof WorkspaceError) return error.code;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
