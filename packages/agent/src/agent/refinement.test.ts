import { describe, expect, it } from "vitest";
import { CommandBus, CommandRegistry } from "@voxel-maker/commands";
import { transactionId, WorkspaceError } from "@voxel-maker/shared";
import type { DocumentStoreRead } from "@voxel-maker/document";
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
import { estimateRequestTokens } from "../provider/types.js";
import type {
  ChatMessage,
  ProviderAdapter,
  ProviderChatRequest,
  ToolCall,
} from "../provider/types.js";
import { createFakeEvidenceCapture } from "../vision/test-fixtures.js";
import { measureStructure } from "../vision/structural.js";
import {
  createImageConsent,
  createVisualRefinementPlan,
} from "../vision/image-consent.js";
import {
  createAgentSession,
  type AgentEvent,
  type AgentLoopOptions,
  type AgentRunResult,
  type VisualRefinementConfig,
} from "./loop.js";

/**
 * Visual refinement loop tests (plan S15.5/S15.9, ticket #40 AC): the
 * critique-and-correction phase runs after the text walk, transmits
 * bounded standard-view evidence only under explicit image consent,
 * stages corrections as ordinary commands, and enforces the
 * image-count/iteration/token/cost/duration/tool/command/voxel limits
 * plus the regression and oscillation gates.
 */

class VirtualClock {
  #now = 0;
  now = (): number => this.#now;
  sleep = (ms: number): Promise<void> => {
    this.#now += ms;
    return Promise.resolve();
  };
}

/** Provider wrapper that records every request (image evidence included). */
class RecordingProvider implements ProviderAdapter {
  readonly providerId = "deterministic";
  readonly defaultModel = "deterministic-model";
  readonly requests: ProviderChatRequest[] = [];
  #inner: DeterministicProvider;

  constructor(
    script: readonly DeterministicStep[],
    clock: { now(): number },
    sleep: (ms: number) => Promise<void>,
  ) {
    this.#inner = new DeterministicProvider({ script, clock, sleep });
  }

  get inner(): DeterministicProvider {
    return this.#inner;
  }

  setScript(script: readonly DeterministicStep[]): void {
    this.#inner.setScript(script);
  }

  async *chat(
    request: ProviderChatRequest,
    options?: import("../provider/types.js").ChatOptions,
  ): AsyncIterable<import("../provider/types.js").ProviderEvent> {
    this.requests.push(request);
    yield* this.#inner.chat(request, options);
  }

  complete(
    request: ProviderChatRequest,
    options?: import("../provider/types.js").ChatOptions,
  ): Promise<import("../provider/types.js").ChatResponse> {
    this.requests.push(request);
    return this.#inner.complete(request, options);
  }
}

const CONSENT = createConsent({
  providerId: "deterministic",
  model: "deterministic-model",
  categories: DISCLOSURE_CATEGORIES,
  consentedAt: 0,
  expiresAt: 1_000_000_000_000,
});

const NOW = 1_750_000_000_000;

function imageConsent(): ReturnType<typeof createImageConsent> {
  return createImageConsent({
    providerId: "deterministic",
    model: "deterministic-model",
    views: ["perspective", "front", "side", "top"],
    maxImages: 12,
    maxResolution: 512,
    estimatedCostUsd: 0.01,
    consentedAt: NOW,
    expiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
  });
}

