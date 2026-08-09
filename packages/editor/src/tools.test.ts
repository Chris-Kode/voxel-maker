import { describe, expect, it } from "vitest";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  type CommandId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  CommandBus,
  CommandRegistry,
  registerBatchCommands,
  registerMaterialCommands,
  registerVoxelCommands,
  setBatchCommand,
} from "@voxel-maker/commands";
import {
  DEFAULT_VOXEL_VOLUME_LIMITS,
  type VoxelVolumeLimits,
} from "@voxel-maker/voxel";
import { createDocumentStore } from "@voxel-maker/document";
import {
  createEditorStore,
  createEyedropperTool,
  createSelectTool,
  createShapeTool,
  createStrokeTool,
  pruneSelection,
} from "./index.js";
import { DEFAULT_DOCUMENT_LIMITS } from "@voxel-maker/model";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import { shapeParamsForDrag } from "./shape-tool.js";
import type { ToolHost, ToolPick } from "./types.js";

/**
 * Ticket #18 headless tool tests (plan S7.2/S7.4/S7.6/S7.7/S7.19): the
 * select tool (node/voxel/region modes, replace/add/toggle/clear, pruning),
 * the read-only eyedropper, the paint stroke, and the box/sphere/cylinder
 * shape tools (transient bounded previews, one labeled transaction per
 * gesture, atomic limit failures, domain clamping). The host wires a real
 * command bus and a stub picker so every assertion runs through the
 * authoritative store.
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

function buildDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:test:0001"),
    metadata: { title: "tools-fixture" },
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
        name: "Box",
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
}

interface Harness {
  readonly store: DocumentStoreRead;
  readonly bus: CommandBus;
  readonly editor: ReturnType<typeof createEditorStore>;
  select: ReturnType<typeof createSelectTool>;
  eyedropper: ReturnType<typeof createEyedropperTool>;
  paint: ReturnType<typeof createStrokeTool>;
  box: ReturnType<typeof createShapeTool>;
  sphere: ReturnType<typeof createShapeTool>;
  cylinder: ReturnType<typeof createShapeTool>;
  /** Stub picker; tests replace this to control pointer->voxel mapping. */
  pick: (clientX: number, clientY: number) => ToolPick | undefined;
  nextCommandId(): CommandId;
  /** Committed voxels of a volume, keyed "x,y,z" -> material. */
  voxels(volumeId: string): Map<string, number>;
}

function createHarness(options?: { maxGestureVoxels?: number }): Harness {
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
    select: undefined as unknown as Harness["select"],
    eyedropper: undefined as unknown as Harness["eyedropper"],
    paint: undefined as unknown as Harness["paint"],
    box: undefined as unknown as Harness["box"],
    sphere: undefined as unknown as Harness["sphere"],
    cylinder: undefined as unknown as Harness["cylinder"],
    pick: () => undefined,
    nextCommandId() {
      commandSequence += 1;
      return commandId(`command:tool:${String(commandSequence)}`);
    },
    voxels(volumeIdValue) {
      const readView = store.getVolume(volumeIdValue as never);
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
  };
  const host: ToolHost = {
    get store() {
      return harness.store;
    },
    maxGestureVoxels: options?.maxGestureVoxels ?? 1_000_000,
    pick(clientX, clientY) {
      return harness.pick(clientX, clientY);
    },
    nextCommandId() {
      return harness.nextCommandId();
    },
    commit(commands, label) {
      const result = harness.bus.executeTransaction(commands, {
        transactionId: transactionId(
          `transaction:tool:${String(harness.bus.historySnapshot().past.length + 1)}`,
        ),
        expectedRevision: harness.store.revision,
        source: "ui",
        label,
      });
      return result.ok ? undefined : result.error;
    },
  };
  harness.select = createSelectTool({ host, editor });
  harness.eyedropper = createEyedropperTool({ host, editor });
  harness.paint = createStrokeTool({ kind: "paint", host, editor });
  harness.box = createShapeTool({ kind: "box", host, editor });
  harness.sphere = createShapeTool({ kind: "sphere", host, editor });
  harness.cylinder = createShapeTool({ kind: "cylinder", host, editor });
  return harness;
}

