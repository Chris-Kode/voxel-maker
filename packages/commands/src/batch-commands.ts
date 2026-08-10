import {
  WorkspaceError,
  materialId,
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
  MAX_VOXELS_PER_OPERATION,
  type VoxelChangeSet,
  type VoxelPatchChunk,
  type ShapeAxis,
} from "@voxel-maker/voxel";
import {
  isRecord,
  missingMaterial,
  missingVolume,
  parseAxis,
  parseCoordinate,
  parseMaterial,
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
} from "./registry.js";
import { CommandRegistry } from "./registry.js";
import {
  VOXEL_COMMAND_SCHEMA_VERSION,
  nodesReferencingVolume,
} from "./voxel-commands.js";

export const VOXEL_SET_BATCH_COMMAND = "voxel.setBatch" as const;
export const VOXEL_REMOVE_BATCH_COMMAND = "voxel.removeBatch" as const;
export const VOXEL_FILL_BOX_COMMAND = "voxel.fillBox" as const;
export const VOXEL_FILL_SPHERE_COMMAND = "voxel.fillSphere" as const;
export const VOXEL_FILL_CYLINDER_COMMAND = "voxel.fillCylinder" as const;
export const VOXEL_REPLACE_MATERIAL_COMMAND = "voxel.replaceMaterial" as const;
export const VOXEL_APPLY_PATCHES_COMMAND = "voxel.applyPatches" as const;

export interface SetBatchEntry {
  readonly coordinate: Vec3i;
  readonly material: MaterialId;
}

export interface SetBatchPayload {
  readonly volumeId: VolumeId;
  readonly entries: readonly SetBatchEntry[];
}

export interface RemoveBatchPayload {
  readonly volumeId: VolumeId;
  readonly coordinates: readonly Vec3i[];
}

export interface FillBoxPayload {
  readonly volumeId: VolumeId;
  readonly region: IntAabb;
  readonly material: MaterialId;
}

export interface FillSpherePayload {
  readonly volumeId: VolumeId;
  readonly center: Vec3i;
  readonly radius: number;
  readonly material: MaterialId;
}

export interface FillCylinderPayload {
  readonly volumeId: VolumeId;
  readonly center: Vec3i;
  readonly radius: number;
  readonly height: number;
  readonly axis: ShapeAxis;
  readonly material: MaterialId;
}

export interface ReplaceMaterialPayload {
  readonly volumeId: VolumeId;
  /** Half-open region; absent means the whole volume. */
  readonly region?: IntAabb;
  /** Source filter, 0..65535; 0 matches empty voxels. */
  readonly fromMaterial: number;
  /** Replacement value, 0..65535; 0 erases matching voxels. */
  readonly toMaterial: number;
}

export interface ApplyPatchesPayload {
  readonly volumeId: VolumeId;
  readonly chunks: readonly VoxelPatchChunk[];
}

/** Canonicalizing constructor for a `voxel.setBatch` command. */
export function setBatchCommand(
  id: CommandId,
  payload: SetBatchPayload,
): Command<typeof VOXEL_SET_BATCH_COMMAND, SetBatchPayload> {
  return {
    id,
    type: VOXEL_SET_BATCH_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      entries: payload.entries.map((entry) => ({
        coordinate: canonicalVec3i(entry.coordinate),
        material: materialId(entry.material),
      })),
    },
  };
}

/** Canonicalizing constructor for a `voxel.removeBatch` command. */
export function removeBatchCommand(
  id: CommandId,
  payload: RemoveBatchPayload,
): Command<typeof VOXEL_REMOVE_BATCH_COMMAND, RemoveBatchPayload> {
  return {
    id,
    type: VOXEL_REMOVE_BATCH_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      coordinates: payload.coordinates.map((coordinate) =>
        canonicalVec3i(coordinate),
      ),
    },
  };
}

/** Canonicalizing constructor for a `voxel.fillBox` command. */
export function fillBoxCommand(
  id: CommandId,
  payload: FillBoxPayload,
): Command<typeof VOXEL_FILL_BOX_COMMAND, FillBoxPayload> {
  return {
    id,
    type: VOXEL_FILL_BOX_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      region: canonicalIntAabb(payload.region),
      material: materialId(payload.material),
    },
  };
}

