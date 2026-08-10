// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { createDocument } from "@voxel-maker/model";
import {
  CommandBus,
  CommandRegistry,
  fillBoxCommand,
  registerBatchCommands,
  registerVoxelCommands,
} from "@voxel-maker/commands";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import { writeVxlProject } from "@voxel-maker/formats";
import type { EditorToolId, SelectionMode } from "@voxel-maker/editor";
import {
  createDesktopComposition,
  type DesktopComposition,
  type FilePicker,
} from "../composition.js";
import { autoConfirmPrompts, requireResult } from "../test-prompts.js";
import type { ViewportController } from "./controller.js";
import { Viewport } from "./Viewport.js";

/**
 * Viewport DOM-binding integration tests (ticket #48): the React
 * `Viewport` component is rendered into a real DOM (happy-dom) and real
 * pointer events are dispatched through the host element, so the gesture
 * routing between the DOM binding and the viewport controller is
 * exercised end to end. The headless controller tests drive
 * `toolPointerDown/Move/Up` directly, which is why a region-mode drag
 * could be green in CI while the app path orbited the camera instead of
 * rubber-banding.
 *
 * The Three.js WebGL renderer is stubbed (the tests run without a GPU);
 * everything else — composition, picker, store, controller, tools — is
 * the real headless stack. The render loop's `requestAnimationFrame`
 * scheduling is stubbed so tests stay deterministic and must call
 * `viewport.applyCamera()` before picking, like the controller tests do.
 */
vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class WebGLRendererStub {
    readonly domElement: HTMLCanvasElement;
    readonly info = { render: { calls: 0, triangles: 0 } };
    constructor() {
      this.domElement = document.createElement("canvas");
    }
    // The stub intentionally ignores GPU state; `void` marks the args as
    // consumed so the lint rules stay quiet.
    setPixelRatio(ratio: number): void {
      void ratio;
    }
    setSize(width: number, height: number): void {
      void width;
      void height;
    }
    render(): void {}
    dispose(): void {}
  }
  return {
    ...actual,
    WebGLRenderer: WebGLRendererStub as unknown as typeof actual.WebGLRenderer,
  };
});

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:test:root");
const CHILD = nodeId("node:test:child");
const VOLUME = volumeId("volume:test:0001");

/** A project with a 4x4x4 box at world translation (2, 0, 0). */
function buildFixtureProject(): Uint8Array {
  const document = createDocument({
    documentId: documentId("document:test:0001"),
    metadata: { title: "fixture-box" },
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
        transform: { ...IDENTITY, translation: [2, 0, 0] },
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
  const { store, writeCapability } = createDocumentStoreHandle({ document });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);
  const result = bus.execute(
    fillBoxCommand(commandId("command:test:fill"), {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [4, 4, 4] },
      material: materialId(1),
    }),
    {
      transactionId: transactionId("transaction:test:fill"),
      expectedRevision: 0,
      source: "system",
    },
  );
  if (!result.ok) throw new Error(`fixture fill failed: ${result.error.code}`);
  const readView = store.getVolume(VOLUME);
  if (readView === undefined) throw new Error("missing read view");
  return writeVxlProject({
    document: store.getDocument(),
    volumes: new Map([[VOLUME, readView]]),
  });
}

const createFakePicker = (): FilePicker => ({
  pickOpenPath: () => Promise.resolve(undefined),
  pickSavePath(suggestedName) {
    return Promise.resolve(suggestedName);
  },
});

async function openFixture(composition: DesktopComposition): Promise<void> {
  const result = requireResult(
    await composition.fileService.openLoadedProject(
      "fixture.vxl",
      buildFixtureProject(),
    ),
  );
  if (!result.ok) {
    const error = result.error;
    throw new Error(
      `open failed: ${error === undefined ? "unknown" : error.code}`,
    );
  }
}

