import { describe, expect, it } from "vitest";
import {
  commandId,
  materialId,
  transactionId,
  volumeId,
  WorkspaceError,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { createDocumentStore } from "@voxel-maker/document";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import {
  registerVoxelCommands,
  removeVoxelCommand,
  setVoxelCommand,
  VOXEL_REMOVE_COMMAND,
  VOXEL_SET_COMMAND,
} from "./voxel-commands.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function createDemoDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:voxel:0001" as never,
    metadata: { title: "voxel commands", tags: [] },
    rootNodeId: "node:voxel:root" as never,
    nodes: [
      {
        nodeId: "node:voxel:root" as never,
        name: "Root",
        parentId: null,
        children: [],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:voxel:0001"),
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
        volumeId: volumeId("volume:voxel:0001"),
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    ],
  });
}

const VOLUME = volumeId("volume:voxel:0001");

function createBus(): {
  bus: CommandBus;
  store: ReturnType<typeof createDocumentStore>["store"];
} {
  const { store, writeCapability } = createDocumentStore({
    document: createDemoDocument(),
  });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  return { bus: new CommandBus(store, registry, writeCapability), store };
}

const setOptions = {
  transactionId: transactionId("transaction:voxel:set:0001"),
  expectedRevision: 0,
  source: "ui" as const,
};

describe("voxel command constructors", () => {
  it("canonicalizes payloads", () => {
    const command = setVoxelCommand(commandId("command:voxel:set:0001"), {
      volumeId: VOLUME,
      coordinate: [-1, 0, 1],
      material: materialId(1),
    });
    expect(command.type).toBe(VOXEL_SET_COMMAND);
    expect(command.schemaVersion).toBe(1);
    expect(command.payload).toEqual({
      volumeId: VOLUME,
      coordinate: [-1, 0, 1],
      material: materialId(1),
    });
  });

  it("rejects invalid materials and coordinates at construction", () => {
    expect(() =>
      setVoxelCommand(commandId("command:voxel:set:0002"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
        material: 0 as never,
      }),
    ).toThrow(/1 through 65535/u);
    expect(() =>
      setVoxelCommand(commandId("command:voxel:set:0003"), {
        volumeId: VOLUME,
        coordinate: [0.5, 0, 0],
        material: materialId(1),
      }),
    ).toThrow(WorkspaceError);
  });
});

describe("voxel.set", () => {
  it("sets a voxel through the bus and emits one commit", () => {
    const { bus, store } = createBus();
    const result = bus.execute(
      setVoxelCommand(commandId("command:voxel:set:0010"), {
        volumeId: VOLUME,
        coordinate: [-1, 0, 1],
        material: materialId(1),
      }),
      setOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revisionBefore).toBe(0);
    expect(result.value.revisionAfter).toBe(1);
    expect(store.revision).toBe(1);
    expect(store.getVoxel(VOLUME, [-1, 0, 1])).toBe(1);
    expect(result.value.event.commandTypes).toEqual([VOXEL_SET_COMMAND]);
    expect(result.value.event.changedVolumes).toEqual([
      {
        volumeId: VOLUME,
        chunks: [{ coordinate: [-1, 0, 0], revision: 1 }],
        bounds: { min: [-16, 0, 0], max: [0, 16, 16] },
      },
    ]);
  });

  it("rejects a set on a missing volume without committing", () => {
    const { bus, store } = createBus();
    const result = bus.execute(
      setVoxelCommand(commandId("command:voxel:set:0011"), {
        volumeId: volumeId("volume:missing:0001"),
        coordinate: [0, 0, 0],
        material: materialId(1),
      }),
      setOptions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_VOLUME");
    expect(store.revision).toBe(0);
  });

  it("rejects a set with a material missing from the document", () => {
    const { bus, store } = createBus();
    const result = bus.execute(
      setVoxelCommand(commandId("command:voxel:set:0012"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
        material: materialId(2),
      }),
      setOptions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_MATERIAL");
    expect(store.revision).toBe(0);
  });

  it("rejects malformed payloads at parse time", () => {
    const { bus, store } = createBus();
    const base = {
      volumeId: VOLUME,
      coordinate: [0, 0, 0],
      material: materialId(1),
    };
    const cases: unknown[] = [
      { ...base, coordinate: [1_048_576, 0, 0] },
      { ...base, coordinate: [0.5, 0, 0] },
      { ...base, coordinate: "0,0,0" },
      { ...base, material: 0 },
      { ...base, material: 65_536 },
      { ...base, volumeId: 42 },
      null,
    ];
    for (const payload of cases) {
      const result = bus.execute(
        {
          id: commandId("command:voxel:set:0013"),
          type: VOXEL_SET_COMMAND,
          schemaVersion: 1,
          payload,
        },
        setOptions,
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.family).toBe("validation");
    }
    expect(store.revision).toBe(0);
  });
});

describe("voxel.remove", () => {
  it("removes a voxel and reclaims the chunk", () => {
    const { bus, store } = createBus();
    bus.execute(
      setVoxelCommand(commandId("command:voxel:set:0020"), {
        volumeId: VOLUME,
        coordinate: [-1, 0, 1],
        material: materialId(1),
      }),
      setOptions,
    );
    const result = bus.execute(
      removeVoxelCommand(commandId("command:voxel:remove:0020"), {
        volumeId: VOLUME,
        coordinate: [-1, 0, 1],
      }),
      {
        transactionId: transactionId("transaction:voxel:remove:0020"),
        expectedRevision: 1,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.getVoxel(VOLUME, [-1, 0, 1])).toBe(0);
    expect(store.getVolume(VOLUME)?.chunkCount()).toBe(0);
    expect(result.value.event.commandTypes).toEqual([VOXEL_REMOVE_COMMAND]);
  });

  it("commits a no-op when removing an empty voxel", () => {
    const { bus, store } = createBus();
    const result = bus.execute(
      removeVoxelCommand(commandId("command:voxel:remove:0021"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
      }),
      setOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revisionAfter).toBe(1);
    expect(result.value.event.changedVolumes).toEqual([]);
    expect(store.revision).toBe(1);
  });
});
