import {
  createMaterialCommand,
  deleteMaterialCommand,
  updateMaterialCommand,
} from "@voxel-maker/commands";
import type { JsonValue } from "@voxel-maker/shared";
import { mutationOutputSchema, type ToolContract } from "../contract.js";
import type { MutationToolContext, MutationPayload } from "./context.js";
import { canonicalColor, type Color } from "@voxel-maker/model";
import {
  requireExistingMaterial,
  requireMaterialId,
  requireOptionalColor,
  requireOptionalNumber,
  requireOptionalString,
  requireString,
  resolveCommandId,
} from "./parse.js";
import { estimateVoxelDelta } from "./estimate.js";
import { invalidArgument } from "../contract.js";

/**
 * Material mutation tools (plan S11.5, ticket #32): material record
 * lifecycle operations that compile only to registered commands with
 * explicit ids and the same canonical values the UI commands accept.
 */

/** `createMaterial` contract: construct a `material.create` command. */
export const CREATE_MATERIAL_CONTRACT: ToolContract = {
  name: "createMaterial",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered material.create command with an explicit material id (1..65535) and canonical color.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: { type: "string", minLength: 1, maxLength: 128 },
      materialId: { type: "integer", minimum: 1, maximum: 65535 },
      name: { type: "string", minLength: 1, maxLength: 128 },
      color: { type: "string", minLength: 7, maxLength: 7 },
      opacity: { type: "number", minimum: 0, maximum: 1 },
      roughness: { type: "number", minimum: 0, maximum: 1 },
      metallic: { type: "number", minimum: 0, maximum: 1 },
      emissive: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["materialId", "name", "color"],
  },
  outputSchema: mutationOutputSchema("createMaterial"),
};

/** `updateMaterial` contract: construct a `material.update` command. */
export const UPDATE_MATERIAL_CONTRACT: ToolContract = {
  name: "updateMaterial",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered material.update command; every field is optional and only supplied fields change.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: { type: "string", minLength: 1, maxLength: 128 },
      materialId: { type: "integer", minimum: 1, maximum: 65535 },
      name: { type: "string", minLength: 1, maxLength: 128 },
      color: { type: "string", minLength: 7, maxLength: 7 },
      opacity: { type: "number", minimum: 0, maximum: 1 },
      roughness: { type: "number", minimum: 0, maximum: 1 },
      metallic: { type: "number", minimum: 0, maximum: 1 },
      emissive: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["materialId"],
  },
  outputSchema: mutationOutputSchema("updateMaterial"),
};

/** `deleteMaterial` contract: construct a `material.delete` command. */
export const DELETE_MATERIAL_CONTRACT: ToolContract = {
  name: "deleteMaterial",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered material.delete command. A referenced material requires an explicit replacement material id; absent when unreferenced.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: { type: "string", minLength: 1, maxLength: 128 },
      materialId: { type: "integer", minimum: 1, maximum: 65535 },
      replacement: { type: "integer", minimum: 1, maximum: 65535 },
    },
    required: ["materialId"],
  },
  outputSchema: mutationOutputSchema("deleteMaterial"),
};

export function createMaterial(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const materialIdValue = requireMaterialId(record, "materialId");
  if (ctx.store.getDocument().materials[materialIdValue] !== undefined) {
    invalidArgument("materialId already exists in the document", [
      "materialId",
    ]);
  }
  const name = requireString(record, "name");
  const color = requireColor(record);
  const command = createMaterialCommand(resolveCommandId(ctx, record), {
    materialId: materialIdValue,
    name,
    color,
    opacity: requireOptionalNumber(record, "opacity", 0, 1) ?? 1,
    roughness: requireOptionalNumber(record, "roughness", 0, 1) ?? 0.5,
    metallic: requireOptionalNumber(record, "metallic", 0, 1) ?? 0,
    emissive: requireOptionalNumber(record, "emissive", 0, 1) ?? 0,
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

export function updateMaterial(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const materialIdValue = requireMaterialId(record, "materialId");
  requireExistingMaterial(ctx.store, materialIdValue);
  const name = requireOptionalString(record, "name");
  const color = requireOptionalColor(record, "color");
  const opacity = requireOptionalNumber(record, "opacity", 0, 1);
  const roughness = requireOptionalNumber(record, "roughness", 0, 1);
  const metallic = requireOptionalNumber(record, "metallic", 0, 1);
  const emissive = requireOptionalNumber(record, "emissive", 0, 1);
  const command = updateMaterialCommand(resolveCommandId(ctx, record), {
    materialId: materialIdValue,
    ...(name === undefined ? {} : { name }),
    ...(color === undefined ? {} : { color: canonicalColor(color) }),
    ...(opacity === undefined ? {} : { opacity }),
    ...(roughness === undefined ? {} : { roughness }),
    ...(metallic === undefined ? {} : { metallic }),
    ...(emissive === undefined ? {} : { emissive }),
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

export function deleteMaterial(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const materialIdValue = requireMaterialId(record, "materialId");
  requireExistingMaterial(ctx.store, materialIdValue);
  const replacement = record.replacement;
  let replacementId: ReturnType<typeof requireMaterialId> | undefined;
  if (replacement !== undefined) {
    replacementId = requireMaterialId(record, "replacement");
    requireExistingMaterial(ctx.store, replacementId);
  }
  const command = deleteMaterialCommand(resolveCommandId(ctx, record), {
    materialId: materialIdValue,
    ...(replacementId === undefined ? {} : { replacement: replacementId }),
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

/** Validates a required canonical #rrggbb color argument. */
function requireColor(record: Readonly<Record<string, JsonValue>>): Color {
  const value = requireOptionalColor(record, "color");
  if (value === undefined) {
    invalidArgument("color must be a canonical #rrggbb color", ["color"]);
  }
  return canonicalColor(value);
}
