import {
  WorkspaceError,
  type CommandId,
  type ComponentId,
  type NodeId,
} from "@voxel-maker/shared";
import { canonicalVec3, type Vec3 } from "@voxel-maker/math";
import type {
  ConstraintComponent,
  ConstraintDescriptor,
  DocumentLimits,
  PivotComponent,
  RotationLimits,
  SceneNode,
  VoxelDocument,
} from "@voxel-maker/model";
import { isRecord, parseComponentId, parseNodeId } from "./parse-helpers.js";
import type { Command } from "./types.js";
import type {
  CommandExecution,
  CommandExecutionContext,
  CommandHandler,
  CommandValidationContext,
  InverseCommand,
  MutableDocument,
  MutableSceneNode,
} from "./registry.js";
import {
  NODE_COMMAND_SCHEMA_VERSION,
  NODE_SET_COMPONENTS_COMMAND,
  NODE_SET_TRANSFORM_COMMAND,
} from "./node-commands.js";
import { CommandRegistry } from "./registry.js";

/**
 * Per-discriminant articulation component commands (plan S9.3/S9.4,
 * tickets #26/#27): pivot and joint are singletons per node, so their
 * lifecycle is a small set of create/update/remove commands instead of
 * whole-list replacement. A joint annotates a node in the single
 * transform hierarchy; it never introduces a second parent graph.
 * `node.setPivot` writes through to `transform.pivot` so the annotation
 * and the approved transform formula stay in sync (plan S7.9:
 * geometry/world behavior matches ADR-0001). Constraints are stable,
 * explicitly ordered local Euler XYZ rotation limits (ADR-0006): the
 * `node.addConstraint` / `node.setConstraint` /
 * `node.reorderConstraint` / `node.removeConstraint` commands manage one
 * descriptor at a time with caller-supplied stable component ids, while
 * `node.setComponents` remains the whole-list replacement path. Undo
 * restores the exact pre-command state via the recorded inverses (which
 * may be different command types or a composite, matching the
 * node.create/node.delete pattern).
 */

export const NODE_SET_PIVOT_COMMAND = "node.setPivot" as const;
export const NODE_REMOVE_PIVOT_COMMAND = "node.removePivot" as const;
export const NODE_ADD_JOINT_COMMAND = "node.addJoint" as const;
export const NODE_REMOVE_JOINT_COMMAND = "node.removeJoint" as const;
export const ARTICULATION_COMMAND_SCHEMA_VERSION = 1;

export interface SetPivotPayload {
  readonly nodeId: NodeId;
  readonly pivot: Vec3;
}

export interface RemovePivotPayload {
  readonly nodeId: NodeId;
}

export interface AddJointPayload {
  readonly nodeId: NodeId;
}

export interface RemoveJointPayload {
  readonly nodeId: NodeId;
}

/** Canonicalizing constructor for a `node.setPivot` command. */
export function setPivotCommand(
  id: CommandId,
  payload: SetPivotPayload,
): Command<typeof NODE_SET_PIVOT_COMMAND, SetPivotPayload> {
  return {
    id,
    type: NODE_SET_PIVOT_COMMAND,
    schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
    payload: {
      nodeId: payload.nodeId,
      pivot: canonicalVec3(payload.pivot),
    },
  };
}

/** Canonicalizing constructor for a `node.removePivot` command. */
export function removePivotCommand(
  id: CommandId,
  payload: RemovePivotPayload,
): Command<typeof NODE_REMOVE_PIVOT_COMMAND, RemovePivotPayload> {
  return {
    id,
    type: NODE_REMOVE_PIVOT_COMMAND,
    schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
    payload: { nodeId: payload.nodeId },
  };
}

/** Canonicalizing constructor for a `node.addJoint` command. */
export function addJointCommand(
  id: CommandId,
  payload: AddJointPayload,
): Command<typeof NODE_ADD_JOINT_COMMAND, AddJointPayload> {
  return {
    id,
    type: NODE_ADD_JOINT_COMMAND,
    schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
    payload: { nodeId: payload.nodeId },
  };
}

