import {
  canonicalJson,
  documentId,
  materialId,
  nodeId,
  volumeId,
} from "@voxel-maker/shared";
import {
  canonicalDocumentHash,
  canonicalDocumentJson,
  createDocument,
  parseDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { traceVoxel } from "@voxel-maker/voxel";
import { traceCommand } from "@voxel-maker/commands";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function createDemoDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:demo:0001"),
    metadata: { title: "headless demo", tags: ["trace"] },
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

/** Headless round-trip demo: create, serialize, hash, reload, and compare. */
export function runHeadlessTrace(): string {
  const document = createDemoDocument();
  const serialized = canonicalDocumentJson(document);
  const hash = canonicalDocumentHash(document);
  const reloaded = parseDocument(serialized);
  const voxel = traceVoxel([-1, 0, 1], 1);
  const command = traceCommand(document, voxel);
  return canonicalJson({
    command: {
      accepted: command.accepted,
      commandId: command.commandId,
      revision: command.revision,
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
      chunk: voxel.chunk,
      local: voxel.local,
      material: voxel.material,
    },
  });
}