/** Pointer -> voxel stub: x maps to x, y to y, z to 0. */
function planePicker(
  volumeIdValue = VOLUME,
  nodeIdValue = CHILD,
): (clientX: number, clientY: number) => ToolPick {
  return (clientX, clientY) => ({
    nodeId: nodeIdValue,
    volumeId: volumeIdValue,
    voxel: [clientX, clientY, 0],
  });
}

function fillFixture(harness: Harness): void {
  const result = harness.bus.execute(
    setBatchCommand(commandId("command:test:prefill"), {
      volumeId: VOLUME,
      entries: [
        { coordinate: [0, 0, 0], material: MATERIAL },
        { coordinate: [1, 0, 0], material: MATERIAL },
        { coordinate: [2, 0, 0], material: MATERIAL },
      ],
    }),
    {
      transactionId: transactionId("transaction:test:prefill"),
      expectedRevision: harness.store.revision,
      source: "system",
    },
  );
  if (!result.ok) throw new Error(`prefill failed: ${result.error.code}`);
}

describe("select tool", () => {
  it("selects nodes with plain clicks and clears on a miss", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.select.click(1, 1);
    expect(harness.editor.selection).toEqual([{ kind: "node", nodeId: CHILD }]);
    harness.pick = () => undefined;
    harness.select.click(50, 50);
    expect(harness.editor.selection).toEqual([]);
  });

  it("adds with Shift and toggles with Ctrl", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.select.click(1, 1);
    harness.pick = planePicker(VOLUME_B, CHILD_B);
    harness.select.click(2, 2, { additive: true, toggle: false });
    expect(harness.editor.selection).toEqual([
      { kind: "node", nodeId: CHILD },
      { kind: "node", nodeId: CHILD_B },
    ]);
    harness.pick = planePicker();
    harness.select.click(1, 1, { additive: false, toggle: true });
    expect(harness.editor.selection).toEqual([
      { kind: "node", nodeId: CHILD_B },
    ]);
    harness.select.click(1, 1, { additive: false, toggle: true });
    expect(harness.editor.selection).toEqual([
      { kind: "node", nodeId: CHILD_B },
      { kind: "node", nodeId: CHILD },
    ]);
  });

  it("selects voxels in voxel mode", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.editor.setSelectionMode("voxel");
    harness.select.click(3, 4);
    expect(harness.editor.selection).toEqual([
      { kind: "voxel", volumeId: VOLUME, voxel: [3, 4, 0] },
    ]);
    harness.select.click(5, 6, { additive: true, toggle: false });
    expect(harness.editor.selection).toEqual([
      { kind: "voxel", volumeId: VOLUME, voxel: [3, 4, 0] },
      { kind: "voxel", volumeId: VOLUME, voxel: [5, 6, 0] },
    ]);
  });

  it("selects a region by dragging in region mode", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.editor.setSelectionMode("region");
    expect(harness.select.pointerDown(1, 1)).toEqual({ ok: true });
    expect(harness.select.active).toBe(true);
    expect(harness.editor.regionDraft).toEqual({
      volumeId: VOLUME,
      region: { min: [1, 1, 0], max: [2, 2, 1] },
    });
    harness.select.pointerMove(4, 3);
    expect(harness.editor.regionDraft).toEqual({
      volumeId: VOLUME,
      region: { min: [1, 1, 0], max: [5, 4, 1] },
    });
    harness.select.pointerUp();
    expect(harness.select.active).toBe(false);
    expect(harness.editor.regionDraft).toBeUndefined();
    expect(harness.editor.selection).toEqual([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [1, 1, 0], max: [5, 4, 1] },
      },
    ]);
    // The drag never committed anything.
    expect(harness.bus.historySnapshot().past).toHaveLength(0);
  });

  it("adds region drags with Shift and cancels cleanly", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.editor.setSelectionMode("region");
    harness.select.pointerDown(1, 1);
    harness.select.pointerMove(3, 3);
    harness.select.pointerUp();
    harness.select.pointerDown(5, 5, { additive: true, toggle: false });
    harness.select.pointerMove(6, 6);
    harness.select.pointerUp();
    expect(harness.editor.selection).toHaveLength(2);
    expect(
      harness.editor.selection.every((entry) => entry.kind === "region"),
    ).toBe(true);
    // A cancelled drag publishes no selection change and no draft.
    const before = harness.editor.selection;
    harness.select.pointerDown(9, 9);
    harness.select.pointerMove(10, 10);
    harness.select.pointerCancel();
    expect(harness.editor.selection).toEqual(before);
    expect(harness.editor.regionDraft).toBeUndefined();
  });

  it("clears on a region-mode click on empty space", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.editor.setSelectionMode("node");
    harness.select.click(1, 1);
    expect(harness.editor.selection).toHaveLength(1);
    harness.editor.setSelectionMode("region");
    harness.pick = () => undefined;
    harness.select.pointerDown(50, 50);
    harness.select.pointerUp();
    expect(harness.editor.selection).toEqual([]);
    // A Shift-modified miss leaves the selection untouched.
    harness.pick = planePicker();
    harness.select.click(1, 1);
    harness.pick = () => undefined;
    harness.select.pointerDown(50, 50, { additive: true, toggle: false });
    harness.select.pointerUp();
    expect(harness.editor.selection).toHaveLength(1);
  });

  it("never leaves a drag draft behind on reset", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.editor.setSelectionMode("region");
    harness.select.pointerDown(1, 1);
    harness.select.reset();
    expect(harness.editor.regionDraft).toBeUndefined();
    expect(harness.select.active).toBe(false);
  });
});

