import {
  WorkspaceError,
  volumeId,
  type CommandId,
  type VolumeId,
} from "@voxel-maker/shared";
import { canonicalIntAabb, type IntAabb, type Vec3i } from "@voxel-maker/math";
import type { DocumentLimits, VoxelDocument } from "@voxel-maker/model";
import {
  CHUNK_EDGE,
  MAX_VOXELS_PER_OPERATION,
  type VoxelChangeSet,
  type VoxelEntry,
} from "@voxel-maker/voxel";
import {
  isRecord,
  missingVolume,
  parseName,
  parseRegion,
  parseVolumeId,
} from "./parse-helpers.js";
import type { Command } from "./types.js";
import type {
  CommandExecution,
  CommandExecutionContext,
  CommandHandler,
  CommandValidationContext,
  InverseCommand,
  MutableDocument,
} from "./registry.js";
import { CommandRegistry } from "./registry.js";
import {
  decodeVolumeEntries,
  encodeVolumeEntries,
  type VolumeEntriesPayload,
} from "./volume-payload.js";
import { patchesInverse } from "./batch-commands.js";
import { nodesReferencingVolume } from "./voxel-commands.js";

export const VOLUME_CREATE_COMMAND = "volume.create" as const;
export const VOLUME_DELETE_COMMAND = "volume.delete" as const;
export const VOLUME_COMMAND_SCHEMA_VERSION = 1;

/**
 * Payload of `volume.create` (ticket #24). The first `volume.create` for a
 * volume inside one transaction creates the volume (and its descriptor) and
 * applies any carried entries; later `volume.create` commands for the same
 * volume in the same transaction append entries to the staged volume. This
 * lets a large import split its voxel stream across several commands while
 * every command payload stays within the per-command byte budget.
 */
export interface CreateVolumePayload {
  readonly volumeId: VolumeId;
  /** Descriptor name; applied on the first creation of the volume. */
  readonly name?: string;
  /** Half-open descriptor bounds; applied on the first creation. */
  readonly bounds?: IntAabb;
  /** Compact binary entries; absent creates an empty volume. */
  readonly entries?: VolumeEntriesPayload;
}

export interface DeleteVolumePayload {
  readonly volumeId: VolumeId;
}

/** Constructor input; entries are encoded into the compact payload. */
export interface CreateVolumeInput {
  readonly volumeId: VolumeId;
  readonly name?: string;
  readonly bounds?: IntAabb;
  readonly entries?: readonly VoxelEntry[];
}

/** Canonicalizing constructor for a `volume.create` command. */
export function createVolumeCommand(
  id: CommandId,
  payload: CreateVolumeInput,
): Command<typeof VOLUME_CREATE_COMMAND, CreateVolumePayload> {
  return {
    id,
    type: VOLUME_CREATE_COMMAND,
    schemaVersion: VOLUME_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.bounds !== undefined
        ? { bounds: canonicalIntAabb(payload.bounds) }
        : {}),
      ...(payload.entries !== undefined
        ? { entries: encodeVolumeEntries(payload.entries) }
        : {}),
    },
  };
}

/** Canonicalizing constructor for a `volume.delete` command. */
export function deleteVolumeCommand(
  id: CommandId,
  payload: DeleteVolumePayload,
): Command<typeof VOLUME_DELETE_COMMAND, DeleteVolumePayload> {
  return {
    id,
    type: VOLUME_DELETE_COMMAND,
    schemaVersion: VOLUME_COMMAND_SCHEMA_VERSION,
    payload: { volumeId: volumeId(payload.volumeId) },
  };
}

function parseCreatePayload(
  payload: unknown,
  limits: DocumentLimits,
): CreateVolumePayload {
  if (!isRecord(payload)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a payload object",
      path: ["payload"],
    });
  }
  return {
    volumeId: parseVolumeId(payload.volumeId, ["payload", "volumeId"]),
    ...(payload.name !== undefined
      ? { name: parseName(payload.name, limits, ["payload", "name"]) }
      : {}),
    ...(payload.bounds !== undefined
      ? { bounds: parseRegion(payload.bounds, limits, ["payload", "bounds"]) }
      : {}),
    ...(payload.entries !== undefined
      ? { entries: payload.entries as VolumeEntriesPayload }
      : {}),
  };
}

function parseEntries(
  payload: CreateVolumePayload,
  path: readonly (string | number)[],
): readonly VoxelEntry[] {
  if (payload.entries === undefined) return [];
  return decodeVolumeEntries(payload.entries, path);
}

/** True when two half-open bounds are equal. */
const boundsEqual = (a: IntAabb, b: IntAabb): boolean =>
  a.min[0] === b.min[0] &&
  a.min[1] === b.min[1] &&
  a.min[2] === b.min[2] &&
  a.max[0] === b.max[0] &&
  a.max[1] === b.max[1] &&
  a.max[2] === b.max[2];

/**
 * True when the payload would re-create an existing volume with an
 * identical descriptor and no entries: the desired end state already holds,
 * so the command commits as a no-op (plan 4.1 no-op policy).
 */
