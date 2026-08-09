import type { JsonValue, NodeId, VolumeId } from "@voxel-maker/shared";
import type { ToolContract } from "../contract.js";
import type { EditorSelectionSnapshot } from "../port.js";
import type { ToolContext } from "./context.js";

/**
 * Selection snapshot normalization (plan S11.3/S11.14): port entries are
 * validated against the open document and pruned when their node or
 * volume no longer exists, so stale editor state can never reach other
 * tools or produce missing references downstream.
 */

export type SelectionPruneReason = "missing-node" | "missing-volume";

export interface NormalizedSelection {
  readonly available: boolean;
  readonly entries: readonly EditorSelectionSnapshot[];
  readonly pruned: {
    readonly reason: SelectionPruneReason;
    readonly nodeId?: string;
    readonly volumeId?: string;
  }[];
}

/** Prunes port selection entries whose node or volume is gone. */
export function normalizeSelection(
  ctx: ToolContext,
): NormalizedSelection {
  const document = ctx.store.getDocument();
  const port = ctx.port;
  if (port === undefined) return { available: false, entries: [], pruned: [] };
  const entries: EditorSelectionSnapshot[] = [];
  const pruned: NormalizedSelection["pruned"] = [];
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
export function selectionEntryJson(entry: EditorSelectionSnapshot): Readonly<Record<string, JsonValue>> {
  switch (entry.kind) {
    case "node":
      return { kind: "node", nodeId: entry.nodeId };
    case "voxel":
      return { kind: "voxel", volumeId: entry.volumeId, voxel: [...entry.voxel] };
    case "region":
      return {
        kind: "region",
        volumeId: entry.volumeId,
        region: { min: [...entry.region.min], max: [...entry.region.max] },
      };
  }
}

/** Bounded selection block shared by `getSelection` and `inspectSummary`. */
export function selectionSummary(
  ctx: ToolContext,
  include: boolean,
): Readonly<Record<string, JsonValue>> {
  if (!include) return { available: false, entries: [], pruned: 0 };
  const normalized = normalizeSelection(ctx);
  const limited = normalized.entries.slice(
    0,
    ctx.limits.maxSelectionEntries,
  );
  return {
    available: normalized.available,
    entries: limited.map(selectionEntryJson),
    pruned: normalized.pruned.length,
  };
}

/** `getSelection` contract: injected selection context (plan S11.3). */
export const GET_SELECTION_CONTRACT: ToolContract = {
  name: "getSelection",
  version: 1,
  capability: "inspect",
  description:
    "Returns the editor's current selection snapshot through the injected EditorContextPort: node, voxel, or region entries. Entries referencing deleted nodes or volumes are pruned and counted. Reports available: false when no editor context port is installed.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      available: { type: "boolean" },
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["node", "voxel", "region"] },
            nodeId: { type: "string" },
            volumeId: { type: "string" },
            voxel: { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 3 },
            region: {
              type: "object",
              additionalProperties: false,
              properties: {
                min: { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 3 },
                max: { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 3 },
              },
              required: ["min", "max"],
            },
          },
          required: ["kind"],
        },
      },
      pruned: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            reason: { type: "string", enum: ["missing-node", "missing-volume"] },
            nodeId: { type: "string" },
            volumeId: { type: "string" },
          },
          required: ["reason"],
        },
      },
    },
    required: ["available", "entries", "pruned"],
  },
};

/** `getSelection` handler. */
export function getSelection(ctx: ToolContext, args: JsonValue): Readonly<Record<string, JsonValue>> {
  void args;
  const normalized = normalizeSelection(ctx);
  return {
    available: normalized.available,
    entries: normalized.entries
      .slice(0, ctx.limits.maxSelectionEntries)
      .map(selectionEntryJson),
    pruned: normalized.pruned.map((entry) => ({
      reason: entry.reason,
      ...(entry.nodeId === undefined ? {} : { nodeId: entry.nodeId }),
      ...(entry.volumeId === undefined ? {} : { volumeId: entry.volumeId }),
    })),
  };
}