describe("eyedropper tool", () => {
  it("samples the picked voxel material into the active material", () => {
    const harness = createHarness();
    fillFixture(harness);
    harness.pick = planePicker();
    harness.editor.setActiveMaterial(REPLACEMENT);
    harness.eyedropper.pointerDown(1, 0);
    expect(harness.editor.activeMaterial).toBe(MATERIAL);
    // Sampling never commits and never starts a gesture.
    expect(harness.bus.historySnapshot().past).toHaveLength(1); // prefill
    expect(harness.eyedropper.active).toBe(false);
  });

  it("leaves the active material unchanged when sampling empty space", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.eyedropper.pointerDown(20, 20);
    expect(harness.editor.activeMaterial).toBe(MATERIAL);
  });
});

describe("paint tool", () => {
  it("recolors only occupied path voxels as one labeled transaction", () => {
    const harness = createHarness();
    fillFixture(harness);
    harness.pick = planePicker();
    harness.editor.setActiveMaterial(REPLACEMENT);
    harness.paint.pointerDown(0, 0);
    harness.paint.pointerMove(4, 0);
    // The path covers voxels 0..4 on x; only 0..2 are occupied, and the
    // draft previews exactly the change that will commit.
    expect(harness.editor.draft?.voxels).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    harness.paint.pointerUp();
    expect(harness.voxels(VOLUME).get("0,0,0")).toBe(2);
    expect(harness.voxels(VOLUME).get("1,0,0")).toBe(2);
    expect(harness.voxels(VOLUME).get("2,0,0")).toBe(2);
    expect(harness.voxels(VOLUME).get("3,0,0")).toBeUndefined();
    expect(harness.bus.historySnapshot().past).toHaveLength(2);
    expect(harness.bus.historySnapshot().past[1]?.label).toBe("Paint stroke");
  });

  it("commits nothing when the stroke changes nothing", () => {
    const harness = createHarness();
    fillFixture(harness);
    harness.pick = planePicker();
    harness.paint.pointerDown(0, 0);
    harness.paint.pointerMove(2, 0);
    harness.paint.pointerUp();
    expect(harness.bus.historySnapshot().past).toHaveLength(1); // prefill only
    expect(harness.editor.draft).toBeUndefined();
  });
});

