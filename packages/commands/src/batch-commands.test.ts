import { describe, expect, it } from "vitest";
import {
  commandId,
  materialId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import {
  DEFAULT_DOCUMENT_LIMITS,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { type DocumentStoreRead } from "@voxel-maker/document";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import { registerVoxelCommands, setVoxelCommand } from "./voxel-commands.js";
import {
  VOXEL_APPLY_PATCHES_COMMAND,
  VOXEL_FILL_BOX_COMMAND,
  VOXEL_FILL_CYLINDER_COMMAND,
  VOXEL_FILL_SPHERE_COMMAND,
  VOXEL_REMOVE_BATCH_COMMAND,
  VOXEL_REPLACE_MATERIAL_COMMAND,
  VOXEL_SET_BATCH_COMMAND,
  applyPatchesCommand,
  fillBoxCommand,
  fillCylinderCommand,
  fillSphereCommand,
  registerBatchCommands,
  removeBatchCommand,
  replaceMaterialCommand,
  setBatchCommand,
} from "./batch-commands.js";
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

const VOLUME = volumeId("volume:batch:0001");
const MATERIAL_ONE = materialId(1);
const MATERIAL_TWO = materialId(2);

function createBatchDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:batch:0001" as never,
    metadata: { title: "batch commands", tags: [] },
    rootNodeId: "node:batch:root" as never,
    nodes: [
      {
        nodeId: "node:batch:root" as never,
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
    document: createBatchDocument(),
  });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  return {
    bus: new CommandBus(store, registry, writeCapability),
    store,
  };
}

const tx = (
  id: string,
  expectedRevision: number,
): import("./types.js").TransactionOptions => ({
  transactionId: transactionId(`transaction:batch:${id}`),
  expectedRevision,
  source: "ui",
});

const voxelAt = (
  store: DocumentStoreRead,
  coordinate: readonly [number, number, number],
) => store.getVoxel(VOLUME, coordinate);

describe("batch command constructors", () => {
  it("canonicalize payloads and reject invalid input", () => {
    const id = commandId("command:batch:ctor:0001");
    expect(
      setBatchCommand(id, {
        volumeId: VOLUME,
        entries: [
          { coordinate: [0, 0, 0], material: MATERIAL_ONE },
          { coordinate: [-1, 0, 1], material: MATERIAL_TWO },
        ],
      }).payload,
    ).toEqual({
      volumeId: VOLUME,
      entries: [
        { coordinate: [0, 0, 0], material: MATERIAL_ONE },
        { coordinate: [-1, 0, 1], material: MATERIAL_TWO },
      ],
    });
    expect(() =>
      setBatchCommand(id, {
        volumeId: VOLUME,
        entries: [{ coordinate: [0, 0, 0], material: 0 as never }],
      }),
    ).toThrow(/1 through 65535/u);
    expect(() =>
      fillSphereCommand(id, {
        volumeId: VOLUME,
        center: [0, 0, 0],
        radius: -1,
        material: MATERIAL_ONE,
      }),
    ).toThrow(/non-negative integer/u);
    expect(() =>
      fillCylinderCommand(id, {
        volumeId: VOLUME,
        center: [0, 0, 0],
        radius: 1,
        height: 1,
        axis: "diagonal" as never,
        material: MATERIAL_ONE,
      }),
    ).toThrow(/Axis/u);
    expect(() =>
      replaceMaterialCommand(id, {
        volumeId: VOLUME,
        fromMaterial: 0,
        toMaterial: 65_536,
      }),
    ).toThrow(/0 through 65535/u);
    expect(() =>
      applyPatchesCommand(id, {
        volumeId: VOLUME,
        chunks: [
          {
            coordinate: [0, 0, 0],
            patches: [{ index: 4096, oldValue: 0 }],
          },
        ],
      }),
    ).toThrow(/0 through 4095/u);
  });
});

describe("voxel.setBatch", () => {
  it("commits a bounded batch and undoes it exactly", () => {
    const { bus, store } = createHarness();
    const result = bus.execute(
      setBatchCommand(commandId("command:batch:set:0001"), {
        volumeId: VOLUME,
        entries: [
          { coordinate: [0, 0, 0], material: MATERIAL_ONE },
          { coordinate: [1, 0, 0], material: MATERIAL_TWO },
          { coordinate: [-1, 0, 0], material: MATERIAL_ONE },
        ],
      }),
      tx("set:0001", 0),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 0])).toBe(2);
    expect(voxelAt(store, [-1, 0, 0])).toBe(1);
    expect(result.value.event.changedVolumes[0]?.chunks).toHaveLength(2);

    const undone = bus.undo(tx("set:undo:0001", 1));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [1, 0, 0])).toBe(0);
    expect(voxelAt(store, [-1, 0, 0])).toBe(0);
  });

  it("rejects a batch referencing a missing material", () => {
    const { bus, store } = createHarness();
    const result = bus.execute(
      setBatchCommand(commandId("command:batch:set:0002"), {
        volumeId: VOLUME,
        entries: [{ coordinate: [0, 0, 0], material: materialId(3) }],
      }),
      tx("set:0002", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_MATERIAL");
    expect(store.revision).toBe(0);
  });
});

