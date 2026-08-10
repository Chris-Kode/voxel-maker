import { describe, expect, it } from "vitest";
import {
  commandId,
  materialId,
  transactionId,
  volumeId,
  type CommandId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { type DocumentStoreRead } from "@voxel-maker/document";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import {
  VOXEL_REMOVE_COMMAND,
  VOXEL_SET_COMMAND,
  registerVoxelCommands,
  removeVoxelCommand,
  setVoxelCommand,
} from "./voxel-commands.js";
import {
  VOXEL_APPLY_PATCHES_COMMAND,
  VOXEL_FILL_BOX_COMMAND,
  VOXEL_FILL_CYLINDER_COMMAND,
  VOXEL_FILL_SPHERE_COMMAND,
  VOXEL_REMOVE_BATCH_COMMAND,
  VOXEL_REPLACE_MATERIAL_COMMAND,
  VOXEL_SET_BATCH_COMMAND,
  registerBatchCommands,
} from "./batch-commands.js";
import {
  VOXEL_COPY_REGION_COMMAND,
  VOXEL_DELETE_REGION_COMMAND,
  VOXEL_MIRROR_REGION_COMMAND,
  VOXEL_ROTATE_REGION_COMMAND,
  VOXEL_TRANSLATE_REGION_COMMAND,
  registerRegionCommands,
} from "./region-commands.js";
import {
  NODE_ADD_CONSTRAINT_COMMAND,
  NODE_ADD_JOINT_COMMAND,
  NODE_REMOVE_CONSTRAINT_COMMAND,
  NODE_REMOVE_JOINT_COMMAND,
  NODE_REMOVE_PIVOT_COMMAND,
  NODE_REORDER_CONSTRAINT_COMMAND,
  NODE_SET_CONSTRAINT_COMMAND,
  NODE_SET_PIVOT_COMMAND,
  registerArticulationCommands,
} from "./articulation-commands.js";
import {
  NODE_CREATE_COMMAND,
  NODE_DELETE_COMMAND,
  NODE_RENAME_COMMAND,
  NODE_REPARENT_COMMAND,
  NODE_SET_COMPONENTS_COMMAND,
  NODE_SET_METADATA_COMMAND,
  NODE_SET_TRANSFORM_COMMAND,
  registerNodeCommands,
} from "./node-commands.js";
import {
  MATERIAL_CREATE_COMMAND,
  MATERIAL_DELETE_COMMAND,
  MATERIAL_UPDATE_COMMAND,
  registerMaterialCommands,
} from "./material-commands.js";
import {
  VOLUME_CREATE_COMMAND,
  VOLUME_DELETE_COMMAND,
  createVolumeCommand,
  deleteVolumeCommand,
  registerVolumeCommands,
} from "./volume-commands.js";
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

const VOLUME = volumeId("volume:conformance:0001");
const FIRST = [0, 0, 0] as const;
const SECOND = [1, 0, 0] as const;

function createConformanceDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:conformance:0001" as never,
    metadata: { title: "command conformance", tags: [] },
    rootNodeId: "node:conformance:root" as never,
    nodes: [
      {
        nodeId: "node:conformance:root" as never,
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
        materialId: materialId(1),
        name: "demo",
        color: "#ff8800",
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

const setAt = (id: CommandId, coordinate: readonly [number, number, number]) =>
  setVoxelCommand(id, {
    volumeId: VOLUME,
    coordinate,
    material: materialId(1),
  });

const removeAt = (
  id: CommandId,
  coordinate: readonly [number, number, number],
) => removeVoxelCommand(id, { volumeId: VOLUME, coordinate });

const voxelAt = (
  store: DocumentStoreRead,
  coordinate: readonly [number, number, number],
) => store.getVoxel(VOLUME, coordinate);

const setSpec: CommandConformanceSpec = {
  name: "voxel.set@1",
  type: VOXEL_SET_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createConformanceDocument,
  register: registerVoxelCommands,
  buildValid: (id) => setAt(id, FIRST),
  buildInvalid: (id) => ({
    id,
    type: VOXEL_SET_COMMAND,
    schemaVersion: 1,
    payload: {
      volumeId: volumeId("volume:conformance:missing"),
      coordinate: FIRST,
      material: materialId(1),
    },
  }),
  buildSecondValid: (id) => setAt(id, SECOND),
  buildExecuteInvalid: (id) => setAt(id, [3_000, 0, 0]),
  assertApplied: (store) => {
    expect(voxelAt(store, FIRST)).toBe(1);
    expect(voxelAt(store, SECOND)).toBe(0);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, FIRST)).toBe(0);
    expect(voxelAt(store, SECOND)).toBe(0);
  },
  assertSecondApplied: (store) => {
    expect(voxelAt(store, FIRST)).toBe(1);
    expect(voxelAt(store, SECOND)).toBe(1);
  },
};

const removeSpec: CommandConformanceSpec = {
  name: "voxel.remove@1",
  type: VOXEL_REMOVE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createConformanceDocument,
  register: registerVoxelCommands,
  seed(bus: CommandBus, store: DocumentStoreRead): void {
    const before = store.revision;
    const result = bus.executeTransaction(
      [
        setAt(commandId("command:conformance:seed:0001"), FIRST),
        setAt(commandId("command:conformance:seed:0002"), SECOND),
      ],
      {
        transactionId: transactionId("transaction:conformance:seed:0001"),
        expectedRevision: before,
        source: "ui",
      },
    );
    if (!result.ok) {
      throw new Error(`conformance seed failed: ${result.error.code}`);
    }
  },
  buildValid: (id) => removeAt(id, FIRST),
  buildInvalid: (id) => ({
    id,
    type: VOXEL_REMOVE_COMMAND,
    schemaVersion: 1,
    payload: {
      volumeId: volumeId("volume:conformance:missing"),
      coordinate: FIRST,
    },
  }),
  buildSecondValid: (id) => removeAt(id, SECOND),
  assertApplied: (store) => {
    expect(voxelAt(store, FIRST)).toBe(0);
    expect(voxelAt(store, SECOND)).toBe(1);
  },
  assertUndone: (store) => {
    expect(voxelAt(store, FIRST)).toBe(1);
    expect(voxelAt(store, SECOND)).toBe(1);
  },
  assertSecondApplied: (store) => {
    expect(voxelAt(store, FIRST)).toBe(0);
    expect(voxelAt(store, SECOND)).toBe(0);
  },
};

runCommandConformanceSuite(setSpec, { describe, it, expect });
runCommandConformanceSuite(removeSpec, { describe, it, expect });

// ---------------------------------------------------------------------------
// volume.create / volume.delete (ticket #24): generic volume lifecycle
// ---------------------------------------------------------------------------

const NEW_VOLUME = volumeId("volume:conformance:created");
const SECOND_VOLUME = volumeId("volume:conformance:second");
const THIRD_VOLUME = volumeId("volume:conformance:third");

/**
 * Conformance document for volume lifecycle commands: the root node carries
 * no voxel component so every declared volume is unreferenced and deletable.
 */
function createVolumeConformanceDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:conformance:0001" as never,
    metadata: { title: "command conformance", tags: [] },
    rootNodeId: "node:conformance:root" as never,
    nodes: [
      {
        nodeId: "node:conformance:root" as never,
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
        name: "demo",
        color: "#ff8800",
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
      {
        volumeId: SECOND_VOLUME,
        bounds: { min: [0, 0, 0], max: [2, 2, 2] },
      },
    ],
  });
}

