#!/usr/bin/env node
/**
 * Rust gate chain (issue #74, plan §10.2 "Rust fmt, clippy, and tests
 * once Tauri exists"): runs the locked Cargo fmt/clippy/test gates for
 * the Tauri shell crate and fails closed on any failure. The gates are
 * offline once the Rust toolchain is installed, so the script is part
 * of the offline `pnpm check` chain; CI and the release workflow run it
 * after installing the toolchain (and the Linux bundling dependencies,
 * which the Tauri crate needs to compile on Linux).
 *
 * Tested by scripts/check-rust.test.mjs.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Crate directory relative to the workspace root. */
export const RUST_CRATE_DIR = "apps/desktop/src-tauri";

/** The mandatory Rust gates, in execution order (plan §10.2). */
export const RUST_GATES = [
  {
    label: "cargo fmt --check",
    command: "cargo",
    args: ["fmt", "--check"],
  },
  {
    label: "cargo clippy --locked --all-targets -- -D warnings",
    command: "cargo",
    args: ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"],
  },
  {
    label: "cargo test --locked",
    command: "cargo",
    args: ["test", "--locked"],
  },
];

/**
 * Runs every Rust gate in order and returns the labels of the failed
 * gates (empty when all pass). `execFile` is injectable for tests; the
 * real default streams the gates' output to the caller's stdio.
 */
export function runRustGates({
  workspaceRoot,
  execFile = execFileSync,
  log = console,
}) {
  const crateDir = join(workspaceRoot, RUST_CRATE_DIR);
  const failures = [];
  for (const gate of RUST_GATES) {
    try {
      execFile(gate.command, gate.args, { cwd: crateDir, stdio: "inherit" });
      log.log(`[check-rust] ${gate.label} passed`);
    } catch (error) {
      failures.push(gate.label);
      log.error(`[check-rust] ${gate.label} failed: ${error.message}`);
    }
  }
  return failures;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const failures = runRustGates({ workspaceRoot: process.cwd() });
  if (failures.length > 0) {
    console.error("Rust gates failed:");
    for (const label of failures) {
      console.error(`- ${label}`);
    }
    process.exit(1);
  }
  console.log("Rust gates passed: fmt, clippy, and tests are green.");
}
