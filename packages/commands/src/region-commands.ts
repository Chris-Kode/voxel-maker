import {
  WorkspaceError,
  volumeId,
  type CommandId,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  canonicalIntAabb,
  canonicalVec3i,
  type IntAabb,
  type Vec3i,
} from "@voxel-maker/math";
import type { DocumentLimits, VoxelDocument } from "@voxel-maker/model";
import {
  assertExactRotationRegion,
  type QuarterTurns,
  type ShapeAxis,
  type VoxelChangeSet,
} from "@voxel-maker/voxel";
import {
  isRecord,
  missingVolume,
  parseAxis,
  parseCoordinate,
  parseDelta,
  parseRegion,
  parseVolumeId,
} from "./parse-helpers.js";
import type { Command } from "./types.js";
import type {
  CommandExecution,
  CommandExecutionContext,
  CommandHandler,
  CommandValidationContext,
} from "./registry.js";
import { CommandRegistry } from "./registry.js";
import { VOXEL_COMMAND_SCHEMA_VERSION } from "./voxel-commands.js";
import { affectedResources, patchesInverse } from "./batch-commands.js";

export const VOXEL_COPY_REGION_COMMAND = "voxel.copyRegion" as const;
export const VOXEL_DELETE_REGION_COMMAND = "voxel.deleteRegion" as const;
export const VOXEL_TRANSLATE_REGION_COMMAND = "voxel.translateRegion" as const;
export const VOXEL_ROTATE_REGION_COMMAND = "voxel.rotateRegion" as const;
export const VOXEL_MIRROR_REGION_COMMAND = "voxel.mirrorRegion" as const;

export interface CopyRegionPayload {
  readonly volumeId: VolumeId;
  /** Half-open source region. */
  readonly source: IntAabb;
  /** Min corner of the destination AABB (source translated to this anchor). */
  readonly destination: Vec3i;
}

export interface DeleteRegionPayload {
  readonly volumeId: VolumeId;
  /** Half-open region to clear. */
  readonly region: IntAabb;
}

export interface TranslateRegionPayload {
  readonly volumeId: VolumeId;
  /** Half-open source region. */
  readonly region: IntAabb;
  /** Integer translation delta. */
  readonly delta: Vec3i;
}

export interface RotateRegionPayload {
  readonly volumeId: VolumeId;
  /** Half-open region rotated around its center. */
  readonly region: IntAabb;
  /** Rotation axis. */
  readonly axis: ShapeAxis;
  /** Exact 90-degree increments: 1, 2, or 3. */
  readonly quarterTurns: QuarterTurns;
}

export interface MirrorRegionPayload {
  readonly volumeId: VolumeId;
  /** Half-open region mirrored across its center plane. */
  readonly region: IntAabb;
  /** Axis perpendicular to the mirror plane. */
  readonly axis: ShapeAxis;
}

/** Canonicalizing constructor for a `voxel.copyRegion` command. */
export function copyRegionCommand(
  id: CommandId,
  payload: CopyRegionPayload,
): Command<typeof VOXEL_COPY_REGION_COMMAND, CopyRegionPayload> {
  return {
    id,
    type: VOXEL_COPY_REGION_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      source: canonicalIntAabb(payload.source),
      destination: canonicalVec3i(payload.destination),
    },
  };
}

/** Canonicalizing constructor for a `voxel.deleteRegion` command. */
export function deleteRegionCommand(
  id: CommandId,
  payload: DeleteRegionPayload,
): Command<typeof VOXEL_DELETE_REGION_COMMAND, DeleteRegionPayload> {
  return {
    id,
    type: VOXEL_DELETE_REGION_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      region: canonicalIntAabb(payload.region),
    },
  };
}

/** Canonicalizing constructor for a `voxel.translateRegion` command. */
export function translateRegionCommand(
  id: CommandId,
  payload: TranslateRegionPayload,
): Command<typeof VOXEL_TRANSLATE_REGION_COMMAND, TranslateRegionPayload> {
  return {
    id,
    type: VOXEL_TRANSLATE_REGION_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      region: canonicalIntAabb(payload.region),
      delta: canonicalVec3i(payload.delta),
    },
  };
}

/** Canonicalizing constructor for a `voxel.rotateRegion` command. */
export function rotateRegionCommand(
  id: CommandId,
  payload: RotateRegionPayload,
): Command<typeof VOXEL_ROTATE_REGION_COMMAND, RotateRegionPayload> {
  const region = canonicalIntAabb(payload.region);
  const axis = parseAxis(payload.axis);
  const quarterTurns = parseQuarterTurns(payload.quarterTurns);
  assertExactRotationRegion(region, axis, quarterTurns);
  return {
    id,
    type: VOXEL_ROTATE_REGION_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      region,
      axis,
      quarterTurns,
    },
  };
}

/** Canonicalizing constructor for a `voxel.mirrorRegion` command. */
export function mirrorRegionCommand(
  id: CommandId,
  payload: MirrorRegionPayload,
): Command<typeof VOXEL_MIRROR_REGION_COMMAND, MirrorRegionPayload> {
  return {
    id,
    type: VOXEL_MIRROR_REGION_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      region: canonicalIntAabb(payload.region),
      axis: parseAxis(payload.axis),
    },
  };
}

