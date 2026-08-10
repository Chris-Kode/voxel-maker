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
 *  - A failed or empty native bundle is FATAL (issue #70): CI/tag
 *    qualification must never upload or publish an artifact set without
 *    a platform installer. The only escape hatch is the explicit
 *    local-only flag `--allow-no-bundle` (or `RELEASE_ALLOW_NO_BUNDLE=1`)
 *    for the documented approved-exception pattern in
 *    docs/release/clean-machine-qualification-v1.md; with the flag the
 *    failure is recorded in the manifest under `bundle.reason` and the
 *    remaining artifacts (web build, headless CLI) are still
 *    checksummed.
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
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeChecksums } from "./release-checksums.mjs";
import { generateCargoSbom, SBOM_FILE } from "./check-cargo-sbom.mjs";

/** Installer/bundle file name extensions that are publishable artifacts. */
const INSTALLER_KINDS = [
  "dmg",
  "pkg",
  "msi",
  "exe",
  "deb",
  "rpm",
  "appimage",
  "app",
];

/** Installer kinds that must be present per platform (issue #70). */
export const EXPECTED_INSTALLER_KINDS = {
  darwin: ["dmg", "app"],
  win32: ["msi", "exe"],
  linux: ["deb", "rpm", "appimage"],
};

/** Classify a publishable artifact name into an installer kind. */
export function installerKind(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".app.zip")) return "app";
  for (const kind of INSTALLER_KINDS) {
    if (lower.endsWith(`.${kind}`)) return kind;
  }
  return null;
}

/**
 * True when at least one expected installer kind is present among the
 * collected artifact names (issue #70). Unknown platforms fall back to
 * "any installer artifact".
 */
export function hasExpectedInstaller(platform, artifactNames) {
  const expected = EXPECTED_INSTALLER_KINDS[platform] ?? [];
  if (expected.length === 0) return artifactNames.length > 0;
  const present = new Set(
    artifactNames
      .map((name) => installerKind(name))
      .filter((kind) => kind !== null),
  );
  return expected.some((kind) => present.has(kind));
}

/**
 * Build and collect the release artifact set for the current platform.
 *
 * Rejects when the native bundle failed or produced no expected
 * installer, unless `allowNoBundle` is set (explicit local-only
 * exception). `spawn` is injectable so tests can simulate a failing
 * toolchain.
 */
