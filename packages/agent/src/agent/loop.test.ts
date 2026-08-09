import { describe, expect, it } from "vitest";
import { CommandBus, CommandRegistry } from "@voxel-maker/commands";
import type { DocumentStoreRead } from "@voxel-maker/document";
import { WorkspaceError } from "@voxel-maker/shared";
import { createInspectionStore } from "../fixtures.js";
import { createInspector } from "../inspector.js";
import { createMutator } from "../mutator.js";
import { createPreviewSession, previewSessionId } from "../preview.js";
import { createPreviewRegistry } from "../registry.js";
import {
  DeterministicProvider,
  type DeterministicStep,
} from "../provider/deterministic.js";
import { DISCLOSURE_CATEGORIES, createConsent } from "../provider/consent.js";
import { DEFAULT_RETRY_POLICY, type ToolCall } from "../provider/types.js";
import {
  createAgentSession,
  type AgentEvent,
  type AgentLoopOptions,
  type AgentRunResult,
} from "./loop.js";

/**
 * Bounded agent loop tests (plan S12.5, ticket #33 AC): the deterministic
 * provider verifies the successful, malformed, repeated-error, timeout,
 * cancellation, and budget-exhaustion paths end to end, and the run never
 * auto-applies — commit and discard are explicit user actions.
 */

/** Virtual clock whose sleep advances synchronously. */
class VirtualClock {
  #now = 0;
  now = (): number => this.#now;
  sleep = (ms: number): Promise<void> => {
    this.#now += ms;
    return Promise.resolve();
  };
}

interface Harness {
  readonly store: DocumentStoreRead;
  readonly bus: CommandBus;
  readonly registry: CommandRegistry;
  readonly clock: VirtualClock;
  readonly provider: DeterministicProvider;
  makeSession(
    script?: readonly DeterministicStep[],
    options?: Partial<AgentLoopOptions>,
  ): ReturnType<typeof createAgentSession>;
}

const CONSENT = createConsent({
  providerId: "deterministic",
  model: "deterministic-model",
  categories: DISCLOSURE_CATEGORIES,
  consentedAt: 0,
  expiresAt: 1_000_000_000_000,
});

function summaryCall(id = "call_summary"): ToolCall {
  return { id, name: "inspectSummary", arguments: {} };
}

function fillBoxCall(id = "call_fill"): ToolCall {
  return {
    id,
    name: "fillBox",
    arguments: {
      volumeId: "volume:main",
      region: { min: [0, 0, 0], max: [1, 1, 1] },
      material: 1,
    },
  };
}

function harness(): Harness {
  const { handle } = createInspectionStore();
  const registry = createPreviewRegistry();
  const bus = new CommandBus(handle.store, registry, handle.writeCapability);
  const clock = new VirtualClock();
  const provider = new DeterministicProvider({
    script: [],
    clock,
    sleep: clock.sleep,
  });
  return {
    store: handle.store,
    bus,
    registry,
    clock,
    provider,
    makeSession(script, options) {
      const session = createPreviewSession({
        live: handle.store,
        applyBus: bus,
        sessionId: previewSessionId("preview:loop:test"),
      });
      const inspector = createInspector({
        store: session,
        capabilities: ["inspect"],
      });
      const mutator = createMutator({
        store: session,
        registry,
        session,
        capabilities: ["mutate"],
      });
      this.provider.setScript(script ?? []);
      return createAgentSession({
        provider: this.provider,
        inspector,
        mutator,
        preview: session,
        consent: CONSENT,
        userPrompt: "Shorten the chair legs.",
        clock,
        sleep: clock.sleep,
        ...options,
      });
    },
  };
}

function runOk(result: AgentRunResult): Extract<AgentRunResult, { ok: true }> {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result as Extract<AgentRunResult, { ok: true }>;
}

function runErr(
  result: AgentRunResult,
): Extract<AgentRunResult, { ok: false }> {
  expect(result.ok).toBe(false);
  return result as Extract<AgentRunResult, { ok: false }>;
}

const SUCCESS_SCRIPT: readonly DeterministicStep[] = [
  { text: "I will inspect the chair.", toolCalls: [summaryCall()] },
  { text: "I will shorten the legs.", toolCalls: [fillBoxCall()] },
  {
    text: "Let me verify the staged result.",
    toolCalls: [summaryCall("call_summary2")],
  },
  { text: "The proposal is ready for approval." },
];

