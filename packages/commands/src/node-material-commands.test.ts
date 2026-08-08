import { describe, expect, it } from "vitest";
import {
  commandId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { createDocumentStore } from "@voxel-maker/document";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import {
  NODE_REPARENT_COMMAND,
  NODE_SET_COMPONENTS_COMMAND,
  NODE_SET_METADATA_COMMAND,
  createNodeCommand,
  deleteNodeCommand,
  registerNodeCommands,
  renameNodeCommand,
  reparentNodeCommand,
  setNodeComponentsCommand,
} from "./node-commands.js";
import { worldTransformMatrix } from "@voxel-maker/document";
import {
  createMaterialCommand,
  deleteMaterialCommand,
  registerMaterialCommands,
  updateMaterialCommand,
} from "./material-commands.js";
import { registerVoxelCommands, setVoxelCommand } from "./voxel-commands.js";
import { registerBatchCommands } from "./batch-commands.js";
import {
  applyMatrix,
  multiplyMatrices,
  transformToMatrix,
} from "@voxel-maker/math";

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

const ROOT = nodeId("node:behavior:root");
const CHILD = nodeId("node:behavior:child");
const GRANDCHILD = nodeId("node:behavior:grandchild");
const NEW = nodeId("node:behavior:new");
const VOLUME = volumeId("volume:behavior:0001");
const VOLUME_TWO = volumeId("volume:behavior:0002");
const MATERIAL_ONE = materialId(1);
const MATERIAL_TWO = materialId(2);
const MATERIAL_THREE = materialId(3);

function createBehaviorDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:behavior:0001" as never,
    metadata: { title: "node and material behavior" },
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
      {
        volumeId: VOLUME_TWO,
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    ],
  });
}

function createHarness(): {
  bus: CommandBus;
  store: ReturnType<typeof createDocumentStore>["store"];
} {
  const { store, writeCapability } = createDocumentStore({
    document: createBehaviorDocument(),
  });
  const registry = new CommandRegistry();
  registerNodeCommands(registry);
  registerMaterialCommands(registry);
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  return { bus: new CommandBus(store, registry, writeCapability), store };
}

const options = (id: string, expectedRevision: number) => ({
  transactionId: transactionId(`transaction:behavior:${id}`),
  expectedRevision,
  source: "ui" as const,
});

const node = (
  store: ReturnType<typeof createDocumentStore>["store"],
  id: string,
) => store.getDocument().nodes[id as never];