/** Frames the fixture from the front and applies the camera projection. */
function frameFront(composition: DesktopComposition): void {
  composition.viewport.setViewportSize(800, 600);
  composition.viewport.setStandardView("front");
  composition.viewport.focus();
  // The real render loop calls applyCamera every frame; with the loop
  // stubbed out, tests must push the camera state themselves.
  composition.viewport.applyCamera();
}

interface FoundPick {
  readonly hit: NonNullable<ReturnType<ViewportController["pick"]>>;
  readonly x: number;
  readonly y: number;
}

/** Scans the viewport for a pick matching the predicate (camera-proof). */
function scanPick(
  composition: DesktopComposition,
  predicate: (
    hit: NonNullable<ReturnType<ViewportController["pick"]>>,
  ) => boolean,
): FoundPick | undefined {
  const viewport = composition.viewport;
  for (let y = 40; y < 560; y += 24) {
    for (let x = 20; x < 780; x += 24) {
      const hit = viewport.pick(x, y);
      if (hit !== undefined && predicate(hit)) return { hit, x, y };
    }
  }
  return undefined;
}

/** Dispatches a real pointer event through the viewport DOM binding. */
function dispatchPointer(
  host: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  options: {
    readonly clientX: number;
    readonly clientY: number;
    readonly button?: number;
    readonly shiftKey?: boolean;
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
  },
): void {
  host.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: options.button ?? 0,
      buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
      clientX: options.clientX,
      clientY: options.clientY,
      shiftKey: options.shiftKey ?? false,
      ctrlKey: options.ctrlKey ?? false,
      metaKey: options.metaKey ?? false,
    }),
  );
}

