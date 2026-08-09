import { type TransactionResult, type Command } from "@voxel-maker/commands";
import { WorkspaceError, type JsonValue } from "@voxel-maker/shared";
import type { Inspector } from "../inspector.js";
import type { Mutator } from "../mutator.js";
import { jsonUnits } from "../budget.js";
import { estimateReservedCostUsd } from "../provider/cost.js";
import {
  consentCovers,
  consentRequiredError,
  type ProviderConsent,
} from "../provider/consent.js";
import {
  DEFAULT_RETRY_POLICY,
  ProviderError,
  estimateRequestTokens,
  isProviderError,
  shouldRetry,
  validateToolCall,
  type ChatMessage,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderChatRequest,
  type ProviderUsage,
  type RetryPolicy,
  type ToolCall,
  type ToolCallResult,
} from "../provider/types.js";
import { toToolError } from "../contract.js";
import type { PreviewDiff, PreviewSession } from "../preview.js";
import {
  budgetLimitError,
  BudgetLedger,
  resolveAgentBudgets,
  type AgentBudgets,
  type AnimationReservation,
} from "./budgets.js";
import { AgentStateMachine, type AgentState } from "./state.js";
import { AgentTranscript, type TranscriptOptions } from "./transcript.js";

/**
 * Bounded provider-neutral agent loop (plan S12.5, ticket #33): one
 * session drives the explicit understand -> inspect -> plan -> stage ->
 * inspect-staged -> validate -> approve walk over the inspection and
 * mutation tool surfaces plus the isolated preview session, under one
 * immutable budget profile. The provider is an injected `ProviderAdapter`
 * (never a vendor type), tool calls are validated against the neutral
 * contracts before execution, staging happens only on the preview
 * session, and the run NEVER auto-applies: `commit`/`discard` are
 * explicit user actions after `approve` (ADR-0007). Cancellation,
 * provider failures, budget exhaustion, and revision conflicts all fail
 * closed and release the preview.
 */

/**
 * Minimal fixed v1 system prompt (plan S12.5; the full context builder
 * and planning policy are later S12.6/S12.7 tickets). It carries the
 * safety, tool, and limit instructions the consent record covers, and
 * never contains project data or credentials.
 */
export const AGENT_SYSTEM_PROMPT = [
  "You are an agent editing a voxel document through a strict, bounded tool surface.",
  "Rules:",
  "- Inspect before you mutate: read current state with inspection tools first.",
  "- Plan with text before staging changes.",
  "- Stage only coarse, semantic commands through mutation tools; never claim an authoritative full JSON dump.",
  "- Inspect the staged result before you finish, then confirm with text and no further tool calls.",
  "- A tool result with ok:false means the call was rejected; fix the call, do not repeat it unchanged.",
  "- Session budgets (rounds, tokens, tool calls, commands, voxel changes, output bytes, duration, cost) are hard limits and cannot be raised.",
  "- Your proposal is never applied automatically; a human approves or discards it.",
].join("\n");

export interface AgentLoopOptions {
  /** Provider-neutral chat adapter; no vendor type reaches the loop. */
  readonly provider: ProviderAdapter;
  /** Inspection tool facade over the preview session (read-only). */
  readonly inspector: Inspector;
  /** Mutation tool facade constructing preview commands (write intent). */
  readonly mutator: Mutator;
  /** Isolated preview session the run stages into. */
  readonly preview: PreviewSession;
  /** Explicit consent for this provider and model (ADR-0010). */
  readonly consent: ProviderConsent;
  /** The user's edit request; the only user content in the run. */
  readonly userPrompt: string;
  /** Virtual clock for duration budgets; defaults to `Date.now`. */
  readonly clock?: { now(): number };
  /** Simulated sleep for retry backoff; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Session budget overrides; every value is clamped to [0, default]. */
  readonly budgets?: Partial<AgentBudgets>;
  /** Safe retry policy; defaults to 3 attempts with bounded backoff. */
  readonly retry?: RetryPolicy;
  /** Per-request wall-clock timeout in milliseconds. */
  readonly requestTimeoutMs?: number;
  /** Output token cap sent to the provider per request. */
  readonly maxOutputTokens?: number;
  /** Opt-in safe transcript options; absent means nothing is retained. */
  readonly transcript?: TranscriptOptions;
  /** Progress projection callback (UI/headless); never awaited. */
  readonly onEvent?: (event: AgentEvent) => void;
  /**
   * Revision-conflict guard checked before approval. The composition
   * root supplies the real check (live revision equals the preview base);
   * the default assumes current, so headless runs stay deterministic.
   */
  readonly isLiveCurrent?: () => boolean;
}