export async function packageRelease({
  workspaceRoot,
  spawn = spawnSync,
  allowNoBundle = false,
  log = console,
}) {
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
  /** macOS DMG bundle directory (defined lazily for the zip fallback). */
  let dmgDir = undefined;

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
      "macos",
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

  /** Installer/bundle file name patterns that are publishable artifacts. */
  const INSTALLER_PATTERNS = [
    new RegExp(`\\.(${INSTALLER_KINDS.join("|")})$`, "iu"),
  ];

  async function collectArtifacts() {
    const artifacts = [];
    for (const root of bundleRoots()) {
      const entries = await readdir(root);
      for (const entry of entries) {
        // Skip build support files (bundle_dmg.sh, icons, raw images, ...).
        if (/^(bundle_|icon|rw\.|.*\.sh$)/iu.test(entry)) continue;
        const path = join(root, entry);
        const info = await stat(path);
        const publishable =
          info.isFile() &&
          INSTALLER_PATTERNS.some((pattern) => pattern.test(entry));
        if (publishable) {
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
    throw new Error(
      "desktop web build missing; run `pnpm build` first (or `pnpm release:package`)",
    );
  }

  try {
    log.log(
      `[release-package] tauri build (${platform}/${arch}, app ${version})`,
    );
    const result = spawn("pnpm", ["tauri", "build"], {
      cwd: desktopDirectory,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    bundle.attempted = true;
    bundle.ok = result.status === 0;
    if (!bundle.ok) {
      bundle.reason = `tauri build exited with status ${result.status ?? "signal"} (${result.signal ?? "none"})`;
      log.error(`[release-package] ${bundle.reason}`);
    } else {
      bundle.artifacts = (await collectArtifacts()).map(
        (artifact) => artifact.name,
      );
    }
  } catch (error) {
    bundle.attempted = true;
    bundle.ok = false;
    bundle.reason = `tauri build could not run: ${error.message}`;
    log.error(`[release-package] ${bundle.reason}`);
  }

  // macOS bundle finalization (plan S17.10): tauri's create-dmg step runs
  // an AppleScript "make Finder pretty" step that times out in headless/CI
  // sessions, and the DMG must embed the *signed* app. On macOS the package
  // flow therefore always (1) signs the freshly built .app bundle when a
  // signing identity is configured, (2) rebuilds the DMG from the bundle
  // with --skip-jenkins (headless-safe), and (3) continues; the .app zip
  // artifact is produced from the signed bundle during collection, so the
  // published checksums cover signed bytes end to end.
  if (platform === "darwin") {
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
      if (process.env.APPLE_SIGNING_IDENTITY) {
        const sign = spawn(
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
          spawn("codesign", ["--verify", "--deep", "--strict", appBundle], {
            stdio: "inherit",
          });
          log.log("[release-package] macOS app bundle signed");
        } else {
          log.error(
            "[release-package] codesign failed; publishing unsigned artifacts",
          );
        }
      }
      dmgDir = join(
        desktopDirectory,
        "src-tauri",
        "target",
        "release",
        "bundle",
        "dmg",
      );
      const dmgName = `Voxel Maker_${version}_${arch}.dmg`;
      // Stale raw images from failed attempts break hdiutil attach; remove them.
      for (const root of [join(dmgDir, "..", "macos"), dmgDir]) {
        try {
          for (const entry of await readdir(root)) {
            if (entry.startsWith("rw."))
              await rm(join(root, entry), { force: true });
          }
        } catch {
          // directory may not exist yet
        }
      }
      const script = join(dmgDir, "bundle_dmg.sh");
      if (existsSync(script)) {
        log.log(
          "[release-package] rebuilding DMG with --skip-jenkins (headless-safe)",
        );
        const dmg = spawn(
          "bash",
          [
            script,
            "--skip-jenkins",
            "--volname",
            "Voxel Maker",
            dmgName,
            dirname(appBundle),
          ],
          { cwd: dmgDir, stdio: "inherit" },
        );
        if (dmg.status === 0) {
          bundle.ok = true;
          bundle.reason = null;
          bundle.artifacts = (await collectArtifacts()).map((artifact) =>
            artifact.directory === true
              ? `${artifact.name}.zip`
              : artifact.name,
          );
          log.log("[release-package] DMG rebuild succeeded");
        } else {
          log.error(
            `[release-package] DMG rebuild failed (status ${dmg.status}); publishing without a DMG`,
          );
        }
      }
    }
  }

  // Issue #70: a native bundle failure or an installer collection without
  // any expected installer kind is fatal unless the explicit local-only
  // flag is set. CI/tag qualification must never upload or publish an
  // artifact set without a platform installer.
  const expectedInstallers = EXPECTED_INSTALLER_KINDS[platform] ?? [];
  const installerKinds = [
    ...new Set(
      bundle.artifacts
        .map((name) => installerKind(name))
        .filter((kind) => kind !== null),
    ),
  ].sort();
  if (
    !bundle.ok ||
    bundle.artifacts.length === 0 ||
    !hasExpectedInstaller(platform, bundle.artifacts)
  ) {
    const reason = !bundle.ok
      ? (bundle.reason ?? "tauri build failed")
      : bundle.artifacts.length === 0
        ? "tauri build produced no installer artifacts"
        : `no expected installer kind (${expectedInstallers.join(", ")}) among collected artifacts: ${bundle.artifacts.join(", ")}`;
    if (!allowNoBundle) {
      throw new Error(
        `native bundle failure is fatal: ${reason}; pass --allow-no-bundle (or RELEASE_ALLOW_NO_BUNDLE=1) for the local-only exception documented in docs/release/clean-machine-qualification-v1.md`,
      );
    }
    log.error(
      `[release-package] continuing without a native bundle (local-only exception): ${reason}`,
    );
  }

  await mkdir(outDirectory, { recursive: true });
  const artifacts = [];
  for (const artifact of await collectArtifacts()) {
    let name = artifact.name;
    let source = artifact.source;
    if (artifact.directory === true) {
      // .app bundles are directories; checksums need a single file, so the
      // published artifact is a ditto zip (preserves resource forks).
      const zipPath = join(dmgDir ?? outDirectory, `${artifact.name}.zip`);
      const ditto = spawn(
        "ditto",
        [
          "-c",
          "-k",
          "--sequesterRsrc",
          "--keepParent",
          artifact.source,
          zipPath,
        ],
        { stdio: "inherit" },
      );
      if (ditto.status !== 0) {
        if (!allowNoBundle) {
          throw new Error(
            `ditto failed for ${artifact.name} (status ${ditto.status}); the installer cannot be packaged`,
          );
        }
        log.error(
          `[release-package] ditto failed for ${artifact.name}; skipping (local-only exception)`,
        );
        continue;
      }
      name = `${artifact.name}.zip`;
      source = zipPath;
    }
    const destination = join(outDirectory, name);
    await copyFile(source, destination);
    const info = await stat(destination);
    artifacts.push({ name, bytes: info.size });
    log.log(`[release-package] artifact ${name} (${info.size} bytes)`);
  }

  // Headless CLI probes are released alongside installers so headless
  // qualification (smoke, recovery, persistence) runs from the artifact set
  // on a clean machine. Each probe is bundled by vite (SSR target) into ONE
  // self-contained file with the whole engine inlined, so a downloaded
  // artifact runs with nothing but Node installed.
  const HEADLESS_PROBES = [
    { entry: "cli.js", artifact: "headless-cli.js" },
    { entry: "persistence-cli.js", artifact: "headless-persistence-cli.js" },
    { entry: "recovery-cli.js", artifact: "headless-recovery-cli.js" },
    {
      entry: "release-smoke-cli.js",
      artifact: "headless-release-smoke-cli.js",
    },
  ];
  const bundleDirectory = join(outDirectory, "..", ".probe-bundle");
  for (const probe of HEADLESS_PROBES) {
    const entry = join(headlessDist, probe.entry);
    if (!existsSync(entry)) {
      log.error(`[release-package] headless probe missing: ${probe.entry}`);
      continue;
    }
    const { build } = await import("vite");
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        ssr: entry,
        outDir: bundleDirectory,
        emptyOutDir: true,
        rollupOptions: {
          output: { format: "es", entryFileNames: probe.artifact },
        },
      },
      ssr: { noExternal: [/@voxel-maker\//] },
    });
    const destination = join(outDirectory, probe.artifact);
    await copyFile(join(bundleDirectory, probe.artifact), destination);
    const info = await stat(destination);
    artifacts.push({ name: probe.artifact, bytes: info.size });
    log.log(
      `[release-package] artifact ${probe.artifact} (${info.size} bytes)`,
    );
  }
  await rm(bundleDirectory, { recursive: true, force: true });

  // Cargo SBOM (issue #74, plan §11.2 "SBOM/license generation"): the
  // CycloneDX SBOM over the Tauri crate's locked dependency tree is
  // mandatory release evidence and ships inside the artifact set,
  // checksummed and recorded in the manifest. A missing or failing SBOM
  // generation is fatal unless the explicit local-only flag is set
  // (the same exception pattern as the native bundle): a release
  // without dependency provenance must never be published.
  let sbom = { ok: false, reason: null };
  try {
    const sbomPath = generateCargoSbom({
      crateDir: join(desktopDirectory, "src-tauri"),
      outDir: outDirectory,
      spawn,
      log,
    });
    const sbomInfo = await stat(sbomPath);
    artifacts.push({ name: SBOM_FILE, bytes: sbomInfo.size });
    sbom = {
      ok: true,
      file: SBOM_FILE,
      format: "CycloneDX JSON",
      tool: "cargo-cyclonedx",
    };
    log.log(
      `[release-package] SBOM artifact ${SBOM_FILE} (${sbomInfo.size} bytes)`,
    );
  } catch (error) {
    sbom.reason = error.message;
    if (!allowNoBundle) {
      throw new Error(
        `Cargo SBOM generation failed and is fatal: ${error.message}`,
      );
    }
    log.error(
      `[release-package] continuing without a Cargo SBOM (local-only exception): ${error.message}`,
    );
  }

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
      expectedInstallers,
      installerKinds,
    },
    sbom: {
      ok: sbom.ok,
      ...(sbom.ok
        ? { file: sbom.file, format: sbom.format, tool: sbom.tool }
        : { reason: sbom.reason }),
    },
    artifacts: artifacts.sort((a, b) => a.name.localeCompare(b.name)),
    checksums: {
      file: "SHASUMS256.txt",
      entries: 0,
    },
    notes:
      "Checksums are SHA-256 over the exact artifact bytes. Verify with `pnpm release:verify-checksums`.",
  };
  await writeFile(
    join(outDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  log.log(
    `[release-package] manifest written to ${join(outDirectory, "manifest.json")}`,
  );
  const checksumCount = await writeChecksums(outDirectory);
  manifest.checksums.entries = checksumCount;
  await writeFile(
    join(outDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  log.log(
    `[release-package] artifact set complete: ${artifacts.length} files, ${checksumCount} checksum entries`,
  );
}

// CLI entry only when invoked directly (the module is imported by
// release-package.test.mjs for the packaging flow).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const allowNoBundle =
    process.argv.includes("--allow-no-bundle") ||
    process.env.RELEASE_ALLOW_NO_BUNDLE === "1";
  try {
    await packageRelease({
      workspaceRoot: process.cwd(),
      allowNoBundle,
    });
  } catch (error) {
    console.error(`[release-package] ${error.message}`);
    process.exitCode = 1;
  }
}
