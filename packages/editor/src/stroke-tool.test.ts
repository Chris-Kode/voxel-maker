import { describe, expect, it } from "vitest";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  type CommandId,
  type WorkspaceError,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  CommandBus,
  CommandRegistry,
  deleteMaterialCommand,
  registerBatchCommands,
  registerMaterialCommands,
  registerVoxelCommands,
  setBatchCommand,
} from "@voxel-maker/commands";
import {
  createDocumentStore,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import { createEditorStore, createStrokeTool } from "./index.js";
import type { StrokeTool } from "./stroke-tool.js";
import type { StrokeToolHost, ToolPick } from "./types.js";

/**
 * Stroke tool tests (plan S7.3/S7.5, ticket #17): the headless gesture
 * lifecycle — rasterize without gaps, transient preview, one labeled
 * transaction per stroke, exact cancel/lost-pointer restoration, negative
 * coordinates, atomic limit failures, and deleted/invalid active
 * materials. The host wires a real command bus and a stub picker so every
 * assertion runs through the authoritative store.
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
const VOLUME_B = volumeId("volume:test:0002");
const MATERIAL = materialId(1);

/** A document with one voxel node; materials 1 and 2 exist. */
function buildDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:test:0001"),
    metadata: { title: "stroke-fixture" },
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
        materialId: materialId(2),
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
}

interface Harness {
  readonly store: DocumentStoreRead;
  readonly bus: CommandBus;
  readonly editor: ReturnType<typeof createEditorStore>;
  pencil: StrokeTool;
  erase: StrokeTool;
  /** Stub picker; tests replace this to control pointer->voxel mapping. */
  pick: (clientX: number, clientY: number) => ToolPick | undefined;
  nextCommandId(): CommandId;
  /** Committed voxels of a volume, keyed "x,y,z" -> material. */
  voxels(volumeId: string): Map<string, number>;
  /** Fills a set of voxels through the real command path. */
  prefill(coordinates: readonly (readonly [number, number, number])[]): void;
}

function createHarness(options?: { maxStrokeVoxels?: number }): Harness {
  const document = buildDocument();
  const { store, writeCapability } = createDocumentStore({ document });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  registerMaterialCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);
  const editor = createEditorStore();
  editor.setActiveMaterial(MATERIAL);
  let commandSequence = 0;
  const harness: Harness = {
    store,
    bus,
    editor,
    pencil: undefined as unknown as StrokeTool,
    erase: undefined as unknown as StrokeTool,
    pick: () => undefined,
    nextCommandId() {
      commandSequence += 1;
      return commandId(`command:stroke:${String(commandSequence)}`);
    },
    voxels(volumeId) {
      const readView = store.getVolume(volumeId as never);
      const result = new Map<string, number>();
      if (readView === undefined) return result;
      for (const chunk of readView.chunkCoordinates()) {
        const values = readView.getChunk(chunk);
        if (values === undefined) continue;
        const baseX = chunk[0] * 16;
        const baseY = chunk[1] * 16;
        const baseZ = chunk[2] * 16;
        for (let index = 0; index < values.length; index += 1) {
          const material = values[index];
          if (material === undefined || material === 0) continue;
          const x = baseX + (index % 16);
          const y = baseY + (Math.floor(index / 16) % 16);
          const z = baseZ + Math.floor(index / 256);
          result.set(`${String(x)},${String(y)},${String(z)}`, material);
        }
      }
      return result;
    },
    prefill(coordinates) {
      const result = bus.executeTransaction(
        [
          setBatchCommand(commandId("command:test:prefill"), {
            volumeId: VOLUME,
            entries: coordinates.map((coordinate) => ({
              coordinate,
              material: MATERIAL,
            })),
          }),
        ],
        {
          transactionId: transactionId("transaction:test:prefill"),
          expectedRevision: store.revision,
          source: "system",
        },
      );
      if (!result.ok) throw new Error(`prefill failed: ${result.error.code}`);
    },
  };
  const host: StrokeToolHost = {
    get store() {
      return harness.store;
    },
    maxStrokeVoxels: options?.maxStrokeVoxels ?? 1_000_000,
    pick(clientX, clientY) {
      return harness.pick(clientX, clientY);
    },
    nextCommandId() {
      return harness.nextCommandId();
    },
    commit(commands, label) {
      const result = harness.bus.executeTransaction(commands, {
        transactionId: transactionId(
          `transaction:stroke:${String(harness.bus.historySnapshot().past.length + 1)}`,
        ),
        expectedRevision: harness.store.revision,
        source: "ui",
        label,
      });
      return result.ok ? undefined : result.error;
    },
  };
  harness.pencil = createStrokeTool({ kind: "pencil", host, editor });
  harness.erase = createStrokeTool({ kind: "erase", host, editor });
  return harness;
}

