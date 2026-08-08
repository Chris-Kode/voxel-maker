import {
  WorkspaceError,
  materialId,
  volumeId,
  type CommandId,
  type MaterialId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import { canonicalVec3i, type Vec3i } from "@voxel-maker/math";
import type { DocumentLimits, VoxelDocument } from "@voxel-maker/model";
import type { Command } from "./types.js";
import type {
  CommandExecution,
  CommandExecutionContext,
  CommandHandler,
  CommandValidationContext,
  InverseCommand,
} from "./registry.js";
import { CommandRegistry } from "./registry.js";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseVolumeId(
  value: unknown,
  path: readonly (string | number)[],
): VolumeId {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_ID",
      message:
        "Identifiers must be non-empty strings of at most 128 characters",
      path,
    });
  }
  return value as VolumeId;
}

function parseCoordinate(
  value: unknown,
  limits: DocumentLimits,
  path: readonly (string | number)[],
): Vec3i {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_VECTOR",
      message: "Expected a 3-component integer vector",
      path,
    });
  }
  const raw = value as unknown[];
  const components: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const component = raw[axis];
    if (
      typeof component !== "number" ||
      !Number.isInteger(component) ||
      Math.abs(component) > limits.maxVoxelCoordinate
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_VOXEL_COORDINATE",
        message: `Voxel coordinates must be integers within +-${String(limits.maxVoxelCoordinate)}`,
        path: [...path, axis],
        context: { value: String(component) },
      });
    }
    components.push(component);
  }
  return [
    components[0] as number,
    components[1] as number,
    components[2] as number,
  ];
}

function parseMaterial(
  value: unknown,
  path: readonly (string | number)[],
): MaterialId {
  if (typeof value !== "number") {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_MATERIAL_ID",
      message: "Material must be an integer from 1 through 65535",
      path,
      context: { value: String(value) },
    });
  }
  return materialId(value);
}

/** Nodes whose voxel component references the volume (plan 5.3). */
function nodesReferencingVolume(
  document: VoxelDocument,
  volumeId: VolumeId,
): readonly NodeId[] {
  const nodeIds: NodeId[] = [];
  for (const node of Object.values(document.nodes)) {
    if (
      node.components.some(
        (component) =>
          component.kind === "voxel" && component.volumeId === volumeId,
      )
    ) {
      nodeIds.push(node.nodeId);
    }
  }
  return nodeIds;
}

const missingVolume = (volumeId: VolumeId): WorkspaceError =>
  new WorkspaceError({
    family: "validation",
    code: "MISSING_VOLUME",
    message: "Volume is not part of the document",
    context: { volumeId },
  });

const missingMaterial = (material: MaterialId): WorkspaceError =>
  new WorkspaceError({
    family: "validation",
    code: "MISSING_MATERIAL",
    message: "Material is not defined in the document",
    context: { material: String(material) },
  });

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
