import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import {
  createDesktopComposition,
  type DesktopComposition,
  type FilePicker,
} from "../composition.js";
import { autoConfirmPrompts } from "../test-prompts.js";
import {
  createConsent,
  createImageConsent,
  DeterministicProvider,
  DISCLOSURE_CATEGORIES,
  KEYCHAIN_SERVICE,
  MemoryConsentStore,
  MemoryCredentialStore,
  MemoryImageConsentStore,
  Secret,
  createFakeEvidenceCapture,
  type DeterministicStep,
  type EvidenceCapture,
  type ToolCall,
} from "@voxel-maker/agent";


/**
 * AI controller tests (plan S12.10/S12.14/S12.15, ticket #34 AC): the
 * desktop seam drives the real bounded agent loop over the real preview
 * session and renderer projection, so the acceptance criteria are
 * exercised end to end: prompts/progress/tool activity/usage/cancellation/
 * errors/bounded diffs in the snapshot, Apply = one labeled undoable
 * history entry, Discard = none, stale-base conflict offers
 * discard/reinspect/replan without silent rebase, staged geometry is
 * projected separately and disposed without live effects, and
 * offline/unconfigured degradation keeps manual editing working.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:ai:root");
const CHILD = nodeId("node:ai:child");
const VOLUME = volumeId("volume:ai:0001");

function fixtureDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:ai:0001"),
    metadata: { title: "ai panel" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [CHILD],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: CHILD,
        name: "Box",
        parentId: ROOT,
        children: [],
        transform: IDENTITY,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "box",
        color: "#ff8800",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [{ volumeId: VOLUME, bounds: { min: [0, 0, 0], max: [5, 5, 5] } }],
  });
}

const createFakePicker = (): FilePicker => ({
  pickOpenPath: () => Promise.resolve(undefined),
  pickSavePath: (suggestedName: string) => Promise.resolve(suggestedName),
});

function fillBoxCall(id = "call_fill"): ToolCall {
  return {
    id,
    name: "fillBox",
    arguments: {
      volumeId: "volume:ai:0001",
      region: { min: [0, 0, 0], max: [1, 1, 1] },
      material: 1,
    },
  };
}

function summaryCall(id = "call_summary"): ToolCall {
  return { id, name: "inspectSummary", arguments: {} };
}

const SUCCESS_SCRIPT: readonly DeterministicStep[] = [
  { text: "I will inspect the box.", toolCalls: [summaryCall()] },
  { text: "I will add a voxel.", toolCalls: [fillBoxCall()] },
  {
    text: "Let me verify the staged result.",
    toolCalls: [summaryCall("call_summary2")],
  },
  { text: "The proposal is ready for approval." },
];

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
  readonly composition: DesktopComposition;
  readonly provider: DeterministicProvider;
  readonly credentials: MemoryCredentialStore;
  readonly consent: MemoryConsentStore;
  readonly clock: VirtualClock;
  dispose(): void;
}

function createHarness(
  options: {
    readonly script?: readonly DeterministicStep[];
    readonly withKey?: boolean;
    readonly withConsent?: boolean;
    readonly withImageConsent?: boolean;
    readonly capture?: EvidenceCapture;
  } = {},
): Harness {
  const clock = new VirtualClock();
  const provider = new DeterministicProvider({
    script: options.script ?? [],
    clock,
    sleep: clock.sleep,
  });
  const credentials = new MemoryCredentialStore();
  const consent = new MemoryConsentStore();
  const imageConsentStore = new MemoryImageConsentStore();
  if (options.withKey !== false) {
    void credentials.save(
      KEYCHAIN_SERVICE,
      "deterministic",
      new Secret("test-key"),
    );
  }
  if (options.withConsent !== false) {
    void consent.save(
      createConsent({
        providerId: "deterministic",
        model: "deterministic-model",
        categories: DISCLOSURE_CATEGORIES,
        consentedAt: 0,
        expiresAt: 1_000_000_000_000,
        clock,
      }),
    );
  }
  if (options.withImageConsent === true) {
    void imageConsentStore.save(
      createImageConsent({
        providerId: "deterministic",
        model: "deterministic-model",
        views: ["perspective", "front", "side", "top"],
        maxImages: 12,
        maxResolution: 512,
        estimatedCostUsd: 0.01,
        clock,
      }),
    );
  }
  const composition = createDesktopComposition({
    storage: new MemoryProjectStorage(),
    picker: createFakePicker(),
    prompts: autoConfirmPrompts,
    ai: {
      provider,
      credentials,
      consent,
      imageConsentStore,
      clock,
      sleep: clock.sleep,
      ...(options.capture === undefined
        ? {}
        : { capture: options.capture }),
    },
  });
  composition.session.open({ document: fixtureDocument(), source: "system" });
  return {
    composition,
    provider,
    credentials,
    consent,
    clock,
    dispose() {
      composition.dispose();
    },
  };
}

/** Flushes meshing queues (staged overlay projection). */
function flushAll(composition: DesktopComposition): void {
  for (let index = 0; index < 64; index += 1) {
    composition.renderer.flush(new THREE.PerspectiveCamera());
    const diagnostics = composition.renderer.diagnostics();
    if (
      diagnostics.pendingChunks === 0 &&
      diagnostics.inFlightMeshes === 0 &&
      diagnostics.uploadsThisFrame === 0
    ) {
      return;
    }
  }
  throw new Error("meshing queues did not drain");
}

