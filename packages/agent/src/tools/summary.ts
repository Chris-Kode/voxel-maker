import type { JsonValue } from "@voxel-maker/shared";
import { boundedEmit } from "../budget.js";
import type { ToolContract } from "../contract.js";
import { clampName } from "./helpers.js";
import type { ToolContext } from "./context.js";
import { selectionSummary } from "./selection.js";

/** `inspectSummary` contract: bounded document summary (plan S11.2). */
export const INSPECT_SUMMARY_CONTRACT: ToolContract = {
  name: "inspectSummary",
  version: 1,
  capability: "inspect",
  description:
    "Bounded summary of the open document: identity, revision, element counts, per-volume occupancy, and the injected selection context. Use first to orient before deeper queries.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      includeSelection: {
        type: "boolean",
        description: "Include the injected editor selection when available (default true)",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      document: {
        type: "object",
        additionalProperties: false,
        properties: {
          documentId: { type: "string" },
          schemaVersion: { const: 1 },
          revision: { type: "integer", minimum: 0 },
          rootNodeId: { type: "string" },
        },
        required: ["documentId", "schemaVersion", "revision", "rootNodeId"],
      },
      counts: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodes: { type: "integer", minimum: 0 },
          materials: { type: "integer", minimum: 0 },
          volumes: { type: "integer", minimum: 0 },
          animations: { type: "integer", minimum: 0 },
          tracks: { type: "integer", minimum: 0 },
          keyframes: { type: "integer", minimum: 0 },
          occupiedVoxels: { type: "integer", minimum: 0 },
          chunks: { type: "integer", minimum: 0 },
        },
        required: [
          "nodes",
          "materials",
          "volumes",
          "animations",
          "tracks",
          "keyframes",
          "occupiedVoxels",
          "chunks",
        ],
      },
      volumes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            volumeId: { type: "string" },
            name: { type: "string" },
            occupiedBounds: { type: "object", additionalProperties: false, properties: { min: { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 3 }, max: { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 3 } }, required: ["min", "max"] },
            occupiedCount: { type: "integer", minimum: 0 },
            chunkCount: { type: "integer", minimum: 0 },
          },
          required: ["volumeId", "occupiedCount", "chunkCount"],
        },
      },
      selection: {
        type: "object",
        additionalProperties: false,
        properties: {
          available: { type: "boolean" },
          entries: { type: "array", items: { type: "object" } },
          pruned: { type: "integer", minimum: 0 },
        },
        required: ["available", "entries", "pruned"],
      },
    },
    required: ["document", "counts", "volumes", "selection"],
  },
};

function buildSummary(ctx: ToolContext, args: JsonValue): Readonly<Record<string, JsonValue>> {
  const { store, limits, budget } = ctx;
  const document = store.getDocument();
  const includeSelection =
    (args as Readonly<Record<string, JsonValue>>).includeSelection !== false;

  let occupiedVoxels = 0;
  let chunks = 0;
  const volumeEntries = Object.values(document.volumes).map((volume) => {
    const view = store.getVolume(volume.volumeId);
    const occupied = view?.occupiedCount() ?? 0;
    const chunkCount = view?.chunkCount() ?? 0;
    occupiedVoxels += occupied;
    chunks += chunkCount;
    const bounds = view?.occupiedBounds();
    return {
      volumeId: volume.volumeId,
      ...(volume.name === undefined
        ? {}
        : { name: clampName(volume.name, limits) }),
      ...(bounds === undefined
        ? {}
        : { occupiedBounds: { min: bounds.min, max: bounds.max } }),
      occupiedCount: occupied,
      chunkCount,
    };
  });

  let tracks = 0;
  let keyframes = 0;
  for (const animation of Object.values(document.animations)) {
    tracks += animation.tracks.length;
    for (const track of animation.tracks) keyframes += track.keyframes.length;
  }

  const volumes = boundedEmit(budget, volumeEntries, (entry) => entry);
  const selection = selectionSummary(ctx, includeSelection);

  return {
    document: {
      documentId: document.documentId,
      schemaVersion: document.documentSchemaVersion,
      revision: store.revision,
      rootNodeId: document.rootNodeId,
    },
    counts: {
      nodes: Object.keys(document.nodes).length,
      materials: Object.keys(document.materials).length,
      volumes: Object.keys(document.volumes).length,
      animations: Object.keys(document.animations).length,
      tracks,
      keyframes,
      occupiedVoxels,
      chunks,
    },
    volumes: volumes.list,
    selection,
  };
}

export function inspectSummary(ctx: ToolContext, args: JsonValue): Readonly<Record<string, JsonValue>> {
  return buildSummary(ctx, args);
}
