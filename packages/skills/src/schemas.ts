import { WorkspaceError } from "@voxel-maker/shared";
import type { JsonSchema } from "@voxel-maker/agent";
import type { IntAabb } from "./geometry.js";

/**
 * Shared JSON-Schema fragments and semantic validators for generator
 * parameters (plan S14.3). Every bound mirrors a hard engine limit
 * (coordinate interval, region extent), so a validated proposal can
 * never ask the engine for an out-of-range or unbounded operation.
 */

/** Hard coordinate interval bound (ARCHITECTURE.md default limits). */
export const MAX_COORDINATE = 1_048_575;
/** Hard region extent bound per axis (ARCHITECTURE.md default limits). */
export const MAX_REGION_EXTENT = 2_048;

/** Integer vector schema with the engine's coordinate interval bounds. */
export const VEC3I_SCHEMA: JsonSchema = {
  type: "array",
  items: {
    type: "integer",
    minimum: -MAX_COORDINATE,
    maximum: MAX_COORDINATE,
  },
  minItems: 3,
  maxItems: 3,
};

/** Half-open region schema `{ min, max }` with bounded coordinates. */
export const REGION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    min: VEC3I_SCHEMA,
    max: VEC3I_SCHEMA,
  },
  required: ["min", "max"],
};

/** Axis enum matching the engine ShapeAxis values. */
export const AXIS_SCHEMA: JsonSchema = {
  type: "string",
  enum: ["x", "y", "z"],
};

/** Bounded positive integer schema. */
export function boundedIntSchema(minimum: number, maximum: number): JsonSchema {
  return { type: "integer", minimum, maximum };
}

/** Positive integer size triple (each component 1..MAX_REGION_EXTENT). */
export const VEC3_SIZE_SCHEMA: JsonSchema = {
  type: "array",
  items: { type: "integer", minimum: 1, maximum: MAX_REGION_EXTENT },
  minItems: 3,
  maxItems: 3,
};

/** Throws the stable invalid-params error with a field path. */
export function invalidGeneratorParams(
  message: string,
  path?: readonly (string | number)[],
): never {
  throw new WorkspaceError({
    family: "validation",
    code: "INVALID_GENERATOR_PARAMS",
    message,
    ...(path === undefined ? {} : { path }),
  });
}

/**
 * Semantic region check: half-open order and per-axis extent. Throws the
 * stable INVALID_GENERATOR_PARAMS error with the field path.
 */
export function requireValidRegion(
  region: IntAabb,
  path: readonly (string | number)[],
): void {
  for (let axis = 0; axis < 3; axis += 1) {
    const min = region.min[axis] as number;
    const max = region.max[axis] as number;
    if (min > max) {
      invalidGeneratorParams(
        "region must satisfy min <= max on every axis",
        path,
      );
    }
    if (max - min > MAX_REGION_EXTENT) {
      invalidGeneratorParams(
        `region extent per axis must be at most ${String(MAX_REGION_EXTENT)}`,
        path,
      );
    }
  }
}

/** True when a region is strictly inside another (half-open containment). */
export function regionInside(inner: IntAabb, outer: IntAabb): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (
      (inner.min[axis] as number) < (outer.min[axis] as number) ||
      (inner.max[axis] as number) > (outer.max[axis] as number)
    ) {
      return false;
    }
  }
  return true;
}
