import type { RecoverySessionId } from "@voxel-maker/shared";
import {
  createDocumentStoreHandle,
  type DocumentStore,
} from "@voxel-maker/document/internal";
import {
  CommandBus,
  CommandRegistry,
  DEFAULT_COMMAND_LIMITS,
  JOURNAL_COMMAND_ENVELOPE_VERSION,
  journalTransactionToJson,
  parseJournalTransaction,
  type CommandLimits,
  type CommittedTransactionRecord,
} from "@voxel-maker/commands";
import {
  readVxlProject,
  VXL_CONTAINER_VERSION,
  VXL_DOCUMENT_VERSION,
} from "@voxel-maker/formats";
import {
  captureRevisionSnapshot,
  createRecoveryJournal,
  createSaveCoordinator,
  createSnapshotWriteGate,
  createVxlProjectEncoder,
  decodeJournalFrames,
  type JournalLimits,
  type RecoveryJournal,
  type SaveCoordinator,
  type SaveOutcome,
} from "@voxel-maker/storage";
import { NodeProjectStorage } from "./node-storage.js";
import type { VoxelWriteCapability } from "@voxel-maker/voxel";
import type { DocumentLimits } from "@voxel-maker/model";

/**
 * Recovery orchestration (plan S5.10/S5.15, ticket #14). `recoverProject`
 * loads the durable snapshot (the project file), scans the ordered journal
 * beside it, replays every complete valid frame through normal command
 * decoding, limits, and invariants, and reports rather than guesses past a
 * corrupt tail. `createRecoverySession` wires a recovered (or freshly
 * opened) document to an append-only recovery journal, a save coordinator,
 * and a fresh bounded user history, preserving the recovery identity across
 * save-as.
 */

export interface RecoveryServices {
  readonly port: NodeProjectStorage;
  readonly projectPath: string;
  readonly registry: CommandRegistry;
  /** Expected recovery session id; when absent, the journal's own id is accepted. */
  readonly expectedSessionId?: RecoverySessionId;
  readonly documentLimits?: DocumentLimits;
  readonly commandLimits?: CommandLimits;
  readonly journalLimits?: Partial<JournalLimits>;
}

/** A corrupt or incompatible journal stop point (never guessed past). */
export interface RecoveryCorruptTail {
  readonly frameIndex: number;
  readonly reason: string;
}

/** Honest report of one recovery attempt. */
export interface RecoveryReport {
  readonly status: "recovered";
  readonly path: string;
  /**
   * Recovery session id of the journal that was replayed; present when a
   * journal exists (or the caller expected one). No id exists for a plain
   * snapshot-only open.
   */
  readonly sessionId?: RecoverySessionId;
  /** Revision of the durable snapshot the recovery started from. */
  readonly snapshotRevision: number;
  /** Semantic hash of that snapshot. */
  readonly snapshotHash: string;
  /** Revision of the restored asset after replay. */
  readonly recoveredRevision: number;
  /**
   * Anchor the next recovery session must use: the journal header base
   * (present when a journal exists). Equals the snapshot anchor unless the
   * snapshot is newer than the journal (confirmed save before truncation),
   * in which case only the journal base keeps appends consistent.
   */
  readonly journalBaseRevision?: number;
  readonly journalBaseSemanticHash?: string;
  readonly replayedFrames: number;
  readonly skippedCoveredFrames: number;
  readonly journalAbsent: boolean;
  /** True when the snapshot was newer than the journal anchor (frames covered). */
  readonly journalSuperseded: boolean;
  /** First corrupt or inconsistent frame; recovery stops there. */
  readonly corruptTail?: RecoveryCorruptTail;
  /** The journal could not be replayed at all (identity/version mismatch). */
  readonly incompatible?: { readonly reason: string };
  /** Recovery always starts a fresh bounded user history (ADR-0003). */
  readonly history: "fresh";
}

/** Mutable builder for the report (internal). */
interface RecoveryReportBuilder {
  status: "recovered";
  path: string;
  sessionId?: RecoverySessionId;
  snapshotRevision: number;
  snapshotHash: string;
  recoveredRevision: number;
  journalBaseRevision?: number;
  journalBaseSemanticHash?: string;
  replayedFrames: number;
  skippedCoveredFrames: number;
  journalAbsent: boolean;
  journalSuperseded: boolean;
  corruptTail?: RecoveryCorruptTail;
  incompatible?: { readonly reason: string };
  history: "fresh";
}

export interface RecoveryOutcome {
  readonly store: DocumentStore;
  readonly writeCapability: VoxelWriteCapability;
  /** Fresh bus with empty undo/redo history (plan S5.15). */
  readonly bus: CommandBus;
  readonly report: RecoveryReport;
}