/** Pointer -> voxel stub: x maps to x, y to y, z to 0, on the first volume. */
function planePicker(
  volumeId = VOLUME,
): (clientX: number, clientY: number) => ToolPick {
  return (clientX, clientY) => ({
    volumeId,
    voxel: [clientX, clientY, 0],
  });
}

function expectVoxel(
  harness: Harness,
  coordinate: [number, number, number],
  material: number,
): void {
  expect(harness.voxels(VOLUME).get(coordinate.join(","))).toBe(material);
}

function errorCode(result: {
  ok: boolean;
  error?: WorkspaceError;
}): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

describe("pencil stroke tool", () => {
  it("commits one labeled, undoable transaction per stroke", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    const down = harness.pencil.pointerDown(0, 0);
    expect(down).toEqual({ ok: true });
    expect(harness.pencil.active).toBe(true);
    expect(harness.editor.draft?.voxels).toEqual([[0, 0, 0]]);
    expect(harness.pencil.pointerMove(3, 0)).toEqual({ ok: true });
    expect(harness.pencil.pointerMove(3, 2)).toEqual({ ok: true });
    const up = harness.pencil.pointerUp();
    expect(up).toEqual({ ok: true });
    expect(harness.pencil.active).toBe(false);
    expect(harness.editor.draft).toBeUndefined();
    // Rasterized path: (0,0,0)..(3,0,0) then (3,0,0)..(3,2,0), no gaps.
    for (const x of [0, 1, 2, 3]) expectVoxel(harness, [x, 0, 0], 1);
    for (const y of [1, 2]) expectVoxel(harness, [3, y, 0], 1);
    expect(harness.voxels(VOLUME).size).toBe(6);

    // One history entry with the stroke label; undo restores the exact
    // pre-gesture state and redo replays the whole stroke.
    const history = harness.bus.historySnapshot();
    expect(history.past).toHaveLength(1);
    expect(history.past[0]?.label).toBe("Draw stroke");
    const undo = harness.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(harness.voxels(VOLUME).size).toBe(0);
    const redo = harness.bus.redo({
      transactionId: transactionId("transaction:test:redo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    expect(redo.ok).toBe(true);
    expect(harness.voxels(VOLUME).size).toBe(6);
  });

  it("rasterizes without gaps between fast pointer moves", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.pencil.pointerDown(0, 0);
    // One big jump: the whole segment must be filled.
    harness.pencil.pointerMove(5, 4);
    harness.pencil.pointerUp();
    const voxels = harness.voxels(VOLUME);
    for (let index = 0; index <= 5; index += 1) {
      expect(
        voxels.get(`${String(index)},${String(Math.round((index * 4) / 5))},0`),
      ).toBe(1);
    }
    expect(voxels.size).toBe(6);
  });

  it("paints one voxel for a click without movement", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.pencil.pointerDown(2, -1);
    harness.pencil.pointerUp();
    expect(harness.voxels(VOLUME).get("2,-1,0")).toBe(1);
    expect(harness.voxels(VOLUME).size).toBe(1);
  });

  it("keeps the preview transient and clears it on commit", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.pencil.pointerDown(0, 0);
    harness.pencil.pointerMove(2, 0);
    expect(harness.editor.draft).toEqual({
      volumeId: VOLUME,
      voxels: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
      material: MATERIAL,
    });
    harness.pencil.pointerUp();
    expect(harness.editor.draft).toBeUndefined();
  });

  it("cancelling restores the exact pre-gesture semantic state", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.pencil.pointerDown(0, 0);
    harness.pencil.pointerMove(4, 0);
    expect(harness.editor.draft).toBeDefined();
    harness.pencil.pointerCancel();
    expect(harness.pencil.active).toBe(false);
    expect(harness.editor.draft).toBeUndefined();
    expect(harness.voxels(VOLUME).size).toBe(0);
    expect(harness.bus.historySnapshot().past).toHaveLength(0);
    // A lost pointer followed by a late up is a no-op.
    expect(harness.pencil.pointerUp()).toEqual({ ok: true });
  });

  it("ignores pointer moves without a prior down", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    expect(harness.pencil.pointerMove(1, 1)).toEqual({ ok: true });
    expect(harness.pencil.pointerUp()).toEqual({ ok: true });
    expect(harness.voxels(VOLUME).size).toBe(0);
  });

  it("starts nothing when the pointer misses all voxels", () => {
    const harness = createHarness();
    harness.pick = () => undefined;
    expect(harness.pencil.pointerDown(0, 0)).toEqual({ ok: true });
    expect(harness.pencil.active).toBe(false);
    expect(harness.editor.draft).toBeUndefined();
    harness.pencil.pointerUp();
    expect(harness.voxels(VOLUME).size).toBe(0);
  });

  it("works under negative coordinates", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.pencil.pointerDown(-4, -3);
    harness.pencil.pointerMove(-1, -6);
    harness.pencil.pointerUp();
    const voxels = harness.voxels(VOLUME);
    expect(voxels.get("-4,-3,0")).toBe(1);
    expect(voxels.get("-1,-6,0")).toBe(1);
    // Every rasterized voxel is within the segment's bounds.
    for (const key of voxels.keys()) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      expect(x).toBeGreaterThanOrEqual(-4);
      expect(x).toBeLessThanOrEqual(-1);
      expect(y).toBeGreaterThanOrEqual(-6);
      expect(y).toBeLessThanOrEqual(-3);
    }
    expect(voxels.size).toBeGreaterThan(2);
  });

  it("stays on the volume the stroke started on", () => {
    const harness = createHarness();
    harness.pick = (clientX, clientY) =>
      clientX > 10
        ? { volumeId: VOLUME_B, voxel: [clientX, clientY, 0] }
        : { volumeId: VOLUME, voxel: [clientX, clientY, 0] };
    harness.pencil.pointerDown(0, 0);
    // A pick over the other volume is ignored...
    harness.pencil.pointerMove(12, 0);
    expect(harness.editor.draft?.voxels).toEqual([[0, 0, 0]]);
    // ...and the stroke resumes from its last voxel on the pinned volume.
    harness.pencil.pointerMove(2, 0);
    expect(harness.editor.draft?.voxels).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    harness.pencil.pointerUp();
    expect(harness.voxels(VOLUME_B).size).toBe(0);
  });

  it("rejects a stroke that exceeds the voxel budget atomically", () => {
    const harness = createHarness({ maxStrokeVoxels: 5 });
    harness.pick = planePicker();
    harness.pencil.pointerDown(0, 0);
    const result = harness.pencil.pointerMove(10, 0);
    expect(errorCode(result)).toBe("TOO_MANY_VOXELS");
    expect(harness.pencil.active).toBe(false);
    expect(harness.editor.draft).toBeUndefined();
    expect(harness.voxels(VOLUME).size).toBe(0);
  });

  it("rejects a stroke without an active material", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.editor.setActiveMaterial(undefined);
    expect(errorCode(harness.pencil.pointerDown(0, 0))).toBe(
      "NO_ACTIVE_MATERIAL",
    );
    expect(harness.pencil.active).toBe(false);
    expect(harness.editor.draft).toBeUndefined();
  });

  it("rejects a stroke whose active material does not exist", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.editor.setActiveMaterial(materialId(7));
    expect(errorCode(harness.pencil.pointerDown(0, 0))).toBe(
      "MISSING_MATERIAL",
    );
    expect(harness.pencil.active).toBe(false);
  });

  it("fails atomically when the material is deleted mid-stroke", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.pencil.pointerDown(0, 0);
    harness.pencil.pointerMove(3, 0);
    const deleted = harness.bus.execute(
      deleteMaterialCommand(commandId("command:test:delete"), {
        materialId: MATERIAL,
      }),
      {
        transactionId: transactionId("transaction:test:delete"),
        expectedRevision: harness.store.revision,
        source: "ui",
      },
    );
    if (!deleted.ok) throw new Error(`delete failed: ${deleted.error.code}`);
    const up = harness.pencil.pointerUp();
    expect(errorCode(up)).toBe("MISSING_MATERIAL");
    expect(harness.pencil.active).toBe(false);
    expect(harness.editor.draft).toBeUndefined();
    // The stroke committed nothing: no partial voxels survive.
    expect(harness.voxels(VOLUME).size).toBe(0);
  });

  it("rejects a stroke when no document is open", () => {
    const harness = createHarness();
    const closed = createStrokeTool({
      kind: "pencil",
      host: {
        store: undefined,
        maxStrokeVoxels: 1_000_000,
        pick: () => ({ volumeId: VOLUME, voxel: [0, 0, 0] }),
        nextCommandId: () => commandId("command:stroke:closed"),
        commit: () => undefined,
      },
      editor: harness.editor,
    });
    expect(errorCode(closed.pointerDown(0, 0))).toBe("SESSION_NOT_OPEN");
    expect(closed.active).toBe(false);
  });

  it("resets an in-progress stroke on lifecycle replacement", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.pencil.pointerDown(0, 0);
    harness.pencil.pointerMove(2, 0);
    harness.pencil.reset();
    expect(harness.pencil.active).toBe(false);
    expect(harness.editor.draft).toBeUndefined();
    expect(harness.voxels(VOLUME).size).toBe(0);
  });
});

