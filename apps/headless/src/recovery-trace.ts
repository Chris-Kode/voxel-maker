import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceError,
  canonicalJson,
  commandId,
  documentId,
  materialId,
  nodeId,
  recoverySessionId,
  transactionId,
  volumeId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  canonicalColor,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import {
  canonicalAssetSemanticHash,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import {
  createDocumentStoreHandle,
  type DocumentStore,
} from "@voxel-maker/document/internal";
import {
  CommandBus,
  CommandRegistry,
  createMaterialCommand,
  fillBoxCommand,
  registerAnimationCommands,
  registerBatchCommands,
  registerMaterialCommands,
  registerArticulationCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
  renameNodeCommand,
  type Command,
} from "@voxel-maker/commands";
import {
  createSaveCoordinator,
  createVxlProjectEncoder,
  decodeJournalFrames,
  type ProjectStoragePort,
  type RecoveryJournal,
  type RecoveryJournalEvent,
  type SaveOutcome,
} from "@voxel-maker/storage";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import { NodeProjectStorage } from "./node-storage.js";
import { createRecoverySession, recoverProject } from "./recovery.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const TRACE_VOLUME = volumeId("volume:recovery:body");
const TRACE_ROOT = nodeId("node:recovery:root");
const TRACE_SESSION = recoverySessionId("session:recovery:trace:0001");

/** Storage port that can fail one journal append (degraded-durability demo). */
export class FaultInjectingPort extends NodeProjectStorage {
  failNextAppend = false;

  override async appendJournal(path: string, bytes: Uint8Array): Promise<void> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new WorkspaceError({
        family: "io",
        code: "IO_DISK_FULL",
        message: "simulated disk full during journal append",
        context: { path },
      });
    }
    return super.appendJournal(path, bytes);
  }
}

export function createTraceDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:recovery:trace:0001"),
    metadata: { title: "recovery trace", tags: ["journal"] },
    rootNodeId: TRACE_ROOT,
    nodes: [
      {
        nodeId: TRACE_ROOT,
        name: "Root",
        parentId: null,
        children: [],
        transform: identity,
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: TRACE_VOLUME },
        ],
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
        volumeId: TRACE_VOLUME,
        name: "Body",
        bounds: { min: [-4, 0, -4], max: [5, 9, 5] },
      },
    ],
  });
}

export function createTraceRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  registerRegionCommands(registry);
  registerNodeCommands(registry);
  registerArticulationCommands(registry);
  registerAnimationCommands(registry);
  registerMaterialCommands(registry);
  return registry;
}

/**
 * Durably writes the current store state to `path` with a plain save
 * coordinator (issue #66): the anchor write happens BEFORE a recovery
 * session exists, exactly like the real open flow where the snapshot is
 * already durable on disk when the session is created over it. The caller
 * then creates the session with this snapshot as its durable base.
 */
export async function saveDurableAnchor(
  store: DocumentStoreRead,
  port: ProjectStoragePort,
  path: string,
): Promise<SaveOutcome> {
  const coordinator = createSaveCoordinator({
    store,
    port,
    encoder: createVxlProjectEncoder(),
  });
  try {
    return await coordinator.save(path);
  } finally {
    coordinator.dispose();
  }
}

/** Immutable volume read views of every document volume (throws when missing). */
function volumeViews(
  store: DocumentStore,
): ReadonlyMap<VolumeId, VoxelVolumeReadView> {
  const views = new Map<VolumeId, VoxelVolumeReadView>();
  for (const volumeIdText of Object.keys(store.getDocument().volumes)) {
    const id = volumeId(volumeIdText);
    const view = store.getVolume(id);
    if (view === undefined) {
      throw new Error(`trace volume ${volumeIdText} disappeared`);
    }
    views.set(id, view);
  }
  return views;
}

/**
 * Headless crash-recovery demo (M1, ticket #14): save a snapshot, journal
 * committed transactions, simulate a crash, recover by replaying the
 * journal through normal decoding, then demonstrate corrupt-tail reporting,
 * compaction, save-as reassociation, and degraded-durability retry.
 */
