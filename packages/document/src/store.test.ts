import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  WorkspaceError,
  type JsonValue,
} from "@voxel-maker/shared";
import {
  DEFAULT_DOCUMENT_LIMITS,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { createDocumentStore, type DocumentCommitted } from "./index.js";
import { createDocumentStoreHandle, type StagedState } from "./internal.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function createDemoDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:store:0001"),
    metadata: { title: "store test", tags: [] },
    rootNodeId: nodeId("node:store:root"),
    nodes: [
      {
        nodeId: nodeId("node:store:root"),
        name: "Root",
        parentId: null,
        children: [],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:store:0001"),
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
        volumeId: volumeId("volume:store:0001"),
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    ],
  });
}

const VOLUME = volumeId("volume:store:0001");

/** Document with two volumes for document-wide aggregate tests (issue #92). */
function createTwoVolumeDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:store:two:0001"),
    metadata: { title: "store two-volume", tags: [] },
    rootNodeId: nodeId("node:store:two:root"),
    nodes: [
      {
        nodeId: nodeId("node:store:two:root"),
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
        volumeId: volumeId("volume:store:two:a"),
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      },
      {
        volumeId: volumeId("volume:store:two:b"),
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    ],
    animations: [],
  });
}

function makeEvent(
  revisionBefore: number,
  revisionAfter: number,
): DocumentCommitted {
  return {
    revisionBefore,
    revisionAfter,
    transactionId: transactionId("transaction:store:0001"),
    source: "ui",
    commandIds: [commandId("command:store:0001")],
    commandTypes: ["voxel.set"],
    changedNodeIds: [],
    changedMaterialIds: [],
    changedAnimationIds: [],
    changedVolumes: [
      {
        volumeId: VOLUME,
        chunks: [{ coordinate: [0, 0, 0], revision: 1 }],
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    ],
  };
}

function stagedState(
  document: VoxelDocument,
  volumes: StagedState["volumes"],
): StagedState {
  return { document, volumes, removedVolumes: [] };
}

describe("createDocumentStore", () => {
  it("exposes the document, revision, and limits", () => {
    const store = createDocumentStore({ document: createDemoDocument() });
    expect(store.revision).toBe(0);
    expect(store.getDocument().documentId).toBe("document:store:0001");
    expect(store.limits.maxVoxelCoordinate).toBe(1_048_575);
  });

  it("reads empty voxels and missing volumes as empty", () => {
    const store = createDocumentStore({ document: createDemoDocument() });
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(0);
    expect(store.getVoxel(volumeId("volume:missing:0001"), [0, 0, 0])).toBe(0);
    expect(store.getVolume(VOLUME)?.chunkCount()).toBe(0);
    expect(store.getVolume(volumeId("volume:missing:0001"))).toBeUndefined();
  });

  it("stages copy-on-write clones that never affect committed state", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    const staged = store.stageVolume(VOLUME);
    expect(staged).toBeDefined();
    staged?.setVoxel([0, 0, 0], 1, writeCapability);
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(0);
    expect(store.getVolume(VOLUME)?.chunkCount()).toBe(0);
  });
});

