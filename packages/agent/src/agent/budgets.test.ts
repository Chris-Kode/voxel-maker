import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  DEFAULT_AGENT_BUDGETS,
  BudgetLedger,
  budgetLimitError,
  resolveAgentBudgets,
  type AgentBudgets,
} from "./budgets.js";

/**
 * Agent session budget tests (plan S12.5, ADR-0009, ticket #33 AC):
 * sessions enforce round, token, tool-call, command, output-byte, voxel,
 * animation, duration, time, and estimated-cost budgets with stable
 * LIMIT_EXCEEDED errors and a deterministic injected clock.
 */

class VirtualClock {
  #now = 0;
  now = (): number => this.#now;
  advance = (ms: number): void => {
    this.#now += ms;
  };
}

describe("agent budget defaults (ADR-0009)", () => {
  it("matches the architecture hard defaults", () => {
    expect(DEFAULT_AGENT_BUDGETS).toEqual({
      maxRounds: 16,
      maxToolCalls: 64,
      maxCommands: 1_024,
      maxProposedVoxelChanges: 1_000_000,
      maxTracks: 256,
      maxKeyframes: 10_000,
      maxClipDurationSeconds: 3_600,
      maxOutputBytes: 4_194_304,
      maxTokens: 128_000,
      maxDurationMs: 600_000,
      maxEstimatedCostUsd: 5,
      maxConsecutiveErrors: 3,
      maxToolResultBytes: 65_536,
    });
  });

  it("clamps overrides into [0, default] so callers can only lower", () => {
    const budgets = resolveAgentBudgets({
      maxRounds: 4,
      maxToolCalls: 100,
      maxDurationMs: -5,
    });
    expect(budgets.maxRounds).toBe(4);
    expect(budgets.maxToolCalls).toBe(64);
    expect(budgets.maxDurationMs).toBe(0);
    expect(budgets.maxTokens).toBe(128_000);
  });
});

