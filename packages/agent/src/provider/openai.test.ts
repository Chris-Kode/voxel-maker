import { describe, expect, it } from "vitest";
import { FILL_BOX_CONTRACT } from "../mutation/index.js";
import { INSPECT_SUMMARY_CONTRACT } from "../tools/index.js";
import { secret } from "./credentials.js";
import { OpenAIProvider } from "./openai.js";
import type { ChatMessage, ProviderChatRequest, ToolCall } from "./types.js";

/**
 * OpenAI adapter tests (plan S12.3, ticket #33): the sole v1 cloud
 * adapter normalizes streaming text, structured tool calls, usage,
 * cancellation, timeout, and safe-retry errors over an injected fetch —
 * no network, no vendor SDK, and no vendor type outside the adapter.
 */

/** Builds a fake fetch that serves SSE lines from an array of chunks. */
function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sseLine(json: unknown): string {
  return `data: ${JSON.stringify(json)}\n\n`;
}

function chunkPayload(payload: Record<string, unknown>): string {
  return sseLine(payload);
}

function request(
  overrides: Partial<ProviderChatRequest> = {},
): ProviderChatRequest {
  return {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "shorten the legs" }],
    ...overrides,
  };
}

function summaryCall(): ToolCall {
  return { id: "call_abc", name: "inspectSummary", arguments: {} };
}

describe("OpenAI adapter: streaming normalization", () => {
  it("streams text deltas, accumulates tool calls, and reports usage", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      const chunks = [
        chunkPayload({
          id: "chatcmpl-1",
          choices: [
            {
              index: 0,
              delta: { content: "I will inspect" },
              finish_reason: null,
            },
          ],
        }),
        chunkPayload({
          id: "chatcmpl-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_abc",
                    function: { name: "inspectSummary", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        chunkPayload({
          id: "chatcmpl-1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        chunkPayload({
          id: "chatcmpl-1",
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 40,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        }),
        "data: [DONE]\n\n",
      ];
      return Promise.resolve(sseResponse(chunks));
    }) as typeof fetch;

    const provider = new OpenAIProvider({
      getApiKey: () => secret("sk-test-1234567890"),
      fetch: fetchImpl,
    });
    const response = await provider.complete(request());
    expect(response.text).toBe("I will inspect");
    expect(response.toolCalls).toEqual([summaryCall()]);
    expect(response.usage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 20,
      estimatedCostUsd: 0.00004,
    });
    expect(response.finishReason).toBe("tool-calls");
    expect(calls.length).toBe(1);
  });

  it("emits a stop reason for a plain text stream", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        sseResponse([
          chunkPayload({
            id: "chatcmpl-2",
            choices: [
              { index: 0, delta: { content: "done" }, finish_reason: "stop" },
            ],
          }),
          "data: [DONE]\n\n",
        ]),
      )) as typeof fetch;
    const provider = new OpenAIProvider({
      getApiKey: () => secret("sk-test-1234567890"),
      fetch: fetchImpl,
    });
    const response = await provider.complete(request());
    expect(response.text).toBe("done");
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("sends provider-neutral messages, tool contracts, and a fixed temperature", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return Promise.resolve(
        sseResponse([
          chunkPayload({
            id: "chatcmpl-3",
            choices: [
              { index: 0, delta: { content: "" }, finish_reason: "stop" },
            ],
          }),
          "data: [DONE]\n\n",
        ]),
      );
    }) as typeof fetch;
    const provider = new OpenAIProvider({
      getApiKey: () => secret("sk-test-1234567890"),
      fetch: fetchImpl,
    });
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a voxel agent." },
      { role: "user", content: "Make it shorter." },
      {
        role: "assistant",
        content: "On it.",
        toolCalls: [summaryCall()],
      },
      {
        role: "tool",
        toolCallId: "call_abc",
        result: { ok: true, value: { revision: 1 } },
      },
    ];
    await provider.complete(
      request({
        messages,
        tools: [INSPECT_SUMMARY_CONTRACT, FILL_BOX_CONTRACT],
        maxTokens: 512,
      }),
    );
    const body = JSON.parse(captured?.body as string) as Record<
      string,
      unknown
    >;
    expect(body["model"]).toBe("gpt-4o-mini");
    expect(body["temperature"]).toBe(0);
    expect(body["stream"]).toBe(true);
    expect(
      (body["stream_options"] as Record<string, unknown>)["include_usage"],
    ).toBe(true);
    expect(body["max_tokens"]).toBe(512);
    const sent = body["messages"] as unknown[];
    expect(sent).toHaveLength(4);
    expect(sent[0]).toEqual({
      role: "system",
      content: "You are a voxel agent.",
    });
    expect(sent[2]).toEqual({
      role: "assistant",
      content: "On it.",
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "inspectSummary", arguments: "{}" },
        },
      ],
    });
    expect(sent[3]).toEqual({
      role: "tool",
      tool_call_id: "call_abc",
      content: '{"revision":1}',
    });
    const tools = body["tools"] as unknown[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "inspectSummary",
        description: INSPECT_SUMMARY_CONTRACT.description,
        parameters: INSPECT_SUMMARY_CONTRACT.inputSchema,
      },
    });
  });
});

