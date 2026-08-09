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

/** Stable error code for malformed tool arguments. */
export const INVALID_ARGUMENT_CODE = "INVALID_ARGUMENT";

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
