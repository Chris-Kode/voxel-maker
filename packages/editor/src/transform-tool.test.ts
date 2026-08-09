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
  registerRegionCommands,
  registerVoxelCommands,
  setBatchCommand,
} from "@voxel-maker/commands";
import { createDocumentStore } from "@voxel-maker/document";
import {
  createEditorStore,
  createTransformTool,
  selectionRegions,
  type EditorStore,
} from "./index.js";
import type { DocumentStoreRead } from "@voxel-maker/document";
import {
  DEFAULT_VOXEL_VOLUME_LIMITS,
  type VoxelVolumeLimits,
  type VoxelVolumeReadView,
} from "@voxel-maker/voxel";
import { DEFAULT_DOCUMENT_LIMITS } from "@voxel-maker/model";
import type { ToolHost, ToolPick } from "./types.js";

/**
 * Ticket #19 headless transform tool tests (plan S7.19): selection-region
 * expansion, move/copy drag gestures (exact destination previews, overlap
 * collision counts, negative coordinates, one labeled transaction per
 * gesture, atomic cancellation), rotate/mirror/delete preview-and-apply
 * flows (90-degree cycling, all axes, lattice parity rejection), and the
 * ADR-0009 budget preflights. The host wires a real command bus and a
 * stub picker so every assertion runs through the authoritative store.
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
    metadata: { title: "transform-fixture" },
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
  readonly editor: EditorStore;
  transform: ReturnType<typeof createTransformTool>;
  /** Stub picker; tests replace this to control pointer->voxel mapping. */
  pick: (clientX: number, clientY: number) => ToolPick | undefined;
  nextCommandId(): CommandId;
  /** Committed voxels of a volume, keyed "x,y,z" -> material. */
  voxels(volumeId: string): Map<string, number>;
  /** Occupied count of a volume through the authoritative store. */
  occupied(volumeId: string): number;
}

function createHarness(options?: { maxGestureVoxels?: number }): Harness {
  const document = buildDocument();
  const { store, writeCapability } = createDocumentStore({ document });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  registerRegionCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);
  const editor = createEditorStore();
  editor.setActiveMaterial(MATERIAL);
  let commandSequence = 0;
  const harness: Harness = {
    store,
    bus,
    editor,
    transform: undefined as unknown as Harness["transform"],
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
    occupied(volumeIdValue) {
      return store.getVolume(volumeIdValue as never)?.occupiedCount() ?? 0;
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
  harness.transform = createTransformTool({ host, editor });
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

/** Sets voxels through one batch command (deterministic fixture setup). */
function setVoxels(
  harness: Harness,
  volumeIdValue: string,
  coordinates: readonly [number, number, number][],
  material: number = MATERIAL,
): void {
  const result = harness.bus.execute(
    setBatchCommand(
      commandId(
        `command:test:${String(harness.bus.historySnapshot().past.length + 1)}`,
      ),
      {
        volumeId: volumeIdValue as never,
        entries: coordinates.map((coordinate) => ({
          coordinate,
          material: material as never,
        })),
      },
    ),
    {
      transactionId: transactionId(
        `transaction:test:${String(harness.bus.historySnapshot().past.length + 1)}`,
      ),
      expectedRevision: harness.store.revision,
      source: "system",
    },
  );
  if (!result.ok) throw new Error(`set failed: ${result.error.code}`);
}

/** Labeled past-history entries of the bus (fixture setups stay unlabeled). */
const labels = (harness: Harness): readonly string[] =>
  harness.bus
    .historySnapshot()
    .past.filter((entry) => entry.label !== undefined)
    .map((entry) => entry.label as string);

describe("selectionRegions", () => {
  it("expands node, voxel, and region entries into per-volume regions", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    setVoxels(harness, VOLUME_B, [[5, 5, 5]]);
    const regions = selectionRegions(harness.store, [
      { kind: "node", nodeId: CHILD },
      { kind: "voxel", volumeId: VOLUME_B, voxel: [5, 5, 5] },
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 1, 1] },
      },
    ]);
    expect(regions).toEqual([
      { volumeId: VOLUME, region: { min: [0, 0, 0], max: [3, 1, 1] } },
      { volumeId: VOLUME_B, region: { min: [5, 5, 5], max: [6, 6, 6] } },
    ]);
    harness.transform.reset();
  });

  it("skips empty volumes and deduplicates equal regions", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [[0, 0, 0]]);
    const regions = selectionRegions(harness.store, [
      { kind: "node", nodeId: CHILD },
      { kind: "node", nodeId: CHILD_B },
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    ]);
    expect(regions).toEqual([
      { volumeId: VOLUME, region: { min: [0, 0, 0], max: [1, 1, 1] } },
    ]);
    harness.transform.reset();
  });

  it("is undefined for an empty selection", () => {
    const harness = createHarness();
    expect(selectionRegions(harness.store, [])).toBeUndefined();
    harness.transform.reset();
  });
});

