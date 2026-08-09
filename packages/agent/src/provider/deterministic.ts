import type { ProviderErrorData } from "./types.js";
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
 * Deterministic provider adapter (plan S12.3, ticket #33): a scripted,
 * provider-neutral adapter that emits exactly the steps a test or
 * headless run orders, on a virtual clock. Each `complete`/`chat` call
 * consumes exactly one scripted step — one step is one provider
 * response — so a scripted run's rounds, retries, and failure sequences
 * are fully deterministic. It is the single fixture that verifies the
 * successful, malformed, repeated-error, timeout, cancellation, and
 * budget-exhaustion paths of the bounded loop without any network or
 * vendor SDK.
 */

/** One scripted step of a deterministic response. */
export interface DeterministicStep {
  readonly text?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: ProviderUsage;
  /** Emits a normalized error instead of content. */
  readonly error?: ProviderErrorData;
  /** Simulated latency in virtual-clock milliseconds. */
  readonly delayMs?: number;
  readonly finishReason?: ProviderFinishReason;
}

export interface DeterministicProviderOptions {
  /** Steps consumed in order by each `complete` call. */
  readonly script: readonly DeterministicStep[];
  /** Provider id reported by the adapter. */
  readonly providerId?: string;
  /** Default model reported by the adapter. */
  readonly model?: string;
  /** Virtual clock; defaults to `Date.now`. */
  readonly clock?: { now(): number };
  /** Simulated sleep; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * When the script is exhausted, repeat the last error step forever
   * (repeated-error tests); without an error, emit a quiet `stop`.
   */
  readonly repeatLastOnExhaustion?: boolean;
  /** Usage reported when a step omits its own. */
  readonly defaultUsage?: ProviderUsage;
}

function isErrorStep(
  step: DeterministicStep,
): step is DeterministicStep & { readonly error: ProviderErrorData } {
  return step.error !== undefined;
}

export class DeterministicProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly defaultModel: string;
  #script: readonly DeterministicStep[];
  readonly #clock: { now(): number };
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #repeatLast: boolean;
  readonly #defaultUsage: ProviderUsage;
  #calls = 0;
  #cursor = 0;
  /** True when the script's final step is an error to repeat forever. */
  #repeatError = false;
  #lastErrorStep:
    | (DeterministicStep & { readonly error: ProviderErrorData })
    | undefined;

  constructor(options: DeterministicProviderOptions) {
    this.#script = options.script;
    this.providerId = options.providerId ?? "deterministic";
    this.defaultModel = options.model ?? "deterministic-model";
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#repeatLast = options.repeatLastOnExhaustion ?? true;
    const finalStep = this.#script[this.#script.length - 1];
    this.#repeatError =
      this.#repeatLast && finalStep !== undefined && isErrorStep(finalStep);
    this.#defaultUsage = options.defaultUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  /** Number of chat responses completed (one per adapter call). */
  get callCount(): number {
    return this.#calls;
  }

  /**
   * Replaces the scripted steps and resets the cursor, call count, and
   * repeat-error state. Used by the loop harness to re-script one shared
   * provider per session; the adapter stays deterministic either way.
   */
  setScript(script: readonly DeterministicStep[]): void {
    this.#script = script;
    this.#calls = 0;
    this.#cursor = 0;
    this.#repeatError = false;
    this.#lastErrorStep = undefined;
    const finalStep = this.#script[this.#script.length - 1];
    this.#repeatError =
      this.#repeatLast && finalStep !== undefined && isErrorStep(finalStep);
  }

  async *chat(
    request: ProviderChatRequest,
    options: ChatOptions = {},
  ): AsyncIterable<ProviderEvent> {
    this.#calls += 1;
    const startedAt = this.#clock.now();
    const signal = options.signal;
    for (;;) {
      if (signal?.aborted === true) {
        yield {
          kind: "error",
          error: new ProviderError({
            family: "canceled",
            code: "CANCELED",
            message: "Deterministic provider canceled",
            retryable: false,
          }),
        };
        return;
      }
      const step = this.#script[this.#cursor];
      if (step === undefined) {
        if (this.#repeatError && this.#lastErrorStep !== undefined) {
          yield this.#errorEvent(this.#lastErrorStep.error);
        } else {
          yield { kind: "done", finishReason: "stop" };
        }
        return;
      }
      if (step.delayMs !== undefined && step.delayMs > 0) {
        await this.#sleep(step.delayMs);
        if (this.#exceededTimeout(startedAt, options)) {
          yield this.#timeoutEvent();
          return;
        }
      }
      if (isErrorStep(step)) {
        this.#lastErrorStep = step;
        this.#cursor += 1;
        yield this.#errorEvent(step.error);
        return;
      }
      if (step.text !== undefined && step.text.length > 0) {
        yield { kind: "text", delta: step.text };
      }
      for (const call of step.toolCalls ?? []) {
        yield { kind: "tool-call", call };
      }
      yield {
        kind: "usage",
        usage: step.usage ?? this.#defaultUsage,
      };
      yield {
        kind: "done",
        finishReason:
          step.finishReason ??
          ((step.toolCalls?.length ?? 0) > 0 ? "tool-calls" : "stop"),
      };
      this.#cursor += 1;
      return;
    }
  }

  async complete(
    request: ProviderChatRequest,
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    return await streamToResponse(this.chat(request, options), options);
  }

  #exceededTimeout(startedAt: number, options: ChatOptions): boolean {
    if (options.timeoutMs === undefined) return false;
    return this.#clock.now() - startedAt > options.timeoutMs;
  }

  #timeoutEvent(): ProviderEvent {
    return {
      kind: "error",
      error: new ProviderError({
        family: "timeout",
        code: "REQUEST_TIMEOUT",
        message: "Deterministic provider exceeded the request timeout",
        retryable: true,
      }),
    };
  }

  #errorEvent(data: ProviderErrorData): ProviderEvent {
    return {
      kind: "error",
      error: new ProviderError({
        family: data.family,
        code: data.code,
        message: data.message,
        retryable: data.retryable,
        ...(data.context === undefined ? {} : { context: data.context }),
      }),
    };
  }
}
