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
  deleteRegionCommand,
  fillBoxCommand,
  registerBatchCommands,
  registerRegionCommands,
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
 * Desktop transform-tool integration tests (plan S7.19, ticket #19): the
 * full composition seam — move/copy drags, rotate/mirror/delete
 * preview-and-apply flows, negative coordinates, exact collision
 * counts, one labeled undoable transaction per operation, Escape
 * cancellation with zero side effects, atomic preview failures, and
 * proof that transform runtime state never reaches the saved bytes.
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
 * A project with two 6x6x6 boxes: box A spans [-6, 0)^3 (filled), box B
 * spans [2, 8) x [-6, 0)^2 (empty unless filled).
 */
function buildFixtureProject(filledB = false): Uint8Array {
  const document = createDocument({
    documentId: documentId("document:test:0001"),
    metadata: { title: "fixture-transform" },
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
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  registerRegionCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);
  const fill = (
    volumeIdValue: string,
    region: { min: [number, number, number]; max: [number, number, number] },
  ) => {
    const result = bus.execute(
      fillBoxCommand(commandId(`command:test:fill:${volumeIdValue}`), {
        volumeId: volumeIdValue as never,
        region,
        material: MATERIAL as never,
      }),
      {
        transactionId: transactionId(`transaction:test:fill:${volumeIdValue}`),
        expectedRevision: store.revision,
        source: "system",
      },
    );
    if (!result.ok)
      throw new Error(`fixture fill failed: ${result.error.code}`);
  };
  fill(VOLUME, { min: [-6, -6, -6], max: [0, 0, 0] });
  if (filledB) {
    fill(VOLUME_B, { min: [2, -6, -6], max: [8, 0, 0] });
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
  filledB = false,
): Promise<void> {
  const result = requireResult(
    await composition.fileService.openLoadedProject(
      "fixture.vxl",
      buildFixtureProject(filledB),
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

/** Labeled past-history entries of the bus (fixture setups stay unlabeled). */
function labels(composition: DesktopComposition): readonly string[] {
  const state = composition.session.current;
  if (state === undefined) return [];
  return state.bus
    .historySnapshot()
    .past.filter((entry) => entry.label !== undefined)
    .map((entry) => entry.label as string);
}

describe("desktop transform move", () => {
  it("moves the selected node geometry as one labeled, undoable transaction", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    // Select box A (the filled box at negative coordinates).
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) throw new Error("box A must be pickable");
    composition.viewport.selectAt(start.x, start.y);
    expect(composition.editor.selection).toEqual([
      { kind: "node", nodeId: CHILD },
    ]);
    // Drag to a voxel strictly to the +x of the anchor so the moved box
    // never re-covers its own old corner.
    const end = scanPick(
      composition,
      (hit) => hit.nodeId === CHILD && hit.voxel[0] > start.hit.voxel[0],
    );
    if (end === undefined) {
      throw new Error("box A must offer two pickable drag corners");
    }
    composition.editor.setActiveTool("transform");
    composition.editor.setTransformMode("move");
    const viewport = composition.viewport;
    expect(viewport.toolPointerDown(start.x, start.y)).toEqual({ ok: true });
    expect(viewport.toolActive).toBe(true);
    expect(composition.editor.transformPreview).toBeDefined();
    viewport.toolPointerMove(end.x, end.y);
    viewport.toolPointerUp();
    expect(composition.editor.transformPreview).toBeUndefined();
    expect(labels(composition)).toEqual(["Move selection"]);
    const delta: [number, number, number] = [
      end.hit.voxel[0] - start.hit.voxel[0],
      end.hit.voxel[1] - start.hit.voxel[1],
      end.hit.voxel[2] - start.hit.voxel[2],
    ];
    // The anchor voxel moved to the drag-end voxel.
    expect(
      materialAt(composition, VOLUME, [
        end.hit.voxel[0],
        end.hit.voxel[1],
        end.hit.voxel[2],
      ]),
    ).toBe(MATERIAL);
    // A corner of box A moved by the same delta (negative coordinates).
    const corner: [number, number, number] = [
      -6 + delta[0],
      -6 + delta[1],
      -6 + delta[2],
    ];
    expect(materialAt(composition, VOLUME, corner)).toBe(MATERIAL);
    expect(materialAt(composition, VOLUME, [-6, -6, -6])).toBe(0);
    // One history entry; undo restores and redo re-applies.
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(state.bus.historySnapshot().past).toHaveLength(1);
    const undo = state.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: state.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(materialAt(composition, VOLUME, [-6, -6, -6])).toBe(MATERIAL);
    const redo = state.bus.redo({
      transactionId: transactionId("transaction:test:redo"),
      expectedRevision: state.store.revision,
      source: "ui",
    });
    expect(redo.ok).toBe(true);
    expect(materialAt(composition, VOLUME, corner)).toBe(MATERIAL);
    composition.dispose();
  });

  it("previews exact overwrite counts when the destination overlaps content", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    // Select the left half of box A: x in [-6, -3).
    const leftHalf = {
      min: [-6, -6, -6] as [number, number, number],
      max: [-3, 0, 0] as [number, number, number],
    };
    composition.editor.setSelection([
      { kind: "region", volumeId: VOLUME, region: leftHalf },
    ]);
    // Drag by a small positive x delta so the destination region stays
    // inside the filled box (overlapping the right half's content).
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) throw new Error("box A must be pickable");
    const end = scanPick(
      composition,
      (hit) =>
        hit.nodeId === CHILD &&
        hit.voxel[0] > start.hit.voxel[0] &&
        hit.voxel[0] <= start.hit.voxel[0] + 5,
    );
    if (end === undefined) {
      throw new Error("box A must offer a small-x drag corner");
    }
    composition.editor.setActiveTool("transform");
    composition.editor.setTransformMode("move");
    const viewport = composition.viewport;
    viewport.toolPointerDown(start.x, start.y);
    viewport.toolPointerMove(end.x, end.y);
    const preview = composition.editor.transformPreview;
    if (preview === undefined || preview.operation !== "move") {
      throw new Error("move preview missing");
    }
    const dx = end.hit.voxel[0] - start.hit.voxel[0];
    const dy = end.hit.voxel[1] - start.hit.voxel[1];
    const dz = end.hit.voxel[2] - start.hit.voxel[2];
    // Exact expectation: occupied box-A voxels inside the destination
    // region that are not part of the moved source region.
    let expectedOverwritten = 0;
    for (let x = -6; x < 0; x += 1) {
      for (let y = -6; y < 0; y += 1) {
        for (let z = -6; z < 0; z += 1) {
          const insideDest =
            x >= -6 + dx &&
            x < -3 + dx &&
            y >= -6 + dy &&
            y < 0 + dy &&
            z >= -6 + dz &&
            z < 0 + dz;
          const insideSource = x >= -6 && x < -3;
          if (insideDest && !insideSource) expectedOverwritten += 1;
        }
      }
    }
    expect(preview.overwrittenVoxels).toBe(expectedOverwritten);
    expect(preview.movedVoxels).toBe(108);
    viewport.toolPointerUp();
    expect(labels(composition)).toEqual(["Move selection"]);
    composition.dispose();
  });
});

describe("desktop transform copy", () => {
  it("copies the selection into box B's empty volume area in one transaction", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition, true);
    frameFront(composition);
    const start = scanPick(composition, (hit) => hit.nodeId === CHILD);
    if (start === undefined) throw new Error("box A must be pickable");
    composition.viewport.selectAt(start.x, start.y);
    const end = scanPick(composition, (hit) => hit.nodeId === CHILD_B);
    if (end === undefined) throw new Error("box B must be pickable");
    composition.editor.setActiveTool("transform");
    composition.editor.setTransformMode("copy");
    const viewport = composition.viewport;
    viewport.toolPointerDown(start.x, start.y);
    viewport.toolPointerMove(end.x, end.y);
    viewport.toolPointerUp();
    expect(labels(composition)).toEqual(["Copy selection"]);
    // Source stays and the copy lands at the anchor + delta.
    expect(materialAt(composition, VOLUME, [-6, -6, -6])).toBe(MATERIAL);
    const delta: [number, number, number] = [
      end.hit.voxel[0] - start.hit.voxel[0],
      end.hit.voxel[1] - start.hit.voxel[1],
      end.hit.voxel[2] - start.hit.voxel[2],
    ];
    const copied: [number, number, number] = [
      -6 + delta[0],
      -6 + delta[1],
      -6 + delta[2],
    ];
    expect(materialAt(composition, VOLUME, copied)).toBe(MATERIAL);
    composition.dispose();
  });
});

