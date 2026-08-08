import {
  canonicalJson,
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import {
  canonicalDocumentHash,
  canonicalDocumentJson,
  createDocument,
  parseDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { chunkCoordinate, localCoordinate } from "@voxel-maker/voxel";
import { createDocumentStore } from "@voxel-maker/document";
import {
  CommandBus,
  CommandRegistry,
  registerVoxelCommands,
  setVoxelCommand,
} from "@voxel-maker/commands";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function createDemoDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:demo:0001"),
    metadata: { title: "headless demo", tags: ["edit"] },
    rootNodeId: nodeId("node:demo:root"),
    nodes: [
      {
        nodeId: nodeId("node:demo:root"),
        name: "Root",
        parentId: null,
        children: [nodeId("node:demo:child")],
        transform: identity,
        components: [],
      },
      {
        nodeId: nodeId("node:demo:child"),
        name: "Child",
        parentId: nodeId("node:demo:root"),
        children: [],
        transform: {
          translation: [1, -1, 2],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:demo:0001"),
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
        volumeId: volumeId("volume:demo:0001"),
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    ],
  });
}

const DEMO_VOLUME = volumeId("volume:demo:0001");
const DEMO_COORDINATE = [-1, 0, 1] as const;

/**
 * Headless edit demo: create a document, set one voxel through the command
 * bus, undo it, redo it, then serialize, hash, reload, and compare.
 */
export function runHeadlessTrace(): string {
  const document = createDemoDocument();
  const { store, writeCapability } = createDocumentStore({ document });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);

  const setResult = bus.execute(
    setVoxelCommand(commandId("command:demo:set:0001"), {
      volumeId: DEMO_VOLUME,
      coordinate: DEMO_COORDINATE,
      material: materialId(1),
    }),
    {
      transactionId: transactionId("transaction:demo:set:0001"),
      expectedRevision: 0,
      source: "ui",
    },
  );
  const afterSet = store.getVoxel(DEMO_VOLUME, DEMO_COORDINATE);

  const undoResult = bus.undo({
    transactionId: transactionId("transaction:demo:undo:0001"),
    expectedRevision: 1,
    source: "ui",
  });
  const afterUndo = store.getVoxel(DEMO_VOLUME, DEMO_COORDINATE);

  const redoResult = bus.redo({
    transactionId: transactionId("transaction:demo:redo:0001"),
    expectedRevision: 2,
    source: "ui",
  });
  const afterRedo = store.getVoxel(DEMO_VOLUME, DEMO_COORDINATE);

  const committed = store.getDocument();
  const serialized = canonicalDocumentJson(committed);
  const hash = canonicalDocumentHash(committed);
  const reloaded = parseDocument(serialized);

  return canonicalJson({
    command: {
      accepted: setResult.ok,
      transactionId: "transaction:demo:set:0001",
      revisionAfter: setResult.ok ? setResult.value.revisionAfter : -1,
    },
    document: {
      documentId: document.documentId,
      hash,
      nodeCount: Object.keys(document.nodes).length,
      reloadedHash: canonicalDocumentHash(reloaded),
      roundTripStable: hash === canonicalDocumentHash(reloaded),
    },
    serialized,
    voxel: {
      chunk: chunkCoordinate(DEMO_COORDINATE),
      local: localCoordinate(DEMO_COORDINATE),
      material: afterRedo,
    },
    edit: {
      afterSet,
      afterUndo,
      afterRedo,
      revisions: [
        setResult.ok ? setResult.value.revisionAfter : -1,
        undoResult.ok ? undoResult.value.revisionAfter : -1,
        redoResult.ok ? redoResult.value.revisionAfter : -1,
      ],
    },
  });
}
