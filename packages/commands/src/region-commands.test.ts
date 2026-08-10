import { describe, expect, it } from "vitest";
import {
  commandId,
  materialId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { type DocumentStoreRead } from "@voxel-maker/document";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import { registerVoxelCommands, setVoxelCommand } from "./voxel-commands.js";
import { fillBoxCommand, registerBatchCommands } from "./batch-commands.js";
import {
  VOXEL_COPY_REGION_COMMAND,
  VOXEL_DELETE_REGION_COMMAND,
  VOXEL_MIRROR_REGION_COMMAND,
  VOXEL_ROTATE_REGION_COMMAND,
  VOXEL_TRANSLATE_REGION_COMMAND,
  copyRegionCommand,
  deleteRegionCommand,
  mirrorRegionCommand,
  registerRegionCommands,
  rotateRegionCommand,
  translateRegionCommand,
} from "./region-commands.js";
import {
  commandKey,
  runCommandConformanceSuite,
  type CommandConformanceSpec,
} from "./conformance.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const VOLUME = volumeId("volume:region:0001");
const MATERIAL_ONE = materialId(1);
const MATERIAL_TWO = materialId(2);

function createRegionDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:region:0001" as never,
    metadata: { title: "region commands", tags: [] },
    rootNodeId: "node:region:root" as never,
    nodes: [
      {
        nodeId: "node:region:root" as never,
        name: "Root",
        parentId: null,
        children: [],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: VOLUME,
          },
        ],
      },
    ],
    materials: [
      {
        materialId: MATERIAL_ONE,
        name: "one",
        color: "#ff8800",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
      {
        materialId: MATERIAL_TWO,
        name: "two",
        color: "#0088ff",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: VOLUME,
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    ],
  });
}

function createHarness(): {
  bus: CommandBus;
  store: DocumentStoreRead;
} {
  const { store, writeCapability } = createDocumentStoreHandle({
    document: createRegionDocument(),
  });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  registerRegionCommands(registry);
  return {
    bus: new CommandBus(store, registry, writeCapability),
    store,
  };
}

const tx = (
  id: string,
  expectedRevision: number,
): import("./types.js").TransactionOptions => ({
  transactionId: transactionId(`transaction:region:${id}`),
  expectedRevision,
  source: "ui",
});

const voxelAt = (
  store: DocumentStoreRead,
  coordinate: readonly [number, number, number],
) => store.getVoxel(VOLUME, coordinate);

/** Seeds the 2x1x2 quad fixture with four distinct materials. */
function seedQuad(bus: CommandBus, store: DocumentStoreRead): void {
  const result = bus.execute(
    fillBoxCommand(commandId("command:region:seed:0001"), {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [2, 1, 2] },
      material: MATERIAL_ONE,
    }),
    tx("seed:0001", store.revision),
  );
  if (!result.ok) throw new Error(`seed failed: ${result.error.code}`);
}

describe("region command constructors", () => {
  it("canonicalize payloads and reject invalid input", () => {
    const id = commandId("command:region:ctor:0001");
    expect(
      translateRegionCommand(id, {
        volumeId: VOLUME,
        region: { min: [-2, -1, -1], max: [0, 0, 1] },
        delta: [3, 2, -4],
      }).payload,
    ).toEqual({
      volumeId: VOLUME,
      region: { min: [-2, -1, -1], max: [0, 0, 1] },
      delta: [3, 2, -4],
    });
    expect(() =>
      rotateRegionCommand(id, {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 1, 1] },
        axis: "y",
        quarterTurns: 1,
      }),
    ).toThrow(/parity/u);
    expect(() =>
      rotateRegionCommand(id, {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 1, 2] },
        axis: "y",
        quarterTurns: 4 as never,
      }),
    ).toThrow(/quarterTurns/u);
    expect(() =>
      mirrorRegionCommand(id, {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 1, 2] },
        axis: "diagonal" as never,
      }),
    ).toThrow(/Axis/u);
    expect(() =>
      copyRegionCommand(id, {
        volumeId: VOLUME,
        source: { min: [0, 0, 0], max: [2, 1, 2] },
        destination: [0.5, 0, 0],
      }),
    ).toThrow(/integer/u);
  });
});