/** Canonicalizing constructor for a `node.removeJoint` command. */
export function removeJointCommand(
  id: CommandId,
  payload: RemoveJointPayload,
): Command<typeof NODE_REMOVE_JOINT_COMMAND, RemoveJointPayload> {
  return {
    id,
    type: NODE_REMOVE_JOINT_COMMAND,
    schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
    payload: { nodeId: payload.nodeId },
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
      message: "Numbers must be finite and must not be negative zero",
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

function parseNodePayload(
  payload: unknown,
  limits: DocumentLimits,
): { readonly nodeId: NodeId; readonly pivot?: Vec3 } {
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
    ...(payload.pivot !== undefined
      ? { pivot: parseVec3(payload.pivot, ["payload", "pivot"]) }
      : {}),
  };
}

const setPivotHandler: CommandHandler<
  typeof NODE_SET_PIVOT_COMMAND,
  SetPivotPayload
> = {
  type: NODE_SET_PIVOT_COMMAND,
  schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): SetPivotPayload {
    const parsed = parseNodePayload(payload, limits);
    if (parsed.pivot === undefined) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "node.setPivot requires the pivot vector",
        path: ["payload", "pivot"],
      });
    }
    return { nodeId: parsed.nodeId, pivot: parsed.pivot };
  },
  validate(payload: SetPivotPayload, context: CommandValidationContext): void {
    if (context.document.nodes[payload.nodeId] === undefined) {
      throw missingNode(payload.nodeId);
    }
  },
  execute(
    payload: SetPivotPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    const transformBefore = node.transform;
    const existing = pivotComponent(node.components);
    const pivot: PivotComponent = {
      kind: "pivot",
      schemaVersion: 1,
      pivot: payload.pivot,
    };
    // Write-through: the pivot annotation is the declared articulation
    // point, and transform.pivot is the value the approved transform
    // formula evaluates (plan S7.9: the pivot command's geometry/world
    // behavior matches ADR-0001). The command keeps both in sync so the
    // annotation is never an inert copy.
    const transformUnchanged = vec3Equal(node.transform.pivot, payload.pivot);
    node.transform = { ...node.transform, pivot: payload.pivot };
    const existed = existing !== undefined;
    if (existed) {
      node.components = node.components.map((component) =>
        component.kind === "pivot" ? pivot : component,
      );
    } else {
      node.components = [...node.components, pivot];
    }
    const componentUnchanged =
      existing !== undefined && vec3Equal(existing.pivot, payload.pivot);
    const inverse: InverseCommand[] = existed
      ? [
          {
            type: NODE_SET_PIVOT_COMMAND,
            schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
            payload: { nodeId: payload.nodeId, pivot: existing.pivot },
          },
        ]
      : [
          // Replayed in reverse: restore the previous transform (and with
          // it transform.pivot), then drop the annotation.
          {
            type: NODE_SET_TRANSFORM_COMMAND,
            schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
            payload: { nodeId: payload.nodeId, transform: transformBefore },
          },
          {
            type: NODE_REMOVE_PIVOT_COMMAND,
            schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
            payload: { nodeId: payload.nodeId },
          },
        ];
    return {
      inverse,
      changedRecords: !(transformUnchanged && componentUnchanged),
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

const removePivotHandler: CommandHandler<
  typeof NODE_REMOVE_PIVOT_COMMAND,
  RemovePivotPayload
> = {
  type: NODE_REMOVE_PIVOT_COMMAND,
  schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): RemovePivotPayload {
    return { nodeId: parseNodePayload(payload, limits).nodeId };
  },
  validate(
    payload: RemovePivotPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.nodes[payload.nodeId] === undefined) {
      throw missingNode(payload.nodeId);
    }
  },
  execute(
    payload: RemovePivotPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    const oldComponents = node.components;
    const existing = pivotComponent(oldComponents);
    if (existing === undefined) {
      // Removing an absent singleton is a no-op commit, matching the
      // node.delete no-op policy: history stays uniform.
      return {
        inverse: {
          type: NODE_REMOVE_PIVOT_COMMAND,
          schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
          payload: { nodeId: payload.nodeId },
        },
        changedRecords: false,
        declaredAffectedResources: nodeResources(payload.nodeId),
      };
    }
    // The annotation is removed but transform.pivot is untouched: the
    // node keeps its geometric pivot and only loses the articulation
    // declaration. The exact inverse restores the component list.
    node.components = oldComponents.filter(
      (component) => component.kind !== "pivot",
    );
    return {
      inverse: {
        type: NODE_SET_COMPONENTS_COMMAND,
        schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
        payload: { nodeId: payload.nodeId, components: oldComponents },
      },
      changedRecords: true,
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

const addJointHandler: CommandHandler<
  typeof NODE_ADD_JOINT_COMMAND,
  AddJointPayload
> = {
  type: NODE_ADD_JOINT_COMMAND,
  schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): AddJointPayload {
    return { nodeId: parseNodePayload(payload, limits).nodeId };
  },
  validate(payload: AddJointPayload, context: CommandValidationContext): void {
    if (context.document.nodes[payload.nodeId] === undefined) {
      throw missingNode(payload.nodeId);
    }
  },
  execute(
    payload: AddJointPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    const hasJoint = node.components.some(
      (component) => component.kind === "joint",
    );
    if (hasJoint) {
      return {
        inverse: {
          type: NODE_ADD_JOINT_COMMAND,
          schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
          payload: { nodeId: payload.nodeId },
        },
        changedRecords: false,
        declaredAffectedResources: nodeResources(payload.nodeId),
      };
    }
    node.components = [...node.components, { kind: "joint", schemaVersion: 1 }];
    return {
      inverse: {
        type: NODE_REMOVE_JOINT_COMMAND,
        schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
        payload: { nodeId: payload.nodeId },
      },
      changedRecords: true,
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

const removeJointHandler: CommandHandler<
  typeof NODE_REMOVE_JOINT_COMMAND,
  RemoveJointPayload
> = {
  type: NODE_REMOVE_JOINT_COMMAND,
  schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): RemoveJointPayload {
    return { nodeId: parseNodePayload(payload, limits).nodeId };
  },
  validate(
    payload: RemoveJointPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.nodes[payload.nodeId] === undefined) {
      throw missingNode(payload.nodeId);
    }
  },
  execute(
    payload: RemoveJointPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    const hasJoint = node.components.some(
      (component) => component.kind === "joint",
    );
    if (!hasJoint) {
      return {
        inverse: {
          type: NODE_REMOVE_JOINT_COMMAND,
          schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
          payload: { nodeId: payload.nodeId },
        },
        changedRecords: false,
        declaredAffectedResources: nodeResources(payload.nodeId),
      };
    }
    node.components = node.components.filter(
      (component) => component.kind !== "joint",
    );
    return {
      inverse: {
        type: NODE_ADD_JOINT_COMMAND,
        schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
        payload: { nodeId: payload.nodeId },
      },
      changedRecords: true,
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

function pivotComponent(
  components: readonly { readonly kind: string }[],
): PivotComponent | undefined {
  return components.find(
    (component): component is PivotComponent => component.kind === "pivot",
  );
}

const vec3Equal = (a: Vec3, b: Vec3): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

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

export const NODE_ADD_CONSTRAINT_COMMAND = "node.addConstraint" as const;
export const NODE_SET_CONSTRAINT_COMMAND = "node.setConstraint" as const;
export const NODE_REORDER_CONSTRAINT_COMMAND =
  "node.reorderConstraint" as const;
export const NODE_REMOVE_CONSTRAINT_COMMAND = "node.removeConstraint" as const;

export interface AddConstraintPayload {
  readonly nodeId: NodeId;
  readonly componentId: ComponentId;
  readonly limits: RotationLimits;
  /**
   * Insert the new constraint before this constraint's stable id; `null`
   * appends at the end. The target must be another constraint on the
   * same node.
   */
  readonly before: ComponentId | null;
}

export interface SetConstraintPayload {
  readonly nodeId: NodeId;
  readonly componentId: ComponentId;
  readonly limits: RotationLimits;
}

export interface ReorderConstraintPayload {
  readonly nodeId: NodeId;
  readonly componentId: ComponentId;
  /**
   * Move the constraint before this constraint's stable id; `null` moves
   * it to the end. The target must be another constraint on the same
   * node.
   */
  readonly before: ComponentId | null;
}

export interface RemoveConstraintPayload {
  readonly nodeId: NodeId;
  readonly componentId: ComponentId;
}

/** Canonicalizing constructor for a `node.addConstraint` command. */
export function addConstraintCommand(
  id: CommandId,
  payload: AddConstraintPayload,
): Command<typeof NODE_ADD_CONSTRAINT_COMMAND, AddConstraintPayload> {
  return {
    id,
    type: NODE_ADD_CONSTRAINT_COMMAND,
    schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
    payload: {
      nodeId: payload.nodeId,
      componentId: payload.componentId,
      limits: canonicalLimits(payload.limits),
      before: payload.before ?? null,
    },
  };
}

/** Canonicalizing constructor for a `node.setConstraint` command. */
export function setConstraintCommand(
  id: CommandId,
  payload: SetConstraintPayload,
): Command<typeof NODE_SET_CONSTRAINT_COMMAND, SetConstraintPayload> {
  return {
    id,
    type: NODE_SET_CONSTRAINT_COMMAND,
    schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
    payload: {
      nodeId: payload.nodeId,
      componentId: payload.componentId,
      limits: canonicalLimits(payload.limits),
    },
  };
}

/** Canonicalizing constructor for a `node.reorderConstraint` command. */
export function reorderConstraintCommand(
  id: CommandId,
  payload: ReorderConstraintPayload,
): Command<typeof NODE_REORDER_CONSTRAINT_COMMAND, ReorderConstraintPayload> {
  return {
    id,
    type: NODE_REORDER_CONSTRAINT_COMMAND,
    schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
    payload: {
      nodeId: payload.nodeId,
      componentId: payload.componentId,
      before: payload.before ?? null,
    },
  };
}

/** Canonicalizing constructor for a `node.removeConstraint` command. */
export function removeConstraintCommand(
  id: CommandId,
  payload: RemoveConstraintPayload,
): Command<typeof NODE_REMOVE_CONSTRAINT_COMMAND, RemoveConstraintPayload> {
  return {
    id,
    type: NODE_REMOVE_CONSTRAINT_COMMAND,
    schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
    payload: {
      nodeId: payload.nodeId,
      componentId: payload.componentId,
    },
  };
}

function canonicalLimits(limits: RotationLimits): RotationLimits {
  return { min: canonicalVec3(limits.min), max: canonicalVec3(limits.max) };
}

function invalidConstraint(
  message: string,
  path: readonly (string | number)[],
): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: "INVALID_CONSTRAINT",
    message,
    path,
  });
}

function parseRotationLimits(
  value: unknown,
  path: readonly (string | number)[],
): RotationLimits {
  if (!isRecord(value)) {
    throw invalidConstraint("Expected rotation limits", path);
  }
  for (const key of Object.keys(value)) {
    if (key !== "min" && key !== "max") {
      throw invalidConstraint(`Unknown limits field ${key}`, [...path, key]);
    }
  }
  const min = parseVec3(value.min, [...path, "min"]);
  const max = parseVec3(value.max, [...path, "max"]);
  for (let axis = 0; axis < 3; axis += 1) {
    if ((min[axis] as number) > (max[axis] as number)) {
      throw invalidConstraint(
        `Rotation limit minimum exceeds maximum on axis ${String(axis)}`,
        [...path, "limits"],
      );
    }
  }
  return { min, max };
}

function parseConstraintPayload(payload: unknown): {
  readonly nodeId: NodeId;
  readonly componentId?: ComponentId;
  readonly limits?: RotationLimits;
  readonly before?: ComponentId | null;
} {
  if (!isRecord(payload)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a payload object",
      path: ["payload"],
    });
  }
  for (const key of Object.keys(payload)) {
    if (
      key !== "nodeId" &&
      key !== "componentId" &&
      key !== "limits" &&
      key !== "before"
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "UNKNOWN_FIELD",
        message: `Unknown constraint command field ${key}`,
        path: ["payload", key],
      });
    }
  }
  return {
    nodeId: parseNodeId(payload.nodeId, ["payload", "nodeId"]),
    ...(payload.componentId !== undefined
      ? {
          componentId: parseComponentId(payload.componentId, [
            "payload",
            "componentId",
          ]),
        }
      : {}),
    ...(payload.limits !== undefined
      ? { limits: parseRotationLimits(payload.limits, ["payload", "limits"]) }
      : {}),
    ...(payload.before !== undefined
      ? {
          before:
            payload.before === null
              ? null
              : parseComponentId(payload.before, ["payload", "before"]),
        }
      : {}),
  };
}

