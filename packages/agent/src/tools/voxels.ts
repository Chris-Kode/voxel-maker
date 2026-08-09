import type { JsonValue, VolumeId } from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import { boundedEmit } from "../budget.js";
import {
  invalidArgument,
  outputSchema,
  type ToolContract,
} from "../contract.js";
import {
  clampName,
  pageSlice,
  requireRegion,
  requireVolume,
  requireVolumeView,
  resolvePage,
  resolvePageSize,
} from "./helpers.js";
import type { ToolContext } from "./context.js";

/**
 * Spatial voxel inspection (plan S11.4): bounded, paginated occupied voxel
 * queries over a region, plus per-volume bounds. Iteration follows stable
 * chunk (X, then Y, then Z) and X-fastest in-chunk order so every query is
 * deterministic; scan work is capped by `maxVoxelsPerQuery` and
 * `maxChunksPerQuery` (ADR-0009).
 */

/** `queryVoxels` contract: bounded/paginated voxel dump (plan S11.4). */
export const QUERY_VOXELS_CONTRACT: ToolContract = {
  name: "queryVoxels",
  version: 1,
  capability: "inspect",
  description:
    "Paginated occupied voxels of one volume, optionally restricted to a half-open integer region. Entries carry volume-local coordinates and material ids; iteration order is deterministic (X, then Y, then Z). Large regions are scanned up to the configured budget and flagged with scanTruncated.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      volumeId: { type: "string" },
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
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
      maxVoxels: {
        type: "integer",
        minimum: 1,
        description:
          "Collection cap for one query (default and max are the configured budget)",
      },
    },
    required: ["volumeId"],
  },
  outputSchema: outputSchema(
    "queryVoxels",
    {
      volumeId: { type: "string" },
      region: {
        anyOf: [
          {
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
          { type: "null" },
        ],
      },
      total: { type: "integer", minimum: 0 },
      scanTruncated: { type: "boolean" },
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
      hasMore: { type: "boolean" },
      voxels: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            coordinate: {
              type: "array",
              items: { type: "integer" },
              minItems: 3,
              maxItems: 3,
            },
            material: { type: "integer", minimum: 0 },
          },
          required: ["coordinate", "material"],
        },
      },
    },
    [
      "volumeId",
      "region",
      "total",
      "scanTruncated",
      "page",
      "pageSize",
      "hasMore",
      "voxels",
    ],
  ),
};

const CHUNK_EDGE = 16;
const CHUNK_VOXEL_COUNT = CHUNK_EDGE * CHUNK_EDGE * CHUNK_EDGE;

const floorDiv = (value: number): number => Math.floor(value / CHUNK_EDGE);

/** Collects occupied voxel entries of `region`, deterministically bounded. */
function collectRegionVoxels(
  ctx: ToolContext,
  volumeId: VolumeId,
  region: IntAabb,
  maxVoxels: number,
): {
  readonly entries: readonly { coordinate: Vec3i; material: number }[];
  readonly scanTruncated: boolean;
} {
  const { store, limits } = ctx;
  const view = requireVolumeView(store, volumeId);
  const entries: { coordinate: Vec3i; material: number }[] = [];
  const minChunk: [number, number, number] = [
    floorDiv(region.min[0]),
    floorDiv(region.min[1]),
    floorDiv(region.min[2]),
  ];
  const maxChunk: [number, number, number] = [
    floorDiv(region.max[0] - 1),
    floorDiv(region.max[1] - 1),
    floorDiv(region.max[2] - 1),
  ];
  let chunksScanned = 0;
  let scanTruncated = false;
  outer: for (let cz = minChunk[2]; cz <= maxChunk[2]; cz += 1) {
    for (let cy = minChunk[1]; cy <= maxChunk[1]; cy += 1) {
      for (let cx = minChunk[0]; cx <= maxChunk[0]; cx += 1) {
        chunksScanned += 1;
        if (chunksScanned > limits.maxChunksPerQuery) {
          scanTruncated = true;
          break outer;
        }
        const values = view.getChunk([cx, cy, cz]);
        if (values === undefined) continue;
        for (let index = 0; index < CHUNK_VOXEL_COUNT; index += 1) {
          const material = values[index];
          if (material === undefined || material === 0) continue;
          const localX = index % CHUNK_EDGE;
          const localY = Math.floor(index / CHUNK_EDGE) % CHUNK_EDGE;
          const localZ = Math.floor(index / (CHUNK_EDGE * CHUNK_EDGE));
          const coordinate: Vec3i = [
            cx * CHUNK_EDGE + localX,
            cy * CHUNK_EDGE + localY,
            cz * CHUNK_EDGE + localZ,
          ];
          if (
            coordinate[0] < region.min[0] ||
            coordinate[0] >= region.max[0] ||
            coordinate[1] < region.min[1] ||
            coordinate[1] >= region.max[1] ||
            coordinate[2] < region.min[2] ||
            coordinate[2] >= region.max[2]
          ) {
            continue;
          }
          entries.push({ coordinate, material });
          if (entries.length >= maxVoxels) {
            scanTruncated = true;
            break outer;
          }
        }
      }
    }
  }
  return { entries, scanTruncated };
}