describe("voxel.translateRegion", () => {
  it("moves a region, reports a compact change set, and undoes exactly", () => {
    const { bus, store } = createHarness();
    seedQuad(bus, store);
    const result = bus.execute(
      translateRegionCommand(commandId("command:region:tr:0001"), {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 1, 2] },
        delta: [3, 2, -4],
      }),
      tx("tr:0001", 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [3, 2, -4])).toBe(1);
    expect(voxelAt(store, [4, 2, -4])).toBe(1);
    expect(voxelAt(store, [3, 2, -3])).toBe(1);
    expect(voxelAt(store, [4, 2, -3])).toBe(1);
    expect(result.value.event.changedVolumes[0]?.chunks).toHaveLength(2);

    const undone = bus.undo(tx("tr:undo:0001", 2));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [3, 2, -4])).toBe(0);
  });

  it("rejects a destination outside the coordinate domain at execution", () => {
    const { bus, store } = createHarness();
    seedQuad(bus, store);
    const result = bus.execute(
      translateRegionCommand(commandId("command:region:tr:0002"), {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 1, 2] },
        delta: [1_048_575, 0, 0],
      }),
      tx("tr:0002", 1),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REGION_OUT_OF_BOUNDS");
    expect(store.revision).toBe(1);
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
  });

  it("accepts a delta beyond the coordinate domain when the destination is valid", () => {
    const { bus, store } = createHarness();
    const seeded = bus.execute(
      setVoxelCommand(commandId("command:region:seed:big:0001"), {
        volumeId: VOLUME,
        coordinate: [-1_048_575, 0, 0],
        material: MATERIAL_ONE,
      }),
      tx("seed:big:0001", 0),
    );
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const moved = bus.execute(
      translateRegionCommand(commandId("command:region:big:0001"), {
        volumeId: VOLUME,
        region: { min: [-1_048_575, 0, 0], max: [-1_048_573, 1, 1] },
        delta: [1_048_575, 0, 0],
      }),
      tx("big:0001", 1),
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(voxelAt(store, [-1_048_575, 0, 0])).toBe(0);
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
  });

  it("rejects a delta beyond the maximum possible translation at parse", () => {
    const { bus, store } = createHarness();
    const result = bus.execute(
      {
        id: commandId("command:region:tr:0003"),
        type: VOXEL_TRANSLATE_REGION_COMMAND,
        schemaVersion: 1,
        payload: {
          volumeId: VOLUME,
          region: { min: [0, 0, 0], max: [2, 1, 1] },
          delta: [2_097_152, 0, 0],
        },
      },
      tx("tr:0003", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_VOXEL_COORDINATE");
    expect(store.revision).toBe(0);
  });
});

describe("voxel.rotateRegion", () => {
  it("rotates a region and undoes exactly", () => {
    const { bus, store } = createHarness();
    seedQuad(bus, store);
    const result = bus.execute(
      rotateRegionCommand(commandId("command:region:rot:0001"), {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 1, 2] },
        axis: "y",
        quarterTurns: 1,
      }),
      tx("rot:0001", 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 0])).toBe(1);
    expect(voxelAt(store, [0, 0, 1])).toBe(1);
    expect(voxelAt(store, [1, 0, 1])).toBe(1);

    const undone = bus.undo(tx("rot:undo:0001", 2));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 1])).toBe(1);
  });

  it("undo and redo preserve a 180-degree axial rotation (issue #93)", () => {
    const { bus, store } = createHarness();
    // Distinguish axial rotation from point reflection: ONE at (0,1,0) must
    // land on (1,1,1) (the y coordinate is preserved), not on (1,0,1), and
    // TWO at (0,0,0) must land on (1,0,1), not on (1,1,1).
    const seedOne = bus.execute(
      setVoxelCommand(commandId("command:region:seed:93:0001"), {
        volumeId: VOLUME,
        coordinate: [0, 1, 0],
        material: MATERIAL_ONE,
      }),
      tx("seed:93:0001", store.revision),
    );
    expect(seedOne.ok).toBe(true);
    if (!seedOne.ok) return;
    const seedTwo = bus.execute(
      setVoxelCommand(commandId("command:region:seed:93:0002"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
        material: MATERIAL_TWO,
      }),
      tx("seed:93:0002", store.revision),
    );
    expect(seedTwo.ok).toBe(true);
    if (!seedTwo.ok) return;

    const result = bus.execute(
      rotateRegionCommand(commandId("command:region:rot:0093"), {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 2, 2] },
        axis: "y",
        quarterTurns: 2,
      }),
      tx("rot:93:0001", store.revision),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voxelAt(store, [1, 1, 1])).toBe(1);
    expect(voxelAt(store, [1, 0, 1])).toBe(2);
    expect(voxelAt(store, [0, 1, 0])).toBe(0);
    expect(voxelAt(store, [0, 0, 0])).toBe(0);

    const undone = bus.undo(tx("rot:93:undo", store.revision));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(voxelAt(store, [0, 1, 0])).toBe(1);
    expect(voxelAt(store, [0, 0, 0])).toBe(2);
    expect(voxelAt(store, [1, 1, 1])).toBe(0);
    expect(voxelAt(store, [1, 0, 1])).toBe(0);

    const redone = bus.redo(tx("rot:93:redo", store.revision));
    expect(redone.ok).toBe(true);
    if (!redone.ok) return;
    expect(voxelAt(store, [1, 1, 1])).toBe(1);
    expect(voxelAt(store, [1, 0, 1])).toBe(2);
    expect(voxelAt(store, [0, 1, 0])).toBe(0);
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
  });

  it("rejects a parity-mismatched region at parse time", () => {
    const { bus, store } = createHarness();
    seedQuad(bus, store);
    // The canonicalizing constructor rejects this payload, so the bus path
    // is exercised with a raw envelope (untrusted input).
    const result = bus.execute(
      {
        id: commandId("command:region:rot:0002"),
        type: VOXEL_ROTATE_REGION_COMMAND,
        schemaVersion: 1,
        payload: {
          volumeId: VOLUME,
          region: { min: [0, 0, 0], max: [2, 1, 1] },
          axis: "y",
          quarterTurns: 1,
        },
      },
      tx("rot:0002", 1),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_ROTATION_REGION");
    expect(store.revision).toBe(1);
  });
});

