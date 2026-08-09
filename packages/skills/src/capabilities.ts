import {
  MUTATION_TOOL_CONTRACTS,
  TOOL_DEFINITIONS,
  type ToolCapability,
} from "@voxel-maker/agent";
import type { SkillManifest } from "./manifest.js";

/**
 * Skill capability checks (plan S14.2, ticket #38): a skill's allowed
 * tools belong to capability classes (inspection vs mutation). The
 * registry validates tool names; this module validates that a skill is
 * usable under an authorized capability set — every allowed tool's
 * capability class must be authorized, so a skill can never silently
 * depend on tools the agent run cannot call.
 */

/** Tool name -> capability class (single source: the agent tool surface). */
export const TOOL_CAPABILITIES: ReadonlyMap<string, ToolCapability> = new Map([
  ...TOOL_DEFINITIONS.map(
    (definition) =>
      [definition.contract.name, definition.contract.capability] as const,
  ),
  ...MUTATION_TOOL_CONTRACTS.map(
    (contract) => [contract.name, contract.capability] as const,
  ),
]);

/** The capability classes a skill requires (its allowed tools). */
export function requiredCapabilities(
  skill: SkillManifest,
): ReadonlySet<ToolCapability> {
  const required = new Set<ToolCapability>();
  for (const tool of skill.allowedTools) {
    const capability = TOOL_CAPABILITIES.get(tool);
    if (capability !== undefined) required.add(capability);
  }
  return required;
}

/** True when every allowed tool of the skill is authorized. */
export function skillUsableWith(
  skill: SkillManifest,
  capabilities: readonly ToolCapability[],
): boolean {
  return unauthorizedTools(skill, capabilities).length === 0;
}

/** The allowed tools not authorized under the given capability set. */
export function unauthorizedTools(
  skill: SkillManifest,
  capabilities: readonly ToolCapability[],
): readonly string[] {
  const authorized = new Set(capabilities);
  return skill.allowedTools.filter((tool) => {
    const capability = TOOL_CAPABILITIES.get(tool);
    return capability === undefined || !authorized.has(capability);
  });
}
