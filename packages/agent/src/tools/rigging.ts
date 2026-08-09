import type { JsonValue, NodeId } from "@voxel-maker/shared";
import { boundedEmit } from "../budget.js";
import { outputSchema, type ToolContract } from "../contract.js";
import {
  clampName,
  pageSlice,
  requireNode,
  resolvePage,
  resolvePageSize,
} from "./helpers.js";
import type { ToolContext } from "./context.js";

/**
 * Rig inspection (plan S11.3/S13.1): pivots, joints, and constraints of
 * the node hierarchy, paginated and budget-truncated. Output is read from
 * the persisted components only; no evaluator state is exposed.
 */

/** `inspectRigging` contract. */
export const INSPECT_RIGGING_CONTRACT: ToolContract = {
  name: "inspectRigging",
  version: 1,
  capability: "inspect",
  description:
    "Paginated rig annotation summary over nodes with pivot, joint, or constraint components: pivot offsets and rotation-limit constraints with their component ids.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      nodeId: {
        type: "string",
        description: "Restrict to one node (default: every rigged node)",
      },
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
    },
  },
  outputSchema: outputSchema(
    "inspectRigging",
    {
      total: { type: "integer", minimum: 0 },
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
      hasMore: { type: "boolean" },
      nodes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            nodeId: { type: "string" },
            name: { type: "string" },
            pivot: {
              type: "array",
              items: { type: "number" },
              minItems: 3,
              maxItems: 3,
            },
            hasJoint: { type: "boolean" },
            constraints: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  componentId: { type: "string" },
                  type: { type: "string" },
                  limits: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      min: {
                        type: "array",
                        items: { type: "number" },
                        minItems: 3,
                        maxItems: 3,
                      },
                      max: {
                        type: "array",
                        items: { type: "number" },
                        minItems: 3,
                        maxItems: 3,
                      },
                    },
                    required: ["min", "max"],
                  },
                },
                required: ["componentId", "type", "limits"],
              },
            },
          },
          required: ["nodeId", "hasJoint", "constraints"],
        },
      },
    },
    ["total", "page", "pageSize", "hasMore", "nodes"],
  ),
};

function rigEntry(ctx: ToolContext, nodeId: NodeId): JsonValue | undefined {
  const document = ctx.store.getDocument();
  const node = requireNode(document, nodeId);
  let pivot: readonly [number, number, number] | undefined;
  let hasJoint = false;
  const constraints: JsonValue[] = [];
  for (const component of node.components) {
    if (component.kind === "pivot") pivot = component.pivot;
    else if (component.kind === "joint") hasJoint = true;
    else if (component.kind === "constraint") {
      for (const constraint of component.constraints) {
        constraints.push({
          componentId: constraint.componentId,
          type: constraint.type,
          limits: {
            min: [...constraint.limits.min],
            max: [...constraint.limits.max],
          },
        });
      }
    }
  }
  if (pivot === undefined && !hasJoint && constraints.length === 0) {
    return undefined;
  }
  return {
    nodeId: node.nodeId,
    ...(node.name === undefined
      ? {}
      : { name: clampName(node.name, ctx.limits) }),
    ...(pivot === undefined ? {} : { pivot: [...pivot] }),
    hasJoint,
    constraints,
  };
}

export function inspectRigging(
  ctx: ToolContext,
  args: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const { store, limits, budget } = ctx;
  const document = store.getDocument();
  const record = args as Readonly<Record<string, JsonValue>>;
  const nodeIds =
    record.nodeId === undefined
      ? (Object.keys(document.nodes) as NodeId[])
      : [record.nodeId as string as NodeId];
  const entries: JsonValue[] = [];
  for (const nodeId of nodeIds) {
    const entry = rigEntry(ctx, nodeId);
    if (entry !== undefined) entries.push(entry);
  }
  const page = resolvePage(record);
  const pageSize = resolvePageSize(record, limits);
  const slice = pageSlice(entries.length, page, pageSize);
  const emitted = boundedEmit(
    budget,
    entries.slice(slice.start, slice.end),
    (entry) => entry,
  );
  return {
    total: slice.total,
    page: slice.page,
    pageSize: slice.pageSize,
    hasMore: slice.hasMore && !emitted.truncated,
    nodes: emitted.list,
  };
}