describe("transform move", () => {
  it("previews the exact destination and commits one labeled transaction", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 1, 1] },
      },
    ]);
    harness.editor.setTransformMode("move");
    harness.pick = planePicker();
    const down = harness.transform.pointerDown(0, 0);
    expect(down).toEqual({ ok: true });
    expect(harness.transform.active).toBe(true);
    const moved = harness.transform.pointerMove(5, 0);
    expect(moved).toEqual({ ok: true });
    const preview = harness.editor.transformPreview;
    expect(preview).toBeDefined();
    if (preview === undefined || preview.operation !== "move") {
      throw new Error("move preview missing");
    }
    expect(preview.delta).toEqual([5, 0, 0]);
    expect(preview.entries).toEqual([
      {
        volumeId: VOLUME,
        source: { min: [0, 0, 0], max: [3, 1, 1] },
        destination: { min: [5, 0, 0], max: [8, 1, 1] },
      },
    ]);
    expect(preview.movedVoxels).toBe(3);
    expect(preview.overwrittenVoxels).toBe(0);
    expect(preview.removedVoxels).toBe(3);
    const up = harness.transform.pointerUp();
    expect(up).toEqual({ ok: true });
    expect(harness.editor.transformPreview).toBeUndefined();
    expect(labels(harness)).toEqual(["Move selection"]);
    expect(harness.bus.historySnapshot().past).toHaveLength(2);
    const voxels = harness.voxels(VOLUME);
    expect(voxels.get("5,0,0")).toBe(MATERIAL);
    expect(voxels.get("6,0,0")).toBe(MATERIAL);
    expect(voxels.get("7,0,0")).toBe(MATERIAL);
    expect(voxels.get("0,0,0")).toBeUndefined();
    harness.transform.reset();
  });

  it("moves across negative coordinates and undoes/redoes atomically", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [[0, 0, 0]]);
    harness.editor.setSelection([
      { kind: "voxel", volumeId: VOLUME, voxel: [0, 0, 0] },
    ]);
    harness.editor.setTransformMode("move");
    harness.pick = planePicker();
    harness.transform.pointerDown(0, 0);
    harness.transform.pointerMove(-3, -2);
    harness.transform.pointerUp();
    expect(harness.voxels(VOLUME).get("-3,-2,0")).toBe(MATERIAL);
    expect(harness.voxels(VOLUME).get("0,0,0")).toBeUndefined();
    expect(harness.occupied(VOLUME)).toBe(1);
    const undo = harness.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(harness.voxels(VOLUME).get("0,0,0")).toBe(MATERIAL);
    expect(harness.voxels(VOLUME).get("-3,-2,0")).toBeUndefined();
    const redo = harness.bus.redo({
      transactionId: transactionId("transaction:test:redo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    expect(redo.ok).toBe(true);
    expect(harness.voxels(VOLUME).get("-3,-2,0")).toBe(MATERIAL);
    harness.transform.reset();
  });

  it("counts and applies overlap collisions exactly", () => {
    const harness = createHarness();
    // Source line at x 0..2 and an external wall at x 5..6.
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [5, 0, 0],
      [6, 0, 0],
    ]);
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 1, 1] },
      },
    ]);
    harness.editor.setTransformMode("move");
    harness.pick = planePicker();
    harness.transform.pointerDown(0, 0);
    harness.transform.pointerMove(5, 0);
    const preview = harness.editor.transformPreview;
    if (preview === undefined) throw new Error("preview missing");
    // Destination x 5..8: occupied at 5,6 -> 2 overwritten; source
    // positions 0,1,2 are outside the destination -> 3 removed.
    expect(preview.overwrittenVoxels).toBe(2);
    expect(preview.removedVoxels).toBe(3);
    harness.transform.pointerUp();
    const voxels = harness.voxels(VOLUME);
    expect(voxels.get("5,0,0")).toBe(MATERIAL);
    expect(voxels.get("6,0,0")).toBe(MATERIAL);
    expect(voxels.get("7,0,0")).toBe(MATERIAL);
    expect(voxels.get("0,0,0")).toBeUndefined();
    expect(harness.occupied(VOLUME)).toBe(3);
    harness.transform.reset();
  });

  it("keeps moved content in a source-overlapping move (snapshot wins)", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 1, 1] },
      },
    ]);
    harness.editor.setTransformMode("move");
    harness.pick = planePicker();
    harness.transform.pointerDown(0, 0);
    // Delta +1: destination [1,4) overlaps the source [0,3).
    harness.transform.pointerMove(1, 0);
    const preview = harness.editor.transformPreview;
    if (preview === undefined) throw new Error("preview missing");
    expect(preview.overwrittenVoxels).toBe(0);
    // Only voxel 0 leaves the destination; 1 and 2 stay occupied.
    expect(preview.removedVoxels).toBe(1);
    harness.transform.pointerUp();
    const voxels = harness.voxels(VOLUME);
    expect(voxels.get("0,0,0")).toBeUndefined();
    expect(voxels.get("1,0,0")).toBe(MATERIAL);
    expect(voxels.get("2,0,0")).toBe(MATERIAL);
    expect(voxels.get("3,0,0")).toBe(MATERIAL);
    harness.transform.reset();
  });

  it("commits one command per volume in a single transaction", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [[0, 0, 0]]);
    setVoxels(harness, VOLUME_B, [[0, 0, 0]]);
    harness.editor.setSelection([
      { kind: "voxel", volumeId: VOLUME, voxel: [0, 0, 0] },
      { kind: "voxel", volumeId: VOLUME_B, voxel: [0, 0, 0] },
    ]);
    harness.editor.setTransformMode("move");
    harness.pick = planePicker();
    harness.transform.pointerDown(0, 0);
    harness.transform.pointerMove(2, 0);
    harness.transform.pointerUp();
    expect(labels(harness)).toEqual(["Move selection"]);
    expect(harness.bus.historySnapshot().past).toHaveLength(3);
    expect(harness.voxels(VOLUME).get("2,0,0")).toBe(MATERIAL);
    expect(harness.voxels(VOLUME_B).get("2,0,0")).toBe(MATERIAL);
    harness.transform.reset();
  });

  it("orders same-volume commands so the commit matches the union preview", () => {
    const harness = createHarness();
    // A region [0,2) plus a voxel at (2,0,0): the region's destination
    // [2,4) overlaps the voxel's source, so the voxel must move first or
    // the region's writes would be re-moved (the voxel at 2 would be
    // lost). The preview promises the union {2,3,4}.
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 1, 1] },
      },
      { kind: "voxel", volumeId: VOLUME, voxel: [2, 0, 0] },
    ]);
    harness.editor.setTransformMode("move");
    harness.pick = planePicker();
    harness.transform.pointerDown(0, 0);
    harness.transform.pointerMove(2, 0);
    const preview = harness.editor.transformPreview;
    if (preview === undefined || preview.operation !== "move") {
      throw new Error("move preview missing");
    }
    expect(preview.movedVoxels).toBe(3);
    harness.transform.pointerUp();
    expect(labels(harness)).toEqual(["Move selection"]);
    const voxels = harness.voxels(VOLUME);
    expect(voxels.get("2,0,0")).toBe(MATERIAL);
    expect(voxels.get("3,0,0")).toBe(MATERIAL);
    expect(voxels.get("4,0,0")).toBe(MATERIAL);
    expect(voxels.get("0,0,0")).toBeUndefined();
    expect(voxels.get("1,0,0")).toBeUndefined();
    expect(harness.occupied(VOLUME)).toBe(3);
    harness.transform.reset();
  });

  it("rejects same-volume regions that mutually interfere", () => {
    const harness = createHarness();
    // Region A [0,5) moves onto region B [2,7) while B moves onto A: the
    // sequential commands cannot realize the union semantics, so the
    // gesture is rejected atomically instead of silently double-moving.
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
      [4, 0, 0],
      [5, 0, 0],
      [6, 0, 0],
    ]);
    const revision = harness.store.revision;
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [5, 1, 1] },
      },
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [2, 0, 0], max: [7, 1, 1] },
      },
    ]);
    harness.editor.setTransformMode("move");
    harness.pick = planePicker();
    const down = harness.transform.pointerDown(0, 0);
    expect(down.ok).toBe(false);
    if (!down.ok) {
      expect(down.error.code).toBe("CONFLICTING_SELECTION_REGIONS");
    }
    expect(harness.transform.active).toBe(false);
    expect(harness.editor.transformPreview).toBeUndefined();
    expect(harness.store.revision).toBe(revision);
    expect(harness.bus.historySnapshot().past).toHaveLength(1);
    harness.transform.reset();
  });

  it("moves a node selection through its occupied bounds", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [2, 0, 0],
    ]);
    harness.editor.setSelection([{ kind: "node", nodeId: CHILD }]);
    harness.editor.setTransformMode("move");
    harness.pick = planePicker();
    harness.transform.pointerDown(0, 0);
    harness.transform.pointerMove(4, 0);
    const preview = harness.editor.transformPreview;
    if (preview === undefined) throw new Error("preview missing");
    expect(preview.entries).toEqual([
      {
        volumeId: VOLUME,
        source: { min: [0, 0, 0], max: [3, 1, 1] },
        destination: { min: [4, 0, 0], max: [7, 1, 1] },
      },
    ]);
    harness.transform.pointerUp();
    const voxels = harness.voxels(VOLUME);
    expect(voxels.get("4,0,0")).toBe(MATERIAL);
    expect(voxels.get("6,0,0")).toBe(MATERIAL);
    expect(voxels.get("0,0,0")).toBeUndefined();
    harness.transform.reset();
  });

  it("commits nothing for a zero delta or a cancelled gesture", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [[0, 0, 0]]);
    const revision = harness.store.revision;
    const pastLength = harness.bus.historySnapshot().past.length;
    harness.editor.setSelection([
      { kind: "voxel", volumeId: VOLUME, voxel: [0, 0, 0] },
    ]);
    harness.editor.setTransformMode("move");
    harness.pick = planePicker();
    harness.transform.pointerDown(0, 0);
    harness.transform.pointerUp();
    expect(harness.store.revision).toBe(revision);
    expect(harness.bus.historySnapshot().past).toHaveLength(pastLength);

    harness.transform.pointerDown(0, 0);
    harness.transform.pointerMove(3, 0);
    expect(harness.editor.transformPreview).toBeDefined();
    harness.transform.pointerCancel();
    expect(harness.editor.transformPreview).toBeUndefined();
    expect(harness.transform.active).toBe(false);
    expect(harness.store.revision).toBe(revision);
    expect(harness.bus.historySnapshot().past).toHaveLength(pastLength);
    expect(harness.voxels(VOLUME).get("0,0,0")).toBe(MATERIAL);
    harness.transform.reset();
  });

  it("rejects gestures that exceed the per-gesture voxel budget", () => {
    const harness = createHarness({ maxGestureVoxels: 8 });
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    const revision = harness.store.revision;
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 3, 3] },
      },
    ]);
    harness.editor.setTransformMode("move");
    harness.pick = planePicker();
    // The 27-voxel region exceeds the 8-voxel budget: the initial preview
    // fails on pointer down, the gesture never starts, and nothing commits.
    const down = harness.transform.pointerDown(0, 0);
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.error.code).toBe("TOO_MANY_VOXELS");
    expect(harness.transform.active).toBe(false);
    expect(harness.transform.pointerMove(1, 0)).toEqual({ ok: true });
    expect(harness.editor.transformPreview).toBeUndefined();
    expect(harness.store.revision).toBe(revision);
    harness.transform.reset();
  });

  it("rejects destinations outside the volume coordinate domain", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [[0, 0, 0]]);
    const revision = harness.store.revision;
    harness.editor.setSelection([
      { kind: "voxel", volumeId: VOLUME, voxel: [0, 0, 0] },
    ]);
    harness.editor.setTransformMode("move");
    harness.pick = planePicker();
    harness.transform.pointerDown(0, 0);
    // The fixture volume's limits default to maxCoordinate 1_048_575;
    // drag far beyond it.
    const moved = harness.transform.pointerMove(1_048_576, 0);
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error.code).toBe("REGION_OUT_OF_BOUNDS");
    expect(harness.transform.active).toBe(false);
    expect(harness.store.revision).toBe(revision);
    harness.transform.reset();
  });
});