export async function runRecoveryTrace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "voxel-maker-recovery-"));
  const projectPath = join(directory, "trace.vxl");
  const otherPath = join(directory, "trace-as.vxl");
  const degradedPath = join(directory, "degraded.vxl");
  const port = new FaultInjectingPort();
  try {
    // --- build the asset through commands and save a snapshot ---
    const document = createTraceDocument();
    const { store, writeCapability } = createDocumentStoreHandle({ document });
    const registry = createTraceRegistry();
    const bus = new CommandBus(store, registry, writeCapability);
    const run = (
      label: string,
      command: Command,
      expectedRevision: number,
    ): number => {
      const result = bus.execute(command, {
        transactionId: transactionId(`transaction:recovery:trace:${label}`),
        expectedRevision,
        source: "ui",
      });
      if (!result.ok) {
        throw new Error(`trace ${label} failed: ${result.error.code}`);
      }
      return result.value.revisionAfter;
    };
    run(
      "fill",
      fillBoxCommand(commandId("command:recovery:trace:fill"), {
        volumeId: TRACE_VOLUME,
        region: { min: [-4, 0, -4], max: [5, 9, 5] },
        material: materialId(1),
      }),
      0,
    );
    const snapshotRevision = run(
      "rename",
      renameNodeCommand(commandId("command:recovery:trace:rename"), {
        nodeId: TRACE_ROOT,
        name: "Root-renamed",
      }),
      1,
    );
    const snapshotHash = canonicalAssetSemanticHash(
      store.getDocument(),
      volumeViews(store),
    );

    // --- durably install the snapshot, then attach the recovery session ---
    // The snapshot save anchors the recovery area before any journal frame.
    // The write happens BEFORE the session exists, exactly like the real
    // open flow: the snapshot is already durable on disk when the session
    // is created over it, so the session starts clean (issue #66).
    const snapshotOutcome = await saveDurableAnchor(store, port, projectPath);
    // Edits run through the session bus so every commit is journaled.
    const session = createRecoverySession({
      projectPath,
      port,
      store,
      writeCapability,
      registry,
      sessionId: TRACE_SESSION,
      baseRevision: snapshotRevision,
      baseSemanticHash: snapshotHash,
    });
    const liveHash = (target: DocumentStore): string =>
      canonicalAssetSemanticHash(target.getDocument(), volumeViews(target));
    const runSession = (
      label: string,
      command: Command,
      expectedRevision: number,
    ): number => {
      const result = session.bus.execute(command, {
        transactionId: transactionId(`transaction:recovery:trace:${label}`),
        expectedRevision,
        source: "ui",
      });
      if (!result.ok) {
        throw new Error(`trace ${label} failed: ${result.error.code}`);
      }
      return result.value.revisionAfter;
    };
    const edit1 = runSession(
      "fill-extra",
      fillBoxCommand(commandId("command:recovery:trace:fill-extra"), {
        volumeId: TRACE_VOLUME,
        region: { min: [-4, 9, -4], max: [5, 10, 5] },
        material: materialId(1),
      }),
      snapshotRevision,
    );
    const edit2 = runSession(
      "material",
      createMaterialCommand(commandId("command:recovery:trace:material"), {
        materialId: materialId(2),
        name: "accent",
        color: canonicalColor("#00ff88"),
        opacity: 1,
        roughness: 0.3,
        metallic: 0.4,
        emissive: 0,
      }),
      edit1,
    );
    await journalEventOnce(
      session.journal,
      (event) => event.kind === "appended" && event.revisionAfter === edit2,
      "journal append",
    );
    const journaledBeforeCrash = session.journal.lastJournaledRevision();
    const liveBeforeCrash = store.revision;
    const liveHashBeforeCrash = liveHash(store);

    // --- simulated crash: everything in memory is discarded ---
    session.dispose();
    const crashRecovery = await recoverProject({
      port,
      projectPath,
      registry,
      expectedSessionId: TRACE_SESSION,
    });
    const recoveredHash = liveHash(crashRecovery.store);
    // Issue #65: a recovered document must start a fresh bounded user
    // history, so an immediate Undo reports no history instead of rolling
    // back a replayed pre-crash transaction.
    const undoAfterRecoveryResult = crashRecovery.bus.undo({
      transactionId: transactionId("transaction:recovery:trace:undo-after"),
      expectedRevision: crashRecovery.report.recoveredRevision,
      source: "ui",
    });
    const undoAfterRecovery = undoAfterRecoveryResult.ok
      ? { accepted: true, code: null }
      : { accepted: false, code: undoAfterRecoveryResult.error.code };
    // Issue #115: the recovered bus retains the replayed command ids for
    // the recovery horizon, so a fresh normal commit that reuses a
    // replayed id is rejected atomically instead of creating a second
    // committed transaction with the same identity.
    // `fill-extra` is the frame the trace awaited before the crash, so it
    // always replays into the recovered bus's executed command-id set;
    // `fill` may be covered by the durable snapshot and skipped.
    const commandReuseAfterRecoveryResult = crashRecovery.bus.execute(
      fillBoxCommand(commandId("command:recovery:trace:fill-extra"), {
        volumeId: TRACE_VOLUME,
        region: { min: [-4, 9, -4], max: [5, 10, 5] },
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:recovery:trace:reuse-after"),
        expectedRevision: crashRecovery.report.recoveredRevision,
        source: "ui",
      },
    );
    const commandReuseAfterRecovery = commandReuseAfterRecoveryResult.ok
      ? { accepted: true, code: null }
      : { accepted: false, code: commandReuseAfterRecoveryResult.error.code };

    // --- corrupt tail: garbage after the last complete frame ---
    await port.appendJournal(
      projectPath,
      new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3]),
    );
    const tailRecovery = await recoverProject({
      port,
      projectPath,
      registry,
      expectedSessionId: TRACE_SESSION,
    });

    // --- compaction: confirmed save installs the snapshot, then drops frames ---
    const compactSession = createRecoverySession({
      projectPath,
      port,
      store: crashRecovery.store,
      writeCapability: crashRecovery.writeCapability,
      registry,
      sessionId: TRACE_SESSION,
      // The recovery anchor is the journal header base (the snapshot
      // anchor when they agree; the journal base when the snapshot is
      // newer than the journal).
      baseRevision:
        crashRecovery.report.journalBaseRevision ??
        crashRecovery.report.snapshotRevision,
      baseSemanticHash:
        crashRecovery.report.journalBaseSemanticHash ??
        crashRecovery.report.snapshotHash,
    });
    const saveOutcome = await compactSession.save(projectPath);
    const journalBytesAfterSave = await port.readJournal(projectPath);
    const journalAfterSave = decodeJournalFrames(
      journalBytesAfterSave ?? new Uint8Array(0),
    );

    // --- save-as reassociation preserves the recovery identity ---
    await compactSession.saveAs(otherPath);
    const journalAtNewPath = await port.readJournal(otherPath);
    const newPathRecovery = await recoverProject({
      port,
      projectPath: otherPath,
      registry,
      expectedSessionId: TRACE_SESSION,
    });
    const journalAtOldPath = await port.readJournal(projectPath);

    // --- degraded durability: append failure leaves the edit valid and dirty ---
    port.failNextAppend = true;
    const { store: degradedStore, writeCapability: degradedCapability } =
      createDocumentStoreHandle({ document });
    const degradedRegistry = createTraceRegistry();
    const degradedSession = createRecoverySession({
      projectPath: degradedPath,
      port,
      store: degradedStore,
      writeCapability: degradedCapability,
      registry: degradedRegistry,
      sessionId: TRACE_SESSION,
      baseRevision: 0,
      baseSemanticHash: canonicalAssetSemanticHash(
        document,
        new Map<VolumeId, VoxelVolumeReadView>(),
      ),
    });
    const degradedResult = degradedSession.bus.execute(
      fillBoxCommand(commandId("command:recovery:trace:degraded"), {
        volumeId: TRACE_VOLUME,
        region: { min: [0, 0, 0], max: [1, 1, 1] },
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:recovery:trace:degraded"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    if (!degradedResult.ok) {
      throw new Error(`degraded edit failed: ${degradedResult.error.code}`);
    }
    await journalEventOnce(
      degradedSession.journal,
      (event) => event.kind === "append-failed",
      "degraded state",
    );
    const degradedAfterFailure = {
      degraded: degradedSession.journal.isDegraded(),
      lastJournaled: degradedSession.journal.lastJournaledRevision() ?? -1,
      storeRevision: degradedStore.revision,
      dirty: degradedSession.saveCoordinator.isDirty(),
    };
    degradedSession.journal.retry();
    await journalEventOnce(
      degradedSession.journal,
      (event) => event.kind === "appended" && event.revisionAfter === 1,
      "retry recovery",
    );
    const degradedAfterRetry = {
      degraded: degradedSession.journal.isDegraded(),
      lastJournaled: degradedSession.journal.lastJournaledRevision() ?? -1,
    };
    degradedSession.dispose();

    return canonicalJson({
      snapshot: {
        revision: snapshotRevision,
        hash: snapshotHash,
        saveStatus: snapshotOutcome.status,
        savedRevision: snapshotOutcome.revision,
      },
      edits: {
        edit1,
        edit2,
        journaledBeforeCrash: journaledBeforeCrash ?? -1,
        liveBeforeCrash,
      },
      crash: {
        recoveredRevision: crashRecovery.report.recoveredRevision,
        journalBaseRevision: crashRecovery.report.journalBaseRevision ?? -1,
        journalBaseHash: crashRecovery.report.journalBaseSemanticHash ?? null,
        replayedFrames: crashRecovery.report.replayedFrames,
        skippedCoveredFrames: crashRecovery.report.skippedCoveredFrames,
        journalAbsent: crashRecovery.report.journalAbsent,
        corruptTail:
          crashRecovery.report.corruptTail === undefined
            ? null
            : {
                frameIndex: crashRecovery.report.corruptTail.frameIndex,
                reason: crashRecovery.report.corruptTail.reason,
              },
        hashStable: recoveredHash === liveHashBeforeCrash,
        historyPast: crashRecovery.bus.historySnapshot().past.length,
        historyFresh: crashRecovery.report.history,
        undoAfterRecovery,
        commandReuseAfterRecovery,
      },
      corruptTail: {
        replayedFrames: tailRecovery.report.replayedFrames,
        recoveredRevision: tailRecovery.report.recoveredRevision,
        frameIndex: tailRecovery.report.corruptTail?.frameIndex ?? -1,
        reason: tailRecovery.report.corruptTail?.reason ?? null,
      },
      compaction: {
        status: saveOutcome.status,
        savedRevision: saveOutcome.revision,
        framesAfterSave: journalAfterSave.frames.length,
        headerPresent: journalAfterSave.header !== undefined,
        baseRevisionAfterSave: journalAfterSave.header?.baseRevision ?? -1,
      },
      saveAs: {
        journalMoved: journalAtOldPath === undefined,
        journalAtNewPath: journalAtNewPath !== undefined,
        sessionIdPreserved: newPathRecovery.report.sessionId === TRACE_SESSION,
        recoveredRevisionAtNewPath: newPathRecovery.report.recoveredRevision,
        replayedAtNewPath: newPathRecovery.report.replayedFrames,
      },
      degraded: {
        afterFailure: degradedAfterFailure,
        afterRetry: degradedAfterRetry,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Resolves on the first journal event matching `predicate`. Event-driven,
 * so tests never depend on wall-clock timing; the timeout is a safety net,
 * not a synchronization mechanism.
 */
export function journalEventOnce(
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
