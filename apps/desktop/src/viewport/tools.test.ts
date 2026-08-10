import { describe, expect, it } from "vitest";
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
  deleteNodeCommand,
  fillBoxCommand,
  registerBatchCommands,
  registerVoxelCommands,
} from "@voxel-maker/commands";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import { writeVxlProject } from "@voxel-maker/formats";
import {
  createDesktopComposition,
  type DesktopComposition,
  type FilePicker,
} from "../composition.js";
import { autoConfirmPrompts, requireResult } from "../test-prompts.js";
import type { ViewportController } from "./controller.js";

/**
 * Desktop selection and shape-tool integration tests (plan S7.2/S7.4/
 * S7.6/S7.7/S7.19, ticket #18): the full composition seam — click/add/
 * toggle/clear node selection, region drag selection, pruning of deleted
 * references, eyedropper sampling, paint recoloring, box/sphere/cylinder
 * previews and one labeled transaction per gesture, atomic budget
 * failures, and proof that selection/tool runtime state never reaches the
 * saved bytes.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:test:root");
const CHILD = nodeId("node:test:child");
const CHILD_B = nodeId("node:test:child-b");
const VOLUME = volumeId("volume:test:0001");
const VOLUME_B = volumeId("volume:test:0002");
const MATERIAL = materialId(1);
const REPLACEMENT = materialId(2);

/**
 * A project with two 6x6x6 boxes: box A spans x in [-6, 0), box B spans
 * x in [2, 8), both at negative y/z. `filled` controls whether box A is
 * voxelized (box B is always empty so multi-node selection must pick A).
 */
function buildFixtureProject(filled = true): Uint8Array {
  const document = createDocument({
    documentId: documentId("document:test:0001"),
    metadata: { title: "fixture-two-boxes" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [CHILD, CHILD_B],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: CHILD,
        name: "Box A",
        parentId: ROOT,
        children: [],
        transform: IDENTITY,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
      {
        nodeId: CHILD_B,
        name: "Box B",
        parentId: ROOT,
        children: [],
        transform: IDENTITY,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME_B }],
      },
    ],
    materials: [
      {
        materialId: MATERIAL,
        name: "red",
        color: "#ff0000",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
      {
        materialId: REPLACEMENT,
        name: "blue",
        color: "#0000ff",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      { volumeId: VOLUME, bounds: { min: [-8, -8, -8], max: [8, 8, 8] } },
      { volumeId: VOLUME_B, bounds: { min: [-8, -8, -8], max: [8, 8, 8] } },
    ],
  });
  const { store, writeCapability } = createDocumentStoreHandle({ document });
  if (filled) {
    const registry = new CommandRegistry();
    registerVoxelCommands(registry);
    registerBatchCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const result = bus.execute(
      fillBoxCommand(commandId("command:test:fill"), {
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [0, 0, 0] },
        material: MATERIAL,
      }),
      {
        transactionId: transactionId("transaction:test:fill"),
        expectedRevision: 0,
        source: "system",
      },
    );
    if (!result.ok)
      throw new Error(`fixture fill failed: ${result.error.code}`);
    const second = bus.execute(
      fillBoxCommand(commandId("command:test:fill-b"), {
        volumeId: VOLUME_B,
        region: { min: [2, -6, -6], max: [8, 0, 0] },
        material: REPLACEMENT,
      }),
      {
        transactionId: transactionId("transaction:test:fill-b"),
        expectedRevision: store.revision,
        source: "system",
      },
    );
    if (!second.ok)
      throw new Error(`fixture fill b failed: ${second.error.code}`);
  }
  const readView = store.getVolume(VOLUME);
  if (readView === undefined) throw new Error("missing read view");
  const readViewB = store.getVolume(VOLUME_B);
  if (readViewB === undefined) throw new Error("missing read view b");
  return writeVxlProject({
    document: store.getDocument(),
    volumes: new Map([
      [VOLUME, readView],
      [VOLUME_B, readViewB],
    ]),
  });
}

const createFakePicker = (): FilePicker => ({
  pickOpenPath: () => Promise.resolve(undefined),
  pickSavePath(suggestedName) {
    return Promise.resolve({ token: suggestedName, path: suggestedName });
  },
});