/**
 * Fake immutable read view over a key set, with `getChunk` materialized
 * from the occupied keys so the tool's chunk-wise scans see content. The
 * occupied-voxel limit is a parameter so the preflight seam is
 * exercised without filling a real volume.
 */
function fakeReadView(
  volumeIdValue: string,
  occupied: ReadonlySet<string>,
  limits: VoxelVolumeLimits,
): VoxelVolumeReadView {
  const values = new Map<string, number>();
  for (const key of occupied) {
    values.set(key, MATERIAL);
  }
  return {
    volumeId: volumeIdValue as never,
    limits,
    getVoxel: (coordinate) => (values.get(coordinate.join(",")) ?? 0) as never,
    getChunk: (coordinate) => {
      const chunk = new Uint16Array(4096);
      let any = false;
      for (const [key, material] of values) {
        const [x, y, z] = key.split(",").map(Number);
        const cx = Math.floor((x as number) / 16);
        const cy = Math.floor((y as number) / 16);
        const cz = Math.floor((z as number) / 16);
        if (
          cx !== coordinate[0] ||
          cy !== coordinate[1] ||
          cz !== coordinate[2]
        ) {
          continue;
        }
        const lx = (((x as number) % 16) + 16) % 16;
        const ly = (((y as number) % 16) + 16) % 16;
        const lz = (((z as number) % 16) + 16) % 16;
        chunk[lx + 16 * (ly + 16 * lz)] = material;
        any = true;
      }
      return any ? chunk : undefined;
    },
    chunkCount: () => 0,
    chunkCoordinates: () => [],
    occupiedCount: () => occupied.size,
    occupiedBounds: () => undefined,
  };
}

