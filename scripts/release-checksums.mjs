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
 *
 * Verification only accepts canonical single-component artifact names and
 * strict 64-hex hashes (issue #97). Traversal, absolute, dot,
 * duplicate, malformed-hash, directory, symlink-escape, missing, extra, and
 * mismatched entries all fail, the checksum file itself must be a regular
 * file, and every artifact is resolved and containment-checked, so
 * verification cannot read or endorse files outside the artifact directory.
 */
import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  writeFile,
  stat,
  realpath,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CHECKSUM_FILE = "SHASUMS256.txt";

/** Files that are metadata about the set rather than artifacts. */
const METADATA_FILES = new Set(["manifest.json"]);

/** Canonical sha256 hex digest of an artifact (exactly 64 hex digits). */
const HASH_PATTERN = /^[0-9a-f]{64}$/iu;

/**
 * Why `name` cannot appear as a checksum entry, or null when it is a valid
 * canonical artifact name. Artifact names are single path components: no
 * separators, no dot segments, and not the set's own metadata files. This is
 * what keeps verification inside the artifact directory (issue #97).
 */
function invalidNameReason(name) {
  if (name === "") return "name is empty";
  if (name === "." || name === "..") return "name is a dot path segment";
  if (name.includes("/") || name.includes("\\"))
    return "name contains a path separator";
  if (name === CHECKSUM_FILE) return `name is ${CHECKSUM_FILE}`;
  if (METADATA_FILES.has(name)) return "name is a metadata file";
  return null;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export async function writeChecksums(directory) {
  const entries = (await readdir(directory)).filter(
    (name) => invalidNameReason(name) === null,
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
  // The checksum file must be a plain file: a symlink could point outside the
  // set and leak its content through malformed-entry messages (issue #97).
  const checksumInfo = await lstat(checksumPath);
  if (!checksumInfo.isFile())
    throw new Error(`${CHECKSUM_FILE} must be a regular file`);
  const text = await readFile(checksumPath, "utf8");
  const expected = new Map();
  const failures = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    const fields = line.split(/\s+/u);
    if (fields.length < 2) {
      const detail = line.length > 80 ? `${line.slice(0, 77)}...` : line;
      failures.push(
        `${CHECKSUM_FILE} line ${i + 1}: malformed entry "${detail}"`,
      );
      continue;
    }
    // sha256sum-style "<hash>  <name>": the name is the rest of the line and
    // may contain spaces (e.g. "Voxel Maker_0.1.0_aarch64.dmg").
    const hash = fields[0];
    const name = fields.slice(1).join(" ");
    if (!HASH_PATTERN.test(hash)) {
      failures.push(`${name}: invalid checksum hash "${hash}"`);
      continue;
    }
    const reason = invalidNameReason(name);
    if (reason !== null) {
      failures.push(`${name}: invalid artifact name (${reason})`);
      continue;
    }
    if (expected.has(name)) {
      failures.push(`${name}: duplicate checksum entry`);
      continue;
    }
    expected.set(name, hash.toLowerCase());
  }
  // The set's real location, so symlinked artifacts can be containment-checked.
  const directoryReal = await realpath(directory);
  for (const [name, hash] of expected) {
    const path = join(directory, name);
    let info;
    try {
      info = await stat(path);
    } catch {
      failures.push(`${name}: artifact missing`);
      continue;
    }
    if (!info.isFile()) {
      failures.push(`${name}: not a file`);
      continue;
    }
    let real;
    try {
      real = await realpath(path);
    } catch {
      failures.push(`${name}: artifact missing`);
      continue;
    }
    const outside = relative(directoryReal, real);
    if (outside.startsWith("..") || isAbsolute(outside)) {
      failures.push(`${name}: escapes the artifact directory`);
      continue;
    }
    try {
      const actual = await sha256File(path);
      if (actual !== hash)
        failures.push(
          `${name}: checksum mismatch (expected ${hash}, got ${actual})`,
        );
    } catch {
      failures.push(`${name}: artifact missing`);
    }
  }
  // Names the writer refuses to list are ignored here too, so a generated
  // set always verifies; directories and other unlisted files still fail.
  const present = new Set(
    (await readdir(directory)).filter(
      (name) => invalidNameReason(name) === null,
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
