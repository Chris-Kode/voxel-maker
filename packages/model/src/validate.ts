import { isCanonicalQuat, isNormalizedQuat } from "@voxel-maker/math";
import { CURRENT_DOCUMENT_SCHEMA_VERSION } from "./migration.js";
import { compareCodeUnit, compareNumeric } from "./order.js";
import type { AnimationDescriptor, SceneNode, VoxelDocument } from "./types.js";
import { isCanonicalColor } from "./color.js";
import { DEFAULT_DOCUMENT_LIMITS, type DocumentLimits } from "./limits.js";

/** A stable, user-safe validation finding with a JSON-ish path and code. */
export interface DocumentIssue {
  readonly family: "validation" | "limit" | "compatibility";
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

type Issue = DocumentIssue;
type Path = readonly (string | number)[];

const issue = (
  family: Issue["family"],
  code: string,
  path: Path,
  message: string,
): Issue => ({ family, code, path, message });

const at = (path: Path, ...keys: (string | number)[]): Path => [
  ...path,
  ...keys,
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sortedKeys = (
  record: Readonly<Record<string, unknown>>,
  compare: (a: string, b: string) => number,
): readonly string[] => Object.keys(record).sort(compare);

function checkId(value: unknown, path: Path, issues: Issue[]): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    issues.push(
      issue(
        "validation",
        "INVALID_ID",
        path,
        "Identifiers must be non-empty strings of at most 128 characters",
      ),
    );
  }
}

function checkName(
  value: unknown,
  path: Path,
  issues: Issue[],
  limits: DocumentLimits,
): void {
  if (typeof value !== "string") {
    issues.push(
      issue("validation", "INVALID_NAME", path, "Name must be a string"),
    );
    return;
  }
  if (new TextEncoder().encode(value).byteLength > limits.maxNameBytes) {
    issues.push(
      issue(
        "validation",
        "INVALID_NAME",
        path,
        `Name exceeds the ${String(limits.maxNameBytes)}-byte limit`,
      ),
    );
  }
}

function checkFiniteNumber(
  value: unknown,
  path: Path,
  issues: Issue[],
  message = "Numbers must be finite and must not be negative zero",
): void {
  if (typeof value !== "number") {
    issues.push(
      issue("validation", "INVALID_FIELD_TYPE", path, "Expected a number"),
    );
    return;
  }
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    issues.push(issue("validation", "INVALID_CANONICAL_NUMBER", path, message));
  }
}

function checkVec3(value: unknown, path: Path, issues: Issue[]): void {
  if (!Array.isArray(value) || value.length !== 3) {
    issues.push(
      issue(
        "validation",
        "INVALID_VECTOR",
        path,
        "Expected a 3-component vector",
      ),
    );
    return;
  }
  for (let i = 0; i < 3; i += 1) {
    checkFiniteNumber(value[i], at(path, i), issues);
  }
}

function checkVec3i(
  value: unknown,
  path: Path,
  issues: Issue[],
  limits: DocumentLimits,
): void {
  if (!Array.isArray(value) || value.length !== 3) {
    issues.push(
      issue(
        "validation",
        "INVALID_VECTOR",
        path,
        "Expected a 3-component integer vector",
      ),
    );
    return;
  }
  const values = value as unknown[];
  for (let i = 0; i < 3; i += 1) {
    const component = values[i];
    if (
      typeof component !== "number" ||
      !Number.isInteger(component) ||
      Math.abs(component) > limits.maxVoxelCoordinate
    ) {
      issues.push(
        issue(
          "validation",
          "INVALID_INTEGER_VECTOR",
          at(path, i),
          `Expected an integer within +-${String(limits.maxVoxelCoordinate)}`,
        ),
      );
    }
  }
}

function checkQuat(value: unknown, path: Path, issues: Issue[]): void {
  if (!Array.isArray(value) || value.length !== 4) {
    issues.push(
      issue(
        "validation",
        "INVALID_QUATERNION",
        path,
        "Expected a 4-component quaternion",
      ),
    );
    return;
  }
  for (let i = 0; i < 4; i += 1) {
    checkFiniteNumber(value[i], at(path, i), issues);
  }
  if (value.every((component) => Number.isFinite(component))) {
    const q = value as unknown as [number, number, number, number];
    if (!isNormalizedQuat(q)) {
      issues.push(
        issue(
          "validation",
          "INVALID_QUATERNION",
          path,
          "Quaternions must be normalized within the ADR-0001 epsilon",
        ),
      );
    } else if (!isCanonicalQuat(q)) {
      issues.push(
        issue(
          "validation",
          "NON_CANONICAL_QUATERNION",
          path,
          "Quaternions must use the ADR-0001 sign canonicalization",
        ),
      );
    }
  }
}

function checkTransform(value: unknown, path: Path, issues: Issue[]): void {
  if (!isRecord(value)) {
    issues.push(
      issue(
        "validation",
        "INVALID_TRANSFORM",
        path,
        "Expected a transform object",
      ),
    );
    return;
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "translation" &&
      key !== "pivot" &&
      key !== "rotation" &&
      key !== "scale"
    ) {
      issues.push(
        issue(
          "validation",
          "UNKNOWN_FIELD",
          at(path, key),
          `Unknown transform field ${key}`,
        ),
      );
    }
  }
  checkVec3(value.translation, at(path, "translation"), issues);
  checkVec3(value.pivot, at(path, "pivot"), issues);
  checkQuat(value.rotation, at(path, "rotation"), issues);
  const scale = value.scale;
  if (!Array.isArray(scale) || scale.length !== 3) {
    issues.push(
      issue(
        "validation",
        "INVALID_SCALE",
        at(path, "scale"),
        "Expected a 3-component scale vector",
      ),
    );
  } else {
    for (let i = 0; i < 3; i += 1) {
      checkFiniteNumber(scale[i], at(path, "scale", i), issues);
      if (
        typeof scale[i] === "number" &&
        Number.isFinite(scale[i]) &&
        scale[i] <= 0
      ) {
        issues.push(
          issue(
            "validation",
            "INVALID_SCALE",
            at(path, "scale", i),
            "Scale must be strictly positive",
          ),
        );
      }
    }
  }
}

