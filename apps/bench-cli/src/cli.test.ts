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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

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
