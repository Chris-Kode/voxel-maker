#!/usr/bin/env node
/**
 * Clean-machine release smoke (issue #46, plan S17.8/S17.14, M5):
 * one deterministic headless journey through the release-critical manual
 * and AI workflows — create, edit, rig, animate, save, recover, import,
 * export, and the offline/consent-gated AI surface. The journey runs with
 * zero network access (no provider adapter is ever constructed) and
 * returns a canonical JSON report whose fields are asserted by
 * `release-smoke.test.ts` and by the packaged-app smoke step in the
 * release workflows.
 */
import {
  animationId,
  canonicalJson,
  commandId,
  componentId,
  documentId,
  keyframeId,
  materialId,
  nodeId,
  recoverySessionId,
  trackId,
  transactionId,
  volumeId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  canonicalColor,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { quaternionFromAxisAngle } from "@voxel-maker/math";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import { canonicalAssetSemanticHash } from "@voxel-maker/document";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import {
  CommandBus,
  CommandRegistry,
  addConstraintCommand,
  addJointCommand,
  addTrackCommand,
  createAnimationCommand,
  createMaterialCommand,
  createNodeCommand,
  fillBoxCommand,
  fillSphereCommand,
  registerAnimationCommands,
  registerArticulationCommands,
  registerBatchCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
  registerVolumeCommands,
  renameNodeCommand,
  setKeyframeCommand,
  setPivotCommand,
  setVoxelCommand,
  type Command,
} from "@voxel-maker/commands";
import {
  evaluateAnimationRuntime,
  type AnimationRuntimeState,
} from "@voxel-maker/animation";
import { importVox, exportVox, exportGltf } from "@voxel-maker/interchange";
import {
  DEFAULT_AGENT_BUDGETS,
  buildSessionDiagnostics,
  createInspector,
  createMutator,
  createPreviewSession,
  consentCovers,
  consentRequiredError,
} from "@voxel-maker/agent";
import type { MutationResult } from "@voxel-maker/agent";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeProjectStorage } from "./node-storage.js";
import { createRecoverySession, recoverProject } from "./recovery.js";
import { saveDurableAnchor } from "./recovery-trace.js";
import {
  decodeJournalFrames,
  type RecoveryJournal,
  type RecoveryJournalEvent,
} from "@voxel-maker/storage";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { DocumentStore } from "@voxel-maker/document/internal";
import type { VoxelWriteCapability } from "@voxel-maker/voxel";

const SMOKE_VERSION = "release-smoke-v1";

/**
 * The release app version the smoke qualifies. The packaged artifact is
 * self-contained, so the constant is compiled in; the in-repo test asserts
 * it stays equal to the root manifest version, so a version bump without
 * updating this gate fails CI.
 */
export const RELEASE_APP_VERSION = "0.1.0";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:smoke:root");
const BODY = nodeId("node:smoke:body");
const ARM = nodeId("node:smoke:arm");
const BODY_VOLUME = volumeId("volume:smoke:body");
const ARM_VOLUME = volumeId("volume:smoke:arm");
const CLIP = animationId("animation:smoke:wave");
const TRACK = trackId("track:smoke:arm-rotation");
const KEY0 = keyframeId("keyframe:smoke:wave:0");
const KEY1 = keyframeId("keyframe:smoke:wave:1");
const CONSTRAINT = componentId("component:smoke:shoulder-limit");
const SESSION = recoverySessionId("recovery:smoke:0001");

function createSmokeDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:smoke:0001"),
    metadata: { title: "release smoke", tags: ["smoke"] },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [BODY, ARM],
        transform: identity,
        components: [],
      },
      {
        nodeId: BODY,
        name: "Body",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: BODY_VOLUME },
        ],
      },
      {
        nodeId: ARM,
        name: "Arm",
        parentId: ROOT,
        children: [],
        transform: {
          translation: [6, 2, 0],
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
        color: canonicalColor("#aabbcc"),
        opacity: 1,
        roughness: 0.8,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: BODY_VOLUME,
        bounds: { min: [-4, 0, -4], max: [5, 9, 5] },
      },
      { volumeId: ARM_VOLUME, bounds: { min: [5, 0, -1], max: [9, 5, 2] } },
    ],
  });
}

function createSmokeRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  registerRegionCommands(registry);
  registerNodeCommands(registry);
  registerArticulationCommands(registry);
  registerAnimationCommands(registry);
  registerMaterialCommands(registry);
  registerVolumeCommands(registry);
  return registry;
}

/**
 * The mutation output envelope (MUTATION_CONTRACT_VERSION): the mutator
 * returns `value` as JsonValue by contract, so this helper narrows the
 * documented shape in one place. The smoke then stages the constructed
 * command through the preview session like the agent loop does.
 */
interface ConstructedCommandValue {
  readonly command: {
    readonly id: string;
    readonly type: string;
    readonly schemaVersion: number;
    readonly payload: unknown;
  };
}

function commandFromProposal(proposal: MutationResult): Command {
  if (!proposal.ok) {
    throw new Error(`release smoke ai proposal failed: ${proposal.error.code}`);
  }
  return (proposal.value as unknown as ConstructedCommandValue)
    .command as Command;
}

/** Immutable volume read views of every document volume (throws when missing). */
function volumeViews(
  store: DocumentStoreRead,
): ReadonlyMap<VolumeId, VoxelVolumeReadView> {
  const views = new Map<VolumeId, VoxelVolumeReadView>();
  for (const volumeIdText of Object.keys(store.getDocument().volumes)) {
    const id = volumeId(volumeIdText);
    const view = store.getVolume(id);
    if (view === undefined) {
      throw new Error(`smoke volume ${volumeIdText} disappeared`);
    }
    views.set(id, view);
  }
  return views;
}

interface LiveHarness {
  readonly document: VoxelDocument;
  readonly store: DocumentStore;
  readonly writeCapability: VoxelWriteCapability;
  readonly registry: CommandRegistry;
  readonly bus: CommandBus;
}

function liveHarness(): LiveHarness {
  const document = createSmokeDocument();
  const { store, writeCapability } = createDocumentStoreHandle({ document });
  const registry = createSmokeRegistry();
  const bus = new CommandBus(store, registry, writeCapability);
  return { document, store, writeCapability, registry, bus };
}

/**
 * A transform-free single-volume document for the lossless VOX round trip
 * (ADR-0011: non-identity transforms block VOX export by default).
 */
function createImportSourceHarness(): LiveHarness {
  const document = createDocument({
    documentId: documentId("document:smoke:vox-source"),
    metadata: { title: "vox round trip source", tags: ["smoke"] },
    rootNodeId: nodeId("node:smoke:vox-root"),
    nodes: [
      {
        nodeId: nodeId("node:smoke:vox-root"),
        name: "Root",
        parentId: null,
        children: [nodeId("node:smoke:vox-body")],
        transform: identity,
        components: [],
      },
      {
        nodeId: nodeId("node:smoke:vox-body"),
        name: "Body",
        parentId: nodeId("node:smoke:vox-root"),
        children: [],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:smoke:vox"),
          },
        ],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "stone",
        color: canonicalColor("#aabbcc"),
        opacity: 1,
        roughness: 0.8,
        metallic: 0,
        emissive: 0,
      },
      {
        materialId: materialId(2),
        name: "accent",
        color: canonicalColor("#ff8800"),
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: volumeId("volume:smoke:vox"),
        // Occupied Z extent is non-positive so the VOX export is lossless
        // under the unsigned-cube origin rule (vox-mapping.ts preflight).
        bounds: { min: [0, 0, -4], max: [4, 4, 1] },
      },
    ],
  });
  const { store, writeCapability } = createDocumentStoreHandle({ document });
  const registry = createSmokeRegistry();
  const bus = new CommandBus(store, registry, writeCapability);
  let result = bus.execute(
    fillBoxCommand(commandId("command:smoke:vox-source:fill"), {
      volumeId: volumeId("volume:smoke:vox"),
      region: { min: [0, 0, -4], max: [4, 4, 1] },
      material: materialId(1),
    }),
    {
      transactionId: transactionId("transaction:smoke:vox-source:0001"),
      expectedRevision: 0,
      source: "ui",
    },
  );
  if (!result.ok) {
    throw new Error(
      `release smoke vox source fill rejected: ${result.error.code}`,
    );
  }
  result = bus.execute(
    fillBoxCommand(commandId("command:smoke:vox-source:accent"), {
      volumeId: volumeId("volume:smoke:vox"),
      region: { min: [1, 1, -3], max: [3, 3, 0] },
      material: materialId(2),
    }),
    {
      transactionId: transactionId("transaction:smoke:vox-source:0002"),
      expectedRevision: 1,
      source: "ui",
    },
  );
  if (!result.ok) {
    throw new Error(
      `release smoke vox source accent rejected: ${result.error.code}`,
    );
  }
  return { document, store, writeCapability, registry, bus };
}

