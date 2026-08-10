import {
  WorkspaceError,
  materialId,
  type CommandId,
  type MaterialId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { Color, DocumentLimits, VoxelDocument } from "@voxel-maker/model";
import { canonicalColor, isCanonicalColor } from "@voxel-maker/model";
import {
  MAX_VOXELS_PER_OPERATION,
  type VoxelChangeSet,
} from "@voxel-maker/voxel";
import {
  isRecord,
  missingMaterial,
  parseMaterial,
  parseName,
} from "./parse-helpers.js";
import { withoutRecordEntry } from "./records.js";
import type { Command } from "./types.js";
import type {
  CommandExecution,
  CommandExecutionContext,
  CommandHandler,
  CommandValidationContext,
  InverseCommand,
} from "./registry.js";
import { CommandRegistry } from "./registry.js";
import { patchesInverse } from "./batch-commands.js";
import { nodesReferencingVolume } from "./voxel-commands.js";

export const MATERIAL_CREATE_COMMAND = "material.create" as const;
export const MATERIAL_UPDATE_COMMAND = "material.update" as const;
export const MATERIAL_DELETE_COMMAND = "material.delete" as const;
export const MATERIAL_COMMAND_SCHEMA_VERSION = 1;

export interface CreateMaterialPayload {
  readonly materialId: MaterialId;
  readonly name: string;
  /** Canonical lowercase `#rrggbb` color. */
  readonly color: Color;
  readonly opacity: number;
  readonly roughness: number;
  readonly metallic: number;
  readonly emissive: number;
}

export interface UpdateMaterialPayload {
  readonly materialId: MaterialId;
  readonly name?: string;
  readonly color?: Color;
  readonly opacity?: number;
  readonly roughness?: number;
  readonly metallic?: number;
  readonly emissive?: number;
}

export interface DeleteMaterialPayload {
  readonly materialId: MaterialId;
  /**
   * Explicit valid replacement for referenced deletion: every voxel using
   * the deleted material is remapped to this material before the record is
   * removed. Absent when the material is unreferenced.
   */
  readonly replacement?: MaterialId;
}

/** Canonicalizing constructor for a `material.create` command. */
export function createMaterialCommand(
  id: CommandId,
  payload: CreateMaterialPayload,
): Command<typeof MATERIAL_CREATE_COMMAND, CreateMaterialPayload> {
  return {
    id,
    type: MATERIAL_CREATE_COMMAND,
    schemaVersion: MATERIAL_COMMAND_SCHEMA_VERSION,
    payload: {
      materialId: materialId(payload.materialId),
      name: payload.name,
      color: canonicalColor(payload.color),
      opacity: payload.opacity,
      roughness: payload.roughness,
      metallic: payload.metallic,
      emissive: payload.emissive,
    },
  };
}

/** Canonicalizing constructor for a `material.update` command. */
export function updateMaterialCommand(
  id: CommandId,
  payload: UpdateMaterialPayload,
): Command<typeof MATERIAL_UPDATE_COMMAND, UpdateMaterialPayload> {
  return {
    id,
    type: MATERIAL_UPDATE_COMMAND,
    schemaVersion: MATERIAL_COMMAND_SCHEMA_VERSION,
    payload: {
      materialId: materialId(payload.materialId),
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.color !== undefined
        ? { color: canonicalColor(payload.color) }
        : {}),
      ...(payload.opacity !== undefined ? { opacity: payload.opacity } : {}),
      ...(payload.roughness !== undefined
        ? { roughness: payload.roughness }
        : {}),
      ...(payload.metallic !== undefined ? { metallic: payload.metallic } : {}),
      ...(payload.emissive !== undefined ? { emissive: payload.emissive } : {}),
    },
  };
}

/** Canonicalizing constructor for a `material.delete` command. */
export function deleteMaterialCommand(
  id: CommandId,
  payload: DeleteMaterialPayload,
): Command<typeof MATERIAL_DELETE_COMMAND, DeleteMaterialPayload> {
  return {
    id,
    type: MATERIAL_DELETE_COMMAND,
    schemaVersion: MATERIAL_COMMAND_SCHEMA_VERSION,
    payload: {
      materialId: materialId(payload.materialId),
      ...(payload.replacement !== undefined
        ? { replacement: materialId(payload.replacement) }
        : {}),
    },
  };
}

function parseColor(value: unknown, path: readonly (string | number)[]): Color {
  if (!isCanonicalColor(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_COLOR",
      message: "Color must be a lowercase #rrggbb value",
      path,
    });
  }
  return value;
}

function parseUnitRange(
  value: unknown,
  field: string,
  path: readonly (string | number)[],
): number {
  if (typeof value !== "number") {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a number",
      path,
    });
  }
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_CANONICAL_NUMBER",
      message: "Numbers must be finite and must not be negative zero",
      path,
    });
  }
  if (value < 0 || value > 1) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_MATERIAL_RANGE",
      message: `${field} must be within [0, 1]`,
      path,
    });
  }
  return value;
}

