import { describe, expect, it } from "vitest";
import { documentId } from "@voxel-maker/shared";
import {
  buildSessionDiagnostics,
  type SessionDiagnosticsInput,
} from "./diagnostics.js";
import { DEFAULT_AGENT_BUDGETS } from "./agent/budgets.js";
import { previewSessionId } from "./preview.js";
import type { AgentRunResult } from "./agent/loop.js";
import type { ChatMessage } from "./provider/types.js";

/**
 * Sanitized-diagnostics tests (issue #44, plan §13): the default report
 * contains no prompts, tool arguments, paths, project contents, or
 * secrets; the opt-in report redacts every one of those before emission.
 */

const HOSTILE_PROMPT =
  "Shorten the legs. My api key is sk-abcdef1234567890 and home is /Users/victim";

function okResult(): AgentRunResult {
  return {
    ok: true,
    state: "approve",
    stagedCommands: 2,
    diff: {
      sessionId: previewSessionId("preview:diagnostics:1"),
      namespace: "preview:diagnostics:1",
      documentId: documentId("document:diagnostics:1"),
      baseRevision: 0,
      revision: 2,
      stagedCommandCount: 2,
      commandTypes: [],
      changedNodeIds: [],
      changedMaterialIds: [],
      changedVolumeIds: [],
      changedAnimationIds: [],
      voxelEstimate: 0,
      truncated: false,
    },
    refinement: undefined,
    rounds: 3,
    toolCalls: 5,
    usage: {
      inputTokens: 120,
      outputTokens: 40,
      estimatedCostUsd: 0.0004,
    },
  };
}

function failedResult(): AgentRunResult {
  return {
    ok: false,
    state: "error",
    reason: "limit",
    error: Object.assign(new Error("session budget exceeded"), {
      code: "LIMIT_EXCEEDED",
    }),
    // Issue #78: failed results carry the cumulative consumed evidence.
    rounds: 2,
    toolCalls: 3,
    usage: {
      inputTokens: 200_000,
      outputTokens: 40,
      estimatedCostUsd: 0.2,
    },
  };
}

function messages(): ChatMessage[] {
  return [
    { role: "system", content: "fixed system prompt" },
    { role: "user", content: HOSTILE_PROMPT },
    {
      role: "assistant",
      content: "I will inspect.",
      toolCalls: [
        {
          id: "c1",
          name: "inspectSummary",
          arguments: { includeSelection: true },
        },
        {
          id: "c2",
          name: "batchFill",
          arguments: { coordinates: [[0, 0, 0]], material: 1 },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "c1",
      result: {
        ok: true,
        value: { document: { documentId: "document:local" } },
      },
    },
  ];
}

function input(
  overrides: Partial<SessionDiagnosticsInput> = {},
): SessionDiagnosticsInput {
  return {
    providerId: "deterministic",
    model: "gpt-4o-mini",
    result: okResult(),
    messages: messages(),
    budgets: DEFAULT_AGENT_BUDGETS,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("buildSessionDiagnostics", () => {
  it("omits prompts, tool arguments, and project contents by default", () => {
    const report = buildSessionDiagnostics(input());
    expect(report.prompts).toBeUndefined();
    const text = JSON.stringify(report);
    expect(text).not.toContain("Shorten the legs");
    expect(text).not.toContain("includeSelection");
    expect(text).not.toContain("document:local");
    expect(text).not.toContain("/Users/victim");
    expect(text).not.toContain("sk-abcdef");
    expect(text).toContain('"rounds":3');
    expect(text).toContain('"toolCalls":5');
    expect(report.staged).toEqual({ commands: 2 });
  });

  it("reports bounded metrics and outcome for successful runs", () => {
    const report = buildSessionDiagnostics(input());
    expect(report.schemaVersion).toBe(1);
    expect(report.createdAt).toBe(1_700_000_000_000);
    expect(report.provider).toEqual({
      providerId: "deterministic",
      model: "gpt-4o-mini",
    });
    expect(report.outcome).toEqual({ ok: true, state: "approve" });
    expect(report.usage).toEqual({
      rounds: 3,
      toolCalls: 5,
      inputTokens: 120,
      outputTokens: 40,
      estimatedCostUsd: 0.0004,
    });
    expect(report.limits.maxRounds).toBe(DEFAULT_AGENT_BUDGETS.maxRounds);
  });

  it("reports failure reason and stable error code without stack traces", () => {
    const report = buildSessionDiagnostics(input({ result: failedResult() }));
    expect(report.outcome.ok).toBe(false);
    expect(report.outcome.reason).toBe("limit");
    expect(report.outcome.errorCode).toBe("LIMIT_EXCEEDED");
    // Issue #78: failed runs keep their consumed rounds, tokens, and cost.
    expect(report.usage).toEqual({
      rounds: 2,
      toolCalls: 3,
      inputTokens: 200_000,
      outputTokens: 40,
      estimatedCostUsd: 0.2,
    });
    expect(report.staged).toBeUndefined();
    const text = JSON.stringify(report);
    expect(text).not.toContain("session budget exceeded");
    expect(text).not.toContain("at ");
  });

  it("redacts opt-in prompts and tool arguments", () => {
    const report = buildSessionDiagnostics(
      input({ includePrompts: true, secrets: ["explicit-secret"] }),
    );
    expect(report.prompts).toBeDefined();
    const text = JSON.stringify(report);
    expect(text).not.toContain("sk-abcdef");
    expect(text).not.toContain("/Users/victim");
    expect(text).toContain("[REDACTED]");
    // Tool arguments are included only when opted in, and stay redacted.
    expect(text).toContain("inspectSummary");
    expect(report.prompts?.toolCalls).toHaveLength(2);
  });

  it("never includes project document ids even when prompts are opted in", () => {
    const report = buildSessionDiagnostics(input({ includePrompts: true }));
    const text = JSON.stringify(report);
    expect(text).not.toContain("document:local");
  });
});
