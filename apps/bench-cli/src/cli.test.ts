import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INCOMPLETE_BENCHMARK_MATRIX } from "@voxel-maker/benchmarks";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Minimal benchmark matrix so a regression here is fast, never a gate claim. */
const MINIMAL_ARGS = [
  "--tier",
  "ci-smoke",
  "--sizes",
  "10000",
  "--kinds",
  "compact",
  "--samples",
  "1",
  "--save-load-runs",
  "1",
  "--preview-samples",
  "1",
  "--preview-size",
  "1",
  "--animation-frames",
  "1",
  "--no-progress",
] as const;

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: readonly string[], cwd: string): CliRun {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("bench CLI output-path validation (issue #58)", () => {
  it("rejects identical --json/--trends targets before measurement and preserves retained trends", () => {
    const dir = mkdtempSync(join(tmpdir(), "voxel-maker-bench-issue-58-"));
    try {
      const target = join(dir, "trends.json");
      const retained = '{\n  "schemaVersion": 1,\n  "rows": []\n}\n';
      writeFileSync(target, retained, "utf8");
      const bytesBefore = readFileSync(target);

      const result = runCli(
        [...MINIMAL_ARGS, "--json", target, "--trends", target],
        dir,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "--json and --trends resolve to the same file",
      );
      expect(result.stderr).toContain(target);
      // The conflict must be rejected during argument validation: no
      // benchmark output and no write of either file.
      expect(result.stdout).not.toContain("hardware:");
      expect(result.stdout).not.toContain("duration:");
      expect(result.stdout).not.toContain("trends appended");
      expect(result.stdout).not.toContain("report written");
      expect(readFileSync(target)).toEqual(bytesBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects aliased spellings of one target and leaves the trend file untouched", () => {
    const dir = mkdtempSync(
      join(tmpdir(), "voxel-maker-bench-issue-58-alias-"),
    );
    try {
      const target = join(dir, "trends.json");
      const retained = '{\n  "schemaVersion": 1,\n  "rows": []\n}\n';
      writeFileSync(target, retained, "utf8");
      const bytesBefore = readFileSync(target);

      // "trends.json" and "./trends.json" are the same resolved file.
      const result = runCli(
        [...MINIMAL_ARGS, "--json", "trends.json", "--trends", "./trends.json"],
        dir,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "--json and --trends resolve to the same file",
      );
      expect(readFileSync(target)).toEqual(bytesBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bench CLI numeric option validation (ticket #57)", () => {
  it.each([
    ["--samples", "nonsense"],
    ["--samples", "1.5"],
    ["--samples", "0"],
    ["--samples", "-3"],
    ["--save-load-runs", "nonsense"],
    ["--save-load-runs", "0"],
    ["--preview-samples", "nonsense"],
    ["--preview-samples", "0"],
    ["--preview-size", "nonsense"],
    ["--preview-size", "0"],
    ["--animation-frames", "nonsense"],
    ["--animation-frames", "0"],
    ["--sizes", "100000,bogus"],
  ] as const)(
    "rejects %s %s with a nonzero exit before fixture allocation or output",
    (flag, value) => {
      const dir = mkdtempSync(join(tmpdir(), "bench-cli-reject-"));
      const jsonPath = join(dir, "out.json");
      const result = runCli(
        [...MINIMAL_ARGS, flag, value, "--json", jsonPath],
        dir,
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("report written");
      expect(result.stderr).toContain("positive integer");
      expect(existsSync(jsonPath)).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    },
  );

  it("starts a fresh baseline when no retained row matches the named hardware (issue #64)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-cli-issue-64-"));
    try {
      const trendsPath = join(dir, "trends.json");
      // A fake CPU model can never match the runner's named hardware,
      // so the CLI must skip comparison and start a fresh baseline.
      const retained = JSON.stringify({
        schemaVersion: 1,
        rows: [
          {
            date: "2025-01-01T00:00:00.000Z",
            hardware: {
              tier: "ci-smoke",
              cpuModel: "Issue-64 Fake CPU",
              platform: "linux",
              arch: "x64",
              cores: 2,
              totalMemoryGiB: 7,
              nodeVersion: "v22",
            },
            values: { "compact.10000.command.p95": 4 },
          },
        ],
      });
      writeFileSync(trendsPath, retained, "utf8");

      const result = runCli([...MINIMAL_ARGS, "--trends", trendsPath], dir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "[skip] no retained baseline on this named hardware",
      );
      expect(result.stdout).toContain("trends appended");
      const appended = JSON.parse(readFileSync(trendsPath, "utf8")) as {
        readonly rows: readonly unknown[];
      };
      expect(appended.rows).toHaveLength(2);
      // The fresh baseline row passed its gates, so it is marked as a
      // baseline candidate (issue #73).
      expect((appended.rows[1] as { readonly passed: boolean }).passed).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("keeps failing against the last passing baseline after a failed row (issue #73)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-cli-issue-73-"));
    try {
      const trendsPath = join(dir, "trends.json");
      // Run 1 establishes a passing baseline with real measurements.
      const first = runCli([...MINIMAL_ARGS, "--trends", trendsPath], dir);
      expect(first.status).toBe(0);
      const afterFirst = JSON.parse(readFileSync(trendsPath, "utf8")) as {
        readonly schemaVersion: number;
        readonly rows: ReadonlyArray<{
          readonly date: string;
          readonly hardware: {
            readonly cpuModel: string;
            readonly platform: string;
            readonly arch: string;
            readonly cores: number;
            readonly totalMemoryGiB: number;
            readonly nodeVersion: string;
          };
          readonly values: Readonly<Record<string, number>>;
          readonly passed: boolean;
        }>;
      };
      expect(afterFirst.schemaVersion).toBe(2);
      expect(afterFirst.rows).toHaveLength(1);
      expect(afterFirst.rows[0]?.passed).toBe(true);
      const hardware = afterFirst.rows[0]?.hardware;
      const values = afterFirst.rows[0]?.values;
      expect(hardware).toBeDefined();
      expect(values).toBeDefined();
      // Deflate the passing baseline so the next real run regresses,
      // and append a failed row (the workflow's failure path) with
      // inflated values that would mask the regression if the failed
      // row became the baseline.
      const deflated = Object.fromEntries(
        Object.entries(values as Record<string, number>).map(([key, v]) => [
          key,
          v / 2,
        ]),
      );
      const inflated = Object.fromEntries(
        Object.entries(values as Record<string, number>).map(([key, v]) => [
          key,
          v * 1.5,
        ]),
      );
      writeFileSync(
        trendsPath,
        JSON.stringify({
          schemaVersion: 2,
          rows: [
            {
              date: "2025-01-01T00:00:00.000Z",
              hardware,
              values: deflated,
              passed: true,
            },
            {
              date: "2025-01-02T00:00:00.000Z",
              hardware,
              values: inflated,
              passed: false,
            },
          ],
        }),
        "utf8",
      );

      const second = runCli([...MINIMAL_ARGS, "--trends", trendsPath], dir);

      // The identical real measurements still regress against the last
      // passing baseline; the failed row must not mask them.
      expect(second.status).toBe(1);
      expect(second.stdout).toContain("REGRESSED");
      const afterSecond = JSON.parse(readFileSync(trendsPath, "utf8")) as {
        readonly rows: ReadonlyArray<{ readonly passed: boolean }>;
      };
      expect(afterSecond.rows).toHaveLength(3);
      expect(afterSecond.rows[2]?.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("migrates a v1 history and never uses its rows as baselines (issue #73)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-cli-issue-73-migrate-"));
    try {
      const trendsPath = join(dir, "trends.json");
      // Run 1 establishes the runner's real named hardware.
      const first = runCli([...MINIMAL_ARGS, "--trends", trendsPath], dir);
      expect(first.status).toBe(0);
      const afterFirst = JSON.parse(readFileSync(trendsPath, "utf8")) as {
        readonly rows: ReadonlyArray<{
          readonly date: string;
          readonly hardware: unknown;
          readonly values: Readonly<Record<string, number>>;
          readonly passed: boolean;
        }>;
      };
      const hardware = afterFirst.rows[0]?.hardware;
      expect(hardware).toBeDefined();
      // Rewrite the history as v1 (no pass markers) with a deflated row
      // on the same hardware: the migrated row must not become a
      // baseline, so the run starts a fresh baseline instead.
      writeFileSync(
        trendsPath,
        JSON.stringify({
          schemaVersion: 1,
          rows: [
            {
              date: "2025-01-01T00:00:00.000Z",
              hardware,
              values: Object.fromEntries(
                Object.entries(afterFirst.rows[0]?.values ?? {}).map(
                  ([key, v]) => [key, v / 2],
                ),
              ),
            },
          ],
        }),
        "utf8",
      );

      const second = runCli([...MINIMAL_ARGS, "--trends", trendsPath], dir);

      expect(second.status).toBe(0);
      expect(second.stdout).toContain(
        "[skip] no passing baseline on this named hardware",
      );
      const afterSecond = JSON.parse(readFileSync(trendsPath, "utf8")) as {
        readonly schemaVersion: number;
        readonly rows: ReadonlyArray<{ readonly passed: boolean }>;
      };
      expect(afterSecond.schemaVersion).toBe(2);
      expect(afterSecond.rows).toHaveLength(2);
      expect(afterSecond.rows[0]?.passed).toBe(false);
      expect(afterSecond.rows[1]?.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("rejects an incomplete named-tier matrix with a structured error (issue #72)", () => {
    // The issue-72 repro: a reference-tier invocation that measures no
    // mandatory 100k/500k/1M scene gate must exit non-zero with a
    // structured incomplete-matrix error and must not write a report.
    const dir = mkdtempSync(join(tmpdir(), "bench-cli-issue-72-"));
    try {
      const jsonPath = join(dir, "out.json");
      const result = runCli(
        [
          "--tier",
          "reference",
          "--sizes",
          "10000",
          "--kinds",
          "compact",
          "--samples",
          "1",
          "--save-load-runs",
          "1",
          "--preview-samples",
          "1",
          "--preview-size",
          "1",
          "--animation-frames",
          "1",
          "--json",
          jsonPath,
          "--no-progress",
        ],
        dir,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(INCOMPLETE_BENCHMARK_MATRIX);
      expect(result.stderr).toContain("missing required size 100000");
      expect(result.stdout).not.toContain("report written");
      expect(existsSync(jsonPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts positive integer counts and writes numeric JSON options", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-cli-ok-"));
    const jsonPath = join(dir, "out.json");
    const result = runCli([...MINIMAL_ARGS, "--json", jsonPath], dir);
    expect(result.status).toBe(0);
    expect(existsSync(jsonPath)).toBe(true);
    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      readonly options: {
        readonly samples: unknown;
        readonly saveLoadRuns: unknown;
      };
    };
    // The report contract declares numbers: NaN counts must never
    // serialize as JSON null (ticket #57).
    expect(report.options.samples).toBe(1);
    expect(report.options.saveLoadRuns).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);
});
