import { WorkspaceError } from "@voxel-maker/shared";

/**
 * Document schema migration registry (plan S2.11, ADR-0004, ADR-0011).
 * Persisted documents carry an explicit `documentSchemaVersion`; a format
 * change that adds, removes, or reinterprets fields bumps that version and
 * registers an ordered, pure, JSON-to-JSON migration for every supported
 * transition. Migrations run one version at a time (`vN -> vN+1`) and never
 * skip; a file whose version is unknown or newer than the current release
 * fails with a compatibility error and is never overwritten. The registry
 * stays empty while v1 is the only released version: the identity chain
 * below proves the current format round-trips, and every future transition
 * must retain its own fixture before the chain may grow.
 */

/** Current supported document schema version (frozen v1, document-v1.md). */
export const CURRENT_DOCUMENT_SCHEMA_VERSION = 1;

/** One ordered, pure JSON-to-JSON schema transition. */
export interface DocumentMigrationStep {
  readonly fromVersion: number;
  readonly toVersion: number;
  /**
   * Pure canonical-JSON-to-canonical-JSON migration. Must not read the
   * clock, random sources, or platform state, and must emit the target
   * version's canonical shape (validation re-checks it afterwards).
   */
  readonly migrate: (json: string) => string;
}

/** One transition that actually ran, in execution order. */
export interface AppliedMigrationStep {
  readonly fromVersion: number;
  readonly toVersion: number;
}

/** The migrated canonical JSON plus a report of every applied transition. */
export interface MigrationResult {
  readonly json: string;
  readonly steps: readonly AppliedMigrationStep[];
}

/** A validated, contiguous migration chain ending at the current version. */
export interface DocumentMigrationChain {
  /** The version every migrated document ends at. */
  readonly currentVersion: number;
  /** The oldest version the chain can migrate from (current when empty). */
  readonly oldestVersion: number;
  /** Registered transitions sorted by `fromVersion`; never mutated. */
  readonly steps: readonly DocumentMigrationStep[];
  /** True for the current version and every older version the chain covers. */
  canMigrate(version: number): boolean;
  /**
   * Migrates canonical JSON one step at a time from `fromVersion` to
   * `currentVersion`, returning the final JSON and an applied-step report.
   * Any version outside the supported range (non-integer, below 1, unknown,
   * or future) throws a `compatibility`/`UNSUPPORTED_DOCUMENT_VERSION`
   * error: the version is untrusted file input, never a programmer error.
   */
  migrate(json: string, fromVersion: number): MigrationResult;
}

const chainError = (code: string, message: string): WorkspaceError =>
  new WorkspaceError({
    family: "internal",
    code,
    message,
    context: { currentVersion: CURRENT_DOCUMENT_SCHEMA_VERSION },
  });

const assertIntegerVersion = (version: number, label: string): void => {
  if (!Number.isInteger(version) || version < 1) {
    throw chainError(
      "INVALID_MIGRATION_CHAIN",
      `Migration ${label} must be an integer of at least 1`,
    );
  }
};

/**
 * Builds a validated migration chain. Steps may arrive in any order; the
 * chain requires consecutive `vN -> vN+1` transitions with no duplicates,
 * no gaps, and a final step that lands exactly on `currentVersion` (the
 * frozen v1 default). A step that jumps more than one version or a chain
 * that cannot reach the current version is a programmer error and throws.
 */
export function createMigrationChain(
  steps: readonly DocumentMigrationStep[],
  currentVersion: number = CURRENT_DOCUMENT_SCHEMA_VERSION,
): DocumentMigrationChain {
  assertIntegerVersion(currentVersion, "current version");
  const ordered = [...steps].sort((a, b) => a.fromVersion - b.fromVersion);
  const seen = new Set<number>();
  let previousTo: number | undefined;
  for (const step of ordered) {
    assertIntegerVersion(step.fromVersion, "fromVersion");
    if (step.toVersion !== step.fromVersion + 1) {
      throw chainError(
        "INVALID_MIGRATION_CHAIN",
        "Migrations run one version at a time; a step must map vN to vN+1",
      );
    }
    if (seen.has(step.fromVersion)) {
      throw chainError(
        "INVALID_MIGRATION_CHAIN",
        "A migration chain cannot register the same fromVersion twice",
      );
    }
    seen.add(step.fromVersion);
    if (previousTo !== undefined && step.fromVersion !== previousTo) {
      throw chainError(
        "INVALID_MIGRATION_CHAIN",
        "Migration steps must be contiguous; a gap or duplicate version is not allowed",
      );
    }
    previousTo = step.toVersion;
  }
  if (previousTo !== undefined && previousTo > currentVersion) {
    throw chainError(
      "INVALID_MIGRATION_CHAIN",
      "A migration chain cannot migrate beyond the current version",
    );
  }
  if (previousTo !== undefined && previousTo !== currentVersion) {
    throw chainError(
      "INVALID_MIGRATION_CHAIN",
      "A migration chain must reach the current version",
    );
  }
  const oldestVersion = ordered[0]?.fromVersion ?? currentVersion;
  const frozenSteps = Object.freeze(ordered);
  const canMigrate = (version: number): boolean =>
    Number.isInteger(version) &&
    version >= 1 &&
    version <= currentVersion &&
    (version === currentVersion || version >= oldestVersion);
  return {
    currentVersion,
    oldestVersion,
    steps: frozenSteps,
    canMigrate,
    migrate(json: string, fromVersion: number): MigrationResult {
      if (fromVersion === currentVersion) {
        return { json, steps: Object.freeze([]) };
      }
      if (!canMigrate(fromVersion)) {
        throw new WorkspaceError({
          family: "compatibility",
          code: "UNSUPPORTED_DOCUMENT_VERSION",
          message:
            "Document format version is not supported by the migration chain; refusing to guess at unknown data",
          context: {
            version: fromVersion,
            currentVersion,
            oldestVersion,
          },
        });
      }
      let current = json;
      const applied: AppliedMigrationStep[] = [];
      for (const step of frozenSteps) {
        if (step.fromVersion < fromVersion) continue;
        current = step.migrate(current);
        applied.push({
          fromVersion: step.fromVersion,
          toVersion: step.toVersion,
        });
      }
      return { json: current, steps: Object.freeze(applied) };
    },
  };
}

/** The production registry: v1 is current, so the chain has no transitions. */
export const DOCUMENT_MIGRATION_CHAIN: DocumentMigrationChain =
  createMigrationChain([]);
