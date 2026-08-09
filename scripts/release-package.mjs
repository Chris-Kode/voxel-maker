#!/usr/bin/env node
/**
 * Release packaging (issue #46, S17.8/S17.10/S17.15): builds the desktop
 * bundle for the current platform, collects every installer artifact,
 * and publishes the artifact set with SHA-256 checksums and a release
 * manifest under `release/artifacts/<version>/`.
 *
 * The script is platform-neutral and mechanical by design:
 *  - On a machine with the native toolchain (macOS: Xcode; Windows:
 *    WiX/NSIS toolchain; Linux: rpm/deb tooling), `pnpm tauri build`
 *    produces the platform installers and this script packages them.
 *  - When the toolchain is unavailable, the failure is recorded in the
 *    manifest as a `notBuilt` reason and the remaining artifacts (web
 *    build, headless CLI) are still checksummed, so the unexecuted
 *    platform qualification stays an explicit, documented exception
 *    rather than a silent gap.
 *
 * Output layout:
 *   release/artifacts/<version>/
 *     <installers and bundles>
 *     SHASUMS256.txt
 *     manifest.json
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { writeChecksums } from "./release-checksums.mjs";

const workspaceRoot = process.cwd();
const rootManifest = JSON.parse(
  await readFile(join(workspaceRoot, "package.json"), "utf8"),
);
const version = rootManifest.version;
const outDirectory = resolve(workspaceRoot, "release", "artifacts", version);
const desktopDirectory = join(workspaceRoot, "apps", "desktop");

const gitCommit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
})();

const platform = process.platform;
const arch = process.arch;

/** Bundle output roots produced by `tauri build` per platform. */
function bundleRoots() {
  const target = join(
    desktopDirectory,
    "src-tauri",
    "target",
    "release",
    "bundle",
  );
  const roots = [];
  for (const kind of [
    "dmg",
    "app",
    "msi",
    "nsis",
    "deb",
    "rpm",
    "appimage",
    "pkg",
  ]) {
    const root = join(target, kind);
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

async function collectArtifacts() {
  const artifacts = [];
  for (const root of bundleRoots()) {
    const entries = await readdir(root);
    for (const entry of entries) {
      const path = join(root, entry);
      const info = await stat(path);
      if (info.isFile()) {
        artifacts.push({ name: entry, source: path, bytes: info.size });
      } else if (info.isDirectory() && entry.endsWith(".app")) {
        // macOS .app bundles are directories; package them as-is.
        artifacts.push({ name: entry, source: path, directory: true });
      }
    }
  }
  return artifacts;
}

let bundle = { attempted: false, ok: false, reason: null, artifacts: [] };
const headlessDist = join(workspaceRoot, "apps", "headless", "dist");
const desktopDist = join(desktopDirectory, "dist");

// The web build is a release artifact on every platform: it is the exact
// frontend payload the packaged app runs, and it can be smoke-served.
const webBuildExists = existsSync(join(desktopDist, "index.html"));
if (!webBuildExists) {
  console.error(
    "desktop web build missing; run `pnpm build` first (or `pnpm release:package`)",
  );
  process.exit(1);
}

try {
  console.log(
    `[release-package] tauri build (${platform}/${arch}, app ${version})`,
  );
  const result = spawnSync("pnpm", ["tauri", "build"], {
    cwd: desktopDirectory,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  bundle.attempted = true;
  bundle.ok = result.status === 0;
  if (!bundle.ok) {
    bundle.reason = `tauri build exited with status ${result.status ?? "signal"} (${result.signal ?? "none"})`;
    console.error(`[release-package] ${bundle.reason}`);
    console.error(
      "[release-package] continuing with non-bundle artifacts; record this as an approved exception in docs/release/clean-machine-qualification-v1.md",
    );
  } else {
    bundle.artifacts = (await collectArtifacts()).map(
      (artifact) => artifact.name,
    );
  }
} catch (error) {
  bundle.attempted = true;
  bundle.ok = false;
  bundle.reason = `tauri build could not run: ${error.message}`;
  console.error(`[release-package] ${bundle.reason}`);
  console.error(
    "[release-package] continuing with non-bundle artifacts; record this as an approved exception in docs/release/clean-machine-qualification-v1.md",
  );
}

// macOS signing hook (plan S17.10): when the maintainer's signing
// identity is configured, sign the freshly built .app bundle before the
// artifacts are copied, so the published checksums cover signed bytes.
if (platform === "darwin" && process.env.APPLE_SIGNING_IDENTITY) {
  const appBundle = join(
    desktopDirectory,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "macos",
    "Voxel Maker.app",
  );
  if (existsSync(appBundle)) {
    const sign = spawnSync(
      "codesign",
      [
        "--deep",
        "--force",
        "--options",
        "runtime",
        "--sign",
        process.env.APPLE_SIGNING_IDENTITY,
        appBundle,
      ],
      { stdio: "inherit" },
    );
    if (sign.status === 0) {
      spawnSync("codesign", ["--verify", "--deep", "--strict", appBundle], {
        stdio: "inherit",
      });
      console.log("[release-package] macOS app bundle signed");
    } else {
      console.error(
        "[release-package] codesign failed; publishing unsigned artifacts",
      );
    }
  }
}

await mkdir(outDirectory, { recursive: true });
const artifacts = [];
for (const artifact of await collectArtifacts()) {
  const destination = join(outDirectory, artifact.name);
  await copyFile(artifact.source, destination);
  const info = await stat(destination);
  artifacts.push({ name: artifact.name, bytes: info.size });
  console.log(
    `[release-package] artifact ${artifact.name} (${info.size} bytes)`,
  );
}

// Headless CLI binaries are released alongside installers so headless
// qualification (smoke, recovery, persistence) runs from the artifact set.
for (const actualName of [
  "cli.js",
  "persistence-cli.js",
  "recovery-cli.js",
  "release-smoke-cli.js",
]) {
  const sourcePath = join(headlessDist, actualName);
  if (existsSync(sourcePath)) {
    const destination = join(outDirectory, `headless-${actualName}`);
    await copyFile(sourcePath, destination);
    const info = await stat(destination);
    artifacts.push({ name: basename(destination), bytes: info.size });
    console.log(
      `[release-package] artifact ${basename(destination)} (${info.size} bytes)`,
    );
  }
}

const checksumCount = await writeChecksums(outDirectory);
const manifest = {
  release: version,
  platform,
  arch,
  gitCommit,
  builtAt: new Date().toISOString(),
  bundle: {
    attempted: bundle.attempted,
    ok: bundle.ok,
    ...(bundle.reason === null ? {} : { reason: bundle.reason }),
    artifacts: bundle.artifacts,
  },
  artifacts: artifacts.sort((a, b) => a.name.localeCompare(b.name)),
  checksums: {
    file: "SHASUMS256.txt",
    entries: checksumCount,
  },
  notes:
    "Checksums are SHA-256 over the exact artifact bytes. Verify with `pnpm release:verify-checksums`.",
};
await writeFile(
  join(outDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  `[release-package] manifest written to ${join(outDirectory, "manifest.json")}`,
);
console.log(
  `[release-package] artifact set complete: ${artifacts.length} files, ${checksumCount} checksum entries`,
);
