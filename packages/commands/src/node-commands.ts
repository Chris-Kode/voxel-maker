import {
  WorkspaceError,
  canonicalJson,
  nodeId,
  type CommandId,
  type JsonValue,
  type NodeId,
} from "@voxel-maker/shared";
import {
  canonicalTransform,
  canonicalVec3,
  isCanonicalQuat,
  isNormalizedQuat,
  resolveLocalTransform,
  type Transform,
  type Vec3,
} from "@voxel-maker/math";
import type {
  Component,
  ConstraintDescriptor,
  DocumentLimits,
  MetadataRecord,
  SceneNode,
  VoxelDocument,
} from "@voxel-maker/model";
import { worldTransformMatrix } from "@voxel-maker/document";
import {
  isRecord,
  missingVolume,
  parseComponentId,
  parseName,
  parseNodeId,
  parseVolumeId,
} from "./parse-helpers.js";
import type { Command } from "./types.js";
import type {
  CommandExecution,
  CommandExecutionContext,
  CommandHandler,
  CommandValidationContext,
  MutableDocument,
  MutableSceneNode,
} from "./registry.js";
import { CommandRegistry } from "./registry.js";

export const NODE_CREATE_COMMAND = "node.create" as const;
export const NODE_RENAME_COMMAND = "node.rename" as const;
export const NODE_SET_TRANSFORM_COMMAND = "node.setTransform" as const;
export const NODE_SET_COMPONENTS_COMMAND = "node.setComponents" as const;
export const NODE_SET_METADATA_COMMAND = "node.setMetadata" as const;
export const NODE_DELETE_COMMAND = "node.delete" as const;
export const NODE_REPARENT_COMMAND = "node.reparent" as const;
export const NODE_COMMAND_SCHEMA_VERSION = 1;

export interface CreateNodePayload {
  readonly nodeId: NodeId;
  readonly name?: string;
  readonly parentId: NodeId;
  readonly transform: Transform;
  readonly components?: readonly Component[];
  readonly metadata?: MetadataRecord;
  /**
   * Insertion index in the parent's ordered children; absent appends. The
   * `node.delete` inverse carries the original index so undo restores the
   * exact children order.
   */
  readonly index?: number;
}

export interface RenameNodePayload {
  readonly nodeId: NodeId;
  /** New name; absent removes the node name. */
  readonly name?: string;
}

export interface SetNodeTransformPayload {
  readonly nodeId: NodeId;
  readonly transform: Transform;
}

export interface SetNodeComponentsPayload {
  readonly nodeId: NodeId;
  readonly components: readonly Component[];
}

export interface SetNodeMetadataPayload {
  readonly nodeId: NodeId;
  /** New metadata; absent removes the node metadata. */
  readonly metadata?: MetadataRecord;
}

export interface DeleteNodePayload {
  readonly nodeId: NodeId;
}

export type ReparentPlacement =
  | "preserve-local"
  | "preserve-world"
  | "set-transform";

export interface ReparentNodePayload {
  readonly nodeId: NodeId;
  readonly newParentId: NodeId;
  readonly placement: ReparentPlacement;
  /**
   * Canonical local transform installed for `preserve-world`. The command
   * constructor resolves and canonicalizes it from the current document
   * (ADR-0001 derived-transform policy); the handler installs it verbatim.
   */
  readonly transform?: Transform;
  /**
   * Insertion index in the new parent's ordered children; absent appends.
   * The inverse carries the original index so undo restores the exact
   * children order.
   */
  readonly index?: number;
}

/** Canonicalizing constructor for a `node.create` command. */
export function createNodeCommand(
  id: CommandId,
  payload: CreateNodePayload,
): Command<typeof NODE_CREATE_COMMAND, CreateNodePayload> {
  return {
    id,
    type: NODE_CREATE_COMMAND,
    schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
    payload: {
      nodeId: nodeId(payload.nodeId),
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      parentId: nodeId(payload.parentId),
      transform: canonicalTransform(payload.transform),
      ...(payload.components !== undefined
        ? { components: canonicalizeComponents(payload.components) }
        : {}),
      ...(payload.metadata !== undefined
        ? { metadata: canonicalizeMetadata(payload.metadata) }
        : {}),
      ...(payload.index !== undefined
        ? { index: parseNonNegativeInteger(payload.index, "index") }
        : {}),
    },
  };
}

function parseNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: `${name} must be a non-negative integer`,
      context: { value: String(value) },
    });
  }
  return value;
}

/** Canonicalizing constructor for a `node.rename` command. */
export function renameNodeCommand(
  id: CommandId,
  payload: RenameNodePayload,
): Command<typeof NODE_RENAME_COMMAND, RenameNodePayload> {
  return {
    id,
    type: NODE_RENAME_COMMAND,
    schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
    payload: {
      nodeId: nodeId(payload.nodeId),
      ...(payload.name !== undefined ? { name: payload.name } : {}),
    },
  };
}

/** Canonicalizing constructor for a `node.setTransform` command. */
export function setNodeTransformCommand(
  id: CommandId,
  payload: SetNodeTransformPayload,
): Command<typeof NODE_SET_TRANSFORM_COMMAND, SetNodeTransformPayload> {
  return {
    id,
    type: NODE_SET_TRANSFORM_COMMAND,
    schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
    payload: {
      nodeId: nodeId(payload.nodeId),
      transform: canonicalTransform(payload.transform),
    },
  };
}

