import {
  copyRegionCommand,
  deleteRegionCommand,
  fillBoxCommand,
  fillCylinderCommand,
  fillSphereCommand,
  mirrorRegionCommand,
  removeBatchCommand,
  replaceMaterialCommand,
  rotateRegionCommand,
  setBatchCommand,
  translateRegionCommand,
} from "@voxel-maker/commands";
import type { JsonValue } from "@voxel-maker/shared";
import {
  mutationOutputSchema,
  regionSchema,
  vec3iSchema,
  type ToolContract,
} from "../contract.js";
import type { JsonSchema } from "../schema.js";
import type { MutationToolContext, MutationPayload } from "./context.js";
import { UNKNOWN_VOLUME_CODE } from "../tools/helpers.js";
import { missingReference } from "../contract.js";
import {
  cylinderEstimate,
  isNonNegativeInteger,
  isVec3i,
  regionVolume,
  requireAxis,
  requireBatchEntry,
  requireBatchLength,
  requireExistingMaterial,
  requireMaterialId,
  requireOptionalRegion,
  requireQuarterTurns,
  requireRegion,
  requireVolumeId,
  resolveCommandId,
  sphereEstimate,
} from "./parse.js";
import { invalidArgument } from "../contract.js";

/**
 * Coarse-geometry mutation tools (plan S11.6, ticket #32): fill, batch,
 * paint, and region operations that compile only to registered commands.
 * Per-voxel streams are discouraged; every tool prefers a coarse semantic
 * operation and reports the bounded voxel estimate of the proposed
 * command. All region arguments are half-open `[min, max)`.
 */

const ID_SCHEMA: JsonSchema = { type: "string", minLength: 1, maxLength: 128 };
const MATERIAL_SCHEMA: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: 65535,
};

/** `fillBox` contract: construct a `voxel.fillBox` command. */
export const FILL_BOX_CONTRACT: ToolContract = {
  name: "fillBox",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered voxel.fillBox command filling a half-open integer region of one volume with one material.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
      region: regionSchema(),
      material: MATERIAL_SCHEMA,
    },
    required: ["volumeId", "region", "material"],
  },
  outputSchema: mutationOutputSchema("fillBox"),
};

/** `fillSphere` contract: construct a `voxel.fillSphere` command. */
export const FILL_SPHERE_CONTRACT: ToolContract = {
  name: "fillSphere",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered voxel.fillSphere command filling the integer sphere centered at an integer coordinate.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
      center: vec3iSchema(),
      radius: { type: "integer", minimum: 0 },
      material: MATERIAL_SCHEMA,
    },
    required: ["volumeId", "center", "radius", "material"],
  },
  outputSchema: mutationOutputSchema("fillSphere"),
};

/** `fillCylinder` contract: construct a `voxel.fillCylinder` command. */
export const FILL_CYLINDER_CONTRACT: ToolContract = {
  name: "fillCylinder",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered voxel.fillCylinder command filling an integer cylinder aligned to one axis.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
      center: vec3iSchema(),
      radius: { type: "integer", minimum: 0 },
      height: { type: "integer", minimum: 0 },
      axis: { type: "string", enum: ["x", "y", "z"] },
      material: MATERIAL_SCHEMA,
    },
    required: ["volumeId", "center", "radius", "height", "axis", "material"],
  },
  outputSchema: mutationOutputSchema("fillCylinder"),
};

/** `setVoxelBatch` contract: construct a `voxel.setBatch` command. */
export const SET_VOXEL_BATCH_CONTRACT: ToolContract = {
  name: "setVoxelBatch",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered voxel.setBatch command writing a bounded batch of explicit voxel entries. Prefer coarse fill/region tools over long per-voxel streams.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            coordinate: vec3iSchema(),
            material: MATERIAL_SCHEMA,
          },
          required: ["coordinate", "material"],
        },
      },
    },
    required: ["volumeId", "entries"],
  },
  outputSchema: mutationOutputSchema("setVoxelBatch"),
};

/** `removeVoxelBatch` contract: construct a `voxel.removeBatch` command. */
export const REMOVE_VOXEL_BATCH_CONTRACT: ToolContract = {
  name: "removeVoxelBatch",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered voxel.removeBatch command clearing a bounded batch of explicit coordinates.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
      coordinates: {
        type: "array",
        items: vec3iSchema(),
      },
    },
    required: ["volumeId", "coordinates"],
  },
  outputSchema: mutationOutputSchema("removeVoxelBatch"),
};

/** `replaceVoxelMaterial` contract: construct a `voxel.replaceMaterial` command. */
export const REPLACE_VOXEL_MATERIAL_CONTRACT: ToolContract = {
  name: "replaceVoxelMaterial",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered voxel.replaceMaterial command remapping one material to another inside an optional region; toMaterial 0 erases matching voxels.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
      region: regionSchema(),
      fromMaterial: { type: "integer", minimum: 0, maximum: 65535 },
      toMaterial: { type: "integer", minimum: 0, maximum: 65535 },
    },
    required: ["volumeId", "fromMaterial", "toMaterial"],
  },
  outputSchema: mutationOutputSchema("replaceVoxelMaterial"),
};

