import {
  AGENT_SYSTEM_PROMPT,
  DEFAULT_AGENT_BUDGETS,
  INSPECTION_CONTRACT_VERSION,
  MUTATION_CONTRACT_VERSION,
  type AgentBudgets,
} from "@voxel-maker/agent";
import { sha256Hex } from "@voxel-maker/model";

/**
 * Version recording of the fixed evaluation suite (plan S12.2, ticket
 * #35 AC): every result carries the versions of the evaluation
 * framework, the provider adapter and model, the system and scenario
 * prompts, the tool-schema contracts, the fixtures (plus the input
 * document's canonical semantic hash), and the budget profile. A changed
 * version anywhere invalidates silent baseline comparisons and triggers
 * the changed-baseline review process (plan 12.3).
 */

/** Version of the fixed geometry evaluation suite itself. */
export const EVALUATION_VERSION = "geometry-eval-v1";

/** Version of the deterministic provider adapter used by the suite. */
export const PROVIDER_VERSION = "deterministic-provider-v1";

/** Stable short hash of a prompt string (system or scenario). */
export function promptVersion(prompt: string): string {
  return sha256Hex(new TextEncoder().encode(prompt)).slice(0, 16);
}

/** Version of the agent system prompt (changes with AGENT_SYSTEM_PROMPT). */
export const SYSTEM_PROMPT_VERSION = promptVersion(AGENT_SYSTEM_PROMPT);

/** Version of the fixed budget profile the suite runs under. */
export const BUDGET_VERSION = "agent-budgets-default-v1";

/** Stable hash of one budget profile (snapshot identity). */
export function budgetHash(budgets: AgentBudgets): string {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(budgets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
  return sha256Hex(new TextEncoder().encode(canonical)).slice(0, 16);
}

/** The budget profile the fixed suite runs under (defaults, immutable). */
export const EVALUATION_BUDGETS: AgentBudgets = DEFAULT_AGENT_BUDGETS;

/** Tool-schema versions recorded with every result. */
export interface ToolSchemaVersions {
  readonly inspection: number;
  readonly mutation: number;
}

/** Tool-schema versions recorded with every result. */
export const TOOL_SCHEMA_VERSIONS: ToolSchemaVersions = Object.freeze({
  inspection: INSPECTION_CONTRACT_VERSION,
  mutation: MUTATION_CONTRACT_VERSION,
});

/** All versioned inputs of one evaluation run. */
export interface EvaluationVersions {
  /** Version of the evaluation framework/scoring itself. */
  readonly evaluation: string;
  readonly provider: {
    readonly id: string;
    readonly version: string;
    readonly model: string;
  };
  readonly prompt: {
    readonly systemVersion: string;
    readonly scenarioVersion: string;
  };
  readonly toolSchema: ToolSchemaVersions;
  readonly fixture: {
    readonly version: string;
    /** Canonical semantic hash of the starting document (input identity). */
    readonly inputDocumentHash: string;
  };
  readonly budget: {
    readonly version: string;
    readonly hash: string;
  };
}

/** Builds the version record for one scenario run. */
export function evaluationVersions(options: {
  readonly scenarioPrompt: string;
  readonly fixtureVersion: string;
  readonly inputDocumentHash: string;
  readonly providerId: string;
  readonly model: string;
}): EvaluationVersions {
  return {
    evaluation: EVALUATION_VERSION,
    provider: {
      id: options.providerId,
      version: PROVIDER_VERSION,
      model: options.model,
    },
    prompt: {
      systemVersion: SYSTEM_PROMPT_VERSION,
      scenarioVersion: promptVersion(options.scenarioPrompt),
    },
    toolSchema: TOOL_SCHEMA_VERSIONS,
    fixture: {
      version: options.fixtureVersion,
      inputDocumentHash: options.inputDocumentHash,
    },
    budget: {
      version: BUDGET_VERSION,
      hash: budgetHash(EVALUATION_BUDGETS),
    },
  };
}