/** Canonicalizing constructor for a `node.setComponents` command. */
export function setNodeComponentsCommand(
  id: CommandId,
  payload: SetNodeComponentsPayload,
): Command<typeof NODE_SET_COMPONENTS_COMMAND, SetNodeComponentsPayload> {
  return {
    id,
    type: NODE_SET_COMPONENTS_COMMAND,
    schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
    payload: {
      nodeId: nodeId(payload.nodeId),
      components: canonicalizeComponents(payload.components),
    },
  };
}

/** Canonicalizing constructor for a `node.setMetadata` command. */
export function setNodeMetadataCommand(
  id: CommandId,
  payload: SetNodeMetadataPayload,
): Command<typeof NODE_SET_METADATA_COMMAND, SetNodeMetadataPayload> {
  return {
    id,
    type: NODE_SET_METADATA_COMMAND,
    schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
    payload: {
      nodeId: nodeId(payload.nodeId),
      ...(payload.metadata !== undefined
        ? { metadata: canonicalizeMetadata(payload.metadata) }
        : {}),
    },
  };
}

/** Canonicalizing constructor for a `node.delete` command. */
export function deleteNodeCommand(
  id: CommandId,
  payload: DeleteNodePayload,
): Command<typeof NODE_DELETE_COMMAND, DeleteNodePayload> {
  return {
    id,
    type: NODE_DELETE_COMMAND,
    schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
    payload: { nodeId: nodeId(payload.nodeId) },
  };
}

/**
 * Canonicalizing constructor for a `node.reparent` command. For
 * `preserve-world` placement the constructor resolves the canonical local
 * transform that keeps the node's world placement fixed under the new
 * parent (ADR-0001) and carries it in the payload; the handler installs it
 * verbatim. `preserve-local` keeps the node's current local transform.
 */
export function reparentNodeCommand(
  id: CommandId,
  payload: ReparentNodePayload,
  document: VoxelDocument,
): Command<typeof NODE_REPARENT_COMMAND, ReparentNodePayload> {
  const placement = parsePlacement(payload.placement);
  const nodeIdValue = nodeId(payload.nodeId);
  const newParentIdValue = nodeId(payload.newParentId);
  if (placement === "preserve-world") {
    const node = document.nodes[nodeIdValue];
    if (node === undefined) throw missingNode(nodeIdValue);
    if (document.nodes[newParentIdValue] === undefined) {
      throw missingNode(newParentIdValue);
    }
    const transform = resolveLocalTransform(
      worldTransformMatrix(document, nodeIdValue),
      worldTransformMatrix(document, newParentIdValue),
      node.transform.pivot,
    );
    return {
      id,
      type: NODE_REPARENT_COMMAND,
      schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
      payload: {
        nodeId: nodeIdValue,
        newParentId: newParentIdValue,
        placement,
        transform,
        ...(payload.index !== undefined
          ? { index: parseNonNegativeInteger(payload.index, "index") }
          : {}),
      },
    };
  }
  return {
    id,
    type: NODE_REPARENT_COMMAND,
    schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
    payload: {
      nodeId: nodeIdValue,
      newParentId: newParentIdValue,
      placement,
      ...(payload.index !== undefined
        ? { index: parseNonNegativeInteger(payload.index, "index") }
        : {}),
    },
  };
}
function missingNode(nodeIdValue: NodeId): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: "MISSING_NODE",
    message: "Node is not part of the document",
    context: { nodeId: nodeIdValue },
  });
}

function parseFiniteNumber(
  value: unknown,
  path: readonly (string | number)[],
  message = "Numbers must be finite and must not be negative zero",
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
      message,
      path,
    });
  }
  return value;
}

function parseVec3(value: unknown, path: readonly (string | number)[]): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_VECTOR",
      message: "Expected a 3-component vector",
      path,
    });
  }
  return [
    parseFiniteNumber(value[0], [...path, 0]),
    parseFiniteNumber(value[1], [...path, 1]),
    parseFiniteNumber(value[2], [...path, 2]),
  ];
}

function parseQuat(
  value: unknown,
  path: readonly (string | number)[],
): Transform["rotation"] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_QUATERNION",
      message: "Expected a 4-component quaternion",
      path,
    });
  }
  const components = [
    parseFiniteNumber(value[0], [...path, 0]),
    parseFiniteNumber(value[1], [...path, 1]),
    parseFiniteNumber(value[2], [...path, 2]),
    parseFiniteNumber(value[3], [...path, 3]),
  ] as const;
  if (!isNormalizedQuat(components)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_QUATERNION",
      message: "Quaternions must be normalized within the ADR-0001 epsilon",
      path,
    });
  }
  if (!isCanonicalQuat(components)) {
    throw new WorkspaceError({
      family: "validation",
      code: "NON_CANONICAL_QUATERNION",
      message: "Quaternions must use the ADR-0001 sign canonicalization",
      path,
    });
  }
  return components;
}

function parseScale(value: unknown, path: readonly (string | number)[]): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_SCALE",
      message: "Expected a 3-component scale vector",
      path,
    });
  }
  const components: Vec3 = [
    parseFiniteNumber(value[0], [...path, 0]),
    parseFiniteNumber(value[1], [...path, 1]),
    parseFiniteNumber(value[2], [...path, 2]),
  ];
  for (let axis = 0; axis < 3; axis += 1) {
    if ((components[axis] as number) <= 0) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_SCALE",
        message: "Scale must be strictly positive",
        path: [...path, axis],
      });
    }
  }
  return components;
}