function checkComponent(
  value: unknown,
  path: Path,
  issues: Issue[],
  seenKinds: Set<string>,
  seenComponentIds: Set<string>,
  volumes: Readonly<Set<string>>,
): void {
  if (!isRecord(value)) {
    issues.push(
      issue(
        "validation",
        "UNSUPPORTED_COMPONENT",
        path,
        "Expected a component object",
      ),
    );
    return;
  }
  const kind = value.kind;
  if (
    typeof kind !== "string" ||
    (kind !== "voxel" &&
      kind !== "pivot" &&
      kind !== "joint" &&
      kind !== "constraint")
  ) {
    issues.push(
      issue(
        "validation",
        "UNSUPPORTED_COMPONENT",
        at(path, "kind"),
        `Unsupported component kind ${String(kind)}`,
      ),
    );
    return;
  }
  if (seenKinds.has(kind)) {
    issues.push(
      issue(
        "validation",
        "DUPLICATE_COMPONENT",
        path,
        `Component kind ${kind} may occur at most once per node`,
      ),
    );
  }
  seenKinds.add(kind);
  if (value.schemaVersion !== 1) {
    issues.push(
      issue(
        "validation",
        "UNSUPPORTED_COMPONENT_VERSION",
        at(path, "schemaVersion"),
        "Unsupported component schema version",
      ),
    );
  }
  const allowed = new Set(["kind", "schemaVersion"]);
  switch (kind) {
    case "voxel": {
      allowed.add("volumeId");
      checkId(value.volumeId, at(path, "volumeId"), issues);
      if (typeof value.volumeId === "string" && !volumes.has(value.volumeId)) {
        issues.push(
          issue(
            "validation",
            "MISSING_REFERENCE",
            at(path, "volumeId"),
            "Voxel component references an unknown volume",
          ),
        );
      }
      break;
    }
    case "pivot":
      allowed.add("pivot");
      checkVec3(value.pivot, at(path, "pivot"), issues);
      break;
    case "joint":
      break;
    case "constraint": {
      allowed.add("constraints");
      if (!Array.isArray(value.constraints)) {
        issues.push(
          issue(
            "validation",
            "INVALID_CONSTRAINT",
            at(path, "constraints"),
            "Expected an array of constraints",
          ),
        );
        break;
      }
      value.constraints.forEach((constraint, index) => {
        checkConstraint(
          constraint,
          at(path, "constraints", index),
          issues,
          seenComponentIds,
        );
      });
      break;
    }
    default:
      break;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push(
        issue(
          "validation",
          "UNKNOWN_FIELD",
          at(path, key),
          `Unknown component field ${key}`,
        ),
      );
    }
  }
}

function checkConstraint(
  value: unknown,
  path: Path,
  issues: Issue[],
  seenComponentIds: Set<string>,
): void {
  if (!isRecord(value)) {
    issues.push(
      issue(
        "validation",
        "INVALID_CONSTRAINT",
        path,
        "Expected a constraint descriptor",
      ),
    );
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "componentId" && key !== "type" && key !== "limits") {
      issues.push(
        issue(
          "validation",
          "UNKNOWN_FIELD",
          at(path, key),
          `Unknown constraint field ${key}`,
        ),
      );
    }
  }
  checkId(value.componentId, at(path, "componentId"), issues);
  if (typeof value.componentId === "string") {
    if (seenComponentIds.has(value.componentId)) {
      issues.push(
        issue(
          "validation",
          "DUPLICATE_COMPONENT_ID",
          at(path, "componentId"),
          "Constraint component IDs must be unique within the document",
        ),
      );
    }
    seenComponentIds.add(value.componentId);
  }
  if (value.type !== "rotation-limits") {
    issues.push(
      issue(
        "validation",
        "INVALID_CONSTRAINT",
        at(path, "type"),
        "Unsupported constraint type",
      ),
    );
  }
  const limits = value.limits;
  if (!isRecord(limits)) {
    issues.push(
      issue(
        "validation",
        "INVALID_CONSTRAINT",
        at(path, "limits"),
        "Expected rotation limits",
      ),
    );
    return;
  }
  for (const key of Object.keys(limits)) {
    if (key !== "min" && key !== "max") {
      issues.push(
        issue(
          "validation",
          "UNKNOWN_FIELD",
          at(path, "limits", key),
          `Unknown limits field ${key}`,
        ),
      );
    }
  }
  const minPath = at(path, "limits", "min");
  const maxPath = at(path, "limits", "max");
  checkVec3(limits.min, minPath, issues);
  checkVec3(limits.max, maxPath, issues);
  const min = limits.min as readonly number[] | undefined;
  const max = limits.max as readonly number[] | undefined;
  checkMinMaxPerAxis(
    min,
    max,
    at(path, "limits"),
    issues,
    "INVALID_CONSTRAINT",
    (axis) => `Rotation limit minimum exceeds maximum on axis ${String(axis)}`,
  );
}