/** Runs one command, throwing with the stable error code on rejection. */
function run(
  harness: LiveHarness,
  label: string,
  command: Command,
  expectedRevision: number,
  serial: { value: number },
): number {
  const result = harness.bus.execute(command, {
    transactionId: transactionId(
      `transaction:smoke:${String(serial.value).padStart(4, "0")}`,
    ),
    expectedRevision,
    source: "ui",
  });
  serial.value += 1;
  if (!result.ok) {
    throw new Error(
      `release smoke ${label} rejected: ${result.error.code} (${result.error.message})`,
    );
  }
  return result.value.revisionAfter;
}

/**
 * Resolves on the first journal event matching `predicate`; event-driven so
 * the smoke never depends on wall-clock timing (same contract as the
 * recovery trace). The timeout is a safety net, not a synchronization
 * mechanism.
 */
function journalEventOnce(
  journal: RecoveryJournal,
  predicate: (event: RecoveryJournalEvent) => boolean,
  what: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${what}`));
    }, 5_000);
    const unsubscribe = journal.subscribe((event) => {
      if (predicate(event)) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Runs the complete release smoke journey and returns the canonical JSON
 * report. Every phase is deterministic (fixed ids, fixed seeds, no clock,
 * no network, no provider adapter).
 */
export async function runReleaseSmoke(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "voxel-maker-smoke-"));
  const projectPath = join(directory, "smoke.vxl");
  const glbPath = join(directory, "smoke.glb");
  const voxPath = join(directory, "smoke.vox");
  const port = new NodeProjectStorage();
  try {
    // ---- create: a fresh validated document ----
    const harness = liveHarness();
    const serial = { value: 0 };
    const created = {
      documentId: harness.document.documentId,
      valid: harness.store.getDocument().nodes[ROOT] !== undefined,
      revision: harness.store.revision,
    };

    // ---- edit: voxel, material, and node commands through the bus ----
    let revision = 0;
    revision = run(
      harness,
      "fillBox body",
      fillBoxCommand(commandId("command:smoke:fill-body"), {
        volumeId: BODY_VOLUME,
        region: { min: [-4, 0, -4], max: [5, 9, 5] },
        material: materialId(1),
      }),
      revision,
      serial,
    );
    revision = run(
      harness,
      "setVoxel accent",
      setVoxelCommand(commandId("command:smoke:set-voxel"), {
        volumeId: BODY_VOLUME,
        coordinate: [0, 4, 0],
        material: materialId(1),
      }),
      revision,
      serial,
    );
    revision = run(
      harness,
      "fillSphere arm",
      fillSphereCommand(commandId("command:smoke:fill-arm"), {
        volumeId: ARM_VOLUME,
        center: [7, 2, 0],
        radius: 2,
        material: materialId(1),
      }),
      revision,
      serial,
    );
    revision = run(
      harness,
      "createMaterial accent",
      createMaterialCommand(commandId("command:smoke:create-material"), {
        materialId: materialId(2),
        name: "accent",
        color: canonicalColor("#00ff88"),
        opacity: 1,
        roughness: 0.3,
        metallic: 0.4,
        emissive: 0,
      }),
      revision,
      serial,
    );
    const createdNodeId = nodeId("node:smoke:extra");
    revision = run(
      harness,
      "createNode extra",
      createNodeCommand(commandId("command:smoke:create-node"), {
        nodeId: createdNodeId,
        name: "Extra",
        parentId: ROOT,
        transform: identity,
      }),
      revision,
      serial,
    );
    revision = run(
      harness,
      "renameNode extra",
      renameNodeCommand(commandId("command:smoke:rename-node"), {
        nodeId: createdNodeId,
        name: "Extra-renamed",
      }),
      revision,
      serial,
    );
    // undo/redo round-trip proves manual editing retains history. Undo and
    // redo are themselves committed transactions (ADR-0003): each advances
    // the store revision, and the accent voxel disappears and reappears.
    const undoEdit = harness.bus.undo({
      transactionId: transactionId("transaction:smoke:undo:0001"),
      expectedRevision: revision,
      source: "ui",
    });
    const nameAfterUndo =
      harness.store.getDocument().nodes[createdNodeId]?.name;
    const redoEdit = harness.bus.redo({
      transactionId: transactionId("transaction:smoke:redo:0001"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    revision = harness.store.revision;
    const voxelAt = harness.store.getVoxel(BODY_VOLUME, [0, 4, 0]);
    const edits = {
      revisionAfter: revision,
      voxelAt,
      undoAccepted: undoEdit.ok && nameAfterUndo === "Extra",
      redoAccepted: redoEdit.ok && voxelAt === 1,
      transactions: serial.value,
    };

    // ---- rig: pivot, joint, and constraint on the arm ----
    revision = run(
      harness,
      "setPivot arm",
      setPivotCommand(commandId("command:smoke:set-pivot"), {
        nodeId: ARM,
        pivot: [1, 1, 0],
      }),
      revision,
      serial,
    );
    revision = run(
      harness,
      "addJoint arm",
      addJointCommand(commandId("command:smoke:add-joint"), {
        nodeId: ARM,
      }),
      revision,
      serial,
    );
    revision = run(
      harness,
      "addConstraint shoulder",
      addConstraintCommand(commandId("command:smoke:add-constraint"), {
        nodeId: ARM,
        componentId: CONSTRAINT,
        limits: {
          min: [-Math.PI / 4, -Math.PI / 4, -Math.PI / 4],
          max: [Math.PI / 4, Math.PI / 4, Math.PI / 4],
        },
        before: null,
      }),
      revision,
      serial,
    );
    const armNode = harness.store.getDocument().nodes[ARM];
    const armComponents =
      armNode === undefined
        ? []
        : armNode.components.map((component) => component.kind);
    const rig = {
      components: armComponents,
      pivotSet: armComponents.includes("pivot"),
      jointAdded: armComponents.includes("joint"),
      constraintAdded: armComponents.includes("constraint"),
    };

    // ---- animate: clip, track, keyframes, then evaluate the runtime ----
    revision = run(
      harness,
      "createAnimation wave",
      createAnimationCommand(commandId("command:smoke:create-animation"), {
        animationId: CLIP,
        name: "Wave",
        duration: 2,
        loop: "loop",
      }),
      revision,
      serial,
    );
    revision = run(
      harness,
      "addTrack arm rotation",
      addTrackCommand(commandId("command:smoke:add-track"), {
        animationId: CLIP,
        trackId: TRACK,
        targetNodeId: ARM,
        interpolation: "linear",
      }),
      revision,
      serial,
    );
    revision = run(
      harness,
      "setKeyframe 0",
      setKeyframeCommand(commandId("command:smoke:key-0"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: KEY0,
        time: 0,
        property: {
          channel: "rotation",
          value: quaternionFromAxisAngle([0, 0, 1], 0),
        },
      }),
      revision,
      serial,
    );
    revision = run(
      harness,
      "setKeyframe 1",
      setKeyframeCommand(commandId("command:smoke:key-1"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: KEY1,
        time: 2,
        property: {
          channel: "rotation",
          value: quaternionFromAxisAngle([0, 0, 1], Math.PI / 2),
        },
      }),
      revision,
      serial,
    );
    const clip = harness.store.getDocument().animations[CLIP] ?? null;
    const runtime: AnimationRuntimeState = evaluateAnimationRuntime(
      harness.store.getDocument(),
      clip,
      1,
    );
    const armWorld = runtime.world.get(ARM);
    const track = clip?.tracks.find((entry) => entry.trackId === TRACK);
    const animate = {
      clipDuration: clip?.duration ?? -1,
      clipLoop: clip?.loop ?? null,
      trackKeyframes: track === undefined ? -1 : track.keyframes.length,
      midPoseRotation: armWorld === undefined ? null : Array.from(armWorld),
      runtimeEvaluated: armWorld !== undefined,
    };

    // ---- save: atomic durable save with journal anchored ----
    const anchorRevision = revision;
    const anchorHash = canonicalAssetSemanticHash(
      harness.store.getDocument(),
      volumeViews(harness.store),
    );
    // The anchor write happens BEFORE the session exists, exactly like the
    // real open flow: the snapshot is already durable on disk when the
    // session is created over it, so the session starts clean (issue #66).
    const saveOutcome = await saveDurableAnchor(
      harness.store,
      port,
      projectPath,
    );
    const session = createRecoverySession({
      projectPath,
      port,
      store: harness.store,
      writeCapability: harness.writeCapability,
      registry: harness.registry,
      sessionId: SESSION,
      baseRevision: anchorRevision,
      baseSemanticHash: anchorHash,
    });
    // The confirmed anchor is already durable, so the session's own save
    // would be a no-op; reset the journal base explicitly so the recovery
    // area is anchored (header present, zero frames) before any edit.
    await session.journal.resetBase(anchorRevision, anchorHash);
    const projectBytes = await readFile(projectPath);
    const journalAfterSave = decodeJournalFrames(
      (await port.readJournal(projectPath)) ?? new Uint8Array(0),
    );
    const save = {
      status: saveOutcome.status,
      savedRevision: saveOutcome.revision,
      anchorRevision,
      bytes: projectBytes.byteLength,
      journalFramesAfterSave: journalAfterSave.frames.length,
      headerPresent: journalAfterSave.header !== undefined,
    };

    // ---- recover: journaled edits, simulated crash, corrupt tail ----
    const runSession = (
      label: string,
      command: Command,
      expectedRevision: number,
    ): number => {
      const result = session.bus.execute(command, {
        transactionId: transactionId(`transaction:smoke:recover:${label}`),
        expectedRevision,
        source: "ui",
      });
      if (!result.ok) {
        throw new Error(
          `release smoke recover ${label} rejected: ${result.error.code}`,
        );
      }
      return result.value.revisionAfter;
    };
    const editAfterSave = runSession(
      "fill-extra",
      fillBoxCommand(commandId("command:smoke:recover:fill"), {
        volumeId: BODY_VOLUME,
        region: { min: [-4, 9, -4], max: [5, 10, 5] },
        material: materialId(1),
      }),
      saveOutcome.revision,
    );
    await journalEventOnce(
      session.journal,
      (event) =>
        event.kind === "appended" && event.revisionAfter === editAfterSave,
      "journal append",
    );
    const liveHashBeforeCrash = canonicalAssetSemanticHash(
      harness.store.getDocument(),
      volumeViews(harness.store),
    );
    session.dispose(); // simulated crash: no durable state beyond the journal
    const crashRecovery = await recoverProject({
      port,
      projectPath,
      registry: harness.registry,
      expectedSessionId: SESSION,
    });
    const recoveredHash = canonicalAssetSemanticHash(
      crashRecovery.store.getDocument(),
      volumeViews(crashRecovery.store),
    );
    await port.appendJournal(
      projectPath,
      new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3]),
    );
    const tailRecovery = await recoverProject({
      port,
      projectPath,
      registry: harness.registry,
      expectedSessionId: SESSION,
    });
    const recover = {
      crash: {
        recoveredRevision: crashRecovery.report.recoveredRevision,
        replayedFrames: crashRecovery.report.replayedFrames,
        journalAbsent: crashRecovery.report.journalAbsent,
        hashStable: recoveredHash === liveHashBeforeCrash,
        historyFresh: crashRecovery.report.history,
        editRevisionAfterSave: editAfterSave,
      },
      corruptTail: {
        reported: tailRecovery.report.corruptTail !== undefined,
        frameIndex: tailRecovery.report.corruptTail?.frameIndex ?? -1,
        reason: tailRecovery.report.corruptTail?.reason ?? null,
        recoveredRevision: tailRecovery.report.recoveredRevision,
      },
    };

    // ---- import: VOX bytes into a fresh session through one transaction ----
    // The VOX source is a transform-free single-volume document so the
    // export is lossless (ADR-0011: transforms are a VOX loss and block by
    // default); the round trip then imports through one transaction.
    const importHarness = liveHarness();
    const voxExportHarness = createImportSourceHarness();
    const voxBytes = await exportVox({
      document: voxExportHarness.document,
      getVolume: (id) => voxExportHarness.store.getVolume(id),
      storagePort: port,
      path: join(directory, "roundtrip.vox"),
      // ADR-0011: VOX cannot carry hierarchy or origins; the structured
      // loss report is surfaced instead of silently dropping data.
      choices: { rebaseOrigins: true, flattenHierarchy: true },
    });
    if (!voxBytes.ok) {
      throw new Error(
        `release smoke vox preflight blocked: ${voxBytes.blocked
          .map((loss) => loss.code)
          .join(",")}`,
      );
    }
    const imported = importVox(importHarness.bus, importHarness.store, {
      bytes: voxBytes.bytes,
      expectedRevision: 0,
      transactionId: transactionId("transaction:smoke:import:0001"),
    });
    const importReport = {
      nodesCreated: imported.nodesCreated,
      volumesCreated: imported.volumesCreated,
      voxelsImported: imported.voxelsImported,
      materialsCreated: imported.materialsCreated,
      revisionAfter: imported.revisionAfter,
      warnings: imported.warnings.length,
      exportLosses: voxBytes.losses.map((loss) => loss.code),
    };

    // ---- export: glTF binary plus VOX through the atomic storage port ----
    const exportHarness = liveHarness();
    const exportSerial = { value: 0 };
    run(
      exportHarness,
      "fillBox export body",
      fillBoxCommand(commandId("command:smoke:export:fill"), {
        volumeId: BODY_VOLUME,
        region: { min: [-4, 0, -4], max: [5, 9, 5] },
        material: materialId(1),
      }),
      0,
      exportSerial,
    );
    const gltfOutcome = await exportGltf({
      document: exportHarness.store.getDocument(),
      getVolume: (id) => exportHarness.store.getVolume(id),
      storagePort: port,
      path: glbPath,
    });
    if (!gltfOutcome.ok) {
      throw new Error("release smoke gltf export failed");
    }
    const glbBytes = await readFile(glbPath);
    const voxOutcome = await exportVox({
      // The transform-free source document is lossless in VOX; the main
      // document's transforms/hierarchy losses are demonstrated by the
      // import-phase round trip with its structured loss report instead.
      document: voxExportHarness.document,
      getVolume: (id) => voxExportHarness.store.getVolume(id),
      storagePort: port,
      path: voxPath,
    });
    if (!voxOutcome.ok) {
      throw new Error(
        `release smoke vox export failed: ${voxOutcome.blocked
          .map((loss) => loss.code)
          .join(",")}`,
      );
    }
    const voxFileBytes = await readFile(voxPath);
    const exportReport = {
      glb: {
        format: gltfOutcome.format,
        bytes: glbBytes.byteLength,
        magic: glbBytes.subarray(0, 4).toString("ascii"),
      },
      vox: {
        bytes: voxFileBytes.byteLength,
        magic: voxFileBytes.subarray(0, 4).toString("ascii"),
        losses: voxOutcome.losses.map((loss) => loss.code),
      },
    };

    // ---- AI offline surface: inspection, staged proposals, consent ----
    // No provider adapter is constructed anywhere in this journey, so
    // providerTransmissions stays zero by construction; the consent gate
    // additionally proves a run without consent fails closed.
    const inspector = createInspector({ store: harness.store });
    const summary = inspector.inspect("inspectSummary", {});
    const mutator = createMutator({
      store: harness.store,
      registry: harness.registry,
    });
    const propose = (commandIdText: string) =>
      commandFromProposal(
        mutator.construct("fillBox", {
          commandId: commandIdText,
          volumeId: BODY_VOLUME,
          region: { min: [0, 0, 0], max: [1, 1, 1] },
          material: 2,
        }),
      );
    // Discard path: staging must be side-effect free.
    const preview = createPreviewSession({
      live: harness.store,
      applyBus: harness.bus,
      registry: harness.registry,
    });
    const voxelBefore = harness.store.getVoxel(BODY_VOLUME, [0, 0, 0]);
    const staged = preview.stage(propose("command:smoke:ai:proposal"));
    if (!staged.ok) {
      throw new Error(`release smoke ai stage failed: ${staged.error.code}`);
    }
    const diff = preview.diff();
    preview.discard();
    const voxelAfterDiscard = harness.store.getVoxel(BODY_VOLUME, [0, 0, 0]);
    // Apply path: one optimistic transaction, then undo restores state.
    const preview2 = createPreviewSession({
      live: harness.store,
      applyBus: harness.bus,
      registry: harness.registry,
    });
    const staged2 = preview2.stage(propose("command:smoke:ai:proposal2"));
    if (!staged2.ok) {
      throw new Error(`release smoke ai stage2 failed: ${staged2.error.code}`);
    }
    const applied = preview2.apply({
      transactionId: transactionId("transaction:smoke:ai:apply"),
      label: "ai-smoke-apply",
    });
    preview2.discard();
    const voxelAfterApply = harness.store.getVoxel(BODY_VOLUME, [0, 0, 0]);
    const undoApply = harness.bus.undo({
      transactionId: transactionId("transaction:smoke:ai:undo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    const voxelAfterUndo = harness.store.getVoxel(BODY_VOLUME, [0, 0, 0]);
    // Diagnostics export smoke (plan §13, S17.9): the sanitized report
    // builder must redact secrets/paths/URLs even when prompts are
    // explicitly opted in, and never leak the raw secret.
    const fakeSecret = "sk-release-smoke-secret-0123456789";
    const diagnostics = buildSessionDiagnostics({
      providerId: "openai",
      model: "gpt-5",
      result: {
        ok: false,
        state: "error",
        reason: "provider",
        error: Object.assign(new Error("release smoke fake provider failure"), {
          code: "PROVIDER_UNCONFIGURED",
        }),
        // Issue #78: failed results carry the cumulative consumed evidence.
        rounds: 1,
        toolCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      messages: [
        {
          role: "user",
          content: `refine the model with key ${fakeSecret} at /Users/release-smoke/project and https://example.com/leak`,
        },
      ],
      budgets: DEFAULT_AGENT_BUDGETS,
      createdAt: 1_700_000_000_000,
      includePrompts: true,
      secrets: [fakeSecret],
    });
    const diagnosticsJson = JSON.stringify(diagnostics);
    const ai = {
      inspectorSummary: summary.ok,
      stagedCommandCount: diff.ok ? diff.value.stagedCommandCount : -1,
      voxelEstimate: diff.ok ? diff.value.voxelEstimate : -1,
      discardLeavesVoxel: voxelAfterDiscard === voxelBefore,
      applyAccepted: applied.ok,
      applyChangesVoxel: voxelAfterApply === 2,
      undoRestoresVoxel: undoApply.ok && voxelAfterUndo === voxelBefore,
      consentRequiredCode: consentRequiredError().code,
      consentCoversMismatched: consentCovers(
        {
          providerId: "openai",
          model: "gpt-5",
          categories: [],
          consentedAt: 0,
          expiresAt: 0,
          consentVersion: 1,
        },
        { providerId: "openai", model: "gpt-5" },
        1,
      ),
      providerTransmissions: 0,
      diagnostics: {
        outcomeOk: diagnostics.outcome.ok,
        errorCode: diagnostics.outcome.errorCode ?? null,
        promptRedacted: !diagnosticsJson.includes(fakeSecret),
        markerPresent: diagnosticsJson.includes("[REDACTED]"),
        noRawPath: !diagnosticsJson.includes("/Users/release-smoke"),
        noRawUrl: !diagnosticsJson.includes("https://example.com/leak"),
        stagedCommands: diagnostics.staged?.commands ?? -1,
      },
    };

    return canonicalJson({
      version: SMOKE_VERSION,
      appVersion: RELEASE_APP_VERSION,
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
      },
      created,
      edits,
      rig,
      animate,
      save,
      recover,
      import: importReport,
      export: exportReport,
      aiOffline: ai,
      offline: { networkAccess: "none", providerAdapters: 0 },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
