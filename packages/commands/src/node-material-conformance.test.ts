import { describe, expect, it } from "vitest";
import {
  commandId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import {
  cloneDocument,
  createDocument,
  type Color,
  type VoxelDocument,
} from "@voxel-maker/model";
import type { DocumentStoreRead } from "@voxel-maker/document";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import {
  NODE_CREATE_COMMAND,
  NODE_DELETE_COMMAND,
  NODE_RENAME_COMMAND,
  NODE_REPARENT_COMMAND,
  NODE_SET_COMPONENTS_COMMAND,
  NODE_SET_METADATA_COMMAND,
  NODE_SET_TRANSFORM_COMMAND,
  createNodeCommand,
  deleteNodeCommand,
  registerNodeCommands,
  renameNodeCommand,
  reparentNodeCommand,
  setNodeComponentsCommand,
  setNodeMetadataCommand,
  setNodeTransformCommand,
} from "./node-commands.js";
import {
  MATERIAL_CREATE_COMMAND,
  MATERIAL_DELETE_COMMAND,
  MATERIAL_UPDATE_COMMAND,
  createMaterialCommand,
  deleteMaterialCommand,
  registerMaterialCommands,
  updateMaterialCommand,
} from "./material-commands.js";
import { registerVoxelCommands, setVoxelCommand } from "./voxel-commands.js";
import { registerBatchCommands } from "./batch-commands.js";
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

const T1 = {
  translation: [1, 2, 3],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const T2 = {
  translation: [4, 5, 6],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [2, 2, 2],
} as const;

const ROOT = nodeId("node:conformance:root");
const CHILD = nodeId("node:conformance:child");
const GRANDCHILD = nodeId("node:conformance:grandchild");
const NEW = nodeId("node:conformance:new");
const NEW2 = nodeId("node:conformance:new2");
const LEAF = nodeId("node:conformance:leaf");
const PARENT2 = nodeId("node:conformance:parent2");
const VOLUME = volumeId("volume:conformance:0001");
const MATERIAL_ONE = materialId(1);
const MATERIAL_TWO = materialId(2);
const MATERIAL_THREE = materialId(3);

/** Deterministic fixture; `createDocument` returns a fresh clone per test. */
function buildFixtureDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:conformance:node-material" as never,
    metadata: { title: "node and material conformance" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [CHILD],
        transform: identity,
        components: [],
      },
      {
        nodeId: CHILD,
        name: "Child",
        parentId: ROOT,
        children: [GRANDCHILD],
        transform: T1,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
        metadata: { role: "child" },
      },
      {
        nodeId: GRANDCHILD,
        name: "Grandchild",
        parentId: CHILD,
        children: [],
        transform: identity,
        components: [],
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

const fixture = buildFixtureDocument();

const color = (value: string): Color => value as Color;

const createFixture = (): VoxelDocument => cloneDocument(fixture);

const nodeRecord = (store: DocumentStoreRead, id: string) =>
  store.getDocument().nodes[id as never];

const materialRecord = (store: DocumentStoreRead, id: number) =>
  store.getDocument().materials[id as never];

const voxelAt = (
  store: DocumentStoreRead,
  coordinate: readonly [number, number, number],
) => store.getVoxel(VOLUME, coordinate);

const createSpec: CommandConformanceSpec = {
  name: "node.create@1",
  type: NODE_CREATE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerNodeCommands,
  buildValid: (id) =>
    createNodeCommand(id, {
      nodeId: NEW,
      parentId: ROOT,
      name: "New",
      transform: identity,
    }),
  buildInvalid: (id) =>
    createNodeCommand(id, {
      nodeId: CHILD,
      parentId: ROOT,
      transform: identity,
    }),
  buildSecondValid: (id) =>
    createNodeCommand(id, {
      nodeId: NEW2,
      parentId: CHILD,
      transform: identity,
    }),
  assertApplied: (store) => {
    const created = nodeRecord(store, NEW);
    expect(created).toBeDefined();
    if (created === undefined) return;
    expect(created.parentId).toBe(ROOT);
    expect(created.name).toBe("New");
    expect(created.children).toEqual([]);
    expect(nodeRecord(store, ROOT)?.children).toEqual([CHILD, NEW]);
  },
  assertUndone: (store) => {
    expect(nodeRecord(store, NEW)).toBeUndefined();
    expect(nodeRecord(store, ROOT)?.children).toEqual([CHILD]);
  },
  assertSecondApplied: (store) => {
    expect(nodeRecord(store, NEW)?.parentId).toBe(ROOT);
    expect(nodeRecord(store, NEW2)?.parentId).toBe(CHILD);
    expect(nodeRecord(store, CHILD)?.children).toEqual([GRANDCHILD, NEW2]);
  },
};

const renameSpec: CommandConformanceSpec = {
  name: "node.rename@1",
  type: NODE_RENAME_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerNodeCommands,
  buildValid: (id) => renameNodeCommand(id, { nodeId: CHILD, name: "Renamed" }),
  buildInvalid: (id) =>
    renameNodeCommand(id, {
      nodeId: nodeId("node:conformance:missing"),
      name: "x",
    }),
  buildSecondValid: (id) =>
    renameNodeCommand(id, { nodeId: GRANDCHILD, name: "Grand" }),
  assertApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.name).toBe("Renamed");
  },
  assertUndone: (store) => {
    expect(nodeRecord(store, CHILD)?.name).toBe("Child");
  },
  assertSecondApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.name).toBe("Renamed");
    expect(nodeRecord(store, GRANDCHILD)?.name).toBe("Grand");
  },
};

