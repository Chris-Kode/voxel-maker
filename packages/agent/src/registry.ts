import {
  registerBatchCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVolumeCommands,
  registerVoxelCommands,
  CommandRegistry,
} from "@voxel-maker/commands";
import type { ToolCapability, ToolContract } from "./contract.js";
import { MUTATION_TOOL_DEFINITIONS } from "./mutation/definitions.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";

/**
 * Tool registry (plan S11.9): the versioned v1 inspection surface plus
 * capability-based authorization. Contracts are derived from the single
 * `TOOL_DEFINITIONS` list, so the registry cannot drift from dispatch;
 * sessions expose only the contracts whose capability is enabled, and
 * inspection is always distinct from mutation.
 */

/** Every v1 inspection tool contract in stable registry order. */
export const INSPECTION_TOOL_CONTRACTS: readonly ToolContract[] = Object.freeze(
  TOOL_DEFINITIONS.map((definition) => definition.contract),
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

/** Capability class of every v1 mutation tool (plan S11.5/S11.6). */
export const MUTATION_CAPABILITY: ToolCapability = "mutate";

/** Every v1 mutation tool contract in stable registry order. */
export const MUTATION_TOOL_CONTRACTS: readonly ToolContract[] = Object.freeze(
  MUTATION_TOOL_DEFINITIONS.map((definition) => definition.contract),
);

/**
 * Composes the preview command registry (plan S11.11): every registered
 * command family the v1 scene/material/coarse-geometry mutation surface
 * can construct. Rigging and animation commands are later-stage surfaces
 * (S11.7/S11.8) and are intentionally absent; staging any other command
 * type fails with the stable UNKNOWN_COMMAND_TYPE error.
 */
export function createPreviewRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  registerRegionCommands(registry);
  registerNodeCommands(registry);
  registerMaterialCommands(registry);
  registerVolumeCommands(registry);
  return registry;
}
