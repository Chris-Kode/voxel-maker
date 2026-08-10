import assert from "node:assert/strict";
import test from "node:test";
import { RUST_GATES, runRustGates } from "./check-rust.mjs";

/** Fake execFile that records invocations and optionally fails gates. */
function fakeExecFile(failLabels) {
  const calls = [];
  const execFile = (command, args, options) => {
    const label = `${command} ${args.join(" ")}`;
    calls.push({ command, args, options });
    if (failLabels.has(label)) {
      const error = new Error(`Command failed: ${label}`);
      error.status = 1;
      throw error;
    }
  };
  return { calls, execFile };
}

test("the Rust gate chain runs fmt, clippy, and tests in order with locked flags", () => {
  const { calls, execFile } = fakeExecFile(new Set());
  const failures = runRustGates({
    workspaceRoot: "/repo",
    execFile,
    log: { log() {}, error() {} },
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(
    calls.map((call) => call.command),
    ["cargo", "cargo", "cargo"],
  );
  assert.deepEqual(calls[0].args, ["fmt", "--check"]);
  assert.deepEqual(calls[1].args, [
    "clippy",
    "--locked",
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ]);
  assert.deepEqual(calls[2].args, ["test", "--locked"]);
});

test("every gate runs in the Tauri crate directory", () => {
  const { calls, execFile } = fakeExecFile(new Set());
  runRustGates({
    workspaceRoot: "/repo",
    execFile,
    log: { log() {}, error() {} },
  });
  for (const call of calls) {
    assert.equal(call.options.cwd, "/repo/apps/desktop/src-tauri");
  }
});

test("a failing fmt gate is reported as a failure", () => {
  const { execFile } = fakeExecFile(new Set(["cargo fmt --check"]));
  const failures = runRustGates({
    workspaceRoot: "/repo",
    execFile,
    log: { log() {}, error() {} },
  });
  assert.deepEqual(failures, ["cargo fmt --check"]);
});

test("a failing clippy gate is reported as a failure", () => {
  const { execFile } = fakeExecFile(
    new Set(["cargo clippy --locked --all-targets -- -D warnings"]),
  );
  const failures = runRustGates({
    workspaceRoot: "/repo",
    execFile,
    log: { log() {}, error() {} },
  });
  assert.deepEqual(failures, [
    "cargo clippy --locked --all-targets -- -D warnings",
  ]);
});

test("a failing test gate is reported as a failure", () => {
  const { execFile } = fakeExecFile(new Set(["cargo test --locked"]));
  const failures = runRustGates({
    workspaceRoot: "/repo",
    execFile,
    log: { log() {}, error() {} },
  });
  assert.deepEqual(failures, ["cargo test --locked"]);
});

test("all gates still run when one fails, and every failure is reported", () => {
  const { execFile } = fakeExecFile(
    new Set(["cargo fmt --check", "cargo test --locked"]),
  );
  const failures = runRustGates({
    workspaceRoot: "/repo",
    execFile,
    log: { log() {}, error() {} },
  });
  assert.deepEqual(failures, ["cargo fmt --check", "cargo test --locked"]);
});

test("the gate list is the documented mandatory set", () => {
  assert.deepEqual(
    RUST_GATES.map((gate) => gate.label),
    [
      "cargo fmt --check",
      "cargo clippy --locked --all-targets -- -D warnings",
      "cargo test --locked",
    ],
  );
});