describe("erase stroke tool", () => {
  it("removes exactly the rasterized voxels as one labeled transaction", () => {
    const harness = createHarness();
    harness.prefill([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
    ]);
    harness.pick = planePicker();
    harness.erase.pointerDown(0, 0);
    harness.erase.pointerMove(3, 0);
    expect(harness.editor.draft?.material).toBeUndefined();
    const up = harness.erase.pointerUp();
    expect(up).toEqual({ ok: true });
    // The whole segment was erased in one transaction.
    for (const x of [0, 1, 2, 3]) {
      expect(harness.voxels(VOLUME).get(`${String(x)},0,0`)).toBeUndefined();
    }
    // Voxels outside the stroke remain untouched.
    expect(harness.voxels(VOLUME).get("0,1,0")).toBe(1);
    expect(harness.voxels(VOLUME).get("0,2,0")).toBe(1);
    const history = harness.bus.historySnapshot();
    expect(history.past).toHaveLength(2); // prefill + erase
    expect(history.past[1]?.label).toBe("Erase stroke");

    // Undo restores the erased voxels; redo removes them again.
    const undo = harness.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(harness.voxels(VOLUME).get("2,0,0")).toBe(1);
    const redo = harness.bus.redo({
      transactionId: transactionId("transaction:test:redo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    expect(redo.ok).toBe(true);
    expect(harness.voxels(VOLUME).get("2,0,0")).toBeUndefined();
  });

  it("erases under negative coordinates and deduplicates overlap", () => {
    const harness = createHarness();
    harness.prefill([
      [-2, -2, 0],
      [-1, -2, 0],
      [-2, -1, 0],
      [-1, -1, 0],
    ]);
    harness.pick = planePicker();
    harness.erase.pointerDown(-2, -2);
    harness.erase.pointerMove(-1, -1);
    // Retrace part of the segment: duplicates must be deduplicated in the
    // draft so the command stays minimal.
    harness.erase.pointerMove(-2, -2);
    expect(harness.editor.draft?.voxels).toEqual([
      [-2, -2, 0],
      [-1, -1, 0],
    ]);
    harness.erase.pointerUp();
    // The diagonal is gone; the off-diagonal voxels were never in the
    // stroke and remain untouched.
    expect(harness.voxels(VOLUME).get("-2,-2,0")).toBeUndefined();
    expect(harness.voxels(VOLUME).get("-1,-1,0")).toBeUndefined();
    expect(harness.voxels(VOLUME).get("-1,-2,0")).toBe(1);
    expect(harness.voxels(VOLUME).get("-2,-1,0")).toBe(1);
    const history = harness.bus.historySnapshot();
    expect(history.past).toHaveLength(2);
    expect(history.past[1]?.label).toBe("Erase stroke");
  });

  it("cancelling an erase stroke changes nothing", () => {
    const harness = createHarness();
    harness.prefill([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    harness.pick = planePicker();
    harness.erase.pointerDown(0, 0);
    harness.erase.pointerMove(1, 0);
    harness.erase.pointerCancel();
    expect(harness.voxels(VOLUME).size).toBe(2);
    expect(harness.bus.historySnapshot().past).toHaveLength(1); // prefill only
  });

  it("ignores erasing empty space", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.erase.pointerDown(0, 0);
    harness.erase.pointerUp();
    expect(harness.voxels(VOLUME).size).toBe(0);
  });
});
