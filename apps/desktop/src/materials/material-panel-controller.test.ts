import { describe, expect, it } from "vitest";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import { createDocument, type MaterialRecordInput } from "@voxel-maker/model";
import {
  CommandBus,
  CommandRegistry,
  fillBoxCommand,
  registerBatchCommands,
  registerVoxelCommands,
} from "@voxel-maker/commands";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import {
  MemoryProjectStorage,
  type ProjectStoragePort,
} from "@voxel-maker/storage";
import { writeVxlProject } from "@voxel-maker/formats";
import {
  createDesktopComposition,
  type DesktopComposition,
  type FilePicker,
} from "../composition.js";
import { autoConfirmPrompts, requireResult } from "../test-prompts.js";
import type { MaterialPanelController } from "./material-panel-controller.js";

/**
 * Ticket #21 desktop tests (plan S7.13): the material panel controller
 * through the real composition — usage counts, create/update/delete with
 * mandatory reassignment, undo/redo, and save/reload preservation of
 * material semantics and voxel assignments. Every assertion runs through
 * the session command bus and the authoritative store, never through
 * mocks of the semantic layer.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:test:root");
const CHILD_A = nodeId("node:test:child-a");
const CHILD_B = nodeId("node:test:child-b");
const VOLUME_A = volumeId("volume:test:0001");
const VOLUME_B = volumeId("volume:test:0002");
const RED = materialId(1);
const BLUE = materialId(2);

/** Material record factory for fixtures. */
function material(
  id: MaterialId,
  name: string,
  color: string,
): MaterialRecordInput {
  return {
    materialId: id,
    name,
    color,
    opacity: 1,
    roughness: 0.5,
    metallic: 0,
    emissive: 0,
  };
}

/**
 * Builds a project with two volumes: a 4x4x4 box of material 1 in
 * volume A and a 2x2x2 box of material 2 in volume B (64 + 8 voxels).
 */
function buildFixtureProject(): Uint8Array {
  const document = createDocument({
    documentId: documentId("document:test:0001"),
    metadata: { title: "fixture-materials" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [CHILD_A, CHILD_B],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: CHILD_A,
        name: "Box A",
        parentId: ROOT,
        children: [],
        transform: IDENTITY,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME_A }],
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
      material(RED, "red", "#ff0000"),
      material(BLUE, "blue", "#0000ff"),
    ],
    volumes: [
      { volumeId: VOLUME_A, bounds: { min: [0, 0, 0], max: [8, 8, 8] } },
      { volumeId: VOLUME_B, bounds: { min: [0, 0, 0], max: [8, 8, 8] } },
    ],
  });
  const { store, writeCapability } = createDocumentStoreHandle({ document });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);
  const fill = (
    volume: VolumeId,
    region: {
      readonly min: readonly [number, number, number];
      readonly max: readonly [number, number, number];
    },
    materialValue: number,
  ): void => {
    const result = bus.execute(
      fillBoxCommand(commandId(`command:fixture:fill-${String(volume)}`), {
        volumeId: volume,
        region: {
          min: [...region.min] as [number, number, number],
          max: [...region.max] as [number, number, number],
        },
        material: materialId(materialValue),
      }),
      {
        transactionId: transactionId(
          `transaction:fixture:fill-${String(volume)}`,
        ),
        expectedRevision: store.revision,
        source: "system",
      },
    );
    if (!result.ok)
      throw new Error(`fixture fill failed: ${result.error.code}`);
  };
  fill(VOLUME_A, { min: [0, 0, 0], max: [4, 4, 4] }, 1);
  fill(VOLUME_B, { min: [0, 0, 0], max: [2, 2, 2] }, 2);
  const volumeA = store.getVolume(VOLUME_A);
  const volumeB = store.getVolume(VOLUME_B);
  if (volumeA === undefined || volumeB === undefined) {
    throw new Error("fixture volumes missing");
  }
  return writeVxlProject({
    document: store.getDocument(),
    volumes: new Map([
      [VOLUME_A, volumeA],
      [VOLUME_B, volumeB],
    ]),
  });
}

function createFakePicker(
  pickOpenPath: () => Promise<string | undefined>,
): FilePicker {
  return {
    pickOpenPath,
    pickSavePath(suggestedName) {
      return Promise.resolve(suggestedName);
    },
  };
}