function plan(): ReturnType<typeof createVisualRefinementPlan> {
  return createVisualRefinementPlan({
    providerId: "deterministic",
    model: "deterministic-model",
    resolution: 8,
  });
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

function deleteRegionCall(id = "call_delete"): ToolCall {
  return {
    id,
    name: "deleteRegion",
    arguments: {
      volumeId: "volume:main",
      region: { min: [0, 0, 0], max: [2, 2, 2] },
    },
  };
}

const CRITIQUE = {
  view: "front",
  issueCategory: "geometry-gap",
  affectedNodeIds: ["node:body"],
  evidence: "A gap is visible between the body and the arm.",
  suggestedCorrection: "Extend the arm one voxel toward the body.",
  confidence: 0.9,
};

/** Text-run script that reaches approve with ONE staged fillBox. */
const BASE_SCRIPT: readonly DeterministicStep[] = [
  { text: "I will add the missing corner voxels.", toolCalls: [fillBoxCall()] },
  { text: "The proposal is ready." },
];

/** Correction that adds the four missing corner voxels of [0,2)^3. */
const CORNER_FILL_STEP: DeterministicStep = {
  text: `Critique: ${JSON.stringify(CRITIQUE)}`,
  toolCalls: [
    {
      id: "call_corner_fill",
      name: "fillBox",
      arguments: {
        volumeId: "volume:main",
        region: { min: [0, 0, 0], max: [2, 2, 2] },
        material: 1,
      },
    },
  ],
};

/** Correction that removes exactly the four corner voxels (oscillation). */
const CORNER_REMOVE_STEP: DeterministicStep = {
  text: `Critique: ${JSON.stringify(CRITIQUE)}`,
  toolCalls: [
    {
      id: "call_corner_remove",
      name: "removeVoxelBatch",
      arguments: {
        volumeId: "volume:main",
        coordinates: [
          [1, 1, 0],
          [1, 0, 1],
          [0, 1, 1],
          [1, 1, 1],
        ],
      },
    },
  ],
};

interface Harness {
  readonly store: DocumentStoreRead;
  readonly bus: CommandBus;
  readonly registry: CommandRegistry;
  readonly clock: VirtualClock;
  readonly provider: RecordingProvider;
  readonly capture: ReturnType<typeof createFakeEvidenceCapture>;
  makeSession(
    script: readonly DeterministicStep[],
    options?: Partial<AgentLoopOptions>,
  ): ReturnType<typeof createAgentSession>;
}

function harness(): Harness {
  const { handle } = createInspectionStore();
  const registry = createPreviewRegistry();
  const bus = new CommandBus(handle.store, registry, handle.writeCapability);
  const clock = new VirtualClock();
  const provider = new RecordingProvider([], clock, clock.sleep);
  const capture = createFakeEvidenceCapture();
  return {
    store: handle.store,
    bus,
    registry,
    clock,
    provider,
    capture,
    makeSession(script, options) {
      const session = createPreviewSession({
        live: handle.store,
        applyBus: bus,
        sessionId: previewSessionId("preview:refine:test"),
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
      this.provider.setScript(script);
      const refinement: VisualRefinementConfig = {
        capture: this.capture,
        plan: plan(),
        consent: imageConsent(),
      };
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
        ...(options?.refinement === undefined
          ? { refinement }
          : { refinement: options.refinement }),
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

/** One critique round that fixes nothing more (stop condition). */
const DONE_CRITIQUE_STEP: DeterministicStep = {
  text: "The images look correct now.",
};

const CRITIQUE_STEP: DeterministicStep = CORNER_FILL_STEP;

describe("visual refinement: evidence and consent (AC1/AC2)", () => {
  it("runs the critique phase and transmits preview-revision evidence only under consent", async () => {
    const h = harness();
    const events: AgentEvent[] = [];
    const session = h.makeSession(
      [...BASE_SCRIPT, CRITIQUE_STEP, DONE_CRITIQUE_STEP],
      { onEvent: (event) => events.push(event) },
    );
    const result = runOk(await session.run());
    expect(result.refinement?.iterations).toBe(2);
    expect(result.refinement?.imagesSent).toBe(8);
    expect(result.refinement?.evaluation.promotable).toBe(true);
    // The critique requests carried the staged preview evidence.
    const refineRequests = h.provider.requests.filter((request) =>
      request.messages.some(
        (m) => m.role === "user" && (m.images?.length ?? 0) > 0,
      ),
    );
    expect(refineRequests).toHaveLength(2);
    for (const request of refineRequests) {
      const users = request.messages.filter(
        (m): m is Extract<ChatMessage, { role: "user" }> => m.role === "user",
      );
      const critique = users[users.length - 1];
      expect(critique).toBeDefined();
      const images = critique?.images ?? [];
      expect(images).toHaveLength(4);
      expect(critique?.content).toContain("standard views");
      // S15.3: compact structural context travels with the images.
      expect(critique?.content).toContain("Structure:");
      expect(critique?.content).toContain("occupied voxels");
      for (const image of images) {
        expect(image.mimeType).toBe("image/png");
        expect(image.source).toBe("preview");
        expect(image.view).toMatch(/^(perspective|front|side|top)$/);
        expect(image.revision).toBeGreaterThanOrEqual(0);
        expect(image.bytes.byteLength).toBeGreaterThan(0);
      }
    }
    const refineEvents = events.filter((event) => event.kind === "refine");
    expect(refineEvents.length).toBe(3); // 2 rounds + 1 final done
    const final = refineEvents[refineEvents.length - 1];
    if (final?.kind !== "refine") throw new Error("expected refine event");
    expect(final.done).toBe(true);
    expect(final.stopped).toBe("no-corrections");
    expect(final.imagesSent).toBe(8);
  });

  it("refuses to run the refinement phase without image consent", async () => {
    const h = harness();
    const session = h.makeSession(BASE_SCRIPT, {
      refinement: {
        capture: h.capture,
        plan: plan(),
        consent: createImageConsent({
          providerId: "deterministic",
          model: "deterministic-model",
          views: ["front"],
          maxImages: 1,
          maxResolution: 8,
          estimatedCostUsd: 0,
          consentedAt: NOW,
          expiresAt: NOW + 86_400_000,
        }),
      },
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("provider");
    expect((result.error as { code?: string }).code).toBe(
      "IMAGE_CONSENT_REQUIRED",
    );
    // The base run staged work but refinement refused before transmission:
    // no critique request ever left the device.
    expect(
      h.provider.requests.every(
        (request) =>
          !request.messages.some(
            (m) => m.role === "user" && (m.images?.length ?? 0) > 0,
          ),
      ),
    ).toBe(true);
  });

  it("fails closed on image-count budget exhaustion instead of transmitting more", async () => {
    const h = harness();
    const session = h.makeSession(
      [
        ...BASE_SCRIPT,
        CRITIQUE_STEP,
        CRITIQUE_STEP,
        CRITIQUE_STEP,
        CRITIQUE_STEP,
      ],
      { budgets: { maxImages: 4 } },
    );
    const result = runOk(await session.run());
    expect(result.refinement?.imagesSent).toBe(4);
    expect(result.refinement?.iterations).toBe(1);
    // The second iteration could not fit another full pass: phase stopped
    // gracefully at the image cap and the run still reached approve.
    expect(result.state).toBe("approve");
    expect(result.refinement?.evaluation.promotable).toBe(true);
  });

  it("ends refinement gracefully at the iteration cap", async () => {
    const h = harness();
    const session = h.makeSession(
      [...BASE_SCRIPT, CRITIQUE_STEP, CRITIQUE_STEP, CRITIQUE_STEP],
      { budgets: { maxVisualIterations: 1 } },
    );
    const result = runOk(await session.run());
    expect(result.refinement?.iterations).toBe(1);
    expect(result.refinement?.imagesSent).toBe(4);
  });
});

describe("visual refinement: budgets (AC3)", () => {
  it("enforces the token budget across critique rounds", async () => {
    const h = harness();
    const session = h.makeSession(
      [
        ...BASE_SCRIPT,
        {
          text: "critique",
          usage: { inputTokens: 70_000, outputTokens: 70_000 },
        },
      ],
      { budgets: { maxTokens: 128_000 } },
    );
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    expect((result.error as { code?: string }).code).toBe("LIMIT_EXCEEDED");
    expect(session.preview.closed).toBe(true);
  });

  it("enforces the cost budget across critique rounds", async () => {
    const h = harness();
    const session = h.makeSession(
      [
        ...BASE_SCRIPT,
        {
          text: "critique",
          usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 6 },
        },
      ],
      { budgets: { maxEstimatedCostUsd: 5 } },
    );
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
  });

  it("counts critique requests against the session round budget", async () => {
    const h = harness();
    const session = h.makeSession(
      [...BASE_SCRIPT, CRITIQUE_STEP, CRITIQUE_STEP, DONE_CRITIQUE_STEP],
      { budgets: { maxRounds: 3 } },
    );
    // Base run consumes 2 rounds; iteration 1 takes the 3rd; the second
    // critique round would exceed the 3-round session budget.
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    const context = (result.error as { context?: { resource?: string } })
      .context;
    expect(context?.resource).toBe("rounds");
  });

  it("enforces the approved plan image cap even when the session budget is higher", async () => {
    const h = harness();
    const session = h.makeSession(
      [...BASE_SCRIPT, CRITIQUE_STEP, CRITIQUE_STEP, DONE_CRITIQUE_STEP],
      {
        refinement: {
          capture: h.capture,
          plan: createVisualRefinementPlan({
            providerId: "deterministic",
            model: "deterministic-model",
            resolution: 8,
            maxImages: 4,
          }),
          consent: imageConsent(),
        },
      },
    );
    const result = runOk(await session.run());
    // Only one full evidence pass fits the approved plan (4 images).
    expect(result.refinement?.iterations).toBe(1);
    expect(result.refinement?.imagesSent).toBe(4);
    expect(result.state).toBe("approve");
  });

  it("enforces the approved plan iteration cap even when the session budget is higher", async () => {
    const h = harness();
    const session = h.makeSession(
      [...BASE_SCRIPT, CRITIQUE_STEP, CRITIQUE_STEP, DONE_CRITIQUE_STEP],
      {
        refinement: {
          capture: h.capture,
          plan: createVisualRefinementPlan({
            providerId: "deterministic",
            model: "deterministic-model",
            resolution: 8,
            maxVisualIterations: 1,
          }),
          consent: imageConsent(),
        },
      },
    );
    const result = runOk(await session.run());
    expect(result.refinement?.iterations).toBe(1);
    expect(result.state).toBe("approve");
  });

  it("enforces the duration budget across critique rounds", async () => {
    const h = harness();
    const session = h.makeSession(
      [
        ...BASE_SCRIPT,
        { ...CORNER_FILL_STEP, delayMs: 10_000 },
        DONE_CRITIQUE_STEP,
      ],
      { budgets: { maxDurationMs: 1_000 } },
    );
    // The first critique round takes 10 virtual seconds; the next
    // reservation must fail the 1s duration budget.
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    expect((result.error as { code?: string }).code).toBe("LIMIT_EXCEEDED");
    const context = (result.error as { context?: { resource?: string } })
      .context;
    expect(context?.resource).toBe("duration");
  });

  it("enforces the command and voxel budgets for corrections", async () => {
    const h = harness();
    const session = h.makeSession(
      [...BASE_SCRIPT, CRITIQUE_STEP, DONE_CRITIQUE_STEP],
      { budgets: { maxCommands: 1 } },
    );
    // The base run already staged 1 command; the correction would be the
    // second and must fail closed as a limit, never staged.
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    expect((result.error as { code?: string }).code).toBe("LIMIT_EXCEEDED");
    const context = (result.error as { context?: { resource?: string } })
      .context;
    expect(context?.resource).toBe("commands");
  });

  it("enforces the voxel-change budget for corrections", async () => {
    const h = harness();
    const session = h.makeSession(
      [...BASE_SCRIPT, CRITIQUE_STEP, DONE_CRITIQUE_STEP],
      { budgets: { maxProposedVoxelChanges: 6 } },
    );
    // The base fill estimates 4 voxel changes; the correction's corner
    // fill needs 4 more and must fail the 6-voxel budget.
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    const context = (result.error as { context?: { resource?: string } })
      .context;
    expect(context?.resource).toBe("proposedVoxelChanges");
  });
});

describe("visual refinement: corrections stay staged commands (AC4)", () => {
  it("keeps corrections as ordinary staged commands with a visible diff", async () => {
    const h = harness();
    const session = h.makeSession([
      ...BASE_SCRIPT,
      CRITIQUE_STEP,
      DONE_CRITIQUE_STEP,
    ]);
    const result = runOk(await session.run());
    expect(result.stagedCommands).toBe(2); // 1 base + 1 correction
    const diff = session.preview.diff();
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.value.stagedCommandCount).toBe(2);
    expect(diff.value.commandTypes).toEqual([
      { type: "voxel.fillBox", count: 2 },
    ]);
    const commands = session.preview.stagedCommands;
    expect(commands).toHaveLength(2);
    // The correction is an ordinary command constructed by the same
    // mutator, with the same deterministic id scheme.
    expect(commands[1]?.type).toBe("voxel.fillBox");
    expect(commands[1]?.id).toBe("command:fillBox:1:1");
  });

  it("applies the refined proposal as ONE labeled undoable history entry", async () => {
    const h = harness();
    const session = h.makeSession([
      ...BASE_SCRIPT,
      CRITIQUE_STEP,
      DONE_CRITIQUE_STEP,
    ]);
    await session.run();
    const base = h.store.revision;
    const applied = session.apply({ label: "AI: refined proposal" });
    expect(applied.ok).toBe(true);
    expect(h.store.revision).toBe(base + 1);
    const history = h.bus.historySnapshot().past;
    expect(history).toHaveLength(1);
    expect(history[0]?.label).toBe("AI: refined proposal");
    // Undo restores the exact pre-apply SEMANTIC state (each transaction
    // increments the revision once, so the revision number differs).
    const undone = h.bus.undo({
      transactionId: transactionId("transaction:undo:refine"),
      expectedRevision: h.store.revision,
      source: "ai",
    });
    expect(undone.ok).toBe(true);
    expect(measureStructure(h.store).occupiedVoxels).toBe(4);
    expect(h.bus.historySnapshot().past).toHaveLength(0);
    // Redo replays the refined proposal (one history entry again).
    const redo = h.bus.redo({
      transactionId: transactionId("transaction:redo:refine"),
      expectedRevision: h.store.revision,
      source: "ai",
    });
    expect(redo.ok).toBe(true);
    expect(measureStructure(h.store).occupiedVoxels).toBe(8);
    expect(h.bus.historySnapshot().past).toHaveLength(1);
  });

  it("discard drops the refined proposal with no live side effects", async () => {
    const h = harness();
    const session = h.makeSession([
      ...BASE_SCRIPT,
      CRITIQUE_STEP,
      DONE_CRITIQUE_STEP,
    ]);
    await session.run();
    const base = h.store.revision;
    session.discard();
    expect(h.store.revision).toBe(base);
    expect(h.bus.historySnapshot().past).toHaveLength(0);
    expect(session.preview.closed).toBe(true);
  });

  it("emits diagnostics for the critique rounds", async () => {
    const h = harness();
    const events: AgentEvent[] = [];
    const session = h.makeSession(
      [...BASE_SCRIPT, CRITIQUE_STEP, DONE_CRITIQUE_STEP],
      { onEvent: (event) => events.push(event) },
    );
    await session.run();
    const refine = events.filter((event) => event.kind === "refine");
    expect(refine.length).toBeGreaterThanOrEqual(2);
    const first = refine[0];
    if (first?.kind !== "refine") throw new Error("expected refine event");
    expect(first.critique?.issueCategory).toBe("geometry-gap");
    expect(first.correctionsStaged).toBe(1);
    expect(first.evaluation?.promotable).toBe(true);
  });
});

describe("visual refinement: regression and oscillation gates (AC5)", () => {
  it("stops the loop and refuses promotion when a correction regresses structure", async () => {
    const h = harness();
    const events: AgentEvent[] = [];
    const session = h.makeSession(
      [
        ...BASE_SCRIPT,
        {
          text: `Critique: ${JSON.stringify(CRITIQUE)}`,
          toolCalls: [deleteRegionCall()],
        },
        CRITIQUE_STEP,
      ],
      { onEvent: (event) => events.push(event) },
    );
    const result = runOk(await session.run());
    expect(result.refinement?.iterations).toBe(1);
    expect(result.refinement?.evaluation.regressions).toContain(
      "occupied-voxel-loss",
    );
    expect(result.refinement?.evaluation.promotable).toBe(false);
    const done = events.filter((event) => event.kind === "refine").pop();
    if (done?.kind !== "refine") throw new Error("expected refine event");
    expect(done.done).toBe(true);
    expect(done.stopped).toBe("regression");
    // The model never got a second critique round after the regression.
    expect(h.provider.requests.length).toBe(BASE_SCRIPT.length + 1);
  });

  it("stops the loop when corrections oscillate back to a seen state", async () => {
    const h = harness();
    const session = h.makeSession([
      ...BASE_SCRIPT,
      // Round 1 adds the four corner voxels.
      CORNER_FILL_STEP,
      // Round 2 removes exactly those four: the state returns to the
      // round-1 baseline -> oscillation detected.
      CORNER_REMOVE_STEP,
      DONE_CRITIQUE_STEP,
    ]);
    const result = runOk(await session.run());
    expect(result.refinement?.iterations).toBe(2);
    expect(result.refinement?.evaluation.oscillationDetected).toBe(true);
    expect(result.refinement?.evaluation.promotable).toBe(false);
    // The third round was never sent.
    expect(h.provider.requests).toHaveLength(BASE_SCRIPT.length + 2);
  });

  it("compares structural and visual outcomes before and after refinement", async () => {
    const h = harness();
    const session = h.makeSession([
      ...BASE_SCRIPT,
      CRITIQUE_STEP,
      DONE_CRITIQUE_STEP,
    ]);
    const result = runOk(await session.run());
    const evaluation = result.refinement?.evaluation;
    expect(evaluation).toBeDefined();
    if (evaluation === undefined) return;
    expect(evaluation.structural.occupiedVoxels).toBeGreaterThan(0);
    expect(evaluation.visual.length).toBe(4);
    expect(evaluation.overallSimilarity).toBeGreaterThan(0);
    expect(evaluation.overallSimilarity).toBeLessThan(1);
  });
});

describe("visual refinement: consent token caps bind critique requests (issue #117)", () => {
  it("fails before a critique request whose input estimate exceeds the remaining consent token cap", async () => {
    const h = harness();
    // The measured input estimates of this harness are ~24.1k for the
    // first text round, ~24.2k for the second, and ~24.7k for the
    // image-bearing critique request: a 24,400 consent token cap lets
    // the two text rounds through and refuses the critique request
    // before transmission (issue #117 AC: caps bind the run; issue #118:
    // the pre-request token contract fails before any provider work).
    const session = h.makeSession([...BASE_SCRIPT, DONE_CRITIQUE_STEP], {
      consent: createConsent({
        providerId: "deterministic",
        model: "deterministic-model",
        categories: DISCLOSURE_CATEGORIES,
        consentedAt: 0,
        expiresAt: 1_000_000_000_000,
        tokenCap: 24_400,
      }),
    });
    const result = runErr(await session.run());
    expect(result.reason).toBe("limit");
    if (result.error instanceof WorkspaceError) {
      expect(result.error.context).toMatchObject({ resource: "tokens" });
    }
    // Both text rounds were sent; the critique request never left the
    // device, so no evidence images were transmitted.
    expect(h.provider.requests).toHaveLength(BASE_SCRIPT.length);
    expect(
      h.provider.requests.every(
        (request) =>
          !request.messages.some(
            (message) =>
              message.role === "user" && (message.images?.length ?? 0) > 0,
          ),
      ),
    ).toBe(true);
    expect(session.preview.closed).toBe(true);
  });

  it("clamps a critique request's output cap to the remaining consent token allowance", async () => {
    const h = harness();
    // A 26,500 token cap covers the critique request's ~24.7k input
    // estimate but not its full 2,048-token output cap, so the loop
    // sends the critique with maxTokens clamped to exactly the remaining
    // allowance (issue #118): the consent cap still binds the worst
    // case, and the evidence images only leave the device inside it.
    const session = h.makeSession([...BASE_SCRIPT, DONE_CRITIQUE_STEP], {
      consent: createConsent({
        providerId: "deterministic",
        model: "deterministic-model",
        categories: DISCLOSURE_CATEGORIES,
        consentedAt: 0,
        expiresAt: 1_000_000_000_000,
        tokenCap: 26_500,
      }),
    });
    const result = runOk(await session.run());
    expect(result.ok).toBe(true);
    const critique = h.provider.requests.at(-1);
    expect(critique).toBeDefined();
    if (critique !== undefined) {
      expect(
        critique.messages.some(
          (message) =>
            message.role === "user" && (message.images?.length ?? 0) > 0,
        ),
      ).toBe(true);
      const inputEstimate = estimateRequestTokens(critique);
      expect(inputEstimate).toBeLessThan(26_500);
      expect(critique.maxTokens).toBe(26_500 - inputEstimate);
      expect(critique.maxTokens).toBeLessThan(2048);
    }
  });
});

describe("visual refinement: cancellation", () => {
  it("cancels during the critique phase and fails closed", async () => {
    const h = harness();
    const session = h.makeSession([
      ...BASE_SCRIPT,
      { text: "critique", delayMs: 100 },
    ]);
    const run = session.run();
    session.cancel();
    const result = runErr(await run);
    expect(result.reason).toBe("canceled");
    expect(session.preview.closed).toBe(true);
  });
});

describe("visual refinement: revision conflict still applies", () => {
  it("checks the live revision before approval after refinement", async () => {
    const h = harness();
    let liveCurrent = true;
    const session = h.makeSession([...BASE_SCRIPT, DONE_CRITIQUE_STEP], {
      isLiveCurrent: () => liveCurrent,
    });
    const run = session.run();
    liveCurrent = false;
    const result = runErr(await run);
    expect(result.reason).toBe("conflict");
    expect(session.preview.closed).toBe(true);
  });
});