/** Canonicalizing constructor for a `voxel.fillSphere` command. */
export function fillSphereCommand(
  id: CommandId,
  payload: FillSpherePayload,
): Command<typeof VOXEL_FILL_SPHERE_COMMAND, FillSpherePayload> {
  return {
    id,
    type: VOXEL_FILL_SPHERE_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      center: canonicalVec3i(payload.center),
      radius: parseNonNegativeInteger(payload.radius, "radius"),
      material: materialId(payload.material),
    },
  };
}

/** Canonicalizing constructor for a `voxel.fillCylinder` command. */
export function fillCylinderCommand(
  id: CommandId,
  payload: FillCylinderPayload,
): Command<typeof VOXEL_FILL_CYLINDER_COMMAND, FillCylinderPayload> {
  return {
    id,
    type: VOXEL_FILL_CYLINDER_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      center: canonicalVec3i(payload.center),
      radius: parseNonNegativeInteger(payload.radius, "radius"),
      height: parseNonNegativeInteger(payload.height, "height"),
      axis: parseAxis(payload.axis),
      material: materialId(payload.material),
    },
  };
}

/** Canonicalizing constructor for a `voxel.replaceMaterial` command. */
export function replaceMaterialCommand(
  id: CommandId,
  payload: ReplaceMaterialPayload,
): Command<typeof VOXEL_REPLACE_MATERIAL_COMMAND, ReplaceMaterialPayload> {
  return {
    id,
    type: VOXEL_REPLACE_MATERIAL_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      ...(payload.region !== undefined
        ? { region: canonicalIntAabb(payload.region) }
        : {}),
      fromMaterial: parseMaterialOrEmpty(
        payload.fromMaterial,
        [],
        "fromMaterial",
      ),
      toMaterial: parseMaterialOrEmpty(payload.toMaterial, [], "toMaterial"),
    },
  };
}

/** Canonicalizing constructor for a `voxel.applyPatches` command. */
export function applyPatchesCommand(
  id: CommandId,
  payload: ApplyPatchesPayload,
): Command<typeof VOXEL_APPLY_PATCHES_COMMAND, ApplyPatchesPayload> {
  return {
    id,
    type: VOXEL_APPLY_PATCHES_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: volumeId(payload.volumeId),
      chunks: payload.chunks.map((chunk) => ({
        coordinate: canonicalVec3i(chunk.coordinate),
        patches: chunk.patches.map((patch) => ({
          index: chunkIndexValue(patch.index),
          oldValue: parseMaterialOrEmpty(patch.oldValue, [], "oldValue"),
        })),
      })),
    },
  };
}

function parseMaterialOrEmpty(
  value: unknown,
  path: readonly (string | number)[],
  name = "Material",
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 65_535
  ) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_MATERIAL_ID",
      message: `${name} must be an integer from 0 through 65535`,
      path,
      context: { value: String(value) },
    });
  }
  return value;
}

function parseNonNegativeInteger(
  value: unknown,
  name: string,
  path: readonly (string | number)[] = [],
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_SHAPE_DIMENSION",
      message: `${name} must be a non-negative integer`,
      path,
      context: { value: String(value) },
    });
  }
  return value;
}

function parseEntries(
  value: unknown,
  limits: DocumentLimits,
  path: readonly (string | number)[],
): SetBatchEntry[] {
  if (!Array.isArray(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected an entries array",
      path,
    });
  }
  if (value.length > MAX_VOXELS_PER_OPERATION) {
    throw new WorkspaceError({
      family: "limit",
      code: "TOO_MANY_VOXELS",
      message: "Batch exceeds the per-operation voxel limit",
      context: { requested: value.length, limit: MAX_VOXELS_PER_OPERATION },
    });
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected an entry object with coordinate and material",
        path: [...path, index],
      });
    }
    return {
      coordinate: parseCoordinate(entry.coordinate, limits, [
        ...path,
        index,
        "coordinate",
      ]),
      material: parseMaterial(entry.material, [...path, index, "material"]),
    };
  });
}

