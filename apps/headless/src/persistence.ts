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
import { quaternionFromAxisAngle, type Vec3i } from "@voxel-maker/math";
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
  addTrackCommand,
  createAnimationCommand,
  deleteAnimationCommand,
  deleteKeyframeCommand,
  createMaterialCommand,
  createNodeCommand,
  fillBoxCommand,
  fillSphereCommand,
  moveKeyframeCommand,
  registerAnimationCommands,
  registerBatchCommands,
  registerMaterialCommands,
  registerArticulationCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
  renameNodeCommand,
  setKeyframeCommand,
  updateMaterialCommand,
  type Command,
} from "@voxel-maker/commands";
import { readVxlProject, writeVxlProject } from "@voxel-maker/formats";
import {
  backupPathFor,
  createSaveCoordinator,
  createVxlProjectEncoder,
} from "@voxel-maker/storage";
import { NodeProjectStorage } from "./node-storage.js";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
export async function runPersistenceTrace(): Promise<string> {
  const document = createPersistenceDocument();
  const { store, writeCapability } = createDocumentStore({ document });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  registerRegionCommands(registry);
  registerNodeCommands(registry);
  registerArticulationCommands(registry);
  registerAnimationCommands(registry);
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
  const { store: reloadedStore, writeCapability: reloadedWriteCapability } =
    createDocumentStore({
      document: loaded.document,
      volumes: new Map(
        [...loaded.volumes.entries()].map(([id, volume]) => [
          id,
          volume.chunks,
        ]),
      ),
    });

  // Editing and undoing clips and keyframes after save and reload (ticket
  // #30): a fresh command bus over the reloaded store authors a new clip,
  // moves a keyframe, undoes and redoes the move, and edits a keyframe
  // value, then undoes that edit — all against the reloaded snapshot.
  const reloadedRegistry = new CommandRegistry();
  registerAnimationCommands(reloadedRegistry);
  const reloadedBus = new CommandBus(
    reloadedStore,
    reloadedRegistry,
    reloadedWriteCapability,
  );
  const bounceId = animationId("animation:demo:persist:bounce");
  const bounceTrack = trackId("track:demo:persist:bounce");
  const bounceKey0 = keyframeId("keyframe:demo:persist:bounce:0");
  const bounceKey1 = keyframeId("keyframe:demo:persist:bounce:1");
  let reloadedRevision = loaded.document.revision;
  let reloadedSerial = 0;
  const reloadedTx = (): {
    transactionId: ReturnType<typeof transactionId>;
    expectedRevision: number;
    source: "ui";
  } => {
    const transaction = {
      transactionId: transactionId(
        `transaction:demo:persist-reload:${String(reloadedSerial).padStart(4, "0")}`,
      ),
      expectedRevision: reloadedRevision,
      source: "ui" as const,
    };
    reloadedSerial += 1;
    return transaction;
  };
  const reloadedExecute = (command: Command): boolean => {
    const result = reloadedBus.execute(command, reloadedTx());
    if (result.ok) reloadedRevision = result.value.revisionAfter;
    return result.ok;
  };
  const bounceKeyTimes = (): readonly number[] =>
    reloadedStore
      .getDocument()
      .animations[bounceId]?.tracks[0]?.keyframes.map((key) => key.time) ?? [];
  const bounceKeyValue = (): readonly number[] | undefined =>
    reloadedStore.getDocument().animations[bounceId]?.tracks[0]?.keyframes[1]
      ?.property.value;
  const createBounceAccepted = reloadedExecute(
    createAnimationCommand(
      commandId("command:demo:persist-reload:create-animation"),
      {
        animationId: bounceId,
        name: "Bounce",
        duration: 2,
        loop: "loop",
      },
    ),
  );
  const addBounceTrackAccepted = reloadedExecute(
    addTrackCommand(commandId("command:demo:persist-reload:add-track"), {
      animationId: bounceId,
      trackId: bounceTrack,
      targetNodeId: ARM,
      interpolation: "linear",
    }),
  );
  const setBounceKeysAccepted =
    reloadedExecute(
      setKeyframeCommand(commandId("command:demo:persist-reload:set-key-0"), {
        animationId: bounceId,
        trackId: bounceTrack,
        keyframeId: bounceKey0,
        time: 0,
        property: {
          channel: "rotation",
          value: quaternionFromAxisAngle([1, 0, 0], 0),
        },
      }),
    ) &&
    reloadedExecute(
      setKeyframeCommand(commandId("command:demo:persist-reload:set-key-1"), {
        animationId: bounceId,
        trackId: bounceTrack,
        keyframeId: bounceKey1,
        time: 2,
        property: {
          channel: "rotation",
          value: quaternionFromAxisAngle([1, 0, 0], Math.PI / 4),
        },
      }),
    );
  const moveAccepted = reloadedExecute(
    moveKeyframeCommand(commandId("command:demo:persist-reload:move-key"), {
      animationId: bounceId,
      trackId: bounceTrack,
      keyframeId: bounceKey1,
      time: 1.5,
    }),
  );
  const timesAfterMove = bounceKeyTimes();
  const undoMoveResult = reloadedBus.undo(reloadedTx());
  const undoMoveAccepted = undoMoveResult.ok;
  // Undo and redo are themselves history transactions (ADR-0003): the
  // revision advances monotonically with every committed transaction.
  if (undoMoveAccepted) {
    reloadedRevision = undoMoveResult.value.revisionAfter;
  }
  const timesAfterUndo = bounceKeyTimes();
  const redoMoveResult = reloadedBus.redo(reloadedTx());
  const redoMoveAccepted = redoMoveResult.ok;
  if (redoMoveAccepted) {
    reloadedRevision = redoMoveResult.value.revisionAfter;
  }
  const timesAfterRedo = bounceKeyTimes();
  const editValueAccepted = reloadedExecute(
    setKeyframeCommand(commandId("command:demo:persist-reload:edit-value"), {
      animationId: bounceId,
      trackId: bounceTrack,
      keyframeId: bounceKey1,
      time: 1.5,
      property: {
        channel: "rotation",
        value: quaternionFromAxisAngle([1, 0, 0], Math.PI / 2),
      },
    }),
  );
  const valueAfterEdit = bounceKeyValue();
  const undoValueResult = reloadedBus.undo(reloadedTx());
  const undoValueAccepted = undoValueResult.ok;
  if (undoValueAccepted) {
    reloadedRevision = undoValueResult.value.revisionAfter;
  }
  const valueAfterUndo = bounceKeyValue();
  // Deleting clips and keyframes after save and reload (S10.6 CRUD):
  // deleting the second keyframe and undoing restores it exactly, then
  // deleting the authored clip and undoing restores the full clip.
  const keyframeCount = (): number =>
    reloadedStore.getDocument().animations[bounceId]?.tracks[0]?.keyframes
      .length ?? 0;
  const clipCount = (): number =>
    Object.keys(reloadedStore.getDocument().animations).length;
  const deleteKeyAccepted = reloadedExecute(
    deleteKeyframeCommand(commandId("command:demo:persist-reload:delete-key"), {
      animationId: bounceId,
      trackId: bounceTrack,
      keyframeId: bounceKey1,
    }),
  );
  const keyframesAfterDelete = keyframeCount();
  const undoDeleteKeyResult = reloadedBus.undo(reloadedTx());
  const undoDeleteKeyAccepted = undoDeleteKeyResult.ok;
  if (undoDeleteKeyAccepted) {
    reloadedRevision = undoDeleteKeyResult.value.revisionAfter;
  }
  const keyframesAfterUndoDelete = keyframeCount();
  const deleteClipAccepted = reloadedExecute(
    deleteAnimationCommand(
      commandId("command:demo:persist-reload:delete-clip"),
      {
        animationId: bounceId,
      },
    ),
  );
  const clipsAfterDelete = clipCount();
  const undoDeleteClipResult = reloadedBus.undo(reloadedTx());
  const undoDeleteClipAccepted = undoDeleteClipResult.ok;
  if (undoDeleteClipAccepted) {
    reloadedRevision = undoDeleteClipResult.value.revisionAfter;
  }
  const clipsAfterUndoDelete = clipCount();
  const valueEditUndone = (() => {
    if (valueAfterEdit === undefined || valueAfterUndo === undefined) {
      return false;
    }
    const undoneX = valueAfterUndo[0] ?? NaN;
    const editedX = valueAfterEdit[0] ?? NaN;
    return (
      Math.abs(undoneX - editedX) > 1e-9 &&
      Math.abs(undoneX - Math.sin(Math.PI / 8)) < 1e-9
    );
  })();
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

  // Atomic durable save (ticket #13, plan S5.6/S5.7/S5.14): the coordinator
  // captures an immutable `(revision, semantic hash)` snapshot, the Node
  // adapter writes a same-directory temporary file, flushes it, preserves a
  // last-known-good backup, and atomically replaces the destination.
  const saveDirectory = await mkdtemp(join(tmpdir(), "voxel-maker-save-"));
  const projectPath = join(saveDirectory, "demo.vxl");
  const storagePort = new NodeProjectStorage();
  const coordinator = createSaveCoordinator({
    store,
    port: storagePort,
    encoder: createVxlProjectEncoder(),
  });
  const firstSave = await coordinator.save(projectPath);
  const cleanAfterFirstSave = !coordinator.isDirty();
  const backupAfterFirstSave = await storagePort.exists(
    backupPathFor(projectPath),
  );

  // A later edit leaves the durable snapshot untouched and marks the
  // project dirty; the second save writes the new snapshot and backs up
  // the first one.
  execute(
    "fillBox extra",
    fillBoxCommand(commandId("command:demo:persist:fill-extra"), {
      volumeId: BODY_VOLUME,
      region: { min: [-4, 9, -4], max: [5, 10, 5] },
      material: materialId(2),
    }),
  );
  const revisionAfterEdit = revision;
  const dirtyAfterEdit = coordinator.isDirty();
  const secondSave = await coordinator.save(projectPath);
  const cleanAfterSecondSave = !coordinator.isDirty();
  const backupAfterSecondSave = await storagePort.exists(
    backupPathFor(projectPath),
  );

  // Reload the bytes that reached the disk and confirm identity.
  const savedBytes = await storagePort.readProject(projectPath);
  const savedProject = readVxlProject(savedBytes);
  const savedHashMatches =
    savedProject.semanticHash === secondSave.semanticHash;
  const backupBytes = await storagePort.readBackup(projectPath);
  const backupLoaded =
    backupBytes === undefined ? undefined : readVxlProject(backupBytes);
  const backupMatchesFirstSave =
    backupLoaded?.semanticHash === firstSave.semanticHash;
  const leftoverTempFiles = (await readdir(saveDirectory)).filter((name) =>
    name.endsWith(".tmp"),
  );
  await rm(saveDirectory, { recursive: true, force: true });

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
    animationReload: {
      clipCountAfterReload: Object.keys(loaded.document.animations).length,
      createBounceAccepted,
      addBounceTrackAccepted,
      setBounceKeysAccepted,
      moveAccepted,
      timesAfterMove,
      timesAfterUndo,
      timesAfterRedo,
      undoMoveAccepted,
      redoMoveAccepted,
      editValueAccepted,
      valueAfterEdit: valueAfterEdit ?? null,
      valueAfterUndo: valueAfterUndo ?? null,
      valueEditUndone,
      undoValueAccepted,
      deleteKeyAccepted,
      keyframesAfterDelete,
      undoDeleteKeyAccepted,
      keyframesAfterUndoDelete,
      deleteClipAccepted,
      clipsAfterDelete,
      undoDeleteClipAccepted,
      clipsAfterUndoDelete,
      reloadedRevision,
    },
    durable: {
      firstSave: {
        status: firstSave.status,
        revision: firstSave.revision,
        cleanAfter: cleanAfterFirstSave,
        backupAfter: backupAfterFirstSave,
      },
      edit: {
        revision: revisionAfterEdit,
        dirtyAfter: dirtyAfterEdit,
      },
      secondSave: {
        status: secondSave.status,
        revision: secondSave.revision,
        cleanAfter: cleanAfterSecondSave,
        backupAfter: backupAfterSecondSave,
        bytes: savedBytes.byteLength,
        savedHashMatches,
        backupMatchesFirstSave,
        leftoverTempFiles,
      },
    },
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