describe("agent loop: successful path (AC: explicit states)", () => {
  it("walks understand->inspect->plan->stage->inspect-staged->validate->approve", async () => {
    const h = harness();
    const states: string[] = [];
    const session = h.makeSession(SUCCESS_SCRIPT, {
      onEvent: (event) => {
        if (event.kind === "state") states.push(event.state);
      },
    });
    const result = runOk(await session.run());
    expect(result.state).toBe("approve");
    expect(states).toEqual([
      "understand",
      "inspect",
      "plan",
      "stage",
      "inspect-staged",
      "validate",
      "approve",
    ]);
    expect(session.machine.state).toBe("approve");
    expect(session.preview.stagedCount).toBe(1);
    expect(session.preview.voxelEstimate).toBeGreaterThan(0);
    expect(result.stagedCommands).toBe(1);
    expect(result.diff.stagedCommandCount).toBe(1);
    expect(result.diff.commandTypes[0]?.type).toBe("voxel.fillBox");
    expect(result.rounds).toBe(4);
    expect(result.toolCalls).toBe(3);
    expect(h.provider.callCount).toBe(4);
  });

  it("never auto-applies: live revision and history stay untouched", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT);
    const base = h.store.revision;
    const result = runOk(await session.run());
    expect(h.store.revision).toBe(base);
    expect(h.bus.historySnapshot().past).toHaveLength(0);
    expect(session.preview.closed).toBe(false);
    expect(result.state).toBe("approve");
  });

  it("apply commits one labeled history entry and closes the preview", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT);
    const base = h.store.revision;
    await session.run();
    const applied = session.apply({ label: "AI: shorten chair legs" });
    expect(applied.ok).toBe(true);
    expect(h.store.revision).toBe(base + 1);
    expect(session.preview.closed).toBe(true);
    expect(session.machine.state).toBe("commit");
    const history = h.bus.historySnapshot().past;
    expect(history).toHaveLength(1);
    expect(history[0]?.label).toBe("AI: shorten chair legs");
    expect(history[0]?.revisionBefore).toBe(base);
  });

  it("discard drops the proposal with no live side effects", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT);
    const base = h.store.revision;
    await session.run();
    session.discard();
    expect(h.store.revision).toBe(base);
    expect(h.bus.historySnapshot().past).toHaveLength(0);
    expect(session.preview.closed).toBe(true);
    expect(session.machine.state).toBe("discard");
  });

  it("refuses apply/discard before approval", () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT);
    expect(() => session.apply()).toThrow(WorkspaceError);
    expect(() => {
      session.discard();
    }).toThrow(WorkspaceError);
  });

  it("records usage into the result summary", async () => {
    const h = harness();
    const script = [
      {
        text: "done",
        usage: { inputTokens: 50, outputTokens: 10, estimatedCostUsd: 0.001 },
      },
    ];
    const session = h.makeSession(script);
    const result = runOk(await session.run());
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      estimatedCostUsd: 0.001,
    });
    expect(result.stagedCommands).toBe(0);
  });
});

