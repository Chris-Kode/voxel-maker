import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Dependency license gate (issue #44, plan §10.2 "dependency license
 * scan"): every installed JS dependency must carry a license on the
 * allowlist. The scan reads the installed tree (pnpm's `.pnpm` store
 * layout) so it is offline and reproducible; the allowlist below covers
 * the v1 dependency set and must be widened only by review.
 *
 * Tested by scripts/check-licenses.test.mjs; runs in `pnpm check:security`.
 */

/** SPDX identifiers accepted without review. */
const ALLOWED_LICENSES = new Set([
  "0bsd",
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "cc0-1.0",
  "isc",
  "mit",
  "mit-0",
  "python-2.0",
  "unlicense",
  "zlib",
  "blueoak-1.0.0",
  "cc-by-4.0",
]);

/** Packages whose license field is intentionally empty/absent. */
const LICENSE_EXEMPT = new Set([
  // Workspace packages (private, never published) and the app shells.
  "@voxel-maker/shared",
  "@voxel-maker/math",
  "@voxel-maker/model",
  "@voxel-maker/voxel",
  "@voxel-maker/document",
  "@voxel-maker/commands",
  "@voxel-maker/renderer",
  "@voxel-maker/session",
  "@voxel-maker/editor",
  "@voxel-maker/formats",
  "@voxel-maker/interchange",
  "@voxel-maker/agent",
  "@voxel-maker/skills",
  "@voxel-maker/testkit",
  "@voxel-maker/evaluation",
  "@voxel-maker/animation",
  "@voxel-maker/rigging",
  "voxel-maker",
  "voxel-maker-headless",
  "voxel-maker-desktop",
]);

function splitSpdx(value) {
  // "Apache-2.0 OR MIT" / "MIT AND BSD-3-Clause" style expressions.
  return value
    .split(/\s+(?:or|and)\s+/iu)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

function normalizeLicense(value) {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    return /\s+(?:or|and)\s+/u.test(trimmed) ? splitSpdx(trimmed) : trimmed;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeLicense(entry)).filter(Boolean);
  }
  if (typeof value === "object" && value !== null) {
    const type = value.type ?? value.license;
    return typeof type === "string" ? type.trim().toLowerCase() : undefined;
  }
  return undefined;
}

function licenseAllowed(value) {
  const normalized = normalizeLicense(value);
  if (Array.isArray(normalized)) {
    return (
      normalized.length > 0 &&
      normalized.every((entry) => ALLOWED_LICENSES.has(entry))
    );
  }
  return normalized !== undefined && ALLOWED_LICENSES.has(normalized);
}

async function collectInstalledPackages(root) {
  const packages = [];
  const pnpmStore = join(root, "node_modules/.pnpm");
  const tryRead = async (directory) => {
    try {
      packages.push(
        JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
      );
    } catch {
      // Not every store directory carries a package.json at this level.
    }
  };
  const storeDirs = await readdir(pnpmStore, { withFileTypes: true }).catch(
    () => [],
  );
  for (const storeDir of storeDirs) {
    if (!storeDir.isDirectory()) continue;
    // Layout: node_modules/.pnpm/<name>@<version>/node_modules/<name>/package.json
    // (scoped names use @scope+name@version).
    const modules = join(pnpmStore, storeDir.name, "node_modules");
    const entries = await readdir(modules, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        const scoped = await readdir(join(modules, entry.name), {
          withFileTypes: true,
        }).catch(() => []);
        for (const sub of scoped) {
          if (sub.isDirectory()) {
            await tryRead(join(modules, entry.name, sub.name));
          }
        }
      } else {
        await tryRead(join(modules, entry.name));
      }
    }
  }
  return packages;
}

export async function inspectLicenses(root) {
  const problems = [];
  const packages = await collectInstalledPackages(root);
  const seen = new Set();
  for (const pkg of packages) {
    const name = pkg.name;
    if (name === undefined || LICENSE_EXEMPT.has(name)) continue;
    if (seen.has(`${name}@${pkg.version ?? ""}`)) continue;
    seen.add(`${name}@${pkg.version ?? ""}`);
    if (!licenseAllowed(pkg.license ?? pkg.licenses)) {
      problems.push(
        `${name}@${pkg.version ?? "?"} has no allowlisted license (${JSON.stringify(pkg.license)})`,
      );
    }
  }
  return problems;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = process.cwd();
  try {
    const problems = await inspectLicenses(root);
    if (problems.length > 0) {
      console.error("License check failed:");
      for (const problem of problems.slice(0, 50))
        console.error(`- ${problem}`);
      if (problems.length > 50) {
        console.error(`- ... and ${String(problems.length - 50)} more`);
      }
      process.exit(1);
    }
    console.log(
      "License check passed: every dependency carries an allowlisted license.",
    );
  } catch (error) {
    console.error(`License check could not run: ${String(error)}`);
    process.exit(1);
  }
}
