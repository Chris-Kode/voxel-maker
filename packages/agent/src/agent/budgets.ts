import { WorkspaceError } from "@voxel-maker/shared";
import type { ProviderUsage } from "../provider/types.js";

/**
 * Agent session budgets (plan S12.5, ADR-0009, ticket #33 AC): one
 * immutable budget profile bounds rounds, tokens, tool calls, commands,
 * output bytes, voxel changes, animation tracks/keyframes/clip duration,
 * elapsed time, and estimated provider spend. Every limit has a hard
 * default; callers may lower at composition time but never raise. The
 * ledger reserves BEFORE each allocation, so a violation leaves every
 * counter untouched (no forbidden side effects).
 */

/** Default agent session budgets (ARCHITECTURE.md AI-session table). */
export interface AgentBudgets {
  /** Maximum model rounds (provider requests). */
  readonly maxRounds: number;
  /** Maximum executed tool calls across the run. */
  readonly maxToolCalls: number;
  /** Maximum staged commands. */
  readonly maxCommands: number;
  /** Maximum cumulative proposed voxel changes. */
  readonly maxProposedVoxelChanges: number;
  /** Maximum proposed or modified animation tracks. */
  readonly maxTracks: number;
  /** Maximum proposed or modified keyframes. */
  readonly maxKeyframes: number;
  /** Maximum cumulative proposed clip duration in seconds. */
  readonly maxClipDurationSeconds: number;
  /** Maximum combined inspection and tool-result bytes. */
  readonly maxOutputBytes: number;
  /** Maximum input plus output tokens. */
  readonly maxTokens: number;
  /** Maximum elapsed wall time in milliseconds. */
  readonly maxDurationMs: number;
  /** Maximum estimated provider spend in USD. */
  readonly maxEstimatedCostUsd: number;
  /** Repeated-error cutoff: consecutive failures end the run. */
  readonly maxConsecutiveErrors: number;
  /** Maximum serialized bytes of one tool result fed back to the model. */
  readonly maxToolResultBytes: number;
  /** Maximum visual-refinement iterations (ADR-0009: three). */
  readonly maxVisualIterations: number;
  /** Maximum transmitted evidence images per session (ADR-0009: 12). */
  readonly maxImages: number;
}

/** ADR-0009-aligned hard defaults for one AI session. */
export const DEFAULT_AGENT_BUDGETS: AgentBudgets = Object.freeze({
  maxRounds: 16,
  maxToolCalls: 64,
  maxCommands: 1_024,
  maxProposedVoxelChanges: 1_000_000,
  maxTracks: 256,
  maxKeyframes: 10_000,
  maxClipDurationSeconds: 3_600,
  maxOutputBytes: 4_194_304,
  maxTokens: 128_000,
  maxDurationMs: 600_000,
  maxEstimatedCostUsd: 5,
  maxConsecutiveErrors: 3,
  maxToolResultBytes: 65_536,
  maxVisualIterations: 3,
  maxImages: 12,
});

/** Merges and clamps caller overrides into [0, default]. */
export function resolveAgentBudgets(
  overrides: Partial<AgentBudgets> | undefined,
): AgentBudgets {
  const merged = { ...DEFAULT_AGENT_BUDGETS, ...overrides };
  const clamped = {} as Record<string, number>;
  for (const key of Object.keys(DEFAULT_AGENT_BUDGETS)) {
    const value = (merged as Record<string, unknown>)[key];
    const max =
      (DEFAULT_AGENT_BUDGETS as unknown as Record<string, number>)[key] ?? 0;
    clamped[key] =
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.min(value, max))
        : max;
  }
  return Object.freeze(clamped) as unknown as AgentBudgets;
}

/** Stable LIMIT_EXCEEDED error naming resource, maximum, and request. */
export function budgetLimitError(
  resource: string,
  maximum: number,
  requested: number,
): WorkspaceError {
  return new WorkspaceError({
    family: "limit",
    code: "LIMIT_EXCEEDED",
    message: `Session budget exceeded: ${resource} (maximum ${String(maximum)}, requested ${String(requested)})`,
    context: { resource, maximum, requested },
  });
}

export type BudgetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: WorkspaceError };

