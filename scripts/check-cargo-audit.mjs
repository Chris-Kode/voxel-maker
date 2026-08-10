#!/usr/bin/env node
/**
 * Cargo vulnerability gate (issue #74, plan §11.2 "Dependency scanning
 * for npm and Cargo"): runs `cargo audit --json` over the Tauri crate's
 * locked dependency tree and fails on any high/critical advisory — the
 * same severity policy as the npm audit gate (scripts/check-audit.mjs).
 * The audit needs registry access, so it is wired into CI and the
 * release workflow rather than the offline `pnpm check` flow.
 *
 * Tested by scripts/check-cargo-audit.test.mjs.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Crate directory relative to the workspace root. */
export const RUST_CRATE_DIR = "apps/desktop/src-tauri";

/** Advisory severities that block the gate (mirrors the npm audit gate). */
export const FAIL_SEVERITIES = new Set(["high", "critical"]);

/**
 * Runs `cargo audit --json` in the crate directory and returns
 * `{ status, report }`. `spawn` is injectable for tests; the audit
 * exits non-zero when advisories exist, so the report is parsed from
 * stdout regardless of the exit status.
 */
export function cargoAuditJson(crateDir, spawn = spawnSync) {
  const result = spawn("cargo", ["audit", "--json"], {
    cwd: crateDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, report: JSON.parse(result.stdout) };
}

/** Extracts [severity, package, title, url] findings from an audit report. */
export function cargoAuditFindings(report) {
  const findings = [];
  for (const entry of report.vulnerabilities?.list ?? []) {
    const advisory = entry.advisory ?? {};
    findings.push({
      severity: advisory.severity ?? "unknown",
      package: entry.package?.name ?? "unknown",
      title: advisory.title ?? "",
      url: advisory.url ?? "",
    });
  }
  return findings;
}

/** Findings whose severity is on the blocking allowlist. */
export function blockingFindings(findings) {
  return findings.filter((finding) => FAIL_SEVERITIES.has(finding.severity));
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = process.cwd();
  try {
    const { report } = cargoAuditJson(join(root, RUST_CRATE_DIR));
    const findings = cargoAuditFindings(report);
    const blocking = blockingFindings(findings);
    if (blocking.length > 0) {
      console.error("Cargo audit failed:");
      for (const finding of blocking.slice(0, 50)) {
        console.error(
          `- ${finding.severity} ${finding.package}: ${finding.title} ${finding.url}`,
        );
      }
      process.exit(1);
    }
    console.log(
      `Cargo audit passed: no high/critical advisories (${String(findings.length)} total advisories).`,
    );
  } catch (error) {
    console.error(`Cargo audit could not run: ${String(error)}`);
    process.exit(2);
  }
}