describe("BudgetLedger: per-resource enforcement", () => {
  function makeLedger(overrides: Partial<AgentBudgets> = {}) {
    const clock = new VirtualClock();
    const budgets = resolveAgentBudgets(overrides);
    return { ledger: new BudgetLedger(budgets, clock), clock, budgets };
  }

  function expectLimit(
    result: { ok: false; error: WorkspaceError },
    resource: string,
    maximum: number,
    requested: number,
  ) {
    expect(result.ok).toBe(false);
    expect(result.error.family).toBe("limit");
    expect(result.error.code).toBe("LIMIT_EXCEEDED");
    expect(result.error.context).toMatchObject({
      resource,
      maximum,
      requested,
    });
  }

  it("enforces the round budget and the elapsed-time budget", () => {
    const { ledger, clock } = makeLedger({ maxRounds: 2, maxDurationMs: 100 });
    expect(ledger.reserveRound().ok).toBe(true);
    expect(ledger.reserveRound().ok).toBe(true);
    const third = ledger.reserveRound();
    expectLimit(third as { ok: false; error: WorkspaceError }, "rounds", 2, 3);
    expect(ledger.round).toBe(2);
    clock.advance(101);
    const timed = ledger.reserveRound();
    expectLimit(
      timed as { ok: false; error: WorkspaceError },
      "duration",
      100,
      101,
    );
  });

  it("enforces the tool-call budget", () => {
    const { ledger } = makeLedger({ maxToolCalls: 1 });
    expect(ledger.reserveToolCall().ok).toBe(true);
    expectLimit(
      ledger.reserveToolCall() as { ok: false; error: WorkspaceError },
      "toolCalls",
      1,
      2,
    );
  });

  it("enforces command and proposed-voxel budgets cumulatively", () => {
    const { ledger } = makeLedger({
      maxCommands: 2,
      maxProposedVoxelChanges: 10,
    });
    expect(ledger.reserveCommand(6).ok).toBe(true);
    expect(ledger.reserveCommand(4).ok).toBe(true);
    expectLimit(
      ledger.reserveCommand(1) as { ok: false; error: WorkspaceError },
      "commands",
      2,
      3,
    );
    const voxelLedger = makeLedger({ maxProposedVoxelChanges: 10 });
    expect(voxelLedger.ledger.reserveCommand(6).ok).toBe(true);
    expectLimit(
      voxelLedger.ledger.reserveCommand(5) as {
        ok: false;
        error: WorkspaceError;
      },
      "proposedVoxelChanges",
      10,
      11,
    );
  });

  it("enforces animation track, keyframe, and clip-duration budgets", () => {
    const { ledger } = makeLedger({
      maxTracks: 2,
      maxKeyframes: 5,
      maxClipDurationSeconds: 10,
    });
    expect(
      ledger.reserveAnimation({
        tracks: 2,
        keyframes: 3,
        clipDurationSeconds: 4,
      }).ok,
    ).toBe(true);
    expectLimit(
      ledger.reserveAnimation({ tracks: 1 }) as {
        ok: false;
        error: WorkspaceError;
      },
      "tracks",
      2,
      3,
    );
    expectLimit(
      ledger.reserveAnimation({ keyframes: 3 }) as {
        ok: false;
        error: WorkspaceError;
      },
      "keyframes",
      5,
      6,
    );
    expectLimit(
      ledger.reserveAnimation({ clipDurationSeconds: 7 }) as {
        ok: false;
        error: WorkspaceError;
      },
      "clipDurationSeconds",
      10,
      11,
    );
  });

  it("enforces the output-byte budget", () => {
    const { ledger } = makeLedger({ maxOutputBytes: 100 });
    expect(ledger.recordOutputBytes(60).ok).toBe(true);
    expect(ledger.recordOutputBytes(40).ok).toBe(true);
    expectLimit(
      ledger.recordOutputBytes(1) as { ok: false; error: WorkspaceError },
      "outputBytes",
      100,
      101,
    );
  });

  it("enforces the combined token budget", () => {
    const { ledger } = makeLedger({ maxTokens: 100 });
    expect(ledger.recordUsage({ inputTokens: 30, outputTokens: 20 }).ok).toBe(
      true,
    );
    expect(ledger.recordUsage({ inputTokens: 30, outputTokens: 20 }).ok).toBe(
      true,
    );
    expectLimit(
      ledger.recordUsage({ inputTokens: 1, outputTokens: 1 }) as {
        ok: false;
        error: WorkspaceError;
      },
      "tokens",
      100,
      102,
    );
  });

  it("enforces the estimated-cost budget via usage records", () => {
    const { ledger } = makeLedger({ maxEstimatedCostUsd: 1 });
    expect(
      ledger.recordUsage({
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0.6,
      }).ok,
    ).toBe(true);
    expect(
      ledger.recordUsage({
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0.4,
      }).ok,
    ).toBe(true);
    expectLimit(
      ledger.recordUsage({
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0.01,
      }) as { ok: false; error: WorkspaceError },
      "estimatedCostUsd",
      1,
      1.01,
    );
  });

  it("tracks consecutive errors with a cutoff", () => {
    const { ledger } = makeLedger({ maxConsecutiveErrors: 2 });
    expect(ledger.recordError().ok).toBe(true);
    expect(ledger.recordError().ok).toBe(true);
    const third = ledger.recordError();
    expectLimit(
      third as { ok: false; error: WorkspaceError },
      "consecutiveErrors",
      2,
      3,
    );
    ledger.resetErrors();
    expect(ledger.recordError().ok).toBe(true);
  });

  it("is atomic: a failed reservation does not consume anything", () => {
    const { ledger } = makeLedger({ maxRounds: 1, maxToolCalls: 1 });
    expect(ledger.reserveRound().ok).toBe(true);
    expect(ledger.reserveRound().ok).toBe(false);
    expect(ledger.round).toBe(1);
    expect(ledger.reserveToolCall().ok).toBe(true);
    expect(ledger.reserveToolCall().ok).toBe(false);
    expect(ledger.toolCalls).toBe(1);
  });

  it("reports usage getters for the final run summary", () => {
    const { ledger } = makeLedger();
    ledger.reserveRound();
    ledger.reserveToolCall();
    ledger.reserveCommand(10);
    ledger.recordOutputBytes(5);
    ledger.recordUsage({
      inputTokens: 1,
      outputTokens: 2,
      estimatedCostUsd: 0.5,
    });
    expect(ledger.round).toBe(1);
    expect(ledger.toolCalls).toBe(1);
    expect(ledger.commands).toBe(1);
    expect(ledger.voxelChanges).toBe(10);
    expect(ledger.outputBytes).toBe(5);
    expect(ledger.inputTokens).toBe(1);
    expect(ledger.outputTokens).toBe(2);
    expect(ledger.costUsd).toBe(0.5);
  });
});

describe("budgetLimitError", () => {
  it("builds a stable, user-safe limit error", () => {
    const error = budgetLimitError("tokens", 128_000, 130_000);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.family).toBe("limit");
    expect(error.code).toBe("LIMIT_EXCEEDED");
    expect(error.toJSON()).toEqual({
      family: "limit",
      code: "LIMIT_EXCEEDED",
      message:
        "Session budget exceeded: tokens (maximum 128000, requested 130000)",
      context: { resource: "tokens", maximum: 128_000, requested: 130_000 },
    });
  });
});
