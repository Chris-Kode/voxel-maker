import type { VolumeId } from "@voxel-maker/shared";
import {
  CommandBus,
  CommandRegistry,
  DEFAULT_COMMAND_LIMITS,
  parseJournalTransaction,
  type CommandLimits,
} from "@voxel-maker/commands";
import { createDocumentStore } from "@voxel-maker/document";
import type { readVxlProject } from "@voxel-maker/formats";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";
import type { DecodedJournal } from "@voxel-maker/storage";
import type { DocumentLimits } from "@voxel-maker/model";
import type { RecoveryCorruptTail } from "./recovery.js";

/**
 * Journal replay for the desktop recovery orchestrator (plan S5.10,
 * ticket #14/#22): installs the durable snapshot into a fresh store,
 * replays every complete valid frame through normal command decoding,
 * limits, and invariants, and reports rather than guesses past a corrupt
 * tail. The replay store is a scratch projection of the recovery; the
 * final replayed document is reinstalled through `DocumentSession` by the
 * caller, so the recovered document always starts a fresh bounded user
 * history (ADR-0003).
 */

export interface ReplayOutcome {
  readonly document: ReturnType<typeof readVxlProject>["document"];
  readonly volumes: Map<VolumeId, readonly VoxelChunkSeed[]>;
  readonly revision: number;
  readonly replayedFrames: number;
  readonly skippedCoveredFrames: number;
  readonly corruptTail?: RecoveryCorruptTail;
}

export interface ReplayServices {
  readonly loaded: ReturnType<typeof readVxlProject>;
  readonly decoded: DecodedJournal;
  readonly registry: CommandRegistry;
  readonly commandLimits?: CommandLimits;
  readonly documentLimits?: DocumentLimits;
}

/**
 * Replays complete valid frames onto a scratch store. Frames already
 * covered by a newer snapshot are skipped; the first inconsistent,
 * undecodable, or invariant-failing frame stops the replay and is reported
 * as a corrupt tail. Never guesses past the stop point.
 */
export function replayJournalFrames(services: ReplayServices): ReplayOutcome {
  const { loaded, decoded } = services;
  const { store, writeCapability } = createDocumentStore({
    document: loaded.document,
    volumes: new Map(
      [...loaded.volumes.entries()].map(([id, volume]) => [id, volume.chunks]),
    ),
    ...(services.documentLimits === undefined
      ? {}
      : { limits: services.documentLimits }),
  });
  const bus = new CommandBus(
    store,
    services.registry,
    writeCapability,
    services.commandLimits ?? DEFAULT_COMMAND_LIMITS,
  );
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

  const document = store.getDocument();
  const volumes = new Map<VolumeId, readonly VoxelChunkSeed[]>();
  for (const volume of loaded.volumes.values()) {
    const view = store.getVolume(volume.volumeId);
    if (view === undefined) continue;
    const seeds: VoxelChunkSeed[] = [];
    for (const coordinate of view.chunkCoordinates()) {
      const values = view.getChunk(coordinate);
      if (values !== undefined) seeds.push({ coordinate, values });
    }
    volumes.set(volume.volumeId, seeds);
  }
  return {
    document,
    volumes,
    revision: store.revision,
    replayedFrames: replayed,
    skippedCoveredFrames: skipped,
    ...(corruptTail === undefined ? {} : { corruptTail }),
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
