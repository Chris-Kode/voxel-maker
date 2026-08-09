/**
 * Minimal JSON Schema (draft-07 subset) used by the inspection tool
 * contracts (plan S11.1). The subset covers every construct the v1 tool
 * schemas need: typed values, required object properties, closed objects,
 * arrays with homogeneous items, enums, constants, numeric/string bounds,
 * and `anyOf` alternatives. Contracts and arguments stay plain JSON so a
 * provider-neutral agent can consume them without this package.
 */

/** JSON Schema value type names supported by the v1 validator. */
export type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "null";

/** A JSON Schema document (draft-07 subset) for one tool boundary. */
export interface JsonSchema {
  readonly type?: JsonSchemaType;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  /** When false, object inputs with unknown properties are rejected. */
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly const?: string | number | boolean | null;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly anyOf?: readonly JsonSchema[];
}

const PROPERTY_PATH = Symbol("property-path");

/** Error accumulator that renders `property: message` strings. */
type SchemaError = {
  readonly [PROPERTY_PATH]: readonly (string | number)[];
  readonly message: string;
};

function errorAt(
  path: readonly (string | number)[],
  message: string,
): SchemaError {
  return { [PROPERTY_PATH]: path, message };
}

function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return "$";
  return `$${path
    .map((part) =>
      typeof part === "number" ? `[${String(part)}]` : `.${part}`,
    )
    .join("")}`;
}

function matchesOneOf(
  schema: JsonSchema,
  value: unknown,
  path: readonly (string | number)[],
  errors: SchemaError[],
  depth: number,
): boolean {
  for (const alternative of schema.anyOf ?? []) {
    const alternativeErrors: SchemaError[] = [];
    validateValue(alternative, value, path, alternativeErrors, depth + 1);
    if (alternativeErrors.length === 0) return true;
  }
  errors.push(
    errorAt(
      path,
      `value does not match any of the ${String(schema.anyOf?.length ?? 0)} allowed alternatives`,
    ),
  );
  return false;
}

/**
 * Validates a plain JSON value against a schema (draft-07 subset). Pushes a
 * stable, path-prefixed message per violation and returns true when the
 * value is valid. `value` is never mutated and nothing is allocated beyond
 * the error list; validation is deterministic and side-effect free.
 */
/**
 * Hard nesting cap for schema validation (issue #44): tool arguments are
 * untrusted provider output, so a pathologically nested value must fail
 * validation instead of overflowing the stack. 64 levels is far above any
 * v1 tool contract.
 */
export const SCHEMA_MAX_DEPTH = 64;

export function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: readonly (string | number)[] = [],
  errors: SchemaError[] = [],
  depth = 0,
): boolean {
  if (depth > SCHEMA_MAX_DEPTH) {
    errors.push(
      errorAt(path, `value exceeds the maximum nesting depth of ${String(SCHEMA_MAX_DEPTH)}`),
    );
    return false;
  }
  const type = schema.type;
  if (type === undefined && schema.anyOf !== undefined) {
    return matchesOneOf(schema, value, path, errors, depth);
  }
  const valueType =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      errors.push(errorAt(path, "expected an integer"));
      return false;
    }
  } else if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(errorAt(path, "expected a finite number"));
      return false;
    }
  } else if (type !== undefined && type !== valueType) {
    errors.push(errorAt(path, `expected ${type}, got ${valueType}`));
    return false;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(errorAt(path, `must be >= ${String(schema.minimum)}`));
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(errorAt(path, `must be <= ${String(schema.maximum)}`));
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(
        errorAt(
          path,
          `must be at least ${String(schema.minLength)} characters`,
        ),
      );
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(
        errorAt(path, `must be at most ${String(schema.maxLength)} characters`),
      );
    }
  }
  if (
    schema.enum !== undefined &&
    !schema.enum.some((candidate) => candidate === value)
  ) {
    errors.push(errorAt(path, "value is not one of the allowed enum values"));
  }
  if (schema.const !== undefined && schema.const !== value) {
    errors.push(
      errorAt(path, `must equal the constant ${JSON.stringify(schema.const)}`),
    );
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(
        errorAt(path, `must contain at least ${String(schema.minItems)} items`),
      );
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(
        errorAt(path, `must contain at most ${String(schema.maxItems)} items`),
      );
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        validateValue(schema.items, value[index], [...path, index], errors, depth + 1);
      }
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Readonly<Record<string, unknown>>;
    for (const requiredKey of schema.required ?? []) {
      if (!(requiredKey in record)) {
        errors.push(errorAt([...path, requiredKey], "is a required property"));
      }
    }
    for (const key of Object.keys(record)) {
      if (
        schema.additionalProperties === false &&
        schema.properties?.[key] === undefined
      ) {
        errors.push(errorAt([...path, key], "is not an allowed property"));
        continue;
      }
      const propertySchema = schema.properties?.[key];
      if (propertySchema !== undefined) {
        validateValue(propertySchema, record[key], [...path, key], errors, depth + 1);
      }
    }
  }
  return errors.length === 0;
}

/** One structured validation error with its JSON path. */
export interface SchemaErrorDetail {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** Structured validation errors (paths are JSON-pointer-ish segments). */
export function schemaErrorDetails(
  schema: JsonSchema,
  value: unknown,
): readonly SchemaErrorDetail[] {
  const errors: SchemaError[] = [];
  validateValue(schema, value, [], errors);
  return errors.map((error) => ({
    path: error[PROPERTY_PATH],
    message: error.message,
  }));
}

/** Formatted, stable validation errors (e.g. `$.region.min: expected an integer`). */
export function schemaErrors(
  schema: JsonSchema,
  value: unknown,
): readonly string[] {
  return schemaErrorDetails(schema, value).map(
    (error) => `${formatPath(error.path)}: ${error.message}`,
  );
}

/** True when the value satisfies the schema. */
export function isValidValue(schema: JsonSchema, value: unknown): boolean {
  return schemaErrors(schema, value).length === 0;
}