/** `copyRegion` contract: construct a `voxel.copyRegion` command. */
export const COPY_REGION_CONTRACT: ToolContract = {
  name: "copyRegion",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered voxel.copyRegion command copying a half-open region to a destination anchor.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
      source: regionSchema(),
      destination: vec3iSchema(),
    },
    required: ["volumeId", "source", "destination"],
  },
  outputSchema: mutationOutputSchema("copyRegion"),
};

/** `deleteRegion` contract: construct a `voxel.deleteRegion` command. */
export const DELETE_REGION_CONTRACT: ToolContract = {
  name: "deleteRegion",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered voxel.deleteRegion command clearing a half-open region.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
      region: regionSchema(),
    },
    required: ["volumeId", "region"],
  },
  outputSchema: mutationOutputSchema("deleteRegion"),
};

/** `translateRegion` contract: construct a `voxel.translateRegion` command. */
export const TRANSLATE_REGION_CONTRACT: ToolContract = {
  name: "translateRegion",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered voxel.translateRegion command moving a half-open region by an integer delta.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
      region: regionSchema(),
      delta: vec3iSchema(),
    },
    required: ["volumeId", "region", "delta"],
  },
  outputSchema: mutationOutputSchema("translateRegion"),
};

/** `rotateRegion` contract: construct a `voxel.rotateRegion` command. */
export const ROTATE_REGION_CONTRACT: ToolContract = {
  name: "rotateRegion",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered voxel.rotateRegion command rotating a half-open region around its center by exact quarter turns.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
      region: regionSchema(),
      axis: { type: "string", enum: ["x", "y", "z"] },
      quarterTurns: { type: "integer", enum: [1, 2, 3] },
    },
    required: ["volumeId", "region", "axis", "quarterTurns"],
  },
  outputSchema: mutationOutputSchema("rotateRegion"),
};

/** `mirrorRegion` contract: construct a `voxel.mirrorRegion` command. */
export const MIRROR_REGION_CONTRACT: ToolContract = {
  name: "mirrorRegion",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered voxel.mirrorRegion command mirroring a half-open region across its center plane.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      volumeId: ID_SCHEMA,
      region: regionSchema(),
      axis: { type: "string", enum: ["x", "y", "z"] },
    },
    required: ["volumeId", "region", "axis"],
  },
  outputSchema: mutationOutputSchema("mirrorRegion"),
};

/** Throws the stable missing-volume error. */
function requireExistingVolume(
  ctx: MutationToolContext,
  id: ReturnType<typeof requireVolumeId>,
): void {
  if (ctx.store.getDocument().volumes[id] === undefined) {
    missingReference("volume", id, UNKNOWN_VOLUME_CODE);
  }
}

/** Validates a 0..65535 material filter argument (0 = empty). */
function requireMaterialFilter(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 65_535
  ) {
    invalidArgument(`${key} must be an integer from 0 through 65535`, [key]);
  }
  return value;
}

export function fillBox(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  requireExistingVolume(ctx, volumeIdValue);
  const region = requireRegion(record.region as JsonValue, "region");
  const material = requireMaterialId(record, "material");
  requireExistingMaterial(ctx.store, material);
  return {
    command: fillBoxCommand(resolveCommandId(ctx, record), {
      volumeId: volumeIdValue,
      region,
      material,
    }),
    voxelEstimate: regionVolume(region),
  };
}

export function fillSphere(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  requireExistingVolume(ctx, volumeIdValue);
  const center = requireVec3i(record, "center");
  const radius = requireDimension(record, "radius");
  const material = requireMaterialId(record, "material");
  requireExistingMaterial(ctx.store, material);
  return {
    command: fillSphereCommand(resolveCommandId(ctx, record), {
      volumeId: volumeIdValue,
      center,
      radius,
      material,
    }),
    voxelEstimate: sphereEstimate(radius),
  };
}

export function fillCylinder(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  requireExistingVolume(ctx, volumeIdValue);
  const center = requireVec3i(record, "center");
  const radius = requireDimension(record, "radius");
  const height = requireDimension(record, "height");
  const axis = requireAxis(record, "axis");
  const material = requireMaterialId(record, "material");
  requireExistingMaterial(ctx.store, material);
  return {
    command: fillCylinderCommand(resolveCommandId(ctx, record), {
      volumeId: volumeIdValue,
      center,
      radius,
      height,
      axis,
      material,
    }),
    voxelEstimate: cylinderEstimate(radius, height),
  };
}