describe("ai controller", () => {
  it("reports unconfigured status and keeps manual editing functional", () => {
    const h = createHarness({ withKey: false, withConsent: false });
    expect(h.composition.ai.state.configured).toBe(false);
    expect(h.composition.ai.state.consented).toBe(false);
    // Manual editing keeps working while AI is unconfigured.
    const state = h.composition.session.current;
    if (state === undefined) throw new Error("no session");
    expect(state.bus.historySnapshot().past).toHaveLength(0);
    expect(h.composition.ai.state.phase).toBe("idle");
    h.dispose();
  });

  it("saves and clears the provider key through the credential store", async () => {
    const h = createHarness({ withKey: false, withConsent: true });
    await h.composition.ai.refreshStatus();
    expect(h.composition.ai.state.configured).toBe(false);
    expect(await h.composition.ai.saveApiKey("  sk-new-key  ")).toBe(true);
    expect(h.composition.ai.state.configured).toBe(true);
    const stored = await h.credentials.get(KEYCHAIN_SERVICE, "deterministic");
    expect(stored?.reveal()).toBe("sk-new-key");
    expect(await h.composition.ai.clearApiKey()).toBe(true);
    expect(h.composition.ai.state.configured).toBe(false);
    h.dispose();
  });

  it("refuses to run without consent and records consent on request", async () => {
    const h = createHarness({ withKey: true, withConsent: false });
    await h.composition.ai.refreshStatus();
    expect(h.composition.ai.state.configured).toBe(true);
    expect(h.composition.ai.state.consented).toBe(false);

    await h.composition.ai.run("Add a voxel");
    expect(h.composition.ai.state.phase).toBe("error");
    expect(h.composition.ai.state.error?.code).toBe("CONSENT_REQUIRED");

    expect(await h.composition.ai.consent(1.5)).toBe(true);
    expect(h.composition.ai.state.consented).toBe(true);
    h.dispose();
  });

  it("runs to approval with progress, tool activity, usage, and a bounded diff", async () => {
    const h = createHarness({ script: SUCCESS_SCRIPT });
    await h.composition.ai.refreshStatus();
    await h.composition.ai.run("Add a voxel to the box");

    const state = h.composition.ai.state;
    expect(state.phase).toBe("approve");
    expect(state.prompt).toBe("Add a voxel to the box");
    expect(state.stagedCommandCount).toBe(1);
    expect(state.diff?.stagedCommandCount).toBe(1);
    expect(state.diff?.voxelEstimate).toBeGreaterThan(0);
    expect(state.diff?.commandTypes[0]?.type).toBe("voxel.fillBox");
    expect(state.diff?.baseRevision).toBe(0);
    expect(state.usage?.inputTokens).toBeGreaterThanOrEqual(0);
    // Normalized tool activity is present and bounded.
    expect(
      state.activity.some(
        (entry) =>
          entry.kind === "tool" && entry.tool === "fillBox" && entry.ok,
      ),
    ).toBe(true);
    expect(state.activity.some((entry) => entry.kind === "usage")).toBe(true);
    expect(state.activity.some((entry) => entry.kind === "state")).toBe(true);

    // Staged geometry is projected separately (preview namespace).
    expect(h.composition.renderer.adapter.previewProjectionCount).toBe(1);
    flushAll(h.composition);
    const root = h.composition.renderer.scene.getObjectByName(
      state.diff?.namespace ?? "",
    );
    expect(root).toBeDefined();
    expect(
      h.composition.renderer.scene.children.some((child) =>
        child.name.startsWith("preview:"),
      ),
    ).toBe(true);

    // Staging never touched live revision, history, or dirty state.
    expect(h.composition.session.current?.revision).toBe(0);
    const current = h.composition.session.current;
    if (current === undefined) throw new Error("no session");
    expect(current.bus.historySnapshot().past).toHaveLength(0);
    h.dispose();
  });

  it("applies the proposal as ONE labeled undoable history entry", async () => {
    const h = createHarness({ script: SUCCESS_SCRIPT });
    await h.composition.ai.refreshStatus();
    await h.composition.ai.run("Add a voxel to the box");
    expect(h.composition.ai.state.phase).toBe("approve");

    h.composition.ai.apply("AI: add a voxel");
    const state = h.composition.ai.state;
    expect(state.phase).toBe("idle");
    expect(state.applied?.label).toBe("AI: add a voxel");
    expect(state.applied?.stagedCommandCount).toBe(1);

    const current = h.composition.session.current;
    if (current === undefined) throw new Error("no session");
    const history = current.bus.historySnapshot().past;
    expect(history).toHaveLength(1);
    expect(history[0]?.label).toBe("AI: add a voxel");
    expect(history[0]?.source).toBe("ai");
    expect(current.store.revision).toBe(1);

    // The staged overlay was disposed with the apply.
    expect(h.composition.renderer.adapter.previewProjectionCount).toBe(0);
    h.dispose();
  });

  it("discards the proposal with zero live effects", async () => {
    const h = createHarness({ script: SUCCESS_SCRIPT });
    await h.composition.ai.refreshStatus();
    await h.composition.ai.run("Add a voxel to the box");
    expect(h.composition.ai.state.phase).toBe("approve");
    expect(h.composition.renderer.adapter.previewProjectionCount).toBe(1);

    h.composition.ai.discard();
    expect(h.composition.ai.state.phase).toBe("idle");
    const current = h.composition.session.current;
    if (current === undefined) throw new Error("no session");
    expect(current.bus.historySnapshot().past).toHaveLength(0);
    expect(current.store.revision).toBe(0);
    expect(h.composition.renderer.adapter.previewProjectionCount).toBe(0);
    h.dispose();
  });

  it("cancels a running run with no live effects", async () => {
    // A manual gate suspends the run between rounds deterministically,
    // and a flag signals when the run first enters the provider sleep.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sleep = async (): Promise<void> => {
      entered?.();
      await gate;
    };
    const clock = new VirtualClock();
    const provider = new DeterministicProvider({
      script: [
        { text: "inspecting", toolCalls: [summaryCall()], delayMs: 1 },
        { text: "done" },
      ],
      clock,
      sleep,
    });
    const credentials = new MemoryCredentialStore();
    const consent = new MemoryConsentStore();
    void credentials.save(
      KEYCHAIN_SERVICE,
      "deterministic",
      new Secret("test-key"),
    );
    void consent.save(
      createConsent({
        providerId: "deterministic",
        model: "deterministic-model",
        categories: DISCLOSURE_CATEGORIES,
        consentedAt: 0,
        expiresAt: 1_000_000_000_000,
        clock,
      }),
    );
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
      ai: { provider, credentials, consent, clock, sleep },
    });
    composition.session.open({ document: fixtureDocument(), source: "system" });
    await composition.ai.refreshStatus();

    const running = composition.ai.run("Add a voxel to the box");
    await enteredPromise;
    // The run is suspended inside the first delayed step: cancel now, so
    // the next round boundary observes the cancellation.
    composition.ai.cancel();
    release?.();
    await running;
    expect(composition.ai.state.phase).toBe("canceled");
    const current = composition.session.current;
    if (current === undefined) throw new Error("no session");
    expect(composition.ai.state.phase).toBe("canceled");
    expect(composition.renderer.adapter.previewProjectionCount).toBe(0);

    composition.ai.dismiss();
    expect(composition.ai.state.phase).toBe("idle");
    composition.dispose();
  });

  it("surfaces provider failures as a stable error phase", async () => {
    const h = createHarness({
      script: [
        {
          text: "",
          error: {
            family: "authentication",
            code: "AUTHENTICATION_FAILED",
            message: "The provider rejected the credential",
            retryable: false,
          },
        },
      ],
    });
    await h.composition.ai.refreshStatus();
    await h.composition.ai.run("Add a voxel to the box");
    expect(h.composition.ai.state.phase).toBe("error");
    expect(h.composition.ai.state.reason).toBe("provider");
    expect(h.composition.ai.state.error?.code).toBe("AUTHENTICATION_FAILED");
    const current = h.composition.session.current;
    if (current === undefined) throw new Error("no session");
    expect(current.bus.historySnapshot().past).toHaveLength(0);
    h.composition.ai.dismiss();
    expect(h.composition.ai.state.phase).toBe("idle");
    h.dispose();
  });

  it("flags a stale base revision at apply and offers discard/reinspect/replan", async () => {
    const h = createHarness({ script: SUCCESS_SCRIPT });
    await h.composition.ai.refreshStatus();
    await h.composition.ai.run("Add a voxel to the box");
    expect(h.composition.ai.state.phase).toBe("approve");
    expect(h.composition.ai.state.baseRevision).toBe(0);

    // The user edits the document manually while the proposal is staged.
    const current = h.composition.session.current;
    if (current === undefined) throw new Error("no session");
    const result = current.bus.execute(
      {
        id: commandId("command:ai:test-manual"),
        type: "voxel.set",
        schemaVersion: 1,
        payload: {
          volumeId: "volume:ai:0001",
          coordinate: [10, 10, 10],
          material: 1,
        },
      },
      {
        transactionId: transactionId("transaction:ai:test-manual"),
        expectedRevision: current.store.revision,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);

    // Apply must NOT silently rebase: it reports the conflict.
    h.composition.ai.apply("AI: add a voxel");
    const state = h.composition.ai.state;
    expect(state.phase).toBe("conflict");
    expect(state.liveRevision).toBe(1);
    const history = current.bus.historySnapshot().past;
    expect(history).toHaveLength(1);
    expect(history[0]?.label).not.toBe("AI: add a voxel");

    // Discard option: drops the proposal, keeps the manual edit.
    h.composition.ai.discard();
    expect(h.composition.ai.state.phase).toBe("idle");
    expect(h.composition.session.current?.store.revision).toBe(1);
    expect(h.composition.renderer.adapter.previewProjectionCount).toBe(0);
    h.dispose();
  });

  it("replans the same prompt at the fresh revision after a conflict", async () => {
    const h = createHarness({ script: SUCCESS_SCRIPT });
    await h.composition.ai.refreshStatus();
    await h.composition.ai.run("Add a voxel to the box");
    const current = h.composition.session.current;
    if (current === undefined) throw new Error("no session");
    const result = current.bus.execute(
      {
        id: commandId("command:ai:test-manual"),
        type: "voxel.set",
        schemaVersion: 1,
        payload: {
          volumeId: "volume:ai:0001",
          coordinate: [10, 10, 10],
          material: 1,
        },
      },
      {
        transactionId: transactionId("transaction:ai:test-manual"),
        expectedRevision: current.store.revision,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);
    h.composition.ai.apply("AI: add a voxel");
    expect(h.composition.ai.state.phase).toBe("conflict");

    await h.composition.ai.replan();
    expect(h.composition.ai.state.phase).toBe("approve");
    expect(h.composition.ai.state.prompt).toBe("Add a voxel to the box");
    // The new proposal is anchored at the fresh live revision.
    expect(h.composition.ai.state.baseRevision).toBe(1);
    expect(h.composition.ai.state.liveRevision).toBe(1);
    h.dispose();
  });

  it("reinspects the changed document after a conflict", async () => {
    const h = createHarness({ script: SUCCESS_SCRIPT });
    await h.composition.ai.refreshStatus();
    await h.composition.ai.run("Add a voxel to the box");
    const current = h.composition.session.current;
    if (current === undefined) throw new Error("no session");
    const result = current.bus.execute(
      {
        id: commandId("command:ai:test-manual"),
        type: "voxel.set",
        schemaVersion: 1,
        payload: {
          volumeId: "volume:ai:0001",
          coordinate: [10, 10, 10],
          material: 1,
        },
      },
      {
        transactionId: transactionId("transaction:ai:test-manual"),
        expectedRevision: current.store.revision,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);
    h.composition.ai.apply("AI: add a voxel");
    expect(h.composition.ai.state.phase).toBe("conflict");

    await h.composition.ai.reinspect();
    expect(h.composition.ai.state.phase).toBe("approve");
    expect(h.composition.ai.state.prompt).toContain(
      "Inspect the current document state",
    );
    expect(h.composition.ai.state.prompt).toContain("Add a voxel to the box");
    expect(h.composition.ai.state.baseRevision).toBe(1);
    h.dispose();
  });

  it("detects a mid-run conflict when the live revision advances", async () => {
    // A manual gate suspends the run between rounds deterministically;
    // the live edit lands while the run is in flight.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Signals when the run first suspends inside the provider sleep.
    let entered: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sleep = async (): Promise<void> => {
      entered?.();
      await gate;
    };
    const clock = new VirtualClock();
    const provider = new DeterministicProvider({
      script: [
        { text: "inspecting", toolCalls: [summaryCall()], delayMs: 1 },
        { text: "staging", toolCalls: [fillBoxCall()], delayMs: 1 },
        { text: "done" },
      ],
      clock,
      sleep,
    });
    const credentials = new MemoryCredentialStore();
    const consent = new MemoryConsentStore();
    void credentials.save(
      KEYCHAIN_SERVICE,
      "deterministic",
      new Secret("test-key"),
    );
    void consent.save(
      createConsent({
        providerId: "deterministic",
        model: "deterministic-model",
        categories: DISCLOSURE_CATEGORIES,
        consentedAt: 0,
        expiresAt: 1_000_000_000_000,
        clock,
      }),
    );
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
      ai: { provider, credentials, consent, clock, sleep },
    });
    composition.session.open({ document: fixtureDocument(), source: "system" });
    await composition.ai.refreshStatus();

    const running = composition.ai.run("Add a voxel to the box");
    await enteredPromise;
    // Advance the live revision while the run is suspended.
    const current = composition.session.current;
    if (current === undefined) throw new Error("no session");
    const result = current.bus.execute(
      {
        id: commandId("command:ai:test-midrun"),
        type: "voxel.set",
        schemaVersion: 1,
        payload: {
          volumeId: "volume:ai:0001",
          coordinate: [5, 5, 5],
          material: 1,
        },
      },
      {
        transactionId: transactionId("transaction:ai:test-midrun"),
        expectedRevision: current.store.revision,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);
    release?.();
    await running;
    expect(composition.ai.state.phase).toBe("conflict");
    expect(composition.ai.state.error?.code).toBe("REVISION_CONFLICT");
    composition.dispose();
  });

  it("disposes the active run on lifecycle replacement", async () => {
    const h = createHarness({ script: SUCCESS_SCRIPT });
    await h.composition.ai.refreshStatus();
    await h.composition.ai.run("Add a voxel to the box");
    expect(h.composition.ai.state.phase).toBe("approve");
    expect(h.composition.renderer.adapter.previewProjectionCount).toBe(1);

    h.composition.session.close();
    expect(h.composition.ai.state.phase).toBe("idle");
    expect(h.composition.ai.state.documentOpen).toBe(false);
    expect(h.composition.renderer.adapter.previewProjectionCount).toBe(0);
    h.dispose();
  });

  it("bounds the activity log", async () => {
    const h = createHarness({ script: SUCCESS_SCRIPT });
    await h.composition.ai.refreshStatus();
    await h.composition.ai.run("Add a voxel to the box");
    expect(h.composition.ai.state.activity.length).toBeLessThanOrEqual(48);
    h.dispose();
  });
});