const setTransformSpec: CommandConformanceSpec = {
  name: "node.setTransform@1",
  type: NODE_SET_TRANSFORM_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerNodeCommands,
  buildValid: (id) =>
    setNodeTransformCommand(id, { nodeId: CHILD, transform: T2 }),
  buildInvalid: (id) => ({
    id,
    type: NODE_SET_TRANSFORM_COMMAND,
    schemaVersion: 1,
    payload: {
      nodeId: CHILD,
      transform: {
        translation: [0, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0, 0, 0, -1],
        scale: [1, 1, 1],
      },
    },
  }),
  buildSecondValid: (id) =>
    setNodeTransformCommand(id, { nodeId: GRANDCHILD, transform: T2 }),
  assertApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.transform).toEqual(T2);
  },
  assertUndone: (store) => {
    expect(nodeRecord(store, CHILD)?.transform).toEqual(T1);
  },
  assertSecondApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.transform).toEqual(T2);
    expect(nodeRecord(store, GRANDCHILD)?.transform).toEqual(T2);
  },
};

const setComponentsSpec: CommandConformanceSpec = {
  name: "node.setComponents@1",
  type: NODE_SET_COMPONENTS_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerNodeCommands,
  buildValid: (id) =>
    setNodeComponentsCommand(id, {
      nodeId: CHILD,
      components: [{ kind: "pivot", schemaVersion: 1, pivot: [0, 0, 0] }],
    }),
  buildInvalid: (id) => ({
    id,
    type: NODE_SET_COMPONENTS_COMMAND,
    schemaVersion: 1,
    payload: {
      nodeId: CHILD,
      components: [{ kind: "unknown", schemaVersion: 1 }],
    },
  }),
  buildSecondValid: (id) =>
    setNodeComponentsCommand(id, {
      nodeId: GRANDCHILD,
      components: [{ kind: "joint", schemaVersion: 1 }],
    }),
  assertApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "pivot", schemaVersion: 1, pivot: [0, 0, 0] },
    ]);
  },
  assertUndone: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
    ]);
  },
  assertSecondApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "pivot", schemaVersion: 1, pivot: [0, 0, 0] },
    ]);
    expect(nodeRecord(store, GRANDCHILD)?.components).toEqual([
      { kind: "joint", schemaVersion: 1 },
    ]);
  },
};

