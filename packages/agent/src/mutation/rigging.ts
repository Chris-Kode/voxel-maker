import {
  addConstraintCommand,
  addJointCommand,
  removeConstraintCommand,
  removeJointCommand,
  removePivotCommand,
  setConstraintCommand,
  setPivotCommand,
} from "@voxel-maker/commands";
import { componentId, type JsonValue } from "@voxel-maker/shared";
import {
  invalidArgument,
  mutationOutputSchema,
  vec3Schema,
  type ToolContract,
} from "../contract.js";
import { requireNode } from "../tools/helpers.js";
import type { MutationToolContext, MutationPayload } from "./context.js";
import { estimateVoxelDelta } from "./estimate.js";
import { requireNodeId, requireString, resolveCommandId } from "./parse.js";

/**
 * Rigging mutation tools (plan S13.5, ticket #36): pivots, joints, and
 * rotation-limit constraints that compile only to registered articulation
 * commands (`node.setPivot`, `node.addJoint`, `node.addConstraint`, ...).
 * Every handler validates arguments against the current read surface,
 * then constructs exactly one command with an explicit id; nothing is
 * executed here and no command type outside the registered articulation
 * surface can be produced.
 */

const ID_SCHEMA = { type: "string", minLength: 1, maxLength: 128 } as const;

/** JSON Schema of one rotation-limits record (`min`/`max` vectors). */
function rotationLimitsSchema(): {
  readonly type: "object";
  readonly additionalProperties: false;
  readonly properties: {
    readonly min: ReturnType<typeof vec3Schema>;
    readonly max: ReturnType<typeof vec3Schema>;
  };
  readonly required: readonly ["min", "max"];
} {
  return {
    type: "object",
    additionalProperties: false,
    properties: { min: vec3Schema(), max: vec3Schema() },
    required: ["min", "max"],
  };
}

/** Validates and bounds a rotation-limits argument (`min <= max` per axis). */
function requireRotationLimits(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
} {
  const value = record[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidArgument(`${key} must be an object with min and max`, [key]);
  }
  const limits = value as Readonly<Record<string, JsonValue>>;
  const min = limits.min;
  const max = limits.max;
  if (
    !Array.isArray(min) ||
    min.length !== 3 ||
    !min.every((item) => typeof item === "number" && Number.isFinite(item)) ||
    !Array.isArray(max) ||
    max.length !== 3 ||
    !max.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    invalidArgument(`${key} must carry finite [x, y, z] min and max arrays`, [
      key,
    ]);
  }
  const minValue = min as readonly number[];
  const maxValue = max as readonly number[];
  for (const axis of [0, 1, 2] as const) {
    if ((minValue[axis] as number) > (maxValue[axis] as number)) {
      invalidArgument(`${key} must satisfy min <= max on every axis`, [
        key,
        axis,
      ]);
    }
  }
  return {
    min: [minValue[0] as number, minValue[1] as number, minValue[2] as number],
    max: [maxValue[0] as number, maxValue[1] as number, maxValue[2] as number],
  };
}

/** `setNodePivot` contract: construct a `node.setPivot` command. */
export const SET_NODE_PIVOT_CONTRACT: ToolContract = {
  name: "setNodePivot",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.setPivot command placing the node's pivot (rotation origin, local space). Missing nodes fail with UNKNOWN_NODE.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
      pivot: vec3Schema(),
    },
    required: ["nodeId", "pivot"],
  },
  outputSchema: mutationOutputSchema("setNodePivot"),
};