function checkMinMaxPerAxis(
  min: readonly number[] | undefined,
  max: readonly number[] | undefined,
  path: Path,
  issues: Issue[],
  code: string,
  message: (axis: number) => string,
): void {
  if (
    min === undefined ||
    max === undefined ||
    min.length !== 3 ||
    max.length !== 3
  ) {
    return;
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const minComponent = min[axis];
    const maxComponent = max[axis];
    if (
      minComponent !== undefined &&
      maxComponent !== undefined &&
      minComponent > maxComponent
    ) {
      issues.push(issue("validation", code, path, message(axis)));
    }
  }
}

function checkMetadata(
  value: unknown,
  path: Path,
  issues: Issue[],
  limits: DocumentLimits,
  state: { members: number; bytes: number },
): void {
  if (!isRecord(value)) {
    issues.push(
      issue(
        "validation",
        "INVALID_METADATA",
        path,
        "Metadata must be a JSON object",
      ),
    );
    return;
  }
  const visited = new Set<object>();
  const walk = (current: unknown, currentPath: Path, depth: number): void => {
    if (depth > limits.maxMetadataDepth) {
      issues.push(
        issue(
          "limit",
          "LIMIT_EXCEEDED",
          currentPath,
          `Metadata exceeds the maximum depth of ${String(limits.maxMetadataDepth)}`,
        ),
      );
      return;
    }
    if (current === null || typeof current !== "object") {
      if (typeof current === "number") {
        checkFiniteNumber(current, currentPath, issues);
      } else if (typeof current === "string") {
        const bytes = new TextEncoder().encode(current).byteLength;
        if (bytes > limits.maxMetadataStringBytes) {
          issues.push(
            issue(
              "limit",
              "LIMIT_EXCEEDED",
              currentPath,
              `Metadata string exceeds the ${String(limits.maxMetadataStringBytes)}-byte limit`,
            ),
          );
        }
      } else if (typeof current !== "boolean") {
        // Non-JSON values (undefined, functions, symbols, BigInt) must be
        // rejected before any accepted document is serialized; array holes
        // are reported separately by the index walk below.
        issues.push(
          issue(
            "validation",
            "INVALID_METADATA",
            currentPath,
            "Metadata must contain only JSON values",
          ),
        );
      }
      return;
    }
    if (visited.has(current)) {
      issues.push(
        issue(
          "validation",
          "INVALID_METADATA",
          currentPath,
          "Metadata cannot contain cycles",
        ),
      );
      return;
    }
    visited.add(current);
    if (Array.isArray(current)) {
      if (state.members + current.length > limits.maxMetadataMembers) {
        // Bound the index walk up front: a hostile sparse array can have an
        // enormous length with no allocated slots, so report the limit at
        // the array path instead of iterating every index.
        issues.push(
          issue(
            "limit",
            "LIMIT_EXCEEDED",
            currentPath,
            `Metadata member count exceeds the ${String(limits.maxMetadataMembers)}-member limit`,
          ),
        );
        visited.delete(current);
        return;
      }
      state.members += current.length;
      for (let index = 0; index < current.length; index += 1) {
        if (!(index in current)) {
          issues.push(
            issue(
              "validation",
              "SPARSE_ARRAY",
              at(currentPath, index),
              "Metadata arrays must not contain holes",
            ),
          );
          continue;
        }
        walk(current[index], at(currentPath, index), depth + 1);
      }
    } else {
      const record = current as Record<string, unknown>;
      state.members += Object.keys(record).length;
      for (const key of Object.keys(record).sort(compareCodeUnit)) {
        if (
          new TextEncoder().encode(key).byteLength >
          limits.maxMetadataStringBytes
        ) {
          issues.push(
            issue(
              "limit",
              "LIMIT_EXCEEDED",
              at(currentPath, key),
              `Metadata key exceeds the ${String(limits.maxMetadataStringBytes)}-byte limit`,
            ),
          );
        }
        walk(record[key], at(currentPath, key), depth + 1);
      }
    }
    visited.delete(current);
  };
  walk(value, path, 0);
  try {
    state.bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    issues.push(
      issue(
        "validation",
        "INVALID_METADATA",
        path,
        "Metadata cannot be serialized",
      ),
    );
  }
}

function checkNode(
  value: unknown,
  path: Path,
  issues: Issue[],
  limits: DocumentLimits,
  state: { members: number; bytes: number },
  seenComponentIds: Set<string>,
  volumes: Readonly<Set<string>>,
  expectedId: string,
): void {
  if (!isRecord(value)) {
    issues.push(
      issue("validation", "INVALID_NODE", path, "Expected a node object"),
    );
    return;
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "nodeId" &&
      key !== "name" &&
      key !== "parentId" &&
      key !== "children" &&
      key !== "transform" &&
      key !== "components" &&
      key !== "metadata"
    ) {
      issues.push(
        issue(
          "validation",
          "UNKNOWN_FIELD",
          at(path, key),
          `Unknown node field ${key}`,
        ),
      );
    }
  }
  checkId(value.nodeId, at(path, "nodeId"), issues);
  if (typeof value.nodeId === "string" && value.nodeId !== expectedId) {
    issues.push(
      issue(
        "validation",
        "MISMATCHED_RECORD_ID",
        at(path, "nodeId"),
        "Node record identifier does not match its record key",
      ),
    );
  }
  if (value.name !== undefined)
    checkName(value.name, at(path, "name"), issues, limits);
  if (value.parentId !== null) {
    checkId(value.parentId, at(path, "parentId"), issues);
  }
  if (!Array.isArray(value.children)) {
    issues.push(
      issue(
        "validation",
        "INVALID_FIELD_TYPE",
        at(path, "children"),
        "Expected an array of child identifiers",
      ),
    );
  } else {
    const seen = new Set<string>();
    value.children.forEach((child, index) => {
      checkId(child, at(path, "children", index), issues);
      if (typeof child === "string") {
        if (seen.has(child)) {
          issues.push(
            issue(
              "validation",
              "DUPLICATE_CHILD",
              at(path, "children", index),
              "A node cannot list the same child twice",
            ),
          );
        }
        seen.add(child);
      }
    });
  }
  checkTransform(value.transform, at(path, "transform"), issues);
  if (!Array.isArray(value.components)) {
    issues.push(
      issue(
        "validation",
        "INVALID_FIELD_TYPE",
        at(path, "components"),
        "Expected an array of components",
      ),
    );
  } else {
    const seenKinds = new Set<string>();
    value.components.forEach((component, index) => {
      checkComponent(
        component,
        at(path, "components", index),
        issues,
        seenKinds,
        seenComponentIds,
        volumes,
      );
    });
  }
  if (value.metadata !== undefined) {
    checkMetadata(value.metadata, at(path, "metadata"), issues, limits, state);
  }
}

