import type { SkillEfficiencyLimits } from "./manifest.js";

/**
 * Command/tool efficiency checks (plan S14.10, ticket #38): every
 * creation skill fixes golden counts (the clean-run expectation recorded
 * against its fixed scenario prompt) and absolute maxima for tool calls,
 * rounds, and proposed commands. This module decides whether an actual
 * run stayed within the skill's limits; the evaluation harness records
 * the counts.
 */

/** Counters of one agent run over a skill scenario. */
export interface SkillRunStats {
  readonly toolCalls: number;
  readonly rounds: number;
  readonly commands: number;
}

/** Per-dimension efficiency result. */
export interface EfficiencyDimension {
  readonly name: "toolCalls" | "rounds" | "commands";
  readonly actual: number;
  readonly golden: number;
  readonly maximum: number;
  /** True when the run stayed within the golden expectation. */
  readonly withinGolden: boolean;
  /** True when the run stayed within the absolute maximum. */
  readonly withinLimit: boolean;
}

/** Complete efficiency report of one run. */
export interface EfficiencyReport {
  readonly dimensions: readonly EfficiencyDimension[];
  /** True when every dimension stayed within its absolute maximum. */
  readonly withinLimits: boolean;
  /** True when every dimension stayed within its golden expectation. */
  readonly withinGolden: boolean;
}

/** Checks one run against the skill's fixed efficiency limits. */
export function checkEfficiency(
  limits: SkillEfficiencyLimits,
  stats: SkillRunStats,
): EfficiencyReport {
  const dimensions: EfficiencyDimension[] = [
    {
      name: "toolCalls",
      actual: stats.toolCalls,
      golden: limits.goldenToolCalls,
      maximum: limits.maxToolCalls,
      withinGolden: stats.toolCalls <= limits.goldenToolCalls,
      withinLimit: stats.toolCalls <= limits.maxToolCalls,
    },
    {
      name: "rounds",
      actual: stats.rounds,
      golden: limits.goldenRounds,
      maximum: limits.maxRounds,
      withinGolden: stats.rounds <= limits.goldenRounds,
      withinLimit: stats.rounds <= limits.maxRounds,
    },
    {
      name: "commands",
      actual: stats.commands,
      golden: limits.goldenCommands,
      maximum: limits.maxCommands,
      withinGolden: stats.commands <= limits.goldenCommands,
      withinLimit: stats.commands <= limits.maxCommands,
    },
  ];
  return Object.freeze({
    dimensions: Object.freeze(dimensions),
    withinLimits: dimensions.every((dimension) => dimension.withinLimit),
    withinGolden: dimensions.every((dimension) => dimension.withinGolden),
  });
}