export function setNodePivot(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  const pivot = requirePivot(record);
  const command = setPivotCommand(resolveCommandId(ctx, record), {
    nodeId: nodeIdValue,
    pivot,
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

/** `removeNodePivot` contract: construct a `node.removePivot` command. */
export const REMOVE_NODE_PIVOT_CONTRACT: ToolContract = {
  name: "removeNodePivot",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.removePivot command removing the node's pivot annotation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
    },
    required: ["nodeId"],
  },
  outputSchema: mutationOutputSchema("removeNodePivot"),
};

export function removeNodePivot(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  const command = removePivotCommand(resolveCommandId(ctx, record), {
    nodeId: nodeIdValue,
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

/** `addNodeJoint` contract: construct a `node.addJoint` command. */
export const ADD_NODE_JOINT_CONTRACT: ToolContract = {
  name: "addNodeJoint",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.addJoint command annotating the node as a joint (constraint evaluation order).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
    },
    required: ["nodeId"],
  },
  outputSchema: mutationOutputSchema("addNodeJoint"),
};

export function addNodeJoint(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  const command = addJointCommand(resolveCommandId(ctx, record), {
    nodeId: nodeIdValue,
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

/** `removeNodeJoint` contract: construct a `node.removeJoint` command. */
export const REMOVE_NODE_JOINT_CONTRACT: ToolContract = {
  name: "removeNodeJoint",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.removeJoint command removing the node's joint annotation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
    },
    required: ["nodeId"],
  },
  outputSchema: mutationOutputSchema("removeNodeJoint"),
};

export function removeNodeJoint(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  const command = removeJointCommand(resolveCommandId(ctx, record), {
    nodeId: nodeIdValue,
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

/** `addConstraint` contract: construct a `node.addConstraint` command. */
export const ADD_CONSTRAINT_CONTRACT: ToolContract = {
  name: "addConstraint",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.addConstraint command adding one rotation-limits constraint with an explicit component id.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
      componentId: ID_SCHEMA,
      limits: rotationLimitsSchema(),
      before: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description:
          "Insert before this constraint's component id (default: append)",
      },
    },
    required: ["nodeId", "componentId", "limits"],
  },
  outputSchema: mutationOutputSchema("addConstraint"),
};

export function addConstraint(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  const componentIdValue = componentId(requireString(record, "componentId"));
  const before = record.before;
  if (before !== undefined && before !== null && typeof before !== "string") {
    invalidArgument("before must be a component id or null", ["before"]);
  }
  const command = addConstraintCommand(resolveCommandId(ctx, record), {
    nodeId: nodeIdValue,
    componentId: componentIdValue,
    limits: requireRotationLimits(record, "limits"),
    before:
      before === undefined || before === null ? null : componentId(before),
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

/** `setConstraint` contract: construct a `node.setConstraint` command. */
export const SET_CONSTRAINT_CONTRACT: ToolContract = {
  name: "setConstraint",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.setConstraint command replacing one constraint's rotation limits.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
      componentId: ID_SCHEMA,
      limits: rotationLimitsSchema(),
    },
    required: ["nodeId", "componentId", "limits"],
  },
  outputSchema: mutationOutputSchema("setConstraint"),
};

export function setConstraint(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  const componentIdValue = componentId(requireString(record, "componentId"));
  const command = setConstraintCommand(resolveCommandId(ctx, record), {
    nodeId: nodeIdValue,
    componentId: componentIdValue,
    limits: requireRotationLimits(record, "limits"),
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

/** `removeConstraint` contract: construct a `node.removeConstraint` command. */
export const REMOVE_CONSTRAINT_CONTRACT: ToolContract = {
  name: "removeConstraint",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered node.removeConstraint command removing one constraint by component id.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      nodeId: ID_SCHEMA,
      componentId: ID_SCHEMA,
    },
    required: ["nodeId", "componentId"],
  },
  outputSchema: mutationOutputSchema("removeConstraint"),
};

export function removeConstraint(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIdValue = requireNodeId(record, "nodeId");
  requireNode(ctx.store.getDocument(), nodeIdValue);
  const componentIdValue = componentId(requireString(record, "componentId"));
  const command = removeConstraintCommand(resolveCommandId(ctx, record), {
    nodeId: nodeIdValue,
    componentId: componentIdValue,
  });
  return { command, voxelEstimate: estimateVoxelDelta(command, ctx.store) };
}

/** Validates a finite three-number pivot argument. */
function requirePivot(
  record: Readonly<Record<string, JsonValue>>,
): readonly [number, number, number] {
  const pivot = record.pivot;
  if (
    !Array.isArray(pivot) ||
    pivot.length !== 3 ||
    !pivot.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    invalidArgument("pivot must be a finite [x, y, z] array", ["pivot"]);
  }
  return [pivot[0] as number, pivot[1] as number, pivot[2] as number];
}
