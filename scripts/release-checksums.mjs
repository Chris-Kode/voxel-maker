#!/usr/bin/env node
/**
 * Release checksums (issue #46, S17.10/S17.15): writes or verifies
 * SHA-256 checksums for every release artifact in a directory.
 *
 *   node scripts/release-checksums.mjs <directory> [--verify]
 *
 * Without --verify the directory's SHASUMS256.txt is (re)written from the
 * current artifact set. With --verify every line is recomputed and
 * compared; the process exits non-zero on any missing, extra, or
 * mismatched artifact.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const CHECKSUM_FILE = "SHASUMS256.txt";

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export async function writeChecksums(directory) {
  const entries = (await readdir(directory)).filter(
    (name) => name !== CHECKSUM_FILE,
  );
  const lines = [];
  for (const name of entries.sort()) {
    const path = join(directory, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    lines.push(`${await sha256File(path)}  ${name}`);
  }
  await writeFile(join(directory, CHECKSUM_FILE), `${lines.join("\n")}\n`);
  return lines.length;
}

export async function verifyChecksums(directory) {
  const checksumPath = join(directory, CHECKSUM_FILE);
  const text = await readFile(checksumPath, "utf8");
  const expected = new Map();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const [hash, ...nameParts] = line.trim().split(/\s+/u);
    expected.set(nameParts.join(" "), hash);
  }
  const failures = [];
  for (const [name, hash] of expected) {
    try {
      const actual = await sha256File(join(directory, name));
      if (actual !== hash)
        failures.push(
          `${name}: checksum mismatch (expected ${hash}, got ${actual})`,
        );
    } catch {
      failures.push(`${name}: artifact missing`);
    }
  }
  const present = new Set(
    (await readdir(directory)).filter((n) => n !== CHECKSUM_FILE),
  );
  for (const name of present) {
    if (!expected.has(name))
      failures.push(`${name}: artifact not listed in ${CHECKSUM_FILE}`);
  }
  return failures;
}

const [directoryArg, mode] = process.argv.slice(2);
if (!directoryArg) {
  console.error(
    "usage: node scripts/release-checksums.mjs <directory> [--verify]",
  );
  process.exit(2);
}
const directory = resolve(directoryArg);
try {
  if (mode === "--verify") {
    const failures = await verifyChecksums(directory);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`  - ${failure}`);
      console.error(`release-checksums verify FAILED for ${directory}`);
      process.exitCode = 1;
    } else {
      console.log(`release-checksums verify passed: ${directory}`);
    }
  } else {
    const count = await writeChecksums(directory);
    console.log(
      `release-checksums wrote ${count} entries to ${join(directory, CHECKSUM_FILE)}`,
    );
  }
} catch (error) {
  console.error(`release-checksums failed: ${error.message}`);
  process.exitCode = 1;
}