describe("ai controller: visual refinement (ticket #40)", () => {
  const REFINE_SCRIPT: readonly DeterministicStep[] = [
    ...SUCCESS_SCRIPT,
    {
      text: 'Critique: {"view":"front","issueCategory":"geometry-gap","affectedNodeIds":["node:ai:child"],"evidence":"A gap is visible.","suggestedCorrection":"Extend the box.","confidence":0.8}',
      toolCalls: [
        {
          id: "call_correction",
          name: "fillBox",
          arguments: {
            volumeId: "volume:ai:0001",
            region: { min: [1, 0, 0], max: [2, 1, 1] },
            material: 1,
          },
        },
      ],
    },
    { text: "The images look correct now." },
  ];

  function enableVisual(h: Harness): void {
    h.composition.ai.setVisualEnabled(true);
    expect(h.composition.ai.state.visualEnabled).toBe(true);
  }

  it("approves image transmission under a bounded per-session plan", async () => {
    const h = createHarness();
    await h.composition.ai.refreshStatus();
    expect(h.composition.ai.state.imageConsent).toBeUndefined();
    const approved = await h.composition.ai.consentImages(512);
    expect(approved).toBe(true);
    const state = h.composition.ai.state;
    expect(state.imageConsent?.providerId).toBe("deterministic");
    expect(state.imageConsent?.maxResolution).toBe(512);
    expect(state.imageConsent?.views).toHaveLength(4);
    expect(state.refinementPlan?.imageCount).toBe(4);
    expect(state.refinementPlan?.maxImages).toBe(12);
    expect(state.refinementPlan?.maxVisualIterations).toBe(3);
    h.dispose();
  });

  it("runs the visual refinement phase and reports iterations and images", async () => {
    const h = createHarness({
      script: REFINE_SCRIPT,
      capture: createFakeEvidenceCapture(),
    });
    await h.composition.ai.refreshStatus();
    await h.composition.ai.consentImages(8);
    enableVisual(h);
    await h.composition.ai.run("Add a voxel to the box");

    const state = h.composition.ai.state;
    expect(state.phase).toBe("approve");
    expect(state.refinement?.iterations).toBe(2);
    expect(state.refinement?.imagesSent).toBe(8);
    expect(state.refinement?.evaluation?.promotable).toBe(true);
    // Corrections are ordinary staged commands in the same diff.
    expect(state.diff?.stagedCommandCount).toBe(2);
    expect(
      state.activity.some((entry) =>
        entry.message.includes("Visual refinement iteration"),
      ),
    ).toBe(true);
    h.dispose();
  });

  it("never transmits evidence when image consent is missing", async () => {
    const h = createHarness({
      script: REFINE_SCRIPT,
      capture: createFakeEvidenceCapture(),
    });
    await h.composition.ai.refreshStatus();
    enableVisual(h);
    await h.composition.ai.run("Add a voxel to the box");
    // No stored image consent: the refinement phase is skipped entirely
    // and the text proposal still reaches approval — no evidence leaves
    // the device.
    expect(h.composition.ai.state.phase).toBe("approve");
    expect(h.composition.ai.state.refinement).toBeUndefined();
    expect(h.composition.ai.state.diff?.stagedCommandCount).toBe(1);
    h.dispose();
  });

  it("gates regression promotion and requires an explicit override", async () => {
    const regressionScript: readonly DeterministicStep[] = [
      ...SUCCESS_SCRIPT,
      {
        text: 'Critique: {"view":"any","issueCategory":"other","affectedNodeIds":[],"evidence":"Delete it all.","confidence":1}',
        toolCalls: [
          {
            id: "call_delete",
            name: "deleteRegion",
            arguments: {
              volumeId: "volume:ai:0001",
              region: { min: [0, 0, 0], max: [5, 5, 5] },
            },
          },
        ],
      },
    ];
    const h = createHarness({
      script: regressionScript,
      capture: createFakeEvidenceCapture(),
    });
    await h.composition.ai.refreshStatus();
    await h.composition.ai.consentImages(8);
    enableVisual(h);
    await h.composition.ai.run("Add a voxel to the box");

    const state = h.composition.ai.state;
    expect(state.phase).toBe("approve");
    expect(state.refinement?.evaluation?.promotable).toBe(false);
    expect(state.refinement?.evaluation?.regressions).toContain(
      "occupied-voxel-loss",
    );
    // The regression gate blocks normal Apply…
    const before = h.composition.session.current?.revision ?? -1;
    h.composition.ai.apply("gated");
    expect(h.composition.ai.state.phase).toBe("approve");
    expect(h.composition.session.current?.revision).toBe(before);
    // …and the explicit human override promotes it as one labeled entry.
    h.composition.ai.applyForced("explicit promote");
    expect(h.composition.ai.state.phase).toBe("idle");
    expect(h.composition.ai.state.applied?.label).toBe("explicit promote");
    const current = h.composition.session.current;
    if (current === undefined) throw new Error("no session");
    expect(current.bus.historySnapshot().past).toHaveLength(1);
    h.dispose();
  });

  it("revokes image consent and disables evidence", async () => {
    const h = createHarness();
    await h.composition.ai.refreshStatus();
    await h.composition.ai.consentImages();
    expect(h.composition.ai.state.imageConsent).toBeDefined();
    await h.composition.ai.clearImageConsent();
    expect(h.composition.ai.state.imageConsent).toBeUndefined();
    expect(h.composition.ai.state.refinementPlan).toBeUndefined();
    h.dispose();
  });
});
