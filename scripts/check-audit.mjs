import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Dependency vulnerability gate (issue #44, plan §10.2 "dependency
 * security scan"): runs `pnpm audit --prod` and fails the gate on any
 * `high` or `critical` advisory. The audit needs registry access, so it is
 * wired into CI (`pnpm check:audit`) and into the release process rather
 * than the offline `pnpm check` flow.
 */

const FAIL_SEVERITIES = new Set(["high", "critical"]);

export function auditJson(projectRoot) {
  const output = execFileSync("pnpm", ["audit", "--prod", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
}

/** Extracts [severity, name, url] findings from an audit report. */
export function auditFindings(report) {
  const findings = [];
  const vulnerabilities = report.vulnerabilities ?? {};
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    const severity = entry.severity ?? "unknown";
    const via = entry.via ?? [];
    for (const advisory of via) {
      if (typeof advisory !== "object" || advisory === null) continue;
      findings.push({
        name,
        severity,
        url: advisory.url ?? "",
        title: advisory.title ?? "",
      });
    }
  }
  return findings;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = process.cwd();
  try {
    const report = auditJson(root);
    const findings = auditFindings(report);
    const blocking = findings.filter((finding) =>
      FAIL_SEVERITIES.has(finding.severity),
    );
    if (blocking.length > 0) {
      console.error("Dependency audit failed:");
      for (const finding of blocking.slice(0, 50)) {
        console.error(
          `- ${finding.severity} ${finding.name}: ${finding.title} ${finding.url}`,
        );
      }
      process.exit(1);
    }
    console.log(
      `Dependency audit passed: no high/critical advisories (${String(findings.length)} total advisories).`,
    );
  } catch (error) {
    console.error(`Dependency audit could not run: ${String(error)}`);
    process.exit(2);
  }
}