function fakeStore(
  document: VoxelDocument,
  view: VoxelVolumeReadView,
): DocumentStoreRead {
  return {
    revision: 0,
    limits: DEFAULT_DOCUMENT_LIMITS,
    volumeLimits: DEFAULT_VOXEL_VOLUME_LIMITS,
    getDocument: () => document,
    getVolume: (volumeId) => (volumeId === VOLUME ? view : undefined),
    getVoxel: () => 0 as never,
    subscribe: () => () => {},
  };
}

/** Tool bound to a fake store; the commit host stays a no-op. */
function toolOnFakeStore(
  harness: Harness,
  store: DocumentStoreRead,
  editor: EditorStore,
): ReturnType<typeof createTransformTool> {
  const host: ToolHost = {
    get store() {
      return store;
    },
    maxGestureVoxels: 1_000_000,
    pick: (clientX) => ({
      nodeId: CHILD,
      volumeId: VOLUME,
      voxel: [clientX, 0, 0],
    }),
    nextCommandId: () => commandId("command:test:transform"),
    commit: () => undefined,
  };
  return createTransformTool({ host, editor });
}

describe("transform occupied-limit preflight", () => {
  it("accepts moves whose net occupied change fits and rejects copies that exceed", () => {
    const harness = createHarness();
    const occupied = new Set<string>();
    for (let x = 0; x < 8; x += 1) {
      occupied.add(`${String(x)},0,0`);
    }
    const view = fakeReadView(VOLUME, occupied, {
      ...DEFAULT_VOXEL_VOLUME_LIMITS,
      maxOccupiedVoxels: 10,
    });
    const editor = createEditorStore();
    editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [8, 1, 1] },
      },
    ]);
    const transform = toolOnFakeStore(
      harness,
      fakeStore(harness.store.getDocument(), view),
      editor,
    );

    // Move by +8 onto empty space: 8 additions, 8 removals -> net 0,
    // occupied stays 8 <= 10: the exact net preflight accepts it.
    editor.setTransformMode("move");
    expect(transform.pointerDown(0, 0)).toEqual({ ok: true });
    expect(transform.pointerMove(8, 0)).toEqual({ ok: true });
    transform.pointerCancel();

    // Copy by +8 onto empty space: 8 additions -> 16 > 10: rejected
    // before any commit and the pending state is cleared.
    editor.setTransformMode("copy");
    expect(transform.pointerDown(0, 0)).toEqual({ ok: true });
    const copy = transform.pointerMove(8, 0);
    expect(copy.ok).toBe(false);
    if (!copy.ok) expect(copy.error.code).toBe("TOO_MANY_OCCUPIED_VOXELS");
    expect(transform.active).toBe(false);
    expect(editor.transformPreview).toBeUndefined();
    transform.reset();
  });

  it("accepts a rotate whose net occupied change is zero at the limit", () => {
    // Rotations never increase the occupied count (the mapped content is
    // a bijection of the source), so a rotation at the occupied-voxel
    // limit must pass the exact preflight instead of being rejected.
    const occupied = new Set<string>();
    for (let x = 0; x < 4; x += 1) occupied.add(`${String(x)},0,0`);
    for (let z = 1; z < 3; z += 1) occupied.add(`3,0,${String(z)}`);
    const view = fakeReadView(VOLUME, occupied, {
      ...DEFAULT_VOXEL_VOLUME_LIMITS,
      maxOccupiedVoxels: 6,
    });
    const editor = createEditorStore();
    editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [4, 1, 4] },
      },
    ]);
    const harness = createHarness();
    const transform = toolOnFakeStore(
      harness,
      fakeStore(harness.store.getDocument(), view),
      editor,
    );
    const result = transform.previewRotate("y");
    expect(result).toEqual({ ok: true });
    const preview = editor.transformPreview;
    if (preview === undefined || preview.operation !== "rotate") {
      throw new Error("rotate preview missing");
    }
    // Three mapped positions land back on occupied source positions, so
    // three source positions are removed and three are re-occupied: the
    // net occupied change is zero and the limit preflight accepts it.
    expect(preview.removedVoxels).toBe(3);
    expect(preview.movedVoxels).toBe(6);
    expect(transform.applyPending()).toEqual({ ok: true });
    transform.reset();
  });
});

