import { describe, expect, it } from "vitest";
import {
  commandId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  canonicalColor,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { createDocumentStore } from "@voxel-maker/document";
import {
  CommandBus,
  CommandRegistry,
  registerBatchCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
  registerVolumeCommands,
} from "@voxel-maker/commands";
import { encodeVox, parseVox } from "@voxel-maker/formats";
import type { VoxColor, VoxModel, VoxVoxel } from "@voxel-maker/formats";
import { importVox, MAX_IMPORT_ENTRIES_PER_COMMAND } from "./import-vox.js";

/** Asserts that `fn` throws a WorkspaceError with the given code. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    const candidate = error as { code?: unknown };
    expect(candidate.code).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code} to be thrown`);
}

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:import:root");

function baseDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:import:0001" as never,
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [],
        transform: identity,
        components: [],
      },
    ],
    materials: [],
    volumes: [],
  });
}

function harness(document: VoxelDocument = baseDocument()) {
  const { store, writeCapability } = createDocumentStore({ document });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  registerRegionCommands(registry);
  registerNodeCommands(registry);
  registerMaterialCommands(registry);
  registerVolumeCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);
  return { store, bus };
}

const palette: VoxColor[] = [
  { r: 0, g: 0, b: 0, a: 0 },
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 255, b: 0, a: 255 },
  ...Array.from({ length: 253 }, () => ({ r: 0, g: 0, b: 0, a: 255 })),
];

const cube: VoxModel = {
  sizeX: 2,
  sizeY: 2,
  sizeZ: 2,
  voxels: [
    { x: 0, y: 0, z: 0, colorIndex: 1 },
    { x: 1, y: 0, z: 0, colorIndex: 1 },
    { x: 0, y: 1, z: 0, colorIndex: 2 },
    { x: 1, y: 1, z: 0, colorIndex: 2 },
  ],
};

describe("importVox", () => {
  it("imports a file into the open document through one transaction", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    const outcome = importVox(bus, store, {
      bytes,
      expectedRevision: 0,
      transactionId: transactionId("transaction:import:test:0001"),
    });
    expect(outcome.revisionAfter).toBe(1);
    expect(outcome.nodesCreated).toBe(1);
    expect(outcome.volumesCreated).toBe(1);
    expect(outcome.materialsCreated).toBe(2);
    expect(outcome.voxelsImported).toBe(4);

    const document = store.getDocument();
    expect(Object.keys(document.nodes)).toHaveLength(2);
    const imported = document.nodes[nodeId("node:import:0001")];
    expect(imported?.name).toBe("Model 1");
    expect(imported?.parentId).toBe(ROOT);
    expect(imported?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: "volume:import:0001" },
    ]);
    expect(document.materials[materialId(1)]?.color).toBe("#ff0000");
    expect(document.materials[materialId(2)]?.color).toBe("#00ff00");
    // Axis mapping: vox (1, 0, 0) -> editor (1, 0, 0); vox (0, 1, 0) -> (0, 0, -1).
    expect(store.getVoxel(volumeId("volume:import:0001"), [1, 0, 0])).toBe(1);
    expect(store.getVoxel(volumeId("volume:import:0001"), [0, 0, -1])).toBe(2);
    expect(store.getVoxel(volumeId("volume:import:0001"), [1, 0, -1])).toBe(2);
  });

  it("rejects malformed files without changing state", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    bytes[0] = 0x58; // corrupt magic
    const before = store.getDocument();
    expectCode(
      () => importVox(bus, store, { bytes, expectedRevision: 0 }),
      "VOX_INVALID_MAGIC",
    );
    expect(store.revision).toBe(0);
    expect(store.getDocument()).toEqual(before);
  });

  it("rejects stale revisions with REVISION_CONFLICT", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    expectCode(
      () => importVox(bus, store, { bytes, expectedRevision: 5 }),
      "REVISION_CONFLICT",
    );
    expect(store.revision).toBe(0);
  });

  it("reuses identical existing materials and avoids id collisions", () => {
    const document = createDocument({
      documentId: "document:import:0002" as never,
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [],
          transform: identity,
          components: [],
        },
      ],
      materials: [
        {
          materialId: materialId(1),
          name: "occupied",
          color: "#00ff00",
          opacity: 1,
          roughness: 0,
          metallic: 0,
          emissive: 0,
        },
      ],
      volumes: [],
    });
    const { store, bus } = harness(document);
    const bytes = encodeVox({ models: [cube], palette });
    const outcome = importVox(bus, store, { bytes, expectedRevision: 0 });
    // Palette index 1 (#ff0000) has no conflict; palette index 2 (#00ff00)
    // matches the existing material and is reused.
    expect(outcome.materialsCreated).toBe(1);
    expect(document.materials[materialId(1)]?.name).toBe("occupied");
    expect(store.getDocument().materials[materialId(2)]?.color).toBe("#ff0000");
    // Palette index 2 reuses existing material 1 (#00ff00); palette index 1
    // is remapped to material 2 (#ff0000).
    expect(store.getVoxel(volumeId("volume:import:0001"), [0, 0, 0])).toBe(
      materialId(2),
    );
  });

  it("remaps colliding palette ids to free material ids", () => {
    const document = createDocument({
      documentId: "document:import:0003" as never,
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [],
          transform: identity,
          components: [],
        },
      ],
      materials: [
        {
          materialId: materialId(1),
          name: "different red",
          color: "#ff8800",
          opacity: 1,
          roughness: 0,
          metallic: 0,
          emissive: 0,
        },
      ],
      volumes: [],
    });
    const { store, bus } = harness(document);
    const bytes = encodeVox({ models: [cube], palette });
    const outcome = importVox(bus, store, { bytes, expectedRevision: 0 });
    expect(outcome.materialsCreated).toBe(2);
    // Palette index 1 collides; it must be remapped to a free id (2),
    // and the imported voxels must reference the remapped material.
    const imported = store.getDocument().nodes[nodeId("node:import:0001")];
    const volumeIdValue = (
      imported?.components.find((c) => c.kind === "voxel") as
        | { kind: "voxel"; volumeId: VolumeId }
        | undefined
    )?.volumeId;
    expect(volumeIdValue).toBeDefined();
    expect(store.getVoxel(volumeIdValue as VolumeId, [0, 0, 0])).toBe(
      materialId(2),
    );
  });

  it("splits large volumes across volume.create commands in one transaction", () => {
    const { store, bus } = harness();
    // A model with more entries than one command can carry.
    const size = 64;
    const voxels: VoxVoxel[] = [];
    for (let z = 0; z < size; z += 1) {
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < 16; x += 1) {
          voxels.push({ x, y, z, colorIndex: 1 });
        }
      }
    }
    expect(voxels.length).toBeGreaterThan(MAX_IMPORT_ENTRIES_PER_COMMAND);
    const bytes = encodeVox({ models: [{ sizeX: 16, sizeY: size, sizeZ: size, voxels }], palette });
    const outcome = importVox(bus, store, { bytes, expectedRevision: 0 });
    expect(outcome.voxelsImported).toBe(voxels.length);
    expect(outcome.volumesCreated).toBe(1);
    const volume = store.getVolume(volumeId("volume:import:0001"));
    expect(volume?.occupiedCount()).toBe(voxels.length);
    expect(store.revision).toBe(1); // exactly one transaction
  });

  it("cancels before commit without side effects", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    const controller = new AbortController();
    controller.abort();
    expectCode(
      () =>
        importVox(bus, store, {
          bytes,
          expectedRevision: 0,
          signal: controller.signal,
        }),
      "IMPORT_CANCELLED",
    );
    expect(store.revision).toBe(0);
  });

  it("reports progress stages", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    const stages: string[] = [];
    importVox(bus, store, {
      bytes,
      expectedRevision: 0,
      onProgress: (stage) => {
        stages.push(stage);
      },
    });
    expect(stages).toEqual(["parse", "commit"]);
  });

  it("supports undo of the whole import", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    const outcome = importVox(bus, store, {
      bytes,
      expectedRevision: 0,
      transactionId: transactionId("transaction:import:undo:0001"),
    });
    const undo = bus.undo({
      transactionId: transactionId("transaction:import:undo:0001:undo"),
      expectedRevision: outcome.revisionAfter,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(store.revision).toBe(2); // undo commits one transaction
    expect(Object.keys(store.getDocument().nodes)).toHaveLength(1);
    expect(store.getVolume(volumeId("volume:import:0001"))).toBeUndefined();
    const redo = bus.redo({
      transactionId: transactionId("transaction:import:undo:0001:redo"),
      expectedRevision: 2,
      source: "ui",
    });
    expect(redo.ok).toBe(true);
    expect(store.getVolume(volumeId("volume:import:0001"))?.occupiedCount()).toBe(4);
  });

  it("round-trips through the codec with identical semantics", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    importVox(bus, store, { bytes, expectedRevision: 0 });
    const document = store.getDocument();
    const volume = store.getVolume(volumeId("volume:import:0001"));
    // Re-encode the imported volume through the export pipeline and parse it.
    const materialColors = Object.fromEntries(
      Object.entries(document.materials).map(([id, material]) => [
        Number(id),
        material.color,
      ]),
    );
    void materialColors;
    const exportedPalette: VoxColor[] = [palette[0] as VoxColor];
    const indexMap = new Map<number, number>();
    for (let index = 1; index <= 255; index += 1) {
      const color = palette[index];
      const entry =
        color === undefined
          ? { r: 0, g: 0, b: 0, a: 255 }
          : color;
      exportedPalette.push(entry);
      if (index === 1 || index === 2) indexMap.set(index, index);
    }
    void indexMap;
    const exportedModel: {
      sizeX: number;
      sizeY: number;
      sizeZ: number;
      voxels: VoxVoxel[];
    } = {
      sizeX: 2,
      sizeY: 2,
      sizeZ: 2,
      voxels: [],
    };
    if (volume !== undefined) {
      for (const coordinate of volume.chunkCoordinates()) {
        const chunk = volume.getChunk(coordinate);
        if (chunk === undefined) continue;
        for (let i = 0; i < chunk.length; i += 1) {
          const material = chunk[i] as number;
          if (material === 0) continue;
          const local = [
            i % 16,
            Math.floor(i / 16) % 16,
            Math.floor(i / 256),
          ];
          exportedModel.voxels.push({
            x: (coordinate[0] as number) * 16 + (local[0] as number),
            y: -((coordinate[2] as number) * 16 + (local[2] as number)),
            z: (coordinate[1] as number) * 16 + (local[1] as number),
            colorIndex: material,
          });
        }
      }
    }
    const reencoded = encodeVox({
      models: [exportedModel],
      palette: exportedPalette,
    });
    const reparsed = parseVox(reencoded);
    expect([...reparsed.models[0]?.voxels ?? []].sort()).toEqual(
      [...cube.voxels].sort((a, b) =>
        a.x - b.x || a.y - b.y || a.z - b.z || a.colorIndex - b.colorIndex,
      ),
    );
    void commandId;
    void canonicalColor;
  });
});