/** One projected progress event of a run (UI-facing, never persisted). */
export type AgentEvent =
  | { readonly kind: "state"; readonly state: AgentState }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly tool: string;
      readonly call: ToolCall;
      readonly result: ToolCallResult;
    }
  | { readonly kind: "usage"; readonly usage: ProviderUsage }
  | { readonly kind: "error"; readonly error: Error };

export type AgentRunReason =
  | "provider"
  | "limit"
  | "cutoff"
  | "canceled"
  | "conflict";

/** The result of one bounded run. */
export type AgentRunResult =
  | {
      readonly ok: true;
      readonly state: "approve";
      /** Staged command count (the proposal awaiting a human decision). */
      readonly stagedCommands: number;
      readonly diff: PreviewDiff;
      readonly rounds: number;
      readonly toolCalls: number;
      readonly usage: ProviderUsage;
    }
  | {
      readonly ok: false;
      readonly state: AgentState;
      readonly reason: AgentRunReason;
      readonly error: Error;
    };

/** One agent session: a single bounded run plus explicit commit/discard. */
export interface AgentSession {
  /** The explicit state machine of this session. */
  readonly machine: AgentStateMachine;
  /** The isolated preview session staging the proposal. */
  readonly preview: PreviewSession;
  /** Full neutral chat history of the run (tool results included). */
  readonly messages: readonly ChatMessage[];
  /** Opt-in redacted transcript; undefined when retention was refused. */
  readonly transcript?: AgentTranscript;
  /** Runs the bounded loop once; rejects on a second run. */
  run(): Promise<AgentRunResult>;
  /**
   * Explicitly commits the staged proposal as one labeled live
   * transaction. Valid only from `approve`; otherwise throws a stable
   * WorkspaceError.
   */
  apply(options?: { label?: string }): TransactionResult;
  /** Explicitly discards the staged proposal. Valid only from `approve`. */
  discard(): void;
  /** Requests cancellation; takes effect at the next run boundary. */
  cancel(): void;
}

/** Classification of one completed round, driving the explicit walk. */
type RoundClass = "inspect" | "stage" | "text" | "error";

/**
 * The explicit walk (plan S12.1): valid machine transitions per round
 * based on what the model actually did. Inspection-only rounds keep the
 * inspection loop alive, staging rounds move through plan into stage,
 * and a text-only round means the model is done talking: the walk emits
 * every remaining state through approve (the run never blocks on the
 * provider again). Error rounds never advance — the repeated-error
 * cutoff bounds them. Every transition is inside the machine's
 * TRANSITIONS table.
 */
function advanceWalk(
  state: AgentState,
  roundClass: RoundClass,
): readonly AgentState[] {
  switch (state) {
    case "understand":
      if (roundClass === "text") {
        return [
          "inspect",
          "plan",
          "stage",
          "inspect-staged",
          "validate",
          "approve",
        ];
      }
      if (roundClass === "inspect" || roundClass === "stage") {
        return ["inspect"];
      }
      return [];
    case "inspect":
      if (roundClass === "stage") return ["plan", "stage"];
      if (roundClass === "text") {
        return ["plan", "stage", "inspect-staged", "validate", "approve"];
      }
      if (roundClass === "inspect") return ["inspect"];
      return [];
    case "plan":
      if (roundClass === "stage") return ["stage"];
      if (roundClass === "text") {
        return ["stage", "inspect-staged", "validate", "approve"];
      }
      if (roundClass === "inspect") return ["inspect"];
      return [];
    case "stage":
      if (roundClass === "inspect") return ["inspect-staged"];
      if (roundClass === "text") {
        return ["inspect-staged", "validate", "approve"];
      }
      if (roundClass === "stage") return ["stage"];
      return [];
    case "inspect-staged":
      if (roundClass === "text") return ["validate", "approve"];
      return ["stage"];
    case "validate":
      if (roundClass === "text") return ["approve"];
      return ["stage"];
    default:
      return [];
  }
}