describe("DocumentStore.commit", () => {
  it("installs staged state, increments revision once, and emits one frozen event", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    const events: DocumentCommitted[] = [];
    store.subscribe((event) => {
      events.push(event);
    });

    const staged = store.stageVolume(VOLUME);
    staged?.setVoxel([-1, 0, 1], 1, writeCapability);
    const nextDocument = {
      ...store.getDocument(),
      revision: store.revision + 1,
    };
    const event = makeEvent(0, 1);
    store.commit(
      stagedState(nextDocument, new Map([[VOLUME, staged as never]])),
      event,
      writeCapability,
    );

    expect(store.revision).toBe(1);
    expect(store.getDocument().revision).toBe(1);
    expect(store.getVoxel(VOLUME, [-1, 0, 1])).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe(event);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(events[0]?.changedVolumes)).toBe(true);
    expect(Object.isFrozen(events[0]?.changedVolumes[0]?.chunks)).toBe(true);
  });

  it("rejects commits without the store write capability", () => {
    const { store } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    const event = makeEvent(0, 1);
    expect(() => {
      store.commit(
        stagedState({ ...store.getDocument(), revision: 1 }, new Map()),
        event,
        { __kind: "VoxelWriteCapability" },
      );
    }).toThrow(/capability/u);
    expect(store.revision).toBe(0);
  });

  it("rejects a staged document from another document", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    const other = createDemoDocument();
    const foreign = {
      ...other,
      documentId: documentId("document:other:0001"),
      revision: 1,
    };
    expect(() => {
      store.commit(
        stagedState(foreign, new Map()),
        makeEvent(0, 1),
        writeCapability,
      );
    }).toThrow(/document/u);
    expect(store.revision).toBe(0);
  });

  it("rejects a staged revision that is not exactly current + 1", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    expect(() => {
      store.commit(
        stagedState({ ...store.getDocument(), revision: 2 }, new Map()),
        makeEvent(0, 2),
        writeCapability,
      );
    }).toThrow(/revision/u);
    expect(store.revision).toBe(0);
  });

  it("rejects an event whose revisions do not match the staged document", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    expect(() => {
      store.commit(
        stagedState({ ...store.getDocument(), revision: 1 }, new Map()),
        makeEvent(0, 2),
        writeCapability,
      );
    }).toThrow(/revision/u);
    expect(store.revision).toBe(0);
  });

  it("rejects staged volumes that are not in the document", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    const staged = store.stageVolume(VOLUME);
    expect(() => {
      store.commit(
        stagedState(
          { ...store.getDocument(), revision: 1 },
          new Map([[volumeId("volume:foreign:0001"), staged as never]]),
        ),
        makeEvent(0, 1),
        writeCapability,
      );
    }).toThrow(/volume/u);
    expect(store.revision).toBe(0);
  });

  it("rejects a structurally invalid staged document", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    const invalid = {
      ...store.getDocument(),
      revision: 1,
      metadata: 42,
    } as unknown as VoxelDocument;
    expect(() => {
      store.commit(
        stagedState(invalid, new Map()),
        makeEvent(0, 1),
        writeCapability,
      );
    }).toThrow(WorkspaceError);
    expect(store.revision).toBe(0);
  });

  it("rejects staged voxel references to undeclared materials (issue #86)", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    const staged = store.stageVolume(VOLUME);
    staged?.setVoxel([0, 0, 0], 2, writeCapability);
    expect(() => {
      store.commit(
        stagedState(
          { ...store.getDocument(), revision: 1 },
          new Map([[VOLUME, staged as never]]),
        ),
        makeEvent(0, 1),
        writeCapability,
      );
    }).toThrow(/Material is not defined/u);
    expect(store.revision).toBe(0);
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(0);
  });

  it("accepts staged voxel references to declared materials (issue #86)", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    const staged = store.stageVolume(VOLUME);
    staged?.setVoxel([0, 0, 0], 1, writeCapability);
    const event = makeEvent(0, 1);
    store.commit(
      stagedState(
        { ...store.getDocument(), revision: 1 },
        new Map([[VOLUME, staged as never]]),
      ),
      event,
      writeCapability,
    );
    expect(store.revision).toBe(1);
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(1);
  });

  it("isolates subscriber exceptions", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    const seen: DocumentCommitted[] = [];
    store.subscribe(() => {
      throw new Error("subscriber boom");
    });
    store.subscribe((event) => {
      seen.push(event);
    });
    store.commit(
      stagedState({ ...store.getDocument(), revision: 1 }, new Map()),
      makeEvent(0, 1),
      writeCapability,
    );
    expect(seen).toHaveLength(1);
  });

  it("unsubscribes listeners", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    const seen: DocumentCommitted[] = [];
    const unsubscribe = store.subscribe((event) => {
      seen.push(event);
    });
    unsubscribe();
    store.commit(
      stagedState({ ...store.getDocument(), revision: 1 }, new Map()),
      makeEvent(0, 1),
      writeCapability,
    );
    expect(seen).toHaveLength(0);
  });
});

describe("public consumer surface", () => {
  it("does not expose direct mutation through the read view", () => {
    const store = createDocumentStore({ document: createDemoDocument() });
    // Compile-time guard: these lines must never type-check. They live in a
    // never-called function so the runtime never executes them.
    const guard = (): void => {
      const view = store.getVolume(VOLUME);
      // @ts-expect-error direct mutation must not be available on the public read view
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      view?.setVoxel([0, 0, 0], 1, undefined);
      // @ts-expect-error the public read surface has no commit (issue #91)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      store.commit(
        stagedState({ ...store.getDocument(), revision: 1 }, new Map()),
        makeEvent(0, 1),
        undefined,
      );
    };
    void guard;
  });

  it("returns a deeply frozen document that cannot be mutated", () => {
    const store = createDocumentStore({ document: createDemoDocument() });
    const document = store.getDocument();
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.nodes)).toBe(true);
    expect(
      Object.isFrozen(document.nodes[nodeId("node:store:root")]?.components),
    ).toBe(true);
    expect(Object.isFrozen(document.materials)).toBe(true);
    expect(() => {
      // Strict-mode assignment to a frozen object must throw.
      (document as { revision: number }).revision = 99;
    }).toThrow(TypeError);
    expect(store.revision).toBe(0);
  });

  it("serializes the committed event canonically", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createDemoDocument(),
    });
    const staged = store.stageVolume(VOLUME);
    staged?.setVoxel([0, 0, 0], 1, writeCapability);
    const event = makeEvent(0, 1);
    store.commit(
      stagedState(
        { ...store.getDocument(), revision: 1 },
        new Map([[VOLUME, staged as never]]),
      ),
      event,
      writeCapability,
    );
    expect(canonicalJson(event as unknown as JsonValue)).toContain(
      '"transactionId":"transaction:store:0001"',
    );
  });
});