function parseCoordinates(
  value: unknown,
  limits: DocumentLimits,
  path: readonly (string | number)[],
): Vec3i[] {
  if (!Array.isArray(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a coordinates array",
      path,
    });
  }
  if (value.length > MAX_VOXELS_PER_OPERATION) {
    throw new WorkspaceError({
      family: "limit",
      code: "TOO_MANY_VOXELS",
      message: "Batch exceeds the per-operation voxel limit",
      context: { requested: value.length, limit: MAX_VOXELS_PER_OPERATION },
    });
  }
  return value.map((coordinate, index) =>
    parseCoordinate(coordinate, limits, [...path, index]),
  );
}

function parsePatches(
  value: unknown,
  limits: DocumentLimits,
  path: readonly (string | number)[],
): VoxelPatchChunk[] {
  if (!Array.isArray(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a chunks array",
      path,
    });
  }
  let total = 0;
  return value.map((chunk, chunkIndex) => {
    if (!isRecord(chunk)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a chunk object with coordinate and patches",
        path: [...path, chunkIndex],
      });
    }
    const patches = chunk.patches;
    if (!Array.isArray(patches)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a patches array",
        path: [...path, chunkIndex, "patches"],
      });
    }
    const patchList = patches as unknown[];
    total += patchList.length;
    if (total > MAX_VOXELS_PER_OPERATION) {
      throw new WorkspaceError({
        family: "limit",
        code: "TOO_MANY_VOXELS",
        message: "Patch list exceeds the per-operation voxel limit",
        context: { requested: total, limit: MAX_VOXELS_PER_OPERATION },
      });
    }
    const coordinate = parseCoordinate(chunk.coordinate, limits, [
      ...path,
      chunkIndex,
      "coordinate",
    ]);
    return {
      coordinate,
      patches: patchList.map((patch, patchIndex) => {
        if (!isRecord(patch)) {
          throw new WorkspaceError({
            family: "validation",
            code: "INVALID_FIELD_TYPE",
            message: "Expected a patch object with index and oldValue",
            path: [...path, chunkIndex, "patches", patchIndex],
          });
        }
        const index = chunkIndexValue(patch.index);
        // A chunk may straddle the domain edge; every patched voxel must
        // itself lie inside the domain (plan S4.4: parse bounds untrusted
        // input before execution).
        const local = [
          index % 16,
          Math.floor(index / 16) % 16,
          Math.floor(index / 256),
        ];
        for (let axis = 0; axis < 3; axis += 1) {
          const voxel =
            (coordinate[axis] as number) * 16 + (local[axis] as number);
          if (Math.abs(voxel) > limits.maxVoxelCoordinate) {
            throw new WorkspaceError({
              family: "validation",
              code: "INVALID_VOXEL_COORDINATE",
              message: `Patched voxel coordinates must be integers within +-${String(limits.maxVoxelCoordinate)}`,
              path: [...path, chunkIndex, "patches", patchIndex, "index"],
              context: { value: String(voxel) },
            });
          }
        }
        return {
          index,
          oldValue: parseMaterialOrEmpty(patch.oldValue, [
            ...path,
            chunkIndex,
            "patches",
            patchIndex,
            "oldValue",
          ]),
        };
      }),
    };
  });
}

function chunkIndexValue(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 4095
  ) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_CHUNK_INDEX",
      message: "Chunk patch index must be an integer from 0 through 4095",
      context: { value: String(value) },
    });
  }
  return value;
}

/** Exact inverse of any batch/fill/region command: restore the change set's old values. */
export function patchesInverse(changeSet: VoxelChangeSet): InverseCommand {
  return {
    type: VOXEL_APPLY_PATCHES_COMMAND,
    schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
    payload: {
      volumeId: changeSet.volumeId,
      chunks: changeSet.chunks.map((chunk) => ({
        coordinate: chunk.coordinate,
        patches: chunk.patches.map((patch) => ({
          index: patch.index,
          oldValue: patch.oldValue,
        })),
      })),
    },
  };
}

export function affectedResources(
  document: VoxelDocument,
  volumeId: VolumeId,
  materialIds: readonly number[],
): CommandExecution["declaredAffectedResources"] {
  return {
    nodeIds: nodesReferencingVolume(document, volumeId),
    materialIds: [...new Set(materialIds)] as MaterialId[],
    animationIds: [],
    volumeIds: [volumeId],
  };
}