function limit(
  resource: string,
  maximum: number,
  requested: number,
): { readonly ok: false; readonly error: WorkspaceError } {
  return { ok: false, error: budgetLimitError(resource, maximum, requested) };
}

/** Animation deltas reserved when staging animation-producing tools. */
export interface AnimationReservation {
  readonly tracks?: number;
  readonly keyframes?: number;
  readonly clipDurationSeconds?: number;
}

/**
 * Deterministic session budget ledger. `startedAt` comes from the
 * injected clock so duration enforcement is testable; every `reserve*`
 * method checks the bound first and only then mutates counters.
 */
export class BudgetLedger {
  readonly budgets: AgentBudgets;
  readonly #clock: { now(): number };
  readonly #startedAt: number;
  #rounds = 0;
  #toolCalls = 0;
  #commands = 0;
  #voxelChanges = 0;
  #tracks = 0;
  #keyframes = 0;
  #clipDurationSeconds = 0;
  #outputBytes = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #costUsd = 0;
  #consecutiveErrors = 0;
  #visualIterations = 0;
  #imagesSent = 0;

  constructor(budgets: AgentBudgets, clock: { now(): number }) {
    this.budgets = budgets;
    this.#clock = clock;
    this.#startedAt = clock.now();
  }

  get round(): number {
    return this.#rounds;
  }
  get toolCalls(): number {
    return this.#toolCalls;
  }
  get commands(): number {
    return this.#commands;
  }
  get voxelChanges(): number {
    return this.#voxelChanges;
  }
  get tracks(): number {
    return this.#tracks;
  }
  get keyframes(): number {
    return this.#keyframes;
  }
  get clipDurationSeconds(): number {
    return this.#clipDurationSeconds;
  }
  get outputBytes(): number {
    return this.#outputBytes;
  }
  get inputTokens(): number {
    return this.#inputTokens;
  }
  get outputTokens(): number {
    return this.#outputTokens;
  }
  get costUsd(): number {
    return this.#costUsd;
  }
  get consecutiveErrors(): number {
    return this.#consecutiveErrors;
  }
  get visualIterations(): number {
    return this.#visualIterations;
  }
  get imagesSent(): number {
    return this.#imagesSent;
  }
  get elapsedMs(): number {
    return this.#clock.now() - this.#startedAt;
  }
  get tokens(): number {
    return this.#inputTokens + this.#outputTokens;
  }