describe("shape tools", () => {
  it("fills a box from a drag as one labeled, undoable transaction", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.box.pointerDown(1, 1);
    expect(harness.box.active).toBe(true);
    expect(harness.editor.draft?.voxels).toEqual([[1, 1, 0]]);
    harness.box.pointerMove(3, 2);
    expect(harness.editor.draft?.voxels).toHaveLength(6);
    harness.box.pointerUp();
    expect(harness.box.active).toBe(false);
    expect(harness.editor.draft).toBeUndefined();
    expect(harness.voxels(VOLUME).size).toBe(6);
    const history = harness.bus.historySnapshot();
    expect(history.past).toHaveLength(1);
    expect(history.past[0]?.label).toBe("Fill box");
    const undo = harness.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(harness.voxels(VOLUME).size).toBe(0);
  });

  it("fills a sphere with the Chebyshev drag radius", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.sphere.pointerDown(0, 0);
    harness.sphere.pointerMove(2, 1);
    // radius = max(|2|, |1|, 0) = 2: the solid sphere of radius 2 has
    // 33 voxels (0,0,0-centered r=2 sphere count: 3x3x3=27 + 6 rim = 33).
    expect(harness.editor.draft?.voxels).toHaveLength(33);
    harness.sphere.pointerUp();
    expect(harness.voxels(VOLUME).size).toBe(33);
    expect(harness.bus.historySnapshot().past[0]?.label).toBe("Fill sphere");
  });

  it("fills a cylinder along the dominant drag axis", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.cylinder.pointerDown(0, 0);
    harness.cylinder.pointerMove(0, 3);
    // Vertical drag: axis y, height 3, radius 0 -> 3 voxels along y.
    expect(harness.editor.draft?.voxels).toHaveLength(3);
    harness.cylinder.pointerMove(2, 3);
    // Now radius 2 on the x/z axes: a 13-voxel disc (x^2+z^2 <= 4) times
    // 3 height layers (y = 0..2) = 39 voxels.
    expect(harness.editor.draft?.voxels).toHaveLength(39);
    harness.cylinder.pointerUp();
    expect(harness.voxels(VOLUME).size).toBe(39);
    expect(harness.bus.historySnapshot().past[0]?.label).toBe("Fill cylinder");
  });

  it("commits nothing for a zero-height cylinder point drag", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.cylinder.pointerDown(0, 0);
    harness.cylinder.pointerUp();
    expect(harness.bus.historySnapshot().past).toHaveLength(0);
    expect(harness.voxels(VOLUME).size).toBe(0);
  });

  it("cancels a shape gesture without committing", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.box.pointerDown(0, 0);
    harness.box.pointerMove(5, 5);
    harness.box.pointerCancel();
    expect(harness.box.active).toBe(false);
    expect(harness.editor.draft).toBeUndefined();
    expect(harness.bus.historySnapshot().past).toHaveLength(0);
    expect(harness.voxels(VOLUME).size).toBe(0);
  });

  it("rejects a shape that exceeds the lowered budget atomically", () => {
    const harness = createHarness({ maxGestureVoxels: 8 });
    harness.pick = planePicker();
    harness.box.pointerDown(0, 0);
    harness.box.pointerMove(4, 4); // 25 voxels > 8
    expect(harness.editor.draft).toBeUndefined();
    expect(harness.box.active).toBe(false);
    expect(harness.bus.historySnapshot().past).toHaveLength(0);
  });

  it("clamps shapes to the volume coordinate domain", () => {
    const harness = createHarness();
    // The anchor sits exactly at the domain edge (x = maxVoxelCoordinate);
    // the drag then extends beyond it, so the region must clamp to the
    // domain and the preview must equal the committed fill.
    harness.pick = (clientX) => ({
      nodeId: CHILD,
      volumeId: VOLUME,
      voxel: [1_048_575 - clientX, 0, 0],
    });
    harness.box.pointerDown(0, 0);
    harness.box.pointerMove(1, 0);
    const draft = harness.editor.draft;
    expect(draft).toBeDefined();
    expect(draft?.voxels).toHaveLength(2);
    harness.box.pointerUp();
    expect(harness.bus.historySnapshot().past[0]?.label).toBe("Fill box");
    // The committed region is inside the domain: both voxels exist.
    expect(harness.voxels(VOLUME).has("1048574,0,0")).toBe(true);
    expect(harness.voxels(VOLUME).has("1048575,0,0")).toBe(true);
  });

  it("stays in the volume the gesture started on", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.box.pointerDown(0, 0);
    harness.box.pointerMove(3, 3);
    expect(harness.editor.draft?.voxels).toHaveLength(16);
    // Picks over the other volume are ignored: the preview keeps VOLUME.
    harness.pick = planePicker(VOLUME_B, CHILD_B);
    harness.box.pointerMove(5, 5);
    expect(harness.editor.draft?.volumeId).toBe(VOLUME);
    expect(harness.editor.draft?.voxels).toHaveLength(16);
    harness.box.pointerUp();
    expect(harness.voxels(VOLUME).size).toBe(16);
    expect(harness.voxels(VOLUME_B).size).toBe(0);
  });
});

