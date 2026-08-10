#!/usr/bin/env node
/**
 * Release publishing (issue #71): prepares the per-platform artifact sets
 * downloaded by the tag workflow for a single GitHub release.
 *
 * GitHub release assets share one flat name namespace, so identically
 * named files across platform sets (manifest.json, SHASUMS256.txt, the
 * headless probes) collide and `gh release create` fails partway. This
 * script renames every file inside each set to
 * `<platform>-<arch>-<basename>` (arch from the set's manifest),
 * regenerates the set's SHASUMS256.txt and manifest.json so they name the
 * published files, and prints the flat file list for `gh release create`.
 *
 *   node scripts/release-publish.mjs <artifacts-root>
 *
 * The artifacts root is the download-artifact output directory: one
 * subdirectory per platform set, named `voxel-maker-<platform>-<sha>`
 * (see .github/workflows/release.yml).
 */
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeChecksums } from "./release-checksums.mjs";

const CHECKSUM_FILE = "SHASUMS256.txt";
const MANIFEST_FILE = "manifest.json";
/** Artifact set directory names produced by the qualify matrix. */
const SET_NAME_PATTERN = /^voxel-maker-(macos|windows|linux)-[0-9a-f]{40}$/u;

/** Every file under `directory`, recursively, sorted. */
export async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files.sort();
}

/**
 * Renames every file in one platform set to `<platform>-<basename>` in
 * place, then regenerates the set's checksums and manifest so they name
 * the published files. Returns the set's files ready for upload.
 */
async function prepareSet(setRoot, platform) {
  const files = await listFiles(setRoot);
  const checksumPaths = files.filter(
    (file) => basename(file) === CHECKSUM_FILE,
  );
  if (checksumPaths.length !== 1) {
    throw new Error(
      `set ${basename(setRoot)} must contain exactly one ${CHECKSUM_FILE} (found ${checksumPaths.length})`,
    );
  }
  const contentRoot = dirname(checksumPaths[0]);
  const manifestPath = join(contentRoot, MANIFEST_FILE);
  if (!files.includes(manifestPath)) {
    throw new Error(`set ${basename(setRoot)} is missing ${MANIFEST_FILE}`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    !Array.isArray(manifest.artifacts) ||
    !manifest.checksums ||
    typeof manifest.arch !== "string"
  ) {
    throw new Error(
      `set ${basename(setRoot)} has an unexpected ${MANIFEST_FILE} shape`,
    );
  }
  const prefix = `${platform}-${manifest.arch}`;

  // Rename every artifact (not the metadata files yet) so the regenerated
  // checksums list the published names.
  const published = [];
  for (const file of files) {
    const name = basename(file);
    if (name === CHECKSUM_FILE || name === MANIFEST_FILE) continue;
    const publishedName = `${prefix}-${name}`;
    if (published.includes(publishedName)) {
      throw new Error(
        `set ${basename(setRoot)} contains duplicate basename ${name}`,
      );
    }
    published.push(publishedName);
    await rename(file, join(dirname(file), publishedName));
  }

  // Regenerate SHASUMS256.txt over the renamed artifacts (it excludes
  // itself and manifest.json by name), then publish the metadata files
  // under their platform/arch-prefixed names.
  await writeChecksums(contentRoot);
  manifest.artifacts = manifest.artifacts.map((artifact) => ({
    ...artifact,
    name: `${prefix}-${artifact.name}`,
  }));
  if (Array.isArray(manifest.bundle?.artifacts)) {
    manifest.bundle.artifacts = manifest.bundle.artifacts.map(
      (name) => `${prefix}-${name}`,
    );
  }
  manifest.checksums = {
    ...manifest.checksums,
    file: `${prefix}-${CHECKSUM_FILE}`,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(
    checksumPaths[0],
    join(contentRoot, `${prefix}-${CHECKSUM_FILE}`),
  );
  await rename(manifestPath, join(contentRoot, `${prefix}-${MANIFEST_FILE}`));

  return (await listFiles(setRoot)).sort();
}

/**
 * Prepares every platform set under `artifactsRoot` for one release and
 * returns the flat, sorted list of files to upload. Each returned file's
 * basename is unique and prefixed with its platform and architecture.
 */
export async function prepareReleaseAssets(artifactsRoot) {
  const root = resolve(artifactsRoot);
  const sets = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (sets.length === 0) {
    throw new Error(`no artifact sets found under ${artifactsRoot}`);
  }
  const uploadFiles = [];
  for (const setName of sets) {
    const match = SET_NAME_PATTERN.exec(setName);
    if (!match) {
      throw new Error(
        `artifact set directory ${setName} does not match voxel-maker-<platform>-<sha>`,
      );
    }
    const setRoot = join(root, setName);
    for (const file of await prepareSet(setRoot, match[1])) {
      uploadFiles.push(join(artifactsRoot, relative(root, file)));
    }
  }
  return uploadFiles.sort();
}

// CLI entry only when invoked directly (the module is imported by the
// regression test for its prepare function).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [artifactsRoot] = process.argv.slice(2);
  if (!artifactsRoot) {
    console.error("usage: node scripts/release-publish.mjs <artifacts-root>");
    process.exit(2);
  }
  try {
    for (const file of await prepareReleaseAssets(artifactsRoot)) {
      console.log(file);
    }
  } catch (error) {
    console.error(`release-publish failed: ${error.message}`);
    process.exitCode = 1;
  }
}