/** Stable error for running the same session twice. */
function alreadyStartedError(): WorkspaceError {
  return new WorkspaceError({
    family: "conflict",
    code: "AGENT_RUN_ALREADY_STARTED",
    message: "An agent session can run exactly once",
  });
}

/** Stable error for apply/discard outside the approval state. */
function notApprovedError(state: AgentState): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: "INVALID_STATE_TRANSITION",
    message: `Apply or discard requires the run to be approved (state: ${state})`,
    context: { state },
  });
}

/** Stable revision-conflict failure (plan S12.9). */
function revisionConflictError(): WorkspaceError {
  return new WorkspaceError({
    family: "conflict",
    code: "REVISION_CONFLICT",
    message:
      "The live document changed while the run was in flight; discard the proposal and reinspect before applying",
  });
}

class AgentSessionImpl implements AgentSession {
  readonly machine = new AgentStateMachine();
  readonly preview: PreviewSession;
  readonly transcript?: AgentTranscript;
  readonly #provider: ProviderAdapter;
  readonly #inspector: Inspector;
  readonly #mutator: Mutator;
  readonly #userPrompt: string;
  readonly #clock: { now(): number };
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #budgets: AgentBudgets;
  readonly #retry: RetryPolicy;
  readonly #requestTimeoutMs: number | undefined;
  readonly #maxOutputTokens: number;
  readonly #onEvent: ((event: AgentEvent) => void) | undefined;
  readonly #isLiveCurrent: () => boolean;
  readonly #ledger: BudgetLedger;
  readonly #abort = new AbortController();
  readonly #messages: ChatMessage[] = [];
  #cancelRequested = false;
  #running = false;
  #started = false;

  constructor(options: AgentLoopOptions) {
    this.#clock = options.clock ?? { now: () => Date.now() };
    if (
      !consentCovers(
        options.consent,
        {
          providerId: options.provider.providerId,
          model: options.provider.defaultModel,
        },
        this.#clock.now(),
      )
    ) {
      throw consentRequiredError();
    }
    this.#provider = options.provider;
    this.#inspector = options.inspector;
    this.#mutator = options.mutator;
    this.preview = options.preview;
    this.#userPrompt = options.userPrompt;
    this.#sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#budgets = resolveAgentBudgets(options.budgets);
    this.#retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#maxOutputTokens = options.maxOutputTokens ?? 2048;
    this.#onEvent = options.onEvent;
    this.#isLiveCurrent = options.isLiveCurrent ?? (() => true);
    this.#ledger = new BudgetLedger(this.#budgets, this.#clock);
    if (options.transcript !== undefined) {
      this.transcript = new AgentTranscript(options.transcript);
    }
  }