function checkMaterial(
  value: unknown,
  path: Path,
  issues: Issue[],
  limits: DocumentLimits,
  expectedId: string,
): void {
  if (!isRecord(value)) {
    issues.push(
      issue(
        "validation",
        "INVALID_MATERIAL",
        path,
        "Expected a material record",
      ),
    );
    return;
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "materialId" &&
      key !== "name" &&
      key !== "color" &&
      key !== "opacity" &&
      key !== "roughness" &&
      key !== "metallic" &&
      key !== "emissive"
    ) {
      issues.push(
        issue(
          "validation",
          "UNKNOWN_FIELD",
          at(path, key),
          `Unknown material field ${key}`,
        ),
      );
    }
  }
  if (
    typeof value.materialId !== "number" ||
    !Number.isInteger(value.materialId) ||
    value.materialId < 1 ||
    value.materialId > 65_535
  ) {
    issues.push(
      issue(
        "validation",
        "INVALID_MATERIAL_ID",
        at(path, "materialId"),
        "Material identifiers must be integers from 1 through 65535",
      ),
    );
  } else if (String(value.materialId) !== expectedId) {
    issues.push(
      issue(
        "validation",
        "MISMATCHED_RECORD_ID",
        at(path, "materialId"),
        "Material record identifier does not match its record key",
      ),
    );
  }
  if (value.name !== undefined)
    checkName(value.name, at(path, "name"), issues, limits);
  else
    issues.push(
      issue(
        "validation",
        "INVALID_FIELD_TYPE",
        at(path, "name"),
        "Expected a material name",
      ),
    );
  if (!isCanonicalColor(value.color)) {
    issues.push(
      issue(
        "validation",
        "INVALID_COLOR",
        at(path, "color"),
        "Color must be a lowercase #rrggbb value",
      ),
    );
  }
  for (const field of [
    "opacity",
    "roughness",
    "metallic",
    "emissive",
  ] as const) {
    const fieldValue = value[field];
    checkFiniteNumber(fieldValue, at(path, field), issues);
    if (
      typeof fieldValue === "number" &&
      Number.isFinite(fieldValue) &&
      (fieldValue < 0 || fieldValue > 1)
    ) {
      issues.push(
        issue(
          "validation",
          "INVALID_MATERIAL_RANGE",
          at(path, field),
          `${field} must be within [0, 1]`,
        ),
      );
    }
  }
}

function checkVolume(
  value: unknown,
  path: Path,
  issues: Issue[],
  limits: DocumentLimits,
  expectedId: string,
): void {
  if (!isRecord(value)) {
    issues.push(
      issue(
        "validation",
        "INVALID_VOLUME",
        path,
        "Expected a volume descriptor",
      ),
    );
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "volumeId" && key !== "name" && key !== "bounds") {
      issues.push(
        issue(
          "validation",
          "UNKNOWN_FIELD",
          at(path, key),
          `Unknown volume field ${key}`,
        ),
      );
    }
  }
  checkId(value.volumeId, at(path, "volumeId"), issues);
  if (typeof value.volumeId === "string" && value.volumeId !== expectedId) {
    issues.push(
      issue(
        "validation",
        "MISMATCHED_RECORD_ID",
        at(path, "volumeId"),
        "Volume record identifier does not match its record key",
      ),
    );
  }
  if (value.name !== undefined)
    checkName(value.name, at(path, "name"), issues, limits);
  if (value.bounds !== undefined) {
    if (!isRecord(value.bounds)) {
      issues.push(
        issue(
          "validation",
          "INVALID_VOLUME_BOUNDS",
          at(path, "bounds"),
          "Expected a bounds object",
        ),
      );
    } else {
      for (const key of Object.keys(value.bounds)) {
        if (key !== "min" && key !== "max") {
          issues.push(
            issue(
              "validation",
              "UNKNOWN_FIELD",
              at(path, "bounds", key),
              `Unknown bounds field ${key}`,
            ),
          );
        }
      }
      checkVec3i(value.bounds.min, at(path, "bounds", "min"), issues, limits);
      checkVec3i(value.bounds.max, at(path, "bounds", "max"), issues, limits);
      checkMinMaxPerAxis(
        value.bounds.min as readonly number[] | undefined,
        value.bounds.max as readonly number[] | undefined,
        at(path, "bounds"),
        issues,
        "INVALID_VOLUME_BOUNDS",
        (axis) => `Bounds minimum exceeds maximum on axis ${String(axis)}`,
      );
    }
  }
}