describe("transform session and selection preconditions", () => {
  it("reports SESSION_NOT_OPEN without a document", () => {
    const editor = createEditorStore();
    editor.setSelection([
      { kind: "voxel", volumeId: VOLUME, voxel: [0, 0, 0] },
    ]);
    editor.setTransformMode("move");
    const host: ToolHost = {
      get store() {
        return undefined;
      },
      maxGestureVoxels: 1_000_000,
      pick: (clientX) => ({
        nodeId: CHILD,
        volumeId: VOLUME,
        voxel: [clientX, 0, 0],
      }),
      nextCommandId: () => commandId("command:test:transform"),
      commit: () => undefined,
    };
    const transform = createTransformTool({ host, editor });
    const down = transform.pointerDown(0, 0);
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.error.code).toBe("SESSION_NOT_OPEN");
    expect(transform.active).toBe(false);
    const preview = transform.previewDelete();
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error.code).toBe("SESSION_NOT_OPEN");
    transform.reset();
  });

  it("is a silent no-op without a selection or on a missed pick", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [[0, 0, 0]]);
    const revision = harness.store.revision;
    const pastLength = harness.bus.historySnapshot().past.length;
    harness.editor.setTransformMode("move");
    harness.pick = () => undefined;
    expect(harness.transform.pointerDown(0, 0)).toEqual({ ok: true });
    expect(harness.transform.active).toBe(false);
    harness.editor.setSelection([
      { kind: "voxel", volumeId: VOLUME, voxel: [0, 0, 0] },
    ]);
    harness.pick = planePicker();
    expect(harness.transform.pointerDown(0, 0)).toEqual({ ok: true });
    expect(harness.transform.pointerMove(2, 0)).toEqual({ ok: true });
    harness.transform.pointerCancel();
    expect(harness.store.revision).toBe(revision);
    expect(harness.bus.historySnapshot().past).toHaveLength(pastLength);
    harness.transform.reset();
  });

  it("ignores pointer gestures in rotate/mirror/delete modes", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [[0, 0, 0]]);
    harness.editor.setSelection([
      { kind: "voxel", volumeId: VOLUME, voxel: [0, 0, 0] },
    ]);
    harness.pick = planePicker();
    harness.editor.setTransformMode("delete");
    const pastLength = harness.bus.historySnapshot().past.length;
    expect(harness.transform.pointerDown(0, 0)).toEqual({ ok: true });
    expect(harness.transform.active).toBe(false);
    expect(harness.transform.pointerMove(3, 0)).toEqual({ ok: true });
    expect(harness.transform.pointerUp()).toEqual({ ok: true });
    expect(harness.bus.historySnapshot().past).toHaveLength(pastLength);
    harness.transform.reset();
  });
});

