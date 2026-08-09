/**
 * Resource limits for the bounded AI inspection surface (plan S11.10,
 * ADR-0009). Every limit has a hard default; callers may lower them at
 * composition time but never raise them, so one fixed budget applies to
 * every agent session. All limits are enforced deterministically: they
 * bound pagination pages, scan work, response bytes, hierarchy depth, and
 * metadata emission before allocation or iteration.
 */

/** Default inspection resource limits (ADR-0009 defaults; callers may lower). */
export interface InspectionLimits {
  /**
   * Maximum serialized response size in JSON code units (UTF-16 length of
   * `JSON.stringify`). Responses that would exceed the budget are
   * truncated predictably and carry `truncated: true`.
   */
  readonly maxResponseBytes: number;
  /** Default page size when a tool call does not request one. */
  readonly defaultPageSize: number;
  /** Hard maximum accepted page size; larger requests are rejected. */
  readonly maxPageSize: number;
  /** Default hierarchy depth (`inspectHierarchy`); input may lower it. */
  readonly defaultHierarchyDepth: number;
  /** Hard maximum hierarchy depth; larger requests are rejected. */
  readonly maxHierarchyDepth: number;
  /** Maximum occupied voxel entries collected by one voxel query. */
  readonly maxVoxelsPerQuery: number;
  /** Maximum chunks scanned by one voxel query (bounds empty-region scans). */
  readonly maxChunksPerQuery: number;
  /** Maximum ray traversal steps (`raycast`). */
  readonly maxRaySteps: number;
  /** Maximum selection entries reported by one selection snapshot. */
  readonly maxSelectionEntries: number;
  /** Maximum metadata keys reported by `inspectNode`. */
  readonly maxMetadataKeys: number;
  /** Maximum characters of a node/material/clip name in any response. */
  readonly maxNameLength: number;
}

/** ADR-0009-aligned hard defaults for the v1 inspection surface. */
export const DEFAULT_INSPECTION_LIMITS: InspectionLimits = Object.freeze({
  maxResponseBytes: 65_536,
  defaultPageSize: 50,
  maxPageSize: 500,
  defaultHierarchyDepth: 8,
  maxHierarchyDepth: 32,
  maxVoxelsPerQuery: 262_144,
  maxChunksPerQuery: 256,
  maxRaySteps: 4096,
  maxSelectionEntries: 256,
  maxMetadataKeys: 32,
  maxNameLength: 128,
});

/**
 * Resolves caller-supplied overrides against the hard defaults. Only
 * strict lowerings are honored; every limit is clamped to `[0, default]`
 * so no caller can raise a bound past the default budget.
 */
/**
 * Merges caller overrides against hard defaults and clamps every numeric
 * limit into `[0, default]`, so no caller can raise a bound past the
 * default budget. Shared by every limit profile.
 */
function clampLimits<T extends object>(
  defaults: T,
  overrides: Partial<T> | undefined,
): T {
  const merged = { ...defaults, ...overrides };
  const clamped = {} as Record<string, number>;
  for (const key of Object.keys(defaults)) {
    const value = (merged as Record<string, unknown>)[key];
    const max = (defaults as Record<string, number>)[key] as number;
    clamped[key] =
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.min(value, max))
        : max;
  }
  return Object.freeze(clamped) as unknown as T;
}

export function resolveInspectionLimits(
  overrides: Partial<InspectionLimits> | undefined,
): InspectionLimits {
  return clampLimits(DEFAULT_INSPECTION_LIMITS, overrides);
}

/**
 * Resource limits for the bounded AI mutation surface (plan S11.10,
 * ticket #32). Tool calls are bounded per call (`maxResponseBytes`,
 * `maxBatchEntries`); a preview session is bounded across the whole
 * staging run (`maxStagedCommands`, `maxProposedVoxelChanges`,
 * `maxDiffEntries`). Every limit has a hard default; callers may lower
 * them at composition time but never raise them.
 */

/** Default mutation resource limits (ADR-0009-aligned; callers may lower). */
export interface MutationLimits {
  /**
   * Maximum serialized response size in JSON code units. Mutation
   * responses carry one full constructed command, so the default matches
   * the command payload byte budget.
   */
  readonly maxResponseBytes: number;
  /** Maximum entries/coordinates accepted by one batch tool call. */
  readonly maxBatchEntries: number;
  /** Maximum commands one preview session may stage. */
  readonly maxStagedCommands: number;
  /** Maximum cumulative proposed voxel changes one session may stage. */
  readonly maxProposedVoxelChanges: number;
  /** Maximum ids reported by one bounded semantic diff. */
  readonly maxDiffEntries: number;
}

/** ADR-0009-aligned hard defaults for the v1 mutation surface. */
export const DEFAULT_MUTATION_LIMITS: MutationLimits = Object.freeze({
  maxResponseBytes: 1_048_576,
  maxBatchEntries: 100_000,
  maxStagedCommands: 1_024,
  maxProposedVoxelChanges: 1_000_000,
  maxDiffEntries: 1_024,
});

/**
 * Resolves caller-supplied overrides against the hard defaults. Only
 * strict lowerings are honored; every limit is clamped to `[0, default]`
 * so no caller can raise a bound past the default budget.
 */
export function resolveMutationLimits(
  overrides: Partial<MutationLimits> | undefined,
): MutationLimits {
  return clampLimits(DEFAULT_MUTATION_LIMITS, overrides);
}
