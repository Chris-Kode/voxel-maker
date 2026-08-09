import type { ProviderUsage } from "./types.js";

/**
 * Deterministic provider pricing (plan S12.2/S12.5, ticket #33): a small
 * per-model rate table the adapters and the budget ledger share. Prices
 * are product policy constants (USD per 1M tokens) so known usage can be
 * reserved before a request and spend stays bounded; unknown models have
 * no price and must rely on an explicit provider-side cap.
 */

export interface ModelPrice {
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
  /** Price of cached input tokens; defaults to 0.25x input when absent. */
  readonly cachedInputPerMillionUsd?: number;
}

/**
 * Allowlisted tool-capable OpenAI models and their list prices
 * (ARCHITECTURE.md: the v1 sole cloud adapter is the OpenAI API with an
 * allowlisted tool-capable model). Unknown models are rejected by the
 * adapter before any request leaves the device.
 */
export const OPENAI_ALLOWED_MODELS = Object.freeze([
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
]);

/** List prices in USD per 1M tokens (published OpenAI pricing). */
export const OPENAI_MODEL_PRICES: Readonly<Record<string, ModelPrice>> =
  Object.freeze({
    "gpt-4o": Object.freeze({
      inputPerMillionUsd: 2.5,
      outputPerMillionUsd: 10,
    }),
    "gpt-4o-mini": Object.freeze({
      inputPerMillionUsd: 0.15,
      outputPerMillionUsd: 0.6,
    }),
    "gpt-4.1": Object.freeze({
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 8,
    }),
    "gpt-4.1-mini": Object.freeze({
      inputPerMillionUsd: 0.4,
      outputPerMillionUsd: 1.6,
    }),
    "gpt-4.1-nano": Object.freeze({
      inputPerMillionUsd: 0.1,
      outputPerMillionUsd: 0.4,
    }),
  });

/** Price table lookup; undefined for unknown models. */
export function priceForModel(model: string): ModelPrice | undefined {
  return OPENAI_MODEL_PRICES[model];
}

/**
 * Deterministic cost estimate of one usage record, or undefined when the
 * model has no price. Rounds to 6 decimal places (USD micro-dollars).
 */
export function estimateCostUsd(
  model: string,
  usage: ProviderUsage,
): number | undefined {
  const price = priceForModel(model);
  if (price === undefined) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const cachedPrice =
    price.cachedInputPerMillionUsd ?? price.inputPerMillionUsd * 0.25;
  const inputUsd =
    (Math.max(0, usage.inputTokens - cached) / 1_000_000) *
    price.inputPerMillionUsd;
  const cachedUsd = (cached / 1_000_000) * cachedPrice;
  const outputUsd =
    (usage.outputTokens / 1_000_000) * price.outputPerMillionUsd;
  return Math.round((inputUsd + cachedUsd + outputUsd) * 1_000_000) / 1_000_000;
}

/**
 * Worst-case reservation for one request: all input tokens plus the full
 * output cap, so the ledger can reject a request before it is sent when
 * the remaining cost budget cannot cover it (ADR-0009).
 */
export function estimateReservedCostUsd(
  model: string,
  inputTokens: number,
  maxOutputTokens: number,
): number | undefined {
  return estimateCostUsd(model, {
    inputTokens,
    outputTokens: maxOutputTokens,
  });
}
