import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * Checked-in secret gate (issue #44, plan §10.2 "no checked-in secret
 * scan"): scans every git-tracked file for high-signal credential
 * patterns, private keys, and tracked secret-material files (.env, .pem,
 * .key). Binary files are skipped; the scan is deterministic and runs in
 * `pnpm check:security` (offline).
 *
 * Tested by scripts/check-secrets.test.mjs against an in-memory corpus.
 */

/** High-signal secret patterns (deliberately conservative). */
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36,255}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{30,255}\b/u,
  /\bsk-[A-Za-z0-9]{20,255}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
];

/** File names that must never be tracked (regardless of content). */
const FORBIDDEN_FILE_NAMES = [
  /(?:^|\/)\.env$/u,
  /\.pem$/u,
  /\.key$/u,
  /\.p12$/u,
  /\.pfx$/u,
  /\.keystore$/u,
];

const isBinary = (content) => content.includes("\0");

/** Scans one file's content; returns the list of findings. */
export function scanContent(path, content) {
  const findings = [];
  if (isBinary(content)) return findings;
  for (const pattern of SECRET_PATTERNS) {
    const match = content.match(pattern);
    if (match !== null) {
      findings.push(`${path}: matches ${String(pattern)}`);
    }
  }
  return findings;
}

/** Scans a named file; forbidden file names are findings even when clean. */
export function scanFile(path, content) {
  const findings = [];
  for (const pattern of FORBIDDEN_FILE_NAMES) {
    if (pattern.test(path)) {
      findings.push(`${path}: tracked file name is forbidden secret material`);
    }
  }
  findings.push(...scanContent(path, content));
  return findings;
}

/** Returns git-tracked file paths under `root` (git must be available). */
export function trackedFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  return output.split("\0").filter((path) => path.length > 0);
}

export async function inspectSecrets(root) {
  const findings = [];
  for (const path of trackedFiles(root)) {
    if (/(?:^|\/)node_modules\//u.test(path) || /(?:^|\/)dist\//u.test(path)) {
      continue;
    }
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    findings.push(...scanFile(path, content));
  }
  return findings;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = process.cwd();
  try {
    const findings = await inspectSecrets(root);
    if (findings.length > 0) {
      console.error("Secret scan failed:");
      for (const finding of findings.slice(0, 50))
        console.error(`- ${finding}`);
      if (findings.length > 50) {
        console.error(`- ... and ${String(findings.length - 50)} more`);
      }
      process.exit(1);
    }
    console.log(
      "Secret scan passed: no checked-in credentials or secret material.",
    );
  } catch (error) {
    console.error(`Secret scan could not run: ${String(error)}`);
    process.exit(1);
  }
}
