import { describe, expect, it } from "vitest";
import { materialId, nodeId, transactionId } from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
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
import type { VoxColor, VoxModel } from "@voxel-maker/formats";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import { importVox } from "./import-vox.js";
import { exportVox } from "./export-vox.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:roundtrip:root");

const palette: VoxColor[] = [
  { r: 0, g: 0, b: 0, a: 0 },
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 255, b: 0, a: 255 },
  ...Array.from({ length: 253 }, () => ({ r: 0, g: 0, b: 0, a: 255 })),
];

const sourceModel: VoxModel = {
  sizeX: 3,
  sizeY: 2,
  sizeZ: 2,
  voxels: [
    { x: 0, y: 0, z: 0, colorIndex: 1 },
    { x: 1, y: 0, z: 0, colorIndex: 1 },
    { x: 2, y: 0, z: 0, colorIndex: 2 },
    { x: 0, y: 1, z: 0, colorIndex: 2 },
    { x: 1, y: 1, z: 0, colorIndex: 1 },
    { x: 0, y: 0, z: 1, colorIndex: 1 },
    { x: 2, y: 1, z: 1, colorIndex: 2 },
  ],
};

describe("VOX round trip through the interchange service", () => {
  it("preserves coordinates and colors across import -> export -> parse", async () => {
    // 1. Start with an empty open document.
    const document: VoxelDocument = createDocument({
      documentId: "document:roundtrip:0001" as never,
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
    const { store, writeCapability } = createDocumentStoreHandle({ document });
    const registry = new CommandRegistry();
    registerVoxelCommands(registry);
    registerBatchCommands(registry);
    registerRegionCommands(registry);
    registerNodeCommands(registry);
    registerMaterialCommands(registry);
    registerVolumeCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);

    // 2. Import a known VOX file.
    const sourceBytes = encodeVox({ models: [sourceModel], palette });
    const imported = importVox(bus, store, {
      bytes: sourceBytes,
      expectedRevision: 0,
      transactionId: transactionId("transaction:roundtrip:import:0001"),
    });
    expect(imported.voxelsImported).toBe(sourceModel.voxels.length);

    // 3. Export the imported document back to VOX.
    const storage = new MemoryProjectStorage();
    const exported = await exportVox({
      document: store.getDocument(),
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "roundtrip.vox",
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      console.log("BLOCKED", JSON.stringify(exported.blocked));
      return;
    }
    const parsed = parseVox(exported.bytes);

    // 4. Coordinates and colors survive the round trip: the exported model
    //    equals the source model (voxel order is canonical in both).
    const model = parsed.models[0];
    expect(model?.sizeX).toBe(sourceModel.sizeX);
    expect(model?.sizeY).toBe(sourceModel.sizeY);
    expect(model?.sizeZ).toBe(sourceModel.sizeZ);
    expect(model?.voxels).toEqual(
      [...sourceModel.voxels].sort(
        (a, b) =>
          a.x - b.x || a.y - b.y || a.z - b.z || a.colorIndex - b.colorIndex,
      ),
    );
    expect(parsed.palette[1]).toEqual(palette[1]);
    expect(parsed.palette[2]).toEqual(palette[2]);
    expect(parsed.warnings).toEqual([]);

    // 5. Re-importing the exported bytes yields the same content in a
    //    fresh id namespace.
    const second = importVox(bus, store, {
      bytes: exported.bytes,
      expectedRevision: imported.revisionAfter,
      transactionId: transactionId("transaction:roundtrip:import:0002"),
    });
    expect(second.nodesCreated).toBe(1);
    const secondNode =
      store.getDocument().nodes[nodeId("node:import:0001:001")] ??
      store.getDocument().nodes[nodeId("node:import:0002")];
    expect(secondNode).toBeDefined();
    const component = secondNode?.components.find(
      (candidate) => candidate.kind === "voxel",
    );
    expect(component?.kind).toBe("voxel");
    if (component?.kind !== "voxel") return;
    expect(store.getVoxel(component.volumeId, [0, 0, 0])).toBe(materialId(1));
    expect(store.getVoxel(component.volumeId, [2, 0, 0])).toBe(materialId(2));
  });
});
