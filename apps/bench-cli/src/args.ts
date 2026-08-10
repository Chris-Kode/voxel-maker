/**
 * Strict command-line parsing for the benchmark CLI (ticket #57):
 * every numeric option must parse to a positive safe integer, so a
 * mistyped repetition count fails with a user-safe argument error
 * BEFORE any fixture allocation or output write. A malformed count can
 * never reach the runner and certify zero-sample performance gates.
 */

import {
  BENCHMARK_SCENE_KINDS,
  type BenchmarkSceneKind,
  type TierName,
} from "@voxel-maker/benchmarks";
import { assertDistinctOutputPaths } from "./output-paths.js";

export interface CliOptions {
  tier: TierName | "auto";
  sizes: readonly number[];
  kinds: readonly BenchmarkSceneKind[];
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

/**
 * Parses one strictly positive count. `Number.parseInt` alone accepts
 * "nonsense" (NaN) and "1.5" (1), and NaN passes `<= 0` guards, so the
 * whole numeric surface is validated here as a canonical decimal
 * positive safe integer before the runner is invoked.
 */
function parseCount(flag: string, raw: string): number {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`${flag} must be a positive integer, got: ${raw}`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer, got: ${raw}`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
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
      case "--sizes": {
        const raw = value();
        const parts = raw.split(",");
        if (parts.some((part) => part.trim() === "")) {
          throw new Error(
            `--sizes must be comma-separated positive integers, got: ${raw}`,
          );
        }
        options.sizes = parts.map((part) => parseCount("--sizes", part));
        break;
      }
      case "--kinds":
        options.kinds = value()
          .split(",")
          .map((part) => part.trim())
          .map((part) => {
            if (!(BENCHMARK_SCENE_KINDS as readonly string[]).includes(part)) {
              throw new Error(`unknown scene kind: ${part}`);
            }
            return part as BenchmarkSceneKind;
          });
        break;
      case "--samples":
        options.samples = parseCount("--samples", value());
        break;
      case "--save-load-runs":
        options.saveLoadRuns = parseCount("--save-load-runs", value());
        break;
      case "--preview-samples":
        options.previewSamples = parseCount("--preview-samples", value());
        break;
      case "--preview-size":
        options.previewSize = parseCount("--preview-size", value());
        break;
      case "--animation-frames":
        options.animationFrames = parseCount("--animation-frames", value());
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
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.sizes.length === 0) options.sizes = [100_000, 500_000, 1_000_000];
  if (options.kinds.length === 0) options.kinds = [...BENCHMARK_SCENE_KINDS];
  // Output-path validation (issue #58) also runs at parse time, so the
  // CLI fails before measuring or writing either file.
  assertDistinctOutputPaths(options.json, options.trends);
  return options;
}
