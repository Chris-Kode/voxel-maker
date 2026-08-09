import { describe, expect, it } from "vitest";
import { AgentTranscript } from "./transcript.js";
import type { ChatMessage, ToolCall } from "../provider/types.js";

/**
 * Safe transcript tests (plan S12.11, ticket #33 AC): opt-in retention,
 * expiry, deletion, and deterministic redaction of secrets and protected
 * content from every exported record.
 */

describe("AgentTranscript", () => {
  const now = 2_000_000;

  it("retains nothing by default and records only when opted in", () => {
    const transcript = new AgentTranscript({ createdAt: now });
    expect(transcript.entryCount).toBe(0);
    expect(transcript.retentionDays).toBe(7);
    expect(transcript.expiresAt).toBe(now + 7 * 24 * 60 * 60 * 1000);
  });

  it("records messages, tool calls, and events as redacted JSON", () => {
    const transcript = new AgentTranscript({
      createdAt: now,
      retentionDays: 1,
      secrets: ["sk-super-secret"],
    });
    const message: ChatMessage = {
      role: "user",
      content: "my key is sk-super-secret and the path is /Users/alice/x",
    };
    transcript.recordMessage(message);
    const call: ToolCall = { id: "c1", name: "inspectSummary", arguments: {} };
    transcript.recordToolCall(call, { ok: true, value: { revision: 3 } });
    transcript.recordEvent({
      kind: "usage",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    const snapshot = transcript.exportRedacted(now);
    expect(snapshot).toBeDefined();
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain("sk-super-secret");
    expect(json).not.toContain("/Users/alice");
    expect(json).toContain("inspectSummary");
    expect(json).toContain('"revision":3');
    expect(transcript.entryCount).toBe(3);
  });

  it("refuses to export after the retention window and can be deleted", () => {
    const transcript = new AgentTranscript({ createdAt: now, retentionDays: 1 });
    transcript.recordMessage({ role: "user", content: "hello" });
    expect(transcript.exportRedacted(now + 24 * 60 * 60 * 1000 + 1)).toBeUndefined();
    transcript.delete();
    expect(transcript.entryCount).toBe(0);
  });
});