function checkKeyframe(
  value: unknown,
  path: Path,
  issues: Issue[],
  duration: number,
  seenKeyframeIds: Set<string>,
): void {
  if (!isRecord(value)) {
    issues.push(
      issue("validation", "INVALID_KEYFRAME", path, "Expected a keyframe"),
    );
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "keyframeId" && key !== "time" && key !== "property") {
      issues.push(
        issue(
          "validation",
          "UNKNOWN_FIELD",
          at(path, key),
          `Unknown keyframe field ${key}`,
        ),
      );
    }
  }
  checkId(value.keyframeId, at(path, "keyframeId"), issues);
  if (typeof value.keyframeId === "string") {
    if (seenKeyframeIds.has(value.keyframeId)) {
      issues.push(
        issue(
          "validation",
          "DUPLICATE_KEYFRAME_ID",
          at(path, "keyframeId"),
          "Keyframe identifiers must be unique within the document",
        ),
      );
    }
    seenKeyframeIds.add(value.keyframeId);
  }
  checkFiniteNumber(value.time, at(path, "time"), issues);
  if (
    typeof value.time === "number" &&
    Number.isFinite(value.time) &&
    (value.time < 0 || value.time > duration)
  ) {
    issues.push(
      issue(
        "validation",
        "INVALID_KEYFRAME_TIME",
        at(path, "time"),
        `Keyframe time must be within [0, ${String(duration)}]`,
      ),
    );
  }
  const property = value.property;
  if (!isRecord(property)) {
    issues.push(
      issue(
        "validation",
        "INVALID_KEYFRAME",
        at(path, "property"),
        "Expected a track property",
      ),
    );
    return;
  }
  for (const key of Object.keys(property)) {
    if (key !== "channel" && key !== "value") {
      issues.push(
        issue(
          "validation",
          "UNKNOWN_FIELD",
          at(path, "property", key),
          `Unknown property field ${key}`,
        ),
      );
    }
  }
  const channel = property.channel;
  if (
    channel !== "translation" &&
    channel !== "rotation" &&
    channel !== "scale"
  ) {
    issues.push(
      issue(
        "validation",
        "INVALID_PROPERTY_CHANNEL",
        at(path, "property", "channel"),
        `Unsupported property channel ${String(channel)}`,
      ),
    );
    return;
  }
  const valuePath = at(path, "property", "value");
  if (channel === "rotation") {
    checkQuat(property.value, valuePath, issues);
  } else {
    checkVec3(property.value, valuePath, issues);
    if (channel === "scale" && Array.isArray(property.value)) {
      property.value.forEach((component, index) => {
        if (
          typeof component === "number" &&
          Number.isFinite(component) &&
          component <= 0
        ) {
          issues.push(
            issue(
              "validation",
              "INVALID_KEYFRAME_VALUE",
              at(valuePath, index),
              "Scale keyframe values must be strictly positive",
            ),
          );
        }
      });
    }
  }
}

function checkTrack(
  value: unknown,
  path: Path,
  issues: Issue[],
  duration: number,
  limits: DocumentLimits,
  state: { tracks: number; keyframes: number },
  seenTrackIds: Set<string>,
  seenKeyframeIds: Set<string>,
): void {
  if (!isRecord(value)) {
    issues.push(
      issue("validation", "INVALID_TRACK", path, "Expected an animation track"),
    );
    return;
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "trackId" &&
      key !== "targetNodeId" &&
      key !== "interpolation" &&
      key !== "keyframes"
    ) {
      issues.push(
        issue(
          "validation",
          "UNKNOWN_FIELD",
          at(path, key),
          `Unknown track field ${key}`,
        ),
      );
    }
  }
  checkId(value.trackId, at(path, "trackId"), issues);
  if (typeof value.trackId === "string") {
    if (seenTrackIds.has(value.trackId)) {
      issues.push(
        issue(
          "validation",
          "DUPLICATE_TRACK_ID",
          at(path, "trackId"),
          "Track identifiers must be unique within the document",
        ),
      );
    }
    seenTrackIds.add(value.trackId);
  }
  checkId(value.targetNodeId, at(path, "targetNodeId"), issues);
  if (
    value.interpolation !== "step" &&
    value.interpolation !== "linear" &&
    value.interpolation !== "smoothstep"
  ) {
    issues.push(
      issue(
        "validation",
        "INVALID_INTERPOLATION",
        at(path, "interpolation"),
        "Unsupported interpolation mode",
      ),
    );
  }
  if (!Array.isArray(value.keyframes)) {
    issues.push(
      issue(
        "validation",
        "INVALID_FIELD_TYPE",
        at(path, "keyframes"),
        "Expected an array of keyframes",
      ),
    );
    return;
  }
  if (value.keyframes.length > limits.maxKeyframesPerTrack) {
    issues.push(
      issue(
        "limit",
        "LIMIT_EXCEEDED",
        at(path, "keyframes"),
        `Track exceeds the ${String(limits.maxKeyframesPerTrack)}-keyframe limit`,
      ),
    );
  }
  state.tracks += 1;
  state.keyframes += value.keyframes.length;
  let previousTime: number | undefined;
  value.keyframes.forEach((keyframe, index) => {
    const keyframePath = at(path, "keyframes", index);
    checkKeyframe(keyframe, keyframePath, issues, duration, seenKeyframeIds);
    if (
      isRecord(keyframe) &&
      typeof keyframe.time === "number" &&
      Number.isFinite(keyframe.time)
    ) {
      if (previousTime !== undefined && keyframe.time === previousTime) {
        issues.push(
          issue(
            "validation",
            "DUPLICATE_KEYFRAME_TIME",
            at(keyframePath, "time"),
            "Keyframe times must be unique",
          ),
        );
      } else if (previousTime !== undefined && keyframe.time < previousTime) {
        issues.push(
          issue(
            "validation",
            "UNSORTED_KEYFRAME_TIMES",
            at(keyframePath, "time"),
            "Keyframe times must be sorted in ascending order",
          ),
        );
      }
      previousTime = keyframe.time;
    }
  });
}