/** Renders the Viewport into a detached container and returns its host. */
function mountViewport(
  composition: DesktopComposition,
  tool: EditorToolId,
  mode: SelectionMode,
): { readonly host: HTMLElement; readonly unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <Viewport
        composition={composition}
        activeTool={tool}
        selectionMode={mode}
      />,
    );
  });
  const host = container.querySelector<HTMLElement>(".viewport");
  if (host === null) throw new Error("viewport host not rendered");
  return {
    host,
    unmount: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * Creates a composition, opens the fixture, mounts the Viewport in select
 * mode, and frames the content. The mount effect reads the host layout
 * (0x0 in the DOM test) and resizes the controller, so the viewport is
 * framed again after mounting for picking to use the fixed 800x600 size.
 */
async function mountSelectViewport(mode: SelectionMode): Promise<{
  readonly composition: DesktopComposition;
  readonly host: HTMLElement;
  readonly unmount: () => void;
}> {
  const composition = createDesktopComposition({
    storage: new MemoryProjectStorage(),
    picker: createFakePicker(),
    prompts: autoConfirmPrompts,
  });
  await openFixture(composition);
  const mounted = mountViewport(composition, "select", mode);
  frameFront(composition);
  if (mode === "region") composition.editor.setSelectionMode("region");
  return { composition, ...mounted };
}

describe("viewport DOM binding", () => {
  beforeAll(() => {
    // Deterministic render loop: the stub never schedules frames, so the
    // camera projection is applied explicitly by the tests.
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("rubber-bands a region-mode drag and commits the region on release", async () => {
    const { composition, host, unmount } = await mountSelectViewport("region");
    const viewport = composition.viewport;
    // Both drag corners must land on the same volume (the box).
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) {
      throw new Error("the box must offer two pickable drag corners");
    }
    const startHit = start.hit;
    const end = scanPick(
      composition,
      (hit) =>
        hit.nodeId === CHILD &&
        (hit.voxel[0] !== startHit.voxel[0] ||
          hit.voxel[1] !== startHit.voxel[1]),
    );
    if (end === undefined) {
      throw new Error("the box must offer two pickable drag corners");
    }
    // Pointer down starts the select-tool gesture and publishes the draft.
    dispatchPointer(host, "pointerdown", {
      clientX: start.x,
      clientY: start.y,
    });
    expect(viewport.toolActive).toBe(true);
    expect(composition.editor.regionDraft).toEqual({
      volumeId: start.hit.volumeId,
      region: {
        min: [start.hit.voxel[0], start.hit.voxel[1], start.hit.voxel[2]],
        max: [
          start.hit.voxel[0] + 1,
          start.hit.voxel[1] + 1,
          start.hit.voxel[2] + 1,
        ],
      },
    });
    // The move must update the draft through the tool lifecycle (the bug:
    // it orbited the camera instead).
    const directionBefore = viewport.cameraState.direction;
    dispatchPointer(host, "pointermove", {
      clientX: end.x,
      clientY: end.y,
    });
    expect(composition.editor.regionDraft).toBeDefined();
    expect(viewport.cameraState.direction).toEqual(directionBefore);
    dispatchPointer(host, "pointerup", { clientX: end.x, clientY: end.y });
    expect(composition.editor.regionDraft).toBeUndefined();
    expect(viewport.toolActive).toBe(false);
    expect(composition.editor.selection).toEqual([
      {
        kind: "region",
        volumeId: start.hit.volumeId,
        region: {
          min: [
            Math.min(start.hit.voxel[0], end.hit.voxel[0]),
            Math.min(start.hit.voxel[1], end.hit.voxel[1]),
            Math.min(start.hit.voxel[2], end.hit.voxel[2]),
          ],
          max: [
            Math.max(start.hit.voxel[0], end.hit.voxel[0]) + 1,
            Math.max(start.hit.voxel[1], end.hit.voxel[1]) + 1,
            Math.max(start.hit.voxel[2], end.hit.voxel[2]) + 1,
          ],
        },
      },
    ]);
    // A selection gesture never commits semantic state.
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(state.bus.historySnapshot().past).toHaveLength(0);
    unmount();
    composition.dispose();
  });

  it("commits a one-voxel region on a plain region-mode click", async () => {
    const { composition, host, unmount } = await mountSelectViewport("region");
    const viewport = composition.viewport;
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) throw new Error("the box must be pickable");
    // A click in region mode must go through the tool lifecycle too (the
    // bug: it fell through to the click-style voxel select and left the
    // tool stuck active with a stale draft until Escape).
    dispatchPointer(host, "pointerdown", {
      clientX: start.x,
      clientY: start.y,
    });
    dispatchPointer(host, "pointerup", {
      clientX: start.x,
      clientY: start.y,
    });
    const voxel = start.hit.voxel;
    expect(composition.editor.selection).toEqual([
      {
        kind: "region",
        volumeId: start.hit.volumeId,
        region: {
          min: [voxel[0], voxel[1], voxel[2]],
          max: [voxel[0] + 1, voxel[1] + 1, voxel[2] + 1],
        },
      },
    ]);
    expect(viewport.toolActive).toBe(false);
    expect(composition.editor.regionDraft).toBeUndefined();
    // The tool is not stuck: a second click replaces the region.
    const second = scanPick(
      composition,
      (hit) =>
        hit.nodeId === CHILD &&
        (hit.voxel[0] !== voxel[0] || hit.voxel[1] !== voxel[1]),
    );
    if (second === undefined) {
      throw new Error("the box must offer a second pickable voxel");
    }
    dispatchPointer(host, "pointerdown", {
      clientX: second.x,
      clientY: second.y,
    });
    dispatchPointer(host, "pointerup", {
      clientX: second.x,
      clientY: second.y,
    });
    expect(composition.editor.selection).toHaveLength(1);
    expect(composition.editor.selection[0]?.kind).toBe("region");
    unmount();
    composition.dispose();
  });

  it("clears on a region-mode click on empty space and keeps Shift clicks", async () => {
    const { composition, host, unmount } = await mountSelectViewport("region");
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) throw new Error("the box must be pickable");
    // Select a one-voxel region first.
    dispatchPointer(host, "pointerdown", {
      clientX: start.x,
      clientY: start.y,
    });
    dispatchPointer(host, "pointerup", { clientX: start.x, clientY: start.y });
    expect(composition.editor.selection).toHaveLength(1);
    // A plain click on empty space clears (all modes, including region).
    dispatchPointer(host, "pointerdown", { clientX: 5, clientY: 5 });
    dispatchPointer(host, "pointerup", { clientX: 5, clientY: 5 });
    expect(composition.editor.selection).toEqual([]);
    // A Shift-modified miss leaves the selection untouched.
    dispatchPointer(host, "pointerdown", {
      clientX: start.x,
      clientY: start.y,
    });
    dispatchPointer(host, "pointerup", { clientX: start.x, clientY: start.y });
    expect(composition.editor.selection).toHaveLength(1);
    dispatchPointer(host, "pointerdown", {
      clientX: 5,
      clientY: 5,
      shiftKey: true,
    });
    dispatchPointer(host, "pointerup", { clientX: 5, clientY: 5 });
    expect(composition.editor.selection).toHaveLength(1);
    expect(composition.editor.regionDraft).toBeUndefined();
    unmount();
    composition.dispose();
  });

  it("leaves modified keys to the global shortcut service", async () => {
    // The viewport's bare keys (1-6 views, F/P, overlay toggles) must not
    // consume Ctrl/Cmd/Alt combinations: Ctrl+2 belongs to the shortcut
    // service (pencil tool), never to the back view (ticket #43).
    const { composition, host, unmount } = await mountSelectViewport("node");
    await openFixture(composition);
    frameFront(composition);
    const before = composition.viewport.cameraState.direction;
    host.ownerDocument.defaultView?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "2",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    expect(composition.viewport.cameraState.direction).toEqual(before);
    // A bare 2 still switches to the back view.
    host.ownerDocument.defaultView?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "2", bubbles: true }),
    );
    expect(composition.viewport.cameraState.direction).toEqual([0, 0, -1]);
    unmount();
    composition.dispose();
  });

  it("cancels a region-mode drag on pointercancel without side effects", async () => {
    const { composition, host, unmount } = await mountSelectViewport("region");
    const viewport = composition.viewport;
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) throw new Error("the box must be pickable");
    dispatchPointer(host, "pointerdown", {
      clientX: start.x,
      clientY: start.y,
    });
    dispatchPointer(host, "pointermove", {
      clientX: start.x + 60,
      clientY: start.y + 40,
    });
    expect(composition.editor.regionDraft).toBeDefined();
    dispatchPointer(host, "pointercancel", {
      clientX: start.x + 60,
      clientY: start.y + 40,
    });
    expect(composition.editor.selection).toEqual([]);
    expect(composition.editor.regionDraft).toBeUndefined();
    expect(viewport.toolActive).toBe(false);
    unmount();
    composition.dispose();
  });

  it("still routes node-mode clicks to the click-style select", async () => {
    const { composition, host, unmount } = await mountSelectViewport("node");
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) throw new Error("the box must be pickable");
    dispatchPointer(host, "pointerdown", {
      clientX: start.x,
      clientY: start.y,
    });
    dispatchPointer(host, "pointerup", {
      clientX: start.x,
      clientY: start.y,
    });
    expect(composition.editor.selection).toEqual([
      { kind: "node", nodeId: CHILD },
    ]);
    unmount();
    composition.dispose();
  });

  it("still orbits on a node-mode drag instead of selecting", async () => {
    const { composition, host, unmount } = await mountSelectViewport("node");
    const viewport = composition.viewport;
    const directionBefore = viewport.cameraState.direction;
    dispatchPointer(host, "pointerdown", {
      clientX: 400,
      clientY: 300,
    });
    dispatchPointer(host, "pointermove", {
      clientX: 460,
      clientY: 300,
    });
    dispatchPointer(host, "pointerup", { clientX: 460, clientY: 300 });
    expect(viewport.cameraState.direction).not.toEqual(directionBefore);
    expect(composition.editor.selection).toEqual([]);
    unmount();
    composition.dispose();
  });
});