describe("voxel.fillBox", () => {
  it("fills a box, reports one compact chunk change, and undoes", () => {
    const { bus, store } = createHarness();
    const result = bus.execute(
      fillBoxCommand(commandId("command:batch:box:0001"), {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 2, 2] },
        material: MATERIAL_ONE,
      }),
      tx("box:0001", 0),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voxelAt(store, [1, 1, 1])).toBe(1);
    expect(voxelAt(store, [2, 0, 0])).toBe(0);
    expect(result.value.event.changedVolumes[0]?.chunks).toHaveLength(1);

    const undone = bus.undo(tx("box:undo:0001", 1));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(voxelAt(store, [1, 1, 1])).toBe(0);
  });
});

describe("voxel.replaceMaterial", () => {
  it("replaces a material in a region and restores on undo", () => {
    const { bus, store } = createHarness();
    bus.execute(
      fillBoxCommand(commandId("command:batch:rep:0001"), {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 3, 3] },
        material: MATERIAL_ONE,
      }),
      tx("rep:0001", 0),
    );
    const result = bus.execute(
      replaceMaterialCommand(commandId("command:batch:rep:0002"), {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [2, 2, 2] },
        fromMaterial: 1,
        toMaterial: 2,
      }),
      tx("rep:0002", 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(2);
    expect(voxelAt(store, [2, 2, 2])).toBe(1);

    const undone = bus.undo(tx("rep:undo:0002", 2));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
  });

  it("rejects painting to a material missing from the document", () => {
    const { bus } = createHarness();
    const result = bus.execute(
      replaceMaterialCommand(commandId("command:batch:rep:0003"), {
        volumeId: VOLUME,
        fromMaterial: 1,
        toMaterial: 3,
      }),
      tx("rep:0003", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_MATERIAL");
  });
});

describe("voxel.fillBox boundary voxels", () => {
  it("fills the boundary voxel with a half-open region ending at max+1", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createBatchDocument(),
      limits: {
        ...DEFAULT_DOCUMENT_LIMITS,
        maxVoxelCoordinate: 1,
      },
    });
    const registry = new CommandRegistry();
    registerVoxelCommands(registry);
    registerBatchCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const result = bus.execute(
      fillBoxCommand(commandId("command:batch:boundary:0001"), {
        volumeId: VOLUME,
        region: { min: [-1, -1, -1], max: [2, 2, 2] },
        material: MATERIAL_ONE,
      }),
      tx("boundary:0001", 0),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voxelAt(store, [1, 1, 1])).toBe(1);
    expect(voxelAt(store, [-1, -1, -1])).toBe(1);
  });
});