function checkAnimation(
  value: unknown,
  path: Path,
  issues: Issue[],
  limits: DocumentLimits,
  state: { clips: number; tracks: number; keyframes: number },
  seenTrackIds: Set<string>,
  seenKeyframeIds: Set<string>,
  expectedId: string,
): void {
  if (!isRecord(value)) {
    issues.push(
      issue(
        "validation",
        "INVALID_ANIMATION",
        path,
        "Expected an animation descriptor",
      ),
    );
    return;
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "animationId" &&
      key !== "name" &&
      key !== "duration" &&
      key !== "loop" &&
      key !== "tracks"
    ) {
      issues.push(
        issue(
          "validation",
          "UNKNOWN_FIELD",
          at(path, key),
          `Unknown animation field ${key}`,
        ),
      );
    }
  }
  checkId(value.animationId, at(path, "animationId"), issues);
  if (
    typeof value.animationId === "string" &&
    value.animationId !== expectedId
  ) {
    issues.push(
      issue(
        "validation",
        "MISMATCHED_RECORD_ID",
        at(path, "animationId"),
        "Animation record identifier does not match its record key",
      ),
    );
  }
  if (value.name !== undefined)
    checkName(value.name, at(path, "name"), issues, limits);
  checkFiniteNumber(value.duration, at(path, "duration"), issues);
  if (
    typeof value.duration === "number" &&
    Number.isFinite(value.duration) &&
    (value.duration <= 0 || value.duration > limits.maxClipDurationSeconds)
  ) {
    issues.push(
      issue(
        "validation",
        "INVALID_ANIMATION_DURATION",
        at(path, "duration"),
        `Duration must be within (0, ${String(limits.maxClipDurationSeconds)}]`,
      ),
    );
  }
  if (value.loop !== "once" && value.loop !== "loop") {
    issues.push(
      issue(
        "validation",
        "INVALID_LOOP_POLICY",
        at(path, "loop"),
        "Loop policy must be once or loop",
      ),
    );
  }
  if (!Array.isArray(value.tracks)) {
    issues.push(
      issue(
        "validation",
        "INVALID_FIELD_TYPE",
        at(path, "tracks"),
        "Expected an array of tracks",
      ),
    );
    return;
  }
  state.clips += 1;
  const duration =
    typeof value.duration === "number" && Number.isFinite(value.duration)
      ? value.duration
      : 0;
  value.tracks.forEach((track, index) => {
    checkTrack(
      track,
      at(path, "tracks", index),
      issues,
      duration,
      limits,
      state,
      seenTrackIds,
      seenKeyframeIds,
    );
  });
}

