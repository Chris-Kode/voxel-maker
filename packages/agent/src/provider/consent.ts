import { WorkspaceError } from "@voxel-maker/shared";

/**
 * Explicit provider-use consent (plan S12.4, ADR-0010): the fixed set of
 * data categories a text-only run may transmit, a validated consent
 * record, and a store. Provider use is consented per provider+model, and
 * every loop verifies consent before its first request; there is no
 * blanket consent and no silent fallback provider.
 */

/** Consent record format version. */
export const CONSENT_VERSION = 1;

/** Default consent lifetime: 30 days. */
export const DEFAULT_CONSENT_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The only categories a text-only agent run may transmit (ADR-0010,
 * ARCHITECTURE.md cloud privacy). A consent record covers a subset; the
 * loop refuses to run when any category it would use is not covered.
 */
export const DISCLOSURE_CATEGORIES = [
  "user-prompt-and-run-messages",
  "fixed-system-safety-skill-tool-and-limit-instructions",
  "provider-model-and-settings-identifiers",
  "base-revision-and-bounded-document-selection-summaries",
  "explicitly-used-inspection-tool-results",
  "staged-command-summaries-validation-errors-and-bounded-diffs",
] as const;

export type DisclosureCategory = (typeof DISCLOSURE_CATEGORIES)[number];

/** One explicit consent record for a provider and model. */
export interface ProviderConsent {
  readonly providerId: string;
  readonly model: string;
  /** Transmitted-category subset the user reviewed and accepted. */
  readonly categories: readonly DisclosureCategory[];
  /** Epoch ms at consent time (injected clock for deterministic tests). */
  readonly consentedAt: number;
  /** Epoch ms after which consent must be renewed. */
  readonly expiresAt: number;
  readonly consentVersion: number;
  /** Optional per-run cost cap the user accepted (USD). */
  readonly costCapUsd?: number;
  /** Optional per-run token cap the user accepted. */
  readonly tokenCap?: number;
}

export interface ConsentInput {
  readonly providerId: string;
  readonly model: string;
  readonly categories: readonly DisclosureCategory[];
  readonly consentedAt?: number;
  readonly expiresAt?: number;
  readonly costCapUsd?: number;
  readonly tokenCap?: number;
  readonly clock?: { now(): number };
}

function consentError(message: string, code: string): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code,
    message,
  });
}

/** Validates and freezes a consent record. */
export function createConsent(input: ConsentInput): ProviderConsent {
  const now = input.clock?.now() ?? Date.now();
  const consentedAt = input.consentedAt ?? now;
  const expiresAt =
    input.expiresAt ?? consentedAt + DEFAULT_CONSENT_DURATION_MS;
  for (const category of input.categories) {
    if (!DISCLOSURE_CATEGORIES.includes(category)) {
      throw consentError(
        `Unknown disclosure category: ${category}`,
        "UNKNOWN_DISCLOSURE_CATEGORY",
      );
    }
  }
  if (!Number.isFinite(consentedAt) || !Number.isFinite(expiresAt)) {
    throw consentError("Consent timestamps must be finite", "INVALID_CONSENT_TIME");
  }
  if (expiresAt <= consentedAt) {
    throw consentError(
      "Consent expiry must be after the consent time",
      "INVALID_CONSENT_EXPIRY",
    );
  }
  return Object.freeze({
    providerId: input.providerId,
    model: input.model,
    categories: Object.freeze([...input.categories]),
    consentedAt,
    expiresAt,
    consentVersion: CONSENT_VERSION,
    ...(input.costCapUsd === undefined ? {} : { costCapUsd: input.costCapUsd }),
    ...(input.tokenCap === undefined ? {} : { tokenCap: input.tokenCap }),
  });
}

/** True when the consent record has expired at `now`. */
export function consentExpired(
  consent: ProviderConsent,
  now: number = Date.now(),
): boolean {
  return now > consent.expiresAt;
}

/**
 * True when the consent covers this exact provider and model and has not
 * expired; the loop refuses any request it does not cover.
 */
export function consentCovers(
  consent: ProviderConsent,
  request: { readonly providerId: string; readonly model: string },
  now: number = Date.now(),
): boolean {
  return (
    consent.providerId === request.providerId &&
    consent.model === request.model &&
    !consentExpired(consent, now) &&
    consent.categories.length === DISCLOSURE_CATEGORIES.length
  );
}

/** Stable error when a run tries to use a provider without consent. */
export function consentRequiredError(): WorkspaceError {
  return new WorkspaceError({
    family: "conflict",
    code: "CONSENT_REQUIRED",
    message:
      "Provider use requires explicit consent for the provider, model, and transmitted data categories",
  });
}

/** Consent record store seam (memory implementation for headless/tests). */
export interface ConsentStore {
  save(consent: ProviderConsent): Promise<void>;
  get(providerId: string, model: string): Promise<ProviderConsent | undefined>;
  delete(providerId: string, model: string): Promise<boolean>;
  list(): Promise<readonly ProviderConsent[]>;
}

/** Deterministic in-memory consent store. */
export class MemoryConsentStore implements ConsentStore {
  readonly #entries = new Map<string, ProviderConsent>();

  async save(consent: ProviderConsent): Promise<void> {
    this.#entries.set(`${consent.providerId}\u0000${consent.model}`, consent);
  }

  async get(providerId: string, model: string): Promise<ProviderConsent | undefined> {
    return this.#entries.get(`${providerId}\u0000${model}`);
  }

  async delete(providerId: string, model: string): Promise<boolean> {
    return this.#entries.delete(`${providerId}\u0000${model}`);
  }

  async list(): Promise<readonly ProviderConsent[]> {
    return [...this.#entries.values()];
  }
}