function isIdenticalRecreate(
  payload: CreateVolumePayload,
  descriptor: { readonly name?: string; readonly bounds?: IntAabb },
): boolean {
  if (payload.entries !== undefined) return false;
  if ((payload.name ?? undefined) !== (descriptor.name ?? undefined))
    return false;
  if (payload.bounds === undefined || descriptor.bounds === undefined) {
    return payload.bounds === undefined && descriptor.bounds === undefined;
  }
  return boundsEqual(payload.bounds, descriptor.bounds);
}

/** Parses the raw entries field, validating its record shape first. */
function parseRawEntries(
  value: unknown,
  path: readonly (string | number)[],
): readonly VoxelEntry[] {
  if (!isRecord(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected an entries payload object",
      path,
    });
  }
  return decodeVolumeEntries(value, path);
}

const createVolumeHandler: CommandHandler<
  typeof VOLUME_CREATE_COMMAND,
  CreateVolumePayload
> = {
  type: VOLUME_CREATE_COMMAND,
  schemaVersion: VOLUME_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): CreateVolumePayload {
    const parsed = parseCreatePayload(payload, limits);
    // Decode (and thereby bound) the entries during parse so an oversized or
    // malformed payload fails before validation or any staging.
    if (parsed.entries !== undefined) {
      parseRawEntries(parsed.entries, ["payload", "entries"]);
    }
    return parsed;
  },
  validate(
    payload: CreateVolumePayload,
    context: CommandValidationContext,
  ): void {
    const committed = context.committedDocument;
    const existing = committed.volumes[payload.volumeId];
    if (existing !== undefined) {
      // Re-creating a volume that already exists with an identical record
      // and no entries is a no-op commit (the desired end state already
      // holds), matching the node no-op policy; anything else is a
      // duplicate error.
      if (isIdenticalRecreate(payload, existing)) return;
      throw new WorkspaceError({
        family: "validation",
        code: "DUPLICATE_VOLUME_ID",
        message: "Volume already exists in the document",
        context: { volumeId: payload.volumeId },
      });
    }
    if (context.isVolumeStaged(payload.volumeId)) {
      // Append mode: a previous `volume.create` in this transaction staged
      // the volume; only entries may be added.
      if (payload.entries === undefined) {
        throw new WorkspaceError({
          family: "validation",
          code: "EMPTY_VOLUME_APPEND",
          message:
            "A volume staged in this transaction requires entries to append",
          context: { volumeId: payload.volumeId },
        });
      }
    } else if (payload.entries !== undefined) {
      for (const entry of parseEntries(payload, ["payload", "entries"])) {
        if (context.document.materials[entry.material] === undefined) {
          throw new WorkspaceError({
            family: "validation",
            code: "MISSING_MATERIAL",
            message: "Material is not defined in the document",
            context: { material: String(entry.material) },
          });
        }
      }
    }
  },
  execute(
    payload: CreateVolumePayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const entries = parseEntries(payload, ["payload", "entries"]);
    const materialIds = [...new Set(entries.map((entry) => entry.material))];
    const committed = context.committedDocument;
    const existingDescriptor = committed.volumes[payload.volumeId];
    if (existingDescriptor !== undefined) {
      // No-op: an identical record was already committed (validation
      // guarantees this is the only executable committed-existing case).
      return {
        inverse: {
          type: VOLUME_CREATE_COMMAND,
          schemaVersion: VOLUME_COMMAND_SCHEMA_VERSION,
          payload,
        },
        changedRecords: false,
        declaredAffectedResources: {
          nodeIds: [],
          materialIds: [],
          animationIds: [],
          volumeIds: [payload.volumeId],
        },
      };
    }
    if (context.isVolumeStaged(payload.volumeId)) {
      // Append: the volume was staged by an earlier command in this
      // transaction. Descriptor fields were applied then; only entries are
      // applied now.
      const stagedVolume = context.stageVolume(payload.volumeId);
      if (stagedVolume === undefined) throw missingVolume(payload.volumeId);
      const changeSet = stagedVolume.setVoxels(
        entries,
        context.writeCapability,
      );
      return {
        changeSet,
        inverse: patchesInverse(changeSet),
        declaredAffectedResources: {
          nodeIds: [],
          materialIds,
          animationIds: [],
          volumeIds: [payload.volumeId],
        },
      };
    }
    const volume = context.stageNewVolume(payload.volumeId);
    const document = context.stageDocument();
    document.volumes[payload.volumeId] = {
      volumeId: payload.volumeId,
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.bounds !== undefined ? { bounds: payload.bounds } : {}),
    };
    let changeSet: VoxelChangeSet | undefined;
    if (entries.length > 0) {
      changeSet = volume.setVoxels(entries, context.writeCapability);
    }
    const inverse: InverseCommand = {
      type: VOLUME_DELETE_COMMAND,
      schemaVersion: VOLUME_COMMAND_SCHEMA_VERSION,
      payload: { volumeId: payload.volumeId },
    };
    return {
      ...(changeSet === undefined ? {} : { changeSet }),
      changedRecords: true,
      inverse,
      declaredAffectedResources: {
        nodeIds: [],
        materialIds,
        animationIds: [],
        volumeIds: [payload.volumeId],
      },
    };
  },
};

