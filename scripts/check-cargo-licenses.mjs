#!/usr/bin/env node
/**
 * Cargo license gate (issue #74, plan §11.2 "SBOM/license
 * generation"): runs `cargo deny check licenses` against the allowlist
 * in apps/desktop/src-tauri/deny.toml and fails closed on any
 * violation. The allowlist covers the v1 Tauri shell dependency set
 * and must be widened only by review.
 *
 * Tested by scripts/check-cargo-licenses.test.mjs.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Crate directory relative to the workspace root. */
export const RUST_CRATE_DIR = "apps/desktop/src-tauri";

/**
 * Runs `cargo deny check licenses` in the crate directory and returns
 * `{ status, output }`. `spawn` is injectable for tests.
 */
export function cargoLicenseCheck(crateDir, spawn = spawnSync) {
  const result = spawn("cargo", ["deny", "check", "licenses"], {
    cwd: crateDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = process.cwd();
  try {
    const result = cargoLicenseCheck(join(root, RUST_CRATE_DIR));
    if (result.status !== 0) {
      console.error("Cargo license gate failed:");
      console.error(result.output);
      process.exit(1);
    }
    console.log(
      "Cargo license gate passed: every crate license is allowlisted.",
    );
  } catch (error) {
    console.error(`Cargo license gate could not run: ${String(error)}`);
    process.exit(2);
  }
}