const setBatchHandler: CommandHandler<
  typeof VOXEL_SET_BATCH_COMMAND,
  SetBatchPayload
> = {
  type: VOXEL_SET_BATCH_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): SetBatchPayload {
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
      entries: parseEntries(payload.entries, limits, ["payload", "entries"]),
    };
  },
  validate(payload: SetBatchPayload, context: CommandValidationContext): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
    for (const entry of payload.entries) {
      if (context.document.materials[entry.material] === undefined) {
        throw missingMaterial(entry.material);
      }
    }
  },
  execute(
    payload: SetBatchPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const changeSet = volume.setVoxels(
      payload.entries,
      context.writeCapability,
    );
    return {
      changeSet,
      inverse: patchesInverse(changeSet),
      declaredAffectedResources: affectedResources(
        context.document,
        payload.volumeId,
        payload.entries.map((entry) => entry.material),
      ),
    };
  },
};

const removeBatchHandler: CommandHandler<
  typeof VOXEL_REMOVE_BATCH_COMMAND,
  RemoveBatchPayload
> = {
  type: VOXEL_REMOVE_BATCH_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): RemoveBatchPayload {
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
      coordinates: parseCoordinates(payload.coordinates, limits, [
        "payload",
        "coordinates",
      ]),
    };
  },
  validate(
    payload: RemoveBatchPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
  },
  execute(
    payload: RemoveBatchPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const changeSet = volume.removeVoxels(
      payload.coordinates,
      context.writeCapability,
    );
    return {
      changeSet,
      inverse: patchesInverse(changeSet),
      declaredAffectedResources: affectedResources(
        context.document,
        payload.volumeId,
        [],
      ),
    };
  },
};

const fillBoxHandler: CommandHandler<
  typeof VOXEL_FILL_BOX_COMMAND,
  FillBoxPayload
> = {
  type: VOXEL_FILL_BOX_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): FillBoxPayload {
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
      material: parseMaterial(payload.material, ["payload", "material"]),
    };
  },
  validate(payload: FillBoxPayload, context: CommandValidationContext): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
    if (context.document.materials[payload.material] === undefined) {
      throw missingMaterial(payload.material);
    }
  },
  execute(
    payload: FillBoxPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const changeSet = volume.fillBox(
      payload.region,
      payload.material,
      context.writeCapability,
    );
    return {
      changeSet,
      inverse: patchesInverse(changeSet),
      declaredAffectedResources: affectedResources(
        context.document,
        payload.volumeId,
        [payload.material],
      ),
    };
  },
};

const fillSphereHandler: CommandHandler<
  typeof VOXEL_FILL_SPHERE_COMMAND,
  FillSpherePayload
> = {
  type: VOXEL_FILL_SPHERE_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): FillSpherePayload {
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
      center: parseCoordinate(payload.center, limits, ["payload", "center"]),
      radius: parseNonNegativeInteger(payload.radius, "radius", [
        "payload",
        "radius",
      ]),
      material: parseMaterial(payload.material, ["payload", "material"]),
    };
  },
  validate(
    payload: FillSpherePayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
    if (context.document.materials[payload.material] === undefined) {
      throw missingMaterial(payload.material);
    }
  },
  execute(
    payload: FillSpherePayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const changeSet = volume.fillSphere(
      payload.center,
      payload.radius,
      payload.material,
      context.writeCapability,
    );
    return {
      changeSet,
      inverse: patchesInverse(changeSet),
      declaredAffectedResources: affectedResources(
        context.document,
        payload.volumeId,
        [payload.material],
      ),
    };
  },
};

const fillCylinderHandler: CommandHandler<
  typeof VOXEL_FILL_CYLINDER_COMMAND,
  FillCylinderPayload