interface Harness {
  readonly composition: DesktopComposition;
  readonly panel: MaterialPanelController;
  readonly storage: ProjectStoragePort;
  dispose(): void;
}

function createHarness(storage = new MemoryProjectStorage()): Harness {
  const composition = createDesktopComposition({
    storage,
    picker: createFakePicker(() => Promise.resolve(undefined)),
    prompts: autoConfirmPrompts,
  });
  return {
    composition,
    panel: composition.materialPanel,
    storage,
    dispose() {
      composition.dispose();
    },
  };
}

async function openFixture(harness: Harness): Promise<void> {
  const result = requireResult(
    await harness.composition.fileService.openLoadedProject(
      "fixture-materials.vxl",
      buildFixtureProject(),
    ),
  );
  expect(result.ok).toBe(true);
}

/** All nonzero material values across every volume of the open store. */
function allVoxelMaterials(harness: Harness): number[] {
  const store = harness.composition.session.current?.store;
  if (store === undefined) throw new Error("no open store");
  const values: number[] = [];
  for (const descriptor of Object.values(store.getDocument().volumes)) {
    const volume = store.getVolume(descriptor.volumeId);
    if (volume === undefined) continue;
    for (const chunk of volume.chunkCoordinates()) {
      const chunkValues = volume.getChunk(chunk);
      if (chunkValues === undefined) continue;
      for (let i = 0; i < chunkValues.length; i += 1) {
        const value = chunkValues[i];
        if (value !== undefined && value !== 0) values.push(value);
      }
    }
  }
  return values;
}

function entry(harness: Harness, id: MaterialId) {
  const found = harness.panel.state.entries.find(
    (candidate) => candidate.record.materialId === id,
  );
  if (found === undefined)
    throw new Error(`missing entry for material ${String(id)}`);
  return found;
}