async function openFixture(
  composition: DesktopComposition,
  filled = true,
): Promise<void> {
  const result = requireResult(
    await composition.fileService.openLoadedProject(
      "fixture.vxl",
      buildFixtureProject(filled),
    ),
  );
  if (!result.ok) {
    const error = result.error;
    throw new Error(
      `open failed: ${error === undefined ? "unknown" : error.code}`,
    );
  }
}

function frameFront(composition: DesktopComposition): void {
  composition.viewport.setViewportSize(800, 600);
  composition.viewport.setStandardView("front");
  composition.viewport.focus();
}

function materialAt(
  composition: DesktopComposition,
  volumeIdValue: string,
  coordinate: [number, number, number],
): number {
  const state = composition.session.current;
  if (state === undefined) throw new Error("no open session");
  return state.store.getVoxel(volumeIdValue as never, coordinate);
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

describe("desktop selection workflows", () => {
  it("selects, add-selects, toggles, and clears through the controller", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    const viewport = composition.viewport;
    const a = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (a === undefined) throw new Error("box A must be pickable");
    const b = scanPick(composition, (hit) => hit.nodeId === CHILD_B);
    if (b === undefined) throw new Error("box B must be pickable");
    // Plain click replaces the selection with the picked node.
    viewport.selectAt(a.x, a.y);
    expect(composition.editor.selection).toEqual([
      { kind: "node", nodeId: CHILD },
    ]);
    // Shift-click adds the second node.
    viewport.selectAt(b.x, b.y, { additive: true, toggle: false });
    expect(composition.editor.selection).toEqual([
      { kind: "node", nodeId: CHILD },
      { kind: "node", nodeId: CHILD_B },
    ]);
    // Ctrl-click toggles the first node off.
    viewport.selectAt(a.x, a.y, { additive: false, toggle: true });
    expect(composition.editor.selection).toEqual([
      { kind: "node", nodeId: CHILD_B },
    ]);
    // Escape clears.
    viewport.clearSelection();
    expect(composition.editor.selection).toEqual([]);
    composition.dispose();
  });

  it("prunes selection references after the selected node is deleted", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    const a = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (a === undefined) throw new Error("box A must be pickable");
    composition.viewport.selectAt(a.x, a.y);
    expect(composition.editor.selection).toEqual([
      { kind: "node", nodeId: CHILD },
    ]);
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const deleted = state.bus.execute(
      deleteNodeCommand(commandId("command:test:delete"), {
        nodeId: CHILD,
      }),
      {
        transactionId: transactionId("transaction:test:delete"),
        expectedRevision: state.store.revision,
        source: "ui",
      },
    );
    expect(deleted.ok).toBe(true);
    // The store commit pruned the deleted reference.
    expect(composition.editor.selection).toEqual([]);
    composition.dispose();
  });

  it("selects a region by dragging in region mode and clears on Escape", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setSelectionMode("region");
    const viewport = composition.viewport;
    // Both drag corners must land on the same volume (box A).
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) {
      throw new Error("box A must offer two pickable drag corners");
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
      throw new Error("box A must offer two pickable drag corners");
    }
    expect(viewport.toolPointerDown(start.x, start.y)).toEqual({ ok: true });
    expect(viewport.toolActive).toBe(true);
    expect(composition.editor.regionDraft).toBeDefined();
    viewport.toolPointerMove(end.x, end.y);
    viewport.toolPointerUp();
    expect(composition.editor.regionDraft).toBeUndefined();
    const expectedRegion = {
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
    };
    expect(composition.editor.selection).toEqual([
      { kind: "region", volumeId: start.hit.volumeId, region: expectedRegion },
    ]);
    // No geometry was committed by a selection gesture.
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(state.bus.historySnapshot().past).toHaveLength(0);
    viewport.clearSelection();
    expect(composition.editor.selection).toEqual([]);
    composition.dispose();
  });

  it("resolves a region-mode miss even when the tool changes mid-gesture", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setSelectionMode("region");
    const viewport = composition.viewport;
    // Down on empty space starts a region gesture with a pending miss;
    // switching tools before the release must not strand that state on
    // the select tool (regression: the miss was never pinned, so the up
    // routed to the new tool and the next region drag resolved as a
    // miss, clearing the selection instead of committing the region).
    viewport.toolPointerDown(5, 5);
    expect(viewport.toolActive).toBe(false);
    composition.editor.setActiveTool("pencil");
    viewport.toolPointerUp();
    expect(viewport.toolActive).toBe(false);
    // Back on select, a real region drag must commit normally.
    composition.editor.setActiveTool("select");
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) {
      throw new Error("box A must offer two pickable drag corners");
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
      throw new Error("box A must offer two pickable drag corners");
    }
    viewport.toolPointerDown(start.x, start.y);
    viewport.toolPointerMove(end.x, end.y);
    viewport.toolPointerUp();
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
    composition.dispose();
  });
});

