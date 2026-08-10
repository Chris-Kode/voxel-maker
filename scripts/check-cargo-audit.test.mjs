import assert from "node:assert/strict";
import test from "node:test";
import {
  cargoAuditFindings,
  cargoAuditJson,
  blockingFindings,
} from "./check-cargo-audit.mjs";

/** Minimal cargo-audit JSON report shape. */
function report(list) {
  return { vulnerabilities: { list } };
}

function advisory(severity, title, url, packageName) {
  return {
    package: { name: packageName },
    advisory: { severity, title, url },
  };
}

test("cargoAuditJson runs cargo audit --json in the crate directory", () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      signal: null,
      error: undefined,
      stdout: JSON.stringify(report([])),
      stderr: "",
    };
  };
  const { status, report: parsed } = cargoAuditJson("/crate", spawn);
  assert.equal(status, 0);
  assert.deepEqual(parsed, report([]));
  assert.deepEqual(calls, [
    {
      command: "cargo",
      args: ["audit", "--json"],
      options: { cwd: "/crate", encoding: "utf8", maxBuffer: 67108864 },
    },
  ]);
});

test("cargoAuditJson surfaces spawn errors (missing cargo-audit)", () => {
  const spawn = () => ({ error: new Error("spawn cargo ENOENT") });
  assert.throws(() => cargoAuditJson("/crate", spawn), /spawn cargo ENOENT/);
});

test("cargoAuditFindings extracts severity, package, title, and url", () => {
  const findings = cargoAuditFindings(
    report([
      advisory("high", "Buffer overflow", "https://rustsec.org/a/1", "libc"),
      advisory("moderate", "Info leak", "https://rustsec.org/a/2", "serde"),
    ]),
  );
  assert.deepEqual(findings, [
    {
      severity: "high",
      package: "libc",
      title: "Buffer overflow",
      url: "https://rustsec.org/a/1",
    },
    {
      severity: "moderate",
      package: "serde",
      title: "Info leak",
      url: "https://rustsec.org/a/2",
    },
  ]);
});

test("cargoAuditFindings tolerates a report without a vulnerabilities list", () => {
  assert.deepEqual(cargoAuditFindings({}), []);
});

test("high and critical advisories are blocking", () => {
  const findings = cargoAuditFindings(
    report([
      advisory("high", "A", "https://rustsec.org/a/1", "pkg-a"),
      advisory("critical", "B", "https://rustsec.org/a/2", "pkg-b"),
      advisory("moderate", "C", "https://rustsec.org/a/3", "pkg-c"),
      advisory("low", "D", "https://rustsec.org/a/4", "pkg-d"),
    ]),
  );
  assert.deepEqual(
    blockingFindings(findings).map((finding) => finding.package),
    ["pkg-a", "pkg-b"],
  );
});

test("an audit with only low/moderate advisories is not blocking", () => {
  const findings = cargoAuditFindings(
    report([
      advisory("moderate", "C", "https://rustsec.org/a/3", "pkg-c"),
      advisory("low", "D", "https://rustsec.org/a/4", "pkg-d"),
    ]),
  );
  assert.deepEqual(blockingFindings(findings), []);
});
