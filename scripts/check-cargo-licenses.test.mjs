import assert from "node:assert/strict";
import test from "node:test";
import { cargoLicenseCheck } from "./check-cargo-licenses.mjs";

test("cargoLicenseCheck runs cargo deny check licenses in the crate directory", () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      signal: null,
      error: undefined,
      stdout: "licenses ok",
      stderr: "",
    };
  };
  const result = cargoLicenseCheck("/crate", spawn);
  assert.equal(result.status, 0);
  assert.match(result.output, /licenses ok/);
  assert.deepEqual(calls, [
    {
      command: "cargo",
      args: ["deny", "check", "licenses"],
      options: { cwd: "/crate", encoding: "utf8", maxBuffer: 67108864 },
    },
  ]);
});

test("cargoLicenseCheck surfaces spawn errors (missing cargo-deny)", () => {
  const spawn = () => ({ error: new Error("spawn cargo ENOENT") });
  assert.throws(() => cargoLicenseCheck("/crate", spawn), /spawn cargo ENOENT/);
});

test("a non-zero cargo deny exit is returned as a failed gate", () => {
  const spawn = () => ({
    status: 1,
    signal: null,
    error: undefined,
    stdout: "",
    stderr: "license check failed: crate foo is not allowed",
  });
  const result = cargoLicenseCheck("/crate", spawn);
  assert.equal(result.status, 1);
  assert.match(result.output, /not allowed/);
});
