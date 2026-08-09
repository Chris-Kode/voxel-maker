import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  DEFAULT_IMAGE_CONSENT_DURATION_MS,
  IMAGE_CONSENT_VERSION,
  MAX_IMAGES_PER_SESSION,
  MAX_VISUAL_ITERATIONS_PER_SESSION,
  MemoryImageConsentStore,
  PROVIDER_PRIVACY_POLICY,
  createImageConsent,
  createVisualRefinementPlan,
  imageConsentCovers,
  imageConsentExpired,
  imageConsentRequiredError,
  planCoveredByConsent,
} from "./image-consent.js";

/**
 * Image-transmission consent tests (plan S15.3, ADR-0010, ticket #40):
 * rendered evidence is a distinct disclosure from text AI; a
 * visual-refinement session runs only under an explicit consent that
 * names the provider, model, views, count, resolution, and cost, and the
 * recorded provider privacy policy is fixed product policy.
 */

const NOW = 1_750_000_000_000;

const CONSENT = {
  providerId: "openai",
  model: "gpt-4o-mini",
  views: ["perspective", "front", "side", "top"] as const,
  maxImages: 12,
  maxResolution: 512,
  estimatedCostUsd: 0.05,
  consentedAt: NOW,
  expiresAt: NOW + DEFAULT_IMAGE_CONSENT_DURATION_MS,
};

describe("createImageConsent", () => {
  it("freezes a valid consent record with the version tag", () => {
    const consent = createImageConsent(CONSENT);
    expect(consent.consentVersion).toBe(IMAGE_CONSENT_VERSION);
    expect(consent.maxImages).toBe(12);
    expect(Object.isFrozen(consent)).toBe(true);
  });

  it("rejects unknown views, empty views, and out-of-range budgets", () => {
    for (const bad of [
      { ...CONSENT, views: [] },
      { ...CONSENT, views: ["north"] },
      { ...CONSENT, views: ["front", "front"] },
      { ...CONSENT, maxImages: 0 },
      { ...CONSENT, maxImages: MAX_IMAGES_PER_SESSION + 1 },
      { ...CONSENT, maxResolution: 0 },
      { ...CONSENT, maxResolution: 2049 },
      { ...CONSENT, estimatedCostUsd: -1 },
      { ...CONSENT, expiresAt: CONSENT.consentedAt },
    ]) {
      expect(() => createImageConsent(bad as never)).toThrow(WorkspaceError);
    }
  });

  it("defaults the expiry to the consent duration", () => {
    const consent = createImageConsent({
      providerId: "openai",
      model: "gpt-4o-mini",
      views: ["front"],
      maxImages: 4,
      maxResolution: 512,
      estimatedCostUsd: 0.01,
      clock: { now: () => 5000 },
    });
    expect(consent.consentedAt).toBe(5000);
    expect(consent.expiresAt).toBe(5000 + DEFAULT_IMAGE_CONSENT_DURATION_MS);
  });
});

describe("imageConsentCovers", () => {
  const consent = createImageConsent(CONSENT);

  it("covers the exact approved request", () => {
    expect(
      imageConsentCovers(
        consent,
        {
          providerId: "openai",
          model: "gpt-4o-mini",
          views: ["perspective", "front", "side", "top"],
          imageCount: 4,
          resolution: 512,
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("refuses a different provider, model, views, count, or resolution", () => {
    const base = {
      providerId: "openai",
      model: "gpt-4o-mini",
      views: ["perspective", "front", "side", "top"] as const,
      imageCount: 4,
      resolution: 512,
    };
    expect(
      imageConsentCovers(consent, { ...base, providerId: "other" }, NOW),
    ).toBe(false);
    expect(imageConsentCovers(consent, { ...base, model: "gpt-4o" }, NOW)).toBe(
      false,
    );
    expect(
      imageConsentCovers(
        consent,
        {
          ...base,
          views: ["perspective", "front", "side", "top", "bottom"] as never,
        },
        NOW,
      ),
    ).toBe(false);
    expect(imageConsentCovers(consent, { ...base, imageCount: 13 }, NOW)).toBe(
      false,
    );
    expect(
      imageConsentCovers(consent, { ...base, resolution: 1024 }, NOW),
    ).toBe(false);
  });

  it("refuses expired consent", () => {
    expect(
      imageConsentCovers(
        consent,
        {
          providerId: "openai",
          model: "gpt-4o-mini",
          views: ["front"],
          imageCount: 1,
          resolution: 512,
        },
        consent.expiresAt + 1,
      ),
    ).toBe(false);
    expect(imageConsentExpired(consent, consent.expiresAt + 1)).toBe(true);
  });
});

describe("visual refinement plans", () => {
  it("validates and freezes a per-session plan", () => {
    const plan = createVisualRefinementPlan({
      providerId: "openai",
      model: "gpt-4o-mini",
      resolution: 512,
    });
    expect(plan.views).toEqual(["perspective", "front", "side", "top"]);
    expect(plan.imageCount).toBe(4);
    expect(plan.maxImages).toBe(MAX_IMAGES_PER_SESSION);
    expect(plan.maxVisualIterations).toBe(MAX_VISUAL_ITERATIONS_PER_SESSION);
    expect(plan.estimatedCostUsd).toBeGreaterThanOrEqual(0);
  });

  it("rejects plans that cannot fit their own image budget", () => {
    expect(() =>
      createVisualRefinementPlan({
        providerId: "openai",
        model: "gpt-4o-mini",
        views: ["perspective", "front", "side", "top"],
        maxImages: 2,
      }),
    ).toThrow(WorkspaceError);
  });

  it("is covered only by consent that matches provider, model, views, count, and resolution", () => {
    const consent = createImageConsent(CONSENT);
    const plan = createVisualRefinementPlan({
      providerId: "openai",
      model: "gpt-4o-mini",
      resolution: 512,
    });
    expect(planCoveredByConsent(plan, consent, NOW)).toBe(true);
    const wrongProvider = createVisualRefinementPlan({
      providerId: "other",
      model: "gpt-4o-mini",
      resolution: 512,
    });
    expect(planCoveredByConsent(wrongProvider, consent, NOW)).toBe(false);
    const tooBig = createVisualRefinementPlan({
      providerId: "openai",
      model: "gpt-4o-mini",
      resolution: 1024,
    });
    expect(planCoveredByConsent(tooBig, consent, NOW)).toBe(false);
  });
});

describe("provider privacy policy record", () => {
  it("records the OpenAI API retention policy, URL, and as-of date", () => {
    expect(PROVIDER_PRIVACY_POLICY.providerId).toBe("openai");
    expect(PROVIDER_PRIVACY_POLICY.url).toContain("openai.com");
    expect(PROVIDER_PRIVACY_POLICY.summary.length).toBeGreaterThan(0);
    expect(PROVIDER_PRIVACY_POLICY.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("image consent store", () => {
  it("saves, reads, lists, and deletes records", async () => {
    const store = new MemoryImageConsentStore();
    const consent = createImageConsent(CONSENT);
    await store.save(consent);
    expect(await store.get("openai", "gpt-4o-mini")).toEqual(consent);
    expect(await store.list()).toHaveLength(1);
    expect(await store.delete("openai", "gpt-4o-mini")).toBe(true);
    expect(await store.get("openai", "gpt-4o-mini")).toBeUndefined();
  });
});

describe("imageConsentRequiredError", () => {
  it("is a stable conflict error", () => {
    const error = imageConsentRequiredError();
    expect(error.family).toBe("conflict");
    expect(error.code).toBe("IMAGE_CONSENT_REQUIRED");
  });
});
