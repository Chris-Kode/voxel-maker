import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs numeric validation (ticket #57)", () => {
  it("applies the documented positive defaults", () => {
    const options = parseArgs([]);
    expect(options.samples).toBe(100);
    expect(options.saveLoadRuns).toBe(5);
    expect(options.previewSamples).toBe(10);
    expect(options.previewSize).toBe(256);
    expect(options.animationFrames).toBe(100);
    expect(options.sizes).toEqual([100_000, 500_000, 1_000_000]);
    expect(options.kinds).toEqual(["compact", "sparse", "checkerboard"]);
    expect(options.tier).toBe("auto");
    expect(options.full).toBe(false);
  });

  it("parses explicit positive integer counts", () => {
    const options = parseArgs([
      "--sizes",
      "100000,500000",
      "--kinds",
      "compact,sparse",
      "--samples",
      "50",
      "--save-load-runs",
      "3",
      "--preview-samples",
      "4",
      "--preview-size",
      "128",
      "--animation-frames",
      "30",
      "--full",
      "--json",
      "out.json",
      "--trends",
      "trends.json",
      "--no-progress",
    ]);
    expect(options.sizes).toEqual([100_000, 500_000]);
    expect(options.kinds).toEqual(["compact", "sparse"]);
    expect(options.samples).toBe(50);
    expect(options.saveLoadRuns).toBe(3);
    expect(options.previewSamples).toBe(4);
    expect(options.previewSize).toBe(128);
    expect(options.animationFrames).toBe(30);
    expect(options.full).toBe(true);
    expect(options.json).toBe("out.json");
    expect(options.trends).toBe("trends.json");
    expect(options.noProgress).toBe(true);
  });

  it.each([
    ["--samples", "nonsense"],
    ["--samples", "0"],
    ["--samples", "-5"],
    ["--samples", "1.5"],
    ["--samples", "10abc"],
    ["--samples", ""],
    ["--save-load-runs", "nonsense"],
    ["--save-load-runs", "0"],
    ["--save-load-runs", "-1"],
    ["--preview-samples", "nonsense"],
    ["--preview-samples", "0"],
    ["--preview-size", "nonsense"],
    ["--preview-size", "0"],
    ["--preview-size", "-1"],
    ["--animation-frames", "nonsense"],
    ["--animation-frames", "0"],
    ["--animation-frames", "-60"],
  ])("rejects malformed, zero, or negative %s %s", (flag, value) => {
    expect(() => parseArgs([flag, value])).toThrow(/positive integer/);
  });

  it("rejects counts that exceed the safe-integer range", () => {
    expect(() => parseArgs(["--samples", "99999999999999999999"])).toThrow(
      /positive integer/,
    );
  });

  it("rejects a malformed --sizes entry instead of silently dropping it", () => {
    expect(() => parseArgs(["--sizes", "100000,bogus"])).toThrow(
      /positive integer/,
    );
    expect(() => parseArgs(["--sizes", "100000,"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--sizes", ""])).toThrow(/positive integer/);
    expect(() => parseArgs(["--sizes", "0"])).toThrow(/positive integer/);
  });

  it("still validates scene kinds and tiers", () => {
    expect(() => parseArgs(["--kinds", "bogus"])).toThrow(/unknown scene kind/);
    expect(() => parseArgs(["--tier", "bogus"])).toThrow(/unknown tier/);
  });
});
