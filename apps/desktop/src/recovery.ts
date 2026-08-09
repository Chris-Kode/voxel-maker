import type { RecoverySessionId, VolumeId } from "@voxel-maker/shared";
import {
  CommandRegistry,
  JOURNAL_COMMAND_ENVELOPE_VERSION,
  type CommandLimits,
} from "@voxel-maker/commands";
import {
  readVxlProject,
  VXL_CONTAINER_VERSION,
  VXL_DOCUMENT_VERSION,
} from "@voxel-maker/formats";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";
import {
  decodeJournalFrames,
  type JournalLimits,
  type ProjectStoragePort,
  type RecoveryJournalPort,
} from "@voxel-maker/storage";
import type { DocumentLimits } from "@voxel-maker/model";
import { replayJournalFrames } from "./replay.js";

/**
 * Recovery orchestration of the desktop shell (plan S5.10/S5.15, ticket
 * #14/#22). `recoverProjectFromPorts` loads the durable snapshot (the
 * project file), scans the ordered journal beside it, replays every
 * complete valid frame through normal command decoding, limits, and
 * invariants, and reports rather than guesses past a corrupt tail. Unlike
 * the headless trace (`apps/headless/src/recovery.ts`) it works against
 * the injected storage ports and returns a fully validated install input
 * for `DocumentSession` — the session stays the only owner that installs
 * aggregates, and the recovered document starts a fresh bounded user
 * history (ADR-0003).
 */

/** The port pair one project file owns (project + adjacent journal). */
export type ProjectPorts = ProjectStoragePort & RecoveryJournalPort;

/** A corrupt or incompatible journal stop point (never guessed past). */
export interface RecoveryCorruptTail {
  readonly frameIndex: number;
  readonly reason: string;
}

/** Honest report of one desktop recovery attempt. */
export interface RecoveryReport {
  readonly status: "recovered";
  readonly path: string;
  /**
   * Recovery session id of the journal that was replayed; present when a
   * journal exists (or the caller expected one).
   */
  readonly sessionId?: RecoverySessionId;
  /** Revision of the durable snapshot the recovery started from. */
  readonly snapshotRevision: number;
  /** Semantic hash of that snapshot. */
  readonly snapshotHash: string;
  /** Revision of the restored asset after replay. */
  readonly recoveredRevision: number;
  /**
   * Anchor the next recovery session must use: the journal header base.
   * Present when a journal exists.
   */
  readonly journalBaseRevision?: number;
  readonly journalBaseSemanticHash?: string;
  readonly replayedFrames: number;
  readonly skippedCoveredFrames: number;
  readonly journalAbsent: boolean;
  /** True when the snapshot was newer than the journal anchor. */
  readonly journalSuperseded: boolean;
  /** First corrupt or inconsistent frame; recovery stops there. */
  readonly corruptTail?: RecoveryCorruptTail;
  /** The journal could not be replayed at all (identity/version mismatch). */
  readonly incompatible?: { readonly reason: string };
}

/**
 * A recovery outcome ready for validated lifecycle install: the replayed
 * document plus chunk seeds (both already validated by `readVxlProject`
 * and the replay store) and the honest report.
 */
export interface RecoveredProjectInput {
  readonly document: ReturnType<typeof readVxlProject>["document"];
  readonly volumes: Map<VolumeId, readonly VoxelChunkSeed[]>;
  readonly report: RecoveryReport;
}

export interface RecoveryServices {
  readonly port: ProjectPorts;
  readonly projectPath: string;
  /** Registered commands used to replay journal frames (S4.15). */
  readonly registry: CommandRegistry;
  /** Expected recovery session id; when absent, the journal's own is used. */
  readonly expectedSessionId?: RecoverySessionId;
  readonly documentLimits?: DocumentLimits;
  readonly commandLimits?: CommandLimits;
  readonly journalLimits?: Partial<JournalLimits>;
}

/**
 * Recovers a project after a process or machine failure: load the durable
 * snapshot, replay complete valid journal frames through normal decoding
 * and invariants, and report rather than guess past a corrupt tail.
 * Throws the structured `readVxlProject`/storage error when the snapshot
 * itself is missing or invalid (a corrupt snapshot is never guessed at).
 * A plain open with no journal resolves the same shape with
 * `journalAbsent: true`.
 */