describe("voxel.mirrorRegion", () => {
  it("mirrors a region and undoes exactly", () => {
    const { bus, store } = createHarness();
    seedQuad(bus, store);
    const result = bus.execute(
      mirrorRegionCommand(commandId("command:region:mir:0001"), {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 1, 2] },
        axis: "x",
      }),
      tx("mir:0001", 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 0])).toBe(1);

    const undone = bus.undo(tx("mir:undo:0001", 2));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 1])).toBe(1);
  });
});

describe("voxel.copyRegion and voxel.deleteRegion", () => {
  it("copies a region without clearing the source and undoes exactly", () => {
    const { bus, store } = createHarness();
    seedQuad(bus, store);
    const result = bus.execute(
      copyRegionCommand(commandId("command:region:copy:0001"), {
        volumeId: VOLUME,
        source: { min: [0, 0, 0], max: [2, 1, 2] },
        destination: [5, 2, -3],
      }),
      tx("copy:0001", 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [5, 2, -3])).toBe(1);
    expect(voxelAt(store, [6, 2, -2])).toBe(1);
    expect(store.getVolume(VOLUME)?.occupiedCount()).toBe(8);

    const undone = bus.undo(tx("copy:undo:0001", 2));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(voxelAt(store, [5, 2, -3])).toBe(0);
    expect(store.getVolume(VOLUME)?.occupiedCount()).toBe(4);
  });

  it("deletes a region and undoes exactly", () => {
    const { bus, store } = createHarness();
    seedQuad(bus, store);
    const result = bus.execute(
      deleteRegionCommand(commandId("command:region:del:0001"), {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 1, 2] },
      }),
      tx("del:0001", 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [1, 0, 1])).toBe(0);
    expect(store.getVolume(VOLUME)?.occupiedCount()).toBe(0);

    const undone = bus.undo(tx("del:undo:0001", 2));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 1])).toBe(1);
  });

  it("rejects region commands referencing a missing volume", () => {
    const { bus, store } = createHarness();
    const result = bus.execute(
      deleteRegionCommand(commandId("command:region:del:0002"), {
        volumeId: volumeId("volume:region:missing"),
        region: { min: [0, 0, 0], max: [2, 1, 2] },
      }),
      tx("del:0002", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_VOLUME");
    expect(store.revision).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Shared conformance specs (plan 4.16 / 4.17)
// ---------------------------------------------------------------------------

const specBase = {
  createDocument: createRegionDocument,
  register(registry: CommandRegistry): void {
    registerVoxelCommands(registry);
    registerBatchCommands(registry);
    registerRegionCommands(registry);
  },
} as const;

const translateRegionSpec: CommandConformanceSpec = {
  ...specBase,
  name: "voxel.translateRegion@1",
  type: VOXEL_TRANSLATE_REGION_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  seed(bus, store) {
    const result = bus.execute(
      setVoxelCommand(commandId("command:region:seed:tr:0001"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
        material: MATERIAL_ONE,
      }),
      tx("seed:tr:0001", store.revision),
    );
    if (!result.ok) throw new Error(`seed failed: ${result.error.code}`);
  },
  buildValid: (id) =>
    translateRegionCommand(id, {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [2, 1, 1] },
      delta: [3, 0, 0],
    }),
  buildInvalid: (id) =>
    translateRegionCommand(id, {
      volumeId: volumeId("volume:region:missing"),
      region: { min: [0, 0, 0], max: [2, 1, 1] },
      delta: [3, 0, 0],
    }),
  buildSecondValid: (id) =>
    translateRegionCommand(id, {
      volumeId: VOLUME,
      region: { min: [3, 0, 0], max: [5, 1, 1] },
      delta: [3, 0, 0],
    }),
  assertApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [3, 0, 0])).toBe(1);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [3, 0, 0])).toBe(0);
  },
  assertSecondApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [3, 0, 0])).toBe(0);
    expect(voxelAt(store, [6, 0, 0])).toBe(1);
  },
};

