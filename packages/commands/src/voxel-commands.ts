import {
  WorkspaceError,
  materialId,
  volumeId,
  type CommandId,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import { nodesReferencingVolume } from "@voxel-maker/document";
import { canonicalVec3i, type Vec3i } from "@voxel-maker/math";
import type { DocumentLimits } from "@voxel-maker/model";
import {
  isRecord,
  missingMaterial,
  missingVolume,
  parseCoordinate,
  parseMaterial,
  parseVolumeId,
} from "./parse-helpers.js";
import type { Command } from "./types.js";
import type {
  CommandExecution,
  CommandExecutionContext,
  CommandHandler,
  CommandValidationContext,
  InverseCommand,
} from "./registry.js";
import { CommandRegistry } from "./registry.js";

export { nodesReferencingVolume } from "@voxel-maker/document";
export const VOXEL_SET_COMMAND = "voxel.set" as const;
export const VOXEL_REMOVE_COMMAND = "voxel.remove" as const;
export const VOXEL_COMMAND_SCHEMA_VERSION = 1;

export interface SetVoxelPayload {
  readonly volumeId: VolumeId;
  readonly coordinate: Vec3i;
  readonly material: MaterialId;
}

export interface RemoveVoxelPayload {
  readonly volumeId: VolumeId;
  readonly coordinate: Vec3i;
}

/** Canonicalizing constructor for a `voxel.set` command. */
export function setVoxelCommand(
  id: CommandId,
  payload: SetVoxelPayload,
): Command<typeof VOXEL_SET_COMMAND, SetVoxelPayload> {
  return {
    id,
    type: VOXEL_SET_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      coordinate: canonicalVec3i(payload.coordinate),
      material: materialId(payload.material),
    },
  };
}

/** Canonicalizing constructor for a `voxel.remove` command. */
export function removeVoxelCommand(
  id: CommandId,
  payload: RemoveVoxelPayload,
): Command<typeof VOXEL_REMOVE_COMMAND, RemoveVoxelPayload> {
  return {
    id,
    type: VOXEL_REMOVE_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      coordinate: canonicalVec3i(payload.coordinate),
    },
  };
}

const setVoxelHandler: CommandHandler<
  typeof VOXEL_SET_COMMAND,
  SetVoxelPayload
> = {
  type: VOXEL_SET_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): SetVoxelPayload {
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
      coordinate: parseCoordinate(payload.coordinate, limits, [
        "payload",
        "coordinate",
      ]),
      material: parseMaterial(payload.material, ["payload", "material"]),
    };
  },
  validate(payload: SetVoxelPayload, context: CommandValidationContext): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
    if (context.document.materials[payload.material] === undefined) {
      throw missingMaterial(payload.material);
    }
  },
  execute(
    payload: SetVoxelPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const change = volume.setVoxel(
      payload.coordinate,
      payload.material,
      context.writeCapability,
    );
    const patch = change?.patches[0];
    const inverse: InverseCommand =
      patch === undefined
        ? {
            type: VOXEL_SET_COMMAND,
            schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
            payload: { ...payload },
          }
        : patch.oldValue === 0
          ? {
              type: VOXEL_REMOVE_COMMAND,
              schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
              payload: {
                volumeId: payload.volumeId,
                coordinate: payload.coordinate,
              },
            }
          : {
              type: VOXEL_SET_COMMAND,
              schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
              payload: {
                volumeId: payload.volumeId,
                coordinate: payload.coordinate,
                material: patch.oldValue,
              },
            };
    return {
      changeSet: {
        volumeId: payload.volumeId,
        chunks: change === undefined ? [] : [change],
      },
      inverse,
      declaredAffectedResources: {
        nodeIds: nodesReferencingVolume(context.document, payload.volumeId),
        materialIds: [payload.material],
        animationIds: [],
        volumeIds: [payload.volumeId],
      },
    };
  },
};

const removeVoxelHandler: CommandHandler<
  typeof VOXEL_REMOVE_COMMAND,
  RemoveVoxelPayload
> = {
  type: VOXEL_REMOVE_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): RemoveVoxelPayload {
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
      coordinate: parseCoordinate(payload.coordinate, limits, [
        "payload",
        "coordinate",
      ]),
    };
  },
  validate(
    payload: RemoveVoxelPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
  },
  execute(
    payload: RemoveVoxelPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const change = volume.removeVoxel(
      payload.coordinate,
      context.writeCapability,
    );
    const patch = change?.patches[0];
    const inverse: InverseCommand =
      patch === undefined
        ? {
            type: VOXEL_REMOVE_COMMAND,
            schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
            payload: { ...payload },
          }
        : {
            type: VOXEL_SET_COMMAND,
            schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
            payload: {
              volumeId: payload.volumeId,
              coordinate: payload.coordinate,
              material: patch.oldValue,
            },
          };
    return {
      changeSet: {
        volumeId: payload.volumeId,
        chunks: change === undefined ? [] : [change],
      },
      inverse,
      declaredAffectedResources: {
        nodeIds: nodesReferencingVolume(context.document, payload.volumeId),
        materialIds: [],
        animationIds: [],
        volumeIds: [payload.volumeId],
      },
    };
  },
};

/** Registers the `voxel.set` and `voxel.remove` handlers. */
export function registerVoxelCommands(registry: CommandRegistry): void {
  registry.register(setVoxelHandler);
  registry.register(removeVoxelHandler);
}