function missingConstraint(componentIdValue: ComponentId): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: "MISSING_CONSTRAINT",
    message: "Node has no constraint with this component id",
    context: { componentId: componentIdValue },
  });
}

function invalidOrderTarget(componentIdValue: ComponentId): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: "INVALID_ORDER_TARGET",
    message: "The order target must be another constraint on the same node",
    context: { componentId: componentIdValue },
  });
}

/** The constraint component of a node, if present. */
function constraintHolder(
  node: SceneNode,
):
  | { readonly component: ConstraintComponent; readonly index: number }
  | undefined {
  for (let index = 0; index < node.components.length; index += 1) {
    const component = node.components[index];
    if (component !== undefined && component.kind === "constraint") {
      return { component, index };
    }
  }
  return undefined;
}

interface ConstraintEntry {
  readonly descriptor: ConstraintDescriptor;
  /** Index of the descriptor inside the constraint component's list. */
  readonly index: number;
}

function findConstraint(
  node: SceneNode,
  componentIdValue: ComponentId,
): ConstraintEntry | undefined {
  const holder = constraintHolder(node);
  if (holder === undefined) return undefined;
  for (let index = 0; index < holder.component.constraints.length; index += 1) {
    const descriptor = holder.component.constraints[index];
    if (
      descriptor !== undefined &&
      descriptor.componentId === componentIdValue
    ) {
      return { descriptor, index };
    }
  }
  return undefined;
}