const rotateRegionSpec: CommandConformanceSpec = {
  ...specBase,
  name: "voxel.rotateRegion@1",
  type: VOXEL_ROTATE_REGION_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  seed(bus, store) {
    const result = bus.execute(
      setVoxelCommand(commandId("command:region:seed:rot:0001"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
        material: MATERIAL_ONE,
      }),
      tx("seed:rot:0001", store.revision),
    );
    if (!result.ok) throw new Error(`seed failed: ${result.error.code}`);
  },
  buildValid: (id) =>
    rotateRegionCommand(id, {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [2, 1, 2] },
      axis: "y",
      quarterTurns: 1,
    }),
  // The parity constraint is enforced by the canonicalizing constructor,
  // so the invalid spec is a raw envelope that fails handler parse.
  buildInvalid: (id) => ({
    id,
    type: VOXEL_ROTATE_REGION_COMMAND,
    schemaVersion: 1,
    payload: {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [2, 1, 1] },
      axis: "y",
      quarterTurns: 1,
    },
  }),
  buildSecondValid: (id) =>
    rotateRegionCommand(id, {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [2, 1, 2] },
      axis: "y",
      quarterTurns: 2,
    }),
  assertApplied: (store) => {
    // The single voxel at (0,0,0) rotates to (0,0,1) around the center.
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [0, 0, 1])).toBe(1);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [0, 0, 1])).toBe(0);
  },
  assertSecondApplied: (store) => {
    // 180 degrees after 90 degrees: (0,0,1) -> (1,0,0).
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [0, 0, 1])).toBe(0);
    expect(voxelAt(store, [1, 0, 0])).toBe(1);
  },
};

const mirrorRegionSpec: CommandConformanceSpec = {
  ...specBase,
  name: "voxel.mirrorRegion@1",
  type: VOXEL_MIRROR_REGION_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  seed(bus, store) {
    const result = bus.execute(
      setVoxelCommand(commandId("command:region:seed:mir:0001"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
        material: MATERIAL_ONE,
      }),
      tx("seed:mir:0001", store.revision),
    );
    if (!result.ok) throw new Error(`seed failed: ${result.error.code}`);
  },
  buildValid: (id) =>
    mirrorRegionCommand(id, {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [2, 1, 1] },
      axis: "x",
    }),
  buildInvalid: (id) =>
    mirrorRegionCommand(id, {
      volumeId: volumeId("volume:region:missing"),
      region: { min: [0, 0, 0], max: [2, 1, 1] },
      axis: "x",
    }),
  buildSecondValid: (id) =>
    mirrorRegionCommand(id, {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [2, 1, 1] },
      axis: "x",
    }),
  assertApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [1, 0, 0])).toBe(1);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 0])).toBe(0);
  },
  assertSecondApplied: (store) => {
    // Mirroring twice restores the original position.
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 0])).toBe(0);
  },
};