describe("agent loop: malformed tool calls", () => {
  it("validates tool calls before execution and feeds the error back", async () => {
    const h = harness();
    const script: readonly DeterministicStep[] = [
      {
        text: "I will use a bogus tool",
        toolCalls: [
          { id: "call_bad", name: "deleteEverything", arguments: {} },
        ],
      },
      { text: "I understand, that tool is unavailable. Nothing to change." },
    ];
    const session = h.makeSession(script);
    const result = runOk(await session.run());
    expect(result.state).toBe("approve");
    expect(result.stagedCommands).toBe(0);
    const toolMessages = session.messages.filter(
      (message) => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(1);
    const tool = toolMessages[0];
    expect(tool?.role).toBe("tool");
    if (tool?.role === "tool") {
      expect(tool.result.ok).toBe(false);
      if (!tool.result.ok) {
        expect(tool.result.error.code).toBe("UNKNOWN_TOOL");
      }
    }
  });

  it("rejects malformed arguments with a schema error", async () => {
    const h = harness();
    const script: readonly DeterministicStep[] = [
      {
        text: "Bad args",
        toolCalls: [
          {
            id: "call_bad2",
            name: "inspectSummary",
            arguments: { includeSelection: "yes" },
          },
        ],
      },
      { text: "Fixed." },
    ];
    const session = h.makeSession(script);
    const result = runOk(await session.run());
    const tool = session.messages.find((message) => message.role === "tool");
    expect(tool?.role).toBe("tool");
    if (tool?.role === "tool" && !tool.result.ok) {
      expect(tool.result.error.code).toBe("INVALID_ARGUMENT");
    }
    expect(result.stagedCommands).toBe(0);
  });

  it("ends in error when malformed calls repeat past the cutoff", async () => {
    const h = harness();
    const script: readonly DeterministicStep[] = [
      { toolCalls: [{ id: "b1", name: "nope1", arguments: {} }] },
      { toolCalls: [{ id: "b2", name: "nope2", arguments: {} }] },
      { toolCalls: [{ id: "b3", name: "nope3", arguments: {} }] },
      { toolCalls: [{ id: "b4", name: "nope4", arguments: {} }] },
    ];
    const session = h.makeSession(script, {
      budgets: { maxConsecutiveErrors: 3 },
    });
    const result = runErr(await session.run());
    expect(result.state).toBe("error");
    expect(result.reason).toBe("cutoff");
    expect(session.preview.closed).toBe(true);
    if (result.error instanceof WorkspaceError) {
      expect(result.error.code).toBe("LIMIT_EXCEEDED");
      expect(result.error.context).toMatchObject({
        resource: "consecutiveErrors",
      });
    }
  });
});

describe("agent loop: repeated provider errors", () => {
  it("retries transient failures and hits the cutoff on persistent errors", async () => {
    const h = harness();
    const script: readonly DeterministicStep[] = [
      {
        error: {
          family: "server",
          code: "SERVER_500",
          message: "boom",
          retryable: true,
        },
      },
      {
        error: {
          family: "server",
          code: "SERVER_500",
          message: "boom",
          retryable: true,
        },
      },
      {
        error: {
          family: "server",
          code: "SERVER_500",
          message: "boom",
          retryable: true,
        },
      },
    ];
    const session = h.makeSession(script);
    const result = runErr(await session.run());
    expect(result.reason).toBe("cutoff");
    expect(result.state).toBe("error");
    // 3 rounds x 3 attempts each (retries are bounded by the policy)
    expect(h.provider.callCount).toBe(9);
    expect(session.preview.closed).toBe(true);
  });

  it("tells the model about exhausted retries so the next round can recover", async () => {
    const h = harness();
    const script: readonly DeterministicStep[] = [
      {
        error: {
          family: "server",
          code: "SERVER_500",
          message: "boom",
          retryable: true,
        },
      },
      { text: "I see the provider failed; nothing to stage." },
    ];
    const session = h.makeSession(script, {
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
    });
    const result = runOk(await session.run());
    expect(result.state).toBe("approve");
    expect(
      session.messages.some(
        (message) =>
          message.role === "system" && message.content.includes("SERVER_500"),
      ),
    ).toBe(true);
  });

  it("succeeds when a retry succeeds", async () => {
    const h = harness();
    const script: readonly DeterministicStep[] = [
      {
        error: {
          family: "server",
          code: "SERVER_500",
          message: "boom",
          retryable: true,
        },
      },
      {
        error: {
          family: "server",
          code: "SERVER_500",
          message: "boom",
          retryable: true,
        },
      },
      { text: "Recovered. No changes needed." },
    ];
    const session = h.makeSession(script);
    const result = runOk(await session.run());
    expect(result.state).toBe("approve");
    expect(h.provider.callCount).toBe(3);
  });

  it("does not retry non-retryable failures", async () => {
    const h = harness();
    const script: readonly DeterministicStep[] = [
      {
        error: {
          family: "authentication",
          code: "AUTHENTICATION_FAILED",
          message: "bad key",
          retryable: false,
        },
      },
    ];
    const session = h.makeSession(script);
    const result = runErr(await session.run());
    expect(result.reason).toBe("provider");
    expect(h.provider.callCount).toBe(1);
    expect(session.preview.closed).toBe(true);
  });
});

describe("agent loop: timeout path", () => {
  it("normalizes a timeout and fails closed after bounded retries", async () => {
    const h = harness();
    const script: readonly DeterministicStep[] = [
      { text: "slow", delayMs: 500 },
    ];
    const session = h.makeSession(script, {
      requestTimeoutMs: 100,
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("provider");
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as { family?: string }).family).toBe("timeout");
    expect((result.error as { code?: string }).code).toBe("REQUEST_TIMEOUT");
    expect(session.preview.closed).toBe(true);
  });
});

describe("agent loop: cancellation", () => {
  it("stops at the next boundary, reaches cancel, and releases the preview", async () => {
    const h = harness();
    // A real-timer sleep keeps the provider request genuinely in flight
    // so cancel() lands mid-round; the virtual clock still guards the
    // request timeout (none is set here), and the run is bounded.
    const realSleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const provider = new DeterministicProvider({
      script: [{ text: "in progress", delayMs: 50 }, { text: "never reached" }],
      clock: h.clock,
      sleep: realSleep,
    });
    const session = h.makeSession(undefined, { provider });
    const pending = session.run();
    setTimeout(() => {
      session.cancel();
    }, 10);
    const result = runErr(await pending);
    expect(result.reason).toBe("canceled");
    expect(result.state).toBe("cancel");
    expect(session.machine.state).toBe("cancel");
    expect(session.preview.closed).toBe(true);
  });

  it("cancels before the first round when requested early", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT);
    session.cancel();
    const result = runErr(await session.run());
    expect(result.reason).toBe("canceled");
    expect(session.preview.closed).toBe(true);
    expect(h.provider.callCount).toBe(0);
  });
});