const setMetadataSpec: CommandConformanceSpec = {
  name: "node.setMetadata@1",
  type: NODE_SET_METADATA_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerNodeCommands,
  buildValid: (id) =>
    setNodeMetadataCommand(id, {
      nodeId: CHILD,
      metadata: { role: "updated", tags: ["a", "b"] },
    }),
  buildInvalid: (id) => ({
    id,
    type: NODE_SET_METADATA_COMMAND,
    schemaVersion: 1,
    payload: { nodeId: CHILD, metadata: "not-an-object" },
  }),
  buildSecondValid: (id) =>
    setNodeMetadataCommand(id, { nodeId: GRANDCHILD, metadata: { x: 1 } }),
  assertApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.metadata).toEqual({
      role: "updated",
      tags: ["a", "b"],
    });
  },
  assertUndone: (store) => {
    expect(nodeRecord(store, CHILD)?.metadata).toEqual({ role: "child" });
  },
  assertSecondApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.metadata).toEqual({
      role: "updated",
      tags: ["a", "b"],
    });
    expect(nodeRecord(store, GRANDCHILD)?.metadata).toEqual({ x: 1 });
  },
};

const deleteSpec: CommandConformanceSpec = {
  name: "node.delete@1",
  type: NODE_DELETE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerNodeCommands,
  seed(bus: CommandBus, store: DocumentStoreRead): void {
    const result = bus.execute(
      createNodeCommand(commandId("command:conformance:seed:node:0001"), {
        nodeId: LEAF,
        parentId: CHILD,
        name: "Leaf",
        transform: identity,
      }),
      {
        transactionId: transactionId("transaction:conformance:seed:node:0001"),
        expectedRevision: store.revision,
        source: "ui",
      },
    );
    if (!result.ok) {
      throw new Error(`conformance seed failed: ${result.error.code}`);
    }
  },
  buildValid: (id) => deleteNodeCommand(id, { nodeId: GRANDCHILD }),
  buildInvalid: (id) => deleteNodeCommand(id, { nodeId: ROOT }),
  buildSecondValid: (id) => deleteNodeCommand(id, { nodeId: LEAF }),
  assertApplied: (store) => {
    expect(nodeRecord(store, GRANDCHILD)).toBeUndefined();
    expect(nodeRecord(store, LEAF)).toBeDefined();
    expect(nodeRecord(store, CHILD)?.children).toEqual([LEAF]);
  },
  assertUndone: (store) => {
    const restored = nodeRecord(store, GRANDCHILD);
    expect(restored).toBeDefined();
    if (restored === undefined) return;
    expect(restored.parentId).toBe(CHILD);
    expect(restored.name).toBe("Grandchild");
    expect(restored.transform).toEqual(identity);
    expect(restored.components).toEqual([]);
    expect(nodeRecord(store, CHILD)?.children).toEqual([GRANDCHILD, LEAF]);
  },
  assertSecondApplied: (store) => {
    expect(nodeRecord(store, GRANDCHILD)).toBeUndefined();
    expect(nodeRecord(store, LEAF)).toBeUndefined();
    expect(nodeRecord(store, CHILD)?.children).toEqual([]);
  },
};

