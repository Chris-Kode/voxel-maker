import {
  WorkspaceError,
  type CommandId,
  type NodeId,
} from "@voxel-maker/shared";
import {
  eulerXYZToQuaternion,
  quaternionToEulerXYZ,
  type Quat,
  type Transform,
  type Vec3,
} from "@voxel-maker/math";
import {
  setNodeComponentsCommand,
  setNodeMetadataCommand,
  setNodeTransformCommand,
  type Command,
} from "@voxel-maker/commands";
import type { Component, MetadataRecord } from "@voxel-maker/model";

/**
 * Headless inspector semantics (plan S7.12, ticket #20): validated text
 * parsing for transform fields, mixed multi-selection resolution, and
 * command construction for transform/component/metadata edits. React
 * widgets only render and forward; every edit is validated here or by the
 * command bus, and every commit goes through the bus (ARCHITECTURE.md
 * "Editor interaction"). Numbers are finite and never serialized -0;
 * rotation text is Euler XYZ degrees (matching the rotate gizmo).
 */

/** One editable transform field. */
export type TransformField =
  | "translation"
  | "rotation"
  | "scale"
  | "pivot";

/** Result of resolving one field across a multi-selection. */
export type FieldValue =
  | { readonly kind: "value"; readonly value: Vec3 }
  | { readonly kind: "mixed" };

const NUMBER_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

function parseFinite(text: string, field: string): number {
  const trimmed = text.trim();
  if (!NUMBER_PATTERN.test(trimmed)) {
    throw inputError(field, `Expected a finite number, got "${trimmed}"`);
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw inputError(field, `Expected a finite number, got "${trimmed}"`);
  }
  return Object.is(value, -0) ? 0 : value;
}

/** Parses "x, y, z" or "x y z" into a canonical finite vector. */
export function parseVec3Input(text: string, field: string): Vec3 {
  const parts = text
    .split(/[,\s]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length !== 3) {
    throw inputError(field, "Expected exactly three numbers (x, y, z)");
  }
  const values = parts.map((part) => parseFinite(part, field));
  return [values[0] as number, values[1] as number, values[2] as number];
}

/**
 * Parses Euler XYZ degrees ("rx, ry, rz") into a canonical unit
 * quaternion. The angles are converted with `eulerXYZToQuaternion`, the
 * same convention the gizmo and the model use.
 */
export function parseRotationDegreesInput(text: string): Quat {
  const euler = parseVec3Input(text, "rotation");
  return eulerXYZToQuaternion([
    (euler[0] * Math.PI) / 180,
    (euler[1] * Math.PI) / 180,
    (euler[2] * Math.PI) / 180,
  ]);
}

/** Parses a scale vector; components must be strictly positive. */
export function parseScaleInput(text: string): Vec3 {
  const scale = parseVec3Input(text, "scale");
  for (let axis = 0; axis < 3; axis += 1) {
    if ((scale[axis] as number) <= 0) {
      throw inputError("scale", "Scale components must be strictly positive");
    }
  }
  return scale;
}

/** Formats a number for an inspector field (no trailing zeros). */
export function formatNumber(value: number): string {
  if (Object.is(value, -0)) return "0";
  const rounded = Math.round(value * 1e4) / 1e4;
  return String(rounded);
}

/** Formats a vector as "x, y, z" for an inspector field. */
export function formatVec3(value: Vec3): string {
  return value.map(formatNumber).join(", ");
}

/** Formats a quaternion as Euler XYZ degrees for an inspector field. */
export function formatRotationDegrees(rotation: Quat): string {
  const euler = quaternionToEulerXYZ(rotation);
  return formatVec3([
    (euler[0] * 180) / Math.PI,
    (euler[1] * 180) / Math.PI,
    (euler[2] * 180) / Math.PI,
  ]);
}

/**
 * Resolves one transform field across the selected nodes: when every node
 * shares the exact value the field shows it, otherwise the field reports
 * "mixed" and edits apply to every selected node (plan S7.12).
 */