function requireConstraint(
  node: SceneNode,
  componentIdValue: ComponentId,
): ConstraintEntry {
  const entry = findConstraint(node, componentIdValue);
  if (entry === undefined) throw missingConstraint(componentIdValue);
  return entry;
}

/** True when any constraint in the document carries the component id. */
function documentHasConstraintId(
  document: VoxelDocument,
  componentIdValue: ComponentId,
): boolean {
  for (const node of Object.values(document.nodes)) {
    for (const component of node.components) {
      if (component.kind !== "constraint") continue;
      for (const constraint of component.constraints) {
        if (constraint.componentId === componentIdValue) return true;
      }
    }
  }
  return false;
}

/** Validates the `before` order target of add/reorder. */
function requireOrderTarget(
  node: SceneNode,
  componentIdValue: ComponentId,
  before: ComponentId | null,
): void {
  if (before === null) return;
  if (before === componentIdValue) throw invalidOrderTarget(before);
  if (findConstraint(node, before) === undefined) {
    throw invalidOrderTarget(before);
  }
}

/** Inserts `value` at `index` in a new array (index == length appends). */
function insertAt<T>(list: readonly T[], index: number, value: T): T[] {
  return [...list.slice(0, index), value, ...list.slice(index)];
}

/** Replaces the constraint component with a new constraints list. */
function setConstraintList(
  node: MutableSceneNode,
  holderIndex: number,
  constraints: readonly ConstraintDescriptor[],
): void {
  node.components = node.components.map((component, index) =>
    index === holderIndex
      ? { kind: "constraint", schemaVersion: 1, constraints }
      : component,
  );
}