const reparentLocalSpec: CommandConformanceSpec = {
  name: "node.reparent@1 (preserve-local)",
  type: NODE_REPARENT_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerNodeCommands,
  seed(bus: CommandBus, store: DocumentStoreRead): void {
    const result = bus.execute(
      createNodeCommand(commandId("command:conformance:seed:parent:0001"), {
        nodeId: PARENT2,
        parentId: ROOT,
        name: "Parent2",
        transform: identity,
      }),
      {
        transactionId: transactionId(
          "transaction:conformance:seed:parent:0001",
        ),
        expectedRevision: store.revision,
        source: "ui",
      },
    );
    if (!result.ok) {
      throw new Error(`conformance seed failed: ${result.error.code}`);
    }
  },
  buildValid: (id) =>
    reparentNodeCommand(
      id,
      { nodeId: GRANDCHILD, newParentId: PARENT2, placement: "preserve-local" },
      fixture,
    ),
  buildInvalid: (id) =>
    reparentNodeCommand(
      id,
      { nodeId: CHILD, newParentId: CHILD, placement: "preserve-local" },
      fixture,
    ),
  buildSecondValid: (id) =>
    reparentNodeCommand(
      id,
      { nodeId: CHILD, newParentId: PARENT2, placement: "preserve-local" },
      fixture,
    ),
  assertApplied: (store) => {
    expect(nodeRecord(store, GRANDCHILD)?.parentId).toBe(PARENT2);
    expect(nodeRecord(store, GRANDCHILD)?.transform).toEqual(identity);
    expect(nodeRecord(store, PARENT2)?.children).toEqual([GRANDCHILD]);
    expect(nodeRecord(store, CHILD)?.children).toEqual([]);
  },
  assertUndone: (store) => {
    expect(nodeRecord(store, GRANDCHILD)?.parentId).toBe(CHILD);
    expect(nodeRecord(store, GRANDCHILD)?.transform).toEqual(identity);
    expect(nodeRecord(store, CHILD)?.children).toEqual([GRANDCHILD]);
    expect(nodeRecord(store, PARENT2)?.children).toEqual([]);
  },
  assertSecondApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.parentId).toBe(PARENT2);
    expect(nodeRecord(store, GRANDCHILD)?.parentId).toBe(PARENT2);
    expect(nodeRecord(store, PARENT2)?.children).toEqual([GRANDCHILD, CHILD]);
    expect(nodeRecord(store, ROOT)?.children).toEqual([PARENT2]);
  },
};

const reparentWorldSpec: CommandConformanceSpec = {
  name: "node.reparent@1 (preserve-world)",
  type: NODE_REPARENT_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerNodeCommands,
  buildValid: (id) =>
    reparentNodeCommand(
      id,
      { nodeId: GRANDCHILD, newParentId: ROOT, placement: "preserve-world" },
      fixture,
    ),
  buildInvalid: (id) =>
    reparentNodeCommand(
      id,
      { nodeId: CHILD, newParentId: CHILD, placement: "preserve-world" },
      fixture,
    ),
  buildSecondValid: (id) =>
    reparentNodeCommand(
      id,
      { nodeId: CHILD, newParentId: GRANDCHILD, placement: "preserve-world" },
      fixture,
    ),
  assertApplied: (store) => {
    expect(nodeRecord(store, GRANDCHILD)?.parentId).toBe(ROOT);
    expect(nodeRecord(store, GRANDCHILD)?.transform).toEqual(T1);
    expect(nodeRecord(store, ROOT)?.children).toEqual([CHILD, GRANDCHILD]);
    expect(nodeRecord(store, CHILD)?.children).toEqual([]);
  },
  assertUndone: (store) => {
    expect(nodeRecord(store, GRANDCHILD)?.parentId).toBe(CHILD);
    expect(nodeRecord(store, GRANDCHILD)?.transform).toEqual(identity);
    expect(nodeRecord(store, CHILD)?.children).toEqual([GRANDCHILD]);
  },
  assertSecondApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.parentId).toBe(GRANDCHILD);
    expect(nodeRecord(store, CHILD)?.transform).toEqual(identity);
    expect(nodeRecord(store, GRANDCHILD)?.parentId).toBe(ROOT);
    expect(nodeRecord(store, GRANDCHILD)?.transform).toEqual(T1);
    expect(nodeRecord(store, GRANDCHILD)?.children).toEqual([CHILD]);
  },
};

const materialCreateSpec: CommandConformanceSpec = {
  name: "material.create@1",
  type: MATERIAL_CREATE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerMaterialCommands,
  buildValid: (id) =>
    createMaterialCommand(id, {
      materialId: MATERIAL_THREE,
      name: "three",
      color: color("#00ff00"),
      opacity: 1,
      roughness: 0.5,
      metallic: 0,
      emissive: 0,
    }),
  buildInvalid: (id) =>
    createMaterialCommand(id, {
      materialId: MATERIAL_ONE,
      name: "duplicate",
      color: color("#00ff00"),
      opacity: 1,
      roughness: 0.5,
      metallic: 0,
      emissive: 0,
    }),
  buildSecondValid: (id) =>
    createMaterialCommand(id, {
      materialId: materialId(4),
      name: "four",
      color: color("#0000ff"),
      opacity: 0.5,
      roughness: 0.2,
      metallic: 0.8,
      emissive: 0.1,
    }),
  assertApplied: (store) => {
    const created = materialRecord(store, MATERIAL_THREE);
    expect(created).toBeDefined();
    if (created === undefined) return;
    expect(created.name).toBe("three");
    expect(created.color).toBe("#00ff00");
  },
  assertUndone: (store) => {
    expect(materialRecord(store, MATERIAL_THREE)).toBeUndefined();
  },
  assertSecondApplied: (store) => {
    expect(materialRecord(store, MATERIAL_THREE)?.name).toBe("three");
    expect(materialRecord(store, 4)?.name).toBe("four");
  },
};

