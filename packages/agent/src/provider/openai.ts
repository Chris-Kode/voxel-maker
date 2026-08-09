import type { JsonValue } from "@voxel-maker/shared";
import type { ToolContract } from "../contract.js";
import { OPENAI_ALLOWED_MODELS, estimateCostUsd } from "./cost.js";
import type { Secret } from "./credentials.js";
import { redactDiagnostics } from "./redact.js";
import {
  ProviderError,
  streamToResponse,
  type ChatOptions,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderChatRequest,
  type ProviderEvent,
  type ProviderFinishReason,
  type ProviderUsage,
  type ToolCall,
} from "./types.js";

/**
 * OpenAI adapter (plan S12.3, ticket #33): the v1 sole cloud adapter
 * (ARCHITECTURE.md). It talks to the official chat-completions endpoint
 * over the platform `fetch`, streams SSE text and tool-call deltas,
 * reports usage with deterministic pricing, and maps every vendor failure
 * onto the normalized `ProviderError` vocabulary. No OpenAI SDK type
 * exists outside this file; the exported surface is `ProviderAdapter`.
 */

/** Fixed v1 endpoint (ADR-0010: no relays or arbitrary endpoints). */
const ENDPOINT = "https://api.openai.com/v1/chat/completions";

/** Default per-request timeout when the loop does not pass one. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Maximum response bytes read for an error body. */
const MAX_ERROR_BODY = 1_000;

/**
 * Hard caps on the provider stream (issue #44, plan §11.2): the provider
 * response is untrusted input, so the accumulated SSE buffer, one SSE
 * line, one accumulated tool-call argument payload, and the tool-call
 * count are all bounded before further allocation. Violations fail the
 * stream with a structured error instead of growing memory without bound.
 */
export const MAX_STREAM_BUFFER_BYTES = 8 * 1024 * 1024;
export const MAX_TOOL_ARGUMENT_BYTES = 256 * 1024;
export const MAX_TOOL_CALLS_PER_STREAM = 128;

/** Bounded-stream error used for every stream-limit violation. */
function streamLimitError(code: string, message: string): ProviderError {
  return normalizedError("invalid-response", code, message, false);
}

export interface OpenAIAdapterOptions {
  /** Supplies the keychain-held API key per request; never stored here. */
  readonly getApiKey: () => Secret | Promise<Secret>;
  /** Default allowlisted model. */
  readonly model?: string;
  /** Injected fetch for deterministic tests; defaults to platform fetch. */
  readonly fetch?: typeof fetch;
}

interface StreamedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

function normalizedError(
  family:
    | "network"
    | "timeout"
    | "authentication"
    | "rate-limit"
    | "server"
    | "invalid-response"
    | "validation"
    | "canceled",
  code: string,
  message: string,
  retryable: boolean,
): ProviderError {
  return new ProviderError({ family, code, message, retryable });
}

/** Maps an HTTP status to a normalized provider error. */
function statusError(status: number, body: string): ProviderError {
  const excerpt = redactDiagnostics(
    body.length > MAX_ERROR_BODY ? body.slice(0, MAX_ERROR_BODY) : body,
  );
  if (status === 401 || status === 403) {
    return normalizedError(
      "authentication",
      "AUTHENTICATION_FAILED",
      "The provider rejected the credential",
      false,
    );
  }
  if (status === 429) {
    return normalizedError(
      "rate-limit",
      "RATE_LIMITED",
      "The provider rate-limited the request",
      true,
    );
  }
  if (status >= 500) {
    return normalizedError(
      "server",
      "SERVER_ERROR",
      `The provider failed (HTTP ${String(status)})`,
      true,
    );
  }
  return normalizedError(
    "validation",
    "REQUEST_REJECTED",
    `The provider rejected the request (HTTP ${String(status)}): ${excerpt}`,
    false,
  );
}

function finishReason(value: string | null | undefined): ProviderFinishReason {
  switch (value) {
    case "tool_calls":
      return "tool-calls";
    case "length":
      return "length";
    case "content_filter":
      return "content-filter";
    case "stop":
      return "stop";
    default:
      return "stop";
  }
}

