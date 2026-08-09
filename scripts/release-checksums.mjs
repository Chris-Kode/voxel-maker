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
import { pathToFileURL } from "node:url";

const CHECKSUM_FILE = "SHASUMS256.txt";

/** Files that are metadata about the set rather than artifacts. */
const METADATA_FILES = new Set(["manifest.json"]);

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export async function writeChecksums(directory) {
  const entries = (await readdir(directory)).filter(
    (name) => name !== CHECKSUM_FILE && !METADATA_FILES.has(name),
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
    (await readdir(directory)).filter(
      (n) => n !== CHECKSUM_FILE && !METADATA_FILES.has(n),
    ),
  );
  for (const name of present) {
    if (!expected.has(name))
      failures.push(`${name}: artifact not listed in ${CHECKSUM_FILE}`);
  }
  return failures;
}

/** Directories under the release artifacts root that hold artifact sets. */
async function artifactDirectories(root) {
  const entries = await readdir(root);
  const directories = [];
  for (const entry of entries) {
    const path = join(root, entry);
    const info = await stat(path);
    if (info.isDirectory()) directories.push(path);
  }
  return directories.length > 0 ? directories : [root];
}

// CLI entry only when invoked directly (the module is imported by
// release-package.mjs for its checksum functions).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
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
      // Verify every versioned artifact set under the given root (or the
      // directory itself when it is a single set).
      let failed = false;
      for (const set of await artifactDirectories(directory)) {
        const failures = await verifyChecksums(set);
        if (failures.length > 0) {
          failed = true;
          for (const failure of failures) console.error(`  - ${failure}`);
          console.error(`release-checksums verify FAILED for ${set}`);
        } else {
          console.log(`release-checksums verify passed: ${set}`);
        }
      }
      if (failed) process.exitCode = 1;
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
}
