import { describe, expect, it } from "vitest";
import {
  detectHardware,
  evaluateGates,
  resolveTier,
  summarizeGates,
} from "./gates.js";
import type { BenchmarkReport } from "./report.js";
import { createBenchmarkFixture } from "./fixtures.js";
import { runBenchmarks } from "./run.js";

/** Minimal report with one scene, for gate unit tests. */
function sceneReport(overrides: {
  readonly commandP95?: number;
  readonly remeshP95?: number;
  readonly flushP95?: number;
  readonly inputToPreview95Ms?: number;
  readonly saveP95Ms?: number;
  readonly loadP95Ms?: number;
  readonly rssMiB?: number;
}): BenchmarkReport {
  const scene = {
    buildMs: 1,
    command: {
      samples: 100,
      mean: 1,
      min: 1,
      max: 1,
      p50: 1,
      p90: 1,
      p95: overrides.commandP95 ?? 1,
      p99: 1,
    },
    remesh: {
      samples: 100,
      mean: 1,
      min: 1,
      max: 1,
      p50: 1,
      p90: 1,
      p95: overrides.remeshP95 ?? 1,
      p99: 1,
    },
    queueWait: {
      samples: 100,
      mean: 1,
      min: 1,
      max: 1,
      p50: 1,
      p90: 1,
      p95: 1,
      p99: 1,
    },
    flush: {
      samples: 100,
      mean: 1,
      min: 1,
      max: 1,
      p50: 1,
      p90: 1,
      p95: overrides.flushP95 ?? 1,
      p99: 1,
    },
    meshSettleMs: 1,
    meshing: {
      dispatchedTotal: 1,
      installedTotal: 1,
      pendingChunks: 0,
      inFlightMeshes: 0,
      completedQueue: 0,
      uploadsThisFrame: 1,
      staleDropped: 0,
      cancelled: 0,
      failed: 0,
      installedTriangles: 1,
      installedDrawCalls: 1,
      installedMeshBytes: 1,
    },
    save: {
      summary: {
        samples: 5,
        mean: 1,
        min: 1,
        max: 1,
        p50: 1,
        p90: 1,
        p95: overrides.saveP95Ms ?? 1000,
        p99: 1,
      },
      bytes: 1,
      peakRssMiB: 0,
      blocked: undefined,
    },
    load: {
      summary: {
        samples: 5,
        mean: 1,
        min: 1,
        max: 1,
        p50: 1,
        p90: 1,
        p95: overrides.loadP95Ms ?? 1000,
        p99: 1,
      },
      bytes: 1,
      peakRssMiB: 0,
      blocked: undefined,
    },
    export: {
      summary: {
        samples: 2,
        mean: 1,
        min: 1,
        max: 1,
        p50: 1,
        p90: 1,
        p95: 1000,
        p99: 1,
      },
      bytes: 1,
      peakRssMiB: 0,
      blocked: undefined,
    },
    preview: {
      samples: 10,
      mean: 1,
      min: 1,
      max: 1,
      p50: 1,
      p90: 1,
      p95: 1,
      p99: 1,
    },
    inputToPreview95Ms: overrides.inputToPreview95Ms ?? 10,
    memory: {
      rssMiB: overrides.rssMiB ?? 100,
      heapUsedMiB: 50,
      heapTotalMiB: 80,
      arrayBuffersMiB: 5,
    },
  };
  return {
    schemaVersion: 1,
    benchmarkVersion: "test",
    date: "2025-01-01T00:00:00.000Z",
    hardware: {
      tier: "reference",
      cpuModel: "Apple M1",
      platform: "darwin",
      arch: "arm64",
      cores: 8,
      totalMemoryGiB: 16,
      nodeVersion: "v22",
    },
    options: {
      sizes: [100_000],
      kinds: ["compact"],
      samples: 100,
      saveLoadRuns: 5,
      full: false,
    },
    scenes: { compact: { "100000": scene }, sparse: {}, checkerboard: {} },
    animation: [
      {
        trackCount: 10_000,
        frames: 60,
        frameMs: {
          samples: 60,
          mean: 5,
          min: 4,
          max: 8,
          p50: 5,
          p90: 7,
          p95: 8,
          p99: 8,
        },
        revisionBefore: 0,
        revisionAfter: 0,
        historyBefore: 0,
        historyAfter: 0,
        semanticHashBefore: "a",
        semanticHashAfter: "a",
      },
    ],
    durationMs: 1000,
  };
}

describe("resolveTier", () => {
  it("explicit tier wins over hardware naming", () => {
    expect(resolveTier("low", "Apple M1")).toBe("low");
    expect(resolveTier("ci-smoke", "Apple M1")).toBe("ci-smoke");
  });

  it("names the ADR-0008 reference and low hardware", () => {
    expect(resolveTier("auto", "Apple M1")).toBe("reference");
    expect(resolveTier("auto", "Intel(R) Core(TM) i5-8250U CPU")).toBe("low");
  });

  it("classifies unknown hardware as the CI smoke tier", () => {
    expect(resolveTier("auto", "Intel(R) Xeon(R) Platinum 8370C")).toBe(
      "ci-smoke",
    );
  });
});