describe("desktop transform rotate", () => {
  it("previews, applies, and undoes a 90-degree rotation around z", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    // Carve a corner hole out of the filled 6x6x6 box so the rotation is
    // observable (a full box is rotation-symmetric).
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const carved = state.bus.execute(
      deleteRegionCommand(commandId("command:test:carve"), {
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [-5, -5, -5] },
      }),
      {
        transactionId: transactionId("transaction:test:carve"),
        expectedRevision: state.store.revision,
        source: "ui",
      },
    );
    expect(carved.ok).toBe(true);
    expect(materialAt(composition, VOLUME, [-6, -6, -6])).toBe(0);
    // The region selection covers the whole box (even extents on every
    // axis, so all rotations are exact).
    composition.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [0, 0, 0] },
      },
    ]);
    composition.editor.setActiveTool("transform");
    composition.editor.setTransformMode("rotate");
    const viewport = composition.viewport;
    expect(viewport.transformPreviewRotate("z")).toEqual({ ok: true });
    expect(viewport.transformApplyPending).toBe(true);
    const preview = composition.editor.transformPreview;
    if (preview === undefined || preview.operation !== "rotate") {
      throw new Error("rotate preview missing");
    }
    expect(preview.axis).toBe("z");
    expect(preview.quarterTurns).toBe(1);
    expect(viewport.transformApply()).toEqual({ ok: true });
    expect(viewport.transformApplyPending).toBe(false);
    expect(labels(composition)).toEqual(["Rotate selection"]);
    // Under the exact z rotation around the center (-3,-3,-3), the
    // corner (-6,-6,-6) maps to (-1,-6,-6): the hole travels with the
    // content and the vacated corner is refilled by (-6,-1,-6).
    expect(materialAt(composition, VOLUME, [-1, -6, -6])).toBe(0);
    expect(materialAt(composition, VOLUME, [-6, -6, -6])).toBe(MATERIAL);
    const undo = state.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: state.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(materialAt(composition, VOLUME, [-6, -6, -6])).toBe(0);
    composition.dispose();
  });

  it("applies 90-degree rotations around every axis and redoes them", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    // Carve a corner hole so each rotation is observable.
    const carved = state.bus.execute(
      deleteRegionCommand(commandId("command:test:carve"), {
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [-5, -5, -5] },
      }),
      {
        transactionId: transactionId("transaction:test:carve"),
        expectedRevision: state.store.revision,
        source: "ui",
      },
    );
    expect(carved.ok).toBe(true);
    composition.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [0, 0, 0] },
      },
    ]);
    composition.editor.setActiveTool("transform");
    composition.editor.setTransformMode("rotate");
    const viewport = composition.viewport;
    // X rotation: the hole at (-6,-6,-6) travels to (-6,-1,-6).
    expect(viewport.transformPreviewRotate("x")).toEqual({ ok: true });
    expect(viewport.transformApply()).toEqual({ ok: true });
    expect(materialAt(composition, VOLUME, [-6, -1, -6])).toBe(0);
    expect(materialAt(composition, VOLUME, [-6, -6, -6])).toBe(MATERIAL);
    // Y rotation: the hole travels to (-6,-1,-1).
    composition.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [0, 0, 0] },
      },
    ]);
    expect(viewport.transformPreviewRotate("y")).toEqual({ ok: true });
    expect(viewport.transformApply()).toEqual({ ok: true });
    expect(materialAt(composition, VOLUME, [-6, -1, -1])).toBe(0);
    // Z rotation: the hole travels to (-6,-6,-1).
    composition.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [0, 0, 0] },
      },
    ]);
    expect(viewport.transformPreviewRotate("z")).toEqual({ ok: true });
    expect(viewport.transformApply()).toEqual({ ok: true });
    expect(materialAt(composition, VOLUME, [-6, -6, -1])).toBe(0);
    expect(labels(composition)).toEqual([
      "Rotate selection",
      "Rotate selection",
      "Rotate selection",
    ]);
    // Undo and redo traverse the three rotations atomically.
    for (let index = 0; index < 3; index += 1) {
      const undo = state.bus.undo({
        transactionId: transactionId(`transaction:test:undo:${String(index)}`),
        expectedRevision: state.store.revision,
        source: "ui",
      });
      expect(undo.ok).toBe(true);
    }
    expect(materialAt(composition, VOLUME, [-6, -6, -6])).toBe(0);
    for (let index = 0; index < 3; index += 1) {
      const redo = state.bus.redo({
        transactionId: transactionId(`transaction:test:redo:${String(index)}`),
        expectedRevision: state.store.revision,
        source: "ui",
      });
      expect(redo.ok).toBe(true);
    }
    expect(materialAt(composition, VOLUME, [-6, -6, -1])).toBe(0);
    composition.dispose();
  });

  it("cancels a pending preview on Escape with zero side effects", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [0, 0, 0] },
      },
    ]);
    composition.editor.setActiveTool("transform");
    composition.editor.setTransformMode("mirror");
    const viewport = composition.viewport;
    expect(viewport.transformPreviewMirror("x")).toEqual({ ok: true });
    expect(viewport.transformApplyPending).toBe(true);
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const revision = state.store.revision;
    const pastLength = state.bus.historySnapshot().past.length;
    // Escape: the controller cancels the pending preview without
    // clearing the selection and without any document side effect.
    viewport.transformCancel();
    expect(viewport.transformApplyPending).toBe(false);
    expect(composition.editor.transformPreview).toBeUndefined();
    expect(composition.editor.selection).toHaveLength(1);
    expect(state.store.revision).toBe(revision);
    expect(state.bus.historySnapshot().past).toHaveLength(pastLength);
    expect(materialAt(composition, VOLUME, [-6, -6, -6])).toBe(MATERIAL);
    composition.dispose();
  });

  it("falls back to the always-exact 180-degree step for parity mismatches", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    // A 1x2x2 region cannot rotate exactly by 90 degrees around z
    // (different parities), but 180 degrees is always exact.
    composition.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [-5, -4, -4] },
      },
    ]);
    composition.editor.setActiveTool("transform");
    composition.editor.setTransformMode("rotate");
    const viewport = composition.viewport;
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const revision = state.store.revision;
    const pastLength = state.bus.historySnapshot().past.length;
    expect(viewport.transformPreviewRotate("z")).toEqual({ ok: true });
    const preview = composition.editor.transformPreview;
    if (preview === undefined || preview.operation !== "rotate") {
      throw new Error("rotate preview missing");
    }
    expect(preview.quarterTurns).toBe(2);
    expect(viewport.transformApply()).toEqual({ ok: true });
    expect(labels(composition)).toEqual(["Rotate selection"]);
    expect(state.store.revision).toBe(revision + 1);
    expect(state.bus.historySnapshot().past).toHaveLength(pastLength + 1);
    composition.dispose();
  });
});