/**
 * Recovers a project after a process or machine failure: load the durable
 * snapshot, replay complete valid journal frames through normal decoding
 * and invariants, and report rather than guess past a corrupt tail.
 * Throws the structured `readVxlProject`/storage error when the snapshot
 * itself is missing or invalid (a corrupt snapshot is never guessed at).
 */
export async function recoverProject(
  services: RecoveryServices,
): Promise<RecoveryOutcome> {
  const { port, projectPath } = services;
  const snapshotBytes = await port.readProject(projectPath);
  const loaded = readVxlProject(snapshotBytes, {
    ...(services.documentLimits === undefined
      ? {}
      : { documentLimits: services.documentLimits }),
  });
  // The port derives the adjacent journal path from the project path.
  const journalBytes = await port.readJournal(projectPath);

  if (journalBytes === undefined || journalBytes.byteLength === 0) {
    const { store, writeCapability, bus } = installRecovered(services, loaded);
    return {
      store,
      writeCapability,
      bus,
      report: {
        status: "recovered",
        path: projectPath,
        ...(services.expectedSessionId === undefined
          ? {}
          : { sessionId: services.expectedSessionId }),
        snapshotRevision: loaded.document.revision,
        snapshotHash: loaded.semanticHash,
        recoveredRevision: store.revision,
        replayedFrames: 0,
        skippedCoveredFrames: 0,
        journalAbsent: true,
        journalSuperseded: false,
        history: "fresh",
      },
    };
  }

  const journalLimits = services.journalLimits;
  const decoded = decodeJournalFrames(journalBytes, journalLimits);

  const base: RecoveryReportBuilder = {
    status: "recovered",
    path: projectPath,
    ...(services.expectedSessionId === undefined
      ? {}
      : { sessionId: services.expectedSessionId }),
    snapshotRevision: loaded.document.revision,
    snapshotHash: loaded.semanticHash,
    recoveredRevision: loaded.document.revision,
    replayedFrames: 0,
    skippedCoveredFrames: 0,
    journalAbsent: false,
    journalSuperseded: false,
    history: "fresh",
  };

  const header = decoded.header;
  if (header === undefined) {
    return finishRecovery(
      base,
      { ...services, loaded, journalBytes },
      {
        corruptTail: {
          frameIndex: decoded.corruptTail?.frameIndex ?? 0,
          reason: decoded.corruptTail?.reason ?? "missing journal header",
        },
      },
    );
  }
  const sessionId = services.expectedSessionId ?? header.recoverySessionId;
  base.sessionId = sessionId;
  base.journalBaseRevision = header.baseRevision;
  base.journalBaseSemanticHash = header.baseSemanticHash;
  const context: RecoveryServices & RecoveryStart = {
    ...services,
    loaded,
    journalBytes,
  };

  const incompatible = (reason: string): RecoveryOutcome =>
    finishRecovery(base, context, { incompatible: { reason } });
  if (header.recoverySessionId !== sessionId) {
    return incompatible(
      `journal session ${header.recoverySessionId} does not match ${sessionId}`,
    );
  }
  if (header.containerVersion !== VXL_CONTAINER_VERSION) {
    return incompatible(
      `journal container version ${String(header.containerVersion)} is not supported`,
    );
  }
  if (header.documentSchemaVersion !== VXL_DOCUMENT_VERSION) {
    return incompatible(
      `journal document version ${String(header.documentSchemaVersion)} is not supported`,
    );
  }
  if (header.commandEnvelopeVersion !== JOURNAL_COMMAND_ENVELOPE_VERSION) {
    return incompatible(
      `journal command envelope version ${String(header.commandEnvelopeVersion)} is not supported`,
    );
  }

  // Snapshot identity (plan 5.6: "Journals require matching snapshot
  // identity"). A snapshot newer than the journal anchor is a confirmed
  // save that already covers the older frames; frames are then skipped
  // individually instead of being guessed at.
  if (header.baseRevision === loaded.document.revision) {
    if (header.baseSemanticHash !== loaded.semanticHash) {
      return incompatible(
        "journal anchor hash does not match the durable snapshot",
      );
    }
  } else if (header.baseRevision < loaded.document.revision) {
    base.journalSuperseded = true;
  } else {
    return incompatible(
      "journal anchor revision is newer than the durable snapshot",
    );
  }

  const { store, writeCapability, bus } = installRecovered(services, loaded);

  let current = store.revision;
  let replayed = 0;
  let skipped = 0;
  const tail = decoded.corruptTail;
  const frameLimit = tail?.frameIndex ?? decoded.frames.length;
  let corruptTail: RecoveryCorruptTail | undefined =
    tail === undefined
      ? undefined
      : { frameIndex: tail.frameIndex, reason: tail.reason };
  for (let index = 0; index < frameLimit; index += 1) {
    const entry = decoded.frames[index];
    if (entry === undefined) break;
    if (entry.frame.revisionAfter <= current) {
      skipped += 1;
      continue;
    }
    if (entry.frame.revisionBefore !== current) {
      corruptTail = {
        frameIndex: index,
        reason: `revision gap: journal expects ${String(entry.frame.revisionBefore)}, snapshot and prior frames end at ${String(current)}`,
      };
      break;
    }
    let record: ReturnType<typeof parseJournalTransaction>;
    try {
      record = parseJournalTransaction(
        entry.frame.transaction,
        services.commandLimits ?? DEFAULT_COMMAND_LIMITS,
      );
    } catch (error) {
      corruptTail = {
        frameIndex: index,
        reason: `journal transaction cannot be decoded: ${messageOf(error)}`,
      };
      break;
    }
    const result = bus.executeTransaction(record.commands, {
      transactionId: record.transactionId,
      expectedRevision: record.expectedRevision,
      source: record.source,
      ...(record.correlationId === undefined
        ? {}
        : { correlationId: record.correlationId }),
      ...(record.label === undefined ? {} : { label: record.label }),
    });
    if (!result.ok) {
      corruptTail = {
        frameIndex: index,
        reason: `journal transaction failed normal invariants: ${result.error.code}: ${result.error.message}`,
      };
      break;
    }
    if (result.value.revisionAfter !== entry.frame.revisionAfter) {
      corruptTail = {
        frameIndex: index,
        reason:
          "journal transaction advanced to a different revision than its frame",
      };
      break;
    }
    current = result.value.revisionAfter;
    replayed += 1;
  }

  // Issue #65: replay applies recorded revision transitions without
  // pretending to be a fresh user edit (plan 5.4). The replayed frames
  // must not be undoable, so the recovered bus starts a fresh bounded
  // user history; idempotency records survive so a retried transaction id
  // still replays its recorded result (ADR-0003).
  bus.resetHistory();

  const report: RecoveryReport = {
    ...base,
    recoveredRevision: store.revision,
    replayedFrames: replayed,
    skippedCoveredFrames: skipped,
    ...(corruptTail === undefined ? {} : { corruptTail }),
  };
  return { store, writeCapability, bus, report };
}

