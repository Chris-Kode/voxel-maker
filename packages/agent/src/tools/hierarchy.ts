import { worldTransformMatrix } from "@voxel-maker/document";
import { decomposeMatrix, type Mat4 } from "@voxel-maker/math";
import type { Component } from "@voxel-maker/model";
import type { JsonValue, NodeId } from "@voxel-maker/shared";
import { boundedEmit } from "../budget.js";
import {
  inspectionLimit,
  outputSchema,
  transformSchema,
  worldTransformSchema,
  type ToolContract,
} from "../contract.js";
import { clampName, requireNode } from "./helpers.js";
import type { ToolContext } from "./context.js";

/**
 * Hierarchy inspection (plan S11.3): a depth-bounded, budget-truncated
 * tree from any root plus one-node detail with local and decomposed world
 * transforms (ADR-0001 conventions).
 */

const transformJson = (transform: {
  readonly translation: readonly [number, number, number];
  readonly pivot: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}): JsonValue => ({
  translation: [...transform.translation],
  pivot: [...transform.pivot],
  rotation: [...transform.rotation],
  scale: [...transform.scale],
});

const worldTransformJson = (
  matrix: Mat4,
  pivot: readonly [number, number, number],
): JsonValue => {
  const decomposed = decomposeMatrix(matrix, pivot);
  return {
    translation: [...decomposed.translation],
    rotation: [...decomposed.rotation],
    scale: [...decomposed.scale],
  };
};

/** `inspectHierarchy` contract: depth-bounded, budget-truncated tree. */
export const INSPECT_HIERARCHY_CONTRACT: ToolContract = {
  name: "inspectHierarchy",
  version: 1,
  capability: "inspect",
  description:
    "Returns the node hierarchy as a tree from the document root (or a given node), depth-bounded and truncated to the response budget. Each entry lists node id, name, child count, and children.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      rootNodeId: {
        type: "string",
        description: "Root of the subtree (default: document root)",
      },
      maxDepth: {
        type: "integer",
        minimum: 0,
        description: "Maximum tree depth below the root (default 8, max 32)",
      },
    },
  },
  outputSchema: outputSchema(
    "inspectHierarchy",
    {
      rootNodeId: { type: "string" },
      maxDepth: { type: "integer", minimum: 0 },
      nodeCount: { type: "integer", minimum: 0 },
      root: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              nodeId: { type: "string" },
              name: { type: "string" },
              childCount: { type: "integer", minimum: 0 },
              children: { type: "array", items: { type: "object" } },
            },
            required: ["nodeId", "childCount", "children"],
          },
          { type: "null" },
        ],
      },
    },
    ["rootNodeId", "maxDepth", "nodeCount", "root"],
  ),
};

/** Builds one tree node, stopping when the budget or depth runs out. */
function buildTreeNode(
  ctx: ToolContext,
  node: ReturnType<typeof requireNode>,
  depth: number,
  maxDepth: number,
  stats: { nodeCount: number },
): JsonValue | undefined {
  const entry: {
    nodeId: NodeId;
    name?: string;
    childCount: number;
    children: JsonValue[];
  } = {
    nodeId: node.nodeId,
    ...(node.name === undefined
      ? {}
      : { name: clampName(node.name, ctx.limits) }),
    childCount: node.children.length,
    children: [],
  };
  if (!ctx.budget.tryReserve(entry)) return undefined;
  stats.nodeCount += 1;
  if (depth >= maxDepth) return entry;
  for (const childId of node.children) {
    const child = ctx.store.getDocument().nodes[childId];
    if (child === undefined) continue;
    const childEntry = buildTreeNode(ctx, child, depth + 1, maxDepth, stats);
    if (childEntry === undefined) break;
    entry.children.push(childEntry);
  }
  return entry;
}

