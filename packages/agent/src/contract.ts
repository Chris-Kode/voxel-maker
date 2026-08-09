import { WorkspaceError, type JsonValue } from "@voxel-maker/shared";
import type { JsonSchema } from "./schema.js";

/**
 * Provider-neutral tool contract (plan S11.1): a versioned JSON-Schema
 * name/description/input/output pair plus a capability flag. Contracts are
 * plain frozen JSON so any provider adapter can consume them without this
 * package; the `agent` package is the single source for the v1 surface.
 */

/** Contract version of the v1 inspection surface. */
export const INSPECTION_CONTRACT_VERSION = 1;

/**
 * Capability classes (plan S11.9): inspection is authorized separately
 * from mutation. The v1 surface ships inspection tools only; mutation
 * capability exists so sessions can prove the split and later stages add
 * mutation tools behind the same registry.
 */
export type ToolCapability = "inspect" | "mutate";

/** Stable, user-safe error data serialized for failed tool calls. */
export type ToolError = {
  readonly family:
    | "validation"
    | "conflict"
    | "limit"
    | "io"
    | "compatibility"
    | "internal";
  readonly code: string;
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly context?: Readonly<Record<string, JsonValue>>;
};

/** One versioned tool contract. */
export interface ToolContract {
  /** Stable tool name used in tool calls (kebab-case). */
  readonly name: string;
  /** Short description of what the tool returns. */
  readonly description: string;
  /** Contract version (1 for the v1 inspection surface). */
  readonly version: number;
  /** Capability class required to call the tool. */
  readonly capability: ToolCapability;
  /** JSON Schema (draft-07 subset) of the tool arguments. */
  readonly inputSchema: JsonSchema;
  /** JSON Schema (draft-07 subset) of the successful response. */
  readonly outputSchema: JsonSchema;
}

/**
 * Coordinate conventions explained in every response (AC: responses
 * explain coordinate conventions). Kept as one compact constant so every
 * tool shares the exact same wording.
 */
export const COORDINATE_CONVENTIONS =
  "Integer voxel coordinates per axis; regions are half-open [min, max) with min <= max per axis; " +
  "node transforms use T(translation) x T(pivot) x R(rotation) x S(scale) x T(-pivot); " +
  "rotations are quaternions [x,y,z,w] with w > 0; world transforms are decomposed to the same TRS convention; " +
  "ray and distance values are world-space units.";

/** Base response fields shared by every successful inspection response. */
export const BASE_RESPONSE_PROPERTIES = {
  tool: { type: "string" as const },
  contractVersion: { const: INSPECTION_CONTRACT_VERSION },
  documentId: { type: "string" as const },
  revision: { type: "integer" as const, minimum: 0 },
  conventions: { type: "string" as const },
  truncated: { type: "boolean" as const },
  truncatedReason: { type: "string" as const },
} satisfies Readonly<Record<string, JsonSchema>>;

/** Required envelope fields of every successful response. */
export const BASE_RESPONSE_REQUIRED = [
  "tool",
  "contractVersion",
  "documentId",
  "revision",
  "conventions",
  "truncated",
] as const;

/** Builds the output schema of one tool from its payload properties. */
export function outputSchema(
  toolName: string,
  payload: Readonly<Record<string, JsonSchema>>,
  requiredPayload: readonly string[],
): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...BASE_RESPONSE_PROPERTIES,
      tool: { enum: [toolName] },
      ...payload,
    },
    required: [...BASE_RESPONSE_REQUIRED, ...requiredPayload],
  };
}

/** JSON Schema of a three-number vector (real coordinates). */
export function vec3Schema(): JsonSchema {
  return numberArraySchema(3, 3);
}

/** JSON Schema of a three-integer vector (voxel coordinates). */
export function vec3iSchema(): JsonSchema {
  return {
    type: "array",
    items: { type: "integer" },
    minItems: 3,
    maxItems: 3,
  };
}

/** JSON Schema of a four-number quaternion `[x, y, z, w]`. */
export function quatSchema(): JsonSchema {
  return numberArraySchema(4, 4);
}

/** JSON Schema of a numeric array with a fixed item range. */
export function numberArraySchema(
  minItems: number,
  maxItems: number,
): JsonSchema {
  return {
    type: "array",
    items: { type: "number" },
    minItems,
    maxItems,
  };
}

/** JSON Schema of a half-open integer region `{ min, max }`. */
export function regionSchema(integer = true): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      min: integer ? vec3iSchema() : vec3Schema(),
      max: integer ? vec3iSchema() : vec3Schema(),
    },
    required: ["min", "max"],
  };
}

/** JSON Schema of a canonical node transform (translation/pivot/rotation/scale). */
export function transformSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      translation: vec3Schema(),
      pivot: vec3Schema(),
      rotation: quatSchema(),
      scale: vec3Schema(),
    },
    required: ["translation", "pivot", "rotation", "scale"],
  };
}

/** JSON Schema of a decomposed world transform (translation/rotation/scale). */
export function worldTransformSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      translation: vec3Schema(),
      rotation: quatSchema(),
      scale: vec3Schema(),
    },
    required: ["translation", "rotation", "scale"],
  };
}

/** Stable error code for malformed tool arguments. */
export const INVALID_ARGUMENT_CODE = "INVALID_ARGUMENT";

/** Stable error code for arguments that exceed a configured inspection limit. */
export const INSPECTION_LIMIT_CODE = "INSPECTION_LIMIT";

/** Throws the stable malformed-argument error for a tool call. */
export function invalidArgument(
  message: string,
  path?: readonly (string | number)[],
): never {
  throw new WorkspaceError({
    family: "validation",
    code: INVALID_ARGUMENT_CODE,
    message,
    ...(path === undefined ? {} : { path }),
  });
}

/**
 * Throws the stable limit error (plan S11.10): a caller-supplied value
 * exceeds the configured inspection budget. `limit` names the budget
 * (pageSize, maxDepth, maxVoxels, maxSteps).
 */
export function inspectionLimit(
  limit: string,
  value: number,
  max: number,
  path: readonly (string | number)[],
): never {
  throw new WorkspaceError({
    family: "limit",
    code: INSPECTION_LIMIT_CODE,
    message: `${limit} must be <= ${String(max)} (requested ${String(value)})`,
    path,
    context: { limit, value, max },
  });
}

/** Throws the stable missing-reference error for one id lookup. */
export function missingReference(
  kind: string,
  id: string,
  code: string,
): never {
  throw new WorkspaceError({
    family: "validation",
    code,
    message: `Unknown ${kind}: ${id}`,
    context: { [kind]: id },
  });
}