  #checkDuration(requested: number): BudgetResult {
    const elapsed = this.elapsedMs;
    if (elapsed > this.budgets.maxDurationMs) {
      return limit("duration", this.budgets.maxDurationMs, elapsed);
    }
    const after = elapsed + requested;
    if (after > this.budgets.maxDurationMs) {
      return limit("duration", this.budgets.maxDurationMs, after);
    }
    return { ok: true };
  }

  reserveRound(): BudgetResult {
    const duration = this.#checkDuration(0);
    if (!duration.ok) return duration;
    const next = this.#rounds + 1;
    if (next > this.budgets.maxRounds) {
      return limit("rounds", this.budgets.maxRounds, next);
    }
    this.#rounds = next;
    return { ok: true };
  }

  reserveToolCall(): BudgetResult {
    const duration = this.#checkDuration(0);
    if (!duration.ok) return duration;
    const next = this.#toolCalls + 1;
    if (next > this.budgets.maxToolCalls) {
      return limit("toolCalls", this.budgets.maxToolCalls, next);
    }
    this.#toolCalls = next;
    return { ok: true };
  }

  reserveCommand(voxelEstimate: number): BudgetResult {
    const duration = this.#checkDuration(0);
    if (!duration.ok) return duration;
    const nextCommands = this.#commands + 1;
    if (nextCommands > this.budgets.maxCommands) {
      return limit("commands", this.budgets.maxCommands, nextCommands);
    }
    const nextVoxels = this.#voxelChanges + voxelEstimate;
    if (nextVoxels > this.budgets.maxProposedVoxelChanges) {
      return limit(
        "proposedVoxelChanges",
        this.budgets.maxProposedVoxelChanges,
        nextVoxels,
      );
    }
    this.#commands = nextCommands;
    this.#voxelChanges = nextVoxels;
    return { ok: true };
  }

  reserveAnimation(reservation: AnimationReservation): BudgetResult {
    const duration = this.#checkDuration(0);
    if (!duration.ok) return duration;
    const tracks = reservation.tracks ?? 0;
    const keyframes = reservation.keyframes ?? 0;
    const seconds = reservation.clipDurationSeconds ?? 0;
    const nextTracks = this.#tracks + tracks;
    if (nextTracks > this.budgets.maxTracks) {
      return limit("tracks", this.budgets.maxTracks, nextTracks);
    }
    const nextKeyframes = this.#keyframes + keyframes;
    if (nextKeyframes > this.budgets.maxKeyframes) {
      return limit("keyframes", this.budgets.maxKeyframes, nextKeyframes);
    }
    const nextSeconds = this.#clipDurationSeconds + seconds;
    if (nextSeconds > this.budgets.maxClipDurationSeconds) {
      return limit(
        "clipDurationSeconds",
        this.budgets.maxClipDurationSeconds,
        nextSeconds,
      );
    }
    this.#tracks = nextTracks;
    this.#keyframes = nextKeyframes;
    this.#clipDurationSeconds = nextSeconds;
    return { ok: true };
  }

  reserveVisualIteration(): BudgetResult {
    const duration = this.#checkDuration(0);
    if (!duration.ok) return duration;
    const next = this.#visualIterations + 1;
    if (next > this.budgets.maxVisualIterations) {
      return limit("visualIterations", this.budgets.maxVisualIterations, next);
    }
    this.#visualIterations = next;
    return { ok: true };
  }

  /** Reserves one transmitted evidence image before it leaves the device. */
  reserveImage(): BudgetResult {
    const duration = this.#checkDuration(0);
    if (!duration.ok) return duration;
    const next = this.#imagesSent + 1;
    if (next > this.budgets.maxImages) {
      return limit("images", this.budgets.maxImages, next);
    }
    this.#imagesSent = next;
    return { ok: true };
  }

  /**
   * Releases a command/voxel reservation when staging the command failed
   * (the reserve-before-allocate rule keeps every counter untouched by
   * rejected allocations). Counters never go below zero.
   */
  releaseCommand(voxelEstimate: number): void {
    this.#commands = Math.max(0, this.#commands - 1);
    this.#voxelChanges = Math.max(0, this.#voxelChanges - voxelEstimate);
  }

  /** Releases an animation reservation after a failed stage. */
  releaseAnimation(reservation: AnimationReservation): void {
    this.#tracks = Math.max(0, this.#tracks - (reservation.tracks ?? 0));
    this.#keyframes = Math.max(
      0,
      this.#keyframes - (reservation.keyframes ?? 0),
    );
    this.#clipDurationSeconds = Math.max(
      0,
      this.#clipDurationSeconds - (reservation.clipDurationSeconds ?? 0),
    );
  }

  recordOutputBytes(units: number): BudgetResult {
    const next = this.#outputBytes + units;
    if (next > this.budgets.maxOutputBytes) {
      return limit("outputBytes", this.budgets.maxOutputBytes, next);
    }
    this.#outputBytes = next;
    return { ok: true };
  }

  recordUsage(usage: ProviderUsage): BudgetResult {
    const nextTokens =
      this.#inputTokens +
      usage.inputTokens +
      this.#outputTokens +
      usage.outputTokens;
    if (nextTokens > this.budgets.maxTokens) {
      return limit("tokens", this.budgets.maxTokens, nextTokens);
    }
    const cost = usage.estimatedCostUsd ?? 0;
    const nextCost = this.#costUsd + cost;
    if (nextCost > this.budgets.maxEstimatedCostUsd) {
      return limit(
        "estimatedCostUsd",
        this.budgets.maxEstimatedCostUsd,
        nextCost,
      );
    }
    this.#inputTokens += usage.inputTokens;
    this.#outputTokens += usage.outputTokens;
    this.#costUsd = nextCost;
    return { ok: true };
  }

  recordError(): BudgetResult {
    const next = this.#consecutiveErrors + 1;
    if (next > this.budgets.maxConsecutiveErrors) {
      return limit(
        "consecutiveErrors",
        this.budgets.maxConsecutiveErrors,
        next,
      );
    }
    this.#consecutiveErrors = next;
    return { ok: true };
  }

  resetErrors(): void {
    this.#consecutiveErrors = 0;
  }
}