/**
 * Installs a fully validated load into a fresh store with a fresh bus
 * (plan S5.15: lifecycle replacement; recovered documents start a fresh
 * bounded user history).
 */
function installRecovered(
  services: RecoveryServices,
  loaded: ReturnType<typeof readVxlProject>,
): {
  readonly store: DocumentStore;
  readonly writeCapability: VoxelWriteCapability;
  readonly bus: CommandBus;
} {
  const { store, writeCapability } = createDocumentStoreHandle({
    document: loaded.document,
    volumes: new Map(
      [...loaded.volumes.entries()].map(([id, volume]) => [id, volume.chunks]),
    ),
    ...(services.documentLimits === undefined
      ? {}
      : { limits: services.documentLimits }),
  });
  return {
    store,
    writeCapability,
    bus: new CommandBus(
      store,
      services.registry,
      writeCapability,
      services.commandLimits,
    ),
  };
}

interface RecoveryStart {
  readonly loaded: ReturnType<typeof readVxlProject>;
  readonly journalBytes: Uint8Array;
}

function finishRecovery(
  base: RecoveryReportBuilder,
  services: RecoveryServices & RecoveryStart,
  detail: {
    readonly corruptTail?: RecoveryCorruptTail;
    readonly incompatible?: { readonly reason: string };
  },
): RecoveryOutcome {
  const { store, writeCapability, bus } = installRecovered(
    services,
    services.loaded,
  );
  return {
    store,
    writeCapability,
    bus,
    report: {
      ...base,
      ...(detail.corruptTail === undefined
        ? {}
        : { corruptTail: detail.corruptTail }),
      ...(detail.incompatible === undefined
        ? {}
        : { incompatible: detail.incompatible }),
    },
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface RecoverySessionOptions {
  readonly projectPath: string;
  readonly port: NodeProjectStorage;
  readonly store: DocumentStore;
  readonly writeCapability: VoxelWriteCapability;
  readonly registry: CommandRegistry;
  /** Stable recovery identity; preserved across save-as reassociation. */
  readonly sessionId: RecoverySessionId;
  /** Durable anchor: the snapshot the journal extends (revision R, hash H_R). */
  readonly baseRevision: number;
  readonly baseSemanticHash: string;
  readonly commandLimits?: CommandLimits;
  readonly journalLimits?: Partial<JournalLimits>;
}

/** One wired open document: fresh history bus + journal + save coordinator. */
export interface RecoverySession {
  readonly bus: CommandBus;
  readonly journal: RecoveryJournal;
  readonly saveCoordinator: SaveCoordinator;
  readonly sessionId: RecoverySessionId;
  /** Saves at `path` and resets the journal anchor when the save confirms. */
  save(path: string): Promise<SaveOutcome>;
  /** Save As: reassociates the recovery area, then saves at the new path. */
  saveAs(path: string): Promise<SaveOutcome>;
  dispose(): void;
}

/**
 * Wires one open document to its recovery area (plan S5.15). Every
 * committed transaction is appended to the ordered journal after commit;
 * a journal failure leaves the edit valid and dirty, exposes degraded
 * durability, and schedules retry or snapshot work. A confirmed save at
 * the session path durably installs the replacement snapshot before old
 * journal data is removed (documented cleanup policy).
 */
export function createRecoverySession(
  options: RecoverySessionOptions,
): RecoverySession {
  const { store, port, registry, writeCapability } = options;
  // One shared snapshot-write gate (ticket #51): saves and compaction both
  // replace the project snapshot, so both route their replacements through
  // the same serialization/fencing owner. Without it, a save captured at an
  // older revision can finish after compaction installed a newer snapshot
  // and overwrite it, leaving a stale snapshot beside a newer journal
  // anchor that recovery rejects.
  const snapshotWriteGate = createSnapshotWriteGate(port);
  const journal = createRecoveryJournal({
    projectPath: options.projectPath,
    port,
    sessionId: options.sessionId,
    baseRevision: options.baseRevision,
    baseSemanticHash: options.baseSemanticHash,
    encoder: createVxlProjectEncoder(),
    capture: () => captureRevisionSnapshot(store),
    snapshotWriteGate,
    ...(options.journalLimits === undefined
      ? {}
      : { limits: options.journalLimits }),
  });
  const saveCoordinator = createSaveCoordinator({
    store,
    port,
    encoder: createVxlProjectEncoder(),
    snapshotWriteGate,
  });
  // A freshly opened durable project starts clean (plan S5.14, ticket #22):
  // when the live snapshot still equals the durable base the journal
  // extends, record that base as the last confirmed save so an unchanged
  // same-path save resolves `unchanged` without rewriting the file or
  // creating a backup (issue #66). Replayed state beyond the base stays
  // dirty: the coordinator keeps no durable anchor and the next save
  // writes the recovered state. The caller contract is that the base IS
  // the durable snapshot on disk (recovery/open flows); a session created
  // over a matching but never-written snapshot would no-op its first save.
  const live = captureRevisionSnapshot(store);
  if (
    live.revision === options.baseRevision &&
    live.semanticHash === options.baseSemanticHash
  ) {
    saveCoordinator.markDurable(
      options.baseRevision,
      options.baseSemanticHash,
      options.projectPath,
    );
  }
  const bus = new CommandBus(
    store,
    registry,
    writeCapability,
    options.commandLimits,
    {
      onCommitted(record: CommittedTransactionRecord) {
        // Semantic commit precedes journaling; the append is asynchronous
        // and its failures surface through journal events and isDegraded().
        void journal
          .journal({
            revisionBefore: record.revisionBefore,
            revisionAfter: record.revisionAfter,
            transaction: journalTransactionToJson(record),
          })
          .catch(() => {
            // Failure is reported through the journal's append-failed event.
          });
      },
    },
  );
  let journalPath = options.projectPath;
  return {
    bus,
    journal,
    saveCoordinator,
    sessionId: options.sessionId,
    async save(path: string): Promise<SaveOutcome> {
      const outcome = await saveCoordinator.save(path);
      if (outcome.status === "saved" && path === journalPath) {
        // Confirmed-save cleanup: the snapshot now covers every frame up to
        // the saved revision; reset the anchor and drop covered frames.
        // Cleanup is best-effort: a failure leaves the journal intact and
        // recovery stays correct (covered frames are skipped on replay).
        await journal
          .resetBase(outcome.revision, outcome.semanticHash)
          .catch(() => {});
      }
      return outcome;
    },
    async saveAs(path: string): Promise<SaveOutcome> {
      await journal.reassociate(path);
      journalPath = path;
      return this.save(path);
    },
    dispose() {
      journal.dispose();
      saveCoordinator.dispose();
      snapshotWriteGate.dispose();
    },
  };
}
