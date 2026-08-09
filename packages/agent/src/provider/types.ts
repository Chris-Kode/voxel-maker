import type { JsonValue } from "@voxel-maker/shared";
import type { ToolContract, ToolError } from "../contract.js";
import { schemaErrorDetails } from "../schema.js";
import { UNKNOWN_TOOL_CODE } from "../registry.js";

/**
 * Provider-neutral chat contract (plan S12.2, ticket #33): normalized
 * streaming events, structured tool calls, usage, cancellation, timeout,
 * and safe-retry behavior. This module is the only vocabulary the agent
 * loop, budgets, and transcript speak about model providers; vendor types
 * never cross this boundary (AC: no vendor types outside adapters).
 */

/** Stable, normalized provider failure families. */
export type ProviderErrorFamily =
  | "network"
  | "timeout"
  | "authentication"
  | "rate-limit"
  | "server"
  | "invalid-response"
  | "validation"
  | "budget"
  | "canceled"
  | "internal";

export interface ProviderErrorData {
  readonly family: ProviderErrorFamily;
  readonly code: string;
  readonly message: string;
  /** True only when a bounded retry is safe (no local side effects yet). */
  readonly retryable: boolean;
  readonly context?: Readonly<Record<string, JsonValue>>;
}

/**
 * Normalized provider error. Adapters map every vendor failure onto this
 * shape; the loop retries only `retryable` errors and only before any
 * tool call from the request has executed.
 */
export class ProviderError extends Error {
  readonly family: ProviderErrorFamily;
  readonly code: string;
  readonly retryable: boolean;
  readonly context?: Readonly<Record<string, JsonValue>>;

  constructor(data: ProviderErrorData) {
    super(data.message);
    this.name = "ProviderError";
    this.family = data.family;
    this.code = data.code;
    this.retryable = data.retryable;
    if (data.context !== undefined) {
      this.context = Object.freeze({ ...data.context }) as Readonly<
        Record<string, JsonValue>
      >;
    }
  }

  toJSON(): ProviderErrorData {
    return {
      family: this.family,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.context === undefined ? {} : { context: this.context }),
    };
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/** True when the normalized failure may be retried safely. */
export function isRetryable(error: ProviderError): boolean {
  return error.retryable;
}

/** One structured tool call emitted by the provider. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Parsed arguments object; validation happens in the loop. */
  readonly arguments: JsonValue;
}

/** Result of executing one tool call, fed back to the provider. */
export type ToolCallResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: ToolError };

/** Provider-neutral chat message (system/user/assistant/tool). */
export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content?: string;
      readonly toolCalls?: readonly ToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly result: ToolCallResult;
    };

/** Token and cost accounting reported by the provider. */
export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  /** Estimated spend in USD when the adapter can price the model. */
  readonly estimatedCostUsd?: number;
}

export type ProviderFinishReason =
  | "stop"
  | "tool-calls"
  | "length"
  | "content-filter"
  | "canceled"
  | "error";

/** One normalized streaming event from a provider adapter. */
export type ProviderEvent =
  | { readonly kind: "text"; readonly delta: string }
  | { readonly kind: "tool-call"; readonly call: ToolCall }
  | { readonly kind: "usage"; readonly usage: ProviderUsage }
  | { readonly kind: "done"; readonly finishReason: ProviderFinishReason }
  | { readonly kind: "error"; readonly error: ProviderError };

/** The accumulated result of one provider round. */
export interface ChatResponse {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: ProviderUsage;
  readonly finishReason: ProviderFinishReason;
}

/** Plain snapshot factory used by adapters and tests. */
export function chatResponse(parts: {
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: ProviderUsage;
  readonly finishReason: ProviderFinishReason;
}): ChatResponse {
  return {
    text: parts.text,
    toolCalls: parts.toolCalls ?? [],
    usage: parts.usage ?? { inputTokens: 0, outputTokens: 0 },
    finishReason: parts.finishReason,
  };
}

/** One provider-neutral chat request. */
export interface ProviderChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  /** Provider-neutral tool contracts; optional for plain text runs. */
  readonly tools?: readonly ToolContract[];
  /** Output token cap for the response. */
  readonly maxTokens?: number;
}