function parseTransform(
  value: unknown,
  path: readonly (string | number)[],
): Transform {
  if (!isRecord(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_TRANSFORM",
      message: "Expected a transform object",
      path,
    });
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "translation" &&
      key !== "pivot" &&
      key !== "rotation" &&
      key !== "scale"
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "UNKNOWN_FIELD",
        message: `Unknown transform field ${key}`,
        path: [...path, key],
      });
    }
  }
  return {
    translation: parseVec3(value.translation, [...path, "translation"]),
    pivot: parseVec3(value.pivot, [...path, "pivot"]),
    rotation: parseQuat(value.rotation, [...path, "rotation"]),
    scale: parseScale(value.scale, [...path, "scale"]),
  };
}

function parsePlacement(value: unknown): ReparentPlacement {
  if (
    value !== "preserve-local" &&
    value !== "preserve-world" &&
    value !== "set-transform"
  ) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_PLACEMENT",
      message:
        "Placement must be preserve-local, preserve-world, or set-transform",
      context: { value: String(value) },
    });
  }
  return value;
}

function parseConstraint(
  value: unknown,
  path: readonly (string | number)[],
): ConstraintDescriptor {
  if (!isRecord(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_CONSTRAINT",
      message: "Expected a constraint descriptor",
      path,
    });
  }
  for (const key of Object.keys(value)) {
    if (key !== "componentId" && key !== "type" && key !== "limits") {
      throw new WorkspaceError({
        family: "validation",
        code: "UNKNOWN_FIELD",
        message: `Unknown constraint field ${key}`,
        path: [...path, key],
      });
    }
  }
  const componentIdValue = parseComponentId(value.componentId, [
    ...path,
    "componentId",
  ]);
  if (value.type !== "rotation-limits") {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_CONSTRAINT",
      message: "Unsupported constraint type",
      path: [...path, "type"],
    });
  }
  const limits = value.limits;
  if (!isRecord(limits)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_CONSTRAINT",
      message: "Expected rotation limits",
      path: [...path, "limits"],
    });
  }
  for (const key of Object.keys(limits)) {
    if (key !== "min" && key !== "max") {
      throw new WorkspaceError({
        family: "validation",
        code: "UNKNOWN_FIELD",
        message: `Unknown limits field ${key}`,
        path: [...path, "limits", key],
      });
    }
  }
  const min = parseVec3(limits.min, [...path, "limits", "min"]);
  const max = parseVec3(limits.max, [...path, "limits", "max"]);
  for (let axis = 0; axis < 3; axis += 1) {
    if ((min[axis] as number) > (max[axis] as number)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_CONSTRAINT",
        message: `Rotation limit minimum exceeds maximum on axis ${String(axis)}`,
        path: [...path, "limits"],
      });
    }
  }
  return {
    componentId: componentIdValue,
    type: "rotation-limits",
    limits: { min, max },
  };
}

function parseComponent(
  value: unknown,
  path: readonly (string | number)[],
  seenKinds: Set<string>,
): Component {
  if (!isRecord(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "UNSUPPORTED_COMPONENT",
      message: "Expected a component object",
      path,
    });
  }
  const kind = value.kind;
  if (
    typeof kind !== "string" ||
    (kind !== "voxel" &&
      kind !== "pivot" &&
      kind !== "joint" &&
      kind !== "constraint")
  ) {
    throw new WorkspaceError({
      family: "validation",
      code: "UNSUPPORTED_COMPONENT",
      message: `Unsupported component kind ${String(kind)}`,
      path: [...path, "kind"],
    });
  }
  if (seenKinds.has(kind)) {
    throw new WorkspaceError({
      family: "validation",
      code: "DUPLICATE_COMPONENT",
      message: `Component kind ${kind} may occur at most once per node`,
      path,
    });
  }
  seenKinds.add(kind);
  if (value.schemaVersion !== 1) {
    throw new WorkspaceError({
      family: "validation",
      code: "UNSUPPORTED_COMPONENT_VERSION",
      message: "Unsupported component schema version",
      path: [...path, "schemaVersion"],
    });
  }
  const allowed = new Set(["kind", "schemaVersion"]);
  switch (kind) {
    case "voxel": {
      allowed.add("volumeId");
      const volumeIdValue = parseVolumeId(value.volumeId, [
        ...path,
        "volumeId",
      ]);
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          throw new WorkspaceError({
            family: "validation",
            code: "UNKNOWN_FIELD",
            message: `Unknown component field ${key}`,
            path: [...path, key],
          });
        }
      }
      return { kind, schemaVersion: 1, volumeId: volumeIdValue };
    }
    case "pivot": {
      allowed.add("pivot");
      const pivot = parseVec3(value.pivot, [...path, "pivot"]);
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          throw new WorkspaceError({
            family: "validation",
            code: "UNKNOWN_FIELD",
            message: `Unknown component field ${key}`,
            path: [...path, key],
          });
        }
      }
      return { kind, schemaVersion: 1, pivot };
    }
    case "joint": {
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          throw new WorkspaceError({
            family: "validation",
            code: "UNKNOWN_FIELD",
            message: `Unknown component field ${key}`,
            path: [...path, key],
          });
        }
      }
      return { kind, schemaVersion: 1 };
    }
    case "constraint": {
      allowed.add("constraints");
      const constraints = value.constraints;
      if (!Array.isArray(constraints)) {
        throw new WorkspaceError({
          family: "validation",
          code: "INVALID_CONSTRAINT",
          message: "Expected an array of constraints",
          path: [...path, "constraints"],
        });
      }
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          throw new WorkspaceError({
            family: "validation",
            code: "UNKNOWN_FIELD",
            message: `Unknown component field ${key}`,
            path: [...path, key],
          });
        }
      }
      return {
        kind,
        schemaVersion: 1,
        constraints: constraints.map((constraint, index) =>
          parseConstraint(constraint, [...path, "constraints", index]),
        ),
      };
    }
    default:
      throw new WorkspaceError({
        family: "validation",
        code: "UNSUPPORTED_COMPONENT",
        message: `Unsupported component kind ${String(kind)}`,
        path: [...path, "kind"],
      });
  }
}