function parseCreatePayload(
  payload: unknown,
  limits: DocumentLimits,
): CreateMaterialPayload {
  if (!isRecord(payload)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a payload object",
      path: ["payload"],
    });
  }
  return {
    materialId: parseMaterial(payload.materialId, ["payload", "materialId"]),
    name: parseName(payload.name, limits, ["payload", "name"]),
    color: parseColor(payload.color, ["payload", "color"]),
    opacity: parseUnitRange(payload.opacity, "opacity", ["payload", "opacity"]),
    roughness: parseUnitRange(payload.roughness, "roughness", [
      "payload",
      "roughness",
    ]),
    metallic: parseUnitRange(payload.metallic, "metallic", [
      "payload",
      "metallic",
    ]),
    emissive: parseUnitRange(payload.emissive, "emissive", [
      "payload",
      "emissive",
    ]),
  };
}

function parseUpdatePayload(
  payload: unknown,
  limits: DocumentLimits,
): UpdateMaterialPayload {
  if (!isRecord(payload)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a payload object",
      path: ["payload"],
    });
  }
  return {
    materialId: parseMaterial(payload.materialId, ["payload", "materialId"]),
    ...(payload.name !== undefined
      ? { name: parseName(payload.name, limits, ["payload", "name"]) }
      : {}),
    ...(payload.color !== undefined
      ? { color: parseColor(payload.color, ["payload", "color"]) }
      : {}),
    ...(payload.opacity !== undefined
      ? {
          opacity: parseUnitRange(payload.opacity, "opacity", [
            "payload",
            "opacity",
          ]),
        }
      : {}),
    ...(payload.roughness !== undefined
      ? {
          roughness: parseUnitRange(payload.roughness, "roughness", [
            "payload",
            "roughness",
          ]),
        }
      : {}),
    ...(payload.metallic !== undefined
      ? {
          metallic: parseUnitRange(payload.metallic, "metallic", [
            "payload",
            "metallic",
          ]),
        }
      : {}),
    ...(payload.emissive !== undefined
      ? {
          emissive: parseUnitRange(payload.emissive, "emissive", [
            "payload",
            "emissive",
          ]),
        }
      : {}),
  };
}

function parseDeletePayload(payload: unknown): DeleteMaterialPayload {
  if (!isRecord(payload)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a payload object",
      path: ["payload"],
    });
  }
  return {
    materialId: parseMaterial(payload.materialId, ["payload", "materialId"]),
    ...(payload.replacement !== undefined
      ? {
          replacement: parseMaterial(payload.replacement, [
            "payload",
            "replacement",
          ]),
        }
      : {}),
  };
}

/**
 * True when any voxel in any volume references the material. The scan is
 * bounded per volume by the voxel operation limit (ADR-0009), matching the
 * per-volume budget the replacement remap enforces.
 */
function isMaterialReferenced(
  context: CommandValidationContext,
  material: MaterialId,
): boolean {
  for (const volumeId of Object.keys(context.document.volumes)) {
    const volume = context.getVolume(volumeId as VolumeId);
    if (volume === undefined) continue;
    let inspected = 0;
    for (const coordinate of volume.chunkCoordinates()) {
      const chunk = volume.getChunk(coordinate);
      if (chunk === undefined) continue;
      for (let index = 0; index < chunk.length; index += 1) {
        inspected += 1;
        if (inspected > MAX_VOXELS_PER_OPERATION) {
          throw new WorkspaceError({
            family: "limit",
            code: "TOO_MANY_VOXELS",
            message:
              "Material reference scan exceeds the per-operation voxel limit",
            context: { limit: MAX_VOXELS_PER_OPERATION },
          });
        }
        if ((chunk[index] as number) === material) return true;
      }
    }
  }
  return false;
}

function materialResources(
  document: VoxelDocument,
  material: MaterialId,
  replacement: MaterialId | undefined,
  changeSets: readonly VoxelChangeSet[],
): CommandExecution["declaredAffectedResources"] {
  const nodeIds = new Set<NodeId>();
  const volumeIds: VolumeId[] = [];
  for (const changeSet of changeSets) {
    volumeIds.push(changeSet.volumeId);
    for (const nodeIdValue of nodesReferencingVolume(
      document,
      changeSet.volumeId,
    )) {
      nodeIds.add(nodeIdValue);
    }
  }
  return {
    nodeIds: [...nodeIds],
    materialIds:
      replacement === undefined ? [material] : [material, replacement],
    animationIds: [],
    volumeIds,
  };
}

const createMaterialHandler: CommandHandler<
  typeof MATERIAL_CREATE_COMMAND,
  CreateMaterialPayload
