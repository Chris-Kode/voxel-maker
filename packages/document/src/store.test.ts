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
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  createDocumentStore,
  type DocumentCommitted,
  type StagedState,
} from "./store.js";

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
  return { document, volumes };
}

describe("createDocumentStore", () => {
  it("exposes the document, revision, and limits", () => {
    const { store } = createDocumentStore({ document: createDemoDocument() });
    expect(store.revision).toBe(0);
    expect(store.getDocument().documentId).toBe("document:store:0001");
    expect(store.limits.maxVoxelCoordinate).toBe(1_048_575);
  });

  it("reads empty voxels and missing volumes as empty", () => {
    const { store } = createDocumentStore({ document: createDemoDocument() });
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(0);
    expect(store.getVoxel(volumeId("volume:missing:0001"), [0, 0, 0])).toBe(0);
    expect(store.getVolume(VOLUME)?.chunkCount()).toBe(0);
    expect(store.getVolume(volumeId("volume:missing:0001"))).toBeUndefined();
  });

  it("stages copy-on-write clones that never affect committed state", () => {
    const { store, writeCapability } = createDocumentStore({
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
    const { store, writeCapability } = createDocumentStore({
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
    const { store } = createDocumentStore({ document: createDemoDocument() });
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
    const { store, writeCapability } = createDocumentStore({
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
    const { store, writeCapability } = createDocumentStore({
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
    const { store, writeCapability } = createDocumentStore({
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
    const { store, writeCapability } = createDocumentStore({
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
    const { store, writeCapability } = createDocumentStore({
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

  it("isolates subscriber exceptions", () => {
    const { store, writeCapability } = createDocumentStore({
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
    const { store, writeCapability } = createDocumentStore({
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
    const { store } = createDocumentStore({ document: createDemoDocument() });
    // Compile-time guard: these lines must never type-check. They live in a
    // never-called function so the runtime never executes them.
    const guard = (): void => {
      const view = store.getVolume(VOLUME);
      // @ts-expect-error direct mutation must not be available on the public read view
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      view?.setVoxel([0, 0, 0], 1, undefined);
      store.commit(
        stagedState({ ...store.getDocument(), revision: 1 }, new Map()),
        makeEvent(0, 1),
        // @ts-expect-error commit requires the private write capability
        undefined,
      );
    };
    void guard;
  });

  it("returns a deeply frozen document that cannot be mutated", () => {
    const { store } = createDocumentStore({ document: createDemoDocument() });
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
    const { store, writeCapability } = createDocumentStore({
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
