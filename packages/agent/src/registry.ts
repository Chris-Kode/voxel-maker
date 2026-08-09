import type { ToolCapability, ToolContract } from "./contract.js";
import { GET_SELECTION_CONTRACT } from "./tools/selection.js";
import { INSPECT_SUMMARY_CONTRACT } from "./tools/summary.js";
import {
  INSPECT_HIERARCHY_CONTRACT,
  INSPECT_NODE_CONTRACT,
} from "./tools/hierarchy.js";
import { INSPECT_MATERIALS_CONTRACT } from "./tools/materials.js";
import {
  QUERY_VOXELS_CONTRACT,
  INSPECT_BOUNDS_CONTRACT,
} from "./tools/voxels.js";
import { RAYCAST_CONTRACT } from "./tools/raycast.js";
import { INSPECT_RIGGING_CONTRACT } from "./tools/rigging.js";
import {
  INSPECT_CLIPS_CONTRACT,
  INSPECT_TRACKS_CONTRACT,
  INSPECT_KEYFRAMES_CONTRACT,
} from "./tools/animation.js";
import { SEARCH_NODES_CONTRACT } from "./tools/search.js";
import { MEASURE_DISTANCE_CONTRACT } from "./tools/distance.js";

/**
 * Tool registry (plan S11.9): the versioned v1 inspection surface plus
 * capability-based authorization. The registry is the single source of
 * tool contracts; sessions expose only the contracts whose capability is
 * enabled, and inspection is always distinct from mutation.
 */

/** Every v1 inspection tool contract in stable registry order. */
export const INSPECTION_TOOL_CONTRACTS: readonly ToolContract[] = Object.freeze(
  [
    INSPECT_SUMMARY_CONTRACT,
    GET_SELECTION_CONTRACT,
    INSPECT_HIERARCHY_CONTRACT,
    INSPECT_NODE_CONTRACT,
    INSPECT_MATERIALS_CONTRACT,
    INSPECT_BOUNDS_CONTRACT,
    QUERY_VOXELS_CONTRACT,
    RAYCAST_CONTRACT,
    INSPECT_RIGGING_CONTRACT,
    INSPECT_CLIPS_CONTRACT,
    INSPECT_TRACKS_CONTRACT,
    INSPECT_KEYFRAMES_CONTRACT,
    SEARCH_NODES_CONTRACT,
    MEASURE_DISTANCE_CONTRACT,
  ],
);

/** Capability class of every v1 inspection tool. */
export const INSPECTION_CAPABILITY: ToolCapability = "inspect";

/**
 * Filters contracts to the enabled capabilities. Authorization is a pure
 * set operation: a tool is exposed when its capability is enabled, so a
 * session that enables only "mutate" (or nothing) exposes zero inspection
 * surface and vice versa.
 */
export function authorizeTools(
  contracts: readonly ToolContract[],
  capabilities: readonly ToolCapability[],
): readonly ToolContract[] {
  const enabled = new Set(capabilities);
  return contracts.filter((contract) => enabled.has(contract.capability));
}

/** Looks up one contract by name. */
export function contractByName(
  contracts: readonly ToolContract[],
  name: string,
): ToolContract | undefined {
  return contracts.find((contract) => contract.name === name);
}

/** Stable error codes for registry failures. */
export const UNKNOWN_TOOL_CODE = "UNKNOWN_TOOL";
export const TOOL_NOT_AUTHORIZED_CODE = "TOOL_NOT_AUTHORIZED";
