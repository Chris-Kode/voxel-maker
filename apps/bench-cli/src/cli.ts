#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cpus, totalmem } from "node:os";
import {
  appendTrendRow,
  compareWithTrends,
  emptyTrendHistory,
  latestSameHardwareRow,
  runBenchmarks,
  type BenchmarkTrendHistory,
  type HardwareInput,
  type RunBenchmarksOptions,
} from "@voxel-maker/benchmarks";
import { parseArgs } from "./args.js";

/**
 * Benchmark CLI (ticket #45): `voxel-maker-bench` runs the headless
 * ADR-0008 benchmark matrix, prints a gate table, writes the JSON
 * report, optionally compares and appends retained trend evidence, and
 * exits non-zero when any gate fails or a retained trend regresses —
 * the CI smoke and scheduled benchmark entry point. Numeric options are
 * strictly validated before the runner is invoked (ticket #57): a
 * malformed, zero, or negative count exits non-zero instead of
 * certifying zero-sample gates.
 */

const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);

function printUsage(): void {
  console.log(`voxel-maker-bench — headless ADR-0008 benchmark harness

Usage:
  voxel-maker-bench [options]

Options:
  --tier <reference|low|ci-smoke|auto>  Gate tier (default auto).
  --sizes <100000,500000,1000000>       Occupied-voxel sizes (positive integers).
  --kinds <compact,sparse,checkerboard> Scene surface classes.
  --samples <n>                         Latency samples per metric (positive integer).
  --save-load-runs <n>                  Save/load repetitions (positive integer).
  --preview-samples <n>                 Preview render samples (positive integer).
  --preview-size <px>                   Preview render size (positive integer).
  --animation-frames <n>                Frames per track count (positive integer).
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
  const argv = process.argv.slice(2);
  if (argv.some((arg) => HELP_FLAGS.has(arg))) {
    printUsage();
    return 0;
  }
  const options = parseArgs(argv);
  const cpu = cpus();
  const hardwareInput: HardwareInput = {
    cpuModel: cpu[0]?.model ?? "unknown",
    cores: cpu.length,
    totalMemoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
  };
  const runOptions: RunBenchmarksOptions = {
    tier: options.tier,
    sizes: options.sizes,
    kinds: options.kinds,
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
    // A gate can fail on completeness (issue #63) or on zero samples
    // (ticket #57): the report says why instead of certifying empty or
    // broken evidence.
    const annotation =
      gate.failureReason ??
      (gate.samples === 0
        ? "zero samples; empty summary is not a measurement"
        : undefined);
    const reason = annotation === undefined ? "" : ` (${annotation})`;
    console.log(
      `[${status}] ${gate.label}: ${formatNumber(gate.measured, gate.unit === "s" ? "s" : gate.unit)} <= ${String(gate.limit)}${gate.unit}${reason}`,
    );
  }
  console.log("");
  console.log(`duration: ${(report.durationMs / 1000).toFixed(1)} s`);

  let exitCode = outcome.gatesPass ? 0 : 1;

  if (options.trends !== undefined) {
    const trendsPath = resolve(options.trends);
    const history = await loadTrends(trendsPath);
    const baseline = latestSameHardwareRow(history, report.hardware);
    if (baseline === undefined && history.rows.length > 0) {
      // No retained row on this named hardware: a different machine
      // class never regresses against unrelated hardware, so the
      // appended row below becomes the fresh baseline.
      const latest = history.rows[history.rows.length - 1];
      console.log("");
      console.log(`latest row: ${latest?.date ?? "none"}`);
      console.log(
        `[skip] no retained baseline on this named hardware (latest ${latest?.hardware.cpuModel ?? "unknown"} -> ${report.hardware.cpuModel}); starting a fresh baseline`,
      );
    }
    const comparisons = compareWithTrends(report, history);
    const regressions = comparisons.filter(
      (comparison) => comparison.regressed,
    );
    if (comparisons.length > 0) {
      console.log("");
      console.log(`trend baseline: ${baseline?.date ?? "none"}`);
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