describe("transform copy", () => {
  it("copies the selection as one labeled transaction and leaves the source", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
    ]);
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 1, 1] },
      },
    ]);
    harness.editor.setTransformMode("copy");
    harness.pick = planePicker();
    harness.transform.pointerDown(0, 0);
    harness.transform.pointerMove(4, 0);
    const preview = harness.editor.transformPreview;
    if (preview === undefined) throw new Error("preview missing");
    expect(preview.operation).toBe("copy");
    // Copy onto empty space: nothing overwritten, nothing removed.
    expect(preview.overwrittenVoxels).toBe(0);
    expect(preview.removedVoxels).toBe(0);
    harness.transform.pointerUp();
    expect(labels(harness)).toEqual(["Copy selection"]);
    const voxels = harness.voxels(VOLUME);
    expect(voxels.get("0,0,0")).toBe(MATERIAL);
    expect(voxels.get("4,0,0")).toBe(MATERIAL);
    expect(voxels.get("5,0,0")).toBe(MATERIAL);
    expect(harness.occupied(VOLUME)).toBe(4);
    harness.transform.reset();
  });

  it("counts every occupied destination voxel as overwritten", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [4, 0, 0],
      [5, 0, 0],
    ]);
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 1, 1] },
      },
    ]);
    harness.editor.setTransformMode("copy");
    harness.pick = planePicker();
    harness.transform.pointerDown(0, 0);
    harness.transform.pointerMove(4, 0);
    const preview = harness.editor.transformPreview;
    if (preview === undefined) throw new Error("preview missing");
    expect(preview.overwrittenVoxels).toBe(2);
    harness.transform.pointerUp();
    expect(harness.occupied(VOLUME)).toBe(4);
    harness.transform.reset();
  });
});