> = {
  type: VOXEL_FILL_CYLINDER_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): FillCylinderPayload {
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
      center: parseCoordinate(payload.center, limits, ["payload", "center"]),
      radius: parseNonNegativeInteger(payload.radius, "radius", [
        "payload",
        "radius",
      ]),
      height: parseNonNegativeInteger(payload.height, "height", [
        "payload",
        "height",
      ]),
      axis: parseAxis(payload.axis, ["payload", "axis"]),
      material: parseMaterial(payload.material, ["payload", "material"]),
    };
  },
  validate(
    payload: FillCylinderPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
    if (context.document.materials[payload.material] === undefined) {
      throw missingMaterial(payload.material);
    }
  },
  execute(
    payload: FillCylinderPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const changeSet = volume.fillCylinder(
      payload.center,
      payload.radius,
      payload.height,
      payload.axis,
      payload.material,
      context.writeCapability,
    );
    return {
      changeSet,
      inverse: patchesInverse(changeSet),
      declaredAffectedResources: affectedResources(
        context.document,
        payload.volumeId,
        [payload.material],
      ),
    };
  },
};

const replaceMaterialHandler: CommandHandler<
  typeof VOXEL_REPLACE_MATERIAL_COMMAND,
  ReplaceMaterialPayload
> = {
  type: VOXEL_REPLACE_MATERIAL_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): ReplaceMaterialPayload {
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
      ...(payload.region !== undefined
        ? {
            region: parseRegion(payload.region, limits, ["payload", "region"]),
          }
        : {}),
      fromMaterial: parseMaterialOrEmpty(payload.fromMaterial, [
        "payload",
        "fromMaterial",
      ]),
      toMaterial: parseMaterialOrEmpty(payload.toMaterial, [
        "payload",
        "toMaterial",
      ]),
    };
  },
  validate(
    payload: ReplaceMaterialPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
    if (
      payload.toMaterial !== 0 &&
      context.document.materials[payload.toMaterial as MaterialId] === undefined
    ) {
      throw missingMaterial(payload.toMaterial as MaterialId);
    }
  },
  execute(
    payload: ReplaceMaterialPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const changeSet = volume.replaceMaterial(
      payload.region,
      payload.fromMaterial,
      payload.toMaterial,
      context.writeCapability,
    );
    return {
      changeSet,
      inverse: patchesInverse(changeSet),
      declaredAffectedResources: affectedResources(
        context.document,
        payload.volumeId,
        [payload.fromMaterial, payload.toMaterial],
      ),
    };
  },
};

const applyPatchesHandler: CommandHandler<
  typeof VOXEL_APPLY_PATCHES_COMMAND,
  ApplyPatchesPayload
> = {
  type: VOXEL_APPLY_PATCHES_COMMAND,
  schemaVersion: VOXEL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): ApplyPatchesPayload {
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
      chunks: parsePatches(payload.chunks, limits, ["payload", "chunks"]),
    };
  },
  validate(
    payload: ApplyPatchesPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.volumes[payload.volumeId] === undefined) {
      throw missingVolume(payload.volumeId);
    }
    // Issue #86: a patch restores a voxel value; every nonzero restored
    // value must reference a declared material or the aggregate referential
    // invariant would be bypassed by restore/import flows.
    for (const chunk of payload.chunks) {
      for (const patch of chunk.patches) {
        if (
          patch.oldValue !== 0 &&
          context.document.materials[patch.oldValue as MaterialId] === undefined
        ) {
          throw missingMaterial(patch.oldValue as MaterialId);
        }
      }
    }
  },
  execute(
    payload: ApplyPatchesPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const volume = context.stageVolume(payload.volumeId);
    if (volume === undefined) throw missingVolume(payload.volumeId);
    const changeSet = volume.applyPatches(
      payload.chunks,
      context.writeCapability,
    );
    const oldValues = new Set<number>();
    for (const chunk of payload.chunks) {
      for (const patch of chunk.patches) {
        oldValues.add(patch.oldValue);
      }
    }
    return {
      changeSet,
      inverse: patchesInverse(changeSet),
      declaredAffectedResources: affectedResources(
        context.document,
        payload.volumeId,
        [...oldValues],
      ),
    };
  },
};

/** Registers the batch, fill, replace, and patch command handlers. */
export function registerBatchCommands(registry: CommandRegistry): void {
  registry.register(setBatchHandler);
  registry.register(removeBatchHandler);
  registry.register(fillBoxHandler);
  registry.register(fillSphereHandler);
  registry.register(fillCylinderHandler);
  registry.register(replaceMaterialHandler);
  registry.register(applyPatchesHandler);
}
