import type { TransactionResult } from "@voxel-maker/commands";
import type { PreviewSession, ApplyOptions } from "@voxel-maker/agent";
import { digestHex } from "./hash.js";

/**
 * Skill provenance (plan S14.9, ticket #38): the active skill and its
 * version are recorded in transaction metadata — the apply label and
 * correlation id of the one optimistic transaction a skill proposal is
 * applied as. Provenance is advisory history/journal metadata: it is
 * never written into the document, never required to open, edit,
 * animate, or export the result, and never consulted by the command
 * bus. Removing the skill catalog therefore cannot affect any document
 * previously created with a skill (ticket #38 AC4).
 */

/** Label prefix of skill provenance (`skill:<name>@<version>`). */
export const SKILL_PROVENANCE_PREFIX = "skill";

const LABEL_PATTERN = /^skill:([a-z0-9.-]+)@([0-9]+\.[0-9]+\.[0-9]+)$/u;

/** The provenance label of one skill version. */
export function provenanceLabel(name: string, version: string): string {
  return `${SKILL_PROVENANCE_PREFIX}:${name}@${version}`;
}

/** Parses a provenance label back into name and version. */
export function parseProvenanceLabel(
  label: string,
): { readonly name: string; readonly version: string } | undefined {
  const match = LABEL_PATTERN.exec(label);
  if (match === null) return undefined;
  return { name: match[1] ?? "", version: match[2] ?? "" };
}

/**
 * Deterministic correlation id of one skill proposal apply: the
 * provenance label plus a digest of the run seed, so repeated applies of
 * the same proposal share one correlation key while distinct runs stay
 * distinguishable.
 */
export function provenanceCorrelationId(
  name: string,
  version: string,
  seed: string,
): string {
  return `${provenanceLabel(name, version)}:${digestHex(seed)}`;
}

/**
 * Applies a staged skill proposal with provenance metadata: the history
 * entry and recovery journal carry `skill:<name>@<version>` as the
 * label and the deterministic correlation id. Explicit caller options
 * win; defaults keep every skill apply attributable. Returns the
 * preview session's transaction result.
 */
export function applyWithProvenance(
  session: PreviewSession,
  name: string,
  version: string,
  seed: string,
  options: ApplyOptions = {},
): TransactionResult {
  return session.apply({
    ...options,
    label: options.label ?? provenanceLabel(name, version),
    correlationId:
      options.correlationId ?? provenanceCorrelationId(name, version, seed),
  });
}