describe("material panel controller", () => {
  it("lists materials with live usage counts when a document opens", async () => {
    const harness = createHarness();
    await openFixture(harness);
    const state = harness.panel.state;
    expect(state.open).toBe(true);
    expect(
      state.entries.map((entryValue) => entryValue.record.materialId),
    ).toEqual([RED, BLUE]);
    expect(entry(harness, RED).usage).toBe(64);
    expect(entry(harness, BLUE).usage).toBe(8);
    expect(state.activeMaterial).toBe(RED); // composition default: lowest id
    expect(state.canCreate).toBe(true);
    expect(state.canUndo).toBe(false);
    harness.dispose();
  });

  it("createMaterial commits one transaction and activates the new material", async () => {
    const harness = createHarness();
    await openFixture(harness);
    const revisionBefore =
      harness.composition.session.current?.store.revision ?? 0;
    const error = harness.panel.createMaterial();
    expect(error).toBeUndefined();
    const created = entry(harness, materialId(3));
    expect(created.record.name).toBe("Material 3");
    expect(created.record.color).toBe("#808080");
    expect(created.record.opacity).toBe(1);
    expect(created.record.roughness).toBe(0.5);
    expect(created.record.metallic).toBe(0);
    expect(created.record.emissive).toBe(0);
    expect(created.usage).toBe(0);
    expect(harness.composition.session.current?.store.revision).toBe(
      revisionBefore + 1,
    );
    expect(harness.panel.state.activeMaterial).toBe(materialId(3));
    expect(harness.panel.state.canUndo).toBe(true);
    harness.dispose();
  });

  it("updateMaterial edits every canonical field through commands", async () => {
    const harness = createHarness();
    await openFixture(harness);
    const revisionBefore =
      harness.composition.session.current?.store.revision ?? 0;

    expect(
      harness.panel.updateMaterial(RED, {
        name: "crimson",
        color: "#FF2040",
        opacity: 0.5,
        roughness: 0.9,
        metallic: 0.25,
        emissive: 0.1,
      }),
    ).toBeUndefined();
    const updated = entry(harness, RED).record;
    expect(updated.name).toBe("crimson");
    expect(updated.color).toBe("#ff2040"); // canonicalized lowercase
    expect(updated.opacity).toBe(0.5);
    expect(updated.roughness).toBe(0.9);
    expect(updated.metallic).toBe(0.25);
    expect(updated.emissive).toBe(0.1);
    expect(harness.composition.session.current?.store.revision).toBe(
      revisionBefore + 1,
    );

    // An unchanged blur commits nothing.
    const before = harness.composition.session.current?.store.revision ?? 0;
    expect(
      harness.panel.updateMaterial(RED, { name: "crimson", color: "#ff2040" }),
    ).toBeUndefined();
    expect(harness.composition.session.current?.store.revision).toBe(before);
    harness.dispose();
  });

  it("updateMaterial rejects a missing material without committing", async () => {
    const harness = createHarness();
    await openFixture(harness);
    const revisionBefore =
      harness.composition.session.current?.store.revision ?? 0;
    const error = harness.panel.updateMaterial(materialId(99), {
      name: "ghost",
    });
    expect(error?.code).toBe("MISSING_MATERIAL");
    expect(harness.composition.session.current?.store.revision).toBe(
      revisionBefore,
    );
    expect(
      harness.composition.editor.notices.some((notice) =>
        notice.message.includes("99"),
      ),
    ).toBe(true);
    harness.dispose();
  });

  it("deleteMaterial removes an unreferenced material directly", async () => {
    const harness = createHarness();
    await openFixture(harness);
    const revisionBefore =
      harness.composition.session.current?.store.revision ?? 0;
    // The fixture's materials are both referenced, so first create an
    // unreferenced material and then delete it directly.
    expect(harness.panel.createMaterial()).toBeUndefined();
    const created = materialId(3);
    expect(entry(harness, created).usage).toBe(0);
    const error = harness.panel.deleteMaterial(created);
    expect(error).toBeUndefined();
    expect(
      harness.panel.state.entries.some(
        (entryValue) => entryValue.record.materialId === created,
      ),
    ).toBe(false);
    expect(harness.composition.session.current?.store.revision).toBe(
      revisionBefore + 2,
    );
    harness.dispose();
  });

  it("referenced deletion requires a valid reassignment", async () => {
    const harness = createHarness();
    await openFixture(harness);

    // Without a replacement the delete is rejected atomically.
    const revisionBefore =
      harness.composition.session.current?.store.revision ?? 0;
    const rejected = harness.panel.deleteMaterial(RED);
    expect(rejected?.code).toBe("REFERENCED_MATERIAL");
    expect(harness.composition.session.current?.store.revision).toBe(
      revisionBefore,
    );
    expect(entry(harness, RED).usage).toBe(64);
    expect(
      harness.composition.editor.notices.some(
        (notice) => notice.level === "error",
      ),
    ).toBe(true);

    // With a replacement the voxels remap and the record is removed in
    // one transaction; no voxel can dangle.
    const error = harness.panel.deleteMaterial(RED, BLUE);
    expect(error).toBeUndefined();
    expect(
      harness.panel.state.entries.some(
        (entryValue) => entryValue.record.materialId === RED,
      ),
    ).toBe(false);
    expect(entry(harness, BLUE).usage).toBe(72);
    expect(allVoxelMaterials(harness)).toEqual(
      Array.from({ length: 72 }, () => 2),
    );
    expect(harness.composition.session.current?.store.revision).toBe(
      revisionBefore + 1,
    );
    harness.dispose();
  });

  it("undo and redo preserve material semantics and voxel assignments", async () => {
    const harness = createHarness();
    await openFixture(harness);

    // A referenced deletion with reassignment undoes as one unit.
    expect(harness.panel.deleteMaterial(RED, BLUE)).toBeUndefined();
    expect(entry(harness, BLUE).usage).toBe(72);

    expect(harness.panel.undo()).toBeUndefined();
    expect(entry(harness, RED).usage).toBe(64);
    expect(entry(harness, BLUE).usage).toBe(8);
    expect(allVoxelMaterials(harness).sort()).toEqual([
      ...Array.from({ length: 64 }, () => 1),
      ...Array.from({ length: 8 }, () => 2),
    ]);

    expect(harness.panel.redo()).toBeUndefined();
    expect(
      harness.panel.state.entries.some(
        (entryValue) => entryValue.record.materialId === RED,
      ),
    ).toBe(false);
    expect(entry(harness, BLUE).usage).toBe(72);

    // A create undoes and redoes as one unit too. RED (id 1) is deleted
    // by the redo above, but the allocator never reuses an id a reachable
    // history entry can mention (ARCHITECTURE.md "Materials"), so the
    // fresh material gets id 3, not 1.
    expect(harness.panel.createMaterial()).toBeUndefined();
    expect(entry(harness, materialId(3)).record.name).toBe("Material 3");
    expect(harness.panel.undo()).toBeUndefined();
    expect(
      harness.panel.state.entries.some(
        (entryValue) => entryValue.record.materialId === materialId(3),
      ),
    ).toBe(false);
    expect(harness.panel.redo()).toBeUndefined();
    expect(entry(harness, materialId(3)).record.name).toBe("Material 3");
    harness.dispose();
  });

  it("never reuses a material id while history can mention it", async () => {
    const harness = createHarness();
    await openFixture(harness);

    // Delete id 1 (referenced, with reassignment): id 1 is now free in
    // the live table, but the delete stays reachable in the undo stack.
    expect(harness.panel.deleteMaterial(RED, BLUE)).toBeUndefined();
    expect(
      harness.panel.state.entries.some(
        (entryValue) => entryValue.record.materialId === RED,
      ),
    ).toBe(false);

    // Creating a material allocates id 3 (strictly above every id seen
    // this session), never the freed id 1.
    expect(harness.panel.createMaterial()).toBeUndefined();
    const created = entry(harness, materialId(3));
    expect(created.record.name).toBe("Material 3");
    expect(created.record.materialId).toBe(materialId(3));

    // Undoing the create frees id 3, but the next create still climbs:
    // the undone create is itself reachable in the redo stack.
    expect(harness.panel.undo()).toBeUndefined();
    expect(harness.panel.createMaterial()).toBeUndefined();
    expect(entry(harness, materialId(4)).record.name).toBe("Material 4");
    harness.dispose();
  });

  it("rejects a malformed color update with a structured error", async () => {
    const harness = createHarness();
    await openFixture(harness);
    const revisionBefore =
      harness.composition.session.current?.store.revision ?? 0;
    const error = harness.panel.updateMaterial(RED, { color: "not-a-color" });
    expect(error?.code).toBe("INVALID_COLOR");
    expect(harness.composition.session.current?.store.revision).toBe(
      revisionBefore,
    );
    expect(entry(harness, RED).record.color).toBe("#ff0000");
    expect(
      harness.composition.editor.notices.some(
        (notice) => notice.level === "error",
      ),
    ).toBe(true);
    harness.dispose();
  });

  it("history flags track undo/redo availability", async () => {
    const harness = createHarness();
    await openFixture(harness);
    expect(harness.panel.state.canUndo).toBe(false);
    expect(harness.panel.state.canRedo).toBe(false);

    expect(
      harness.panel.updateMaterial(RED, { name: "crimson" }),
    ).toBeUndefined();
    expect(harness.panel.state.canUndo).toBe(true);
    expect(harness.panel.state.canRedo).toBe(false);

    expect(harness.panel.undo()).toBeUndefined();
    expect(entry(harness, RED).record.name).toBe("red");
    expect(harness.panel.state.canUndo).toBe(false);
    expect(harness.panel.state.canRedo).toBe(true);

    const error = harness.panel.undo();
    expect(error?.code).toBe("NOTHING_TO_UNDO");
    expect(harness.panel.state.canRedo).toBe(true);
    harness.dispose();
  });

  it("save and reload preserve material semantics and voxel assignments", async () => {
    const harness = createHarness();
    await openFixture(harness);

    // Material edits: create, rename/recolor, and a referenced deletion
    // with reassignment that remaps every voxel.
    expect(harness.panel.createMaterial()).toBeUndefined();
    expect(
      harness.panel.updateMaterial(RED, {
        name: "crimson",
        color: "#ff2040",
        emissive: 0.2,
      }),
    ).toBeUndefined();
    expect(harness.panel.deleteMaterial(BLUE, materialId(3))).toBeUndefined();

    const saved = await harness.composition.fileService.saveProject();
    expect(saved?.ok).toBe(true);
    if (saved?.path === undefined) throw new Error("save produced no path");
    const bytes = await harness.storage.readProject(saved.path);

    // Reload into a fresh composition and compare the semantic state.
    const reloaded = createHarness();
    const opened = requireResult(
      await reloaded.composition.fileService.openLoadedProject(
        "reload.vxl",
        bytes,
      ),
    );
    expect(opened.ok).toBe(true);
    expect(
      reloaded.panel.state.entries.map(
        (entryValue) => entryValue.record.materialId,
      ),
    ).toEqual([RED, materialId(3)]);
    expect(entry(reloaded, RED).record).toEqual(entry(harness, RED).record);
    expect(entry(reloaded, materialId(3)).record).toEqual(
      entry(harness, materialId(3)).record,
    );
    expect(entry(reloaded, RED).usage).toBe(64);
    expect(entry(reloaded, materialId(3)).usage).toBe(8);
    expect(allVoxelMaterials(reloaded)).toEqual(allVoxelMaterials(harness));
    reloaded.dispose();
    harness.dispose();
  });

  it("tracks external commits and resets on lifecycle replacement", async () => {
    const harness = createHarness();
    await openFixture(harness);

    // An external voxel edit updates the usage counts through the store
    // subscription.
    const store = harness.composition.session.current?.store;
    const revision = store?.revision ?? 0;
    const fill = harness.composition.session.current?.bus.execute(
      fillBoxCommand(commandId("command:test:external-fill"), {
        volumeId: VOLUME_A,
        region: { min: [4, 0, 0], max: [6, 1, 1] },
        material: BLUE,
      }),
      {
        transactionId: transactionId("transaction:test:external-fill"),
        expectedRevision: revision,
        source: "ui",
      },
    );
    expect(fill?.ok).toBe(true);
    expect(entry(harness, BLUE).usage).toBe(10);

    // Closing the document empties the panel.
    const closed = requireResult(
      await harness.composition.fileService.closeProject(),
    );
    expect(closed.ok).toBe(true);
    expect(harness.panel.state.open).toBe(false);
    expect(harness.panel.state.entries).toEqual([]);
    expect(harness.panel.state.canCreate).toBe(false);
    harness.dispose();
  });

  it("paintWith switches the runtime paint material", async () => {
    const harness = createHarness();
    await openFixture(harness);
    harness.panel.paintWith(BLUE);
    expect(harness.composition.editor.activeMaterial).toBe(BLUE);
    // A stale id is a no-op.
    harness.panel.paintWith(materialId(99));
    expect(harness.composition.editor.activeMaterial).toBe(BLUE);
    harness.dispose();
  });

  it("refuses creation at the document material limit", async () => {
    const harness = createHarness();
    const document = createDocument({
      documentId: documentId("document:test:limit"),
      metadata: { title: "limit" },
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [],
          transform: IDENTITY,
          components: [],
        },
      ],
      materials: Array.from({ length: 4096 }, (_, index) =>
        material(materialId(index + 1), `m${String(index + 1)}`, "#808080"),
      ),
      volumes: [],
    });
    const result = requireResult(
      await harness.composition.fileService.openLoadedProject(
        "limit.vxl",
        writeVxlProject({ document, volumes: new Map() }),
      ),
    );
    expect(result.ok).toBe(true);
    expect(harness.panel.state.canCreate).toBe(false);
    const error = harness.panel.createMaterial();
    expect(error?.code).toBe("LIMIT_EXCEEDED");
    harness.dispose();
  });

  it("panel actions without an open document fail cleanly", () => {
    const harness = createHarness();
    expect(harness.panel.state.open).toBe(false);
    expect(harness.panel.createMaterial()?.code).toBe("SESSION_NOT_OPEN");
    expect(harness.panel.updateMaterial(RED, { name: "x" })?.code).toBe(
      "SESSION_NOT_OPEN",
    );
    expect(harness.panel.deleteMaterial(RED)?.code).toBe("SESSION_NOT_OPEN");
    expect(harness.panel.undo()?.code).toBe("SESSION_NOT_OPEN");
    expect(harness.panel.redo()?.code).toBe("SESSION_NOT_OPEN");
    harness.dispose();
  });
});