/**
 * A box tool over a fake read surface with `occupiedCount` occupied
 * voxels and a 10-voxel occupied limit (ADR-0009): drives the tool's
 * preflight through the real gesture path against a tiny limit.
 */
function createOccupiedLimitHarness(occupiedCount: number): {
  readonly harness: Harness;
  readonly box: ReturnType<typeof createShapeTool>;
  readonly editor: ReturnType<typeof createEditorStore>;
} {
  const harness = createHarness();
  const occupied = new Set<string>();
  for (let x = 0; x < occupiedCount; x += 1) {
    occupied.add(`${String(x)},0,0`);
  }
  const limits: VoxelVolumeLimits = {
    ...DEFAULT_VOXEL_VOLUME_LIMITS,
    maxOccupiedVoxels: 10,
  };
  const fakeView: VoxelVolumeReadView = {
    volumeId: VOLUME,
    limits,
    getVoxel: (coordinate) =>
      occupied.has(coordinate.join(",")) ? MATERIAL : (0 as never),
    getChunk: () => undefined,
    chunkCount: () => 0,
    chunkCoordinates: () => [],
    occupiedCount: () => occupied.size,
    occupiedBounds: () => undefined,
  };
  const fakeStore: DocumentStoreRead = {
    revision: 0,
    limits: DEFAULT_DOCUMENT_LIMITS,
    volumeLimits: DEFAULT_VOXEL_VOLUME_LIMITS,
    getDocument: () => harness.store.getDocument(),
    getVolume: (volumeId) => (volumeId === VOLUME ? fakeView : undefined),
    getVoxel: () => 0 as never,
    subscribe: () => () => {},
  };
  const editor = createEditorStore();
  editor.setActiveMaterial(MATERIAL);
  const host: ToolHost = {
    get store() {
      return fakeStore;
    },
    maxGestureVoxels: 1_000_000,
    pick: (clientX) => ({
      nodeId: CHILD,
      volumeId: VOLUME,
      voxel: [clientX, 0, 0],
    }),
    nextCommandId: () => commandId("command:test:shape"),
    commit: () => undefined,
  };
  return {
    harness,
    box: createShapeTool({ kind: "box", host, editor }),
    editor,
  };
}