function parseComponents(
  value: unknown,
  path: readonly (string | number)[],
): Component[] {
  if (!Array.isArray(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected an array of components",
      path,
    });
  }
  const seenKinds = new Set<string>();
  return value.map((component, index) =>
    parseComponent(component, [...path, index], seenKinds),
  );
}

function parseMetadata(
  value: unknown,
  limits: DocumentLimits,
  path: readonly (string | number)[],
): MetadataRecord | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_METADATA",
      message: "Metadata must be a JSON object",
      path,
    });
  }
  const state = { members: 0, bytes: 0 };
  const visited = new Set<object>();
  const walk = (
    current: unknown,
    currentPath: readonly (string | number)[],
    depth: number,
  ): JsonValue => {
    if (depth > limits.maxMetadataDepth) {
      throw new WorkspaceError({
        family: "limit",
        code: "LIMIT_EXCEEDED",
        message: `Metadata exceeds the maximum depth of ${String(limits.maxMetadataDepth)}`,
        path: currentPath,
      });
    }
    if (current === null || typeof current !== "object") {
      if (typeof current === "number") {
        return parseFiniteNumber(current, currentPath);
      }
      if (typeof current === "string") {
        if (
          new TextEncoder().encode(current).byteLength >
          limits.maxMetadataStringBytes
        ) {
          throw new WorkspaceError({
            family: "limit",
            code: "LIMIT_EXCEEDED",
            message: `Metadata string exceeds the ${String(limits.maxMetadataStringBytes)}-byte limit`,
            path: currentPath,
          });
        }
        return current;
      }
      if (typeof current === "boolean") return current;
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_METADATA",
        message: "Metadata must contain only JSON values",
        path: currentPath,
      });
    }
    if (visited.has(current)) {
      throw new WorkspaceError({
        family: "validation",
        code: "CYCLIC_VALUE",
        message: "Metadata cannot contain cycles",
        path: currentPath,
      });
    }
    visited.add(current);
    let result: JsonValue;
    if (Array.isArray(current)) {
      state.members += current.length;
      result = current.map((item, index) =>
        walk(item, [...currentPath, index], depth + 1),
      );
    } else {
      const record = current as Record<string, unknown>;
      state.members += Object.keys(record).length;
      result = Object.fromEntries(
        Object.keys(record).map((key): [string, JsonValue] => {
          if (
            new TextEncoder().encode(key).byteLength >
            limits.maxMetadataStringBytes
          ) {
            throw new WorkspaceError({
              family: "limit",
              code: "LIMIT_EXCEEDED",
              message: `Metadata key exceeds the ${String(limits.maxMetadataStringBytes)}-byte limit`,
              path: [...currentPath, key],
            });
          }
          return [key, walk(record[key], [...currentPath, key], depth + 1)];
        }),
      );
    }
    visited.delete(current);
    return result;
  };
  const parsed = walk(value, path, 0);
  if (state.members > limits.maxMetadataMembers) {
    throw new WorkspaceError({
      family: "limit",
      code: "LIMIT_EXCEEDED",
      message: `Metadata member count exceeds the ${String(limits.maxMetadataMembers)}-member limit`,
      path,
    });
  }
  try {
    state.bytes += new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
  } catch {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_METADATA",
      message: "Metadata cannot be serialized",
      path,
    });
  }
  if (state.bytes > limits.maxMetadataBytes) {
    throw new WorkspaceError({
      family: "limit",
      code: "LIMIT_EXCEEDED",
      message: `Metadata exceeds the ${String(limits.maxMetadataBytes)}-byte limit`,
      path,
    });
  }
  return parsed as MetadataRecord;
}

/** Deep canonical copy of a component list (trusted constructor path). */
function canonicalizeComponents(components: readonly Component[]): Component[] {
  return components.map((component) => {
    switch (component.kind) {
      case "voxel":
        return {
          kind: "voxel",
          schemaVersion: 1,
          volumeId: component.volumeId,
        };
      case "pivot":
        return {
          kind: "pivot",
          schemaVersion: 1,
          pivot: canonicalVec3(component.pivot),
        };
      case "joint":
        return { kind: "joint", schemaVersion: 1 };
      case "constraint":
        return {
          kind: "constraint",
          schemaVersion: 1,
          constraints: component.constraints.map((constraint) => ({
            componentId: constraint.componentId,
            type: constraint.type,
            limits: {
              min: canonicalVec3(constraint.limits.min),
              max: canonicalVec3(constraint.limits.max),
            },
          })),
        };
    }
  });
}