/**
 * Reads every occupied voxel of a volume as entries (bounded by the volume
 * occupancy limit). Used by `volume.delete` to build its exact `volume.create`
 * inverse.
 */
export function readVolumeEntries(
  volume: import("@voxel-maker/voxel").VoxelVolumeReadView,
): VoxelEntry[] {
  const entries: VoxelEntry[] = [];
  for (const coordinate of volume.chunkCoordinates()) {
    const chunk = volume.getChunk(coordinate);
    if (chunk === undefined) continue;
    for (let index = 0; index < chunk.length; index += 1) {
      const material = chunk[index] as number;
      if (material === 0) continue;
      const local: Vec3i = [
        index % CHUNK_EDGE,
        Math.floor(index / CHUNK_EDGE) % CHUNK_EDGE,
        Math.floor(index / (CHUNK_EDGE * CHUNK_EDGE)),
      ];
      entries.push({
        coordinate: [
          coordinate[0] * CHUNK_EDGE + local[0],
          coordinate[1] * CHUNK_EDGE + local[1],
          coordinate[2] * CHUNK_EDGE + local[2],
        ],
        material: material as VoxelEntry["material"],
      });
    }
  }
  return entries;
}

const deleteVolumeHandler: CommandHandler<
  typeof VOLUME_DELETE_COMMAND,
  DeleteVolumePayload
> = {
  type: VOLUME_DELETE_COMMAND,
  schemaVersion: VOLUME_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown): DeleteVolumePayload {
    if (!isRecord(payload)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a payload object",
        path: ["payload"],
      });
    }
    return {
      volumeId: parseVolumeId(payload.volumeId, ["payload", "volumeId"]),
    };
  },
  validate(
    payload: DeleteVolumePayload,
    context: CommandValidationContext,
  ): void {
    if (context.committedDocument.volumes[payload.volumeId] === undefined) {
      // Deleting a volume that is already absent is a no-op commit (the
      // desired end state already holds), matching the node/voxel no-op
      // policy (plan 4.1).
      return;
    }
    if (nodesReferencingVolume(context.document, payload.volumeId).length > 0) {
      throw new WorkspaceError({
        family: "validation",
        code: "VOLUME_IN_USE",
        message:
          "Volume is referenced by a node; remove the node before deleting the volume",
        context: { volumeId: payload.volumeId },
      });
    }
  },
  execute(
    payload: DeleteVolumePayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const committed = context.committedDocument;
    const descriptor = committed.volumes[payload.volumeId];
    if (descriptor === undefined) {
      // No-op: the volume is already absent; the inverse replays the same
      // delete and remains a no-op.
      return {
        inverse: {
          type: VOLUME_DELETE_COMMAND,
          schemaVersion: VOLUME_COMMAND_SCHEMA_VERSION,
          payload: { volumeId: payload.volumeId },
        },
        changedRecords: false,
        declaredAffectedResources: {
          nodeIds: [],
          materialIds: [],
          animationIds: [],
          volumeIds: [payload.volumeId],
        },
      };
    }
    const volume = context.getVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const entries = readVolumeEntries(volume);
    if (entries.length > MAX_VOXELS_PER_OPERATION) {
      throw new WorkspaceError({
        family: "limit",
        code: "TOO_MANY_VOXELS",
        message: "Volume exceeds the per-operation voxel limit for deletion",
        context: { limit: MAX_VOXELS_PER_OPERATION },
      });
    }
    const inverse: InverseCommand = {
      type: VOLUME_CREATE_COMMAND,
      schemaVersion: VOLUME_COMMAND_SCHEMA_VERSION,
      payload: {
        volumeId: payload.volumeId,
        ...(descriptor.name !== undefined ? { name: descriptor.name } : {}),
        ...(descriptor.bounds !== undefined
          ? { bounds: descriptor.bounds }
          : {}),
        ...(entries.length > 0
          ? { entries: encodeVolumeEntries(entries) }
          : {}),
      },
    };
    context.stageRemoveVolume(payload.volumeId);
    const document = context.stageDocument();
    document.volumes = Object.fromEntries(
      Object.entries(document.volumes).filter(
        ([id]) => id !== payload.volumeId,
      ),
    ) as MutableDocument["volumes"];
    return {
      changedRecords: true,
      inverse,
      declaredAffectedResources: {
        nodeIds: nodesReferencingVolume(committed, payload.volumeId),
        materialIds: [],
        animationIds: [],
        volumeIds: [payload.volumeId],
      },
    };
  },
};

/** Registers the generic volume lifecycle commands. */
export function registerVolumeCommands(registry: CommandRegistry): void {
  registry.register(createVolumeHandler);
  registry.register(deleteVolumeHandler);
}

/** Stable resource helper for volume commands (plan 4.16). */
export function volumeResources(
  document: VoxelDocument,
  volumeId: VolumeId,
): CommandExecution["declaredAffectedResources"] {
  return {
    nodeIds: nodesReferencingVolume(document, volumeId),
    materialIds: [],
    animationIds: [],
    volumeIds: [volumeId],
  };
}