describe("desktop tool workflows", () => {
  it("paints only occupied voxels as one labeled, undoable transaction", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setActiveMaterial(REPLACEMENT);
    composition.editor.setActiveTool("paint");
    const viewport = composition.viewport;
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) throw new Error("fixture voxels must be pickable");
    const startHit = start.hit;
    const end = scanPick(
      composition,
      (hit) =>
        hit.nodeId === CHILD &&
        (hit.voxel[0] !== startHit.voxel[0] ||
          hit.voxel[1] !== startHit.voxel[1]),
    );
    if (end === undefined) throw new Error("fixture voxels must be pickable");
    viewport.toolPointerDown(start.x, start.y);
    // The draft previews only occupied voxels that will change.
    expect(composition.editor.draft?.voxels.length).toBeGreaterThan(0);
    viewport.toolPointerMove(end.x, end.y);
    viewport.toolPointerUp();
    expect(
      materialAt(composition, start.hit.volumeId, [
        start.hit.voxel[0],
        start.hit.voxel[1],
        start.hit.voxel[2],
      ]),
    ).toBe(2);
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(state.bus.historySnapshot().past).toHaveLength(1);
    expect(state.bus.historySnapshot().past[0]?.label).toBe("Paint stroke");
    const undo = state.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: state.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(
      materialAt(composition, start.hit.volumeId, [
        start.hit.voxel[0],
        start.hit.voxel[1],
        start.hit.voxel[2],
      ]),
    ).toBe(1);
    composition.dispose();
  });

  it("samples the material under the pointer with the eyedropper", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setActiveTool("eyedropper");
    const viewport = composition.viewport;
    const a = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (a === undefined) throw new Error("fixture voxels must be pickable");
    viewport.toolPointerDown(a.x, a.y);
    expect(composition.editor.activeMaterial).toBe(MATERIAL);
    // No gesture, no draft, no transaction.
    expect(viewport.toolActive).toBe(false);
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(state.bus.historySnapshot().past).toHaveLength(0);
    composition.dispose();
  });

  it("fills a box drag as one labeled, undoable transaction", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setActiveTool("box");
    const viewport = composition.viewport;
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) throw new Error("fixture voxels must be pickable");
    viewport.toolPointerDown(start.x, start.y);
    expect(viewport.toolActive).toBe(true);
    expect(composition.editor.draft?.voxels).toHaveLength(1);
    const startHit = start.hit;
    const end = scanPick(
      composition,
      (hit) =>
        hit.nodeId === CHILD &&
        (hit.voxel[0] !== startHit.voxel[0] ||
          hit.voxel[1] !== startHit.voxel[1]),
    );
    if (end === undefined) throw new Error("box drag needs a second corner");
    viewport.toolPointerMove(end.x, end.y);
    expect(composition.editor.draft?.voxels.length).toBeGreaterThan(1);
    viewport.toolPointerUp();
    expect(viewport.toolActive).toBe(false);
    expect(composition.editor.draft).toBeUndefined();
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(state.bus.historySnapshot().past).toHaveLength(1);
    expect(state.bus.historySnapshot().past[0]?.label).toBe("Fill box");
    const undo = state.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: state.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(state.bus.historySnapshot().past).toHaveLength(0);
    composition.dispose();
  });

  it("fills sphere and cylinder drags as one transaction each", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setActiveMaterial(REPLACEMENT);
    const viewport = composition.viewport;
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) throw new Error("fixture voxels must be pickable");
    const startHit = start.hit;
    const end = scanPick(
      composition,
      (hit) =>
        hit.nodeId === CHILD &&
        (hit.voxel[0] !== startHit.voxel[0] ||
          hit.voxel[1] !== startHit.voxel[1]),
    );
    if (end === undefined) throw new Error("shape drag needs a second corner");
    // Sphere.
    composition.editor.setActiveTool("sphere");
    viewport.toolPointerDown(start.x, start.y);
    viewport.toolPointerMove(end.x, end.y);
    viewport.toolPointerUp();
    // The sphere stays visible to the picker for the cylinder drag.
    composition.editor.setActiveTool("cylinder");
    viewport.toolPointerDown(start.x, start.y);
    viewport.toolPointerMove(end.x, end.y);
    viewport.toolPointerUp();
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(state.bus.historySnapshot().past).toHaveLength(2);
    expect(state.bus.historySnapshot().past[0]?.label).toBe("Fill sphere");
    expect(state.bus.historySnapshot().past[1]?.label).toBe("Fill cylinder");
    composition.dispose();
  });

  it("rejects an oversized shape atomically through the composition", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
      gestureVoxelLimit: 4,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setActiveTool("box");
    const viewport = composition.viewport;
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) throw new Error("fixture voxels must be pickable");
    const startHit = start.hit;
    expect(viewport.toolPointerDown(start.x, start.y)).toEqual({ ok: true });
    // A small move stays inside the budget.
    const small = scanPick(
      composition,
      (hit) =>
        hit.nodeId === CHILD &&
        Math.abs(hit.voxel[0] - startHit.voxel[0]) +
          Math.abs(hit.voxel[1] - startHit.voxel[1]) ===
          1,
    );
    if (small === undefined) throw new Error("need an adjacent voxel");
    expect(viewport.toolPointerMove(small.x, small.y)).toEqual({ ok: true });
    // A far move spans 5+ voxels along one axis: 5x1x1 > 4.
    const far = scanPick(
      composition,
      (hit) =>
        hit.nodeId === CHILD && Math.abs(hit.voxel[0] - startHit.voxel[0]) >= 5,
    );
    if (far === undefined) throw new Error("need a far voxel");
    const oversized = viewport.toolPointerMove(far.x, far.y);
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.error.code).toBe("TOO_MANY_VOXELS");
    expect(viewport.toolActive).toBe(false);
    expect(composition.editor.draft).toBeUndefined();
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(state.bus.historySnapshot().past).toHaveLength(0);
    composition.dispose();
  });
});