const materialUpdateSpec: CommandConformanceSpec = {
  name: "material.update@1",
  type: MATERIAL_UPDATE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerMaterialCommands,
  buildValid: (id) =>
    updateMaterialCommand(id, {
      materialId: MATERIAL_ONE,
      name: "one-updated",
      color: color("#00ff00"),
    }),
  buildInvalid: (id) => updateMaterialCommand(id, { materialId: MATERIAL_ONE }),
  buildSecondValid: (id) =>
    updateMaterialCommand(id, { materialId: MATERIAL_TWO, opacity: 0.5 }),
  assertApplied: (store) => {
    expect(materialRecord(store, MATERIAL_ONE)?.name).toBe("one-updated");
    expect(materialRecord(store, MATERIAL_ONE)?.color).toBe("#00ff00");
  },
  assertUndone: (store) => {
    expect(materialRecord(store, MATERIAL_ONE)?.name).toBe("one");
    expect(materialRecord(store, MATERIAL_ONE)?.color).toBe("#ff8800");
  },
  assertSecondApplied: (store) => {
    expect(materialRecord(store, MATERIAL_ONE)?.name).toBe("one-updated");
    expect(materialRecord(store, MATERIAL_TWO)?.opacity).toBe(0.5);
  },
};

const materialDeleteUnreferencedSpec: CommandConformanceSpec = {
  name: "material.delete@1 (unreferenced)",
  type: MATERIAL_DELETE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerMaterialCommands,
  buildValid: (id) => deleteMaterialCommand(id, { materialId: MATERIAL_TWO }),
  buildInvalid: (id) =>
    deleteMaterialCommand(id, {
      materialId: MATERIAL_ONE,
      replacement: MATERIAL_ONE,
    }),
  buildSecondValid: (id) =>
    deleteMaterialCommand(id, { materialId: MATERIAL_ONE }),
  assertApplied: (store) => {
    expect(materialRecord(store, MATERIAL_TWO)).toBeUndefined();
    expect(materialRecord(store, MATERIAL_ONE)).toBeDefined();
  },
  assertUndone: (store) => {
    expect(materialRecord(store, MATERIAL_TWO)).toBeDefined();
    expect(materialRecord(store, MATERIAL_ONE)).toBeDefined();
  },
  assertSecondApplied: (store) => {
    expect(materialRecord(store, MATERIAL_TWO)).toBeUndefined();
    expect(materialRecord(store, MATERIAL_ONE)).toBeUndefined();
  },
};

