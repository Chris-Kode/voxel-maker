// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import type { DesktopComposition, FilePicker } from "../composition.js";
import { createDesktopComposition } from "../composition.js";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import { autoConfirmPrompts } from "../test-prompts.js";
import { AiPanel } from "./AiPanel.js";
import {
  createConsent,
  DeterministicProvider,
  DISCLOSURE_CATEGORIES,
  KEYCHAIN_SERVICE,
  MemoryConsentStore,
  MemoryCredentialStore,
  Secret,
  type DeterministicStep,
  type ToolCall,
} from "@voxel-maker/agent";

/**
 * AI panel DOM-binding tests (plan S12.10/S12.14, ticket #34): the React
 * panel renders the real AI controller and drives the real bounded agent
 * loop through the DOM — prompt entry, progress, normalized tool
 * activity, usage, cancellation, errors, bounded diffs, Apply/Discard,
 * the stale-base conflict choices, and the unconfigured/offline
 * degradation — while the controller and the composition stay headless.
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

class VirtualClock {
  #now = 0;
  now = (): number => this.#now;
  sleep = (ms: number): Promise<void> => {
    this.#now += ms;
    return Promise.resolve();
  };
}

interface Mounted {
  readonly composition: DesktopComposition;
  readonly panel: HTMLElement;
  readonly unmount: () => void;
}

function mountPanel(
  options: {
    readonly withDocument?: boolean;
    readonly script?: readonly DeterministicStep[];
    readonly withKey?: boolean;
    readonly withConsent?: boolean;
  } = {},
): Mounted {
  const clock = new VirtualClock();
  const provider = new DeterministicProvider({
    script: options.script ?? [],
    clock,
    sleep: clock.sleep,
  });
  const credentials = new MemoryCredentialStore();
  const consent = new MemoryConsentStore();
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
  const composition = createDesktopComposition({
    storage: new MemoryProjectStorage(),
    picker: createFakePicker(),
    prompts: autoConfirmPrompts,
    ai: { provider, credentials, consent, clock, sleep: clock.sleep },
  });
  if (options.withDocument !== false) {
    composition.session.open({ document: fixtureDocument(), source: "system" });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<AiPanel controller={composition.ai} />);
  });
  const panel = container.querySelector<HTMLElement>(".ai-panel");
  if (panel === null) throw new Error("ai panel not rendered");
  return {
    composition,
    panel,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      composition.dispose();
    },
  };
}

function button(panel: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(
    panel.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

function textarea(panel: HTMLElement, label: string): HTMLTextAreaElement {
  const found = Array.from(
    panel.querySelectorAll<HTMLTextAreaElement>("textarea"),
  ).find((candidate) => candidate.getAttribute("aria-label") === label);
  if (found === undefined) throw new Error(`textarea not found: ${label}`);
  return found;
}

function input(panel: HTMLElement, label: string): HTMLInputElement {
  const found = Array.from(
    panel.querySelectorAll<HTMLInputElement>("input"),
  ).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label ||
      candidate.closest("label")?.textContent.includes(label) === true,
  );
  if (found === undefined) throw new Error(`input not found: ${label}`);
  return found;
}

/** Sets a controlled input's value through the native setter (React sees it). */
function setValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set === undefined) throw new Error("missing value setter");
  descriptor.set.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Yields through the microtask chain so async controller flows settle. */
