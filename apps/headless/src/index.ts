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
} from "@voxel-maker/shared";
import {
  canonicalColor,
  canonicalDocumentHash,
  canonicalDocumentJson,
  createDocument,
  parseDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { quaternionFromAxisAngle } from "@voxel-maker/math";
import {
  createAnimatedWheelDocument,
  createPlaybackController,
  evaluateAnimationRuntime,
} from "@voxel-maker/animation";
import { chunkCoordinate, localCoordinate } from "@voxel-maker/voxel";
import { createDocumentStore } from "@voxel-maker/document";
import {
  CommandBus,
  CommandRegistry,
  addTrackCommand,
  createAnimationCommand,
  createMaterialCommand,
  createNodeCommand,
  deleteMaterialCommand,
  registerAnimationCommands,
  registerArticulationCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerVoxelCommands,
  renameNodeCommand,
  reparentNodeCommand,
  setKeyframeCommand,
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
  registerAnimationCommands(registry);
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

/**
 * Headless animation trace (ticket #28): author a generic clip through the
 * command bus (create clip, add track, set keyframes), sample and evaluate
 * the layered runtime, drive the injectable playback controller with a
 * fake clock, and verify that stop restores the base state exactly while
 * playback never bumps the document revision.
 */
export function runAnimationTrace(): string {
  const document = createAnimatedWheelDocument();
  const { store, writeCapability } = createDocumentStore({ document });
  const registry = new CommandRegistry();
  registerNodeCommands(registry);
  registerAnimationCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);

  const wheel = nodeId("node:rig:wheel:wheel");
  const spin = animationId("animation:demo:spin");
  const spinTrack = trackId("track:demo:spin");
  const revision = () => store.revision;
  const tx = (label: string, expectedRevision: number) => ({
    transactionId: transactionId(`transaction:demo:${label}`),
    expectedRevision,
    source: "ui" as const,
  });

  const baseRevision = revision();
  const createClip = bus.execute(
    createAnimationCommand(commandId("command:demo:animation:create:0001"), {
      animationId: spin,
      name: "Spin",
      duration: 1,
      loop: "loop",
    }),
    tx("animation-create", baseRevision),
  );
  const addTrack = bus.execute(
    addTrackCommand(commandId("command:demo:animation:track:0001"), {
      animationId: spin,
      trackId: spinTrack,
      targetNodeId: wheel,
      interpolation: "linear",
    }),
    tx("animation-track", baseRevision + 1),
  );
  const setKey = bus.execute(
    setKeyframeCommand(commandId("command:demo:animation:key:0001"), {
      animationId: spin,
      trackId: spinTrack,
      keyframeId: keyframeId("keyframe:demo:spin:0"),
      time: 0,
      property: {
        channel: "rotation",
        value: quaternionFromAxisAngle([0, 1, 0], 0),
      },
    }),
    tx("animation-key-0", baseRevision + 2),
  );
  const setKeyEnd = bus.execute(
    setKeyframeCommand(commandId("command:demo:animation:key:0002"), {
      animationId: spin,
      trackId: spinTrack,
      keyframeId: keyframeId("keyframe:demo:spin:1"),
      time: 1,
      property: {
        channel: "rotation",
        value: quaternionFromAxisAngle([0, 1, 0], Math.PI / 2),
      },
    }),
    tx("animation-key-1", baseRevision + 3),
  );
  const authoringAccepted =
    createClip.ok && addTrack.ok && setKey.ok && setKeyEnd.ok;
  if (!authoringAccepted) {
    throw new Error("headless animation authoring failed");
  }

  const clip = store.getDocument().animations[spin];
  if (clip === undefined) throw new Error("headless animation clip missing");
  const runtime = evaluateAnimationRuntime(store.getDocument(), clip, 0.5);
  const wheelLocal = runtime.local.get(wheel);
  const sampledSin = wheelLocal === undefined ? NaN : wheelLocal.rotation[1];
  const revisionAfterAuthoring = revision();

  // Playback: fake clock, play 0.5s, pause, stop, and check base restore.
  let clock = 1000;
  const controller = createPlaybackController(
    { now: () => clock },
    store.getDocument(),
    clip,
  );
  controller.play();
  clock += 0.5;
  controller.tick(clock);
  const played = controller.state;
  const evaluatedWhilePlaying = controller.evaluate().local.get(wheel)
    ?.rotation[1];
  controller.pause();
  controller.scrub(0.25);
  const scrubbedTime = controller.state.resolvedTime;
  controller.stop();
  const baseRestored = controller.evaluate().local.get(wheel)?.rotation[1];
  const revisionAfterPlayback = revision();

  return canonicalJson({
    authoring: {
      accepted: authoringAccepted,
      clipCount: Object.keys(store.getDocument().animations).length,
      revisionAfterAuthoring,
    },
    sampling: {
      clipName: clip.name ?? null,
      duration: clip.duration,
      loop: clip.loop,
      resolvedHalfSecondRotationSin: sampledSin,
      expectedHalfSecondRotationSin: Math.sin(Math.PI / 8),
    },
    playback: {
      playing: played.playing,
      time: played.time,
      loop: played.loopOverride,
      scrubbedTime,
      rotationSinWhilePlaying: evaluatedWhilePlaying ?? -1,
      rotationSinAfterStop: baseRestored ?? -1,
      baseRestoredExactly: baseRestored === 0,
      revisionAfterPlayback,
      revisionUnchangedDuringPlayback:
        revisionAfterPlayback === revisionAfterAuthoring,
    },
  });
}