const materialDeleteReplacementSpec: CommandConformanceSpec = {
  name: "material.delete@1 (replacement)",
  type: MATERIAL_DELETE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register(registry: CommandRegistry): void {
    registerMaterialCommands(registry);
    registerVoxelCommands(registry);
    registerBatchCommands(registry);
  },
  seed(bus: CommandBus, store: DocumentStoreRead): void {
    const before = store.revision;
    const result = bus.executeTransaction(
      [
        createMaterialCommand(
          commandId("command:conformance:seed:material:0001"),
          {
            materialId: MATERIAL_THREE,
            name: "three",
            color: color("#00ff00"),
            opacity: 1,
            roughness: 0.5,
            metallic: 0,
            emissive: 0,
          },
        ),
        setVoxelCommand(commandId("command:conformance:seed:voxel:0001"), {
          volumeId: VOLUME,
          coordinate: [0, 0, 0],
          material: MATERIAL_ONE,
        }),
      ],
      {
        transactionId: transactionId(
          "transaction:conformance:seed:material:0001",
        ),
        expectedRevision: before,
        source: "ui",
      },
    );
    if (!result.ok) {
      throw new Error(`conformance seed failed: ${result.error.code}`);
    }
  },
  buildValid: (id) =>
    deleteMaterialCommand(id, {
      materialId: MATERIAL_ONE,
      replacement: MATERIAL_THREE,
    }),
  buildInvalid: (id) =>
    deleteMaterialCommand(id, {
      materialId: MATERIAL_TWO,
      replacement: MATERIAL_TWO,
    }),
  buildSecondValid: (id) =>
    deleteMaterialCommand(id, {
      materialId: MATERIAL_TWO,
      replacement: MATERIAL_THREE,
    }),
  assertApplied: (store) => {
    expect(materialRecord(store, MATERIAL_ONE)).toBeUndefined();
    expect(materialRecord(store, MATERIAL_TWO)).toBeDefined();
    expect(voxelAt(store, [0, 0, 0])).toBe(MATERIAL_THREE);
  },
  assertUndone: (store) => {
    expect(materialRecord(store, MATERIAL_ONE)).toBeDefined();
    expect(materialRecord(store, MATERIAL_TWO)).toBeDefined();
    expect(voxelAt(store, [0, 0, 0])).toBe(MATERIAL_ONE);
  },
  assertSecondApplied: (store) => {
    expect(materialRecord(store, MATERIAL_ONE)).toBeUndefined();
    expect(materialRecord(store, MATERIAL_TWO)).toBeUndefined();
    expect(voxelAt(store, [0, 0, 0])).toBe(MATERIAL_THREE);
  },
};

runCommandConformanceSuite(createSpec, { describe, it, expect });
runCommandConformanceSuite(renameSpec, { describe, it, expect });
runCommandConformanceSuite(setTransformSpec, { describe, it, expect });
runCommandConformanceSuite(setComponentsSpec, { describe, it, expect });
runCommandConformanceSuite(setMetadataSpec, { describe, it, expect });
runCommandConformanceSuite(deleteSpec, { describe, it, expect });
runCommandConformanceSuite(reparentLocalSpec, { describe, it, expect });
runCommandConformanceSuite(reparentWorldSpec, { describe, it, expect });
runCommandConformanceSuite(materialCreateSpec, { describe, it, expect });
runCommandConformanceSuite(materialUpdateSpec, { describe, it, expect });
runCommandConformanceSuite(materialDeleteUnreferencedSpec, {
  describe,
  it,
  expect,
});
runCommandConformanceSuite(materialDeleteReplacementSpec, {
  describe,
  it,
  expect,
});

/** Every registered persistent command must declare a conformance spec (plan 4.17). */
const NODE_MATERIAL_CONFORMANCE_COMMANDS = [
  commandKey(MATERIAL_CREATE_COMMAND, 1),
  commandKey(MATERIAL_DELETE_COMMAND, 1),
  commandKey(MATERIAL_UPDATE_COMMAND, 1),
  commandKey(NODE_CREATE_COMMAND, 1),
  commandKey(NODE_DELETE_COMMAND, 1),
  commandKey(NODE_RENAME_COMMAND, 1),
  commandKey(NODE_REPARENT_COMMAND, 1),
  commandKey(NODE_SET_COMPONENTS_COMMAND, 1),
  commandKey(NODE_SET_METADATA_COMMAND, 1),
  commandKey(NODE_SET_TRANSFORM_COMMAND, 1),
] as const;

describe("node and material command conformance coverage", () => {
  it("runs every registered node and material command through the conformance suite", () => {
    const registry = new CommandRegistry();
    registerNodeCommands(registry);
    registerMaterialCommands(registry);
    const registered = registry
      .list()
      .map(({ type, schemaVersion }) => commandKey(type, schemaVersion));
    expect(registered).toEqual([...NODE_MATERIAL_CONFORMANCE_COMMANDS]);
  });
});