const addConstraintHandler: CommandHandler<
  typeof NODE_ADD_CONSTRAINT_COMMAND,
  AddConstraintPayload
> = {
  type: NODE_ADD_CONSTRAINT_COMMAND,
  schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): AddConstraintPayload {
    void limits;
    const parsed = parseConstraintPayload(payload);
    if (
      parsed.componentId === undefined ||
      parsed.limits === undefined ||
      parsed.before === undefined
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message:
          "node.addConstraint requires nodeId, componentId, limits, and before",
        path: ["payload"],
      });
    }
    return {
      nodeId: parsed.nodeId,
      componentId: parsed.componentId,
      limits: parsed.limits,
      before: parsed.before,
    };
  },
  validate(
    payload: AddConstraintPayload,
    context: CommandValidationContext,
  ): void {
    const node = context.document.nodes[payload.nodeId];
    if (node === undefined) throw missingNode(payload.nodeId);
    const existing = findConstraint(node, payload.componentId);
    if (existing === undefined) {
      if (documentHasConstraintId(context.document, payload.componentId)) {
        throw new WorkspaceError({
          family: "validation",
          code: "DUPLICATE_COMPONENT_ID",
          message:
            "Constraint component IDs must be unique within the document",
          context: { componentId: payload.componentId },
        });
      }
    } else if (
      !rotationLimitsEqual(existing.descriptor.limits, payload.limits)
    ) {
      // Re-adding the same id with different limits is a create conflict
      // (matching node.create); an identical re-add is a no-op commit.
      throw new WorkspaceError({
        family: "validation",
        code: "DUPLICATE_COMPONENT_ID",
        message: "Constraint component IDs must be unique within the document",
        context: { componentId: payload.componentId },
      });
    }
    requireOrderTarget(node, payload.componentId, payload.before);
  },
  execute(
    payload: AddConstraintPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    const componentsBefore = node.components;
    const holder = constraintHolder(node);
    const descriptor: ConstraintDescriptor = {
      componentId: payload.componentId,
      type: "rotation-limits",
      limits: payload.limits,
    };
    const existing =
      holder === undefined
        ? undefined
        : findConstraint(node, payload.componentId);
    if (existing !== undefined && holder !== undefined) {
      // Identical re-add (same id, limits, and position) is a no-op
      // commit, matching node.create. An identical id moved to another
      // position is a deterministic move with a reorder inverse.
      const removed = holder.component.constraints.filter(
        (constraint) => constraint.componentId !== payload.componentId,
      );
      const targetIndex =
        payload.before === null
          ? removed.length
          : removed.findIndex(
              (constraint) => constraint.componentId === payload.before,
            );
      if (targetIndex === existing.index) {
        return {
          inverse: {
            type: NODE_ADD_CONSTRAINT_COMMAND,
            schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
            payload: {
              nodeId: payload.nodeId,
              componentId: payload.componentId,
              limits: payload.limits,
              before: payload.before,
            },
          },
          changedRecords: false,
          declaredAffectedResources: nodeResources(payload.nodeId),
        };
      }
      setConstraintList(
        node,
        holder.index,
        insertAt(removed, targetIndex, descriptor),
      );
      const restoreBefore = removed[existing.index]?.componentId ?? null;
      return {
        inverse: {
          type: NODE_REORDER_CONSTRAINT_COMMAND,
          schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
          payload: {
            nodeId: payload.nodeId,
            componentId: payload.componentId,
            before: restoreBefore,
          },
        },
        changedRecords: true,
        declaredAffectedResources: nodeResources(payload.nodeId),
      };
    }
    if (holder === undefined) {
      node.components = [
        ...node.components,
        { kind: "constraint", schemaVersion: 1, constraints: [descriptor] },
      ];
      return {
        inverse: {
          type: NODE_REMOVE_CONSTRAINT_COMMAND,
          schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
          payload: { nodeId: payload.nodeId, componentId: payload.componentId },
        },
        changedRecords: true,
        declaredAffectedResources: nodeResources(payload.nodeId),
      };
    }
    const targetIndex =
      payload.before === null
        ? holder.component.constraints.length
        : holder.component.constraints.findIndex(
            (entry) => entry.componentId === payload.before,
          );
    setConstraintList(
      node,
      holder.index,
      insertAt(holder.component.constraints, targetIndex, descriptor),
    );
    if (holder.component.constraints.length === 0) {
      // The node carried an empty constraint component (only possible via
      // whole-list replacement). The inverse must recreate that empty
      // component, so it is a whole-list restore of the exact pre-state.
      return {
        inverse: {
          type: NODE_SET_COMPONENTS_COMMAND,
          schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
          payload: { nodeId: payload.nodeId, components: componentsBefore },
        },
        changedRecords: true,
        declaredAffectedResources: nodeResources(payload.nodeId),
      };
    }
    return {
      inverse: {
        type: NODE_REMOVE_CONSTRAINT_COMMAND,
        schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
        payload: { nodeId: payload.nodeId, componentId: payload.componentId },
      },
      changedRecords: true,
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

const setConstraintHandler: CommandHandler<
  typeof NODE_SET_CONSTRAINT_COMMAND,
  SetConstraintPayload
> = {
  type: NODE_SET_CONSTRAINT_COMMAND,
  schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): SetConstraintPayload {
    void limits;
    const parsed = parseConstraintPayload(payload);
    if (parsed.componentId === undefined || parsed.limits === undefined) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "node.setConstraint requires nodeId, componentId, and limits",
        path: ["payload"],
      });
    }
    return {
      nodeId: parsed.nodeId,
      componentId: parsed.componentId,
      limits: parsed.limits,
    };
  },
  validate(
    payload: SetConstraintPayload,
    context: CommandValidationContext,
  ): void {
    const node = context.document.nodes[payload.nodeId];
    if (node === undefined) throw missingNode(payload.nodeId);
    requireConstraint(node, payload.componentId);
  },
  execute(
    payload: SetConstraintPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    const entry = requireConstraint(node, payload.componentId);
    if (rotationLimitsEqual(entry.descriptor.limits, payload.limits)) {
      return {
        inverse: {
          type: NODE_SET_CONSTRAINT_COMMAND,
          schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
          payload: {
            nodeId: payload.nodeId,
            componentId: payload.componentId,
            limits: payload.limits,
          },
        },
        changedRecords: false,
        declaredAffectedResources: nodeResources(payload.nodeId),
      };
    }
    const holder = constraintHolder(node);
    if (holder === undefined) throw missingConstraint(payload.componentId);
    const constraints = holder.component.constraints.map((constraint, index) =>
      index === entry.index
        ? { ...constraint, limits: payload.limits }
        : constraint,
    );
    setConstraintList(node, holder.index, constraints);
    return {
      inverse: {
        type: NODE_SET_CONSTRAINT_COMMAND,
        schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
        payload: {
          nodeId: payload.nodeId,
          componentId: payload.componentId,
          limits: entry.descriptor.limits,
        },
      },
      changedRecords: true,
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

const reorderConstraintHandler: CommandHandler<
  typeof NODE_REORDER_CONSTRAINT_COMMAND,
  ReorderConstraintPayload
> = {
  type: NODE_REORDER_CONSTRAINT_COMMAND,
  schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): ReorderConstraintPayload {
    void limits;
    const parsed = parseConstraintPayload(payload);
    if (parsed.componentId === undefined || parsed.before === undefined) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message:
          "node.reorderConstraint requires nodeId, componentId, and before",
        path: ["payload"],
      });
    }
    return {
      nodeId: parsed.nodeId,
      componentId: parsed.componentId,
      before: parsed.before,
    };
  },
  validate(
    payload: ReorderConstraintPayload,
    context: CommandValidationContext,
  ): void {
    const node = context.document.nodes[payload.nodeId];
    if (node === undefined) throw missingNode(payload.nodeId);
    requireConstraint(node, payload.componentId);
    requireOrderTarget(node, payload.componentId, payload.before);
  },
  execute(
    payload: ReorderConstraintPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    const entry = requireConstraint(node, payload.componentId);
    const holder = constraintHolder(node);
    if (holder === undefined) throw missingConstraint(payload.componentId);
    const removed = holder.component.constraints.filter(
      (constraint) => constraint.componentId !== payload.componentId,
    );
    const targetIndex =
      payload.before === null
        ? removed.length
        : removed.findIndex(
            (constraint) => constraint.componentId === payload.before,
          );
    if (targetIndex === entry.index) {
      return {
        inverse: {
          type: NODE_REORDER_CONSTRAINT_COMMAND,
          schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
          payload: {
            nodeId: payload.nodeId,
            componentId: payload.componentId,
            before: payload.before,
          },
        },
        changedRecords: false,
        declaredAffectedResources: nodeResources(payload.nodeId),
      };
    }
    setConstraintList(
      node,
      holder.index,
      insertAt(removed, targetIndex, entry.descriptor),
    );
    // Exact inverse: move the descriptor back to its original index,
    // expressed as a `before` target in the post-move list.
    const restoreBefore = removed[entry.index]?.componentId ?? null;
    return {
      inverse: {
        type: NODE_REORDER_CONSTRAINT_COMMAND,
        schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
        payload: {
          nodeId: payload.nodeId,
          componentId: payload.componentId,
          before: restoreBefore,
        },
      },
      changedRecords: true,
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

const removeConstraintHandler: CommandHandler<
  typeof NODE_REMOVE_CONSTRAINT_COMMAND,
  RemoveConstraintPayload
> = {
  type: NODE_REMOVE_CONSTRAINT_COMMAND,
  schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): RemoveConstraintPayload {
    void limits;
    const parsed = parseConstraintPayload(payload);
    if (parsed.componentId === undefined) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "node.removeConstraint requires nodeId and componentId",
        path: ["payload"],
      });
    }
    return { nodeId: parsed.nodeId, componentId: parsed.componentId };
  },
  validate(
    payload: RemoveConstraintPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.nodes[payload.nodeId] === undefined) {
      throw missingNode(payload.nodeId);
    }
  },
  execute(
    payload: RemoveConstraintPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const node = mutableNode(document, payload.nodeId);
    const componentsBefore = node.components;
    const entry = findConstraint(node, payload.componentId);
    if (entry === undefined) {
      // Removing an absent constraint is a no-op commit, matching the
      // removePivot/removeJoint no-op policy: history stays uniform.
      return {
        inverse: {
          type: NODE_REMOVE_CONSTRAINT_COMMAND,
          schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
          payload: { nodeId: payload.nodeId, componentId: payload.componentId },
        },
        changedRecords: false,
        declaredAffectedResources: nodeResources(payload.nodeId),
      };
    }
    const holder = constraintHolder(node);
    if (holder === undefined) throw missingConstraint(payload.componentId);
    const remaining = holder.component.constraints.filter(
      (constraint) => constraint.componentId !== payload.componentId,
    );
    if (remaining.length === 0) {
      // The last constraint goes away with the component; the exact
      // inverse restores the whole pre-command component list.
      node.components = node.components.filter(
        (component, index) => index !== holder.index,
      );
      return {
        inverse: {
          type: NODE_SET_COMPONENTS_COMMAND,
          schemaVersion: NODE_COMMAND_SCHEMA_VERSION,
          payload: { nodeId: payload.nodeId, components: componentsBefore },
        },
        changedRecords: true,
        declaredAffectedResources: nodeResources(payload.nodeId),
      };
    }
    setConstraintList(node, holder.index, remaining);
    // Exact inverse: re-insert the descriptor at its old position via
    // `before` (the constraint that followed it), or append when it was
    // the last constraint.
    const restoreBefore = remaining[entry.index]?.componentId ?? null;
    return {
      inverse: {
        type: NODE_ADD_CONSTRAINT_COMMAND,
        schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
        payload: {
          nodeId: payload.nodeId,
          componentId: payload.componentId,
          limits: entry.descriptor.limits,
          before: restoreBefore,
        },
      },
      changedRecords: true,
      declaredAffectedResources: nodeResources(payload.nodeId),
    };
  },
};

export function rotationLimitsEqual(
  a: RotationLimits,
  b: RotationLimits,
): boolean {
  return (
    a.min[0] === b.min[0] &&
    a.min[1] === b.min[1] &&
    a.min[2] === b.min[2] &&
    a.max[0] === b.max[0] &&
    a.max[1] === b.max[1] &&
    a.max[2] === b.max[2]
  );
}

/** Registers the per-discriminant articulation component handlers. */
export function registerArticulationCommands(registry: CommandRegistry): void {
  registry.register(setPivotHandler);
  registry.register(removePivotHandler);
  registry.register(addJointHandler);
  registry.register(removeJointHandler);
  registry.register(addConstraintHandler);
  registry.register(setConstraintHandler);
  registry.register(reorderConstraintHandler);
  registry.register(removeConstraintHandler);
}
