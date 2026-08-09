import {
  WorkspaceError,
  type CommandId,
  type NodeId,
} from "@voxel-maker/shared";
import { canonicalVec3, type Vec3 } from "@voxel-maker/math";
import type { DocumentLimits, PivotComponent } from "@voxel-maker/model";
import { isRecord, parseNodeId } from "./parse-helpers.js";
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

/**
 * Per-discriminant articulation component commands (plan S9.3, ticket
 * #26): pivot and joint are singletons per node, so their lifecycle is a
 * small set of create/update/remove commands instead of whole-list
 * replacement. A joint annotates a node in the single transform
 * hierarchy; it never introduces a second parent graph. Undo restores the
 * exact previous component list via the recorded inverse (which may be a
 * different command type, matching the node.create/node.delete pattern).
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
    const existing = pivotComponent(node.components);
    const pivot: PivotComponent = {
      kind: "pivot",
      schemaVersion: 1,
      pivot: payload.pivot,
    };
    if (existing !== undefined) {
      node.components = node.components.map((component) =>
        component.kind === "pivot" ? pivot : component,
      );
      const unchanged = vec3Equal(existing.pivot, payload.pivot);
      return {
        inverse: {
          type: NODE_SET_PIVOT_COMMAND,
          schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
          payload: { nodeId: payload.nodeId, pivot: existing.pivot },
        },
        changedRecords: !unchanged,
        declaredAffectedResources: nodeResources(payload.nodeId),
      };
    }
    node.components = [...node.components, pivot];
    return {
      inverse: {
        type: NODE_REMOVE_PIVOT_COMMAND,
        schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
        payload: { nodeId: payload.nodeId },
      },
      changedRecords: true,
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
    const existing = pivotComponent(node.components);
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
    node.components = node.components.filter(
      (component) => component.kind !== "pivot",
    );
    return {
      inverse: {
        type: NODE_SET_PIVOT_COMMAND,
        schemaVersion: ARTICULATION_COMMAND_SCHEMA_VERSION,
        payload: { nodeId: payload.nodeId, pivot: existing.pivot },
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

/** Registers the per-discriminant articulation component handlers. */
export function registerArticulationCommands(registry: CommandRegistry): void {
  registry.register(setPivotHandler);
  registry.register(removePivotHandler);
  registry.register(addJointHandler);
  registry.register(removeJointHandler);
}
