#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cpus, totalmem } from "node:os";
import {
  appendTrendRow,
  compareWithTrends,
  emptyTrendHistory,
  runBenchmarks,
  type BenchmarkSceneKind,
  type BenchmarkTrendHistory,
  type HardwareInput,
  type RunBenchmarksOptions,
  type TierName,
} from "@voxel-maker/benchmarks";

/**
 * Benchmark CLI (ticket #45): `voxel-maker-bench` runs the headless
 * ADR-0008 benchmark matrix, prints a gate table, writes the JSON
 * report, optionally compares and appends retained trend evidence, and
 * exits non-zero when any gate fails or a retained trend regresses —
 * the CI smoke and scheduled benchmark entry point.
 */

interface CliOptions {
  tier: TierName | "auto";
  sizes: readonly number[];
  kinds: readonly string[];
  samples: number;
  saveLoadRuns: number;
  previewSamples: number;
  previewSize: number;
  animationFrames: number;
  full: boolean;
  json: string | undefined;
  trends: string | undefined;
  noProgress: boolean;
}

const KIND_NAMES = ["compact", "sparse", "checkerboard"] as const;

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    tier: "auto",
    sizes: [],
    kinds: [],
    samples: 100,
    saveLoadRuns: 5,
    previewSamples: 10,
    previewSize: 256,
    animationFrames: 60,
    full: false,
    json: undefined,
    trends: undefined,
    noProgress: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--tier":
        options.tier = value() as TierName | "auto";
        if (!["reference", "low", "ci-smoke", "auto"].includes(options.tier)) {
          throw new Error(`unknown tier: ${options.tier as string}`);
        }
        break;
      case "--sizes":
        options.sizes = value()
          .split(",")
          .map((part) => Number.parseInt(part, 10))
          .filter((size) => Number.isFinite(size) && size > 0);
        break;
      case "--kinds":
        options.kinds = value()
          .split(",")
          .map((part) => part.trim());
        for (const kind of options.kinds) {
          if (!(KIND_NAMES as readonly string[]).includes(kind)) {
            throw new Error(`unknown scene kind: ${kind}`);
          }
        }
        break;
      case "--samples":
        options.samples = Number.parseInt(value(), 10);
        break;
      case "--save-load-runs":
        options.saveLoadRuns = Number.parseInt(value(), 10);
        break;
      case "--preview-samples":
        options.previewSamples = Number.parseInt(value(), 10);
        break;
      case "--preview-size":
        options.previewSize = Number.parseInt(value(), 10);
        break;
      case "--animation-frames":
        options.animationFrames = Number.parseInt(value(), 10);
        break;
      case "--full":
        options.full = true;
        break;
      case "--json":
        options.json = value();
        break;
      case "--trends":
        options.trends = value();
        break;
      case "--no-progress":
        options.noProgress = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.sizes.length === 0) options.sizes = [100_000, 500_000, 1_000_000];
  if (options.kinds.length === 0) options.kinds = [...KIND_NAMES];
  if (options.samples <= 0) throw new Error("--samples must be positive");
  return options;
}

function printUsage(): void {
  console.log(`voxel-maker-bench — headless ADR-0008 benchmark harness

Usage:
  voxel-maker-bench [options]

Options:
  --tier <reference|low|ci-smoke|auto>  Gate tier (default auto).
  --sizes <100000,500000,1000000>       Occupied-voxel sizes.
  --kinds <compact,sparse,checkerboard> Scene surface classes.
  --samples <n>                         Latency samples per metric.
  --save-load-runs <n>                  Save/load repetitions.
  --preview-samples <n>                 Preview render samples.
  --preview-size <px>                   Preview render size.
  --animation-frames <n>                Frames per track count.
  --full                                Full matrix (incl. export at 1M).
  --json <path>                         Write the JSON report.
  --trends <path>                       Compare + append retained trends.
  --no-progress                         Suppress progress output.
  --help                                Show this help.`);
}

function formatNumber(value: number | undefined, unit: string): string {
  if (value === undefined) return "n/a";
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)}${unit}`;
}

/** Loads a trend history file, tolerating a missing or fresh file. */
async function loadTrends(path: string): Promise<BenchmarkTrendHistory> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion?: unknown;
      rows?: unknown;
    };
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.rows)) {
      throw new Error(`unsupported trend schema in ${path}`);
    }
    const history = parsed as BenchmarkTrendHistory;
    return history;
  } catch (error) {
    const cause = error as { code?: string };
    if (cause.code === "ENOENT") return emptyTrendHistory();
    throw error;
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const cpu = cpus();
  const hardwareInput: HardwareInput = {
    cpuModel: cpu[0]?.model ?? "unknown",
    cores: cpu.length,
    totalMemoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
  };
  const runOptions: RunBenchmarksOptions = {
    tier: options.tier,
    sizes: options.sizes,
    kinds: options.kinds as BenchmarkSceneKind[],
    samples: options.samples,
    saveLoadRuns: options.saveLoadRuns,
    previewSamples: options.previewSamples,
    previewSize: options.previewSize,
    animationFrames: options.animationFrames,
    full: options.full,
    hardwareInput,
    ...(options.noProgress
      ? {}
      : {
          onProgress: (message: string) => {
            console.log(message);
          },
        }),
  };
  const outcome = await runBenchmarks(runOptions);
  const { report } = outcome;

  console.log("");
  console.log(
    `hardware: ${report.hardware.cpuModel} (${report.hardware.platform}/${report.hardware.arch}, ${String(report.hardware.cores)} cores, ${String(report.hardware.totalMemoryGiB)} GiB)`,
  );
  console.log(`tier: ${report.hardware.tier}`);
  console.log("");
  for (const gate of outcome.gates) {
    const status = gate.skipped ? "skip" : gate.pass ? "pass" : "FAIL";
    console.log(
      `[${status}] ${gate.label}: ${formatNumber(gate.measured, gate.unit === "s" ? "s" : gate.unit)} <= ${String(gate.limit)}${gate.unit}`,
    );
  }
  console.log("");
  console.log(`duration: ${(report.durationMs / 1000).toFixed(1)} s`);

  let exitCode = outcome.gatesPass ? 0 : 1;

  if (options.trends !== undefined) {
    const trendsPath = resolve(options.trends);
    const history = await loadTrends(trendsPath);
    const comparisons = compareWithTrends(report, history);
    const regressions = comparisons.filter(
      (comparison) => comparison.regressed,
    );
    if (comparisons.length > 0) {
      console.log("");
      console.log(
        `trend baseline: ${history.rows[history.rows.length - 1]?.date ?? "none"}`,
      );
      for (const comparison of comparisons) {
        const flag = comparison.regressed ? " REGRESSED" : "";
        const unit = comparison.key.endsWith("rssMiB") ? "MiB" : "ms";
        console.log(
          `[${comparison.regressed ? "FAIL" : "ok"}] ${comparison.key}: ${formatNumber(comparison.previous, unit)} -> ${formatNumber(comparison.current, unit)} (${(comparison.deltaPct * 100).toFixed(1)}%)${flag}`,
        );
      }
      if (regressions.length > 0) exitCode = 1;
    }
    const updated = appendTrendRow(history, report);
    await mkdir(dirname(trendsPath), { recursive: true });
    await writeFile(trendsPath, `${JSON.stringify(updated, null, 2)}\n`);
    console.log(`trends appended to ${trendsPath}`);
  }

  if (options.json !== undefined) {
    const jsonPath = resolve(options.json);
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report written to ${jsonPath}`);
  }

  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