const MAX_METADATA_COPY_DEPTH = 64;

function copyJson(
  value: JsonValue,
  seen: Set<object>,
  depth: number,
): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_METADATA_COPY_DEPTH) {
    throw new WorkspaceError({
      family: "limit",
      code: "METADATA_TOO_DEEP",
      message: "Metadata is nested too deeply to be represented canonically",
    });
  }
  if (seen.has(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "CYCLIC_VALUE",
      message: "Metadata cannot contain cycles",
    });
  }
  seen.add(value);
  const items = value as readonly JsonValue[];
  const copied = Array.isArray(value)
    ? items.map((item) => copyJson(item, seen, depth + 1))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          copyJson(item, seen, depth + 1),
        ]),
      );
  seen.delete(value);
  return copied;
}

/** Deep canonical copy of a metadata record (trusted constructor path). */
function canonicalizeMetadata(metadata: MetadataRecord): MetadataRecord {
  return copyJson(metadata, new Set(), 0) as MetadataRecord;
}

/** Constraint component ids of every node except the excluded one. */
function constraintComponentIds(
  document: VoxelDocument,
  excludeNodeId: NodeId | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const node of Object.values(document.nodes)) {
    if (node.nodeId === excludeNodeId) continue;
    for (const component of node.components) {
      if (component.kind !== "constraint") continue;
      for (const constraint of component.constraints) {
        ids.add(constraint.componentId);
      }
    }
  }
  return ids;
}

/** Validates components against the document (references and id uniqueness). */
function validateComponents(
  components: readonly Component[],
  context: CommandValidationContext,
  excludeNodeId: NodeId | undefined,
): void {
  const existing = constraintComponentIds(context.document, excludeNodeId);
  const seen = new Set<string>();
  for (const component of components) {
    if (component.kind === "voxel") {
      if (context.document.volumes[component.volumeId] === undefined) {
        throw missingVolume(component.volumeId);
      }
    }
    if (component.kind !== "constraint") continue;
    for (const constraint of component.constraints) {
      if (
        existing.has(constraint.componentId) ||
        seen.has(constraint.componentId)
      ) {
        throw new WorkspaceError({
          family: "validation",
          code: "DUPLICATE_COMPONENT_ID",
          message:
            "Constraint component IDs must be unique within the document",
          context: { componentId: constraint.componentId },
        });
      }
      seen.add(constraint.componentId);
    }
  }
}

/** Mutable node record; validate guarantees existence before execute. */
function mutableNode(
  document: MutableDocument,
  nodeIdValue: NodeId,
): MutableSceneNode {
  const node = document.nodes[nodeIdValue];
  if (node === undefined) throw missingNode(nodeIdValue);
  return node;
}

function nodeResources(
  nodeIdValue: NodeId,
): CommandExecution["declaredAffectedResources"] {
  return {
    nodeIds: [nodeIdValue],
    materialIds: [],
    animationIds: [],
    volumeIds: [],
  };
}

/** True when an existing node record matches a create request (no-op). */
function createRecordsEqual(
  node: SceneNode,
  payload: CreateNodePayload,
): boolean {
  return (
    node.parentId === payload.parentId &&
    (node.name ?? undefined) === (payload.name ?? undefined) &&
    transformsEqual(node.transform, payload.transform) &&
    componentsEqual(node.components, payload.components ?? []) &&
    metadataEqual(node.metadata, payload.metadata)
  );
}

const createNodeHandler: CommandHandler<
  typeof NODE_CREATE_COMMAND,
  CreateNodePayload