export function setVoxelBatch(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  requireExistingVolume(ctx, volumeIdValue);
  const entries = record.entries;
  if (!Array.isArray(entries)) {
    invalidArgument("entries must be an array", ["entries"]);
  }
  requireBatchLength(entries.length, ctx.limits.maxBatchEntries, ["entries"]);
  const parsed = entries.map((entry, index) =>
    requireBatchEntry(entry as Readonly<Record<string, JsonValue>>, [
      "entries",
      index,
    ]),
  );
  return {
    command: setBatchCommand(resolveCommandId(ctx, record), {
      volumeId: volumeIdValue,
      entries: parsed,
    }),
    voxelEstimate: parsed.length,
  };
}

export function removeVoxelBatch(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  requireExistingVolume(ctx, volumeIdValue);
  const coordinates = record.coordinates;
  if (!Array.isArray(coordinates)) {
    invalidArgument("coordinates must be an array", ["coordinates"]);
  }
  requireBatchLength(coordinates.length, ctx.limits.maxBatchEntries, [
    "coordinates",
  ]);
  const parsed = (coordinates as JsonValue[]).map((coordinate, index) => {
    if (!isVec3i(coordinate)) {
      invalidArgument("coordinate must be an integer [x, y, z]", [
        "coordinates",
        index,
      ]);
    }
    return coordinate as [number, number, number];
  });
  return {
    command: removeBatchCommand(resolveCommandId(ctx, record), {
      volumeId: volumeIdValue,
      coordinates: parsed,
    }),
    voxelEstimate: parsed.length,
  };
}

export function replaceVoxelMaterial(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  requireExistingVolume(ctx, volumeIdValue);
  const region = requireOptionalRegion(record, "region");
  const fromMaterial = requireMaterialFilter(record, "fromMaterial");
  const toMaterial = requireMaterialFilter(record, "toMaterial");
  const estimate = regionVolumeOrOccupied(ctx, volumeIdValue, region);
  return {
    command: replaceMaterialCommand(resolveCommandId(ctx, record), {
      volumeId: volumeIdValue,
      ...(region === undefined ? {} : { region }),
      fromMaterial,
      toMaterial,
    }),
    voxelEstimate: estimate,
  };
}

export function copyRegion(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  requireExistingVolume(ctx, volumeIdValue);
  const source = requireRegion(record.source as JsonValue, "source");
  const destination = requireVec3i(record, "destination");
  return {
    command: copyRegionCommand(resolveCommandId(ctx, record), {
      volumeId: volumeIdValue,
      source,
      destination,
    }),
    voxelEstimate: regionVolume(source),
  };
}

export function deleteRegion(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  requireExistingVolume(ctx, volumeIdValue);
  const region = requireRegion(record.region as JsonValue, "region");
  return {
    command: deleteRegionCommand(resolveCommandId(ctx, record), {
      volumeId: volumeIdValue,
      region,
    }),
    voxelEstimate: regionVolume(region),
  };
}

export function translateRegion(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  requireExistingVolume(ctx, volumeIdValue);
  const region = requireRegion(record.region as JsonValue, "region");
  const delta = requireVec3i(record, "delta");
  return {
    command: translateRegionCommand(resolveCommandId(ctx, record), {
      volumeId: volumeIdValue,
      region,
      delta,
    }),
    voxelEstimate: regionVolume(region),
  };
}

export function rotateRegion(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  requireExistingVolume(ctx, volumeIdValue);
  const region = requireRegion(record.region as JsonValue, "region");
  const axis = requireAxis(record, "axis");
  const quarterTurns = requireQuarterTurns(record, "quarterTurns");
  return {
    command: rotateRegionCommand(resolveCommandId(ctx, record), {
      volumeId: volumeIdValue,
      region,
      axis,
      quarterTurns,
    }),
    voxelEstimate: regionVolume(region),
  };
}

export function mirrorRegion(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIdValue = requireVolumeId(record, "volumeId");
  requireExistingVolume(ctx, volumeIdValue);
  const region = requireRegion(record.region as JsonValue, "region");
  const axis = requireAxis(record, "axis");
  return {
    command: mirrorRegionCommand(resolveCommandId(ctx, record), {
      volumeId: volumeIdValue,
      region,
      axis,
    }),
    voxelEstimate: regionVolume(region),
  };
}

/** Validates an integer [x, y, z] argument. */
function requireVec3i(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): [number, number, number] {
  const value = record[key];
  if (!isVec3i(value)) {
    invalidArgument(`${key} must be an integer [x, y, z]`, [key]);
  }
  return value as [number, number, number];
}

/** Validates a non-negative integer dimension argument. */
function requireDimension(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): number {
  const value = record[key];
  if (!isNonNegativeInteger(value)) {
    invalidArgument(`${key} must be a non-negative integer`, [key]);
  }
  return value as number;
}

/** Region volume, or the volume's occupied count when region is absent. */
function regionVolumeOrOccupied(
  ctx: MutationToolContext,
  volumeId: ReturnType<typeof requireVolumeId>,
  region: ReturnType<typeof requireOptionalRegion>,
): number {
  if (region !== undefined) return regionVolume(region);
  const view = ctx.store.getVolume(volumeId);
  return view === undefined ? 0 : view.occupiedCount();
}