> = {
  type: MATERIAL_CREATE_COMMAND,
  schemaVersion: MATERIAL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): CreateMaterialPayload {
    return parseCreatePayload(payload, limits);
  },
  validate(
    payload: CreateMaterialPayload,
    context: CommandValidationContext,
  ): void {
    const existing = context.document.materials[payload.materialId];
    if (existing !== undefined) {
      // Creating a material that already exists with an identical record is
      // a no-op commit (the desired end state already holds), matching the
      // voxel no-op policy; a conflicting record is a duplicate error.
      if (materialRecordEqual(existing, payload)) return;
      throw new WorkspaceError({
        family: "validation",
        code: "DUPLICATE_MATERIAL_ID",
        message: "A material with this identifier already exists",
        context: { material: String(payload.materialId) },
      });
    }
    if (
      Object.keys(context.document.materials).length >=
      context.limits.maxMaterials
    ) {
      throw new WorkspaceError({
        family: "limit",
        code: "LIMIT_EXCEEDED",
        message: `Material count exceeds the ${String(context.limits.maxMaterials)}-material limit`,
        path: ["payload", "materialId"],
      });
    }
  },
  execute(
    payload: CreateMaterialPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const existing = document.materials[payload.materialId];
    if (existing !== undefined) {
      if (materialRecordEqual(existing, payload)) {
        return {
          inverse: {
            type: MATERIAL_CREATE_COMMAND,
            schemaVersion: MATERIAL_COMMAND_SCHEMA_VERSION,
            payload,
          },
          changedRecords: false,
          declaredAffectedResources: {
            nodeIds: [],
            materialIds: [payload.materialId],
            animationIds: [],
            volumeIds: [],
          },
        };
      }
      throw new WorkspaceError({
        family: "validation",
        code: "DUPLICATE_MATERIAL_ID",
        message: "A material with this identifier already exists",
        context: { material: String(payload.materialId) },
      });
    }
    document.materials[payload.materialId] = {
      materialId: payload.materialId,
      name: payload.name,
      color: payload.color,
      opacity: payload.opacity,
      roughness: payload.roughness,
      metallic: payload.metallic,
      emissive: payload.emissive,
    };
    return {
      inverse: {
        type: MATERIAL_DELETE_COMMAND,
        schemaVersion: MATERIAL_COMMAND_SCHEMA_VERSION,
        payload: { materialId: payload.materialId },
      },
      changedRecords: true,
      declaredAffectedResources: {
        nodeIds: [],
        materialIds: [payload.materialId],
        animationIds: [],
        volumeIds: [],
      },
    };
  },
};

const updateMaterialHandler: CommandHandler<
  typeof MATERIAL_UPDATE_COMMAND,
  UpdateMaterialPayload
> = {
  type: MATERIAL_UPDATE_COMMAND,
  schemaVersion: MATERIAL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): UpdateMaterialPayload {
    return parseUpdatePayload(payload, limits);
  },
  validate(
    payload: UpdateMaterialPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.materials[payload.materialId] === undefined) {
      throw missingMaterial(payload.materialId);
    }
    if (
      payload.name === undefined &&
      payload.color === undefined &&
      payload.opacity === undefined &&
      payload.roughness === undefined &&
      payload.metallic === undefined &&
      payload.emissive === undefined
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "EMPTY_MATERIAL_UPDATE",
        message: "At least one material property must be provided",
        path: ["payload"],
      });
    }
  },
  execute(
    payload: UpdateMaterialPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const record = document.materials[payload.materialId];
    if (record === undefined) throw missingMaterial(payload.materialId);
    const old = { ...record };
    if (payload.name !== undefined) record.name = payload.name;
    if (payload.color !== undefined) record.color = payload.color;
    if (payload.opacity !== undefined) record.opacity = payload.opacity;
    if (payload.roughness !== undefined) record.roughness = payload.roughness;
    if (payload.metallic !== undefined) record.metallic = payload.metallic;
    if (payload.emissive !== undefined) record.emissive = payload.emissive;
    const inversePayload: UpdateMaterialPayload = {
      materialId: payload.materialId,
      ...(payload.name !== undefined ? { name: old.name } : {}),
      ...(payload.color !== undefined ? { color: old.color } : {}),
      ...(payload.opacity !== undefined ? { opacity: old.opacity } : {}),
      ...(payload.roughness !== undefined ? { roughness: old.roughness } : {}),
      ...(payload.metallic !== undefined ? { metallic: old.metallic } : {}),
      ...(payload.emissive !== undefined ? { emissive: old.emissive } : {}),
    };
    return {
      inverse: {
        type: MATERIAL_UPDATE_COMMAND,
        schemaVersion: MATERIAL_COMMAND_SCHEMA_VERSION,
        payload: inversePayload,
      },
      changedRecords: !materialRecordEqual(old, record),
      declaredAffectedResources: {
        nodeIds: [],
        materialIds: [payload.materialId],
        animationIds: [],
        volumeIds: [],
      },
    };
  },
};