describe("runtime state serialization exclusion", () => {
  it("never persists selection or tool state into the saved bytes", async () => {
    const storage = new MemoryProjectStorage();
    const composition = createDesktopComposition({
      storage,
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    // Leave distinctive runtime state behind.
    composition.editor.setSelection([
      { kind: "node", nodeId: CHILD },
      { kind: "voxel", volumeId: VOLUME, voxel: [0, 0, 0] },
    ]);
    composition.editor.setSelectionMode("region");
    composition.editor.setActiveTool("sphere");
    composition.editor.setActiveMaterial(REPLACEMENT);
    // Save As writes real bytes (a same-path save of an unchanged opened
    // project is the documented unchanged short-circuit and writes nothing).
    const saved = requireResult(await composition.fileService.saveProjectAs());
    expect(saved.ok).toBe(true);
    if (saved.path === undefined) throw new Error("save produced no path");
    const bytes = await storage.readProject(saved.path);
    const text = new TextDecoder().decode(bytes);
    // Runtime-only EditorStore state must never leak into the manifest
    // (the document legitimately contains node ids and voxel components;
    // the runtime fields themselves are what must stay out).
    expect(text).not.toContain("selectionMode");
    expect(text).not.toContain("activeTool");
    expect(text).not.toContain("regionDraft");
    expect(text).not.toContain("notices");
    expect(text).not.toContain("draft");
    // A fresh composition opening the same bytes starts with the default
    // runtime state.
    const fresh = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    const reopened = requireResult(
      await fresh.fileService.openLoadedProject("fixture.vxl", bytes),
    );
    expect(reopened.ok).toBe(true);
    expect(fresh.editor.selection).toEqual([]);
    expect(fresh.editor.selectionMode).toBe("node");
    expect(fresh.editor.activeTool).toBe("select");
    expect(fresh.editor.activeMaterial).toBe(MATERIAL);
    fresh.dispose();
    composition.dispose();
  });
});