const volumeCreateSpec: CommandConformanceSpec = {
  name: "volume.create@1",
  type: VOLUME_CREATE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createVolumeConformanceDocument,
  register: registerVolumeCommands,
  buildValid: (id) =>
    createVolumeCommand(id, {
      volumeId: NEW_VOLUME,
      name: "Imported",
      bounds: { min: [0, 0, -2], max: [3, 3, 0] },
    }),
  buildInvalid: (id) => ({
    id,
    type: VOLUME_CREATE_COMMAND,
    schemaVersion: 1,
    payload: { volumeId: VOLUME },
  }),
  buildExecuteInvalid: (id) =>
    createVolumeCommand(id, {
      volumeId: NEW_VOLUME,
      entries: [{ coordinate: [2_000_000, 0, 0], material: materialId(1) }],
    }),
  assertApplied: (store) => {
    const descriptor = store.getDocument().volumes[NEW_VOLUME];
    expect(descriptor?.name).toBe("Imported");
    expect(descriptor?.bounds).toEqual({
      min: [0, 0, -2],
      max: [3, 3, 0],
    });
    expect(store.getVolume(NEW_VOLUME)?.occupiedCount()).toBe(0);
  },
  assertUndone: (store) => {
    expect(store.getVolume(NEW_VOLUME)).toBeUndefined();
    expect(store.getDocument().volumes[NEW_VOLUME]).toBeUndefined();
  },
  buildSecondValid: (id) =>
    createVolumeCommand(id, {
      volumeId: THIRD_VOLUME,
      entries: [{ coordinate: [5, 5, 5], material: materialId(1) }],
    }),
  assertSecondApplied: (store) => {
    expect(store.getVoxel(THIRD_VOLUME, [5, 5, 5])).toBe(1);
    expect(store.getDocument().volumes[NEW_VOLUME]?.name).toBe("Imported");
  },
};
runCommandConformanceSuite(volumeCreateSpec, { describe, it, expect });