describe("voxel.applyPatches", () => {
  it("rejects patches restoring undeclared materials atomically (issue #86)", () => {
    const { bus, store } = createHarness();
    let events = 0;
    store.subscribe(() => {
      events += 1;
    });
    const result = bus.execute(
      applyPatchesCommand(commandId("command:batch:patch:0090"), {
        volumeId: VOLUME,
        chunks: [
          {
            coordinate: [0, 0, 0],
            patches: [{ index: 0, oldValue: 65_535 }],
          },
        ],
      }),
      tx("patch:0090", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_MATERIAL");
    expect(store.revision).toBe(0);
    expect(events).toBe(0);
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
  });

  it("accepts patches restoring declared materials", () => {
    const { bus, store } = createHarness();
    bus.execute(
      setBatchCommand(commandId("command:batch:patch:0091"), {
        volumeId: VOLUME,
        entries: [{ coordinate: [0, 0, 0], material: MATERIAL_TWO }],
      }),
      tx("patch:0091", 0),
    );
    const result = bus.execute(
      applyPatchesCommand(commandId("command:batch:patch:0092"), {
        volumeId: VOLUME,
        chunks: [
          {
            coordinate: [0, 0, 0],
            patches: [{ index: 0, oldValue: MATERIAL_ONE }],
          },
        ],
      }),
      tx("patch:0092", 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(MATERIAL_ONE);
  });

  it("rejects patches whose voxel lies outside the coordinate domain at parse", () => {
    const { bus, store } = createHarness();
    const result = bus.execute(
      applyPatchesCommand(commandId("command:batch:patch:0003"), {
        volumeId: VOLUME,
        chunks: [
          {
            coordinate: [-65_536, 0, 0],
            patches: [{ index: 0, oldValue: 0 }],
          },
        ],
      }),
      tx("patch:0003", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_VOXEL_COORDINATE");
    expect(store.revision).toBe(0);
  });

  it("restores exact voxel state from a compact patch list", () => {
    const { bus, store } = createHarness();
    bus.execute(
      setBatchCommand(commandId("command:batch:patch:0001"), {
        volumeId: VOLUME,
        entries: [
          { coordinate: [0, 0, 0], material: MATERIAL_ONE },
          { coordinate: [1, 0, 0], material: MATERIAL_TWO },
        ],
      }),
      tx("patch:0001", 0),
    );
    const result = bus.execute(
      applyPatchesCommand(commandId("command:batch:patch:0002"), {
        volumeId: VOLUME,
        chunks: [
          {
            coordinate: [0, 0, 0],
            patches: [
              { index: 0, oldValue: 0 },
              { index: 1, oldValue: 0 },
            ],
          },
        ],
      }),
      tx("patch:0002", 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [1, 0, 0])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Shared conformance specs (plan 4.16 / 4.17)
// ---------------------------------------------------------------------------

const specBase = {
  createDocument: createBatchDocument,
  register(registry: CommandRegistry): void {
    registerVoxelCommands(registry);
    registerBatchCommands(registry);
  },
} as const;

const setBatchSpec: CommandConformanceSpec = {
  ...specBase,
  name: "voxel.setBatch@1",
  type: VOXEL_SET_BATCH_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  seed(bus, store) {
    const result = bus.execute(
      setVoxelCommand(commandId("command:batch:seed:set:0001"), {
        volumeId: VOLUME,
        coordinate: [5, 0, 0],
        material: MATERIAL_ONE,
      }),
      tx("seed:set:0001", store.revision),
    );
    if (!result.ok) throw new Error(`seed failed: ${result.error.code}`);
  },
  buildValid: (id) =>
    setBatchCommand(id, {
      volumeId: VOLUME,
      entries: [
        { coordinate: [0, 0, 0], material: MATERIAL_ONE },
        { coordinate: [1, 0, 0], material: MATERIAL_TWO },
      ],
    }),
  buildInvalid: (id) =>
    setBatchCommand(id, {
      volumeId: VOLUME,
      entries: [{ coordinate: [0, 0, 0], material: materialId(3) }],
    }),
  buildSecondValid: (id) =>
    setBatchCommand(id, {
      volumeId: VOLUME,
      entries: [{ coordinate: [2, 0, 0], material: MATERIAL_ONE }],
    }),
  assertApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 0])).toBe(2);
    expect(voxelAt(store, [5, 0, 0])).toBe(1);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [1, 0, 0])).toBe(0);
    expect(voxelAt(store, [5, 0, 0])).toBe(1);
  },
  assertSecondApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 0])).toBe(2);
    expect(voxelAt(store, [2, 0, 0])).toBe(1);
  },
};

const removeBatchSpec: CommandConformanceSpec = {
  ...specBase,
  name: "voxel.removeBatch@1",
  type: VOXEL_REMOVE_BATCH_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  seed(bus, store) {
    const result = bus.execute(
      setBatchCommand(commandId("command:batch:seed:rm:0001"), {
        volumeId: VOLUME,
        entries: [
          { coordinate: [0, 0, 0], material: MATERIAL_ONE },
          { coordinate: [1, 0, 0], material: MATERIAL_TWO },
        ],
      }),
      tx("seed:rm:0001", store.revision),
    );
    if (!result.ok) throw new Error(`seed failed: ${result.error.code}`);
  },
  buildValid: (id) =>
    removeBatchCommand(id, {
      volumeId: VOLUME,
      coordinates: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    }),
  buildInvalid: (id) =>
    removeBatchCommand(id, {
      volumeId: volumeId("volume:batch:missing"),
      coordinates: [[0, 0, 0]],
    }),
  buildSecondValid: (id) =>
    removeBatchCommand(id, {
      volumeId: VOLUME,
      coordinates: [[9, 9, 9]],
    }),
  assertApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [1, 0, 0])).toBe(0);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 0])).toBe(2);
  },
  assertSecondApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [1, 0, 0])).toBe(0);
    expect(voxelAt(store, [9, 9, 9])).toBe(0);
  },
};

