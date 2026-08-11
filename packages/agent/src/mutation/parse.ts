import type {
  CommandId,
  JsonValue,
  MaterialId,
  NodeId,
  VolumeId,
} from "@voxel-maker/shared";
import { commandId, materialId, nodeId, volumeId } from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import type { DocumentStoreRead } from "@voxel-maker/document";
import {
  invalidArgument,
  missingReference,
  mutationLimit,
} from "../contract.js";
import {
  isVec3,
  isVec3i,
  requireRegion,
  UNKNOWN_MATERIAL_CODE,
} from "../tools/helpers.js";
export { isVec3i, requireRegion, UNKNOWN_MATERIAL_CODE };
import type { MutationToolContext } from "./context.js";

/**
 * Argument parsing helpers for the mutation tools (plan S11.5): every
 * untrusted value is bounded and validated before a command constructor
 * runs, and reference checks report the stable missing-reference errors
 * used across the agent surface.
 */

const MAX_ID_LENGTH = 128;

/** Validates one string argument and returns it. */
export function requireString(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH
  ) {
    invalidArgument(
      `${key} must be a non-empty string of at most ${String(MAX_ID_LENGTH)} characters`,
      [key],
    );
  }
  return value;
}

/** Optional string argument; absent returns undefined. */
export function requireOptionalString(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return requireString(record, key);
}

/**
 * Resolves the command id: the explicit `commandId` argument when present
 * (bounded, then branded), otherwise a deterministic id generated from the
 * tool name, the base revision, and the per-mutator call sequence. The
 * base revision namespaces the fallback per run (issue #115): the
 * per-mutator sequence alone restarts at 0 for every run, so two runs
 * that omit an explicit commandId would mint the same ids and the second
 * Apply would fail with DUPLICATE_COMMAND_ID. Committed runs on a bus
 * always observe distinct base revisions (a stale preview is rejected at
 * creation), keeping the ids unique while staying deterministic.
 */
export function resolveCommandId(
  ctx: MutationToolContext,
  record: Readonly<Record<string, JsonValue>>,
): CommandId {
  const explicit = record.commandId;
  if (explicit !== undefined) {
    if (
      typeof explicit !== "string" ||
      explicit.length === 0 ||
      explicit.length > MAX_ID_LENGTH
    ) {
      invalidArgument(
        `commandId must be a non-empty string of at most ${String(MAX_ID_LENGTH)} characters`,
        ["commandId"],
      );
    }
    return commandId(explicit);
  }
  return commandId(
    `command:${ctx.toolName}:${String(ctx.baseRevision)}:${String(ctx.commandSequence)}`,
  );
}

/** Bounded node id argument (existence is checked by the caller). */
export function requireNodeId(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): NodeId {
  return nodeId(requireString(record, key));
}

/** Bounded volume id argument (existence is checked by the caller). */
export function requireVolumeId(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): VolumeId {
  return volumeId(requireString(record, key));
}

/** Validates an integer material id argument (1..65535). */
export function requireMaterialId(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): MaterialId {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    invalidArgument(`${key} must be an integer from 1 through 65535`, [key]);
  }
  return materialId(value);
}

/** Looks up a material record or throws the stable missing error. */
export function requireExistingMaterial(
  store: DocumentStoreRead,
  id: MaterialId,
): void {
  if (store.getDocument().materials[id] === undefined) {
    missingReference("material", String(id), UNKNOWN_MATERIAL_CODE);
  }
}

/** Validates a transform argument; the command constructor canonicalizes. */
export function requireTransform(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): {
  readonly translation: readonly [number, number, number];
  readonly pivot: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
} {
  const value = record[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidArgument(`${key} must be an object`, [key]);
  }
  const transform = value as Readonly<Record<string, JsonValue>>;
  const translation = transform.translation;
  const pivot = transform.pivot;
  const rotation = transform.rotation;
  const scale = transform.scale;
  if (
    translation === undefined ||
    pivot === undefined ||
    rotation === undefined ||
    scale === undefined ||
    !isVec3(translation) ||
    !isVec3(pivot) ||
    !isVec3(scale) ||
    !Array.isArray(rotation) ||
    rotation.length !== 4 ||
    !rotation.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    invalidArgument(
      `${key} must carry translation, pivot, scale [x,y,z] and rotation [x,y,z,w]`,
      [key],
    );
  }
  return {
    translation: translation as readonly [number, number, number],
    pivot: pivot as readonly [number, number, number],
    rotation: rotation as unknown as readonly [number, number, number, number],
    scale: scale as readonly [number, number, number],
  };
}

