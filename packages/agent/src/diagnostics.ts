import type { AgentBudgets } from "./agent/budgets.js";
import type { AgentRunResult } from "./agent/loop.js";
import { redactJson } from "./provider/redact.js";
import type { ChatMessage } from "./provider/types.js";

/**
 * Sanitized session diagnostics (issue #44, plan §13, ADR-0010, S17.9):
 * a locally previewable run report that NEVER contains prompts, tool
 * arguments, project contents, paths, or secrets by default. Prompt and
 * tool-call inclusion is an explicit per-export choice (`includePrompts`)
 * and every included string still passes through `redactJson` with the
 * session's explicit secret list. Diagnostics are for the user's own
 * debugging and export; there is no telemetry pipeline in v1.
 *
 * Policy reference: docs/security/privacy-and-diagnostics-v1.md.
 */

export interface SessionDiagnosticsInput {
  /** Provider id reported by the adapter (never a credential). */
  readonly providerId: string;
  /** Model reported by the adapter (allowlisted by the adapter). */
  readonly model: string;
  /** The bounded run result (staged counts, usage, outcome). */
  readonly result: AgentRunResult;
  /** Full neutral chat history; used ONLY for opt-in prompt inclusion. */
  readonly messages: readonly ChatMessage[];
  /** The immutable budget profile the run executed under. */
  readonly budgets: AgentBudgets;
  /** Epoch ms; injected clock keeps reports deterministic. */
  readonly createdAt?: number;
  /**
   * Opt-in prompt/tool-argument inclusion (default false). When true,
   * every string is redacted (secrets, paths, URLs) before it is emitted.
   */
  readonly includePrompts?: boolean;
  /** Explicit secret values redacted from any included content. */
  readonly secrets?: readonly string[];
}

/** One sanitized diagnostic report (frozen, JSON-serializable). */
export interface SessionDiagnostics {
  readonly schemaVersion: 1;
  readonly createdAt: number;
  readonly provider: { readonly providerId: string; readonly model: string };
  readonly outcome: {
    readonly ok: boolean;
    readonly state: string;
    readonly reason?: string;
    readonly errorCode?: string;
  };
  readonly usage: {
    readonly rounds: number;
    readonly toolCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCostUsd?: number;
  };
  readonly staged: { readonly commands: number } | undefined;
  readonly limits: {
    readonly maxRounds: number;
    readonly maxToolCalls: number;
    readonly maxTokens: number;
    readonly maxDurationMs: number;
    readonly maxEstimatedCostUsd: number;
  };
  /** Present only when `includePrompts` was requested; always redacted. */
  readonly prompts?: {
    readonly userPrompt: string;
    readonly toolCalls: readonly {
      readonly name: string;
      readonly arguments: unknown;
    }[];
  };
}

/** Stable error code extraction; unknown errors never leak details. */
function errorCode(error: Error): string | undefined {
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Builds the sanitized report. The default report contains only bounded
 * metrics; prompts and tool arguments are omitted entirely unless the
 * caller explicitly opts in, and even then every string is redacted.
 */
export function buildSessionDiagnostics(
  input: SessionDiagnosticsInput,
): SessionDiagnostics {
  const result = input.result;
  // Issue #78: failed/canceled runs carry the cumulative counters, so the
  // report never erases consumed rounds, tokens, or cost.
  const usage = result.usage;
  const failureCode = result.ok ? undefined : errorCode(result.error);
  const outcome: SessionDiagnostics["outcome"] = {
    ok: result.ok,
    state: result.state,
    ...(!result.ok ? { reason: result.reason } : {}),
    ...(!result.ok && failureCode !== undefined
      ? { errorCode: failureCode }
      : {}),
  };
  const usageReport: SessionDiagnostics["usage"] = {
    rounds: result.rounds,
    toolCalls: result.toolCalls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.estimatedCostUsd === undefined
      ? {}
      : { estimatedCostUsd: usage.estimatedCostUsd }),
  };
  const staged = result.ok ? { commands: result.stagedCommands } : undefined;

  const prompts =
    input.includePrompts === true
      ? (() => {
          const userPrompt =
            input.messages.find((message) => message.role === "user")
              ?.content ?? "";
          const toolCalls = input.messages.flatMap((message) =>
            message.role === "assistant" && message.toolCalls !== undefined
              ? message.toolCalls.map((call) => ({
                  name: call.name,
                  arguments: call.arguments,
                }))
              : [],
          );
          const redactedUserPrompt = redactJson(userPrompt, input.secrets);
          return {
            userPrompt:
              typeof redactedUserPrompt === "string" ? redactedUserPrompt : "",
            toolCalls: Object.freeze(
              toolCalls.map((call) => ({
                name: call.name,
                arguments: redactJson(call.arguments, input.secrets),
              })),
            ),
          };
        })()
      : undefined;

  // Built untyped, then narrowed: exactOptionalPropertyTypes cannot express
  // "optional member whose value is conditionally absent", and the spreads
  // below are guarded so no optional member is ever explicitly undefined.
  const report = {
    schemaVersion: 1,
    createdAt: input.createdAt ?? Date.now(),
    provider: { providerId: input.providerId, model: input.model },
    outcome,
    usage: usageReport,
    ...(staged === undefined ? {} : { staged }),
    ...(prompts === undefined ? {} : { prompts }),
    limits: {
      maxRounds: input.budgets.maxRounds,
      maxToolCalls: input.budgets.maxToolCalls,
      maxTokens: input.budgets.maxTokens,
      maxDurationMs: input.budgets.maxDurationMs,
      maxEstimatedCostUsd: input.budgets.maxEstimatedCostUsd,
    },
  } as SessionDiagnostics;

  return Object.freeze(report);
}
