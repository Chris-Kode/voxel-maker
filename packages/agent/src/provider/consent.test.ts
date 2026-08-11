import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  CONSENT_VERSION,
  DISCLOSURE_CATEGORIES,
  consentCovers,
  consentExpired,
  createConsent,
} from "./consent.js";

/**
 * Provider-consent tests (plan S12.4, ADR-0010, issue #117): a consent
 * record names the provider, model, transmitted categories, lifetime,
 * and the optional per-run token and spend caps the user accepted. Caps
 * are part of the consent boundary, so a record that is not finite and
 * nonnegative must be rejected at creation.
 */

const NOW = 1_750_000_000_000;

function baseInput() {
  return {
    providerId: "openai",
    model: "gpt-4o-mini",
    categories: DISCLOSURE_CATEGORIES,
    consentedAt: NOW,
    expiresAt: NOW + 86_400_000,
  };
}

describe("createConsent", () => {
  it("freezes a valid consent record with the version tag", () => {
    const consent = createConsent(baseInput());
    expect(consent.consentVersion).toBe(CONSENT_VERSION);
    expect(Object.isFrozen(consent)).toBe(true);
    expect(consent.tokenCap).toBeUndefined();
    expect(consent.costCapUsd).toBeUndefined();
  });

  it("accepts finite nonnegative token and cost caps and stores them", () => {
    const consent = createConsent({
      ...baseInput(),
      tokenCap: 0,
      costCapUsd: 0,
    });
    expect(consent.tokenCap).toBe(0);
    expect(consent.costCapUsd).toBe(0);
    const capped = createConsent({
      ...baseInput(),
      tokenCap: 5_000,
      costCapUsd: 0.05,
    });
    expect(capped.tokenCap).toBe(5_000);
    expect(capped.costCapUsd).toBe(0.05);
  });

  it("rejects non-finite or negative token and cost caps (issue #117)", () => {
    for (const bad of [
      { tokenCap: -1 },
      { tokenCap: -0 },
      { tokenCap: Number.NaN },
      { tokenCap: Number.POSITIVE_INFINITY },
      { tokenCap: Number.NEGATIVE_INFINITY },
      { costCapUsd: -0.001 },
      { costCapUsd: -0 },
      { costCapUsd: Number.NaN },
      { costCapUsd: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => createConsent({ ...baseInput(), ...bad })).toThrow(
        WorkspaceError,
      );
    }
  });
});

describe("consentCovers", () => {
  const consent = createConsent({
    ...baseInput(),
    tokenCap: 1_000,
    costCapUsd: 0.01,
  });

  it("covers the exact provider and model and every disclosure category", () => {
    expect(
      consentCovers(
        consent,
        { providerId: "openai", model: "gpt-4o-mini" },
        NOW,
      ),
    ).toBe(true);
  });

  it("refuses a different provider, model, or an expired record", () => {
    expect(
      consentCovers(
        consent,
        { providerId: "other", model: "gpt-4o-mini" },
        NOW,
      ),
    ).toBe(false);
    expect(
      consentCovers(consent, { providerId: "openai", model: "gpt-4o" }, NOW),
    ).toBe(false);
    expect(consentExpired(consent, consent.expiresAt + 1)).toBe(true);
    expect(
      consentCovers(
        consent,
        { providerId: "openai", model: "gpt-4o-mini" },
        consent.expiresAt + 1,
      ),
    ).toBe(false);
  });
});