  get messages(): readonly ChatMessage[] {
    return Object.freeze([...this.#messages]);
  }

  async run(): Promise<AgentRunResult> {
    if (this.#started) throw alreadyStartedError();
    this.#started = true;
    this.#running = true;
    try {
      this.#emit({ kind: "state", state: this.machine.state });
      if (this.machine.state === "cancel") {
        return this.#canceledResult();
      }
      this.#messages.push({ role: "system", content: AGENT_SYSTEM_PROMPT });
      this.#messages.push({ role: "user", content: this.#userPrompt });
      for (const message of this.#messages) {
        this.transcript?.recordMessage(message);
      }
      for (;;) {
        if (this.#cancelRequested || this.#abort.signal.aborted) {
          return this.#canceledResult();
        }
        const round = this.#ledger.reserveRound();
        if (!round.ok) return this.#failedResult("limit", round.error);
        const contracts = [
          ...this.#inspector.contracts,
          ...this.#mutator.contracts,
        ];
        const request: ProviderChatRequest = {
          model: this.#provider.defaultModel,
          messages: [...this.#messages],
          tools: contracts,
          maxTokens: this.#maxOutputTokens,
        };
        const costError = this.#reserveCost(request);
        if (costError !== undefined) {
          return this.#failedResult("limit", costError);
        }
        const outcome = await this.#request(request);
        if (outcome.kind === "canceled") return this.#canceledResult();
        if (outcome.kind === "fatal") {
          return this.#failedResult("provider", outcome.error);
        }
        if (outcome.kind === "round-error") {
          const note: ChatMessage = {
            role: "system",
            content: `A provider request failed (${outcome.error.family} ${outcome.error.code}). This is not a tool result; recover by changing the approach.`,
          };
          this.#messages.push(note);
          this.transcript?.recordMessage(note);
          const recorded = this.#ledger.recordError();
          if (!recorded.ok) {
            return this.#failedResult("cutoff", recorded.error);
          }
          if (
            this.#ledger.consecutiveErrors >= this.#budgets.maxConsecutiveErrors
          ) {
            return this.#failedResult(
              "cutoff",
              budgetLimitError(
                "consecutiveErrors",
                this.#budgets.maxConsecutiveErrors,
                this.#ledger.consecutiveErrors,
              ),
            );
          }
          continue;
        }
        const roundOutcome = this.#processResponse(outcome.response);
        if (roundOutcome.result !== undefined) return roundOutcome.result;
        if (roundOutcome.roundClass === "error") {
          const recorded = this.#ledger.recordError();
          if (!recorded.ok) {
            return this.#failedResult("cutoff", recorded.error);
          }
          if (
            this.#ledger.consecutiveErrors >= this.#budgets.maxConsecutiveErrors
          ) {
            return this.#failedResult(
              "cutoff",
              budgetLimitError(
                "consecutiveErrors",
                this.#budgets.maxConsecutiveErrors,
                this.#ledger.consecutiveErrors,
              ),
            );
          }
        } else {
          this.#ledger.resetErrors();
        }
        for (const next of advanceWalk(
          this.machine.state,
          roundOutcome.roundClass,
        )) {
          if (next === "approve" && !this.#isLiveCurrent()) {
            this.#failClosed();
            return {
              ok: false,
              state: this.machine.state,
              reason: "conflict",
              error: revisionConflictError(),
            };
          }
          this.machine.transition(next);
          this.#emit({ kind: "state", state: next });
          if (next === "approve") {
            const diff = this.preview.diff();
            if (!diff.ok) {
              this.#failClosed();
              return {
                ok: false,
                state: this.machine.state,
                reason: "provider",
                error: diff.error,
              };
            }
            return {
              ok: true,
              state: "approve",
              stagedCommands: this.preview.stagedCount,
              diff: diff.value,
              rounds: this.#ledger.round,
              toolCalls: this.#ledger.toolCalls,
              usage: this.#usageSummary(),
            };
          }
        }
      }
    } finally {
      this.#running = false;
    }
  }

  apply(options: { label?: string } = {}): TransactionResult {
    if (this.machine.state !== "approve") {
      throw notApprovedError(this.machine.state);
    }
    const result = this.preview.apply({
      ...(options.label === undefined ? {} : { label: options.label }),
    });
    if (result.ok) {
      this.machine.transition("commit");
    } else {
      this.#failClosed();
    }
    return result;
  }

  discard(): void {
    if (this.machine.state !== "approve") {
      throw notApprovedError(this.machine.state);
    }
    this.machine.transition("discard");
    this.preview.discard();
  }

  cancel(): void {
    if (this.machine.terminated) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_STATE_TRANSITION",
        message: `Cannot cancel a terminated agent session (state: ${this.machine.state})`,
        context: { state: this.machine.state },
      });
    }
    this.#cancelRequested = true;
    this.#abort.abort();
    if (!this.#running) {
      this.machine.cancel();
      this.preview.cancel();
    }
  }

  /**
   * Reserves the worst-case request cost before sending (ADR-0009): when
   * the model is priceable the full output cap is reserved; when it is
   * not, an already-exhausted cap cannot be guaranteed and the run
   * refuses to start the request.
   */
  #reserveCost(request: ProviderChatRequest): WorkspaceError | undefined {
    const remaining = this.#budgets.maxEstimatedCostUsd - this.#ledger.costUsd;
    const reserved = estimateReservedCostUsd(
      request.model,
      estimateRequestTokens(request),
      this.#maxOutputTokens,
    );
    if (reserved !== undefined) {
      if (remaining < reserved) {
        return budgetLimitError(
          "estimatedCostUsd",
          this.#budgets.maxEstimatedCostUsd,
          this.#ledger.costUsd + reserved,
        );
      }
      return undefined;
    }
    if (remaining <= 0) {
      return budgetLimitError(
        "estimatedCostUsd",
        this.#budgets.maxEstimatedCostUsd,
        this.#ledger.costUsd,
      );
    }
    return undefined;
  }

  /**
   * One provider round with bounded safe retries. Returns a response, a
   * cancellation, an immediate fatal failure, or a round-level error that
   * counts toward the repeated-error cutoff.
   */
  async #request(
    request: ProviderChatRequest,
  ): Promise<
    | { readonly kind: "response"; readonly response: ChatResponse }
    | { readonly kind: "canceled" }
    | { readonly kind: "fatal"; readonly error: ProviderError }
    | { readonly kind: "round-error"; readonly error: ProviderError }
  > {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const response = await this.#provider.complete(request, {
          signal: this.#abort.signal,
          ...(this.#requestTimeoutMs === undefined
            ? {}
            : { timeoutMs: this.#requestTimeoutMs }),
        });
        return { kind: "response", response };
      } catch (error) {
        if (this.#cancelRequested || this.#abort.signal.aborted) {
          return { kind: "canceled" };
        }
        if (!isProviderError(error)) {
          return {
            kind: "fatal",
            error: new ProviderError({
              family: "internal",
              code: "UNEXPECTED_PROVIDER_FAILURE",
              message:
                error instanceof Error
                  ? error.message
                  : "Unexpected provider failure",
              retryable: false,
            }),
          };
        }
        if (error.family === "canceled") return { kind: "canceled" };
        if (!shouldRetry(error, this.#retry, attempt)) {
          // Non-retryable failures and timeouts fail closed after the
          // bounded retries; other retryable failures count toward the
          // repeated-error cutoff so the model keeps a chance to
          // recover while the run stays bounded.
          if (!error.retryable || error.family === "timeout") {
            return { kind: "fatal", error };
          }
          return { kind: "round-error", error };
        }
        await this.#sleep(this.#retry.delayMs(attempt));
      }
    }
  }

  /** Executes one validated response: usage, text, and tool calls. */
  #processResponse(response: ChatResponse): {
    readonly roundClass: RoundClass;
    readonly result?: AgentRunResult;
  } {
    const usage = this.#ledger.recordUsage(response.usage);
    if (!usage.ok) {
      return {
        roundClass: "text",
        result: this.#failedResult("limit", usage.error),
      };
    }
    this.#emit({ kind: "usage", usage: response.usage });
    this.transcript?.recordEvent({ kind: "usage", usage: response.usage });
    const textBytes = this.#ledger.recordOutputBytes(response.text.length);
    if (!textBytes.ok) {
      return {
        roundClass: "text",
        result: this.#failedResult("limit", textBytes.error),
      };
    }
    this.#emit({ kind: "text", text: response.text });
    const assistant: ChatMessage = {
      role: "assistant",
      ...(response.text.length === 0 ? {} : { content: response.text }),
      ...(response.toolCalls.length === 0
        ? {}
        : { toolCalls: response.toolCalls }),
    };
    this.#messages.push(assistant);
    this.transcript?.recordMessage(assistant);
    let inspected = 0;
    let staged = 0;
    let failed = 0;
    for (const call of response.toolCalls) {
      const reserve = this.#ledger.reserveToolCall();
      if (!reserve.ok) {
        return {
          roundClass: "text",
          result: this.#failedResult("limit", reserve.error),
        };
      }
      const prepared = this.#prepareToolCall(call);
      if (prepared.kind === "limit") {
        return {
          roundClass: "text",
          result: this.#failedResult("limit", prepared.error),
        };
      }
      if (prepared.kind === "stage") {
        // ADR-0009 ordering: reserve the proposal's output bytes and the
        // command/voxel/animation budgets BEFORE the preview mutation, so
        // a hard-limit violation fails before allocation.
        const perResult = this.#recordResultBytes(prepared.envelopeUnits);
        if (perResult !== undefined) {
          return {
            roundClass: "text",
            result: this.#failedResult("limit", perResult),
          };
        }
        const commandReserve = this.#ledger.reserveCommand(
          prepared.voxelEstimate,
        );
        if (!commandReserve.ok) {
          return {
            roundClass: "text",
            result: this.#failedResult("limit", commandReserve.error),
          };
        }
        const animation = prepared.animation;
        if (animation !== undefined) {
          const animationReserve = this.#ledger.reserveAnimation(animation);
          if (!animationReserve.ok) {
            return {
              roundClass: "text",
              result: this.#failedResult("limit", animationReserve.error),
            };
          }
        }
        const stageResult = this.preview.stage(prepared.command);
        if (!stageResult.ok) {
          this.#ledger.releaseCommand(prepared.voxelEstimate);
          if (animation !== undefined) {
            this.#ledger.releaseAnimation(animation);
          }
          if (stageResult.error.family === "limit") {
            // The preview enforces its own hard budgets; a limit there is
            // a session-level failure, not a fixable tool error.
            return {
              roundClass: "text",
              result: this.#failedResult("limit", stageResult.error),
            };
          }
          const result: ToolCallResult = {
            ok: false,
            error: toToolError(stageResult.error),
          };
          failed += 1;
          this.#messages.push({ role: "tool", toolCallId: call.id, result });
          this.transcript?.recordToolCall(call, result);
          this.#emit({ kind: "tool", tool: call.name, call, result });
          continue;
        }
        staged += 1;
        const result: ToolCallResult = {
          ok: true,
          value: {
            staged: true,
            revision: stageResult.value.revision,
            commandId: prepared.command.id,
            commandType: prepared.command.type,
            voxelEstimate: prepared.voxelEstimate,
          },
        };
        this.#messages.push({ role: "tool", toolCallId: call.id, result });
        this.transcript?.recordToolCall(call, result);
        this.#emit({ kind: "tool", tool: call.name, call, result });
        continue;
      }
      const result = prepared.result;
      if (result.ok) inspected += 1;
      else failed += 1;
      const perResult = this.#recordResultBytes(
        jsonUnits(result.ok ? result.value : result.error),
      );
      if (perResult !== undefined) {
        return {
          roundClass: "text",
          result: this.#failedResult("limit", perResult),
        };
      }
      this.#messages.push({ role: "tool", toolCallId: call.id, result });
      this.transcript?.recordToolCall(call, result);
      this.#emit({ kind: "tool", tool: call.name, call, result });
    }
    let roundClass: RoundClass;
    if (staged > 0) roundClass = "stage";
    else if (inspected > 0) roundClass = "inspect";
    else if (failed > 0) roundClass = "error";
    else roundClass = "text";
    return { roundClass };
  }

  /**
   * Validates ONE tool call against the neutral contracts and prepares it
   * without side effects. Inspection calls and rejected calls become
   * `feedback` results; a successfully constructed mutation becomes a
   * `stage` proposal (command, voxel estimate, animation reservation, and
   * the serialized size of the construct response, which upper-bounds the
   * staged result fed back). Staging itself happens in the caller so
   * every budget is reserved before the preview mutation.
   */
  #prepareToolCall(call: ToolCall):
    | { readonly kind: "feedback"; readonly result: ToolCallResult }
    | {
        readonly kind: "stage";
        readonly envelopeUnits: number;
        readonly command: Command;
        readonly voxelEstimate: number;
        readonly animation: AnimationReservation | undefined;
      }
    | { readonly kind: "limit"; readonly error: WorkspaceError } {
    const contracts = [
      ...this.#inspector.contracts,
      ...this.#mutator.contracts,
    ];
    const validation = validateToolCall(call, contracts);
    if (validation !== undefined) {
      return { kind: "feedback", result: { ok: false, error: validation } };
    }
    if (this.#isInspection(call.name)) {
      const result = this.#inspector.inspect(call.name, call.arguments);
      return result.ok
        ? { kind: "feedback", result: { ok: true, value: result.value } }
        : { kind: "feedback", result: { ok: false, error: result.error } };
    }
    const constructed = this.#mutator.construct(call.name, call.arguments);
    if (!constructed.ok) {
      return {
        kind: "feedback",
        result: { ok: false, error: constructed.error },
      };
    }
    const value = constructed.value as Readonly<Record<string, JsonValue>>;
    const voxelEstimate =
      typeof value.voxelEstimate === "number" &&
      Number.isFinite(value.voxelEstimate)
        ? Math.max(0, Math.floor(value.voxelEstimate))
        : 0;
    const command = commandFromEnvelope(value);
    if (command === undefined) {
      return {
        kind: "feedback",
        result: {
          ok: false,
          error: {
            family: "validation",
            code: "INVALID_COMMAND_PROPOSAL",
            message: "The constructed command proposal is malformed",
          },
        },
      };
    }
    return {
      kind: "stage",
      envelopeUnits: jsonUnits(constructed.value),
      command,
      voxelEstimate,
      animation: animationReservationOf(value),
    };
  }

  /**
   * Enforces the per-result output bound and records the cumulative
   * output bytes (ADR-0009: reserve before allocation).
   */
  #recordResultBytes(units: number): WorkspaceError | undefined {
    if (units > this.#budgets.maxToolResultBytes) {
      return budgetLimitError(
        "toolResultBytes",
        this.#budgets.maxToolResultBytes,
        units,
      );
    }
    const recorded = this.#ledger.recordOutputBytes(units);
    if (!recorded.ok) return recorded.error;
    return undefined;
  }

  #isInspection(name: string): boolean {
    return this.#inspector.contracts.some((contract) => contract.name === name);
  }

  #usageSummary(): ProviderUsage {
    return {
      inputTokens: this.#ledger.inputTokens,
      outputTokens: this.#ledger.outputTokens,
      ...(this.#ledger.costUsd > 0
        ? { estimatedCostUsd: this.#ledger.costUsd }
        : {}),
    };
  }

  #emit(event: AgentEvent): void {
    this.#onEvent?.(event);
  }

  #failedResult(reason: AgentRunReason, error: Error): AgentRunResult {
    this.#failClosed();
    return { ok: false, state: this.machine.state, reason, error };
  }

  #canceledResult(): AgentRunResult {
    if (!this.machine.terminated) this.machine.cancel();
    this.preview.cancel();
    return {
      ok: false,
      state: "cancel",
      reason: "canceled",
      error: new ProviderError({
        family: "canceled",
        code: "CANCELED",
        message: "The agent run was canceled",
        retryable: false,
      }),
    };
  }

  #failClosed(): void {
    if (!this.machine.terminated) this.machine.fail();
    this.preview.cancel();
  }
}