export async function recoverProjectFromPorts(
  services: RecoveryServices,
): Promise<RecoveredProjectInput> {
  const { port, projectPath } = services;
  const snapshotBytes = await port.readProject(projectPath);
  const loaded = readVxlProject(snapshotBytes, {
    ...(services.documentLimits === undefined
      ? {}
      : { documentLimits: services.documentLimits }),
  });
  const journalBytes = await port.readJournal(projectPath);
  const volumes = new Map<VolumeId, readonly VoxelChunkSeed[]>();
  for (const volume of loaded.volumes.values()) {
    volumes.set(volume.volumeId, volume.chunks);
  }

  let report: RecoveryReport = {
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
    journalAbsent: true,
    journalSuperseded: false,
  };

  if (journalBytes === undefined || journalBytes.byteLength === 0) {
    return { document: loaded.document, volumes, report };
  }
  report = { ...report, journalAbsent: false };

  const decoded = decodeJournalFrames(journalBytes, services.journalLimits);
  const header = decoded.header;
  if (header === undefined) {
    return {
      document: loaded.document,
      volumes,
      report: {
        ...report,
        corruptTail: {
          frameIndex: decoded.corruptTail?.frameIndex ?? 0,
          reason: decoded.corruptTail?.reason ?? "missing journal header",
        },
      },
    };
  }
  const sessionId = services.expectedSessionId ?? header.recoverySessionId;
  report = {
    ...report,
    sessionId,
    journalBaseRevision: header.baseRevision,
    journalBaseSemanticHash: header.baseSemanticHash,
  };

  const incompatible = (reason: string): RecoveryReport => ({
    ...report,
    incompatible: { reason },
  });
  if (header.recoverySessionId !== sessionId) {
    return {
      document: loaded.document,
      volumes,
      report: incompatible(
        `journal session ${header.recoverySessionId} does not match ${sessionId}`,
      ),
    };
  }
  if (header.containerVersion !== VXL_CONTAINER_VERSION) {
    return {
      document: loaded.document,
      volumes,
      report: incompatible(
        `journal container version ${String(header.containerVersion)} is not supported`,
      ),
    };
  }
  if (header.documentSchemaVersion !== VXL_DOCUMENT_VERSION) {
    return {
      document: loaded.document,
      volumes,
      report: incompatible(
        `journal document version ${String(header.documentSchemaVersion)} is not supported`,
      ),
    };
  }
  if (header.commandEnvelopeVersion !== JOURNAL_COMMAND_ENVELOPE_VERSION) {
    return {
      document: loaded.document,
      volumes,
      report: incompatible(
        `journal command envelope version ${String(header.commandEnvelopeVersion)} is not supported`,
      ),
    };
  }

  // Snapshot identity (plan 5.6): a snapshot newer than the journal anchor
  // is a confirmed save that already covers the older frames; those frames
  // are skipped individually instead of being guessed at.
  if (header.baseRevision === loaded.document.revision) {
    if (header.baseSemanticHash !== loaded.semanticHash) {
      return {
        document: loaded.document,
        volumes,
        report: incompatible(
          "journal anchor hash does not match the durable snapshot",
        ),
      };
    }
  } else if (header.baseRevision < loaded.document.revision) {
    report = { ...report, journalSuperseded: true };
  } else {
    return {
      document: loaded.document,
      volumes,
      report: incompatible(
        "journal anchor revision is newer than the durable snapshot",
      ),
    };
  }

  const replayed = replayJournalFrames({
    loaded,
    decoded,
    registry: services.registry,
    ...(services.commandLimits === undefined
      ? {}
      : { commandLimits: services.commandLimits }),
    ...(services.documentLimits === undefined
      ? {}
      : { documentLimits: services.documentLimits }),
  });
  return {
    document: replayed.document,
    volumes: replayed.volumes,
    report: {
      ...report,
      recoveredRevision: replayed.revision,
      replayedFrames: replayed.replayedFrames,
      skippedCoveredFrames: replayed.skippedCoveredFrames,
      ...(replayed.corruptTail === undefined
        ? {}
        : { corruptTail: replayed.corruptTail }),
    },
  };
}
