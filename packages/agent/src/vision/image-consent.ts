import { WorkspaceError } from "@voxel-maker/shared";
import { estimateImageTokens } from "../provider/types.js";
import { priceForModel } from "../provider/cost.js";
import {
  MAX_EVIDENCE_DIMENSION,
  MAX_EVIDENCE_IMAGES,
  STANDARD_VIEWS,
  type StandardViewId,
} from "./evidence.js";

/**
 * Explicit image-transmission consent (plan S15.3, ADR-0010, ticket #40):
 * rendered standard-view evidence is a DISTINCT disclosure from text AI.
 * Images are off by default; every visual-refinement session requires a
 * per-session confirmation that names the provider, model, views, image
 * count, maximum resolution, budget, and estimated cost. The loop refuses
 * to transmit a single image without a consent record that covers the
 * exact request.
 */

/** Consent record format version. */
export const IMAGE_CONSENT_VERSION = 1;

/** Default image-consent lifetime: 30 days. */
export const DEFAULT_IMAGE_CONSENT_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard cap on images per visual-refinement session (ADR-0009 table). */
export const MAX_IMAGES_PER_SESSION = 12;

/** Hard cap on visual refinement iterations per session (ADR-0009 table). */
export const MAX_VISUAL_ITERATIONS_PER_SESSION = 3;

/**
 * Recorded provider privacy policy for image transmission (ADR-0010:
 * "the UI states the provider's actual published retention terms and
 * date"). One immutable product-policy constant the consent UI and the
 * loop both follow; changing it is a policy change requiring review.
 */
export const PROVIDER_PRIVACY_POLICY = Object.freeze({
  providerId: "openai",
  /** Summarized from the provider's published API data usage policy. */
  summary:
    "OpenAI API inputs and outputs are not used for training by default; " +
    "API data may be retained for up to 30 days for abuse and misuse " +
    "monitoring, except where law requires longer retention.",
  url: "https://openai.com/policies/api-data-usage-policies",
  /** Date the terms were recorded (policy-as-of date). */
  recordedAt: "2025-06-01",
} as const);

/** One explicit image-transmission consent record. */
export interface ImageTransmissionConsent {
  readonly providerId: string;
  readonly model: string;
  /** Standard views the user approved (non-empty subset). */
  readonly views: readonly StandardViewId[];
  /** Maximum images the user approved for one session. */
  readonly maxImages: number;
  /** Maximum square resolution in px the user approved. */
  readonly maxResolution: number;
  /** Estimated session cost in USD the user accepted. */
  readonly estimatedCostUsd: number;
  readonly consentedAt: number;
  readonly expiresAt: number;
  readonly consentVersion: number;
}

export interface ImageConsentInput {
  readonly providerId: string;
  readonly model: string;
  readonly views: readonly StandardViewId[];
  readonly maxImages: number;
  readonly maxResolution: number;
  readonly estimatedCostUsd: number;
  readonly consentedAt?: number;
  readonly expiresAt?: number;
  readonly clock?: { now(): number };
}

function consentError(code: string, message: string): WorkspaceError {
  return new WorkspaceError({ family: "validation", code, message });
}