export function queryVoxels(
  ctx: ToolContext,
  args: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const { store, limits } = ctx;
  const document = store.getDocument();
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeId = record.volumeId as string as VolumeId;
  requireVolume(document, volumeId);
  const region =
    record.region === undefined
      ? store.getVolume(volumeId)?.occupiedBounds()
      : requireRegion(record.region, "region");
  if (region === undefined) {
    return {
      volumeId,
      region: null,
      total: 0,
      scanTruncated: false,
      page: resolvePage(record),
      pageSize: resolvePageSize(record, limits),
      hasMore: false,
      voxels: [],
    };
  }
  const maxVoxels = resolveMaxVoxels(record, limits);
  const pageSize = resolvePageSize(record, limits);
  const page = resolvePage(record);
  const { entries, scanTruncated } = collectRegionVoxels(
    ctx,
    volumeId,
    region,
    maxVoxels,
  );
  const slice = pageSlice(entries.length, page, pageSize);
  const emitted = boundedEmit(
    ctx.budget,
    entries.slice(slice.start, slice.end),
    (entry) => ({
      coordinate: [...entry.coordinate],
      material: entry.material,
    }),
  );
  return {
    volumeId,
    region: { min: [...region.min], max: [...region.max] },
    total: slice.total,
    scanTruncated,
    page: slice.page,
    pageSize: slice.pageSize,
    hasMore: slice.hasMore && !emitted.truncated,
    voxels: emitted.list,
  };
}

/** Resolves the per-query voxel cap against the configured budget. */
function resolveMaxVoxels(
  record: Readonly<Record<string, JsonValue>>,
  limits: { readonly maxVoxelsPerQuery: number },
): number {
  const maxVoxels = record.maxVoxels;
  if (maxVoxels === undefined) return limits.maxVoxelsPerQuery;
  if (
    typeof maxVoxels !== "number" ||
    !Number.isInteger(maxVoxels) ||
    maxVoxels < 1
  ) {
    invalidArgument("maxVoxels must be a positive integer", ["maxVoxels"]);
  }
  if (maxVoxels > limits.maxVoxelsPerQuery) {
    invalidArgument(
      `maxVoxels must be <= ${String(limits.maxVoxelsPerQuery)}`,
      ["maxVoxels"],
    );
  }
  return maxVoxels;
}

/** `inspectBounds` contract: per-volume occupied bounds (plan S11.3/S11.4). */
export const INSPECT_BOUNDS_CONTRACT: ToolContract = {
  name: "inspectBounds",
  version: 1,
  capability: "inspect",
  description:
    "Occupied bounds, chunk and voxel counts, and owning nodes of one volume or of every volume (default). Half-open bounds are [min, max).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      volumeId: {
        type: "string",
        description: "Restrict to one volume (default: all volumes)",
      },
    },
  },
  outputSchema: outputSchema(
    "inspectBounds",
    {
      volumes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            volumeId: { type: "string" },
            name: { type: "string" },
            declaredBounds: {
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
            occupiedBounds: {
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
            occupiedCount: { type: "integer", minimum: 0 },
            chunkCount: { type: "integer", minimum: 0 },
            ownerNodeIds: { type: "array", items: { type: "string" } },
          },
          required: ["volumeId", "occupiedCount", "chunkCount", "ownerNodeIds"],
        },
      },
    },
    ["volumes"],
  ),
};

export function inspectBounds(
  ctx: ToolContext,
  args: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const { store, limits, budget } = ctx;
  const document = store.getDocument();
  const record = args as Readonly<Record<string, JsonValue>>;
  const volumeIds =
    record.volumeId === undefined
      ? (Object.keys(document.volumes) as VolumeId[])
      : [record.volumeId as string as VolumeId];
  const entries = volumeIds.map((volumeId) => {
    const descriptor = requireVolume(document, volumeId);
    const view = store.getVolume(volumeId);
    const occupied = view?.occupiedBounds();
    const owners = Object.values(document.nodes)
      .filter((node) =>
        node.components.some(
          (component) =>
            component.kind === "voxel" && component.volumeId === volumeId,
        ),
      )
      .map((node) => node.nodeId);
    return {
      volumeId,
      ...(descriptor.name === undefined
        ? {}
        : { name: clampName(descriptor.name, limits) }),
      ...(descriptor.bounds === undefined
        ? {}
        : {
            declaredBounds: {
              min: [...descriptor.bounds.min],
              max: [...descriptor.bounds.max],
            },
          }),
      ...(occupied === undefined
        ? {}
        : {
            occupiedBounds: { min: [...occupied.min], max: [...occupied.max] },
          }),
      occupiedCount: view?.occupiedCount() ?? 0,
      chunkCount: view?.chunkCount() ?? 0,
      ownerNodeIds: owners,
    };
  });
  const emitted = boundedEmit(budget, entries, (entry) => entry);
  return { volumes: emitted.list };
}
