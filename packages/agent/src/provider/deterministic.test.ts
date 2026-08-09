import { describe, expect, it } from "vitest";
import {
  DeterministicProvider,
  type DeterministicStep,
} from "./deterministic.js";
import type {
  ChatOptions,
  ProviderChatRequest,
  ToolCall,
} from "./types.js";

/**
 * Deterministic provider adapter tests (plan S12.3, ticket #33 AC): the
 * scripted adapter verifies successful, malformed, repeated-error,
 * timeout, cancellation, and budget-exhaustion paths on a virtual clock,
 * with no network and no vendor types.
 */

/** Virtual clock: sleep advances time synchronously, so tests stay fast. */
class VirtualClock {
  #now = 0;
  now = (): number => this.#now;
  sleep = async (ms: number): Promise<void> => {
    this.#now += ms;
  };
}

function request(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    model: "deterministic-model",
    messages: [{ role: "user", content: "shorten the chair legs" }],
    ...overrides,
  };
}

function summaryCall(id: string): ToolCall {
  return { id, name: "inspectSummary", arguments: {} };
}

describe("deterministic provider: successful path", () => {
  it("streams text deltas, tool calls, usage, and a finish reason", async () => {
    const clock = new VirtualClock();
    const provider = new DeterministicProvider({
      script: [
        { text: "Let me look", delayMs: 5 },
        {
          text: " at the chair",
          toolCalls: [summaryCall("call_1")],
          usage: { inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.0001 },
          delayMs: 10,
        },
      ],
      clock,
      sleep: clock.sleep,
    });
    const response = await provider.complete(request(), { timeoutMs: 1000 });
    expect(response.text).toBe("Let me look at the chair");
    expect(response.toolCalls).toEqual([summaryCall("call_1")]);
    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostUsd: 0.0001,
    });
    expect(response.finishReason).toBe("tool-calls");
    expect(clock.now()).toBe(15);
    expect(provider.callCount).toBe(1);
  });

  it("emits a plain stop when no tools are requested", async () => {
    const provider = new DeterministicProvider({ script: [{ text: "done" }] });
    const response = await provider.complete(request());
    expect(response.text).toBe("done");
    expect(response.finishReason).toBe("stop");
    expect(response.toolCalls).toEqual([]);
  });
});

describe("deterministic provider: malformed path", () => {
  it("emits a normalized invalid-response error for malformed content", async () => {
    const provider = new DeterministicProvider({
      script: [
        {
          error: {
            family: "invalid-response",
            code: "MALFORMED_TOOL_CALL",
            message: "tool call arguments were not valid JSON",
            retryable: false,
          },
        },
      ],
    });
    await expect(provider.complete(request())).rejects.toMatchObject({
      family: "invalid-response",
      code: "MALFORMED_TOOL_CALL",
      retryable: false,
    });
  });
});

describe("deterministic provider: repeated-error path", () => {
  it("emits the next scripted failure per retry and then succeeds", async () => {
    const provider = new DeterministicProvider({
      script: [
        {
          error: {
            family: "server",
            code: "SERVER_502",
            message: "bad gateway",
            retryable: true,
          },
        },
        {
          error: {
            family: "rate-limit",
            code: "RATE_LIMITED",
            message: "slow down",
            retryable: true,
          },
        },
        { text: "recovered", usage: { inputTokens: 5, outputTokens: 2 } },
      ],
    });
    await expect(provider.complete(request())).rejects.toMatchObject({
      code: "SERVER_502",
    });
    await expect(provider.complete(request())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    const response = await provider.complete(request());
    expect(response.text).toBe("recovered");
    expect(provider.callCount).toBe(3);
  });

  it("keeps failing forever after the last error step (cutoff fixture)", async () => {
    const provider = new DeterministicProvider({
      script: [
        {
          error: {
            family: "server",
            code: "SERVER_500",
            message: "still failing",
            retryable: true,
          },
        },
      ],
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(provider.complete(request())).rejects.toMatchObject({
        code: "SERVER_500",
      });
    }
    expect(provider.callCount).toBe(4);
  });
});

describe("deterministic provider: timeout path", () => {
  it("emits a normalized timeout error when the virtual clock exceeds the request timeout", async () => {
    const clock = new VirtualClock();
    const provider = new DeterministicProvider({
      script: [{ text: "slow", delayMs: 500 }],
      clock,
      sleep: clock.sleep,
    });
    await expect(
      provider.complete(request(), { timeoutMs: 100 }),
    ).rejects.toMatchObject({
      family: "timeout",
      code: "REQUEST_TIMEOUT",
      retryable: true,
    });
  });

  it("succeeds when the simulated latency fits the timeout", async () => {
    const clock = new VirtualClock();
    const provider = new DeterministicProvider({
      script: [{ text: "fast", delayMs: 50 }],
      clock,
      sleep: clock.sleep,
    });
    const response = await provider.complete(request(), { timeoutMs: 100 });
    expect(response.text).toBe("fast");
  });
});

describe("deterministic provider: cancellation path", () => {
  it("emits a canceled error when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new DeterministicProvider({ script: [{ text: "x" }] });
    await expect(
      provider.complete(request(), { signal: controller.signal }),
    ).rejects.toMatchObject({ family: "canceled", code: "CANCELED" });
  });

  it("emits a canceled error mid-stream when the signal aborts", async () => {
    const clock = new VirtualClock();
    const controller = new AbortController();
    const provider = new DeterministicProvider({
      script: [
        { text: "first", delayMs: 10 },
        { text: "second", delayMs: 10 },
      ],
      clock,
      sleep: async (ms: number) => {
        void ms;
        controller.abort();
      },
    });
    await expect(
      provider.complete(request(), { signal: controller.signal }),
    ).rejects.toMatchObject({ family: "canceled" });
  });
});

describe("deterministic provider: budget-exhaustion fixture", () => {
  it("reports usage large enough for the loop to hit token and cost caps", async () => {
    const provider = new DeterministicProvider({
      script: [
        {
          text: "huge response",
          usage: {
            inputTokens: 200_000,
            outputTokens: 400_000,
            estimatedCostUsd: 12.5,
          },
        },
      ],
    });
    const response = await provider.complete(request());
    expect(response.usage.inputTokens).toBe(200_000);
    expect(response.usage.outputTokens).toBe(400_000);
    expect(response.usage.estimatedCostUsd).toBe(12.5);
  });

  it("exposes a chat() stream for event-level assertions", async () => {
    const provider = new DeterministicProvider({
      script: [{ text: "streamed", usage: { inputTokens: 1, outputTokens: 1 } }],
    });
    const events: string[] = [];
    const options: ChatOptions = {};
    for await (const event of provider.chat(request(), options)) {
      events.push(event.kind);
    }
    expect(events).toEqual(["text", "usage", "done"]);
  });
});