/** Asserts that `fn` throws a WorkspaceError with the exact stable code. */
function expectErrorCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`Expected WorkspaceError ${code}, but nothing was thrown`);
  }
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    (thrown as { code: unknown }).code === code
  ) {
    return;
  }
  throw new Error(
    `Expected WorkspaceError ${code}, got ${
      thrown instanceof Error ? thrown.name : typeof thrown
    }`,
  );
}

describe("createDocumentStore volume seeding", () => {
  /** Document declaring materials 1..3 so seeding tests can use each. */
  const seededDocument = (): VoxelDocument =>
    createDocument({
      documentId: documentId("document:store:0001"),
      metadata: { title: "store test", tags: [] },
      rootNodeId: nodeId("node:store:root"),
      nodes: [
        {
          nodeId: nodeId("node:store:root"),
          name: "Root",
          parentId: null,
          children: [],
          transform: identity,
          components: [
            {
              kind: "voxel",
              schemaVersion: 1,
              volumeId: volumeId("volume:store:0001"),
            },
          ],
        },
      ],
      materials: [
        {
          materialId: materialId(1),
          name: "one",
          color: "#ff0000",
          opacity: 1,
          roughness: 0.5,
          metallic: 0,
          emissive: 0,
        },
        {
          materialId: materialId(2),
          name: "two",
          color: "#00ff00",
          opacity: 1,
          roughness: 0.5,
          metallic: 0,
          emissive: 0,
        },
        {
          materialId: materialId(3),
          name: "three",
          color: "#0000ff",
          opacity: 1,
          roughness: 0.5,
          metallic: 0,
          emissive: 0,
        },
      ],
      volumes: [
        {
          volumeId: volumeId("volume:store:0001"),
          bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        },
      ],
    });

  const seeds = (): ReadonlyMap<
    string,
    readonly {
      coordinate: readonly [number, number, number];
      values: Uint16Array;
    }[]
  > =>
    new Map([
      [
        "volume:store:0001",
        [
          {
            coordinate: [-1, 0, 0],
            values: (() => {
              const values = new Uint16Array(4096);
              values[0] = 2;
              values[15 + 16 * (0 + 16 * 1)] = 3;
              return values;
            })(),
          },
        ],
      ],
    ]);

  it("installs seeded chunks through the validated load path", () => {
    const store = createDocumentStore({
      document: seededDocument(),
      volumes: seeds() as never,
    });
    const volume = store.getVolume(VOLUME);
    expect(volume).toBeDefined();
    expect(volume?.getVoxel([-16, 0, 0])).toBe(2);
    expect(volume?.getVoxel([-1, 0, 1])).toBe(3);
    expect(volume?.getVoxel([0, 0, 0])).toBe(0);
    expect(volume?.occupiedCount()).toBe(2);
  });

  it("rejects seeded chunks that reference undeclared materials", () => {
    expectErrorCode(
      () =>
        createDocumentStore({
          document: createDemoDocument(),
          volumes: seeds() as never,
        }),
      "MISSING_MATERIAL",
    );
  });

  it("loads zero and declared material values unchanged", () => {
    const values = new Uint16Array(4096);
    values[0] = 1;
    values[17] = 0;
    const store = createDocumentStore({
      document: seededDocument(),
      volumes: new Map([
        ["volume:store:0001", [{ coordinate: [-1, 0, 0], values }]],
      ]) as never,
    });
    expect(store.getVoxel(VOLUME, [-16, 0, 0])).toBe(1);
    expect(store.getVoxel(VOLUME, [-15, 0, 0])).toBe(0);
  });

  it("rejects seeds for volumes missing from the document", () => {
    expectErrorCode(
      () =>
        createDocumentStore({
          document: createDemoDocument(),
          volumes: new Map([["volume:store:9999", []]]) as never,
        }),
      "MISSING_VOLUME",
    );
  });

  it("rejects malformed seeds before any install", () => {
    expectErrorCode(
      () =>
        createDocumentStore({
          document: createDemoDocument(),
          volumes: new Map([
            [
              "volume:store:0001",
              [{ coordinate: [0, 0, 0], values: new Uint16Array(3) }],
            ],
          ]) as never,
        }),
      "INVALID_CHUNK_LENGTH",
    );
  });
});