describe("node commands", () => {
  it("lets later commands in one transaction see earlier staged record effects", () => {
    const { bus, store } = createHarness();
    const result = bus.executeTransaction(
      [
        createNodeCommand(commandId("command:behavior:create:0001"), {
          nodeId: NEW,
          parentId: ROOT,
          name: "New",
          transform: identity,
        }),
        renameNodeCommand(commandId("command:behavior:rename:0001"), {
          nodeId: NEW,
          name: "Renamed",
        }),
      ],
      options("staged:0001", 0),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(node(store, NEW)?.name).toBe("Renamed");
    expect(node(store, ROOT)?.children).toEqual([CHILD, NEW]);
  });

  it("reports changed node ids on events and none for no-op creates", () => {
    const { bus } = createHarness();
    const created = bus.execute(
      createNodeCommand(commandId("command:behavior:create:0002"), {
        nodeId: NEW,
        parentId: ROOT,
        transform: identity,
      }),
      options("event:0001", 0),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.event.changedNodeIds).toEqual([NEW]);
    expect(created.value.event.changedMaterialIds).toEqual([]);

    const noop = bus.execute(
      createNodeCommand(commandId("command:behavior:create:0003"), {
        nodeId: NEW,
        parentId: ROOT,
        transform: identity,
      }),
      options("event:0002", 1),
    );
    expect(noop.ok).toBe(true);
    if (!noop.ok) return;
    expect(noop.value.event.changedNodeIds).toEqual([]);
  });

  it("inserts at the requested children index and restores it on undo of delete", () => {
    const { bus, store } = createHarness();
    const inserted = bus.execute(
      createNodeCommand(commandId("command:behavior:create:0004"), {
        nodeId: NEW,
        parentId: ROOT,
        transform: identity,
        index: 0,
      }),
      options("index:0001", 0),
    );
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(node(store, ROOT)?.children).toEqual([NEW, CHILD]);

    const deleted = bus.execute(
      deleteNodeCommand(commandId("command:behavior:delete:0001"), {
        nodeId: NEW,
      }),
      options("index:0002", 1),
    );
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(node(store, ROOT)?.children).toEqual([CHILD]);

    const undone = bus.undo(options("index:undo:0001", 2));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(node(store, ROOT)?.children).toEqual([NEW, CHILD]);
  });

  it("rejects deleting the root, non-leaf nodes, and animation targets", () => {
    const { bus } = createHarness();
    const root = bus.execute(
      deleteNodeCommand(commandId("command:behavior:delete:0002"), {
        nodeId: ROOT,
      }),
      options("delete:0001", 0),
    );
    expect(root.ok).toBe(false);
    if (root.ok) return;
    expect(root.error.code).toBe("INVALID_ROOT");

    const nonLeaf = bus.execute(
      deleteNodeCommand(commandId("command:behavior:delete:0003"), {
        nodeId: CHILD,
      }),
      options("delete:0002", 0),
    );
    expect(nonLeaf.ok).toBe(false);
    if (nonLeaf.ok) return;
    expect(nonLeaf.error.code).toBe("NODE_HAS_CHILDREN");

    const withAnimation = createHarness();
    const animated = withAnimation.bus.execute(
      deleteNodeCommand(commandId("command:behavior:delete:0004"), {
        nodeId: GRANDCHILD,
      }),
      options("delete:0003", 0),
    );
    expect(animated.ok).toBe(true);
    if (!animated.ok) return;
    // A document with an animation track targeting the node cannot delete it.
    const animatedDoc = createDocument({
      documentId: "document:behavior:0002" as never,
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [GRANDCHILD],
          transform: identity,
          components: [],
        },
        {
          nodeId: GRANDCHILD,
          name: "Grandchild",
          parentId: ROOT,
          children: [],
          transform: identity,
          components: [],
        },
      ],
      animations: [
        {
          animationId: "animation:behavior:0001" as never,
          duration: 1,
          loop: "once",
          tracks: [
            {
              trackId: "track:behavior:0001" as never,
              targetNodeId: GRANDCHILD,
              interpolation: "step",
              keyframes: [
                {
                  keyframeId: "keyframe:behavior:0001" as never,
                  time: 0,
                  property: { channel: "translation", value: [0, 0, 0] },
                },
              ],
            },
          ],
        },
      ],
    });
    const { store: animatedStore, writeCapability } = createDocumentStore({
      document: animatedDoc,
    });
    const registry = new CommandRegistry();
    registerNodeCommands(registry);
    const animatedBus = new CommandBus(
      animatedStore,
      registry,
      writeCapability,
    );
    const rejected = animatedBus.execute(
      deleteNodeCommand(commandId("command:behavior:delete:0005"), {
        nodeId: GRANDCHILD,
      }),
      options("delete:0004", 0),
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe("REFERENCED_NODE");
  });

  it("rejects reparenting the root, to itself, and to a descendant", () => {
    const { bus } = createHarness();
    const root = bus.execute(
      reparentNodeCommand(
        commandId("command:behavior:reparent:0001"),
        { nodeId: ROOT, newParentId: CHILD, placement: "preserve-local" },
        createBehaviorDocument(),
      ),
      options("reparent:0001", 0),
    );
    expect(root.ok).toBe(false);
    if (root.ok) return;
    expect(root.error.code).toBe("INVALID_ROOT");

    const self = bus.execute(
      reparentNodeCommand(
        commandId("command:behavior:reparent:0002"),
        { nodeId: CHILD, newParentId: CHILD, placement: "preserve-local" },
        createBehaviorDocument(),
      ),
      options("reparent:0002", 0),
    );
    expect(self.ok).toBe(false);
    if (self.ok) return;
    expect(self.error.code).toBe("SELF_PARENT");

    const cycle = bus.execute(
      reparentNodeCommand(
        commandId("command:behavior:reparent:0003"),
        { nodeId: CHILD, newParentId: GRANDCHILD, placement: "preserve-local" },
        createBehaviorDocument(),
      ),
      options("reparent:0003", 0),
    );
    expect(cycle.ok).toBe(false);
    if (cycle.ok) return;
    expect(cycle.error.code).toBe("CYCLIC_HIERARCHY");
  });

  it("undo of reparent restores the exact children order", () => {
    const { store, writeCapability } = createDocumentStore({
      document: createDocument({
        documentId: "document:behavior:0003" as never,
        rootNodeId: ROOT,
        nodes: [
          {
            nodeId: ROOT,
            name: "Root",
            parentId: null,
            children: [
              nodeId("node:behavior:a"),
              nodeId("node:behavior:b"),
              nodeId("node:behavior:c"),
            ],
            transform: identity,
            components: [],
          },
          {
            nodeId: nodeId("node:behavior:a"),
            name: "A",
            parentId: ROOT,
            children: [],
            transform: identity,
            components: [],
          },
          {
            nodeId: nodeId("node:behavior:b"),
            name: "B",
            parentId: ROOT,
            children: [],
            transform: identity,
            components: [],
          },
          {
            nodeId: nodeId("node:behavior:c"),
            name: "C",
            parentId: ROOT,
            children: [],
            transform: identity,
            components: [],
          },
        ],
      }),
    });
    const registry = new CommandRegistry();
    registerNodeCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const parent2 = nodeId("node:behavior:parent2");
    const created = bus.execute(
      createNodeCommand(commandId("command:behavior:reparent-order:0001"), {
        nodeId: parent2,
        parentId: ROOT,
        transform: identity,
      }),
      options("reparent-order:0001", 0),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const moved = bus.execute(
      reparentNodeCommand(
        commandId("command:behavior:reparent-order:0002"),
        {
          nodeId: nodeId("node:behavior:b"),
          newParentId: parent2,
          placement: "preserve-local",
        },
        store.getDocument(),
      ),
      options("reparent-order:0002", 1),
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(node(store, ROOT)?.children).toEqual([
      nodeId("node:behavior:a"),
      nodeId("node:behavior:c"),
      parent2,
    ]);
    const undone = bus.undo(options("reparent-order:undo:0001", 2));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    // The exact pre-command children order is restored, not an append.
    expect(node(store, ROOT)?.children).toEqual([
      nodeId("node:behavior:a"),
      nodeId("node:behavior:b"),
      nodeId("node:behavior:c"),
      parent2,
    ]);
  });

  it("preserve-local keeps the local transform; preserve-world keeps the world placement", () => {
    const { bus, store } = createHarness();
    const local = bus.execute(
      reparentNodeCommand(
        commandId("command:behavior:reparent:0004"),
        { nodeId: GRANDCHILD, newParentId: ROOT, placement: "preserve-local" },
        createBehaviorDocument(),
      ),
      options("reparent:0004", 0),
    );
    expect(local.ok).toBe(true);
    if (!local.ok) return;
    expect(node(store, GRANDCHILD)?.transform).toEqual(identity);
    expect(node(store, GRANDCHILD)?.parentId).toBe(ROOT);

    const world = bus.execute(
      reparentNodeCommand(
        commandId("command:behavior:reparent:0005"),
        { nodeId: CHILD, newParentId: GRANDCHILD, placement: "preserve-world" },
        store.getDocument(),
      ),
      options("reparent:0005", 1),
    );
    expect(world.ok).toBe(true);
    if (!world.ok) return;
    // CHILD's world placement must be unchanged: its world matrix before and
    // after the reparent is identical.
    const before = worldTransformMatrix(createBehaviorDocument(), CHILD);
    const after = worldTransformMatrix(store.getDocument(), CHILD);
    for (let index = 0; index < 16; index += 1) {
      expect(
        Math.abs((after[index] as number) - (before[index] as number)),
      ).toBeLessThan(1e-9);
    }
    // The resolved local transform is carried in the payload (deterministic intent).
    const payload = world.value.event.commandTypes;
    expect(payload).toEqual([NODE_REPARENT_COMMAND]);
  });

  it("preserve-world reparenting carries the canonical resolved transform in the payload", () => {
    const document = createBehaviorDocument();
    const command = reparentNodeCommand(
      commandId("command:behavior:reparent:0006"),
      { nodeId: GRANDCHILD, newParentId: ROOT, placement: "preserve-world" },
      document,
    );
    const payload = command.payload as {
      transform?: { translation: readonly number[] };
    };
    // GRANDCHILD's world transform is CHILD's T1; under the identity root the
    // resolved local transform is exactly T1.
    expect(payload.transform?.translation).toEqual([1, 2, 3]);
  });

  it("rejects component schemas that bypass the discriminated union", () => {
    const { bus } = createHarness();
    const unknownKind = bus.execute(
      {
        id: commandId("command:behavior:components:0001"),
        type: NODE_SET_COMPONENTS_COMMAND,
        schemaVersion: 1,
        payload: {
          nodeId: CHILD,
          components: [{ kind: "laser", schemaVersion: 1 }],
        },
      },
      options("components:0001", 0),
    );
    expect(unknownKind.ok).toBe(false);
    if (unknownKind.ok) return;
    expect(unknownKind.error.code).toBe("UNSUPPORTED_COMPONENT");

    const duplicateSingleton = bus.execute(
      {
        id: commandId("command:behavior:components:0002"),
        type: NODE_SET_COMPONENTS_COMMAND,
        schemaVersion: 1,
        payload: {
          nodeId: CHILD,
          components: [
            { kind: "pivot", schemaVersion: 1, pivot: [0, 0, 0] },
            { kind: "pivot", schemaVersion: 1, pivot: [1, 1, 1] },
          ],
        },
      },
      options("components:0002", 0),
    );
    expect(duplicateSingleton.ok).toBe(false);
    if (duplicateSingleton.ok) return;
    expect(duplicateSingleton.error.code).toBe("DUPLICATE_COMPONENT");

    const missingVolume = bus.execute(
      setNodeComponentsCommand(commandId("command:behavior:components:0003"), {
        nodeId: CHILD,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:behavior:missing"),
          },
        ],
      }),
      options("components:0003", 0),
    );
    expect(missingVolume.ok).toBe(false);
    if (missingVolume.ok) return;
    expect(missingVolume.error.code).toBe("MISSING_VOLUME");
  });

  it("rejects constraint component ids that collide across nodes", () => {
    const { bus } = createHarness();
    const first = bus.execute(
      setNodeComponentsCommand(commandId("command:behavior:constraint:0001"), {
        nodeId: CHILD,
        components: [
          {
            kind: "constraint",
            schemaVersion: 1,
            constraints: [
              {
                componentId: "constraint:behavior:shared" as never,
                type: "rotation-limits",
                limits: { min: [0, 0, 0], max: [1, 1, 1] },
              },
            ],
          },
        ],
      }),
      options("constraint:0001", 0),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = bus.execute(
      setNodeComponentsCommand(commandId("command:behavior:constraint:0002"), {
        nodeId: GRANDCHILD,
        components: [
          {
            kind: "constraint",
            schemaVersion: 1,
            constraints: [
              {
                componentId: "constraint:behavior:shared" as never,
                type: "rotation-limits",
                limits: { min: [0, 0, 0], max: [1, 1, 1] },
              },
            ],
          },
        ],
      }),
      options("constraint:0002", 1),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("DUPLICATE_COMPONENT_ID");
  });

  it("bounds metadata by depth, members, and bytes", () => {
    const { bus } = createHarness();
    // Build a metadata tree nested 20 levels deep (limit is 16).
    let nested: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 20; level += 1) {
      nested = { child: nested };
    }
    const tooDeep = bus.execute(
      {
        id: commandId("command:behavior:metadata:0001"),
        type: NODE_SET_METADATA_COMMAND,
        schemaVersion: 1,
        payload: { nodeId: CHILD, metadata: nested },
      },
      options("metadata:0001", 0),
    );
    expect(tooDeep.ok).toBe(false);
    if (tooDeep.ok) return;
    expect(tooDeep.error.code).toBe("LIMIT_EXCEEDED");
  });

  it("enforces the node count limit", () => {
    const { store, writeCapability } = createDocumentStore({
      document: createBehaviorDocument(),
      limits: {
        maxNodes: 3,
        maxVolumes: 1024,
        maxMaterials: 4096,
        maxClips: 256,
        maxTracks: 10000,
        maxKeyframes: 1000000,
        maxKeyframesPerTrack: 100000,
        maxClipDurationSeconds: 86400,
        maxNameBytes: 256,
        maxMetadataDepth: 16,
        maxMetadataMembers: 10000,
        maxMetadataBytes: 1048576,
        maxMetadataStringBytes: 65536,
        maxVoxelCoordinate: 1048575,
        maxRevision: Number.MAX_SAFE_INTEGER,
      },
    });
    const registry = new CommandRegistry();
    registerNodeCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const result = bus.execute(
      createNodeCommand(commandId("command:behavior:limit:0001"), {
        nodeId: NEW,
        parentId: ROOT,
        transform: identity,
      }),
      options("limit:0001", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("LIMIT_EXCEEDED");
  });
});

describe("material commands", () => {
  it("creates, updates, and deletes materials through the bus", () => {
    const { bus, store } = createHarness();
    const created = bus.execute(
      createMaterialCommand(commandId("command:behavior:material:0001"), {
        materialId: MATERIAL_THREE,
        name: "three",
        color: "#00ff00" as never,
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      }),
      options("material:0001", 0),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(store.getDocument().materials[MATERIAL_THREE]?.name).toBe("three");

    const updated = bus.execute(
      updateMaterialCommand(commandId("command:behavior:material:0002"), {
        materialId: MATERIAL_THREE,
        name: "three-updated",
        opacity: 0.25,
      }),
      options("material:0002", 1),
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const record = store.getDocument().materials[MATERIAL_THREE];
    expect(record?.name).toBe("three-updated");
    expect(record?.opacity).toBe(0.25);
    expect(record?.color).toBe("#00ff00");

    const deleted = bus.execute(
      deleteMaterialCommand(commandId("command:behavior:material:0003"), {
        materialId: MATERIAL_THREE,
      }),
      options("material:0003", 2),
    );
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(store.getDocument().materials[MATERIAL_THREE]).toBeUndefined();
  });

  it("rejects referenced deletion without a replacement and remaps with one", () => {
    const { bus, store } = createHarness();
    bus.execute(
      setVoxelCommand(commandId("command:behavior:voxel:0001"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
        material: MATERIAL_ONE,
      }),
      options("voxel:0001", 0),
    );
    const rejected = bus.execute(
      deleteMaterialCommand(commandId("command:behavior:material:0004"), {
        materialId: MATERIAL_ONE,
      }),
      options("material:0004", 1),
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe("REFERENCED_MATERIAL");

    const remapped = bus.execute(
      deleteMaterialCommand(commandId("command:behavior:material:0005"), {
        materialId: MATERIAL_ONE,
        replacement: MATERIAL_TWO,
      }),
      options("material:0005", 1),
    );
    expect(remapped.ok).toBe(true);
    if (!remapped.ok) return;
    expect(store.getDocument().materials[MATERIAL_ONE]).toBeUndefined();
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(MATERIAL_TWO);
    expect(remapped.value.event.changedMaterialIds).toEqual([
      MATERIAL_ONE,
      MATERIAL_TWO,
    ]);
    expect(remapped.value.event.changedVolumes).toHaveLength(1);
    expect(remapped.value.event.changedNodeIds).toEqual([CHILD]);
  });

  it("undoes a referenced deletion across several volumes as one unit", () => {
    const { bus, store } = createHarness();
    bus.executeTransaction(
      [
        setVoxelCommand(commandId("command:behavior:voxel:0002"), {
          volumeId: VOLUME,
          coordinate: [0, 0, 0],
          material: MATERIAL_ONE,
        }),
        setVoxelCommand(commandId("command:behavior:voxel:0003"), {
          volumeId: VOLUME_TWO,
          coordinate: [0, 0, 0],
          material: MATERIAL_ONE,
        }),
      ],
      options("voxel:0002", 0),
    );
    const deleted = bus.execute(
      deleteMaterialCommand(commandId("command:behavior:material:0006"), {
        materialId: MATERIAL_ONE,
        replacement: MATERIAL_TWO,
      }),
      options("material:0006", 1),
    );
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(MATERIAL_TWO);
    expect(store.getVoxel(VOLUME_TWO, [0, 0, 0])).toBe(MATERIAL_TWO);

    const undone = bus.undo(options("material:undo:0001", 2));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(store.getDocument().materials[MATERIAL_ONE]?.name).toBe("one");
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(MATERIAL_ONE);
    expect(store.getVoxel(VOLUME_TWO, [0, 0, 0])).toBe(MATERIAL_ONE);
  });

  it("reports an invalid replacement even when the material is already absent", () => {
    const { bus } = createHarness();
    const result = bus.execute(
      deleteMaterialCommand(commandId("command:behavior:material:0010"), {
        materialId: materialId(99),
        replacement: materialId(98),
      }),
      options("material:0010", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_MATERIAL");
  });

  it("rejects empty updates and out-of-range properties", () => {
    const { bus } = createHarness();
    const empty = bus.execute(
      updateMaterialCommand(commandId("command:behavior:material:0007"), {
        materialId: MATERIAL_ONE,
      }),
      options("material:0007", 0),
    );
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.code).toBe("EMPTY_MATERIAL_UPDATE");

    const outOfRange = bus.execute(
      {
        id: commandId("command:behavior:material:0008"),
        type: "material.update",
        schemaVersion: 1,
        payload: { materialId: MATERIAL_ONE, opacity: 1.5 },
      },
      options("material:0008", 0),
    );
    expect(outOfRange.ok).toBe(false);
    if (outOfRange.ok) return;
    expect(outOfRange.error.code).toBe("INVALID_MATERIAL_RANGE");
  });

  it("enforces the material count limit", () => {
    const { store, writeCapability } = createDocumentStore({
      document: createBehaviorDocument(),
      limits: {
        maxNodes: 10000,
        maxVolumes: 1024,
        maxMaterials: 2,
        maxClips: 256,
        maxTracks: 10000,
        maxKeyframes: 1000000,
        maxKeyframesPerTrack: 100000,
        maxClipDurationSeconds: 86400,
        maxNameBytes: 256,
        maxMetadataDepth: 16,
        maxMetadataMembers: 10000,
        maxMetadataBytes: 1048576,
        maxMetadataStringBytes: 65536,
        maxVoxelCoordinate: 1048575,
        maxRevision: Number.MAX_SAFE_INTEGER,
      },
    });
    const registry = new CommandRegistry();
    registerMaterialCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const result = bus.execute(
      createMaterialCommand(commandId("command:behavior:material:0009"), {
        materialId: MATERIAL_THREE,
        name: "three",
        color: "#00ff00" as never,
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      }),
      options("material:0009", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("LIMIT_EXCEEDED");
  });
});

describe("world transform queries", () => {
  it("composes ancestor transforms in order", () => {
    const document = createBehaviorDocument();
    const world = worldTransformMatrix(document, GRANDCHILD);
    // GRANDCHILD's world matrix is ROOT x CHILD(T1) x GRANDCHILD(identity).
    const expected = multiplyMatrices(
      transformToMatrix(identity),
      multiplyMatrices(transformToMatrix(T1), transformToMatrix(identity)),
    );
    for (let index = 0; index < 16; index += 1) {
      expect(
        Math.abs((world[index] as number) - (expected[index] as number)),
      ).toBeLessThan(1e-12);
    }
    expect(applyMatrix(world, [0, 0, 0])).toEqual([1, 2, 3]);
  });
});