describe("volume.create append mode material validation (issue #86)", () => {
  const makeHarness = () => {
    const document = createVolumeConformanceDocument();
    const { store, writeCapability } = createDocumentStoreHandle({ document });
    const registry = new CommandRegistry();
    registerVolumeCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    return { store, bus };
  };

  it("rejects appending entries with undeclared materials atomically", () => {
    const { store, bus } = makeHarness();
    let events = 0;
    store.subscribe(() => {
      events += 1;
    });
    const result = bus.executeTransaction(
      [
        createVolumeCommand(commandId("command:conformance:append:0001"), {
          volumeId: NEW_VOLUME,
          name: "Imported",
        }),
        createVolumeCommand(commandId("command:conformance:append:0002"), {
          volumeId: NEW_VOLUME,
          entries: [{ coordinate: [0, 0, 0], material: materialId(65_535) }],
        }),
      ],
      {
        transactionId: transactionId("transaction:conformance:append:0001"),
        expectedRevision: 0,
        source: "import",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_MATERIAL");
    expect(store.revision).toBe(0);
    expect(events).toBe(0);
    expect(store.getVolume(NEW_VOLUME)).toBeUndefined();
    expect(store.getDocument().volumes[NEW_VOLUME]).toBeUndefined();
  });

  it("appends entries whose materials are declared in the same transaction", () => {
    const { store, bus } = makeHarness();
    const result = bus.executeTransaction(
      [
        createVolumeCommand(commandId("command:conformance:append:0003"), {
          volumeId: NEW_VOLUME,
          name: "Imported",
        }),
        createVolumeCommand(commandId("command:conformance:append:0004"), {
          volumeId: NEW_VOLUME,
          entries: [{ coordinate: [0, 0, 0], material: materialId(1) }],
        }),
      ],
      {
        transactionId: transactionId("transaction:conformance:append:0002"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.revision).toBe(1);
    expect(store.getVoxel(NEW_VOLUME, [0, 0, 0])).toBe(1);
  });
});

const volumeDeleteSpec: CommandConformanceSpec = {
  name: "volume.delete@1",
  type: VOLUME_DELETE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createVolumeConformanceDocument,
  register: registerVolumeCommands,
  seed: (bus, store) => {
    const result = bus.execute(
      createVolumeCommand(commandId("command:conformance:volume.delete:seed"), {
        volumeId: NEW_VOLUME,
        name: "Seeded",
        entries: [
          { coordinate: [0, 0, 0], material: materialId(1) },
          { coordinate: [3, 3, 3], material: materialId(1) },
        ],
      }),
      {
        transactionId: transactionId(
          "transaction:conformance:volume.delete:seed",
        ),
        expectedRevision: store.revision,
        source: "ui",
      },
    );
    if (!result.ok) throw new Error("volume.delete seed failed");
  },
  buildValid: (id) => deleteVolumeCommand(id, { volumeId: NEW_VOLUME }),
  buildInvalid: (id) => ({
    id,
    type: VOLUME_DELETE_COMMAND,
    schemaVersion: 1,
    payload: { volumeId: 123 },
  }),
  assertApplied: (store) => {
    expect(store.getVolume(NEW_VOLUME)).toBeUndefined();
    expect(store.getDocument().volumes[NEW_VOLUME]).toBeUndefined();
  },
  assertUndone: (store) => {
    const volume = store.getVolume(NEW_VOLUME);
    expect(volume?.occupiedCount()).toBe(2);
    expect(store.getVoxel(NEW_VOLUME, [0, 0, 0])).toBe(1);
    expect(store.getVoxel(NEW_VOLUME, [3, 3, 3])).toBe(1);
    expect(store.getDocument().volumes[NEW_VOLUME]?.name).toBe("Seeded");
  },
  buildSecondValid: (id) =>
    deleteVolumeCommand(id, { volumeId: SECOND_VOLUME }),
  assertSecondApplied: (store) => {
    expect(store.getVolume(NEW_VOLUME)).toBeUndefined();
    expect(store.getVolume(SECOND_VOLUME)).toBeUndefined();
  },
};
runCommandConformanceSuite(volumeDeleteSpec, { describe, it, expect });

/** Every registered persistent command must declare a conformance spec (plan 4.17). */
const CONFORMANCE_TESTED_COMMANDS = [
  commandKey(MATERIAL_CREATE_COMMAND, 1),
  commandKey(MATERIAL_DELETE_COMMAND, 1),
  commandKey(MATERIAL_UPDATE_COMMAND, 1),
  commandKey(NODE_ADD_CONSTRAINT_COMMAND, 1),
  commandKey(NODE_ADD_JOINT_COMMAND, 1),
  commandKey(NODE_CREATE_COMMAND, 1),
  commandKey(NODE_DELETE_COMMAND, 1),
  commandKey(NODE_REMOVE_CONSTRAINT_COMMAND, 1),
  commandKey(NODE_REMOVE_JOINT_COMMAND, 1),
  commandKey(NODE_REMOVE_PIVOT_COMMAND, 1),
  commandKey(NODE_RENAME_COMMAND, 1),
  commandKey(NODE_REORDER_CONSTRAINT_COMMAND, 1),
  commandKey(NODE_REPARENT_COMMAND, 1),
  commandKey(NODE_SET_COMPONENTS_COMMAND, 1),
  commandKey(NODE_SET_CONSTRAINT_COMMAND, 1),
  commandKey(NODE_SET_METADATA_COMMAND, 1),
  commandKey(NODE_SET_PIVOT_COMMAND, 1),
  commandKey(NODE_SET_TRANSFORM_COMMAND, 1),
  commandKey(VOLUME_CREATE_COMMAND, 1),
  commandKey(VOLUME_DELETE_COMMAND, 1),
  commandKey(VOXEL_APPLY_PATCHES_COMMAND, 1),
  commandKey(VOXEL_COPY_REGION_COMMAND, 1),
  commandKey(VOXEL_DELETE_REGION_COMMAND, 1),
  commandKey(VOXEL_FILL_BOX_COMMAND, 1),
  commandKey(VOXEL_FILL_CYLINDER_COMMAND, 1),
  commandKey(VOXEL_FILL_SPHERE_COMMAND, 1),
  commandKey(VOXEL_MIRROR_REGION_COMMAND, 1),
  commandKey(VOXEL_REMOVE_COMMAND, 1),
  commandKey(VOXEL_REMOVE_BATCH_COMMAND, 1),
  commandKey(VOXEL_REPLACE_MATERIAL_COMMAND, 1),
  commandKey(VOXEL_ROTATE_REGION_COMMAND, 1),
  commandKey(VOXEL_SET_COMMAND, 1),
  commandKey(VOXEL_SET_BATCH_COMMAND, 1),
  commandKey(VOXEL_TRANSLATE_REGION_COMMAND, 1),
] as const;

describe("command conformance coverage", () => {
  it("runs every registered command through the conformance suite", () => {
    const registry = new CommandRegistry();
    registerVoxelCommands(registry);
    registerBatchCommands(registry);
    registerRegionCommands(registry);
    registerNodeCommands(registry);
    registerArticulationCommands(registry);
    registerMaterialCommands(registry);
    registerVolumeCommands(registry);
    const registered = registry
      .list()
      .map(({ type, schemaVersion }) => commandKey(type, schemaVersion));
    expect(registered).toEqual([...CONFORMANCE_TESTED_COMMANDS]);
  });
});