export function transformFieldValue(
  transforms: readonly Transform[],
  field: TransformField,
): FieldValue {
  if (transforms.length === 0) return { kind: "mixed" };
  const first = fieldValue(transforms[0] as Transform, field);
  for (const transform of transforms.slice(1)) {
    const next = fieldValue(transform, field);
    if (!vec3Equal(first, next)) return { kind: "mixed" };
  }
  return { kind: "value", value: first };
}

function fieldValue(transform: Transform, field: TransformField): Vec3 {
  switch (field) {
    case "translation":
      return transform.translation;
    case "rotation":
      return quaternionToEulerXYZ(transform.rotation);
    case "scale":
      return transform.scale;
    case "pivot":
      return transform.pivot;
  }
}

const vec3Equal = (a: Vec3, b: Vec3): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/**
 * Builds one `node.setTransform` command per selected node that replaces
 * the edited field and preserves every other field. `value` is the parsed
 * canonical field value (a quaternion for rotation, a vector otherwise).
 * Empty when no node changed.
 */
export function buildSetTransformFieldCommands(
  nextCommandId: () => CommandId,
  nodes: readonly { readonly nodeId: NodeId; readonly transform: Transform }[],
  field: TransformField,
  value: Vec3 | Quat,
): readonly Command[] {
  const commands: Command[] = [];
  for (const node of nodes) {
    const transform = applyField(node.transform, field, value);
    if (transformsEqual(transform, node.transform)) continue;
    commands.push(
      setNodeTransformCommand(nextCommandId(), {
        nodeId: node.nodeId,
        transform,
      }),
    );
  }
  return commands;
}

function applyField(
  transform: Transform,
  field: TransformField,
  value: Vec3 | Quat,
): Transform {
  switch (field) {
    case "translation":
      return { ...transform, translation: value as Vec3 };
    case "rotation":
      return { ...transform, rotation: value as Quat };
    case "scale":
      return { ...transform, scale: value as Vec3 };
    case "pivot":
      return { ...transform, pivot: value as Vec3 };
  }
}

const transformsEqual = (a: Transform, b: Transform): boolean =>
  vec3Equal(a.translation, b.translation) &&
  vec3Equal(a.pivot, b.pivot) &&
  a.rotation[0] === b.rotation[0] &&
  a.rotation[1] === b.rotation[1] &&
  a.rotation[2] === b.rotation[2] &&
  a.rotation[3] === b.rotation[3] &&
  vec3Equal(a.scale, b.scale);

/** Builds a `node.setComponents` command (single selection; plan S7.12). */
export function buildSetComponentsCommand(
  id: CommandId,
  nodeId: NodeId,
  components: readonly Component[],
): Command<"node.setComponents"> {
  return setNodeComponentsCommand(id, { nodeId, components });
}

/** Parses JSON metadata text; the bus enforces depth/byte limits. */
export function parseMetadataInput(text: string): MetadataRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw inputError("metadata", "Metadata must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw inputError("metadata", "Metadata must be a JSON object");
  }
  assertJsonValues(parsed, new Set<object>());
  return parsed as MetadataRecord;
}

function assertJsonValues(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw inputError("metadata", "Metadata numbers must be finite");
    }
    return;
  }
  if (typeof value !== "object") {
    throw inputError("metadata", "Metadata must contain only JSON values");
  }
  if (seen.has(value)) {
    throw inputError("metadata", "Metadata cannot contain cycles");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValues(item, seen);
  } else {
    for (const item of Object.values(value)) assertJsonValues(item, seen);
  }
  seen.delete(value);
}

/** Formats a metadata record for the inspector text area. */
export function formatMetadata(metadata: MetadataRecord): string {
  return JSON.stringify(metadata, null, 2);
}

/** Builds a `node.setMetadata` command; empty text removes the record. */
export function buildSetMetadataCommand(
  id: CommandId,
  nodeId: NodeId,
  text: string,
): Command<"node.setMetadata"> {
  return setNodeMetadataCommand(id, {
    nodeId,
    ...(text.trim().length === 0 ? {} : { metadata: parseMetadataInput(text) }),
  });
}

function inputError(field: string, message: string): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: "INVALID_INSPECTOR_INPUT",
    message,
    context: { field },
  });
}
