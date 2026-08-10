import { describe, expect, it } from "vitest";
import {
  appendTrendRow,
  compareWithTrends,
  DEFAULT_TREND_TOLERANCE,
  emptyTrendHistory,
  flattenReport,
  isTrendRegression,
  sameNamedHardware,
  type BenchmarkTrendHistory,
} from "./trends.js";
import type { BenchmarkReport, HardwareInfo } from "./report.js";
import type { SceneMeasurements } from "./report.js";

const hardware: HardwareInfo = {
  tier: "ci-smoke",
  cpuModel: "Test CPU",
  platform: "test",
  arch: "x64",
  cores: 4,
  totalMemoryGiB: 8,
  nodeVersion: "v22",
};

const report: BenchmarkReport = {
  schemaVersion: 1,
  benchmarkVersion: "test",
  date: "2025-02-01T00:00:00.000Z",
  hardware,
  options: {
    sizes: [100_000],
    kinds: ["compact"],
    samples: 10,
    saveLoadRuns: 2,
    full: false,
  },
  scenes: {
    compact: {
      "100000": {
        buildMs: 1,
        command: {
          samples: 10,
          mean: 2,
          min: 1,
          max: 4,
          p50: 2,
          p90: 3,
          p95: 4,
          p99: 4,
        },
        remesh: {
          samples: 10,
          mean: 5,
          min: 3,
          max: 9,
          p50: 5,
          p90: 8,
          p95: 9,
          p99: 9,
        },
        queueWait: {
          samples: 10,
          mean: 6,
          min: 4,
          max: 10,
          p50: 6,
          p90: 9,
          p95: 10,
          p99: 10,
        },
        flush: {
          samples: 10,
          mean: 1,
          min: 1,
          max: 2,
          p50: 1,
          p90: 2,
          p95: 2,
          p99: 2,
        },
        meshSettleMs: 50,
        meshing: {
          dispatchedTotal: 10,
          installedTotal: 10,
          pendingChunks: 0,
          inFlightMeshes: 0,
          completedQueue: 0,
          uploadsThisFrame: 4,
          staleDropped: 0,
          cancelled: 0,
          failed: 0,
          installedTriangles: 100,
          installedDrawCalls: 10,
          installedMeshBytes: 1000,
        },
        save: {
          summary: {
            samples: 2,
            mean: 10,
            min: 9,
            max: 11,
            p50: 10,
            p90: 11,
            p95: 11,
            p99: 11,
          },
          bytes: 100,
          peakRssMiB: 0,
          blocked: undefined,
        },
        load: {
          summary: {
            samples: 2,
            mean: 10,
            min: 9,
            max: 11,
            p50: 10,
            p90: 11,
            p95: 11,
            p99: 11,
          },
          bytes: 100,
          peakRssMiB: 0,
          blocked: undefined,
        },
        export: {
          summary: {
            samples: 2,
            mean: 100,
            min: 90,
            max: 110,
            p50: 100,
            p90: 110,
            p95: 110,
            p99: 110,
          },
          bytes: 1000,
          peakRssMiB: 10,
          blocked: undefined,
        },
        preview: {
          samples: 2,
          mean: 3,
          min: 2,
          max: 4,
          p50: 3,
          p90: 4,
          p95: 4,
          p99: 4,
        },
        inputToPreview95Ms: 15,
        memory: {
          rssMiB: 100,
          heapUsedMiB: 50,
          heapTotalMiB: 80,
          arrayBuffersMiB: 5,
        },
      },
    },
    sparse: {},
    checkerboard: {},
  },
  animation: [
    {
      trackCount: 10_000,
      frames: 10,
      frameMs: {
        samples: 10,
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

describe("flattenReport", () => {
  it("produces stable keys for every trend metric", () => {
    const values = flattenReport(report);
    expect(values["compact.100000.command.p95"]).toBe(4);
    expect(values["compact.100000.remesh.p95"]).toBe(9);
    expect(values["compact.100000.flush.p95"]).toBe(2);
    expect(values["compact.100000.save.p95"]).toBe(11);
    expect(values["compact.100000.load.p95"]).toBe(11);
    expect(values["compact.100000.export.p95"]).toBe(110);
    expect(values["compact.100000.memory.rssMiB"]).toBe(100);
    expect(values["animation.10000.frameMs.p95"]).toBe(8);
  });
});

describe("isTrendRegression", () => {
  it("tolerates small absolute growth", () => {
    // delta 1ms is inside the 2ms absolute floor.
    expect(isTrendRegression(10, 11, DEFAULT_TREND_TOLERANCE)).toBe(false);
    // delta 2.5ms is 25% relative growth: beyond the 20% tolerance.
    expect(isTrendRegression(10, 12.5, DEFAULT_TREND_TOLERANCE)).toBe(true);
    expect(isTrendRegression(10, 13, DEFAULT_TREND_TOLERANCE)).toBe(true);
  });

  it("treats growth beyond the relative tolerance as a regression", () => {
    expect(isTrendRegression(100, 119, DEFAULT_TREND_TOLERANCE)).toBe(false);
    expect(isTrendRegression(100, 121, DEFAULT_TREND_TOLERANCE)).toBe(true);
  });

  it("never flags an improvement", () => {
    expect(isTrendRegression(100, 80, DEFAULT_TREND_TOLERANCE)).toBe(false);
  });
});

describe("compareWithTrends / appendTrendRow", () => {
  it("appends one row per report and compares the latest baseline", () => {
    const history = appendTrendRow(emptyTrendHistory(), report);
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]?.hardware.cpuModel).toBe("Test CPU");

    const slow: BenchmarkReport = {
      ...report,
      date: "2025-03-01T00:00:00.000Z",
      scenes: {
        ...report.scenes,
        compact: {
          ...report.scenes.compact,
          "100000": {
            ...(report.scenes.compact["100000"] as SceneMeasurements),
            command: {
              ...(report.scenes.compact["100000"] as SceneMeasurements).command,
              p95: 4,
            },
          },
        },
      },
    };
    const comparisons = compareWithTrends(slow, history);
    expect(comparisons.length).toBeGreaterThan(0);
    const commit = comparisons.find(
      (c) => c.key === "compact.100000.command.p95",
    );
    expect(commit?.previous).toBe(4);
    expect(commit?.current).toBe(4);
    expect(commit?.regressed).toBe(false);
  });

  it("detects a retained trend regression", () => {
    const history = appendTrendRow(emptyTrendHistory(), report);
    const slower: BenchmarkReport = {
      ...report,
      date: "2025-03-01T00:00:00.000Z",
      scenes: {
        ...report.scenes,
        compact: {
          ...report.scenes.compact,
          "100000": {
            ...(report.scenes.compact["100000"] as SceneMeasurements),
            command: {
              ...(report.scenes.compact["100000"] as SceneMeasurements).command,
              p95: 40,
            },
          },
        },
      },
    };
    const comparisons = compareWithTrends(slower, history);
    const commit = comparisons.find(
      (c) => c.key === "compact.100000.command.p95",
    );
    expect(commit?.regressed).toBe(true);
  });

  it("starts a fresh baseline across different named hardware in the same tier", () => {
    // GitHub-hosted ci-smoke runners rotate CPU generations (e.g.
    // EPYC 7763 -> EPYC 9V74); tier alone must never trigger a
    // regression comparison against unrelated hardware.
    const history = appendTrendRow(emptyTrendHistory(), report);
    const otherCpu: BenchmarkReport = {
      ...report,
      date: "2025-03-01T00:00:00.000Z",
      hardware: { ...hardware, cpuModel: "AMD EPYC 9V74 80-Core Processor" },
      scenes: {
        ...report.scenes,
        compact: {
          ...report.scenes.compact,
          "100000": {
            ...(report.scenes.compact["100000"] as SceneMeasurements),
            command: {
              ...(report.scenes.compact["100000"] as SceneMeasurements).command,
              p95: 40,
            },
          },
        },
      },
    };
    expect(sameNamedHardware(report.hardware, otherCpu.hardware)).toBe(false);
    expect(compareWithTrends(otherCpu, history)).toEqual([]);
  });

  it("compares when every named-hardware field matches", () => {
    expect(sameNamedHardware(report.hardware, { ...hardware })).toBe(true);
    expect(sameNamedHardware(report.hardware, { ...hardware, cores: 8 })).toBe(
      false,
    );
  });

  it("compares only against the latest row", () => {
    const history: BenchmarkTrendHistory = {
      schemaVersion: 1,
      rows: [
        { date: "old", hardware, values: { "compact.100000.command.p95": 4 } },
        {
          date: "latest",
          hardware,
          values: { "compact.100000.command.p95": 5 },
        },
      ],
    };
    const comparisons = compareWithTrends(report, history);
    const commit = comparisons.find(
      (c) => c.key === "compact.100000.command.p95",
    );
    expect(commit?.previous).toBe(5);
  });
});
