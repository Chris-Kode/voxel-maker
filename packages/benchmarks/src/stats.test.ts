import { describe, expect, it } from "vitest";
import { percentile, summarize } from "./stats.js";

describe("percentile", () => {
  it("returns 0 for an empty sample set", () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it("returns the only sample for a single value", () => {
    expect(percentile([7], 0.95)).toBe(7);
  });

  it("uses nearest-rank interpolation for interior percentiles", () => {
    // p50 of 1..10 is 5.5 with linear interpolation between ranks 4 and 5.
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(samples, 0.5)).toBeCloseTo(5.5, 6);
    // p95 of 1..100 lands between 94 and 95 (rank 94.05).
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    const p95 = percentile(hundred, 0.95);
    expect(p95).toBeGreaterThanOrEqual(95);
    expect(p95).toBeLessThan(96);
  });

  it("is deterministic regardless of input order", () => {
    const a = percentile([3, 1, 2, 9, 8, 7], 0.5);
    const b = percentile([7, 8, 9, 2, 1, 3], 0.5);
    expect(a).toBe(b);
  });
});

describe("summarize", () => {
  it("summarizes an empty set with zeros", () => {
    const summary = summarize([]);
    expect(summary.samples).toBe(0);
    expect(summary.mean).toBe(0);
    expect(summary.p95).toBe(0);
  });

  it("reports mean and extreme values", () => {
    const summary = summarize([1, 2, 3, 4]);
    expect(summary.mean).toBeCloseTo(2.5, 6);
    expect(summary.min).toBe(1);
    expect(summary.max).toBe(4);
    expect(summary.samples).toBe(4);
  });

  it("p95 interpolates toward the largest value when samples are few", () => {
    const summary = summarize([1, 2, 3]);
    // rank 0.95 * 2 = 1.9 -> 2.9 (interpolated nearest-rank).
    expect(summary.p95).toBeCloseTo(2.9, 6);
    expect(summary.max).toBe(3);
  });
});