/** Validates and freezes one image-consent record. */
export function createImageConsent(input: ImageConsentInput): ImageTransmissionConsent {
  const now = input.clock?.now() ?? Date.now();
  const consentedAt = input.consentedAt ?? now;
  const expiresAt =
    input.expiresAt ?? consentedAt + DEFAULT_IMAGE_CONSENT_DURATION_MS;
  if (input.providerId.length === 0 || input.model.length === 0) {
    throw consentError(
      "INVALID_IMAGE_CONSENT",
      "Image consent needs a provider and a model",
    );
  }
  if (input.views.length === 0 || input.views.length > MAX_EVIDENCE_IMAGES) {
    throw consentError(
      "INVALID_IMAGE_CONSENT",
      `Image consent needs between 1 and ${String(MAX_EVIDENCE_IMAGES)} standard views`,
    );
  }
  for (const view of input.views) {
    if (!STANDARD_VIEWS.includes(view)) {
      throw consentError("INVALID_IMAGE_CONSENT", `Unknown standard view: ${view}`);
    }
  }
  if (new Set(input.views).size !== input.views.length) {
    throw consentError("INVALID_IMAGE_CONSENT", "Image consent views must not repeat");
  }
  if (
    !Number.isInteger(input.maxImages) ||
    input.maxImages < 1 ||
    input.maxImages > MAX_IMAGES_PER_SESSION
  ) {
    throw consentError(
      "INVALID_IMAGE_CONSENT",
      `Image consent maxImages must be an integer in [1, ${String(MAX_IMAGES_PER_SESSION)}]`,
    );
  }
  if (
    !Number.isInteger(input.maxResolution) ||
    input.maxResolution < 1 ||
    input.maxResolution > MAX_EVIDENCE_DIMENSION
  ) {
    throw consentError(
      "INVALID_IMAGE_CONSENT",
      `Image consent maxResolution must be an integer in [1, ${String(MAX_EVIDENCE_DIMENSION)}]`,
    );
  }
  if (
    !Number.isFinite(input.estimatedCostUsd) ||
    input.estimatedCostUsd < 0
  ) {
    throw consentError(
      "INVALID_IMAGE_CONSENT",
      "Image consent estimated cost must be a non-negative number",
    );
  }
  if (!Number.isFinite(consentedAt) || !Number.isFinite(expiresAt)) {
    throw consentError(
      "INVALID_IMAGE_CONSENT",
      "Image consent timestamps must be finite",
    );
  }
  if (expiresAt <= consentedAt) {
    throw consentError(
      "INVALID_IMAGE_CONSENT",
      "Image consent expiry must be after the consent time",
    );
  }
  return Object.freeze({
    providerId: input.providerId,
    model: input.model,
    views: Object.freeze([...input.views]),
    maxImages: input.maxImages,
    maxResolution: input.maxResolution,
    estimatedCostUsd: input.estimatedCostUsd,
    consentedAt,
    expiresAt,
    consentVersion: IMAGE_CONSENT_VERSION,
  });
}

/** True when the image consent has expired at `now`. */
export function imageConsentExpired(
  consent: ImageTransmissionConsent,
  now: number = Date.now(),
): boolean {
  return now > consent.expiresAt;
}

/** One image-transmission request to check against a consent record. */
export interface ImageTransmissionRequest {
  readonly providerId: string;
  readonly model: string;
  readonly views: readonly StandardViewId[];
  readonly imageCount: number;
  /** Square resolution in px. */
  readonly resolution: number;
}

/**
 * True when the consent record covers the exact request: same
 * provider/model, not expired, every requested view approved, requested
 * image count within the approved maximum, and requested resolution
 * within the approved maximum.
 */
export function imageConsentCovers(
  consent: ImageTransmissionConsent,
  request: ImageTransmissionRequest,
  now: number = Date.now(),
): boolean {
  if (
    consent.providerId !== request.providerId ||
    consent.model !== request.model ||
    imageConsentExpired(consent, now)
  ) {
    return false;
  }
  if (request.imageCount > consent.maxImages) return false;
  if (request.resolution > consent.maxResolution) return false;
  const approved = new Set(consent.views);
  return request.views.every((view) => approved.has(view));
}

/** Stable error when a run tries to transmit images without consent. */
export function imageConsentRequiredError(): WorkspaceError {
  return new WorkspaceError({
    family: "conflict",
    code: "IMAGE_CONSENT_REQUIRED",
    message:
      "Image transmission requires explicit consent for the provider, model, views, count, resolution, budget, and cost",
  });
}

/** Image consent record store seam (memory implementation for tests). */
export interface ImageConsentStore {
  save(consent: ImageTransmissionConsent): Promise<void>;
  get(providerId: string, model: string): Promise<ImageTransmissionConsent | undefined>;
  delete(providerId: string, model: string): Promise<boolean>;
  list(): Promise<readonly ImageTransmissionConsent[]>;
}

/** Deterministic in-memory image consent store. */
export class MemoryImageConsentStore implements ImageConsentStore {
  readonly #entries = new Map<string, ImageTransmissionConsent>();

  save(consent: ImageTransmissionConsent): Promise<void> {
    this.#entries.set(`${consent.providerId}\u0000${consent.model}`, consent);
    return Promise.resolve();
  }