/** Identity transform used when a tool call omits `transform`. */
export const IDENTITY_TRANSFORM = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

/** Resolves the optional transform argument (identity default). */
export function requireOptionalTransform(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): ReturnType<typeof requireTransform> {
  if (record[key] === undefined) return IDENTITY_TRANSFORM;
  return requireTransform(record, key);
}

/** Validates a shape axis argument. */
export function requireAxis(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): "x" | "y" | "z" {
  const value = record[key];
  if (value !== "x" && value !== "y" && value !== "z") {
    invalidArgument(`${key} must be one of "x", "y", "z"`, [key]);
  }
  return value;
}

/** Validates an exact quarter-turn argument (1, 2, or 3). */
export function requireQuarterTurns(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): 1 | 2 | 3 {
  const value = record[key];
  if (value !== 1 && value !== 2 && value !== 3) {
    invalidArgument(`${key} must be 1, 2, or 3`, [key]);
  }
  return value;
}

/** Validates an optional non-negative integer (insertion index). */
export function requireOptionalIndex(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalidArgument(`${key} must be a non-negative integer`, [key]);
  }
  return value;
}

/** Validates an optional components array (items validated at stage time). */
export function requireOptionalComponents(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): readonly JsonValue[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "object" && item !== null)
  ) {
    invalidArgument(`${key} must be an array of component objects`, [key]);
  }
  return value as readonly JsonValue[];
}

/** Validates an optional metadata object (bounded at stage time). */
export function requireOptionalMetadata(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): Readonly<Record<string, JsonValue>> | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidArgument(`${key} must be an object`, [key]);
  }
  return value as Readonly<Record<string, JsonValue>>;
}

/** Validates an optional region argument. */
export function requireOptionalRegion(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): IntAabb | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return requireRegion(value, key);
}

/** Bounded count of a batch argument against the configured limit. */
export function requireBatchLength(
  length: number,
  limit: number,
  path: readonly (string | number)[],
): void {
  if (length > limit) {
    mutationLimit("maxBatchEntries", length, limit, path);
  }
}

/** Number of voxels in a half-open region (the conservative estimate). */
export function regionVolume(region: IntAabb): number {
  return (
    (region.max[0] - region.min[0]) *
    (region.max[1] - region.min[1]) *
    (region.max[2] - region.min[2])
  );
}

/** Volume of the axis-aligned box that contains a sphere of `radius`. */
export function sphereEstimate(radius: number): number {
  const diameter = 2 * Math.ceil(radius) + 1;
  return diameter * diameter * diameter;
}

/** Volume of the axis-aligned box that contains a cylinder. */
export function cylinderEstimate(radius: number, height: number): number {
  const diameter = 2 * Math.ceil(radius) + 1;
  return diameter * diameter * Math.max(1, Math.ceil(height));
}

/** True when `value` is a valid non-negative integer dimension. */
export function isNonNegativeInteger(value: JsonValue | undefined): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Validates one batch entry `{ coordinate, material }`. */
export function requireBatchEntry(
  record: Readonly<Record<string, JsonValue>>,
  path: readonly (string | number)[],
): { readonly coordinate: Vec3i; readonly material: MaterialId } {
  const coordinate = record.coordinate;
  const material = record.material;
  if (!isVec3i(coordinate)) {
    invalidArgument("entry coordinate must be an integer [x, y, z]", [
      ...path,
      "coordinate",
    ]);
  }
  if (
    typeof material !== "number" ||
    !Number.isInteger(material) ||
    material < 1 ||
    material > 65_535
  ) {
    invalidArgument("entry material must be an integer from 1 through 65535", [
      ...path,
      "material",
    ]);
  }
  return {
    coordinate: coordinate as Vec3i,
    material: materialId(material),
  };
}

/** Validates an optional placement argument for reparentNode. */
export function requirePlacement(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): "preserve-local" | "preserve-world" | "set-transform" {
  const value = record[key];
  if (
    value !== "preserve-local" &&
    value !== "preserve-world" &&
    value !== "set-transform"
  ) {
    invalidArgument(
      `${key} must be one of "preserve-local", "preserve-world", "set-transform"`,
      [key],
    );
  }
  return value;
}

/** Optional color argument; validated by the command constructor. */
export function requireOptionalColor(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length !== 7 || value[0] !== "#") {
    invalidArgument(`${key} must be a canonical #rrggbb color`, [key]);
  }
  return value;
}

/** Optional finite number argument within `[min, max]`. */
export function requireOptionalNumber(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    invalidArgument(
      `${key} must be a finite number in [${String(min)}, ${String(max)}]`,
      [key],
    );
  }
  return value;
}
