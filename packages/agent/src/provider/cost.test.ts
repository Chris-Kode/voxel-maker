import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_MODEL_PRICE,
  estimateCostUsd,
  priceForModel,
} from "./cost.js";

describe("model pricing", () => {
  it("prices allowlisted OpenAI models", () => {
    expect(priceForModel("gpt-4o-mini")).toBeDefined();
    expect(priceForModel("gpt-4o")).toBeDefined();
  });

  it("returns undefined for unknown models", () => {
    expect(priceForModel("unknown-model")).toBeUndefined();
  });

  it("prices the deterministic suite provider for evaluation cost tracking", () => {
    expect(priceForModel("deterministic-model")).toBe(
      DETERMINISTIC_MODEL_PRICE,
    );
  });

  it("estimates cost deterministically for the eval model", () => {
    // 1M input tokens at $1/M + 1M output tokens at $2/M = $3.00.
    const cost = estimateCostUsd("deterministic-model", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(3);
  });
});
