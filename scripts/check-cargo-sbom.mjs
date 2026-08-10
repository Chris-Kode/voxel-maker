#!/usr/bin/env node
/**
 * Cargo SBOM generation (issue #74, plan §11.2 "SBOM/license
 * generation"): runs `cargo cyclonedx` over the Tauri crate's locked
 * dependency tree and writes the CycloneDX JSON SBOM into the given
 * output directory, failing closed when the SBOM cannot be produced.
 * The release packaging flow (scripts/release-package.mjs) uses this to
 * ship the SBOM inside the release artifact set; PR CI runs it into a
 * scratch directory so a broken SBOM generation fails pull requests.
 *
 * cargo-cyclonedx writes `<override>.json` into the manifest's
 * directory, so the script moves the generated file into `outDir`.
 * The tool has no `--locked` flag; lockfile freshness is enforced by
 * the `--locked` clippy/test gates in scripts/check-rust.mjs, which run
 * before packaging in CI and the release workflow.
 *
 * Tested by scripts/check-cargo-sbom.test.mjs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Crate directory relative to the workspace root. */
export const RUST_CRATE_DIR = "apps/desktop/src-tauri";

/** File name the generated SBOM is published under. */
export const SBOM_FILE = "sbom.cdx.json";

/** Override filename passed to cargo-cyclonedx (the tool appends .json). */
const CYCLONEDX_OVERRIDE = "sbom.cdx";

/**
 * Generates the CycloneDX JSON SBOM for the crate's locked dependency
 * tree into `outDir` and returns the SBOM file path. `spawn` is
 * injectable for tests. Throws when the tool fails or the SBOM file is
 * not produced.
 */
export function generateCargoSbom({
  crateDir,
  outDir,
  spawn = spawnSync,
  log = console,
}) {
  const result = spawn(
    "cargo",
    [
      "cyclonedx",
      "--format",
      "json",
      "--override-filename",
      CYCLONEDX_OVERRIDE,
    ],
    { cwd: crateDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cargo cyclonedx exited with status ${result.status}`);
  }
  const generated = join(crateDir, `${CYCLONEDX_OVERRIDE}.json`);
  if (!existsSync(generated)) {
    throw new Error(`SBOM file ${generated} was not produced`);
  }
  const sbomPath = join(outDir, SBOM_FILE);
  renameSync(generated, sbomPath);
  log.log(`[check-cargo-sbom] SBOM written to ${sbomPath}`);
  return sbomPath;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const outDirArg = process.argv.indexOf("--out");
  const outDir =
    outDirArg >= 0 && process.argv[outDirArg + 1] !== undefined
      ? process.argv[outDirArg + 1]
      : await mkdtemp(join(tmpdir(), "voxel-sbom-"));
  try {
    generateCargoSbom({
      crateDir: join(process.cwd(), RUST_CRATE_DIR),
      outDir,
    });
    console.log(`Cargo SBOM generated: ${join(outDir, SBOM_FILE)}`);
  } catch (error) {
    console.error(`Cargo SBOM could not be generated: ${String(error)}`);
    process.exit(1);
  }
}
