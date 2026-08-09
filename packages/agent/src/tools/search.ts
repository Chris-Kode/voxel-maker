import type { JsonValue } from "@voxel-maker/shared";
import { boundedEmit } from "../budget.js";
import {
  invalidArgument,
  outputSchema,
  type ToolContract,
} from "../contract.js";
import {
  clampName,
  pageSlice,
  resolvePage,
  resolvePageSize,
} from "./helpers.js";
import type { ToolContext } from "./context.js";

/**
 * Node search (plan S11.4 "tag search"): bounded name/tag lookup over the
 * hierarchy. Matching is deterministic (document record order) and purely
 * string-based; no paths, URLs, or free-form expressions are accepted.
 */

/** `searchNodes` contract. */
export const SEARCH_NODES_CONTRACT: ToolContract = {
  name: "searchNodes",
  version: 1,
  capability: "inspect",
  description:
    "Searches nodes by case-insensitive name substring (query) and/or metadata tag. A tag matches when the node metadata 'tags' array contains it or any metadata string value equals it. At least one of query/tag is required.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description: "Case-insensitive name substring",
      },
      tag: { type: "string", minLength: 1, description: "Exact metadata tag" },
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
    },
  },
  outputSchema: outputSchema(
    "searchNodes",
    {
      total: { type: "integer", minimum: 0 },
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
      hasMore: { type: "boolean" },
      matches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            nodeId: { type: "string" },
            name: { type: "string" },
          },
          required: ["nodeId"],
        },
      },
    },
    ["total", "page", "pageSize", "hasMore", "matches"],
  ),
};

function metadataContainsTag(
  metadata: Readonly<Record<string, unknown>> | undefined,
  tag: string,
): boolean {
  if (metadata === undefined) return false;
  for (const key of Object.keys(metadata)) {
    const value = metadata[key];
    if (key === "tags" && Array.isArray(value)) {
      if (value.some((item) => typeof item === "string" && item === tag)) {
        return true;
      }
    } else if (typeof value === "string" && value === tag) {
      return true;
    }
  }
  return false;
}

export function searchNodes(
  ctx: ToolContext,
  args: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const { store, limits, budget } = ctx;
  const document = store.getDocument();
  const record = args as Readonly<Record<string, JsonValue>>;
  const query = record.query;
  const tag = record.tag;
  if (query === undefined && tag === undefined) {
    invalidArgument("at least one of query or tag is required");
  }
  const queryText =
    query === undefined ? undefined : (query as string).toLowerCase();
  const tagText = tag === undefined ? undefined : (tag as string);
  const matches: JsonValue[] = [];
  for (const node of Object.values(document.nodes)) {
    const nameMatches =
      queryText !== undefined &&
      node.name !== undefined &&
      node.name.toLowerCase().includes(queryText);
    const tagMatches =
      tagText !== undefined &&
      metadataContainsTag(
        node.metadata as Readonly<Record<string, unknown>>,
        tagText,
      );
    if (nameMatches || tagMatches) {
      matches.push({
        nodeId: node.nodeId,
        ...(node.name === undefined
          ? {}
          : { name: clampName(node.name, limits) }),
      });
    }
  }
  const page = resolvePage(record);
  const pageSize = resolvePageSize(record, limits);
  const slice = pageSlice(matches.length, page, pageSize);
  const emitted = boundedEmit(
    budget,
    matches.slice(slice.start, slice.end),
    (entry) => entry,
  );
  return {
    total: slice.total,
    page: slice.page,
    pageSize: slice.pageSize,
    hasMore: slice.hasMore && !emitted.truncated,
    matches: emitted.list,
  };
}