describe("document-wide voxel totals (ADR-0009, issue #92)", () => {
  const VOLUME_A = volumeId("volume:store:two:a");
  const VOLUME_B = volumeId("volume:store:two:b");

  function catchCommit(fn: () => void): unknown {
    try {
      fn();
    } catch (error) {
      return error;
    }
    throw new Error("expected commit to throw");
  }

  function commitBox(
    store: ReturnType<typeof createDocumentStoreHandle>["store"],
    writeCapability: ReturnType<
      typeof createDocumentStoreHandle
    >["writeCapability"],
    volume: ReturnType<typeof volumeId>,
    size: readonly [number, number, number],
    event: DocumentCommitted,
  ): void {
    const staged = store.stageVolume(volume);
    if (staged === undefined) throw new Error("missing volume");
    staged.fillBox(
      { min: [0, 0, 0], max: [size[0], size[1], size[2]] },
      1,
      writeCapability,
    );
    const nextDocument = {
      ...store.getDocument(),
      revision: store.revision + 1,
    };
    store.commit(
      {
        document: nextDocument,
        volumes: new Map([[volume, staged]]),
        removedVolumes: [],
      },
      event,
      writeCapability,
    );
  }

  it("rejects a commit whose aggregate occupied voxels exceed the document limit", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createTwoVolumeDocument(),
      limits: { ...DEFAULT_DOCUMENT_LIMITS, maxOccupiedVoxels: 100 },
    });
    commitBox(store, writeCapability, VOLUME_A, [60, 1, 1], makeEvent(0, 1));
    expect(store.revision).toBe(1);
    const error = catchCommit(() => {
      commitBox(store, writeCapability, VOLUME_B, [60, 1, 1], makeEvent(1, 2));
    });
    expect(error).toBeInstanceOf(WorkspaceError);
    if (!(error instanceof WorkspaceError)) return;
    expect(error.family).toBe("limit");
    expect(error.code).toBe("TOO_MANY_OCCUPIED_VOXELS");
    expect(error.message).toBe("Document exceeds its occupied-voxel limit");
    expect(error.context).toEqual({
      requested: 120,
      limit: 100,
      resource: "occupiedVoxels",
    });
    // Atomic rejection: revision and committed voxel state are unchanged.
    expect(store.revision).toBe(1);
    expect(store.getVolume(VOLUME_B)?.occupiedCount()).toBe(0);
    expect(store.getVolume(VOLUME_A)?.occupiedCount()).toBe(60);
  });

  it("rejects a commit whose aggregate non-empty chunks exceed the document limit", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createTwoVolumeDocument(),
      limits: { ...DEFAULT_DOCUMENT_LIMITS, maxChunks: 3 },
    });
    // Each box spans two chunks (x = 0..17 covers chunk 0 and chunk 1).
    commitBox(store, writeCapability, VOLUME_A, [18, 1, 1], makeEvent(0, 1));
    expect(store.getVolume(VOLUME_A)?.chunkCount()).toBe(2);
    const error = catchCommit(() => {
      commitBox(store, writeCapability, VOLUME_B, [18, 1, 1], makeEvent(1, 2));
    });
    expect(error).toBeInstanceOf(WorkspaceError);
    if (!(error instanceof WorkspaceError)) return;
    expect(error.family).toBe("limit");
    expect(error.code).toBe("TOO_MANY_CHUNKS");
    expect(error.message).toBe("Document exceeds its non-empty chunk limit");
    expect(error.context).toEqual({
      requested: 4,
      limit: 3,
      resource: "chunks",
    });
    expect(store.revision).toBe(1);
    expect(store.getVolume(VOLUME_B)?.chunkCount()).toBe(0);
  });

  it("allows document-wide totals at exactly the limit", () => {
    const { store, writeCapability } = createDocumentStoreHandle({
      document: createTwoVolumeDocument(),
      limits: { ...DEFAULT_DOCUMENT_LIMITS, maxOccupiedVoxels: 100 },
    });
    commitBox(store, writeCapability, VOLUME_A, [50, 1, 1], makeEvent(0, 1));
    commitBox(store, writeCapability, VOLUME_B, [50, 1, 1], makeEvent(1, 2));
    expect(store.revision).toBe(2);
    expect(store.getVolume(VOLUME_A)?.occupiedCount()).toBe(50);
    expect(store.getVolume(VOLUME_B)?.occupiedCount()).toBe(50);
  });
});