describe("agent loop: budget exhaustion", () => {
  it("stops on round exhaustion with a stable limit error", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT, {
      budgets: { maxRounds: 1 },
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    expect(result.state).toBe("error");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.context).toMatchObject({ resource: "rounds" });
    }
    expect(session.preview.closed).toBe(true);
  });

  it("stops on tool-call exhaustion", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT, {
      budgets: { maxToolCalls: 1 },
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.context).toMatchObject({ resource: "toolCalls" });
    }
  });

  it("stops on token exhaustion reported by usage", async () => {
    const h = harness();
    const script: readonly DeterministicStep[] = [
      {
        text: "expensive",
        usage: { inputTokens: 200_000, outputTokens: 0 },
      },
    ];
    const session = h.makeSession(script);
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.context).toMatchObject({ resource: "tokens" });
    }
  });

  it("stops on estimated-cost exhaustion", async () => {
    const h = harness();
    const script: readonly DeterministicStep[] = [
      {
        text: "costly",
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 6 },
      },
    ];
    const session = h.makeSession(script);
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.context).toMatchObject({
        resource: "estimatedCostUsd",
      });
    }
  });

  it("stops before staging when the command budget is exhausted", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT, {
      budgets: { maxCommands: 0 },
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.context).toMatchObject({ resource: "commands" });
    }
    expect(session.preview.stagedCount).toBe(0);
  });

  it("stops before staging when the voxel budget is exhausted", async () => {
    const h = harness();
    // The fixture's fillBox region estimates 1 voxel, so a zero-voxel
    // session budget must fail before anything is staged.
    const session = h.makeSession(SUCCESS_SCRIPT, {
      budgets: { maxProposedVoxelChanges: 0 },
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.context).toMatchObject({
        resource: "proposedVoxelChanges",
      });
    }
    expect(session.preview.stagedCount).toBe(0);
  });

  it("stops when a single tool result exceeds the per-result byte budget", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT, {
      budgets: { maxToolResultBytes: 1 },
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.context).toMatchObject({
        resource: "toolResultBytes",
      });
    }
    expect(session.preview.closed).toBe(true);
  });

  it("stops when the output-byte budget is exhausted", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT, {
      budgets: { maxOutputBytes: 0 },
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.context).toMatchObject({ resource: "outputBytes" });
    }
  });

  it("fails the run when the preview staging budget rejects a command", async () => {
    const h = harness();
    const preview = createPreviewSession({
      live: h.store,
      applyBus: h.bus,
      sessionId: previewSessionId("preview:loop:stage-limit"),
      limits: { maxStagedCommands: 0 },
    });
    const inspector = createInspector({
      store: preview,
      capabilities: ["inspect"],
    });
    const mutator = createMutator({
      store: preview,
      registry: h.registry,
      session: preview,
      capabilities: ["mutate"],
    });
    const session = h.makeSession(SUCCESS_SCRIPT, {
      preview,
      inspector,
      mutator,
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.family).toBe("limit");
      expect(result.error.code).toBe("STAGING_COMMAND_LIMIT");
    }
    expect(session.preview.closed).toBe(true);
    expect(session.preview.stagedCount).toBe(0);
  });

  it("feeds a rejected stage back to the model and keeps the run alive", async () => {
    const h = harness();
    // Two fillBox calls carrying the same explicit command id: the first
    // stages, the second is rejected by the preview session as a
    // duplicate, which must release the session reservations and be fed
    // back as a tool error instead of failing the run.
    const sameCommand = (id: string): ToolCall => ({
      id,
      name: "fillBox",
      arguments: {
        volumeId: "volume:main",
        region: { min: [0, 0, 0], max: [1, 1, 1] },
        material: 1,
        commandId: "cmd:duplicate",
      },
    });
    const session = h.makeSession([
      {
        text: "stage the same command twice",
        toolCalls: [sameCommand("call_fill_a"), sameCommand("call_fill_b")],
      },
      { text: "The duplicate was rejected; nothing more to do." },
    ]);
    const result = runOk(await session.run());
    expect(result.stagedCommands).toBe(1);
    const toolMessages = session.messages.filter(
      (message) => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(2);
    const second = toolMessages[1];
    expect(second?.role).toBe("tool");
    if (second?.role === "tool" && !second.result.ok) {
      expect(second.result.error.code).toBe("DUPLICATE_COMMAND_ID");
    }
  });

  it("stops when the duration budget is exhausted", async () => {
    const h = harness();
    const clock = new VirtualClock();
    // A dedicated provider shares the test clock: its simulated latency
    // advances the clock inside round 1, and the next round's
    // reservation must fail the duration cap.
    const provider = new DeterministicProvider({
      script: [{ text: "late", delayMs: 200, toolCalls: [summaryCall()] }],
      clock,
      sleep: clock.sleep,
    });
    const session = h.makeSession(undefined, {
      provider,
      budgets: { maxDurationMs: 100 },
      clock,
      sleep: clock.sleep,
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.context).toMatchObject({ resource: "duration" });
    }
  });

  it("reserves known cost before a request that would exceed the cap", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT, {
      budgets: { maxEstimatedCostUsd: 0 },
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.context).toMatchObject({
        resource: "estimatedCostUsd",
      });
    }
  });
});

