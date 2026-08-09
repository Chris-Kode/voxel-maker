import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import { INSPECT_SUMMARY_CONTRACT } from "../tools/index.js";
import { FILL_BOX_CONTRACT } from "../mutation/index.js";
import {
  ProviderError,
  chatResponse,
  isProviderError,
  isRetryable,
  shouldRetry,
  streamToResponse,
  validateToolCall,
  DEFAULT_RETRY_POLICY,
  estimateImageTokens,
  estimateRequestTokens,
  estimateTextTokens,
  type ChatImage,
  type ChatMessage,
  type ProviderEvent,
  type ToolCall,
} from "./types.js";

/**
 * Provider-neutral contract tests (plan S12.2, ticket #33): normalized
 * streaming events, structured tool calls, usage, cancellation, timeout,
 * and safe-retry behavior with zero vendor types leaking into the
 * semantic core.
 */

function textEvent(text: string): ProviderEvent {
  return { kind: "text", delta: text };
}
function usageEvent(): ProviderEvent {
  return {
    kind: "usage",
    usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 },
  };
}

describe("ProviderError normalization (AC: no vendor types)", () => {
  it("carries a stable family, code, retryable flag, and redacted JSON", () => {
    const error = new ProviderError({
      family: "timeout",
      code: "REQUEST_TIMEOUT",
      message: "The request timed out",
      retryable: true,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.family).toBe("timeout");
    expect(error.code).toBe("REQUEST_TIMEOUT");
    expect(error.retryable).toBe(true);
    expect(error.toJSON()).toEqual({
      family: "timeout",
      code: "REQUEST_TIMEOUT",
      message: "The request timed out",
      retryable: true,
    });
    expect(JSON.stringify(error)).not.toContain("stack");
  });

  it("classifies transient failures as retryable and policy failures as not", () => {
    expect(
      isRetryable(
        new ProviderError({
          family: "network",
          code: "NETWORK",
          message: "",
          retryable: true,
        }),
      ),
    ).toBe(true);
    expect(
      isRetryable(
        new ProviderError({
          family: "timeout",
          code: "TIMEOUT",
          message: "",
          retryable: true,
        }),
      ),
    ).toBe(true);
    expect(
      isRetryable(
        new ProviderError({
          family: "rate-limit",
          code: "RATE_LIMIT",
          message: "",
          retryable: true,
        }),
      ),
    ).toBe(true);
    expect(
      isRetryable(
        new ProviderError({
          family: "server",
          code: "SERVER",
          message: "",
          retryable: true,
        }),
      ),
    ).toBe(true);
    expect(
      isRetryable(
        new ProviderError({
          family: "authentication",
          code: "AUTH",
          message: "",
          retryable: false,
        }),
      ),
    ).toBe(false);
    expect(
      isRetryable(
        new ProviderError({
          family: "validation",
          code: "BAD_REQUEST",
          message: "",
          retryable: false,
        }),
      ),
    ).toBe(false);
    expect(
      isRetryable(
        new ProviderError({
          family: "invalid-response",
          code: "MALFORMED",
          message: "",
          retryable: false,
        }),
      ),
    ).toBe(false);
    expect(
      isRetryable(
        new ProviderError({
          family: "budget",
          code: "BUDGET",
          message: "",
          retryable: false,
        }),
      ),
    ).toBe(false);
    expect(
      isRetryable(
        new ProviderError({
          family: "canceled",
          code: "CANCELED",
          message: "",
          retryable: false,
        }),
      ),
    ).toBe(false);
  });

  it("never retries non-transient failures and bounds total attempts", () => {
    expect(
      shouldRetry(
        new ProviderError({
          family: "invalid-response",
          code: "MALFORMED",
          message: "",
          retryable: false,
        }),
        DEFAULT_RETRY_POLICY,
        1,
      ),
    ).toBe(false);
    expect(
      shouldRetry(
        new ProviderError({
          family: "network",
          code: "NETWORK",
          message: "",
          retryable: true,
        }),
        DEFAULT_RETRY_POLICY,
        3,
      ),
    ).toBe(false);
    expect(
      shouldRetry(
        new ProviderError({
          family: "network",
          code: "NETWORK",
          message: "",
          retryable: true,
        }),
        DEFAULT_RETRY_POLICY,
        1,
      ),
    ).toBe(true);
  });

  it("computes deterministic bounded backoff delays", () => {
    const delays: number[] = [];
    for (
      let attempt = 1;
      attempt <= DEFAULT_RETRY_POLICY.maxAttempts;
      attempt += 1
    ) {
      delays.push(DEFAULT_RETRY_POLICY.delayMs(attempt));
    }
    expect(delays).toEqual([250, 500, 1000]);
  });
});

describe("tool call validation (AC: structured tool calls)", () => {
  it("accepts a valid tool call against its contract", () => {
    const call: ToolCall = {
      id: "call_1",
      name: "inspectSummary",
      arguments: { includeSelection: true },
    };
    expect(validateToolCall(call, [INSPECT_SUMMARY_CONTRACT])).toBeUndefined();
  });

  it("rejects unknown tool names with a stable error", () => {
    const call: ToolCall = {
      id: "call_2",
      name: "deleteEverything",
      arguments: {},
    };
    const error = validateToolCall(call, [INSPECT_SUMMARY_CONTRACT]);
    expect(error).toBeDefined();
    expect(error?.code).toBe("UNKNOWN_TOOL");
  });

  it("rejects malformed arguments with a schema validation error", () => {
    const call: ToolCall = {
      id: "call_3",
      name: "inspectSummary",
      arguments: { includeSelection: "yes" },
    };
    const error = validateToolCall(call, [INSPECT_SUMMARY_CONTRACT]);
    expect(error?.code).toBe("INVALID_ARGUMENT");
    expect(error?.family).toBe("validation");
  });

  it("rejects non-object and missing arguments deterministically", () => {
    expect(
      validateToolCall(
        { id: "call_4", name: "inspectSummary", arguments: null },
        [INSPECT_SUMMARY_CONTRACT],
      )?.code,
    ).toBe("INVALID_ARGUMENT");
  });
});

describe("stream accumulation", () => {
  it("concatenates text deltas, keeps tool call order, and records usage", async () => {
    const events: ProviderEvent[] = [
      textEvent("Short"),
      textEvent("en legs"),
      {
        kind: "tool-call",
        call: { id: "c1", name: "inspectSummary", arguments: {} },
      },
      usageEvent(),
      { kind: "done", finishReason: "tool-calls" },
    ];
    const response = await streamToResponse(events);
    expect(response.text).toBe("Shorten legs");
    expect(response.toolCalls.map((call) => call.name)).toEqual([
      "inspectSummary",
    ]);
    expect(response.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.001,
    });
    expect(response.finishReason).toBe("tool-calls");
  });

  it("throws a normalized error when the stream fails mid-way", async () => {
    const events: ProviderEvent[] = [
      textEvent("partial"),
      {
        kind: "error",
        error: new ProviderError({
          family: "network",
          code: "NETWORK",
          message: "dropped",
          retryable: true,
        }),
      },
    ];
    await expect(streamToResponse(events)).rejects.toMatchObject({
      family: "network",
      code: "NETWORK",
    });
  });

  it("throws a canceled error on an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: ProviderEvent[] = [textEvent("x")];
    await expect(
      streamToResponse(events, { signal: controller.signal }),
    ).rejects.toMatchObject({ family: "canceled", code: "CANCELED" });
  });

  it("detects a missing done event as an invalid response", async () => {
    await expect(
      streamToResponse([textEvent("never done")]),
    ).rejects.toMatchObject({
      family: "invalid-response",
    });
  });

  it("builds a plain chat response snapshot", () => {
    const response = chatResponse({
      text: "ok",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
    });
    expect(response).toEqual({
      text: "ok",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
    });
  });
});