describe("desktop transform mirror", () => {
  it("previews and applies a mirror as one labeled, undoable transaction", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    // Carve a corner hole so the in-place mirror is observable: the hole
    // reflects across the region's x-center plane to (-1,-6,-6).
    const carved = state.bus.execute(
      deleteRegionCommand(commandId("command:test:carve"), {
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [-5, -5, -5] },
      }),
      {
        transactionId: transactionId("transaction:test:carve"),
        expectedRevision: state.store.revision,
        source: "ui",
      },
    );
    expect(carved.ok).toBe(true);
    composition.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [0, 0, 0] },
      },
    ]);
    composition.editor.setActiveTool("transform");
    composition.editor.setTransformMode("mirror");
    const viewport = composition.viewport;
    expect(viewport.transformPreviewMirror("x")).toEqual({ ok: true });
    const preview = composition.editor.transformPreview;
    if (preview === undefined || preview.operation !== "mirror") {
      throw new Error("mirror preview missing");
    }
    expect(preview.axis).toBe("x");
    // Mirroring is in place: the affected bounds are the source region.
    expect(preview.entries[0]?.destination).toEqual({
      min: [-6, -6, -6],
      max: [0, 0, 0],
    });
    expect(viewport.transformApply()).toEqual({ ok: true });
    expect(labels(composition)).toEqual(["Mirror selection"]);
    // x' = -6 + 0 - x - 1 = -7 - x: the hole reflects to (-1,-6,-6) and
    // the vacated corner is refilled by the mirrored neighbor.
    expect(materialAt(composition, VOLUME, [-1, -6, -6])).toBe(0);
    expect(materialAt(composition, VOLUME, [-6, -6, -6])).toBe(MATERIAL);
    const undo = state.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: state.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(materialAt(composition, VOLUME, [-6, -6, -6])).toBe(0);
    composition.dispose();
  });
});