const fillBoxSpec: CommandConformanceSpec = {
  ...specBase,
  name: "voxel.fillBox@1",
  type: VOXEL_FILL_BOX_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  buildValid: (id) =>
    fillBoxCommand(id, {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [2, 2, 2] },
      material: MATERIAL_ONE,
    }),
  buildInvalid: (id) =>
    fillBoxCommand(id, {
      volumeId: volumeId("volume:batch:missing"),
      region: { min: [0, 0, 0], max: [1, 1, 1] },
      material: MATERIAL_ONE,
    }),
  buildSecondValid: (id) =>
    fillBoxCommand(id, {
      volumeId: VOLUME,
      region: { min: [4, 4, 4], max: [5, 5, 5] },
      material: MATERIAL_TWO,
    }),
  assertApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 1, 1])).toBe(1);
    expect(voxelAt(store, [2, 0, 0])).toBe(0);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [1, 1, 1])).toBe(0);
  },
  assertSecondApplied: (store) => {
    expect(voxelAt(store, [1, 1, 1])).toBe(1);
    expect(voxelAt(store, [4, 4, 4])).toBe(2);
  },
};

const fillSphereSpec: CommandConformanceSpec = {
  ...specBase,
  name: "voxel.fillSphere@1",
  type: VOXEL_FILL_SPHERE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  buildValid: (id) =>
    fillSphereCommand(id, {
      volumeId: VOLUME,
      center: [0, 0, 0],
      radius: 1,
      material: MATERIAL_ONE,
    }),
  buildInvalid: (id) =>
    fillSphereCommand(id, {
      volumeId: volumeId("volume:batch:missing"),
      center: [0, 0, 0],
      radius: 1,
      material: MATERIAL_ONE,
    }),
  buildExecuteInvalid: (id) =>
    fillSphereCommand(id, {
      volumeId: VOLUME,
      center: [0, 0, 0],
      radius: 1_000_000,
      material: MATERIAL_ONE,
    }),
  buildSecondValid: (id) =>
    fillSphereCommand(id, {
      volumeId: VOLUME,
      center: [10, 0, 0],
      radius: 0,
      material: MATERIAL_TWO,
    }),
  assertApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 1, 0])).toBe(0);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [1, 0, 0])).toBe(0);
  },
  assertSecondApplied: (store) => {
    expect(voxelAt(store, [1, 0, 0])).toBe(1);
    expect(voxelAt(store, [10, 0, 0])).toBe(2);
  },
};

const fillCylinderSpec: CommandConformanceSpec = {
  ...specBase,
  name: "voxel.fillCylinder@1",
  type: VOXEL_FILL_CYLINDER_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  buildValid: (id) =>
    fillCylinderCommand(id, {
      volumeId: VOLUME,
      center: [0, 0, 0],
      radius: 1,
      height: 2,
      axis: "y",
      material: MATERIAL_ONE,
    }),
  buildInvalid: (id) =>
    fillCylinderCommand(id, {
      volumeId: volumeId("volume:batch:missing"),
      center: [0, 0, 0],
      radius: 1,
      height: 2,
      axis: "y",
      material: MATERIAL_ONE,
    }),
  buildSecondValid: (id) =>
    fillCylinderCommand(id, {
      volumeId: VOLUME,
      center: [0, 0, 0],
      radius: 0,
      height: 1,
      axis: "z",
      material: MATERIAL_TWO,
    }),
  assertApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [0, 1, 0])).toBe(1);
    expect(voxelAt(store, [0, 2, 0])).toBe(0);
    expect(voxelAt(store, [1, 0, 0])).toBe(1);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [0, 1, 0])).toBe(0);
  },
  assertSecondApplied: (store) => {
    expect(voxelAt(store, [0, 1, 0])).toBe(1);
    expect(voxelAt(store, [0, 0, 0])).toBe(2);
  },
};