describe("deterministic token estimation", () => {
  it("estimates tokens from text length deterministically", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcdefgh")).toBe(2);
  });

  it("estimates a whole request from its messages and tools", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a voxel editor agent." },
      { role: "user", content: "Make the chair legs shorter." },
      {
        role: "assistant",
        content: "I will inspect first.",
        toolCalls: [{ id: "c1", name: "inspectSummary", arguments: {} }],
      },
    ];
    const tokens = estimateRequestTokens({
      model: "gpt-4o-mini",
      messages,
      tools: [INSPECT_SUMMARY_CONTRACT, FILL_BOX_CONTRACT],
    });
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isInteger(tokens)).toBe(true);
  });
});

describe("ProviderError interop", () => {
  it("serializes as a stable WorkspaceError-shaped record when needed", () => {
    const error = new ProviderError({
      family: "server",
      code: "SERVER_500",
      message: "boom",
      retryable: true,
    });
    expect(isProviderError(error)).toBe(true);
    expect(
      isProviderError(
        new WorkspaceError({ family: "limit", code: "X", message: "y" }),
      ),
    ).toBe(false);
  });
});

describe("estimateImageTokens (plan S15.3, ticket #40)", () => {
  it("charges the flat low-detail rate the v1 adapter sends", () => {
    // The adapter transmits every evidence image at detail:"low", which
    // OpenAI bills as a flat 85 tokens per image regardless of size.
    expect(estimateImageTokens({ width: 512, height: 512 })).toBe(85);
    expect(estimateImageTokens({ width: 1024, height: 1024 })).toBe(85);
    expect(estimateImageTokens({ width: 1, height: 1 })).toBe(85);
    expect(estimateImageTokens({ width: 2048, height: 2048 })).toBe(85);
  });

  it("counts image tokens in whole-request estimates and budgets", () => {
    const image: ChatImage = {
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
      view: "front",
      width: 1024,
      height: 1024,
      revision: 3,
      source: "preview",
    };
    const plain: ChatMessage = { role: "user", content: "hello" };
    const withImage: ChatMessage = {
      role: "user",
      content: "hello",
      images: [image],
    };
    const base = estimateRequestTokens({
      model: "m",
      messages: [plain],
    });
    const withImages = estimateRequestTokens({
      model: "m",
      messages: [withImage],
    });
    expect(withImages - base).toBe(
      estimateImageTokens({ width: 1024, height: 1024 }),
    );
  });
});