/** Structural validation of an untrusted document-shaped value. */
export function validateDocumentStructure(
  value: unknown,
  limits: DocumentLimits = DEFAULT_DOCUMENT_LIMITS,
): readonly DocumentIssue[] {
  const issues: Issue[] = [];
  if (!isRecord(value)) {
    issues.push(
      issue("validation", "INVALID_DOCUMENT", [], "Expected a document object"),
    );
    return issues;
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "documentId" &&
      key !== "documentSchemaVersion" &&
      key !== "revision" &&
      key !== "metadata" &&
      key !== "rootNodeId" &&
      key !== "nodes" &&
      key !== "materials" &&
      key !== "volumes" &&
      key !== "animations"
    ) {
      issues.push(
        issue(
          "validation",
          "UNKNOWN_FIELD",
          at([], key),
          `Unknown document field ${key}`,
        ),
      );
    }
  }
  checkId(value.documentId, ["documentId"], issues);
  checkFiniteNumber(
    value.documentSchemaVersion,
    ["documentSchemaVersion"],
    issues,
  );
  if (
    typeof value.documentSchemaVersion === "number" &&
    Number.isFinite(value.documentSchemaVersion) &&
    value.documentSchemaVersion !== CURRENT_DOCUMENT_SCHEMA_VERSION
  ) {
    issues.push(
      issue(
        "validation",
        "INVALID_DOCUMENT_SCHEMA_VERSION",
        ["documentSchemaVersion"],
        "Unsupported document schema version",
      ),
    );
  }
  checkFiniteNumber(value.revision, ["revision"], issues);
  if (
    typeof value.revision === "number" &&
    Number.isFinite(value.revision) &&
    (!Number.isInteger(value.revision) ||
      value.revision < 0 ||
      value.revision > limits.maxRevision)
  ) {
    issues.push(
      issue(
        "validation",
        "INVALID_REVISION",
        ["revision"],
        `Revision must be a non-negative integer at most ${String(limits.maxRevision)}`,
      ),
    );
  }
  checkId(value.rootNodeId, ["rootNodeId"], issues);

  const metadataState = { members: 0, bytes: 0 };
  const volumes = new Set<string>();
  const seenComponentIds = new Set<string>();

  if (!isRecord(value.metadata)) {
    issues.push(
      issue(
        "validation",
        "INVALID_METADATA",
        ["metadata"],
        "Metadata must be a JSON object",
      ),
    );
  } else {
    checkMetadata(value.metadata, ["metadata"], issues, limits, metadataState);
  }

  if (!isRecord(value.volumes)) {
    issues.push(
      issue(
        "validation",
        "INVALID_FIELD_TYPE",
        ["volumes"],
        "Expected a record of volumes",
      ),
    );
  } else {
    const volumeKeys = sortedKeys(value.volumes, compareCodeUnit);
    if (volumeKeys.length > limits.maxVolumes) {
      issues.push(
        issue(
          "limit",
          "LIMIT_EXCEEDED",
          ["volumes"],
          `Volume count exceeds the ${String(limits.maxVolumes)}-volume limit`,
        ),
      );
    }
    for (const key of volumeKeys) {
      volumes.add(key);
      checkVolume(
        value.volumes[key],
        at(["volumes"], key),
        issues,
        limits,
        key,
      );
    }
  }

  if (!isRecord(value.nodes)) {
    issues.push(
      issue(
        "validation",
        "INVALID_FIELD_TYPE",
        ["nodes"],
        "Expected a record of nodes",
      ),
    );
  } else {
    const nodeKeys = sortedKeys(value.nodes, compareCodeUnit);
    if (nodeKeys.length > limits.maxNodes) {
      issues.push(
        issue(
          "limit",
          "LIMIT_EXCEEDED",
          ["nodes"],
          `Node count exceeds the ${String(limits.maxNodes)}-node limit`,
        ),
      );
    }
    for (const key of nodeKeys) {
      checkNode(
        value.nodes[key],
        at(["nodes"], key),
        issues,
        limits,
        metadataState,
        seenComponentIds,
        volumes,
        key,
      );
    }
  }

  if (!isRecord(value.materials)) {
    issues.push(
      issue(
        "validation",
        "INVALID_FIELD_TYPE",
        ["materials"],
        "Expected a record of materials",
      ),
    );
  } else {
    const materialKeys = sortedKeys(value.materials, compareNumeric);
    if (materialKeys.length > limits.maxMaterials) {
      issues.push(
        issue(
          "limit",
          "LIMIT_EXCEEDED",
          ["materials"],
          `Material count exceeds the ${String(limits.maxMaterials)}-material limit`,
        ),
      );
    }
    for (const key of materialKeys) {
      if (
        !/^(?:[1-9]|[1-9][0-9]{1,4}|65535)$/u.test(key) ||
        Number(key) < 1 ||
        Number(key) > 65_535
      ) {
        issues.push(
          issue(
            "validation",
            "INVALID_MATERIAL_ID",
            ["materials", key],
            "Material record keys must be integers from 1 through 65535",
          ),
        );
      }
      checkMaterial(
        value.materials[key],
        at(["materials"], key),
        issues,
        limits,
        key,
      );
    }
  }

  const animationState = { clips: 0, tracks: 0, keyframes: 0 };
  const seenTrackIds = new Set<string>();
  const seenKeyframeIds = new Set<string>();
  if (!isRecord(value.animations)) {
    issues.push(
      issue(
        "validation",
        "INVALID_FIELD_TYPE",
        ["animations"],
        "Expected a record of animations",
      ),
    );
  } else {
    const animationKeys = sortedKeys(value.animations, compareCodeUnit);
    if (animationKeys.length > limits.maxClips) {
      issues.push(
        issue(
          "limit",
          "LIMIT_EXCEEDED",
          ["animations"],
          `Animation count exceeds the ${String(limits.maxClips)}-clip limit`,
        ),
      );
    }
    for (const key of animationKeys) {
      checkAnimation(
        value.animations[key],
        at(["animations"], key),
        issues,
        limits,
        animationState,
        seenTrackIds,
        seenKeyframeIds,
        key,
      );
    }
  }

  if (metadataState.members > limits.maxMetadataMembers) {
    issues.push(
      issue(
        "limit",
        "LIMIT_EXCEEDED",
        ["metadata"],
        `Metadata member count exceeds the ${String(limits.maxMetadataMembers)}-member limit`,
      ),
    );
  }
  if (metadataState.bytes > limits.maxMetadataBytes) {
    issues.push(
      issue(
        "limit",
        "LIMIT_EXCEEDED",
        ["metadata"],
        `Metadata exceeds the ${String(limits.maxMetadataBytes)}-byte limit`,
      ),
    );
  }
  if (animationState.tracks > limits.maxTracks) {
    issues.push(
      issue(
        "limit",
        "LIMIT_EXCEEDED",
        ["animations"],
        `Track count exceeds the ${String(limits.maxTracks)}-track limit`,
      ),
    );
  }
  if (animationState.keyframes > limits.maxKeyframes) {
    issues.push(
      issue(
        "limit",
        "LIMIT_EXCEEDED",
        ["animations"],
        `Keyframe count exceeds the ${String(limits.maxKeyframes)}-keyframe limit`,
      ),
    );
  }

  return issues;
}

