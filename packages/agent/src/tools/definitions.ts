import type { JsonValue } from "@voxel-maker/shared";
import type { ToolContract } from "../contract.js";
import type { ToolContext } from "./context.js";
import { getSelection } from "./selection.js";
import { inspectSummary } from "./summary.js";
import { inspectHierarchy, inspectNode } from "./hierarchy.js";
import { inspectMaterials } from "./materials.js";
import { inspectBounds, queryVoxels } from "./voxels.js";
import { raycast } from "./raycast.js";
import { inspectRigging } from "./rigging.js";
import { inspectClips, inspectKeyframes, inspectTracks } from "./animation.js";
import { searchNodes } from "./search.js";
import { measureDistance } from "./distance.js";
import { GET_SELECTION_CONTRACT } from "./selection.js";
import { INSPECT_SUMMARY_CONTRACT } from "./summary.js";
import {
  INSPECT_HIERARCHY_CONTRACT,
  INSPECT_NODE_CONTRACT,
} from "./hierarchy.js";
import { INSPECT_MATERIALS_CONTRACT } from "./materials.js";
import { INSPECT_BOUNDS_CONTRACT, QUERY_VOXELS_CONTRACT } from "./voxels.js";
import { RAYCAST_CONTRACT } from "./raycast.js";
import { INSPECT_RIGGING_CONTRACT } from "./rigging.js";
import {
  INSPECT_CLIPS_CONTRACT,
  INSPECT_KEYFRAMES_CONTRACT,
  INSPECT_TRACKS_CONTRACT,
} from "./animation.js";
import { SEARCH_NODES_CONTRACT } from "./search.js";
import { MEASURE_DISTANCE_CONTRACT } from "./distance.js";

/**
 * One registered tool: its versioned contract plus the pure handler that
 * runs it over the read context. This list is the single source for the
 * registry (contracts), the inspector (dispatch), and the public exports,
 * so adding a tool touches exactly one file.
 */

/** Handler signature shared by every inspection tool. */
export type ToolHandler = (
  ctx: ToolContext,
  args: JsonValue,
) => Readonly<Record<string, JsonValue>>;

export interface ToolDefinition {
  readonly contract: ToolContract;
  readonly handler: ToolHandler;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  { contract: INSPECT_SUMMARY_CONTRACT, handler: inspectSummary },
  { contract: GET_SELECTION_CONTRACT, handler: getSelection },
  { contract: INSPECT_HIERARCHY_CONTRACT, handler: inspectHierarchy },
  { contract: INSPECT_NODE_CONTRACT, handler: inspectNode },
  { contract: INSPECT_MATERIALS_CONTRACT, handler: inspectMaterials },
  { contract: INSPECT_BOUNDS_CONTRACT, handler: inspectBounds },
  { contract: QUERY_VOXELS_CONTRACT, handler: queryVoxels },
  { contract: RAYCAST_CONTRACT, handler: raycast },
  { contract: INSPECT_RIGGING_CONTRACT, handler: inspectRigging },
  { contract: INSPECT_CLIPS_CONTRACT, handler: inspectClips },
  { contract: INSPECT_TRACKS_CONTRACT, handler: inspectTracks },
  { contract: INSPECT_KEYFRAMES_CONTRACT, handler: inspectKeyframes },
  { contract: SEARCH_NODES_CONTRACT, handler: searchNodes },
  { contract: MEASURE_DISTANCE_CONTRACT, handler: measureDistance },
]);
