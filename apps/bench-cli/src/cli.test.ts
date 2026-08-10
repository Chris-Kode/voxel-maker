import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
];

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: readonly string[], cwd: string): CliRun {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
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