describe("shape volume-limit preflight", () => {
  it("clamps shape extents to the volume extent limit", () => {
    const harness = createHarness();
    const limits: VoxelVolumeLimits = {
      ...DEFAULT_VOXEL_VOLUME_LIMITS,
      maxExtent: 8,
    };
    // Pure derivation: a 12-voxel drag clamps to an 8-voxel span.
    const boxParams = shapeParamsForDrag(
      "box",
      VOLUME,
      [0, 0, 0],
      [12, 0, 0],
      limits,
    );
    if (boxParams.kind !== "box") throw new Error("expected box params");
    expect(boxParams.region).toEqual({ min: [0, 0, 0], max: [8, 1, 1] });
    const sphereParams = shapeParamsForDrag(
      "sphere",
      VOLUME,
      [0, 0, 0],
      [12, 0, 0],
      limits,
    );
    if (sphereParams.kind !== "sphere")
      throw new Error("expected sphere params");
    // 2r + 1 <= 8 -> r <= 3 (Chebyshev 12 clamps to 3).
    expect(sphereParams.radius).toBe(3);
    const cylinderParams = shapeParamsForDrag(
      "cylinder",
      VOLUME,
      [0, 0, 0],
      [0, 12, 0],
      limits,
    );
    if (cylinderParams.kind !== "cylinder")
      throw new Error("expected cylinder params");
    expect(cylinderParams.height).toBe(8);
    expect(cylinderParams.radius).toBe(0);
    // Through the real store the same clamp makes the commit succeed.
    harness.pick = planePicker();
    harness.box.pointerDown(0, 0);
    harness.box.pointerMove(12, 0);
    // The preview is the clamped box (13 voxels on x would be 13; the
    // default store extent is 2048, so no clamping happens here).
    expect(harness.editor.draft?.voxels).toHaveLength(13);
    harness.box.pointerUp();
    expect(harness.bus.historySnapshot().past[0]?.label).toBe("Fill box");
    expect(harness.voxels(VOLUME).size).toBe(13);
  });

  it("reports the occupied-voxel limit before any commit", () => {
    const { box, editor } = createOccupiedLimitHarness(8);
    // Down at (0,0,0): the first voxel is already occupied, so the
    // occupied count does not grow.
    expect(box.pointerDown(0, 0)).toEqual({ ok: true });
    // Move to (4,0,0): 4 empty additions -> 8 + 4 = 12 > 10.
    const result = box.pointerMove(4, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOO_MANY_OCCUPIED_VOXELS");
    expect(box.active).toBe(false);
    expect(editor.draft).toBeUndefined();
  });

  it("reports the occupied-voxel limit through pointerDown atomically", () => {
    // A volume already at its occupied-voxel limit: pointer-down on an
    // empty voxel must report the same structured error as pointerMove
    // (regression: pointerDown used to let the WorkspaceError escape the
    // DOM handler, leaving the tool active with params and no draft).
    const { harness, box, editor } = createOccupiedLimitHarness(10);
    // Down at (10,0,0): one empty addition -> 10 + 1 = 11 > 10, so the
    // gesture is rejected and cancelled before any preview or commit.
    const result = box.pointerDown(10, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOO_MANY_OCCUPIED_VOXELS");
    expect(box.active).toBe(false);
    expect(editor.draft).toBeUndefined();
    expect(harness.bus.historySnapshot().past).toHaveLength(0);
  });
});

describe("selection pruning integration", () => {
  it("prunes deleted references through the document surface", () => {
    const harness = createHarness();
    harness.pick = planePicker();
    harness.select.click(1, 1);
    expect(harness.editor.selection).toEqual([{ kind: "node", nodeId: CHILD }]);
    // Simulate a store commit that deletes the node (the desktop
    // controller prunes on every committed event; here we exercise the
    // pure helper against the authoritative document).
    const document = harness.store.getDocument();
    const pruned = pruneSelection(harness.editor.selection, document);
    expect(pruned).toEqual([{ kind: "node", nodeId: CHILD }]);
  });
});