async function flushAsync(times = 32): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("ai panel", () => {
  it("shows the empty state without a document", () => {
    const mounted = mountPanel({ withDocument: false });
    expect(mounted.panel.textContent).toContain(
      "Open a document to use the AI assistant",
    );
    mounted.unmount();
  });

  it("offers key configuration and explains the unavailable state", async () => {
    const mounted = mountPanel({ withKey: false, withConsent: false });
    expect(mounted.panel.textContent).toContain("Provider settings");
    expect(mounted.panel.textContent).toContain(
      "AI runs are unavailable until a provider key is stored",
    );
    const keyInput = input(mounted.panel, "Provider API key");
    act(() => {
      setValue(keyInput, "sk-test");
    });
    await act(async () => {
      button(mounted.panel, "Save key").click();
      await flushAsync();
    });
    expect(mounted.panel.textContent).toContain("Provider key stored");
    mounted.unmount();
  });

  it("requires explicit consent before the run form appears", async () => {
    const mounted = mountPanel({ withKey: true, withConsent: false });
    await act(async () => {
      await mounted.composition.ai.refreshStatus();
    });
    expect(mounted.panel.textContent).toContain("I understand and enable");
    expect(
      Array.from(mounted.panel.querySelectorAll("button")).some((candidate) =>
        candidate.textContent.includes("Run"),
      ),
    ).toBe(false);
    await act(async () => {
      button(
        mounted.panel,
        "I understand and enable deterministic-model",
      ).click();
      await flushAsync();
    });
    expect(mounted.panel.textContent).toContain("Describe the edit");
    mounted.unmount();
  });

  it("runs a prompt, shows progress, and reaches Apply/Discard", async () => {
    const mounted = mountPanel({ script: SUCCESS_SCRIPT });
    await act(async () => {
      await mounted.composition.ai.refreshStatus();
    });
    const prompt = textarea(mounted.panel, "AI edit request");
    act(() => {
      setValue(prompt, "Add a voxel to the box");
    });
    await act(async () => {
      button(mounted.panel, "Run").click();
      await flushAsync();
    });
    // The run completes: the proposal is ready for review with a bounded
    // diff and the Apply/Discard controls.
    expect(mounted.panel.textContent).toContain("Proposal ready for review");
    expect(mounted.panel.textContent).toContain("1 staged command");
    expect(mounted.panel.textContent).toContain("voxel.fillBox");
    button(mounted.panel, "Apply");
    button(mounted.panel, "Discard");
    mounted.unmount();
  });

  it("applies the proposal as one labeled undoable history entry", async () => {
    const mounted = mountPanel({ script: SUCCESS_SCRIPT });
    await act(async () => {
      await mounted.composition.ai.refreshStatus();
    });
    const prompt = textarea(mounted.panel, "AI edit request");
    act(() => {
      setValue(prompt, "Add a voxel to the box");
    });
    await act(async () => {
      button(mounted.panel, "Run").click();
      await flushAsync();
    });
    const label = input(mounted.panel, "History label");
    act(() => {
      setValue(label, "AI: add a voxel");
    });
    act(() => {
      button(mounted.panel, "Apply").click();
    });
    expect(mounted.panel.textContent).toContain("Applied");
    const state = mounted.composition.session.current;
    if (state === undefined) throw new Error("no session");
    const history = state.bus.historySnapshot().past;
    expect(history).toHaveLength(1);
    expect(history[0]?.label).toBe("AI: add a voxel");
    mounted.unmount();
  });

  it("discards the proposal with no history entry", async () => {
    const mounted = mountPanel({ script: SUCCESS_SCRIPT });
    await act(async () => {
      await mounted.composition.ai.refreshStatus();
    });
    const prompt = textarea(mounted.panel, "AI edit request");
    act(() => {
      setValue(prompt, "Add a voxel to the box");
    });
    await act(async () => {
      button(mounted.panel, "Run").click();
      await flushAsync();
    });
    act(() => {
      button(mounted.panel, "Discard").click();
    });
    const state = mounted.composition.session.current;
    if (state === undefined) throw new Error("no session");
    expect(state.bus.historySnapshot().past).toHaveLength(0);
    expect(state.store.revision).toBe(0);
    mounted.unmount();
  });

  it("shows the stale-base conflict choices instead of silently rebasing", async () => {
    const mounted = mountPanel({ script: SUCCESS_SCRIPT });
    await act(async () => {
      await mounted.composition.ai.refreshStatus();
    });
    const prompt = textarea(mounted.panel, "AI edit request");
    act(() => {
      setValue(prompt, "Add a voxel to the box");
    });
    await act(async () => {
      button(mounted.panel, "Run").click();
      await flushAsync();
    });
    // The user edits the document while the proposal is staged.
    const current = mounted.composition.session.current;
    if (current === undefined) throw new Error("no session");
    act(() => {
      const result = current.bus.execute(
        {
          id: commandId("command:ai:panel-manual"),
          type: "voxel.set",
          schemaVersion: 1,
          payload: {
            volumeId: "volume:ai:0001",
            coordinate: [10, 10, 10],
            material: 1,
          },
        },
        {
          transactionId: transactionId("transaction:ai:panel-manual"),
          expectedRevision: current.store.revision,
          source: "ui",
        },
      );
      expect(result.ok).toBe(true);
    });
    act(() => {
      button(mounted.panel, "Apply").click();
    });
    expect(mounted.panel.textContent).toContain(
      "The document changed while the proposal was pending",
    );
    button(mounted.panel, "Discard");
    button(mounted.panel, "Reinspect");
    button(mounted.panel, "Replan");
    mounted.unmount();
  });

  it("surfaces a provider failure and dismisses back to idle", async () => {
    const mounted = mountPanel({
      script: [
        {
          text: "",
          error: {
            family: "network",
            code: "NETWORK_FAILURE",
            message: "The provider is unreachable",
            retryable: false,
          },
        },
      ],
    });
    await act(async () => {
      await mounted.composition.ai.refreshStatus();
    });
    const prompt = textarea(mounted.panel, "AI edit request");
    act(() => {
      setValue(prompt, "Add a voxel to the box");
    });
    await act(async () => {
      button(mounted.panel, "Run").click();
      await flushAsync();
    });
    expect(mounted.panel.textContent).toContain("provider is unreachable");
    act(() => {
      button(mounted.panel, "Dismiss").click();
    });
    expect(mounted.panel.textContent).toContain("Describe the edit");
    mounted.unmount();
  });
});