export function inspectHierarchy(
  ctx: ToolContext,
  args: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const { store, limits } = ctx;
  const document = store.getDocument();
  const record = args as Readonly<Record<string, JsonValue>>;
  const rootId =
    record.rootNodeId === undefined
      ? document.rootNodeId
      : (record.rootNodeId as string as NodeId);
  const requestedDepth =
    record.maxDepth === undefined
      ? limits.defaultHierarchyDepth
      : (record.maxDepth as number);
  if (requestedDepth > limits.maxHierarchyDepth) {
    inspectionLimit("maxDepth", requestedDepth, limits.maxHierarchyDepth, [
      "maxDepth",
    ]);
  }
  const root = requireNode(document, rootId);
  const stats = { nodeCount: 0 };
  const tree = buildTreeNode(ctx, root, 0, requestedDepth, stats);
  if (tree === undefined) {
    return {
      rootNodeId: rootId,
      maxDepth: requestedDepth,
      nodeCount: 0,
      root: null,
    };
  }
  return {
    rootNodeId: rootId,
    maxDepth: requestedDepth,
    nodeCount: stats.nodeCount,
    root: tree,
  };
}

/** `inspectNode` contract: one node with local/world transforms. */
export const INSPECT_NODE_CONTRACT: ToolContract = {
  name: "inspectNode",
  version: 1,
  capability: "inspect",
  description:
    "Returns one node's identity, children, canonical local transform, decomposed world transform (optional), component summary, and metadata keys. Missing nodes fail with UNKNOWN_NODE.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      nodeId: { type: "string" },
      includeWorldTransform: {
        type: "boolean",
        description:
          "Also decompose and return the world transform (default true)",
      },
    },
    required: ["nodeId"],
  },
  outputSchema: outputSchema(
    "inspectNode",
    {
      nodeId: { type: "string" },
      name: { type: "string" },
      parentId: { anyOf: [{ type: "string" }, { type: "null" }] },
      children: { type: "array", items: { type: "string" } },
      transform: transformSchema(),
      worldTransform: worldTransformSchema(),
      components: { type: "array", items: { type: "object" } },
      metadata: {
        type: "object",
        additionalProperties: false,
        properties: { keys: { type: "array", items: { type: "string" } } },
        required: ["keys"],
      },
    },
    ["nodeId", "children", "transform", "components", "metadata"],
  ),
};

function componentJson(
  component: Component,
): Readonly<Record<string, JsonValue>> {
  switch (component.kind) {
    case "voxel":
      return { kind: "voxel", volumeId: component.volumeId };
    case "pivot":
      return { kind: "pivot", pivot: [...component.pivot] };
    case "joint":
      return { kind: "joint" };
    case "constraint":
      return {
        kind: "constraint",
        constraints: component.constraints.map((constraint) => ({
          componentId: constraint.componentId,
          type: constraint.type,
          limits: {
            min: [...constraint.limits.min],
            max: [...constraint.limits.max],
          },
        })),
      };
  }
}

export function inspectNode(
  ctx: ToolContext,
  args: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const { store, limits } = ctx;
  const document = store.getDocument();
  const record = args as Readonly<Record<string, JsonValue>>;
  const node = requireNode(document, record.nodeId as string as NodeId);
  const includeWorld = record.includeWorldTransform !== false;
  const children = boundedEmit(ctx.budget, node.children, (childId) => childId);
  const payload: {
    nodeId: NodeId;
    name?: string;
    parentId: string | null;
    children: readonly JsonValue[];
    transform: JsonValue;
    worldTransform?: JsonValue;
    components: JsonValue[];
    metadata: JsonValue;
  } = {
    nodeId: node.nodeId,
    ...(node.name === undefined ? {} : { name: clampName(node.name, limits) }),
    parentId: node.parentId,
    children: children.list,
    transform: transformJson(node.transform),
    components: node.components.map(componentJson),
    metadata: {
      keys: Object.keys(node.metadata ?? {}).slice(0, limits.maxMetadataKeys),
    },
  };
  if (includeWorld) {
    const world = worldTransformMatrix(document, node.nodeId);
    payload.worldTransform = worldTransformJson(world, node.transform.pivot);
  }
  return payload;
}