> = {
  type: NODE_CREATE_COMMAND,
  schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): CreateNodePayload {
    if (!isRecord(payload)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a payload object",
        path: ["payload"],
      });
    }
    return {
      nodeId: parseNodeId(payload.nodeId, ["payload", "nodeId"]),
      ...(payload.name !== undefined
        ? {
            name: parseName(payload.name, limits, ["payload", "name"]),
          }
        : {}),
      parentId: parseNodeId(payload.parentId, ["payload", "parentId"]),
      transform: parseTransform(payload.transform, ["payload", "transform"]),
      ...(payload.components !== undefined
        ? {
            components: parseComponents(payload.components, [
              "payload",
              "components",
            ]),
          }
        : {}),
      ...(payload.metadata !== undefined
        ? {
            metadata: parseMetadata(payload.metadata, limits, [
              "payload",
              "metadata",
            ]) as MetadataRecord,
          }
        : {}),
      ...(payload.index !== undefined
        ? { index: parseNonNegativeInteger(payload.index, "index") }
        : {}),
    };
  },
  validate(
    payload: CreateNodePayload,
    context: CommandValidationContext,
  ): void {
    const existing = context.document.nodes[payload.nodeId];
    if (existing !== undefined) {
      // Creating a node that already exists with an identical record is a
      // no-op commit (the desired end state already holds), matching the
      // voxel no-op policy; a conflicting record is a duplicate error.
      if (createRecordsEqual(existing, payload)) return;
      throw new WorkspaceError({
        family: "validation",
        code: "DUPLICATE_NODE_ID",
        message: "A node with this identifier already exists",
        context: { nodeId: payload.nodeId },
      });
    }
    if (context.document.nodes[payload.parentId] === undefined) {
      throw missingNode(payload.parentId);
    }
    if (Object.keys(context.document.nodes).length >= context.limits.maxNodes) {
      throw new WorkspaceError({
        family: "limit",
        code: "LIMIT_EXCEEDED",
        message: `Node count exceeds the ${String(context.limits.maxNodes)}-node limit`,
        path: ["payload", "nodeId"],
      });
    }
    validateComponents(payload.components ?? [], context, undefined);
  },
  execute(
    payload: CreateNodePayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const existing = document.nodes[payload.nodeId];
    if (existing !== undefined) {
      if (createRecordsEqual(existing, payload)) {
        return {
          inverse: {
            type: NODE_CREATE_COMMAND,
            schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
            payload,
          },
          changedRecords: false,
          declaredAffectedResources: nodeResources(payload.nodeId),
        };
      }
      throw new WorkspaceError({
        family: "validation",
        code: "DUPLICATE_NODE_ID",
        message: "A node with this identifier already exists",
        context: { nodeId: payload.nodeId },
      });
    }
    const node: MutableSceneNode = {
      nodeId: payload.nodeId,
      parentId: payload.parentId,
      children: [],
      transform: payload.transform,
      components: [...(payload.components ?? [])],
    };
    if (payload.name !== undefined) node.name = payload.name;
    if (payload.metadata !== undefined) node.metadata = payload.metadata;
    document.nodes[payload.nodeId] = node;
    const parent = mutableNode(document, payload.parentId);
    parent.children.splice(
      payload.index ?? parent.children.length,
      0,
      payload.nodeId,
    );
    return {
      inverse: {
        type: NODE_DELETE_COMMAND,
        schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
        payload: { nodeId: payload.nodeId },
      },
      changedRecords: true,
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

const renameNodeHandler: CommandHandler<
  typeof NODE_RENAME_COMMAND,
  RenameNodePayload
> = {
  type: NODE_RENAME_COMMAND,
  schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): RenameNodePayload {
    if (!isRecord(payload)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a payload object",
        path: ["payload"],
      });
    }
    return {
      nodeId: parseNodeId(payload.nodeId, ["payload", "nodeId"]),
      ...(payload.name !== undefined
        ? {
            name: parseName(payload.name, limits, ["payload", "name"]),
          }
        : {}),
    };
  },
  validate(
    payload: RenameNodePayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.nodes[payload.nodeId] === undefined) {
      throw missingNode(payload.nodeId);
    }
  },
  execute(
    payload: RenameNodePayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    const oldName = node.name;
    if (payload.name === undefined) {
      delete node.name;
    } else {
      node.name = payload.name;
    }
    const inversePayload: RenameNodePayload = {
      nodeId: payload.nodeId,
      ...(oldName !== undefined ? { name: oldName } : {}),
    };
    return {
      inverse: {
        type: NODE_RENAME_COMMAND,
        schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
        payload: inversePayload,
      },
      changedRecords: oldName !== payload.name,
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

const setNodeTransformHandler: CommandHandler<
  typeof NODE_SET_TRANSFORM_COMMAND,
  SetNodeTransformPayload
> = {
  type: NODE_SET_TRANSFORM_COMMAND,
  schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): SetNodeTransformPayload {
    void limits;
    if (!isRecord(payload)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a payload object",
        path: ["payload"],
      });
    }
    return {
      nodeId: parseNodeId(payload.nodeId, ["payload", "nodeId"]),
      transform: parseTransform(payload.transform, ["payload", "transform"]),
    };
  },
  validate(
    payload: SetNodeTransformPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.nodes[payload.nodeId] === undefined) {
      throw missingNode(payload.nodeId);
    }
  },
  execute(
    payload: SetNodeTransformPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    const oldTransform = node.transform;
    node.transform = payload.transform;
    return {
      inverse: {
        type: NODE_SET_TRANSFORM_COMMAND,
        schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
        payload: { nodeId: payload.nodeId, transform: oldTransform },
      },
      changedRecords: !transformsEqual(oldTransform, payload.transform),
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

const setNodeComponentsHandler: CommandHandler<
  typeof NODE_SET_COMPONENTS_COMMAND,
  SetNodeComponentsPayload
> = {
  type: NODE_SET_COMPONENTS_COMMAND,
  schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): SetNodeComponentsPayload {
    void limits;
    if (!isRecord(payload)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a payload object",
        path: ["payload"],
      });
    }
    return {
      nodeId: parseNodeId(payload.nodeId, ["payload", "nodeId"]),
      components: parseComponents(payload.components, [
        "payload",
        "components",
      ]),
    };
  },
  validate(
    payload: SetNodeComponentsPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.nodes[payload.nodeId] === undefined) {
      throw missingNode(payload.nodeId);
    }
    validateComponents(payload.components, context, payload.nodeId);
  },
  execute(
    payload: SetNodeComponentsPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    const oldComponents = node.components;
    node.components = [...payload.components];
    return {
      inverse: {
        type: NODE_SET_COMPONENTS_COMMAND,
        schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
        payload: { nodeId: payload.nodeId, components: oldComponents },
      },
      changedRecords: !componentsEqual(oldComponents, payload.components),
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

const setNodeMetadataHandler: CommandHandler<
  typeof NODE_SET_METADATA_COMMAND,
  SetNodeMetadataPayload
> = {
  type: NODE_SET_METADATA_COMMAND,
  schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): SetNodeMetadataPayload {
    if (!isRecord(payload)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a payload object",
        path: ["payload"],
      });
    }
    return {
      nodeId: parseNodeId(payload.nodeId, ["payload", "nodeId"]),
      ...(payload.metadata !== undefined
        ? {
            metadata: parseMetadata(payload.metadata, limits, [
              "payload",
              "metadata",
            ]) as MetadataRecord,
          }
        : {}),
    };
  },
  validate(
    payload: SetNodeMetadataPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.nodes[payload.nodeId] === undefined) {
      throw missingNode(payload.nodeId);
    }
  },
  execute(
    payload: SetNodeMetadataPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    const oldMetadata = node.metadata;
    if (payload.metadata === undefined) {
      delete node.metadata;
    } else {
      node.metadata = payload.metadata;
    }
    const inversePayload: SetNodeMetadataPayload = {
      nodeId: payload.nodeId,
      ...(oldMetadata !== undefined ? { metadata: oldMetadata } : {}),
    };
    return {
      inverse: {
        type: NODE_SET_METADATA_COMMAND,
        schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
        payload: inversePayload,
      },
      changedRecords: !metadataEqual(oldMetadata, payload.metadata),
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

const deleteNodeHandler: CommandHandler<
  typeof NODE_DELETE_COMMAND,
  DeleteNodePayload
> = {
  type: NODE_DELETE_COMMAND,
  schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): DeleteNodePayload {
    void limits;
    if (!isRecord(payload)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a payload object",
        path: ["payload"],
      });
    }
    return {
      nodeId: parseNodeId(payload.nodeId, ["payload", "nodeId"]),
    };
  },
  validate(
    payload: DeleteNodePayload,
    context: CommandValidationContext,
  ): void {
    const node = context.document.nodes[payload.nodeId];
    // Deleting a node that is already absent is a no-op commit (the desired
    // end state already holds), matching the voxel no-op policy.
    if (node === undefined) return;
    if (payload.nodeId === context.document.rootNodeId) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_ROOT",
        message: "The document root cannot be deleted",
        context: { nodeId: payload.nodeId },
      });
    }
    if (node.children.length > 0) {
      throw new WorkspaceError({
        family: "validation",
        code: "NODE_HAS_CHILDREN",
        message:
          "Only leaf nodes can be deleted; delete or reparent the children first",
        context: { nodeId: payload.nodeId },
      });
    }
    for (const animation of Object.values(context.document.animations)) {
      for (const track of animation.tracks) {
        if (track.targetNodeId === payload.nodeId) {
          throw new WorkspaceError({
            family: "validation",
            code: "REFERENCED_NODE",
            message:
              "Node is targeted by an animation track and cannot be deleted",
            context: { nodeId: payload.nodeId },
          });
        }
      }
    }
  },
  execute(
    payload: DeleteNodePayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = document.nodes[payload.nodeId];
    if (node === undefined) {
      return {
        inverse: {
          type: NODE_DELETE_COMMAND,
          schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
          payload: { nodeId: payload.nodeId },
        },
        changedRecords: false,
        declaredAffectedResources: nodeResources(payload.nodeId),
      };
    }
    if (node.parentId === null) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_ROOT",
        message: "The document root cannot be deleted",
        context: { nodeId: payload.nodeId },
      });
    }
    const parent = mutableNode(document, node.parentId);
    const index = parent.children.indexOf(payload.nodeId);
    const inversePayload: CreateNodePayload = {
      nodeId: node.nodeId,
      parentId: node.parentId,
      transform: node.transform,
      components: [...node.components],
      ...(node.name !== undefined ? { name: node.name } : {}),
      ...(node.metadata !== undefined ? { metadata: node.metadata } : {}),
      ...(index >= 0 ? { index } : {}),
    };
    parent.children = parent.children.filter(
      (child) => child !== payload.nodeId,
    );
    document.nodes = Object.fromEntries(
      Object.entries(document.nodes).filter(([id]) => id !== payload.nodeId),
    ) as MutableDocument["nodes"];
    return {
      inverse: {
        type: NODE_CREATE_COMMAND,
        schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
        payload: inversePayload,
      },
      changedRecords: true,
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

const reparentNodeHandler: CommandHandler<
  typeof NODE_REPARENT_COMMAND,
  ReparentNodePayload
> = {
  type: NODE_REPARENT_COMMAND,
  schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): ReparentNodePayload {
    void limits;
    if (!isRecord(payload)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a payload object",
        path: ["payload"],
      });
    }
    const placement = parsePlacement(payload.placement);
    const hasTransform = payload.transform !== undefined;
    if (
      (placement === "preserve-world" || placement === "set-transform") &&
      !hasTransform
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: `${placement} reparenting requires the canonical transform`,
        path: ["payload", "transform"],
      });
    }
    if (placement === "preserve-local" && hasTransform) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "preserve-local reparenting must not carry a transform",
        path: ["payload", "transform"],
      });
    }
    return {
      nodeId: parseNodeId(payload.nodeId, ["payload", "nodeId"]),
      newParentId: parseNodeId(payload.newParentId, ["payload", "newParentId"]),
      placement,
      ...(hasTransform
        ? {
            transform: parseTransform(payload.transform, [
              "payload",
              "transform",
            ]),
          }
        : {}),
      ...(payload.index !== undefined
        ? { index: parseNonNegativeInteger(payload.index, "index") }
        : {}),
    };
  },
  validate(
    payload: ReparentNodePayload,
    context: CommandValidationContext,
  ): void {
    const node = context.document.nodes[payload.nodeId];
    if (node === undefined) throw missingNode(payload.nodeId);
    if (payload.nodeId === context.document.rootNodeId) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_ROOT",
        message: "The document root cannot be reparented",
        context: { nodeId: payload.nodeId },
      });
    }
    if (context.document.nodes[payload.newParentId] === undefined) {
      throw missingNode(payload.newParentId);
    }
    if (payload.newParentId === payload.nodeId) {
      throw new WorkspaceError({
        family: "validation",
        code: "SELF_PARENT",
        message: "A node cannot be its own parent",
        context: { nodeId: payload.nodeId },
      });
    }
    // Acyclicity: the new parent must not be the node or one of its
    // descendants (walking up from the new parent reaches the node).
    let ancestor: SceneNode | undefined =
      context.document.nodes[payload.newParentId];
    while (ancestor !== undefined) {
      if (ancestor.nodeId === payload.nodeId) {
        throw new WorkspaceError({
          family: "validation",
          code: "CYCLIC_HIERARCHY",
          message: "Reparenting would create a cycle in the hierarchy",
          context: { nodeId: payload.nodeId, newParentId: payload.newParentId },
        });
      }
      ancestor =
        ancestor.parentId === null
          ? undefined
          : context.document.nodes[ancestor.parentId];
    }
  },
  execute(
    payload: ReparentNodePayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    if (node.parentId === null) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_ROOT",
        message: "The document root cannot be reparented",
        context: { nodeId: payload.nodeId },
      });
    }
    const oldParentId = node.parentId;
    const oldTransform = node.transform;
    const oldParent = mutableNode(document, oldParentId);
    const oldIndex = oldParent.children.indexOf(payload.nodeId);
    oldParent.children = oldParent.children.filter(
      (child) => child !== payload.nodeId,
    );
    const newParent = mutableNode(document, payload.newParentId);
    newParent.children.splice(
      payload.index ?? newParent.children.length,
      0,
      payload.nodeId,
    );
    node.parentId = payload.newParentId;
    if (
      (payload.placement === "preserve-world" ||
        payload.placement === "set-transform") &&
      payload.transform !== undefined
    ) {
      node.transform = payload.transform;
    }
    return {
      inverse: {
        type: NODE_REPARENT_COMMAND,
        schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
        payload: {
          nodeId: payload.nodeId,
          newParentId: oldParentId,
          placement: "set-transform",
          transform: oldTransform,
          ...(oldIndex >= 0 ? { index: oldIndex } : {}),
        },
      },
      changedRecords: true,
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

function transformsEqual(a: Transform, b: Transform): boolean {
  return (
    a.translation[0] === b.translation[0] &&
    a.translation[1] === b.translation[1] &&
    a.translation[2] === b.translation[2] &&
    a.pivot[0] === b.pivot[0] &&
    a.pivot[1] === b.pivot[1] &&
    a.pivot[2] === b.pivot[2] &&
    a.rotation[0] === b.rotation[0] &&
    a.rotation[1] === b.rotation[1] &&
    a.rotation[2] === b.rotation[2] &&
    a.rotation[3] === b.rotation[3] &&
    a.scale[0] === b.scale[0] &&
    a.scale[1] === b.scale[1] &&
    a.scale[2] === b.scale[2]
  );
}

function componentsEqual(
  a: readonly Component[],
  b: readonly Component[],
): boolean {
  return (
    a.length === b.length &&
    a.every((component, index) => componentEqual(component, b[index]))
  );
}

function componentEqual(a: Component, b: Component | undefined): boolean {
  if (b === undefined) return false;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "voxel":
      return b.kind === "voxel" && a.volumeId === b.volumeId;
    case "pivot":
      return (
        b.kind === "pivot" &&
        a.pivot[0] === b.pivot[0] &&
        a.pivot[1] === b.pivot[1] &&
        a.pivot[2] === b.pivot[2]
      );
    case "joint":
      return b.kind === "joint";
    case "constraint":
      return (
        b.kind === "constraint" &&
        a.constraints.length === b.constraints.length &&
        a.constraints.every((constraint, index) => {
          const other = b.constraints[index];
          return (
            other !== undefined &&
            constraint.componentId === other.componentId &&
            constraint.limits.min[0] === other.limits.min[0] &&
            constraint.limits.min[1] === other.limits.min[1] &&
            constraint.limits.min[2] === other.limits.min[2] &&
            constraint.limits.max[0] === other.limits.max[0] &&
            constraint.limits.max[1] === other.limits.max[1] &&
            constraint.limits.max[2] === other.limits.max[2]
          );
        })
      );
  }
}

function metadataEqual(
  a: MetadataRecord | undefined,
  b: MetadataRecord | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  // Canonical comparison: RFC 8785 member ordering, so metadata that differs
  // only in key order compares equal (a no-op create stays a no-op).
  return canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue);
}

/** Registers the node hierarchy command handlers. */
export function registerNodeCommands(registry: CommandRegistry): void {
  registry.register(createNodeHandler);
  registry.register(renameNodeHandler);
  registry.register(setNodeTransformHandler);
  registry.register(setNodeComponentsHandler);
  registry.register(setNodeMetadataHandler);
  registry.register(deleteNodeHandler);
  registry.register(reparentNodeHandler);
}