describe("detectHardware", () => {
  it("records the injected machine facts with the requested tier", () => {
    const hardware = detectHardware("ci-smoke", {
      cpuModel: "Apple M1",
      cores: 8,
      totalMemoryGiB: 16,
    });
    expect(hardware.tier).toBe("ci-smoke");
    expect(hardware.cpuModel).toBe("Apple M1");
    expect(hardware.cores).toBe(8);
    expect(hardware.totalMemoryGiB).toBe(16);
    expect(hardware.platform.length).toBeGreaterThan(0);
    expect(hardware.nodeVersion.startsWith("v")).toBe(true);
  });

  it("falls back to Node globals and unknown hardware", () => {
    const hardware = detectHardware("ci-smoke");
    expect(hardware.cpuModel).toBe("unknown");
    expect(hardware.totalMemoryGiB).toBe(0);
    expect(hardware.platform.length).toBeGreaterThan(0);
  });
});

describe("evaluateGates", () => {
  it("reference gates pass within the ADR-0008 budgets", () => {
    const report = sceneReport({
      commandP95: 7,
      remeshP95: 29,
      flushP95: 16,
      saveP95Ms: 1900,
      loadP95Ms: 1900,
      inputToPreview95Ms: 49,
      rssMiB: 1500,
    });
    const results = evaluateGates(report, "reference");
    const failed = results.filter((result) => !result.pass && !result.skipped);
    expect(failed).toEqual([]);
    expect(summarizeGates("reference", results).allPass).toBe(true);
  });

  it("reference gates fail when a budget is exceeded", () => {
    const report = sceneReport({
      commandP95: 20,
      remeshP95: 100,
      flushP95: 50,
      saveP95Ms: 3000,
      loadP95Ms: 3000,
      inputToPreview95Ms: 200,
      rssMiB: 3000,
    });
    const results = evaluateGates(report, "reference");
    const failed = results.filter((result) => !result.pass && !result.skipped);
    expect(failed.length).toBeGreaterThan(0);
    const ids = new Set(failed.map((result) => result.id));
    expect(ids.has("commit.p95.100k.compact")).toBe(true);
    expect(ids.has("remesh.p95.100k.compact")).toBe(true);
    expect(ids.has("flush.p95.100k.compact")).toBe(true);
    expect(ids.has("inputToPreview.p95.100k.compact")).toBe(true);
    expect(ids.has("save.p95.100k")).toBe(true);
    expect(ids.has("load.p95.100k")).toBe(true);
    expect(ids.has("memory.peak.1m")).toBe(true);
  });

  it("skips gates whose measurement is absent", () => {
    const report = sceneReport({});
    const results = evaluateGates(report, "reference");
    expect(results.some((result) => result.skipped)).toBe(true);
    expect(results.every((result) => result.pass)).toBe(true);
  });

  it("ci-smoke gates flag gross regressions and meshing failures", () => {
    const report = sceneReport({ commandP95: 500, rssMiB: 7000 });
    const results = evaluateGates(report, "ci-smoke");
    const failed = results.filter((result) => !result.pass && !result.skipped);
    expect(failed.some((result) => result.id === "commit.p95.100k.smoke")).toBe(
      true,
    );
    expect(failed.some((result) => result.id === "memory.peak.smoke")).toBe(
      true,
    );
  });

  it("animation mutation detection fails the no-mutation gate", () => {
    const report = sceneReport({});
    const mutated = {
      ...report,
      animation: report.animation.map((row) => ({
        ...row,
        revisionAfter: 1,
        semanticHashAfter: "b",
      })),
    };
    const results = evaluateGates(mutated, "ci-smoke");
    const gate = results.find(
      (result) => result.id === "animation.noMutation.smoke",
    );
    expect(gate?.pass).toBe(false);
  });
});

describe("runBenchmarks smoke path", () => {
  it("produces a report with gate results on the 100k compact fixture", async () => {
    const fixture = createBenchmarkFixture("compact", 100_000);
    expect(fixture.occupiedCount).toBe(100_000);
    const outcome = await runBenchmarks({
      tier: "ci-smoke",
      sizes: [100_000],
      kinds: ["compact"],
      samples: 5,
      saveLoadRuns: 1,
      previewSamples: 1,
      previewSize: 64,
      animationFrames: 3,
    });
    expect(outcome.report.hardware.tier).toBe("ci-smoke");
    expect(outcome.gates.length).toBeGreaterThan(0);
    // The smoke tier must pass on any reasonably fast machine.
    expect(outcome.gatesPass).toBe(true);
  }, 120_000);
});
