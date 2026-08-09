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
  canonicalColor,
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
  createMaterialCommand,
  createNodeCommand,
  deleteMaterialCommand,
  registerMaterialCommands,
  registerArticulationCommands,
  registerNodeCommands,
  registerVoxelCommands,
  renameNodeCommand,
  reparentNodeCommand,
  setVoxelCommand,
  updateMaterialCommand,
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
  registerNodeCommands(registry);
  registerArticulationCommands(registry);
  registerMaterialCommands(registry);
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

  // Hierarchy and material edits ride the same atomic history path as voxels.
  const childId = nodeId("node:demo:child");
  const extraId = nodeId("node:demo:extra");
  const createNodeResult = bus.execute(
    createNodeCommand(commandId("command:demo:create-node:0001"), {
      nodeId: extraId,
      parentId: nodeId("node:demo:root"),
      name: "Extra",
      transform: identity,
    }),
    {
      transactionId: transactionId("transaction:demo:create-node:0001"),
      expectedRevision: 3,
      source: "ui",
    },
  );
  if (!createNodeResult.ok) {
    throw new Error(`demo create node failed: ${createNodeResult.error.code}`);
  }
  const reparentResult = bus.execute(
    reparentNodeCommand(
      commandId("command:demo:reparent:0001"),
      { nodeId: extraId, newParentId: childId, placement: "preserve-world" },
      store.getDocument(),
    ),
    {
      transactionId: transactionId("transaction:demo:reparent:0001"),
      expectedRevision: 4,
      source: "ui",
    },
  );
  const createMaterialResult = bus.execute(
    createMaterialCommand(commandId("command:demo:create-material:0001"), {
      materialId: materialId(2),
      name: "accent",
      color: canonicalColor("#00ff88"),
      opacity: 1,
      roughness: 0.3,
      metallic: 0.4,
      emissive: 0,
    }),
    {
      transactionId: transactionId("transaction:demo:create-material:0001"),
      expectedRevision: 5,
      source: "ui",
    },
  );
  const updateMaterialResult = bus.execute(
    updateMaterialCommand(commandId("command:demo:update-material:0001"), {
      materialId: materialId(2),
      name: "accent-bright",
      emissive: 0.2,
    }),
    {
      transactionId: transactionId("transaction:demo:update-material:0001"),
      expectedRevision: 6,
      source: "ui",
    },
  );
  const deleteMaterialResult = bus.execute(
    deleteMaterialCommand(commandId("command:demo:delete-material:0001"), {
      materialId: materialId(2),
    }),
    {
      transactionId: transactionId("transaction:demo:delete-material:0001"),
      expectedRevision: 7,
      source: "ui",
    },
  );
  const renameResult = bus.execute(
    renameNodeCommand(commandId("command:demo:rename:0001"), {
      nodeId: extraId,
      name: "Extra-renamed",
    }),
    {
      transactionId: transactionId("transaction:demo:rename:0001"),
      expectedRevision: 8,
      source: "ui",
    },
  );

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
    hierarchy: {
      createNodeAccepted: createNodeResult.ok,
      reparentAccepted: reparentResult.ok,
      renameAccepted: renameResult.ok,
      extraParent: committed.nodes[extraId]?.parentId ?? null,
      extraName: committed.nodes[extraId]?.name ?? null,
      childChildren: committed.nodes[childId]?.children ?? [],
    },
    materials: {
      createAccepted: createMaterialResult.ok,
      updateAccepted: updateMaterialResult.ok,
      deleteAccepted: deleteMaterialResult.ok,
      materialCount: Object.keys(committed.materials).length,
    },
  });
}
