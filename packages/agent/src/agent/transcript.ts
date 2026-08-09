import type { JsonValue } from "@voxel-maker/shared";
import { redactJson } from "../provider/redact.js";
import type {
  ChatMessage,
  ProviderEvent,
  ToolCall,
  ToolCallResult,
} from "../provider/types.js";

/**
 * Opt-in safe transcript (plan S12.11, ADR-0010, ticket #33): no
 * transcript is retained by default; an explicit per-session choice keeps
 * a local record that expires after a user-selected 1, 7, or 30 days.
 * Every entry is redacted at write time (secrets, paths, URLs, provider
 * payloads) so retained data never contains a credential, and export is a
 * plain JSON snapshot suitable for local encrypted-at-rest storage by the
 * composition root.
 */

export type RetentionDays = 1 | 7 | 30;

export interface TranscriptOptions {
  readonly retentionDays?: RetentionDays;
  /** Epoch ms of creation; injected clock keeps tests deterministic. */
  readonly createdAt?: number;
  /** Explicit secret values redacted from every entry. */
  readonly secrets?: readonly string[];
}

export type TranscriptEntry =
  | { readonly kind: "message"; readonly message: JsonValue }
  | {
      readonly kind: "tool";
      readonly call: JsonValue;
      readonly result: JsonValue;
    }
  | { readonly kind: "event"; readonly event: JsonValue };

/** Redacted transcript snapshot for export. */
export interface TranscriptSnapshot {
  readonly createdAt: number;
  readonly retentionDays: RetentionDays;
  readonly expiresAt: number;
  readonly entries: readonly TranscriptEntry[];
}

function messageToJson(message: ChatMessage): JsonValue {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        ...(message.content === undefined ? {} : { content: message.content }),
        ...(message.toolCalls === undefined
          ? {}
          : { toolCalls: message.toolCalls }),
      };
    case "tool":
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        result: message.result,
      };
  }
}

export class AgentTranscript {
  readonly retentionDays: RetentionDays;
  readonly createdAt: number;
  readonly #secrets: readonly string[];
  #entries: TranscriptEntry[] = [];

  constructor(options: TranscriptOptions = {}) {
    this.retentionDays = options.retentionDays ?? 7;
    this.createdAt = options.createdAt ?? Date.now();
    this.#secrets = options.secrets ?? [];
  }

  get expiresAt(): number {
    return this.createdAt + this.retentionDays * 24 * 60 * 60 * 1000;
  }

  /** True after the retention window (no export allowed). */
  expired(now: number = Date.now()): boolean {
    return now > this.expiresAt;
  }

  get entryCount(): number {
    return this.#entries.length;
  }

  recordMessage(message: ChatMessage): void {
    this.#entries.push({
      kind: "message",
      message: redactJson(messageToJson(message), this.#secrets),
    });
  }

  recordToolCall(call: ToolCall, result: ToolCallResult): void {
    this.#entries.push({
      kind: "tool",
      call: redactJson(call as unknown as JsonValue, this.#secrets),
      result: redactJson(result as unknown as JsonValue, this.#secrets),
    });
  }

  recordEvent(event: ProviderEvent): void {
    this.#entries.push({
      kind: "event",
      event: redactJson(event as unknown as JsonValue, this.#secrets),
    });
  }

  /** Redacted JSON snapshot; refuses to export an expired transcript. */
  exportRedacted(now: number = Date.now()): TranscriptSnapshot | undefined {
    if (this.expired(now)) return undefined;
    return {
      createdAt: this.createdAt,
      retentionDays: this.retentionDays,
      expiresAt: this.expiresAt,
      entries: Object.freeze([...this.#entries]),
    };
  }

  /** Deletes the retained record. */
  delete(): void {
    this.#entries = [];
  }
}