const copyRegionSpec: CommandConformanceSpec = {
  ...specBase,
  name: "voxel.copyRegion@1",
  type: VOXEL_COPY_REGION_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  seed(bus, store) {
    const result = bus.execute(
      setVoxelCommand(commandId("command:region:seed:copy:0001"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
        material: MATERIAL_ONE,
      }),
      tx("seed:copy:0001", store.revision),
    );
    if (!result.ok) throw new Error(`seed failed: ${result.error.code}`);
  },
  buildValid: (id) =>
    copyRegionCommand(id, {
      volumeId: VOLUME,
      source: { min: [0, 0, 0], max: [2, 1, 1] },
      destination: [3, 0, 0],
    }),
  buildInvalid: (id) =>
    copyRegionCommand(id, {
      volumeId: volumeId("volume:region:missing"),
      source: { min: [0, 0, 0], max: [2, 1, 1] },
      destination: [3, 0, 0],
    }),
  buildSecondValid: (id) =>
    copyRegionCommand(id, {
      volumeId: VOLUME,
      source: { min: [0, 0, 0], max: [2, 1, 1] },
      destination: [6, 0, 0],
    }),
  assertApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [3, 0, 0])).toBe(1);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [3, 0, 0])).toBe(0);
  },
  assertSecondApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [3, 0, 0])).toBe(1);
    expect(voxelAt(store, [6, 0, 0])).toBe(1);
  },
};

const deleteRegionSpec: CommandConformanceSpec = {
  ...specBase,
  name: "voxel.deleteRegion@1",
  type: VOXEL_DELETE_REGION_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  seed(bus, store) {
    const result = bus.execute(
      setVoxelCommand(commandId("command:region:seed:del:0001"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
        material: MATERIAL_ONE,
      }),
      tx("seed:del:0001", store.revision),
    );
    if (!result.ok) throw new Error(`seed failed: ${result.error.code}`);
  },
  buildValid: (id) =>
    deleteRegionCommand(id, {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [2, 1, 1] },
    }),
  buildInvalid: (id) =>
    deleteRegionCommand(id, {
      volumeId: volumeId("volume:region:missing"),
      region: { min: [0, 0, 0], max: [2, 1, 1] },
    }),
  buildSecondValid: (id) =>
    deleteRegionCommand(id, {
      volumeId: VOLUME,
      region: { min: [9, 9, 9], max: [10, 10, 10] },
    }),
  assertApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
  },
  assertSecondApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [9, 9, 9])).toBe(0);
  },
};

runCommandConformanceSuite(translateRegionSpec, { describe, it, expect });
runCommandConformanceSuite(rotateRegionSpec, { describe, it, expect });
runCommandConformanceSuite(mirrorRegionSpec, { describe, it, expect });
runCommandConformanceSuite(copyRegionSpec, { describe, it, expect });
runCommandConformanceSuite(deleteRegionSpec, { describe, it, expect });

/** Every registered region command must declare a conformance spec (plan 4.17). */
const CONFORMANCE_TESTED_REGION_COMMANDS = [
  commandKey(VOXEL_COPY_REGION_COMMAND, 1),
  commandKey(VOXEL_DELETE_REGION_COMMAND, 1),
  commandKey(VOXEL_MIRROR_REGION_COMMAND, 1),
  commandKey(VOXEL_ROTATE_REGION_COMMAND, 1),
  commandKey(VOXEL_TRANSLATE_REGION_COMMAND, 1),
] as const;

describe("region command conformance coverage", () => {
  it("runs every registered region command through the conformance suite", () => {
    const registry = new CommandRegistry();
    registerRegionCommands(registry);
    const registered = registry
      .list()
      .map(({ type, schemaVersion }) => commandKey(type, schemaVersion));
    expect(registered).toEqual([...CONFORMANCE_TESTED_REGION_COMMANDS]);
  });
});
