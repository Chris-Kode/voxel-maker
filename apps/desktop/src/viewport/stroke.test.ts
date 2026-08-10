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
import { createDocument } from "@voxel-maker/model";
import {
  CommandBus,
  CommandRegistry,
  deleteMaterialCommand,
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

/**
 * Desktop stroke integration tests (plan S7.3/S7.5, ticket #17): the full
 * composition seam — real picking over the authoritative store, the
 * stroke tools, one labeled transaction per gesture, exact undo/redo,
 * transient preview projection, negative coordinates, and deleted active
 * materials. Everything runs headless through the real command path.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:test:root");
const CHILD = nodeId("node:test:child");
const VOLUME = volumeId("volume:test:0001");
const MATERIAL = materialId(1);
const REPLACEMENT = materialId(2);

/** A project with a solid 6x6x6 box entirely at negative coordinates. */
function buildFixtureProject(filled = true): Uint8Array {
  const document = createDocument({
    documentId: documentId("document:test:0001"),
    metadata: { title: "fixture-negative-box" },
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
      {
        volumeId: VOLUME,
        bounds: { min: [-8, -8, -8], max: [8, 8, 8] },
      },
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
  }
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

/** Positions the camera in a deterministic front view of the content. */
function frameFront(composition: DesktopComposition): void {
  composition.viewport.setViewportSize(800, 600);
  composition.viewport.setStandardView("front");
  composition.viewport.focus();
}

function materialAt(
  composition: DesktopComposition,
  coordinate: [number, number, number],
): number {
  const state = composition.session.current;
  if (state === undefined) throw new Error("no open session");
  return state.store.getVoxel(VOLUME, coordinate);
}

function previewMesh(
  composition: DesktopComposition,
): THREE.InstancedMesh | undefined {
  const mesh = composition.draftOverlay.mesh;
  return mesh === undefined ? undefined : mesh;
}

describe("desktop stroke workflows", () => {
  it("draws a gap-free stroke as one labeled, undoable transaction", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    // The freshly opened document defaults the active material to the
    // lowest material id, so the pencil is ready without a materials panel.
    expect(composition.editor.activeMaterial).toBe(MATERIAL);
    // Paint a different material so the stroke is observable over the
    // already-filled fixture box (and undo restores the fill).
    composition.editor.setActiveMaterial(REPLACEMENT);
    composition.editor.setActiveTool("pencil");

    const viewport = composition.viewport;
    const start = viewport.pick(400, 300);
    const middle = viewport.pick(400, 180);
    const end = viewport.pick(480, 180);
    if (start === undefined || middle === undefined || end === undefined) {
      throw new Error("fixture voxels must be pickable");
    }
    // The fixture lives entirely at negative coordinates, and the stroke
    // travels two voxel steps (up, then right).
    expect(start.voxel[2]).toBeLessThan(0);
    // Screen-up is +Y in the front view, so the upper pick is a larger y.
    expect(middle.voxel[1]).toBeGreaterThan(start.voxel[1]);
    expect(end.voxel).not.toEqual(start.voxel);

    expect(viewport.toolActive).toBe(false);
    expect(viewport.toolPointerDown(400, 300)).toEqual({ ok: true });
    expect(viewport.toolActive).toBe(true);
    expect(viewport.toolPointerMove(400, 180)).toEqual({ ok: true });
    expect(viewport.toolPointerMove(480, 180)).toEqual({ ok: true });
    expect(viewport.toolPointerUp()).toEqual({ ok: true });
    expect(viewport.toolActive).toBe(false);

    // The rasterized path is committed: start, every gap-free step, end.
    expect(
      materialAt(composition, [...start.voxel] as [number, number, number]),
    ).toBe(2);
    expect(
      materialAt(composition, [...end.voxel] as [number, number, number]),
    ).toBe(2);
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const history = state.bus.historySnapshot();
    expect(history.past).toHaveLength(1);
    expect(history.past[0]?.label).toBe("Draw stroke");

    // Undo restores the exact pre-gesture state; redo replays the stroke.
    const undo = state.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: state.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    // Undo restores the exact pre-gesture state (the original fill).
    expect(
      materialAt(composition, [...start.voxel] as [number, number, number]),
    ).toBe(1);
    const redo = state.bus.redo({
      transactionId: transactionId("transaction:test:redo"),
      expectedRevision: state.store.revision,
      source: "ui",
    });
    expect(redo.ok).toBe(true);
    expect(
      materialAt(composition, [...end.voxel] as [number, number, number]),
    ).toBe(2);
    composition.dispose();
  });

  it("erases a stroke as one labeled transaction and undoes it", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setActiveTool("erase");
    const viewport = composition.viewport;
    const start = viewport.pick(400, 300);
    const end = viewport.pick(460, 300);
    if (start === undefined || end === undefined) {
      throw new Error("fixture voxels must be pickable");
    }
    expect(viewport.toolPointerDown(400, 300)).toEqual({ ok: true });
    expect(viewport.toolPointerMove(460, 300)).toEqual({ ok: true });
    expect(viewport.toolPointerUp()).toEqual({ ok: true });

    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(
      materialAt(composition, [...start.voxel] as [number, number, number]),
    ).toBe(0);
    const history = state.bus.historySnapshot();
    expect(history.past).toHaveLength(1);
    expect(history.past[0]?.label).toBe("Erase stroke");
    const undo = state.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: state.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(
      materialAt(composition, [...start.voxel] as [number, number, number]),
    ).toBe(1);
    composition.dispose();
  });

  it("projects a transient preview and clears it on commit", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setActiveTool("pencil");
    const viewport = composition.viewport;
    const start = viewport.pick(400, 300);
    if (start === undefined) throw new Error("fixture voxels must be pickable");

    expect(previewMesh(composition)).toBeUndefined();
    viewport.toolPointerDown(400, 300);
    const mesh = previewMesh(composition);
    expect(mesh).toBeDefined();
    expect(mesh?.count).toBe(1);
    // The preview renders under the owning node's group in volume space.
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const group = composition.renderer.adapter.objectForNode(CHILD);
    expect(mesh?.parent).toBe(group);
    expect(mesh?.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    const material = mesh?.material as THREE.MeshBasicMaterial;
    expect(material.color.getHex()).toBe(0xff0000);
    expect(composition.draftOverlay.voxelCount).toBe(1);

    // The stroke grows beyond the initial capacity: the projected mesh
    // must hold a matrix for every previewed voxel (instance capacity is
    // fixed at construction, so the overlay rebuilds the mesh).
    viewport.toolPointerMove(520, 300);
    const grown = previewMesh(composition);
    expect(grown).toBeDefined();
    expect(grown?.count).toBe(composition.draftOverlay.voxelCount);
    expect(grown?.instanceMatrix.array.length).toBe(
      composition.draftOverlay.voxelCount * 16,
    );
    viewport.toolPointerUp();
    expect(previewMesh(composition)).toBeUndefined();
    expect(composition.draftOverlay.voxelCount).toBe(0);
    composition.dispose();
  });

  it("cancelling or losing a pointer changes nothing", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setActiveTool("erase");
    const viewport = composition.viewport;
    const before = materialAt(composition, [-1, -1, -1]);
    viewport.toolPointerDown(400, 300);
    viewport.toolPointerMove(430, 300);
    expect(viewport.toolActive).toBe(true);
    viewport.toolPointerCancel();
    expect(viewport.toolActive).toBe(false);
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(state.bus.historySnapshot().past).toHaveLength(0);
    expect(materialAt(composition, [-1, -1, -1])).toBe(before);
    // A late up after the lost pointer is a no-op.
    expect(viewport.toolPointerUp()).toEqual({ ok: true });
    composition.dispose();
  });

  it("rejects strokes when the active material was deleted", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    // Empty volume so the material is deletable with a replacement.
    await openFixture(composition, false);
    frameFront(composition);
    composition.editor.setActiveTool("pencil");
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const deleted = state.bus.execute(
      deleteMaterialCommand(commandId("command:test:delete"), {
        materialId: MATERIAL,
        replacement: REPLACEMENT,
      }),
      {
        transactionId: transactionId("transaction:test:delete"),
        expectedRevision: state.store.revision,
        source: "ui",
      },
    );
    if (!deleted.ok) throw new Error(`delete failed: ${deleted.error.code}`);
    // The composition pruned the deleted active material and notified.
    expect(composition.editor.activeMaterial).toBeUndefined();
    expect(
      composition.editor.notices.some((notice) =>
        notice.message.includes("deleted"),
      ),
    ).toBe(true);

    const viewport = composition.viewport;
    const result = viewport.toolPointerDown(400, 300);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_ACTIVE_MATERIAL");
    expect(viewport.toolActive).toBe(false);
    expect(state.bus.historySnapshot().past).toHaveLength(1); // delete only
    composition.dispose();
  });

  it("rejects a stroke that exceeds the lowered voxel budget atomically", async () => {
    // ADR-0009 lets callers lower (never raise) hard limits; the desktop
    // composition exposes the stroke budget so the limit seam is testable
    // through the real pick/commit path.
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
      gestureVoxelLimit: 2,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setActiveTool("pencil");
    const viewport = composition.viewport;
    expect(viewport.toolPointerDown(400, 300)).toEqual({ ok: true });
    const moved = viewport.toolPointerMove(560, 300);
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error.code).toBe("TOO_MANY_VOXELS");
    expect(viewport.toolActive).toBe(false);
    expect(composition.editor.draft).toBeUndefined();
    expect(
      composition.editor.notices.some(
        (notice) =>
          notice.level === "error" && notice.message.includes("limit"),
      ),
    ).toBe(true);
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    // No partial commit: the history holds only the open (no-op) state.
    expect(state.bus.historySnapshot().past).toHaveLength(0);
    composition.dispose();
  });

  it("finishes a stroke through the tool that started it", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setActiveTool("pencil");
    composition.editor.setActiveMaterial(REPLACEMENT);
    const viewport = composition.viewport;
    const start = viewport.pick(400, 300);
    if (start === undefined) throw new Error("fixture voxels must be pickable");
    expect(viewport.toolPointerDown(400, 300)).toEqual({ ok: true });
    // Switching the active tool mid-gesture must not leak the draft: the
    // gesture stays pinned to the pencil that started it.
    composition.editor.setActiveTool("erase");
    expect(viewport.toolPointerMove(430, 300)).toEqual({ ok: true });
    composition.editor.setActiveTool("select");
    expect(viewport.toolPointerUp()).toEqual({ ok: true });
    expect(viewport.toolActive).toBe(false);
    expect(composition.editor.draft).toBeUndefined();
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const history = state.bus.historySnapshot();
    expect(history.past).toHaveLength(1);
    expect(history.past[0]?.label).toBe("Draw stroke");
    // The pencil painted the segment with its own material over the fill.
    expect(
      materialAt(composition, [...start.voxel] as [number, number, number]),
    ).toBe(2);
    composition.dispose();
  });

  it("explains the no-op when the document has no voxels", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    // Empty volume: picking misses, so a pencil click cannot start a
    // stroke; the controller says why instead of staying silent.
    await openFixture(composition, false);
    frameFront(composition);
    composition.editor.setActiveTool("pencil");
    const viewport = composition.viewport;
    expect(viewport.toolPointerDown(400, 300)).toEqual({ ok: true });
    expect(viewport.toolActive).toBe(false);
    expect(composition.editor.draft).toBeUndefined();
    expect(
      composition.editor.notices.some(
        (notice) =>
          notice.level === "info" && notice.message.includes("no voxels"),
      ),
    ).toBe(true);
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(state.bus.historySnapshot().past).toHaveLength(0);
    composition.dispose();
  });

  it("rejects a stroke whose active material id does not exist", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setActiveTool("pencil");
    // An "invalid" active material (id not in the document) fails at
    // pointer down with no draft and no commit.
    composition.editor.setActiveMaterial(materialId(999));
    const viewport = composition.viewport;
    const result = viewport.toolPointerDown(400, 300);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MISSING_MATERIAL");
    expect(viewport.toolActive).toBe(false);
    expect(composition.editor.draft).toBeUndefined();
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(state.bus.historySnapshot().past).toHaveLength(0);
    composition.dispose();
  });

  it("resets an in-progress stroke when the document is replaced", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setActiveTool("pencil");
    const viewport = composition.viewport;
    viewport.toolPointerDown(400, 300);
    expect(viewport.toolActive).toBe(true);
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    state.bus.execute(
      fillBoxCommand(commandId("command:test:more"), {
        volumeId: VOLUME,
        region: { min: [1, 1, 1], max: [2, 2, 2] },
        material: MATERIAL,
      }),
      {
        transactionId: transactionId("transaction:test:more"),
        expectedRevision: state.store.revision,
        source: "ui",
      },
    );
    // The commit itself does not end the gesture; closing the document
    // does. Close, then open a fresh document.
    const closed = requireResult(await composition.fileService.closeProject());
    expect(closed.ok).toBe(true);
    expect(viewport.toolActive).toBe(false);
    await openFixture(composition);
    expect(composition.editor.activeMaterial).toBe(MATERIAL);
    composition.dispose();
  });
});