const deleteMaterialHandler: CommandHandler<
  typeof MATERIAL_DELETE_COMMAND,
  DeleteMaterialPayload
> = {
  type: MATERIAL_DELETE_COMMAND,
  schemaVersion: MATERIAL_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): DeleteMaterialPayload {
    void limits;
    return parseDeletePayload(payload);
  },
  validate(
    payload: DeleteMaterialPayload,
    context: CommandValidationContext,
  ): void {
    // Deleting a material that is already absent is a no-op commit (the
    // desired end state already holds), matching the voxel no-op policy.
    // The replacement is still validated so an invalid intent is reported.
    if (payload.replacement !== undefined) {
      if (context.document.materials[payload.replacement] === undefined) {
        throw missingMaterial(payload.replacement);
      }
      if (payload.replacement === payload.materialId) {
        throw new WorkspaceError({
          family: "validation",
          code: "INVALID_REPLACEMENT",
          message: "Replacement material must differ from the deleted material",
          context: { material: String(payload.materialId) },
        });
      }
    }
    if (context.document.materials[payload.materialId] === undefined) {
      return;
    }
    if (payload.replacement !== undefined) {
      if (context.document.materials[payload.replacement] === undefined) {
        throw missingMaterial(payload.replacement);
      }
      if (payload.replacement === payload.materialId) {
        throw new WorkspaceError({
          family: "validation",
          code: "INVALID_REPLACEMENT",
          message: "Replacement material must differ from the deleted material",
          context: { material: String(payload.materialId) },
        });
      }
    }
    if (
      payload.replacement === undefined &&
      isMaterialReferenced(context, payload.materialId)
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "REFERENCED_MATERIAL",
        message:
          "Material is referenced by voxels; supply an explicit valid replacement to delete it",
        context: { material: String(payload.materialId) },
      });
    }
  },
  execute(
    payload: DeleteMaterialPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const record = document.materials[payload.materialId];
    if (record === undefined) {
      return {
        inverse: {
          type: MATERIAL_DELETE_COMMAND,
          schemaVersion: MATERIAL_COMMAND_SCHEMA_VERSION,
          payload: { materialId: payload.materialId },
        },
        changedRecords: false,
        declaredAffectedResources: {
          nodeIds: [],
          materialIds: [],
          animationIds: [],
          volumeIds: [],
        },
      };
    }
    const changeSets: VoxelChangeSet[] = [];
    if (payload.replacement !== undefined) {
      for (const volumeId of Object.keys(document.volumes)) {
        const volume = context.stageVolume(volumeId as VolumeId);
        if (volume === undefined) continue;
        const changeSet = volume.replaceMaterial(
          undefined,
          payload.materialId,
          payload.replacement,
          context.writeCapability,
        );
        if (changeSet.chunks.length > 0) changeSets.push(changeSet);
      }
    }
    document.materials = withoutRecordEntry(
      document.materials,
      String(payload.materialId),
    );
    const inverse: InverseCommand[] = changeSets.map((changeSet) =>
      patchesInverse(changeSet),
    );
    inverse.push({
      type: MATERIAL_CREATE_COMMAND,
      schemaVersion: MATERIAL_COMMAND_SCHEMA_VERSION,
      payload: {
        materialId: record.materialId,
        name: record.name,
        color: record.color,
        opacity: record.opacity,
        roughness: record.roughness,
        metallic: record.metallic,
        emissive: record.emissive,
      },
    });
    return {
      ...(changeSets[0] !== undefined ? { changeSet: changeSets[0] } : {}),
      ...(changeSets.length > 1
        ? { additionalChangeSets: changeSets.slice(1) }
        : {}),
      inverse,
      changedRecords: true,
      declaredAffectedResources: materialResources(
        document,
        payload.materialId,
        payload.replacement,
        changeSets,
      ),
    };
  },
};

function materialRecordEqual(
  a: {
    readonly name: string;
    readonly color: string;
    readonly opacity: number;
    readonly roughness: number;
    readonly metallic: number;
    readonly emissive: number;
  },
  b: {
    readonly name: string;
    readonly color: string;
    readonly opacity: number;
    readonly roughness: number;
    readonly metallic: number;
    readonly emissive: number;
  },
): boolean {
  return (
    a.name === b.name &&
    a.color === b.color &&
    a.opacity === b.opacity &&
    a.roughness === b.roughness &&
    a.metallic === b.metallic &&
    a.emissive === b.emissive
  );
}

/** Registers the material command handlers. */
export function registerMaterialCommands(registry: CommandRegistry): void {
  registry.register(createMaterialHandler);
  registry.register(updateMaterialHandler);
  registry.register(deleteMaterialHandler);
}