describe("agent loop: consent and transcript", () => {
  it("refuses to create a session without explicit consent", () => {
    const h = harness();
    expect(() => {
      h.makeSession(SUCCESS_SCRIPT, {
        consent: createConsent({
          providerId: "other",
          model: "deterministic-model",
          categories: DISCLOSURE_CATEGORIES,
          consentedAt: 0,
          expiresAt: 1_000_000_000_000,
        }),
      });
    }).toThrow(WorkspaceError);
  });

  it("records a redacted transcript when opted in", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT, {
      transcript: {
        retentionDays: 7,
        createdAt: 1_000,
        secrets: ["sk-secret"],
      },
    });
    await session.run();
    const snapshot = session.transcript?.exportRedacted(1_000);
    expect(snapshot).toBeDefined();
    const json = JSON.stringify(snapshot);
    expect(json).toContain("inspectSummary");
    expect(json).toContain("fillBox");
    expect(json).not.toContain("sk-secret");
  });

  it("emits progress events for UI projection", async () => {
    const h = harness();
    const events: AgentEvent[] = [];
    const session = h.makeSession(SUCCESS_SCRIPT, {
      onEvent: (event) => events.push(event),
    });
    await session.run();
    expect(events.some((event) => event.kind === "text")).toBe(true);
    const toolEvents = events.filter(
      (event): event is Extract<AgentEvent, { readonly kind: "tool" }> =>
        event.kind === "tool",
    );
    expect(toolEvents.map((event) => event.tool)).toContain("inspectSummary");
    expect(events.some((event) => event.kind === "usage")).toBe(true);
  });
});

describe("agent loop: revision conflict", () => {
  it("fails closed when the live revision changed before approval", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT, {
      isLiveCurrent: () => false,
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("conflict");
    expect(result.state).toBe("error");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.code).toBe("REVISION_CONFLICT");
    }
    expect(session.preview.closed).toBe(true);
  });
});

describe("agent loop: run guards", () => {
  it("rejects a second run on the same session", async () => {
    const h = harness();
    const session = h.makeSession(SUCCESS_SCRIPT);
    await session.run();
    await expect(session.run()).rejects.toThrow(WorkspaceError);
  });
});