describe("desktop transform delete", () => {
  it("previews and applies a delete as one labeled, undoable transaction", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [0, 0, 0] },
      },
    ]);
    composition.editor.setActiveTool("transform");
    composition.editor.setTransformMode("delete");
    const viewport = composition.viewport;
    expect(viewport.transformPreviewDelete()).toEqual({ ok: true });
    const preview = composition.editor.transformPreview;
    if (preview === undefined || preview.operation !== "delete") {
      throw new Error("delete preview missing");
    }
    expect(preview.removedVoxels).toBe(216);
    expect(viewport.transformApply()).toEqual({ ok: true });
    expect(labels(composition)).toEqual(["Delete selection"]);
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    expect(state.store.getVolume(VOLUME)?.occupiedCount()).toBe(0);
    const undo = state.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: state.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(state.store.getVolume(VOLUME)?.occupiedCount()).toBe(216);
    composition.dispose();
  });
});

describe("desktop transform serialization exclusion", () => {
  it("never persists transform mode or preview state into the saved bytes", async () => {
    const storage = new MemoryProjectStorage();
    const composition = createDesktopComposition({
      storage,
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    frameFront(composition);
    composition.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [-6, -6, -6], max: [0, 0, 0] },
      },
    ]);
    composition.editor.setActiveTool("transform");
    composition.editor.setTransformMode("rotate");
    composition.editor.setTransformPreview({
      operation: "rotate",
      axis: "z",
      quarterTurns: 1,
      entries: [
        {
          volumeId: VOLUME,
          source: { min: [-6, -6, -6], max: [0, 0, 0] },
          destination: { min: [-6, -6, -6], max: [0, 0, 0] },
        },
      ],
      movedVoxels: 216,
      overwrittenVoxels: 0,
      removedVoxels: 0,
    });
    // Save As writes real bytes (a same-path save of an unchanged opened
    // project is the documented unchanged short-circuit and writes nothing).
    const saved = requireResult(await composition.fileService.saveProjectAs());
    expect(saved.ok).toBe(true);
    if (saved.path === undefined) throw new Error("save produced no path");
    const bytes = await storage.readProject(saved.path);
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("transformMode");
    expect(text).not.toContain("transformPreview");
    const fresh = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    const reopened = requireResult(
      await fresh.fileService.openLoadedProject("fixture.vxl", bytes),
    );
    expect(reopened.ok).toBe(true);
    expect(fresh.editor.transformMode).toBe("move");
    expect(fresh.editor.transformPreview).toBeUndefined();
    fresh.dispose();
    composition.dispose();
  });
});