export interface ChatOptions {
  readonly signal?: AbortSignal;
  /** Per-request wall-clock timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * Provider adapter seam (plan S12.2/S12.3): streaming text, structured
 * tool calls, usage, cancellation, and timeout, all normalized. Adapters
 * implement this interface; the loop never imports an adapter class or a
 * vendor SDK type.
 */
export interface ProviderAdapter {
  readonly providerId: string;
  readonly defaultModel: string;
  chat(
    request: ProviderChatRequest,
    options?: ChatOptions,
  ): AsyncIterable<ProviderEvent>;
  complete(
    request: ProviderChatRequest,
    options?: ChatOptions,
  ): Promise<ChatResponse>;
}

/**
 * Validates a provider tool call against the neutral contracts before
 * execution. Returns a stable `ToolError` (UNKNOWN_TOOL or
 * INVALID_ARGUMENT) or undefined when the call is well-formed.
 */
export function validateToolCall(
  call: ToolCall,
  contracts: readonly ToolContract[],
): ToolError | undefined {
  const contract = contracts.find((candidate) => candidate.name === call.name);
  if (contract === undefined) {
    return {
      family: "validation",
      code: UNKNOWN_TOOL_CODE,
      message: `Unknown tool: ${call.name}`,
      context: { tool: call.name },
    };
  }
  const details = schemaErrorDetails(contract.inputSchema, call.arguments);
  if (details.length > 0) {
    const first = details[0];
    return {
      family: "validation",
      code: "INVALID_ARGUMENT",
      message: `Invalid arguments for ${call.name}: ${details
        .map((detail) => detail.message)
        .join("; ")}`,
      ...(first === undefined ? {} : { path: first.path }),
      context: {
        tool: call.name,
        errors: details.map((detail) => detail.message),
      },
    };
  }
  return undefined;
}

function canceledError(): ProviderError {
  return new ProviderError({
    family: "canceled",
    code: "CANCELED",
    message: "The provider request was canceled",
    retryable: false,
  });
}

/**
 * Consumes an event stream into one `ChatResponse`. Text deltas
 * concatenate in order, tool calls keep arrival order, the last usage
 * event wins, and an error event rejects the whole response. A stream
 * without a `done` event is an invalid response; an aborted signal maps
 * to the stable CANCELED error.
 */
export async function streamToResponse(
  events: AsyncIterable<ProviderEvent> | readonly ProviderEvent[],
  options: ChatOptions = {},
): Promise<ChatResponse> {
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  let usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
  let finished: ProviderFinishReason | undefined;
  for await (const event of events) {
    if (options.signal?.aborted === true) throw canceledError();
    switch (event.kind) {
      case "text":
        text.push(event.delta);
        break;
      case "tool-call":
        toolCalls.push(event.call);
        break;
      case "usage":
        usage = event.usage;
        break;
      case "done":
        finished = event.finishReason;
        break;
      case "error":
        throw event.error;
    }
  }
  if (finished === undefined) {
    throw new ProviderError({
      family: "invalid-response",
      code: "MISSING_FINISH_REASON",
      message: "Provider stream ended without a finish reason",
      retryable: false,
    });
  }
  return chatResponse({
    text: text.join(""),
    toolCalls,
    usage,
    finishReason: finished,
  });
}

/** Deterministic text token estimate: 4 characters per token. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageTokens(message: ChatMessage): number {
  switch (message.role) {
    case "system":
    case "user":
      return estimateTextTokens(message.content);
    case "assistant": {
      let tokens = estimateTextTokens(message.content ?? "");
      for (const call of message.toolCalls ?? []) {
        tokens +=
          estimateTextTokens(call.name) +
          estimateTextTokens(JSON.stringify(call.arguments));
      }
      return tokens;
    }
    case "tool": {
      const payload = message.result.ok
        ? JSON.stringify(message.result.value)
        : JSON.stringify(message.result.error);
      return estimateTextTokens(payload);
    }
  }
}

/** Deterministic whole-request token estimate (messages + tool schemas). */
export function estimateRequestTokens(request: ProviderChatRequest): number {
  let tokens = 0;
  for (const message of request.messages) tokens += messageTokens(message);
  for (const tool of request.tools ?? []) {
    tokens += estimateTextTokens(JSON.stringify(tool));
  }
  return tokens;
}

export interface RetryPolicy {
  /** Total attempts including the first (>= 1). */
  readonly maxAttempts: number;
  /** Deterministic delay in ms before the given retry attempt (1-based). */
  readonly delayMs: (attempt: number) => number;
  /** True when the normalized error may be retried. */
  readonly shouldRetry: (error: ProviderError) => boolean;
}

/** Default safe retry policy: 3 attempts, bounded exponential backoff. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  delayMs: (attempt: number): number =>
    Math.min(250 * 2 ** (attempt - 1), 1000),
  shouldRetry: (error: ProviderError): boolean => error.retryable,
});

/** True when this attempt may still retry `error` under `policy`. */
export function shouldRetry(
  error: ProviderError,
  policy: RetryPolicy,
  attempt: number,
): boolean {
  return attempt < policy.maxAttempts && policy.shouldRetry(error);
}