const replaceMaterialSpec: CommandConformanceSpec = {
  ...specBase,
  name: "voxel.replaceMaterial@1",
  type: VOXEL_REPLACE_MATERIAL_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  seed(bus, store) {
    const result = bus.execute(
      fillBoxCommand(commandId("command:batch:seed:rep:0001"), {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [3, 3, 3] },
        material: MATERIAL_ONE,
      }),
      tx("seed:rep:0001", store.revision),
    );
    if (!result.ok) throw new Error(`seed failed: ${result.error.code}`);
  },
  buildValid: (id) =>
    replaceMaterialCommand(id, {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [2, 2, 2] },
      fromMaterial: 1,
      toMaterial: 2,
    }),
  buildInvalid: (id) =>
    replaceMaterialCommand(id, {
      volumeId: VOLUME,
      fromMaterial: 1,
      toMaterial: 3,
    }),
  buildExecuteInvalid: (id) =>
    replaceMaterialCommand(id, {
      volumeId: VOLUME,
      fromMaterial: 0,
      toMaterial: 1,
    }),
  buildSecondValid: (id) =>
    replaceMaterialCommand(id, {
      volumeId: VOLUME,
      region: { min: [2, 2, 2], max: [3, 3, 3] },
      fromMaterial: 1,
      toMaterial: 2,
    }),
  assertApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(2);
    expect(voxelAt(store, [1, 1, 1])).toBe(2);
    expect(voxelAt(store, [2, 2, 2])).toBe(1);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 1, 1])).toBe(1);
    expect(voxelAt(store, [2, 2, 2])).toBe(1);
  },
  assertSecondApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(2);
    expect(voxelAt(store, [2, 2, 2])).toBe(2);
  },
};

const applyPatchesSpec: CommandConformanceSpec = {
  ...specBase,
  name: "voxel.applyPatches@1",
  type: VOXEL_APPLY_PATCHES_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  seed(bus, store) {
    const result = bus.execute(
      setBatchCommand(commandId("command:batch:seed:patch:0001"), {
        volumeId: VOLUME,
        entries: [
          { coordinate: [0, 0, 0], material: MATERIAL_ONE },
          { coordinate: [1, 0, 0], material: MATERIAL_TWO },
        ],
      }),
      tx("seed:patch:0001", store.revision),
    );
    if (!result.ok) throw new Error(`seed failed: ${result.error.code}`);
  },
  buildValid: (id) =>
    applyPatchesCommand(id, {
      volumeId: VOLUME,
      chunks: [
        {
          coordinate: [0, 0, 0],
          patches: [
            { index: 0, oldValue: 0 },
            { index: 1, oldValue: 0 },
          ],
        },
      ],
    }),
  buildInvalid: (id) =>
    applyPatchesCommand(id, {
      volumeId: volumeId("volume:batch:missing"),
      chunks: [
        {
          coordinate: [0, 0, 0],
          patches: [{ index: 0, oldValue: 0 }],
        },
      ],
    }),
  buildExecuteInvalid: (id) =>
    applyPatchesCommand(id, {
      volumeId: VOLUME,
      chunks: [
        {
          coordinate: [1_000_000, 0, 0],
          patches: [{ index: 0, oldValue: 0 }],
        },
      ],
    }),
  buildSecondValid: (id) =>
    applyPatchesCommand(id, {
      volumeId: VOLUME,
      chunks: [
        {
          coordinate: [0, 0, 0],
          patches: [{ index: 0, oldValue: 1 }],
        },
      ],
    }),
  assertApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(0);
    expect(voxelAt(store, [1, 0, 0])).toBe(0);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 0])).toBe(2);
  },
  assertSecondApplied: (store) => {
    expect(voxelAt(store, [0, 0, 0])).toBe(1);
    expect(voxelAt(store, [1, 0, 0])).toBe(0);
  },
};

runCommandConformanceSuite(setBatchSpec, { describe, it, expect });
runCommandConformanceSuite(removeBatchSpec, { describe, it, expect });
runCommandConformanceSuite(fillBoxSpec, { describe, it, expect });
runCommandConformanceSuite(fillSphereSpec, { describe, it, expect });
runCommandConformanceSuite(fillCylinderSpec, { describe, it, expect });
runCommandConformanceSuite(replaceMaterialSpec, { describe, it, expect });
runCommandConformanceSuite(applyPatchesSpec, { describe, it, expect });

/** Every registered persistent command must declare a conformance spec (plan 4.17). */
export const BATCH_CONFORMANCE_TESTED_COMMANDS = [
  commandKey(VOXEL_APPLY_PATCHES_COMMAND, 1),
  commandKey(VOXEL_FILL_BOX_COMMAND, 1),
  commandKey(VOXEL_FILL_CYLINDER_COMMAND, 1),
  commandKey(VOXEL_FILL_SPHERE_COMMAND, 1),
  commandKey(VOXEL_REMOVE_BATCH_COMMAND, 1),
  commandKey(VOXEL_REPLACE_MATERIAL_COMMAND, 1),
  commandKey(VOXEL_SET_BATCH_COMMAND, 1),
] as const;
