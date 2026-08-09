import type { JsonValue, NodeId } from "@voxel-maker/shared";
import type { Vec3 } from "@voxel-maker/math";
import {
  invalidArgument,
  outputSchema,
  vec3Schema,
  type ToolContract,
} from "../contract.js";
import { nodeWorldPosition, requireNode } from "./helpers.js";
import type { ToolContext } from "./context.js";

/**
 * World-space distance measurement (plan S11.4): the euclidean distance
 * between two node origins and/or explicit world-space points. Pure and
 * deterministic; nodes resolve to their world origin.
 */

/** `measureDistance` contract. */
export const MEASURE_DISTANCE_CONTRACT: ToolContract = {
  name: "measureDistance",
  version: 1,
  capability: "inspect",
  description:
    "Euclidean world-space distance between two references; each side is exactly one of fromNodeId/fromPoint (toNodeId/toPoint). Node positions are their local origin mapped through the pivot-aware world transform.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      fromNodeId: { type: "string", maxLength: 256 },
      fromPoint: vec3Schema(),
      toNodeId: { type: "string", maxLength: 256 },
      toPoint: vec3Schema(),
    },
  },
  outputSchema: outputSchema(
    "measureDistance",
    {
      from: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodeId: { type: "string" },
          point: vec3Schema(),
        },
      },
      to: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodeId: { type: "string" },
          point: vec3Schema(),
        },
      },
      distance: { type: "number", minimum: 0 },
    },
    ["from", "to", "distance"],
  ),
};

type Endpoint = { readonly nodeId: NodeId } | { readonly point: Vec3 };

function resolveEndpoint(
  ctx: ToolContext,
  record: Readonly<Record<string, JsonValue>>,
  prefix: "from" | "to",
): Endpoint {
  const nodeKey = `${prefix}NodeId`;
  const pointKey = `${prefix}Point`;
  const nodeValue = record[nodeKey];
  const pointValue = record[pointKey];
  if (nodeValue === undefined && pointValue === undefined) {
    invalidArgument(`exactly one of ${nodeKey} or ${pointKey} is required`, [
      nodeKey,
    ]);
  }
  if (nodeValue !== undefined && pointValue !== undefined) {
    invalidArgument(`provide either ${nodeKey} or ${pointKey}, not both`, [
      nodeKey,
    ]);
  }
  if (nodeValue !== undefined) {
    requireNode(ctx.store.getDocument(), nodeValue as string as NodeId);
    return { nodeId: nodeValue as string as NodeId };
  }
  const point = pointValue as Vec3;
  for (let axis = 0; axis < 3; axis += 1) {
    if (!Number.isFinite(point[axis])) {
      invalidArgument(`${pointKey} must contain finite numbers`, [
        pointKey,
        axis,
      ]);
    }
  }
  return { point };
}

function endpointJson(endpoint: Endpoint): Readonly<Record<string, JsonValue>> {
  if ("nodeId" in endpoint) return { nodeId: endpoint.nodeId };
  return { point: [...endpoint.point] };
}

export function measureDistance(
  ctx: ToolContext,
  args: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const record = args as Readonly<Record<string, JsonValue>>;
  const from = resolveEndpoint(ctx, record, "from");
  const to = resolveEndpoint(ctx, record, "to");
  const fromPosition =
    "nodeId" in from ? nodeWorldPosition(ctx.store, from.nodeId) : from.point;
  const toPosition =
    "nodeId" in to ? nodeWorldPosition(ctx.store, to.nodeId) : to.point;
  const dx = toPosition[0] - fromPosition[0];
  const dy = toPosition[1] - fromPosition[1];
  const dz = toPosition[2] - fromPosition[2];
  return {
    from: endpointJson(from),
    to: endpointJson(to),
    distance: Math.sqrt(dx * dx + dy * dy + dz * dz),
  };
}
