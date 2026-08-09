import { WorkspaceError, type JsonValue } from "@voxel-maker/shared";
import { validateStructuralCheck } from "./checks.js";

/**
 * Versioned creation-skill manifest (plan S14.1, ticket #38): the
 * removable, versioned domain-knowledge envelope above the generic
 * engine. One manifest names the skill, its fixed instructions, the
 * allowed agent tools, the compatible generators, hard constraints,
 * provenance, and the fixed evaluation metadata (scenario prompt,
 * structural checks, visual baselines, command/tool efficiency limits).
 * A manifest is plain JSON-safe data: it is validated and deep-frozen at
 * registration time, never mutated afterwards, and never required by any
 * saved document (plan S14.9).
 */

/** Schema version of the v1 skill manifest contract. */
export const SKILL_MANIFEST_VERSION = 1;

/** Asset categories the v1 creation skills cover (plan S14.6). */
export const SKILL_CATEGORIES = [
  "furniture",
  "architecture",
  "vegetation",
  "vehicle",
  "humanoid",
  "quadruped",
  "flying-creature",
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** Provenance of one skill (plan S14.9): where the knowledge came from. */
export interface SkillProvenance {
  /** Author of the skill definition. */
  readonly author: string;
  /** Repository/package the skill ships from. */
  readonly source: string;
  /** SPDX license id of the skill definition. */
  readonly license: string;
  /** ISO date (YYYY-MM-DD) the skill version was created. */
  readonly created: string;
}

/**
 * Hard constraints of one skill. Every value is bounded by the shared
 * engine budgets (agent session budgets and generator proposal limits),
 * so a manifest can never raise a bound past the defaults (ADR-0009).
 */
export interface SkillConstraints {
  /** Maximum agent rounds one run of the skill may use. */
  readonly maxRoundsPerRun: number;
  /** Maximum agent tool calls one run of the skill may use. */
  readonly maxToolCallsPerRun: number;
  /** Maximum proposed commands one run of the skill may stage. */
  readonly maxCommandsPerRun: number;
  /** Maximum commands one generator proposal may contain. */
  readonly maxCommandsPerProposal: number;
  /** Maximum cumulative proposed voxel changes of one proposal. */
  readonly maxVoxelsPerProposal: number;
}

/**
 * One fixed structural check of a skill's evaluation metadata (plan
 * S14.10). `name` must resolve in the structural-check registry and
 * `options` must satisfy that check's option contract; the registry
 * rejects unknown checks and invalid options at registration.
 */
export interface SkillStructuralCheck {
  readonly name: string;
  readonly description: string;
  readonly options: JsonValue;
}

/** Standard preview view ids of the visual-baseline protocol (S15.2). */
export const BASELINE_VIEWS = ["perspective", "front", "side", "top"] as const;

export type BaselineView = (typeof BASELINE_VIEWS)[number];

/**
 * One fixed visual baseline of a skill's evaluation metadata: the
 * rendered standard view must keep its non-background silhouette share
 * inside the declared ratio interval. Baselines are declarative (the
 * skills package never renders); the evaluation harness supplies the
 * silhouette evidence.
 */
export interface SkillVisualBaseline {
  readonly view: BaselineView;
  readonly description: string;
  /** Inclusive lower bound of the silhouette pixel share (0..1). */
  readonly minSilhouetteRatio?: number;
  /** Inclusive upper bound of the silhouette pixel share (0..1). */
  readonly maxSilhouetteRatio?: number;
}

/**
 * Command/tool efficiency limits of a skill (plan S14.10): the golden
 * counts a clean run is expected to stay under and the absolute maxima
 * a run may never exceed. Goldens are recorded against the fixed
 * scenario prompt; maxima never exceed the skill constraints.
 */
export interface SkillEfficiencyLimits {
  readonly goldenToolCalls: number;
  readonly goldenRounds: number;
  readonly goldenCommands: number;
  readonly maxToolCalls: number;
  readonly maxRounds: number;
  readonly maxCommands: number;
}

/** Fixed evaluation metadata of one skill (plan S14.10). */
export interface SkillEvaluationMetadata {
  /** Stable id of the fixed evaluation scenario of the skill. */
  readonly scenarioId: string;
  /** The fixed user prompt the skill is evaluated against. */
  readonly fixedPrompt: string;
  /** Fixed structural checks over the resulting document. */
  readonly structuralChecks: readonly SkillStructuralCheck[];
  /** Fixed rendered-preview baselines of the resulting document. */
  readonly visualBaselines: readonly SkillVisualBaseline[];
  /** Command/tool efficiency limits of the fixed scenario. */
  readonly efficiency: SkillEfficiencyLimits;
}

/** One versioned creation-skill manifest (plan S14.1). */
export interface SkillManifest {
  readonly manifestVersion: number;
  /** Stable skill name (`skill.<kebab-case>`), unique in the registry. */
  readonly name: string;
  /** Semantic version of the skill definition (`major.minor.patch`). */
  readonly version: string;
  readonly description: string;
  readonly category: SkillCategory;
  /** Fixed instructions the agent runs under when the skill is active. */
  readonly instructions: string;
  /** Allowed agent tool names (subset of the registered tool surface). */
  readonly allowedTools: readonly string[];
  /** Compatible generator names (subset of the generator registry). */
  readonly generators: readonly string[];
  readonly constraints: SkillConstraints;
  readonly provenance: SkillProvenance;
  readonly evaluation: SkillEvaluationMetadata;
}

/** Known names the manifest validator resolves against (S14.2). */
export interface SkillEnvironment {
  /** Every registered agent tool name (inspection + mutation). */
  readonly knownTools: ReadonlySet<string>;
  /** Every registered generator name. */
  readonly knownGenerators: ReadonlySet<string>;
}

/** Stable error codes of the manifest validator (one per dimension). */
export const INVALID_SKILL_MANIFEST_CODE = "INVALID_SKILL_MANIFEST";
export const SKILL_MANIFEST_VERSION_CODE = "SKILL_MANIFEST_VERSION_INVALID";
export const SKILL_NAME_CODE = "SKILL_NAME_INVALID";
export const SKILL_DESCRIPTION_CODE = "SKILL_DESCRIPTION_INVALID";
export const SKILL_CATEGORY_CODE = "SKILL_CATEGORY_INVALID";
export const SKILL_VERSION_CODE = "SKILL_VERSION_INVALID";
export const SKILL_INSTRUCTIONS_CODE = "SKILL_INSTRUCTIONS_INVALID";
export const SKILL_TOOLS_CODE = "SKILL_TOOLS_INVALID";
export const SKILL_CONSTRAINTS_CODE = "SKILL_CONSTRAINTS_INVALID";
export const SKILL_GENERATOR_CODE = "SKILL_GENERATOR_INVALID";
export const SKILL_PROVENANCE_CODE = "SKILL_PROVENANCE_INVALID";
export const SKILL_EVALUATION_CODE = "SKILL_EVALUATION_INVALID";

const NAME_PATTERN = /^skill\.[a-z0-9-]+$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** Bounds shared by every manifest field (bounded input rule). */
const MAX_NAME_LENGTH = 64;
const MAX_VERSION_LENGTH = 32;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_INSTRUCTIONS_LENGTH = 16_384;
const MAX_TOOLS = 64;
const MAX_GENERATORS = 32;
const MAX_CHECKS = 32;
const MAX_BASELINES = 8;
const MAX_TEXT_LENGTH = 256;

/** Upper bounds a manifest constraint may never exceed (ADR-0009). */
export const SKILL_CONSTRAINT_CAPS = Object.freeze({
  maxRoundsPerRun: 16,
  maxToolCallsPerRun: 64,
  maxCommandsPerRun: 1_024,
  maxCommandsPerProposal: 1_024,
  maxVoxelsPerProposal: 1_000_000,
} as const);

function invalid(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>>,
): never {
  throw new WorkspaceError({
    family: "validation",
    code,
    message,
    // Context values are bounded plain JSON produced by the validator.
    context: context as Readonly<Record<string, JsonValue>>,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  minLength: number,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length < minLength || value.length > maxLength) return undefined;
  return value;
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * Validates one raw manifest against the skill environment and returns
 * the deep-frozen manifest. Every acceptance dimension of ticket #38 is
 * checked with its own stable error code: manifest version, name/version
 * shape, instructions, allowed tools, constraints, generator
 * compatibility, provenance, and evaluation metadata (structural checks,
 * visual baselines, efficiency limits).
 */
export function validateSkillManifest(
  value: unknown,
  environment: SkillEnvironment,
): SkillManifest {
  if (!isRecord(value)) {
    invalid(
      INVALID_SKILL_MANIFEST_CODE,
      "Skill manifest must be an object",
      {},
    );
  }

  const manifestVersion = value.manifestVersion;
  if (manifestVersion !== SKILL_MANIFEST_VERSION) {
    invalid(SKILL_MANIFEST_VERSION_CODE, "Unsupported skill manifest version", {
      manifestVersion,
      supported: SKILL_MANIFEST_VERSION,
    });
  }

  const name = boundedString(value.name, 1, MAX_NAME_LENGTH);
  if (name === undefined || !NAME_PATTERN.test(name)) {
    invalid(SKILL_NAME_CODE, "Invalid skill name", { name: value.name });
  }

  const version = boundedString(value.version, 1, MAX_VERSION_LENGTH);
  if (version === undefined || !VERSION_PATTERN.test(version)) {
    invalid(SKILL_VERSION_CODE, "Invalid skill version", {
      version: value.version,
    });
  }

  const description = boundedString(
    value.description,
    1,
    MAX_DESCRIPTION_LENGTH,
  );
  if (description === undefined) {
    invalid(SKILL_DESCRIPTION_CODE, "Invalid skill description", {
      description: value.description,
    });
  }

  const category = value.category;
  if (
    typeof category !== "string" ||
    !(SKILL_CATEGORIES as readonly string[]).includes(category)
  ) {
    invalid(SKILL_CATEGORY_CODE, "Invalid skill category", {
      category: value.category,
    });
  }

  const instructions = boundedString(
    value.instructions,
    1,
    MAX_INSTRUCTIONS_LENGTH,
  );
  if (instructions === undefined) {
    invalid(SKILL_INSTRUCTIONS_CODE, "Invalid skill instructions", {
      instructions: value.instructions,
    });
  }

  const allowedTools = value.allowedTools;
  if (
    !Array.isArray(allowedTools) ||
    allowedTools.length < 1 ||
    allowedTools.length > MAX_TOOLS ||
    allowedTools.some((tool) => typeof tool !== "string") ||
    !uniqueStrings(allowedTools as string[])
  ) {
    invalid(SKILL_TOOLS_CODE, "Invalid allowed tools list", {
      allowedTools,
    });
  }
  const unknownTools = (allowedTools as string[]).filter(
    (tool) => !environment.knownTools.has(tool),
  );
  if (unknownTools.length > 0) {
    invalid(SKILL_TOOLS_CODE, "Skill references unknown tools", {
      unknownTools,
    });
  }

  const generators = value.generators;
  if (
    !Array.isArray(generators) ||
    generators.length < 1 ||
    generators.length > MAX_GENERATORS ||
    generators.some((generator) => typeof generator !== "string") ||
    !uniqueStrings(generators as string[])
  ) {
    invalid(SKILL_GENERATOR_CODE, "Invalid generator list", { generators });
  }
  const unknownGenerators = (generators as string[]).filter(
    (generator) => !environment.knownGenerators.has(generator),
  );
  if (unknownGenerators.length > 0) {
    invalid(SKILL_GENERATOR_CODE, "Skill references unknown generators", {
      unknownGenerators,
    });
  }

  const constraints = validateConstraints(value.constraints);
  const provenance = validateProvenance(value.provenance);
  const evaluation = validateEvaluation(value.evaluation, constraints);

  const manifest: SkillManifest = {
    manifestVersion: SKILL_MANIFEST_VERSION,
    name,
    version,
    description,
    category: category as SkillCategory,
    instructions,
    allowedTools: Object.freeze(
      allowedTools.filter((tool): tool is string => typeof tool === "string"),
    ),
    generators: Object.freeze(
      generators.filter(
        (generator): generator is string => typeof generator === "string",
      ),
    ),
    constraints,
    provenance,
    evaluation,
  };
  return Object.freeze(manifest);
}

function validateConstraints(value: unknown): SkillConstraints {
  if (!isRecord(value)) {
    invalid(SKILL_CONSTRAINTS_CODE, "Constraints must be an object", {});
  }
  const caps = SKILL_CONSTRAINT_CAPS;
  const fields: Readonly<Record<string, number>> = {
    maxRoundsPerRun: caps.maxRoundsPerRun,
    maxToolCallsPerRun: caps.maxToolCallsPerRun,
    maxCommandsPerRun: caps.maxCommandsPerRun,
    maxCommandsPerProposal: caps.maxCommandsPerProposal,
    maxVoxelsPerProposal: caps.maxVoxelsPerProposal,
  };
  const result = {} as Record<string, number>;
  for (const key of Object.keys(fields)) {
    const parsed = boundedInteger(value[key], 1, fields[key] ?? 1);
    if (parsed === undefined) {
      invalid(SKILL_CONSTRAINTS_CODE, `Invalid constraint ${key}`, {
        field: key,
        value: value[key],
        maximum: fields[key],
      });
    }
    result[key] = parsed;
  }
  return Object.freeze(result) as unknown as SkillConstraints;
}

function validateProvenance(value: unknown): SkillProvenance {
  if (!isRecord(value)) {
    invalid(SKILL_PROVENANCE_CODE, "Provenance must be an object", {});
  }
  const author = boundedString(value.author, 1, MAX_TEXT_LENGTH);
  if (author === undefined) {
    invalid(SKILL_PROVENANCE_CODE, "Invalid provenance author", {
      author: value.author,
    });
  }
  const source = boundedString(value.source, 1, MAX_TEXT_LENGTH);
  if (source === undefined) {
    invalid(SKILL_PROVENANCE_CODE, "Invalid provenance source", {
      source: value.source,
    });
  }
  const license = boundedString(value.license, 1, MAX_TEXT_LENGTH);
  if (license === undefined) {
    invalid(SKILL_PROVENANCE_CODE, "Invalid provenance license", {
      license: value.license,
    });
  }
  const created = boundedString(value.created, 1, MAX_TEXT_LENGTH);
  if (created === undefined || !DATE_PATTERN.test(created)) {
    invalid(SKILL_PROVENANCE_CODE, "Invalid provenance created date", {
      created: value.created,
    });
  }
  return Object.freeze({ author, source, license, created });
}

function validateEvaluation(
  value: unknown,
  constraints: SkillConstraints,
): SkillEvaluationMetadata {
  if (!isRecord(value)) {
    invalid(SKILL_EVALUATION_CODE, "Evaluation metadata must be an object", {});
  }
  const scenarioId = boundedString(value.scenarioId, 1, 128);
  if (scenarioId === undefined) {
    invalid(SKILL_EVALUATION_CODE, "Invalid evaluation scenario id", {
      scenarioId: value.scenarioId,
    });
  }
  const fixedPrompt = boundedString(
    value.fixedPrompt,
    1,
    MAX_INSTRUCTIONS_LENGTH,
  );
  if (fixedPrompt === undefined) {
    invalid(SKILL_EVALUATION_CODE, "Invalid evaluation fixed prompt", {
      fixedPrompt: value.fixedPrompt,
    });
  }

  const structuralChecks = value.structuralChecks;
  if (
    !Array.isArray(structuralChecks) ||
    structuralChecks.length < 1 ||
    structuralChecks.length > MAX_CHECKS
  ) {
    invalid(SKILL_EVALUATION_CODE, "Invalid structural checks list", {
      structuralChecks,
    });
  }
  const checkNames = new Set<string>();
  const parsedChecks = structuralChecks.map((entry, index) => {
    if (!isRecord(entry)) {
      invalid(SKILL_EVALUATION_CODE, "Structural check must be an object", {
        index,
      });
    }
    const checkName = boundedString(entry.name, 1, MAX_TEXT_LENGTH);
    if (checkName === undefined || checkNames.has(checkName)) {
      invalid(SKILL_EVALUATION_CODE, "Invalid or duplicate check name", {
        index,
        name: entry.name,
      });
    }
    checkNames.add(checkName);
    const checkDescription = boundedString(
      entry.description,
      1,
      MAX_TEXT_LENGTH,
    );
    if (checkDescription === undefined) {
      invalid(SKILL_EVALUATION_CODE, "Invalid check description", {
        index,
        name: checkName,
      });
    }
    // Resolves the check against the structural-check registry and
    // validates its options; unknown checks and bad options surface as
    // the manifest's evaluation error with the check-level code in the
    // context.
    try {
      validateStructuralCheck(checkName, entry.options);
    } catch (error) {
      const cause =
        error instanceof WorkspaceError ? error.code : "UNKNOWN_ERROR";
      invalid(SKILL_EVALUATION_CODE, `Invalid structural check ${checkName}`, {
        check: checkName,
        cause,
      });
    }
    return Object.freeze({
      name: checkName,
      description: checkDescription,
      options: entry.options,
    });
  });

  const visualBaselines = value.visualBaselines;
  if (
    !Array.isArray(visualBaselines) ||
    visualBaselines.length < 1 ||
    visualBaselines.length > MAX_BASELINES
  ) {
    invalid(SKILL_EVALUATION_CODE, "Invalid visual baselines list", {
      visualBaselines,
    });
  }
  const baselineViews = new Set<string>();
  const parsedBaselines = visualBaselines.map((entry, index) => {
    if (!isRecord(entry)) {
      invalid(SKILL_EVALUATION_CODE, "Visual baseline must be an object", {
        index,
      });
    }
    const view = entry.view;
    if (
      typeof view !== "string" ||
      !(BASELINE_VIEWS as readonly string[]).includes(view) ||
      baselineViews.has(view)
    ) {
      invalid(SKILL_EVALUATION_CODE, "Invalid or duplicate baseline view", {
        index,
        view: entry.view,
      });
    }
    baselineViews.add(view);
    const description = boundedString(entry.description, 1, MAX_TEXT_LENGTH);
    if (description === undefined) {
      invalid(SKILL_EVALUATION_CODE, "Invalid baseline description", {
        index,
        view,
      });
    }
    const minRatio = ratioBound(entry.minSilhouetteRatio, "minSilhouetteRatio");
    const maxRatio = ratioBound(entry.maxSilhouetteRatio, "maxSilhouetteRatio");
    if (
      minRatio !== undefined &&
      maxRatio !== undefined &&
      minRatio > maxRatio
    ) {
      invalid(SKILL_EVALUATION_CODE, "Baseline ratio interval is inverted", {
        index,
        view,
        minRatio,
        maxRatio,
      });
    }
    return Object.freeze({
      view: view as BaselineView,
      description,
      ...(minRatio === undefined ? {} : { minSilhouetteRatio: minRatio }),
      ...(maxRatio === undefined ? {} : { maxSilhouetteRatio: maxRatio }),
    });
  });

  const efficiency = validateEfficiency(value.efficiency, constraints);

  return Object.freeze({
    scenarioId,
    fixedPrompt,
    structuralChecks: Object.freeze(
      parsedChecks,
    ) as readonly SkillStructuralCheck[],
    visualBaselines: Object.freeze(
      parsedBaselines,
    ) as readonly SkillVisualBaseline[],
    efficiency,
  });
}

function ratioBound(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(SKILL_EVALUATION_CODE, `Invalid baseline ${field}`, {
      field,
      value,
    });
  }
  if (value < 0 || value > 1) {
    invalid(SKILL_EVALUATION_CODE, `Baseline ${field} out of range`, {
      field,
      value,
    });
  }
  return value;
}

function validateEfficiency(
  value: unknown,
  constraints: SkillConstraints,
): SkillEfficiencyLimits {
  if (!isRecord(value)) {
    invalid(SKILL_EVALUATION_CODE, "Efficiency limits must be an object", {});
  }
  const pairs: Readonly<Record<string, number>> = {
    goldenToolCalls: constraints.maxToolCallsPerRun,
    goldenRounds: constraints.maxRoundsPerRun,
    goldenCommands: constraints.maxCommandsPerRun,
    maxToolCalls: constraints.maxToolCallsPerRun,
    maxRounds: constraints.maxRoundsPerRun,
    maxCommands: constraints.maxCommandsPerRun,
  };
  const result = {} as Record<string, number>;
  for (const key of Object.keys(pairs)) {
    const parsed = boundedInteger(value[key], 0, pairs[key] ?? 0);
    if (parsed === undefined) {
      invalid(SKILL_EVALUATION_CODE, `Invalid efficiency limit ${key}`, {
        field: key,
        value: value[key],
        maximum: pairs[key],
      });
    }
    result[key] = parsed;
  }
  const goldens: Readonly<Record<string, number>> = {
    goldenToolCalls: result.goldenToolCalls ?? 0,
    goldenRounds: result.goldenRounds ?? 0,
    goldenCommands: result.goldenCommands ?? 0,
  };
  for (const key of Object.keys(goldens)) {
    const maxKey = `max${key.slice(6)}`;
    if ((goldens[key] ?? 0) > (result[maxKey] ?? 0)) {
      invalid(SKILL_EVALUATION_CODE, "Golden limit exceeds its maximum", {
        field: key,
        golden: goldens[key],
        maximum: result[maxKey],
      });
    }
  }
  return Object.freeze(result) as unknown as SkillEfficiencyLimits;
}