function toVendorMessages(request: ProviderChatRequest): unknown[] {
  const messages: unknown[] = [];
  for (const message of request.messages) {
    switch (message.role) {
      case "system":
        messages.push({ role: "system", content: message.content });
        break;
      case "user": {
        const images = message.images ?? [];
        if (images.length === 0) {
          messages.push({ role: "user", content: message.content });
        } else {
          // Vision content parts (plan S15.3, ticket #40): the bounded
          // standard-view PNGs become base64 data URLs. Only PNG is
          // supported; the adapter refuses anything else.
          const parts: unknown[] = [
            { type: "text", text: message.content },
            ...images.map((image) => {
              const mimeType = image.mimeType as string;
              if (mimeType !== "image/png") {
                throw normalizedError(
                  "validation",
                  "UNSUPPORTED_IMAGE_MIME",
                  `Unsupported image mime type: ${mimeType}`,
                  false,
                );
              }
              if (image.bytes.byteLength === 0) {
                throw normalizedError(
                  "validation",
                  "EMPTY_IMAGE",
                  "Refusing to transmit an empty image",
                  false,
                );
              }
              return {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${base64Encode(image.bytes)}`,
                  // Fixed low-detail request: bounded token cost, and the
                  // standard views are simple voxel silhouettes.
                  detail: "low",
                },
              };
            }),
          ];
          messages.push({ role: "user", content: parts });
        }
        break;
      }
      case "assistant":
        messages.push({
          role: "assistant",
          ...(message.content === undefined || message.content.length === 0
            ? {}
            : { content: message.content }),
          ...((message.toolCalls?.length ?? 0) === 0
            ? {}
            : {
                tool_calls: message.toolCalls?.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
              }),
        });
        break;
      case "tool": {
        const payload = message.result.ok
          ? message.result.value
          : message.result.error;
        messages.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          content: JSON.stringify(payload),
        });
        break;
      }
    }
  }
  return messages;
}

/** Pure base64 encoder (RFC 4648) over bytes; platform-neutral. */
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.byteLength ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.byteLength ? (bytes[i + 2] as number) : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET.charAt((triple >> 18) & 0x3f);
    out += BASE64_ALPHABET.charAt((triple >> 12) & 0x3f);
    out +=
      i + 1 < bytes.byteLength
        ? BASE64_ALPHABET.charAt((triple >> 6) & 0x3f)
        : "=";
    out +=
      i + 2 < bytes.byteLength ? BASE64_ALPHABET.charAt(triple & 0x3f) : "=";
  }
  return out;
}

function toVendorTools(tools: readonly ToolContract[]): unknown[] {
  return tools.map((contract) => ({
    type: "function",
    function: {
      name: contract.name,
      description: contract.description,
      parameters: contract.inputSchema,
    },
  }));
}

export class OpenAIProvider implements ProviderAdapter {
  readonly providerId = "openai";
  readonly defaultModel: string;
  readonly #getApiKey: () => Secret | Promise<Secret>;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAIAdapterOptions) {
    const model = options.model ?? "gpt-4o-mini";
    if (!OPENAI_ALLOWED_MODELS.includes(model)) {
      throw normalizedError(
        "validation",
        "MODEL_NOT_ALLOWED",
        `Model ${model} is not on the v1 allowlist`,
        false,
      );
    }
    this.defaultModel = model;
    this.#getApiKey = options.getApiKey;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
  }

  async *chat(
    request: ProviderChatRequest,
    options: ChatOptions = {},
  ): AsyncIterable<ProviderEvent> {
    if (!OPENAI_ALLOWED_MODELS.includes(request.model)) {
      yield {
        kind: "error",
        error: normalizedError(
          "validation",
          "MODEL_NOT_ALLOWED",
          `Model ${request.model} is not on the v1 allowlist`,
          false,
        ),
      };
      return;
    }
    for (const message of request.messages) {
      if (message.role !== "user" || (message.images?.length ?? 0) === 0) {
        continue;
      }
      for (const image of message.images ?? []) {
        // The chat contract types images as PNG, but the message may
        // cross untrusted JSON boundaries: re-validate the runtime value.
        const mimeType = image.mimeType as string;
        if (mimeType !== "image/png") {
          yield {
            kind: "error",
            error: normalizedError(
              "validation",
              "UNSUPPORTED_IMAGE_MIME",
              `Unsupported image mime type: ${mimeType}`,
              false,
            ),
          };
          return;
        }
        if (image.bytes.byteLength === 0) {
          yield {
            kind: "error",
            error: normalizedError(
              "validation",
              "EMPTY_IMAGE",
              "Refusing to transmit an empty image",
              false,
            ),
          };
          return;
        }
      }
    }
    const apiKey = await this.#getApiKey();
    if (apiKey.reveal().length === 0) {
      yield {
        kind: "error",
        error: normalizedError(
          "authentication",
          "MISSING_API_KEY",
          "No API key is available in the credential store",
          false,
        ),
      };
      return;
    }

    const controller = new AbortController();
    const userSignal = options.signal;
    // Object flags: assignments inside the abort listener and the timer
    // are invisible to control-flow analysis, so plain booleans would
    // be narrowed to their initializers at the catch site.
    const state = { timedOut: false, canceled: false };
    const abort = (): void => {
      controller.abort();
    };
    if (userSignal !== undefined) {
      if (userSignal.aborted) {
        state.canceled = true;
        controller.abort();
      } else {
        userSignal.addEventListener(
          "abort",
          () => {
            state.canceled = true;
            controller.abort();
          },
          { once: true },
        );
      }
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref();

    try {
      const response = await this.#fetch(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey.reveal()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          messages: toVendorMessages(request),
          ...((request.tools?.length ?? 0) === 0
            ? {}
            : { tools: toVendorTools(request.tools ?? []) }),
          ...(request.maxTokens === undefined
            ? {}
            : { max_tokens: request.maxTokens }),
          temperature: 0,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        yield { kind: "error", error: statusError(response.status, body) };
        return;
      }
      const decoder = new TextDecoder();
      const reader = response.body?.getReader();
      if (reader === undefined) {
        yield {
          kind: "error",
          error: normalizedError(
            "invalid-response",
            "MISSING_STREAM",
            "The provider response had no body stream",
            false,
          ),
        };
        return;
      }
      let buffer = "";
      const toolCalls = new Map<number, StreamedToolCall>();
      let usage: ProviderUsage | undefined;
      let finish: ProviderFinishReason | undefined;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_STREAM_BUFFER_BYTES) {
          yield {
            kind: "error",
            error: streamLimitError(
              "STREAM_LIMIT_EXCEEDED",
              "Provider stream exceeded the accumulated byte limit",
            ),
          };
          return;
        }
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data.length > MAX_STREAM_BUFFER_BYTES) {
              yield {
                kind: "error",
                error: streamLimitError(
                  "STREAM_LIMIT_EXCEEDED",
                  "Provider stream exceeded the per-line byte limit",
                ),
              };
              return;
            }
            if (data === "[DONE]") {
              if (finish === undefined) finish = "stop";
              buffer = "";
              break;
            }
            let payload: unknown;
            try {
              payload = JSON.parse(data) as unknown;
            } catch {
              yield {
                kind: "error",
                error: normalizedError(
                  "invalid-response",
                  "MALFORMED_STREAM",
                  "The provider stream contained invalid JSON",
                  false,
                ),
              };
              return;
            }
            const chunk = payload as {
              readonly choices?: readonly {
                readonly delta?: {
                  readonly content?: string | null;
                  readonly tool_calls?: readonly {
                    readonly index: number;
                    readonly id?: string;
                    readonly function?: {
                      readonly name?: string;
                      readonly arguments?: string;
                    };
                  }[];
                };
                readonly finish_reason?: string | null;
              }[];
              readonly usage?: {
                readonly prompt_tokens: number;
                readonly completion_tokens: number;
                readonly prompt_tokens_details?: {
                  readonly cached_tokens?: number;
                };
              };
            };
            for (const choice of chunk.choices ?? []) {
              const delta = choice.delta;
              if (delta?.content !== undefined && delta.content !== null) {
                yield { kind: "text", delta: delta.content };
              }
              for (const part of delta?.tool_calls ?? []) {
                const current = toolCalls.get(part.index) ?? {
                  id: "",
                  name: "",
                  arguments: "",
                };
                if (toolCalls.size >= MAX_TOOL_CALLS_PER_STREAM && !toolCalls.has(part.index)) {
                  yield {
                    kind: "error",
                    error: streamLimitError(
                      "STREAM_LIMIT_EXCEEDED",
                      "Provider stream exceeded the tool-call count limit",
                    ),
                  };
                  return;
                }
                const added = part.function?.arguments ?? "";
                if (current.arguments.length + added.length > MAX_TOOL_ARGUMENT_BYTES) {
                  yield {
                    kind: "error",
                    error: streamLimitError(
                      "STREAM_LIMIT_EXCEEDED",
                      "Provider stream exceeded the tool-call argument byte limit",
                    ),
                  };
                  return;
                }
                toolCalls.set(part.index, {
                  id: part.id ?? current.id,
                  name: part.function?.name ?? current.name,
                  arguments: current.arguments + added,
                });
              }
              if (
                choice.finish_reason !== undefined &&
                choice.finish_reason !== null
              ) {
                finish = finishReason(choice.finish_reason);
              }
            }
            if (chunk.usage !== undefined) {
              const rawUsage: ProviderUsage = {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
                ...(chunk.usage.prompt_tokens_details?.cached_tokens ===
                undefined
                  ? {}
                  : {
                      cachedInputTokens:
                        chunk.usage.prompt_tokens_details.cached_tokens,
                    }),
              };
              const cost = estimateCostUsd(request.model, rawUsage);
              usage = {
                ...rawUsage,
                ...(cost === undefined ? {} : { estimatedCostUsd: cost }),
              };
              yield { kind: "usage", usage };
            }
          }
          newline = buffer.indexOf("\n");
        }
        if (userSignal?.aborted === true) break;
      }
      const calls: (ToolCall | undefined)[] = [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => {
          try {
            const parsed = JSON.parse(
              call.arguments === "" ? "{}" : call.arguments,
            ) as JsonValue;
            return { id: call.id, name: call.name, arguments: parsed };
          } catch {
            return undefined;
          }
        });
      for (const call of calls) {
        if (call === undefined) {
          yield {
            kind: "error",
            error: normalizedError(
              "invalid-response",
              "MALFORMED_TOOL_CALL",
              "A tool call had arguments that are not valid JSON",
              false,
            ),
          };
          return;
        }
        yield { kind: "tool-call", call };
      }
      if (usage === undefined) {
        usage = { inputTokens: 0, outputTokens: 0 };
      }
      yield { kind: "usage", usage };
      yield { kind: "done", finishReason: finish ?? "stop" };
    } catch (error) {
      if (state.canceled) {
        yield {
          kind: "error",
          error: normalizedError(
            "canceled",
            "CANCELED",
            "The provider request was canceled",
            false,
          ),
        };
        return;
      }
      if (state.timedOut) {
        yield {
          kind: "error",
          error: normalizedError(
            "timeout",
            "REQUEST_TIMEOUT",
            "The provider request exceeded its timeout",
            true,
          ),
        };
        return;
      }
      const reason = error instanceof Error ? error : new Error(String(error));
      yield {
        kind: "error",
        error: normalizedError(
          "network",
          "NETWORK_ERROR",
          reason.message === ""
            ? "The provider was unreachable"
            : reason.message,
          true,
        ),
      };
    } finally {
      clearTimeout(timer);
      userSignal?.removeEventListener("abort", abort);
    }
  }

  async complete(
    request: ProviderChatRequest,
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    return await streamToResponse(this.chat(request, options), options);
  }
}