describe("transform rotate", () => {
  it("cycles 90, 180, and 270 degrees around an axis and applies one transaction", () => {
    const harness = createHarness();
    // An L shape inside a 4x4x1 region (even extents, exact around z).
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [2, 1, 0],
    ]);
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [4, 4, 1] },
      },
    ]);
    harness.editor.setTransformMode("rotate");
    expect(harness.transform.previewRotate("z")).toEqual({ ok: true });
    let preview = harness.editor.transformPreview;
    if (preview === undefined || preview.operation !== "rotate") {
      throw new Error("rotate preview missing");
    }
    expect(preview.axis).toBe("z");
    expect(preview.quarterTurns).toBe(1);
    // A 90-degree turn swaps the plane extents: 4x4x1 -> 4x4x1 here.
    expect(preview.entries[0]?.destination).toEqual({
      min: [0, 0, 0],
      max: [4, 4, 1],
    });
    // The same axis again advances to 180 degrees (source box).
    expect(harness.transform.previewRotate("z")).toEqual({ ok: true });
    preview = harness.editor.transformPreview;
    if (preview === undefined || preview.operation !== "rotate") {
      throw new Error("rotate preview missing");
    }
    expect(preview.quarterTurns).toBe(2);
    expect(preview.entries[0]?.destination).toEqual({
      min: [0, 0, 0],
      max: [4, 4, 1],
    });
    // And again to 270 degrees; a fourth click cycles back to 90.
    expect(harness.transform.previewRotate("z")).toEqual({ ok: true });
    preview = harness.editor.transformPreview;
    if (preview === undefined || preview.operation !== "rotate") {
      throw new Error("rotate preview missing");
    }
    expect(preview.quarterTurns).toBe(3);
    expect(harness.transform.previewRotate("z")).toEqual({ ok: true });
    preview = harness.editor.transformPreview;
    if (preview === undefined || preview.operation !== "rotate") {
      throw new Error("rotate preview missing");
    }
    expect(preview.quarterTurns).toBe(1);

    // Apply the 90-degree rotation as one labeled transaction.
    expect(harness.transform.applyPending()).toEqual({ ok: true });
    expect(labels(harness)).toEqual(["Rotate selection"]);
    expect(harness.bus.historySnapshot().past).toHaveLength(2);
    expect(harness.editor.transformPreview).toBeUndefined();
    const voxels = harness.voxels(VOLUME);
    // Rotating the L 90 degrees around z (exact lattice rotation):
    // (0,0,0)->(3,0,0), (1,0,0)->(3,1,0), (2,0,0)->(3,2,0), (2,1,0)->(2,2,0).
    expect(voxels.get("3,0,0")).toBe(MATERIAL);
    expect(voxels.get("3,1,0")).toBe(MATERIAL);
    expect(voxels.get("3,2,0")).toBe(MATERIAL);
    expect(voxels.get("2,2,0")).toBe(MATERIAL);
    expect(voxels.get("0,0,0")).toBeUndefined();
    expect(harness.occupied(VOLUME)).toBe(4);

    // Undo restores the original L and redo re-applies the rotation.
    const undo = harness.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    const restored = harness.voxels(VOLUME);
    expect(restored.get("0,0,0")).toBe(MATERIAL);
    expect(restored.get("2,1,0")).toBe(MATERIAL);
    expect(restored.get("3,2,0")).toBeUndefined();
    const redo = harness.bus.redo({
      transactionId: transactionId("transaction:test:redo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    expect(redo.ok).toBe(true);
    expect(harness.voxels(VOLUME).get("2,2,0")).toBe(MATERIAL);
    harness.transform.reset();
  });

  it("rotates around every axis and falls back to 180 degrees for parity mismatches", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]);
    // All odd extents: every axis rotates exactly.
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 3, 3] },
      },
    ]);
    harness.editor.setTransformMode("rotate");
    for (const axis of ["x", "y", "z"] as const) {
      expect(harness.transform.previewRotate(axis)).toEqual({ ok: true });
      const preview = harness.editor.transformPreview;
      if (preview === undefined || preview.operation !== "rotate") {
        throw new Error("rotate preview missing");
      }
      expect(preview.axis).toBe(axis);
      expect(preview.quarterTurns).toBe(1);
    }
    harness.transform.cancelPending();
    // A 1x2 region cannot rotate exactly by 90 degrees around z (extents
    // 1 and 2 have different parities), but 180 degrees is always exact:
    // the preview falls back to the 180-degree step instead of failing.
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [1, 2, 1] },
      },
    ]);
    expect(harness.transform.previewRotate("z")).toEqual({ ok: true });
    const fallback = harness.editor.transformPreview;
    if (fallback === undefined || fallback.operation !== "rotate") {
      throw new Error("rotate preview missing");
    }
    expect(fallback.quarterTurns).toBe(2);
    // 180 degrees keeps the source box as its destination.
    expect(fallback.entries[0]?.destination).toEqual({
      min: [0, 0, 0],
      max: [1, 2, 1],
    });
    // The 180-degree rotation commits one labeled transaction.
    expect(harness.transform.applyPending()).toEqual({ ok: true });
    expect(labels(harness)).toEqual(["Rotate selection"]);
    harness.transform.reset();
  });

  it("cancels the pending preview with zero side effects", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    const revision = harness.store.revision;
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 1, 1] },
      },
    ]);
    harness.editor.setTransformMode("rotate");
    const pastLength = harness.bus.historySnapshot().past.length;
    expect(harness.transform.previewRotate("y")).toEqual({ ok: true });
    expect(harness.editor.transformPreview).toBeDefined();
    harness.transform.cancelPending();
    expect(harness.editor.transformPreview).toBeUndefined();
    expect(harness.store.revision).toBe(revision);
    expect(harness.bus.historySnapshot().past).toHaveLength(pastLength);
    // Apply without a pending preview is a no-op.
    expect(harness.transform.applyPending()).toEqual({ ok: true });
    expect(harness.store.revision).toBe(revision);
    harness.transform.reset();
  });

  it("is a silent no-op for a selection with no occupied voxels", () => {
    const harness = createHarness();
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 3, 3] },
      },
    ]);
    harness.editor.setTransformMode("rotate");
    expect(harness.transform.previewRotate("x")).toEqual({ ok: true });
    expect(harness.editor.transformPreview).toBeUndefined();
    expect(harness.transform.applyPending()).toEqual({ ok: true });
    expect(harness.bus.historySnapshot().past).toHaveLength(0);
    harness.transform.reset();
  });
});