/** Referential validation: root, parent/child reciprocity, cycles, references. */
export function validateReferences(
  document: VoxelDocument,
): readonly DocumentIssue[] {
  const issues: Issue[] = [];
  const nodes = document.nodes as unknown as Readonly<
    Record<string, SceneNode>
  >;
  const animations = document.animations as unknown as Readonly<
    Record<string, AnimationDescriptor>
  >;
  const nodeEntries = Object.entries(nodes).sort(([a], [b]) =>
    compareCodeUnit(a, b),
  );
  const nodeIds = new Set(nodeEntries.map(([id]) => id));

  if (!nodeIds.has(document.rootNodeId)) {
    issues.push(
      issue(
        "validation",
        "MISSING_REFERENCE",
        ["rootNodeId"],
        "The root node does not exist",
      ),
    );
  }

  const roots = nodeEntries.filter(([, node]) => node.parentId === null);
  if (roots.length === 0) {
    issues.push(
      issue(
        "validation",
        "INVALID_ROOT",
        ["nodes"],
        "The document has no root node",
      ),
    );
  } else if (roots.length > 1) {
    issues.push(
      issue(
        "validation",
        "INVALID_ROOT",
        ["nodes"],
        "The document has more than one root node",
      ),
    );
  } else {
    const onlyRoot = roots[0];
    if (onlyRoot !== undefined && onlyRoot[0] !== document.rootNodeId) {
      issues.push(
        issue(
          "validation",
          "INVALID_ROOT",
          ["rootNodeId"],
          "The document root must be the only parentless node",
        ),
      );
    }
  }

  for (const [id, node] of nodeEntries) {
    const nodePath = ["nodes", id] as const;
    if (node.parentId === id) {
      issues.push(
        issue(
          "validation",
          "SELF_PARENT",
          [...nodePath, "parentId"],
          "A node cannot be its own parent",
        ),
      );
    } else if (node.parentId !== null) {
      if (!nodeIds.has(node.parentId)) {
        issues.push(
          issue(
            "validation",
            "MISSING_REFERENCE",
            [...nodePath, "parentId"],
            "Parent node does not exist",
          ),
        );
      } else {
        const parent = nodes[node.parentId];
        if (parent !== undefined && !parent.children.includes(id as never)) {
          issues.push(
            issue(
              "validation",
              "RECIPROCAL_REFERENCE",
              [...nodePath, "parentId"],
              "Parent does not list this node among its children",
            ),
          );
        }
      }
    }
    const seen = new Set<string>();
    node.children.forEach((child, index) => {
      const childPath = [...nodePath, "children", index];
      if (child === id) {
        issues.push(
          issue(
            "validation",
            "SELF_PARENT",
            childPath,
            "A node cannot be its own child",
          ),
        );
        return;
      }
      if (!nodeIds.has(child)) {
        issues.push(
          issue(
            "validation",
            "MISSING_REFERENCE",
            childPath,
            "Child node does not exist",
          ),
        );
        return;
      }
      if (seen.has(child)) {
        issues.push(
          issue(
            "validation",
            "DUPLICATE_CHILD",
            childPath,
            "A node cannot list the same child twice",
          ),
        );
      }
      seen.add(child);
      const childNode = nodes[child];
      if (childNode !== undefined && childNode.parentId !== id) {
        issues.push(
          issue(
            "validation",
            "RECIPROCAL_REFERENCE",
            childPath,
            "Child does not reference this node as its parent",
          ),
        );
      }
    });
  }

  // Cycle detection walks parent chains so that disconnected cycles are also
  // rejected. Each distinct cycle is reported once via its sorted member key,
  // and chains that terminate at the root are memoized so deep hierarchies
  // validate in linear time.
  const reportedCycles = new Set<string>();
  const endsAtRoot = new Set<string>();
  for (const [start] of nodeEntries) {
    if (endsAtRoot.has(start)) continue;
    const chain: string[] = [];
    const inChain = new Set<string>();
    let current: string | null = start;
    while (current !== null && nodeIds.has(current) && !inChain.has(current)) {
      if (endsAtRoot.has(current)) {
        current = null;
        break;
      }
      inChain.add(current);
      chain.push(current);
      const parent: SceneNode["parentId"] | undefined =
        nodes[current]?.parentId;
      current =
        parent === undefined || parent === null || parent === current
          ? null
          : parent;
    }
    if (current === null || !inChain.has(current)) {
      for (const id of chain) endsAtRoot.add(id);
      continue;
    }
    const cycleStart = chain.indexOf(current);
    const members = chain.slice(cycleStart).sort(compareCodeUnit);
    const key = members.join("\u0000");
    if (!reportedCycles.has(key)) {
      reportedCycles.add(key);
      const firstMember = members[0];
      if (firstMember !== undefined) {
        issues.push(
          issue(
            "validation",
            "CYCLIC_HIERARCHY",
            ["nodes", firstMember],
            `Cycle detected: ${members.join(" -> ")}`,
          ),
        );
      }
    }
  }

  const rootNode = nodes[document.rootNodeId];
  if (rootNode !== undefined && rootNode.parentId === null) {
    // Iterative reachability walk: a within-limits 10,000-node chain must not
    // overflow the call stack (AGENTS.md: structured, user-safe errors).
    const visited = new Set<string>();
    const pending: string[] = [document.rootNodeId];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || visited.has(id) || !nodeIds.has(id)) continue;
      visited.add(id);
      const current = nodes[id];
      if (current !== undefined) {
        pending.push(...current.children);
      }
    }
    for (const [id] of nodeEntries) {
      if (!visited.has(id)) {
        issues.push(
          issue(
            "validation",
            "DISCONNECTED_NODE",
            ["nodes", id],
            "Node is not reachable from the document root",
          ),
        );
      }
    }
  }

  for (const [animationId, animation] of Object.entries(animations).sort(
    ([a], [b]) => compareCodeUnit(a, b),
  )) {
    animation.tracks.forEach((track, trackIndex) => {
      if (!nodeIds.has(track.targetNodeId)) {
        issues.push(
          issue(
            "validation",
            "MISSING_REFERENCE",
            ["animations", animationId, "tracks", trackIndex, "targetNodeId"],
            "Animation track targets an unknown node",
          ),
        );
      }
    });
  }

  return issues;
}

/** Full document validation: structural checks, then referential checks. */
export function validateDocument(
  value: unknown,
  limits: DocumentLimits = DEFAULT_DOCUMENT_LIMITS,
): readonly DocumentIssue[] {
  const structural = validateDocumentStructure(value, limits);
  if (structural.length > 0) return structural;
  return validateReferences(value as VoxelDocument);
}
