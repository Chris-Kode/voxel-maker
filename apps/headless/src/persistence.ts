import {
  animationId,
  canonicalJson,
  commandId,
  documentId,
  keyframeId,
  materialId,
  nodeId,
  trackId,
  transactionId,
  volumeId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import {
  canonicalColor,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import {
  canonicalAssetSemanticHash,
  createDocumentStore,
} from "@voxel-maker/document";
import {
  CommandBus,
  CommandRegistry,
  createMaterialCommand,
  createNodeCommand,
  fillBoxCommand,
  fillSphereCommand,
  registerBatchCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
  renameNodeCommand,
  updateMaterialCommand,
  type Command,
} from "@voxel-maker/commands";
import { readVxlProject, writeVxlProject } from "@voxel-maker/formats";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const BODY_VOLUME = volumeId("volume:demo:persist:body");
const ARM_VOLUME = volumeId("volume:demo:persist:arm");
const ROOT = nodeId("node:demo:persist:root");
const CHILD = nodeId("node:demo:persist:child");
const ARM = nodeId("node:demo:persist:arm");
const EXTRA = nodeId("node:demo:persist:extra");

/**
 * Headless create-save-reload demo (M1, ticket #11): build a multi-node
 * asset through commands, save a deterministic `.vxl` container, reload it,
 * verify the canonical semantic hash, and reinstall the asset into a fresh
 * store through validated lifecycle replacement.
 */
export function runPersistenceTrace(): string {
  const document = createPersistenceDocument();
  const { store, writeCapability } = createDocumentStore({ document });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  registerRegionCommands(registry);
  registerNodeCommands(registry);
  registerMaterialCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);

  let revision = 0;
  let serial = 0;
  const transactions: Array<{
    label: string;
    accepted: boolean;
    revision: number;
  }> = [];
  const execute = (label: string, command: Command): void => {
    const result = bus.execute(command, {
      transactionId: transactionId(
        `transaction:demo:persist:${String(serial).padStart(4, "0")}`,
      ),
      expectedRevision: revision,
      source: "ui",
    });
    serial += 1;
    transactions.push({
      label,
      accepted: result.ok,
      revision: result.ok ? result.value.revisionAfter : -1,
    });
    revision = result.ok ? result.value.revisionAfter : revision;
  };

  // Voxel content: a box body and a negative-coordinate sphere arm.
  execute(
    "fillBox body",
    fillBoxCommand(commandId("command:demo:persist:fill-body"), {
      volumeId: BODY_VOLUME,
      region: { min: [-4, 0, -4], max: [5, 9, 5] },
      material: materialId(1),
    }),
  );
  execute(
    "fillSphere arm",
    fillSphereCommand(commandId("command:demo:persist:fill-arm"), {
      volumeId: ARM_VOLUME,
      center: [-8, 2, 3],
      radius: 2,
      material: materialId(1),
    }),
  );
  execute(
    "createMaterial accent",
    createMaterialCommand(commandId("command:demo:persist:create-material"), {
      materialId: materialId(2),
      name: "accent",
      color: canonicalColor("#00ff88"),
      opacity: 1,
      roughness: 0.3,
      metallic: 0.4,
      emissive: 0,
    }),
  );
  execute(
    "updateMaterial accent",
    updateMaterialCommand(commandId("command:demo:persist:update-material"), {
      materialId: materialId(2),
      name: "accent-bright",
      emissive: 0.2,
    }),
  );
  execute(
    "createNode extra",
    createNodeCommand(commandId("command:demo:persist:create-node"), {
      nodeId: EXTRA,
      name: "Extra",
      parentId: CHILD,
      transform: identity,
    }),
  );
  execute(
    "renameNode extra",
    renameNodeCommand(commandId("command:demo:persist:rename-node"), {
      nodeId: EXTRA,
      name: "Extra-renamed",
    }),
  );

  // Save: deterministic bytes, indexed container, semantic hash over
  // document + sorted chunk streams.
  const saved = store.getDocument();
  const volumes = new Map<VolumeId, VoxelVolumeReadView>();
  for (const volumeIdText of Object.keys(saved.volumes)) {
    const id = volumeId(volumeIdText);
    const readView = store.getVolume(id);
    if (readView === undefined) {
      throw new Error(`demo volume ${volumeIdText} disappeared`);
    }
    volumes.set(id, readView);
  }
  const hashBefore = canonicalAssetSemanticHash(saved, volumes);
  const firstBytes = writeVxlProject({ document: saved, volumes });
  const secondBytes = writeVxlProject({ document: saved, volumes });
  const byteStable = Buffer.from(firstBytes).equals(Buffer.from(secondBytes));

  // Reload: full validation (ZIP, index, checksums, versions, hash) and
  // reconstructed hierarchy, materials, animation descriptors, and volumes.
  const loaded = readVxlProject(firstBytes);
  const hashAfter = loaded.semanticHash;
  const hashStable = hashBefore === hashAfter;

  // Validated lifecycle replacement: reinstall into a fresh store.
  const { store: reloadedStore } = createDocumentStore({
    document: loaded.document,
    volumes: new Map(
      [...loaded.volumes.entries()].map(([id, volume]) => [id, volume.chunks]),
    ),
  });
  const sampleCoordinates: Vec3i[] = [
    [-4, 0, -4],
    [0, 4, 0],
    [4, 8, 4],
    [-8, 2, 3],
    [-10, 0, 1],
    [-6, 4, 5],
  ];
  const voxelSamples = sampleCoordinates.map((coordinate) => ({
    coordinate,
    before: store.getVoxel(BODY_VOLUME, coordinate),
    after: reloadedStore.getVoxel(BODY_VOLUME, coordinate),
  }));

  return canonicalJson({
    save: {
      bytes: firstBytes.byteLength,
      entryNames: loaded.manifest.entries.map((entry) => entry.name),
      byteStable,
      hashBefore,
      hashAfter,
      hashStable,
      volumeCount: loaded.volumes.size,
      chunkCounts: [...loaded.volumes.entries()].map(([id, volume]) => ({
        volumeId: id,
        chunks: volume.chunks.length,
      })),
    },
    reload: {
      documentId: loaded.document.documentId,
      revision: loaded.document.revision,
      nodeCount: Object.keys(loaded.document.nodes).length,
      materialCount: Object.keys(loaded.document.materials).length,
      animationCount: Object.keys(loaded.document.animations).length,
      rootName: loaded.document.nodes[ROOT]?.name ?? null,
      armParent: loaded.document.nodes[ARM]?.parentId ?? null,
      extraParent: loaded.document.nodes[EXTRA]?.parentId ?? null,
      extraName: loaded.document.nodes[EXTRA]?.name ?? null,
      accentColor: loaded.document.materials[materialId(2)]?.color ?? null,
      accentEmissive:
        loaded.document.materials[materialId(2)]?.emissive ?? null,
      occupiedBody: store.getVolume(BODY_VOLUME)?.occupiedCount() ?? -1,
      occupiedBodyAfter:
        reloadedStore.getVolume(BODY_VOLUME)?.occupiedCount() ?? -1,
      occupiedArm: store.getVolume(ARM_VOLUME)?.occupiedCount() ?? -1,
      occupiedArmAfter:
        reloadedStore.getVolume(ARM_VOLUME)?.occupiedCount() ?? -1,
      voxelSamples,
    },
    transactions,
  });
}

/** Builds the demo asset: hierarchy, materials, animation, two volumes. */
function createPersistenceDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:demo:persist:0001"),
    metadata: { title: "persistence demo", tags: ["vxl", "reload"] },
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
        children: [ARM],
        transform: identity,
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: BODY_VOLUME },
        ],
      },
      {
        nodeId: ARM,
        name: "Arm",
        parentId: CHILD,
        children: [],
        transform: {
          translation: [-8, 2, 3],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: ARM_VOLUME }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "stone",
        color: "#aabbcc",
        opacity: 1,
        roughness: 0.8,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: BODY_VOLUME,
        name: "Body",
        bounds: { min: [-4, 0, -4], max: [5, 9, 5] },
      },
      {
        volumeId: ARM_VOLUME,
        name: "Arm",
        bounds: { min: [-11, -1, 0], max: [-5, 5, 6] },
      },
    ],
    animations: [
      {
        animationId: animationId("animation:demo:persist:spin"),
        name: "Spin",
        duration: 4,
        loop: "loop",
        tracks: [
          {
            trackId: trackId("track:demo:persist:spin"),
            targetNodeId: ARM,
            interpolation: "linear",
            keyframes: [
              {
                keyframeId: keyframeId("keyframe:demo:persist:spin:0"),
                time: 0,
                property: { channel: "rotation", value: [0, 0, 0, 1] },
              },
              {
                keyframeId: keyframeId("keyframe:demo:persist:spin:1"),
                time: 4,
                property: { channel: "rotation", value: [0, 0, 1, 0] },
              },
            ],
          },
        ],
      },
    ],
  });
}