describe("OpenAI adapter: normalized errors", () => {
  function providerFor(status: number, body: string): OpenAIProvider {
    return new OpenAIProvider({
      getApiKey: () => secret("sk-test-1234567890"),
      fetch: (() =>
        Promise.resolve(new Response(body, { status }))) as typeof fetch,
    });
  }

  it("maps 401 to a non-retryable authentication error", async () => {
    await expect(
      providerFor(401, "bad key").complete(request()),
    ).rejects.toMatchObject({
      family: "authentication",
      code: "AUTHENTICATION_FAILED",
      retryable: false,
    });
  });

  it("maps 429 to a retryable rate-limit error", async () => {
    await expect(
      providerFor(429, "slow down").complete(request()),
    ).rejects.toMatchObject({
      family: "rate-limit",
      code: "RATE_LIMITED",
      retryable: true,
    });
  });

  it("maps 5xx to a retryable server error", async () => {
    await expect(
      providerFor(503, "unavailable").complete(request()),
    ).rejects.toMatchObject({
      family: "server",
      code: "SERVER_ERROR",
      retryable: true,
    });
  });

  it("maps other 4xx to a non-retryable validation error", async () => {
    await expect(
      providerFor(400, "bad request").complete(request()),
    ).rejects.toMatchObject({
      family: "validation",
      code: "REQUEST_REJECTED",
      retryable: false,
    });
  });

  it("maps network failures to a retryable network error", async () => {
    const provider = new OpenAIProvider({
      getApiKey: () => secret("sk-test-1234567890"),
      fetch: (() => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(provider.complete(request())).rejects.toMatchObject({
      family: "network",
      code: "NETWORK_ERROR",
      retryable: true,
    });
  });

  it("maps malformed SSE to an invalid-response error", async () => {
    const provider = new OpenAIProvider({
      getApiKey: () => secret("sk-test-1234567890"),
      fetch: (() =>
        Promise.resolve(
          sseResponse(["data: {not json\n\n", "data: [DONE]\n\n"]),
        )) as typeof fetch,
    });
    await expect(provider.complete(request())).rejects.toMatchObject({
      family: "invalid-response",
      code: "MALFORMED_STREAM",
      retryable: false,
    });
  });

  it("rejects tool call arguments that are not valid JSON", async () => {
    const provider = new OpenAIProvider({
      getApiKey: () => secret("sk-test-1234567890"),
      fetch: (() =>
        Promise.resolve(
          sseResponse([
            chunkPayload({
              id: "chatcmpl-4",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "c1",
                        function: {
                          name: "inspectSummary",
                          arguments: "{oops",
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
            "data: [DONE]\n\n",
          ]),
        )) as typeof fetch,
    });
    await expect(provider.complete(request())).rejects.toMatchObject({
      family: "invalid-response",
      code: "MALFORMED_TOOL_CALL",
      retryable: false,
    });
  });

  it("rejects non-allowlisted models before any request leaves", async () => {
    let fetched = false;
    const provider = new OpenAIProvider({
      getApiKey: () => secret("sk-test-1234567890"),
      fetch: (() => {
        fetched = true;
        return Promise.resolve(sseResponse([]));
      }) as typeof fetch,
    });
    await expect(
      provider.complete(request({ model: "gpt-3.5-turbo" })),
    ).rejects.toMatchObject({
      family: "validation",
      code: "MODEL_NOT_ALLOWED",
      retryable: false,
    });
    expect(fetched).toBe(false);
  });

  it("fails closed with an authentication error when no key is available", async () => {
    let fetched = false;
    const provider = new OpenAIProvider({
      getApiKey: () => secret(""),
      fetch: (() => {
        fetched = true;
        return Promise.resolve(sseResponse([]));
      }) as typeof fetch,
    });
    await expect(provider.complete(request())).rejects.toMatchObject({
      family: "authentication",
      code: "MISSING_API_KEY",
      retryable: false,
    });
    expect(fetched).toBe(false);
  });
});

describe("OpenAI adapter: cancellation and timeout", () => {
  it("maps a user abort to a non-retryable canceled error", async () => {
    const controller = new AbortController();
    const provider = new OpenAIProvider({
      getApiKey: () => secret("sk-test-1234567890"),
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }) as typeof fetch,
    });
    const pending = provider.complete(request(), { signal: controller.signal });
    // Abort after the request is in flight (microtask turn) so the
    // adapter's signal listener is registered when cancellation lands.
    setTimeout(() => {
      controller.abort();
    }, 0);
    await expect(pending).rejects.toMatchObject({
      family: "canceled",
      code: "CANCELED",
      retryable: false,
    });
  });

  it("maps an internal timeout to a retryable timeout error", async () => {
    const provider = new OpenAIProvider({
      getApiKey: () => secret("sk-test-1234567890"),
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("timed out", "TimeoutError"));
          });
        });
      }) as typeof fetch,
    });
    await expect(
      provider.complete(request(), { timeoutMs: 1 }),
    ).rejects.toMatchObject({
      family: "timeout",
      code: "REQUEST_TIMEOUT",
      retryable: true,
    });
  });
});

