import type { JsonValue, NodeId, VolumeId } from "@voxel-maker/shared";
import { boundedEmit } from "../budget.js";
import { outputSchema, type ToolContract } from "../contract.js";
import type { EditorSelectionSnapshot } from "../port.js";
import type { ToolContext } from "./context.js";

/**
 * Selection snapshot normalization (plan S11.3/S11.14): port entries are
 * validated against the open document and pruned when their node or
 * volume no longer exists, so stale editor state can never reach other
 * tools or produce missing references downstream. Emission is bounded by
 * `maxSelectionEntries` and by the response byte budget; any drop is
 * reported through `entriesTruncated` so capping is never silent.
 */

export type SelectionPruneReason = "missing-node" | "missing-volume";

export interface PrunedSelectionEntry {
  readonly reason: SelectionPruneReason;
  readonly nodeId?: string;
  readonly volumeId?: string;
}

export interface NormalizedSelection {
  readonly available: boolean;
  readonly entries: readonly EditorSelectionSnapshot[];
  readonly pruned: PrunedSelectionEntry[];
}

/** Prunes port selection entries whose node or volume is gone. */
export function normalizeSelection(ctx: ToolContext): NormalizedSelection {
  const document = ctx.store.getDocument();
  const port = ctx.port;
  if (port === undefined) return { available: false, entries: [], pruned: [] };
  const entries: EditorSelectionSnapshot[] = [];
  const pruned: PrunedSelectionEntry[] = [];
  for (const entry of port.getSelection()) {
    if (entry.kind === "node") {
      if (document.nodes[entry.nodeId as NodeId] === undefined) {
        pruned.push({ reason: "missing-node", nodeId: entry.nodeId });
      } else {
        entries.push(entry);
      }
      continue;
    }
    if (document.volumes[entry.volumeId as VolumeId] === undefined) {
      pruned.push({ reason: "missing-volume", volumeId: entry.volumeId });
      continue;
    }
    entries.push(entry);
  }
  return { available: true, entries, pruned };
}

/** JSON-safe selection entry for responses. */
export function selectionEntryJson(
  entry: EditorSelectionSnapshot,
): Readonly<Record<string, JsonValue>> {
  switch (entry.kind) {
    case "node":
      return { kind: "node", nodeId: entry.nodeId };
    case "voxel":
      return {
        kind: "voxel",
        volumeId: entry.volumeId,
        voxel: [...entry.voxel],
      };
    case "region":
      return {
        kind: "region",
        volumeId: entry.volumeId,
        region: { min: [...entry.region.min], max: [...entry.region.max] },
      };
  }
}

function prunedEntryJson(entry: PrunedSelectionEntry): JsonValue {
  return {
    reason: entry.reason,
    ...(entry.nodeId === undefined ? {} : { nodeId: entry.nodeId }),
    ...(entry.volumeId === undefined ? {} : { volumeId: entry.volumeId }),
  };
}

/**
 * Bounded selection block shared by `getSelection` and `inspectSummary`.
 * `include` is false only when the caller opted out of selection context;
 * `available` always reports whether an editor port exists.
 */
export function selectionSummary(
  ctx: ToolContext,
  include: boolean,
): Readonly<Record<string, JsonValue>> {
  const normalized = normalizeSelection(ctx);
  if (!include) {
    return {
      available: normalized.available,
      included: false,
      entries: [],
      entriesTruncated: false,
      pruned: [],
    };
  }
  const capped = normalized.entries.length > ctx.limits.maxSelectionEntries;
  const entries = boundedEmit(
    ctx.budget,
    normalized.entries.slice(0, ctx.limits.maxSelectionEntries),
    (entry) => selectionEntryJson(entry),
  );
  const pruned = boundedEmit(ctx.budget, normalized.pruned, (entry) =>
    prunedEntryJson(entry),
  );
  return {
    available: normalized.available,
    included: true,
    entries: entries.list,
    entriesTruncated: capped || entries.truncated,
    pruned: pruned.list,
  };
}

/** `getSelection` contract: injected selection context (plan S11.3). */
export const GET_SELECTION_CONTRACT: ToolContract = {
  name: "getSelection",
  version: 1,
  capability: "inspect",
  description:
    "Returns the editor's current selection snapshot through the injected EditorContextPort: node, voxel, or region entries. Entries referencing deleted nodes or volumes are pruned and reported; drops past the entry budget set entriesTruncated. Reports available: false when no editor context port is installed.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  outputSchema: outputSchema(
    "getSelection",
    {
      available: { type: "boolean" },
      included: { const: true },
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["node", "voxel", "region"] },
            nodeId: { type: "string" },
            volumeId: { type: "string" },
            voxel: {
              type: "array",
              items: { type: "integer" },
              minItems: 3,
              maxItems: 3,
            },
            region: {
              type: "object",
              additionalProperties: false,
              properties: {
                min: {
                  type: "array",
                  items: { type: "integer" },
                  minItems: 3,
                  maxItems: 3,
                },
                max: {
                  type: "array",
                  items: { type: "integer" },
                  minItems: 3,
                  maxItems: 3,
                },
              },
              required: ["min", "max"],
            },
          },
          required: ["kind"],
        },
      },
      entriesTruncated: { type: "boolean" },
      pruned: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            reason: {
              type: "string",
              enum: ["missing-node", "missing-volume"],
            },
            nodeId: { type: "string" },
            volumeId: { type: "string" },
          },
          required: ["reason"],
        },
      },
    },
    ["available", "included", "entries", "entriesTruncated", "pruned"],
  ),
};

/** `getSelection` handler. */
export function getSelection(
  ctx: ToolContext,
): Readonly<Record<string, JsonValue>> {
  return selectionSummary(ctx, true);
}