describe("transform mirror", () => {
  it("mirrors across every axis and mirroring twice is the identity", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 1, 1] },
      },
    ]);
    harness.editor.setTransformMode("mirror");
    expect(harness.transform.previewMirror("x")).toEqual({ ok: true });
    const preview = harness.editor.transformPreview;
    if (preview === undefined || preview.operation !== "mirror") {
      throw new Error("mirror preview missing");
    }
    expect(preview.axis).toBe("x");
    // The mirror stays inside the source region: affected bounds are the
    // region itself and nothing is overwritten or removed.
    expect(preview.entries[0]?.destination).toEqual({
      min: [0, 0, 0],
      max: [3, 1, 1],
    });
    expect(preview.overwrittenVoxels).toBe(0);
    expect(preview.removedVoxels).toBe(0);
    expect(harness.transform.applyPending()).toEqual({ ok: true });
    expect(labels(harness)).toEqual(["Mirror selection"]);
    let voxels = harness.voxels(VOLUME);
    // Mirror across the x plane through x = 1.5: 0 -> 2, 1 -> 1, 2 -> 0.
    expect(voxels.get("0,0,0")).toBe(MATERIAL);
    expect(voxels.get("2,0,0")).toBe(MATERIAL);
    expect(voxels.get("1,0,0")).toBe(MATERIAL);
    expect(harness.occupied(VOLUME)).toBe(3);

    // Mirroring again restores the original positions (identity).
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 1, 1] },
      },
    ]);
    expect(harness.transform.previewMirror("x")).toEqual({ ok: true });
    expect(harness.transform.applyPending()).toEqual({ ok: true });
    voxels = harness.voxels(VOLUME);
    expect(voxels.get("0,0,0")).toBe(MATERIAL);
    expect(voxels.get("2,0,0")).toBe(MATERIAL);

    // Mirror across y and z keep the content (it lies in the x row).
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 1, 1] },
      },
    ]);
    for (const axis of ["y", "z"] as const) {
      expect(harness.transform.previewMirror(axis)).toEqual({ ok: true });
      expect(harness.transform.applyPending()).toEqual({ ok: true });
    }
    expect(harness.occupied(VOLUME)).toBe(3);
    harness.transform.reset();
  });
});

describe("transform delete", () => {
  it("previews the removed count and commits one labeled transaction", () => {
    const harness = createHarness();
    setVoxels(harness, VOLUME, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    setVoxels(harness, VOLUME_B, [[0, 0, 0]]);
    harness.editor.setSelection([
      {
        kind: "region",
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 1, 1] },
      },
      { kind: "voxel", volumeId: VOLUME_B, voxel: [0, 0, 0] },
    ]);
    harness.editor.setTransformMode("delete");
    expect(harness.transform.previewDelete()).toEqual({ ok: true });
    const preview = harness.editor.transformPreview;
    if (preview === undefined || preview.operation !== "delete") {
      throw new Error("delete preview missing");
    }
    expect(preview.removedVoxels).toBe(4);
    expect(preview.movedVoxels).toBe(4);
    expect(preview.overwrittenVoxels).toBe(0);
    expect(harness.transform.applyPending()).toEqual({ ok: true });
    expect(labels(harness)).toEqual(["Delete selection"]);
    expect(harness.bus.historySnapshot().past).toHaveLength(3);
    expect(harness.occupied(VOLUME)).toBe(0);
    expect(harness.occupied(VOLUME_B)).toBe(0);
    // Undo restores every deleted voxel in one history entry.
    const undo = harness.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(harness.occupied(VOLUME)).toBe(3);
    expect(harness.occupied(VOLUME_B)).toBe(1);
    harness.transform.reset();
  });
});