describe("OpenAI adapter: vision evidence (plan S15.3, ticket #40)", () => {
  it("encodes bounded standard-view PNGs as vision content parts", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(sseResponse([]));
    }) as typeof fetch;
    const provider = new OpenAIProvider({
      getApiKey: () => secret("sk-test-1234567890"),
      fetch: fetchImpl,
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await provider.complete(
      request({
        messages: [
          {
            role: "user",
            content: "Critique these views.",
            images: [
              {
                mimeType: "image/png",
                bytes: png,
                view: "front",
                width: 512,
                height: 512,
                revision: 7,
                source: "preview",
              },
            ],
          },
        ],
      }),
    );
    const message = bodies[0]?.messages as { content: unknown[] }[];
    const parts = message?.[0]?.content as { type: string; image_url: { url: string; detail: string } }[];
    expect(parts[0]).toEqual({ type: "text", text: "Critique these views." });
    expect(parts[1]?.type).toBe("image_url");
    expect(parts[1]?.image_url.url.startsWith("data:image/png;base64,")).toBe(
      true,
    );
    expect(parts[1]?.image_url.detail).toBe("low");
    // The base64 payload decodes back to the exact PNG bytes.
    const payload = parts[1]?.image_url.url.split(",")[1] ?? "";
    const decoded = new Uint8Array(Buffer.from(payload, "base64"));
    expect([...decoded]).toEqual([...png]);
  });

  it("refuses empty or non-PNG images with a stable validation error", async () => {
    let fetched = false;
    const provider = new OpenAIProvider({
      getApiKey: () => secret("sk-test-1234567890"),
      fetch: (() => {
        fetched = true;
        return Promise.resolve(sseResponse([]));
      }) as typeof fetch,
    });
    await expect(
      provider.complete(
        request({
          messages: [
            {
              role: "user",
              content: "x",
              images: [
                {
                  mimeType: "image/png",
                  bytes: new Uint8Array(0),
                  view: "front",
                  width: 8,
                  height: 8,
                  revision: 1,
                  source: "live",
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      family: "validation",
      code: "EMPTY_IMAGE",
    });
    await expect(
      provider.complete(
        request({
          messages: [
            {
              role: "user",
              content: "x",
              images: [
                {
                  mimeType: "image/jpeg",
                  bytes: new Uint8Array([1]),
                  view: "front",
                  width: 8,
                  height: 8,
                  revision: 1,
                  source: "live",
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      family: "validation",
      code: "UNSUPPORTED_IMAGE_MIME",
    });
    expect(fetched).toBe(false);
  });
});