function parseQuarterTurns(value: unknown): QuarterTurns {
  if (value !== 1 && value !== 2 && value !== 3) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_QUARTER_TURNS",
      message: "quarterTurns must be 1, 2, or 3 (exact 90-degree increments)",
      context: { value: String(value) },
    });
  }
  return value;
}

/** Materials referenced by a change set (old and new non-empty values). */
function materialsFromChangeSet(changeSet: VoxelChangeSet): MaterialId[] {
  const materials = new Set<number>();
  for (const chunk of changeSet.chunks) {
    for (const patch of chunk.patches) {
      if (patch.oldValue !== 0) materials.add(patch.oldValue);
      if (patch.newValue !== 0) materials.add(patch.newValue);
    }
  }
  return [...materials] as MaterialId[];
}

function regionExecution(
  changeSet: VoxelChangeSet,
  document: VoxelDocument,
  volumeId: VolumeId,
): CommandExecution {
  return {
    changeSet,
    inverse: patchesInverse(changeSet),
    declaredAffectedResources: affectedResources(
      document,
      volumeId,
      materialsFromChangeSet(changeSet),
    ),
  };
}

const copyRegionHandler: CommandHandler<
  typeof VOXEL_COPY_REGION_COMMAND,
  CopyRegionPayload
> = {
  type: VOXEL_COPY_REGION_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): CopyRegionPayload {
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
      source: parseRegion(payload.source, limits, ["payload", "source"]),
      destination: parseCoordinate(payload.destination, limits, [
        "payload",
        "destination",
      ]),
    };
  },
  validate(
    payload: CopyRegionPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
  },
  execute(
    payload: CopyRegionPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const changeSet = volume.copyRegion(
      payload.source,
      payload.destination,
      context.writeCapability,
    );
    return regionExecution(changeSet, context.document, payload.volumeId);
  },
};

const deleteRegionHandler: CommandHandler<
  typeof VOXEL_DELETE_REGION_COMMAND,
  DeleteRegionPayload
> = {
  type: VOXEL_DELETE_REGION_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): DeleteRegionPayload {
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
      region: parseRegion(payload.region, limits, ["payload", "region"]),
    };
  },
  validate(
    payload: DeleteRegionPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
  },
  execute(
    payload: DeleteRegionPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const changeSet = volume.deleteRegion(
      payload.region,
      context.writeCapability,
    );
    return regionExecution(changeSet, context.document, payload.volumeId);
  },
};

const translateRegionHandler: CommandHandler<
  typeof VOXEL_TRANSLATE_REGION_COMMAND,
  TranslateRegionPayload
> = {
  type: VOXEL_TRANSLATE_REGION_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): TranslateRegionPayload {
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
      region: parseRegion(payload.region, limits, ["payload", "region"]),
      delta: parseDelta(payload.delta, limits, ["payload", "delta"]),
    };
  },
  validate(
    payload: TranslateRegionPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
  },
  execute(
    payload: TranslateRegionPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const changeSet = volume.translateRegion(
      payload.region,
      payload.delta,
      context.writeCapability,
    );
    return regionExecution(changeSet, context.document, payload.volumeId);
  },
};

const rotateRegionHandler: CommandHandler<
  typeof VOXEL_ROTATE_REGION_COMMAND,
  RotateRegionPayload
> = {
  type: VOXEL_ROTATE_REGION_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): RotateRegionPayload {
    if (!isRecord(payload)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a payload object",
        path: ["payload"],
      });
    }
    const region = parseRegion(payload.region, limits, ["payload", "region"]);
    const axis = parseAxis(payload.axis, ["payload", "axis"]);
    const quarterTurns = parseQuarterTurns(payload.quarterTurns);
    // Exact lattice rotation is a parse-time constraint: a region whose
    // rotation-plane extents have different parities cannot be rotated
    // exactly around its center (resampling is deferred in v1).
    assertExactRotationRegion(region, axis, quarterTurns, [
      "payload",
      "region",
    ]);
    return {
      volumeId: parseVolumeId(payload.volumeId, ["payload", "volumeId"]),
      region,
      axis,
      quarterTurns,
    };
  },
  validate(
    payload: RotateRegionPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
  },
  execute(
    payload: RotateRegionPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const changeSet = volume.rotateRegion(
      payload.region,
      payload.axis,
      payload.quarterTurns,
      context.writeCapability,
    );
    return regionExecution(changeSet, context.document, payload.volumeId);
  },
};

const mirrorRegionHandler: CommandHandler<
  typeof VOXEL_MIRROR_REGION_COMMAND,
  MirrorRegionPayload
> = {
  type: VOXEL_MIRROR_REGION_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): MirrorRegionPayload {
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
      region: parseRegion(payload.region, limits, ["payload", "region"]),
      axis: parseAxis(payload.axis, ["payload", "axis"]),
    };
  },
  validate(
    payload: MirrorRegionPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
  },
  execute(
    payload: MirrorRegionPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const changeSet = volume.mirrorRegion(
      payload.region,
      payload.axis,
      context.writeCapability,
    );
    return regionExecution(changeSet, context.document, payload.volumeId);
  },
};

/** Registers the region transformation command handlers. */
export function registerRegionCommands(registry: CommandRegistry): void {
  registry.register(copyRegionHandler);
  registry.register(deleteRegionHandler);
  registry.register(translateRegionHandler);
  registry.register(rotateRegionHandler);
  registry.register(mirrorRegionHandler);
}