/**
 * Bounded shape guard for the mutator's command proposal envelope
 * (AGENTS.md: parse and bound every untrusted value before allocation).
 * The mutator validated the command already, but the seam returns plain
 * JSON, so the loop re-checks the exact fields it casts into a Command.
 */
function commandFromEnvelope(
  value: Readonly<Record<string, JsonValue>>,
): Command | undefined {
  const command = value.command;
  if (
    typeof command !== "object" ||
    command === null ||
    Array.isArray(command)
  ) {
    return undefined;
  }
  const record = command as Readonly<Record<string, JsonValue>>;
  const id = record.id;
  const type = record.type;
  const schemaVersion = record.schemaVersion;
  const payload = record.payload;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 128 ||
    typeof type !== "string" ||
    type.length === 0 ||
    type.length > 128 ||
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1 ||
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return undefined;
  }
  return {
    id,
    type,
    schemaVersion,
    payload,
  } as Command;
}

/**
 * Extracts the animation reservation a staging tool reported (plan
 * S12.5): later rigging/animation tools (S11.7/S11.8) report their
 * deltas here; the v1 geometry surface has none, so the reservation is
 * empty and always passes.
 */
function animationReservationOf(
  value: Readonly<Record<string, JsonValue>>,
): AnimationReservation | undefined {
  const animation = value.animation;
  if (typeof animation !== "object" || animation === null) return undefined;
  const record = animation as Readonly<Record<string, JsonValue>>;
  const tracks = finiteCount(record.tracks);
  const keyframes = finiteCount(record.keyframes);
  const clipDurationSeconds = finiteNumber(record.clipDurationSeconds);
  if (tracks === 0 && keyframes === 0 && clipDurationSeconds === 0) {
    return undefined;
  }
  return {
    ...(tracks > 0 ? { tracks } : {}),
    ...(keyframes > 0 ? { keyframes } : {}),
    ...(clipDurationSeconds > 0 ? { clipDurationSeconds } : {}),
  };
}

function finiteCount(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function finiteNumber(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Creates one bounded agent session over a provider and preview. */
export function createAgentSession(options: AgentLoopOptions): AgentSession {
  return new AgentSessionImpl(options);
}