  get(providerId: string, model: string): Promise<ImageTransmissionConsent | undefined> {
    return Promise.resolve(this.#entries.get(`${providerId}\u0000${model}`));
  }

  delete(providerId: string, model: string): Promise<boolean> {
    return Promise.resolve(this.#entries.delete(`${providerId}\u0000${model}`));
  }

  list(): Promise<readonly ImageTransmissionConsent[]> {
    return Promise.resolve([...this.#entries.values()]);
  }
}

/**
 * One approved visual-refinement session plan (ADR-0010: per-session
 * confirmation naming views, count, resolution, budget, and cost). The
 * plan is validated and frozen; the refinement loop requires that the
 * stored image consent covers it.
 */
export interface VisualRefinementPlan {
  readonly providerId: string;
  readonly model: string;
  readonly views: readonly StandardViewId[];
  readonly resolution: number;
  /** Transmitted image count for one full pass over the views. */
  readonly imageCount: number;
  readonly maxImages: number;
  readonly maxVisualIterations: number;
  readonly estimatedCostUsd: number;
}

export interface VisualRefinementPlanInput {
  readonly providerId: string;
  readonly model: string;
  readonly views?: readonly StandardViewId[];
  /** Square resolution; defaults to `DEFAULT_EVIDENCE_SIZE`. */
  readonly resolution?: number;
  readonly maxImages?: number;
  readonly maxVisualIterations?: number;
  readonly estimatedCostUsd?: number;
}

/** Deterministic cost estimate of one full evidence pass (USD). */
export function estimateImagePassCostUsd(
  model: string,
  views: readonly StandardViewId[],
  resolution: number,
): number {
  const price = priceForModel(model);
  if (price === undefined) return 0;
  const tokens = views.reduce(
    (sum) => sum + estimateImageTokens({ width: resolution, height: resolution }),
    0,
  );
  const usd = (tokens / 1_000_000) * price.inputPerMillionUsd;
  // Micro-dollar precision, matching the ledger rounding.
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Validates and freezes one visual-refinement session plan. */
export function createVisualRefinementPlan(
  input: VisualRefinementPlanInput,
): VisualRefinementPlan {
  const views =
    input.views === undefined ? [...STANDARD_VIEWS] : [...input.views];
  if (views.length === 0 || views.length > MAX_EVIDENCE_IMAGES) {
    throw consentError(
      "INVALID_REFINEMENT_PLAN",
      `A refinement plan needs between 1 and ${String(MAX_EVIDENCE_IMAGES)} views`,
    );
  }
  for (const view of views) {
    if (!STANDARD_VIEWS.includes(view)) {
      throw consentError("INVALID_REFINEMENT_PLAN", `Unknown standard view: ${view}`);
    }
  }
  const resolution = input.resolution ?? 512;
  if (
    !Number.isInteger(resolution) ||
    resolution < 1 ||
    resolution > MAX_EVIDENCE_DIMENSION
  ) {
    throw consentError(
      "INVALID_REFINEMENT_PLAN",
      `Refinement resolution must be an integer in [1, ${String(MAX_EVIDENCE_DIMENSION)}]`,
    );
  }
  const maxImages = input.maxImages ?? MAX_IMAGES_PER_SESSION;
  if (
    !Number.isInteger(maxImages) ||
    maxImages < 1 ||
    maxImages > MAX_IMAGES_PER_SESSION
  ) {
    throw consentError(
      "INVALID_REFINEMENT_PLAN",
      `Refinement maxImages must be an integer in [1, ${String(MAX_IMAGES_PER_SESSION)}]`,
    );
  }
  const maxVisualIterations =
    input.maxVisualIterations ?? MAX_VISUAL_ITERATIONS_PER_SESSION;
  if (
    !Number.isInteger(maxVisualIterations) ||
    maxVisualIterations < 1 ||
    maxVisualIterations > MAX_VISUAL_ITERATIONS_PER_SESSION
  ) {
    throw consentError(
      "INVALID_REFINEMENT_PLAN",
      `Refinement iterations must be an integer in [1, ${String(MAX_VISUAL_ITERATIONS_PER_SESSION)}]`,
    );
  }
  const imageCount = views.length;
  if (imageCount > maxImages) {
    throw consentError(
      "INVALID_REFINEMENT_PLAN",
      "Refinement image count exceeds the plan image budget",
    );
  }
  const estimated =
    input.estimatedCostUsd ??
    estimateImagePassCostUsd(input.model, views, resolution) *
      maxVisualIterations;
  if (!Number.isFinite(estimated) || estimated < 0) {
    throw consentError(
      "INVALID_REFINEMENT_PLAN",
      "Refinement estimated cost must be a non-negative number",
    );
  }
  return Object.freeze({
    providerId: input.providerId,
    model: input.model,
    views: Object.freeze(views),
    resolution,
    imageCount,
    maxImages,
    maxVisualIterations,
    estimatedCostUsd: estimated,
  });
}

/** True when the plan stays inside the consent's approved bounds. */
export function planCoveredByConsent(
  plan: VisualRefinementPlan,
  consent: ImageTransmissionConsent,
  now: number = Date.now(),
): boolean {
  return imageConsentCovers(consent, {
    providerId: plan.providerId,
    model: plan.model,
    views: plan.views,
    imageCount: plan.imageCount,
    resolution: plan.resolution,
  }, now);
}
