import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EXPECTED_INSTALLER_KINDS,
  hasExpectedInstaller,
  installerKind,
  packageRelease,
} from "./release-package.mjs";

const HEADLESS_PROBES = [
  "cli.js",
  "persistence-cli.js",
  "recovery-cli.js",
  "release-smoke-cli.js",
];

/** Minimal valid web/headless dist tree for the packaging flow. */
async function packageTree() {
  const root = await mkdtemp(join(tmpdir(), "voxel-release-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "voxel-maker", version: "0.1.0" }),
  );
  await mkdir(join(root, "apps/desktop/dist"), { recursive: true });
  await writeFile(
    join(root, "apps/desktop/dist/index.html"),
    "<html></html>\n",
  );
  await mkdir(join(root, "apps/headless/dist"), { recursive: true });
  for (const probe of HEADLESS_PROBES) {
    await writeFile(
      join(root, "apps/headless/dist", probe),
      "export const probe = 1;\n",
    );
  }
  return root;
}

/** Fake spawn that records invocations and returns a fixed status. */
function fakeSpawn(status) {
  return () => ({ status, signal: null, error: undefined });
}

function artifactSet(root) {
  return join(root, "release", "artifacts", "0.1.0");
}

// ---------------------------------------------------------------------------
// Installer-kind helpers (issue #70)
// ---------------------------------------------------------------------------

test("installerKind classifies publishable installer names", () => {
  assert.equal(installerKind("Voxel Maker_0.1.0_aarch64.dmg"), "dmg");
  assert.equal(installerKind("Voxel Maker_0.1.0_aarch64.pkg"), "pkg");
  assert.equal(installerKind("Voxel Maker.app"), "app");
  assert.equal(installerKind("Voxel Maker.app.zip"), "app");
  assert.equal(installerKind("voxel-maker_0.1.0_x64.msi"), "msi");
  assert.equal(installerKind("voxel-maker_0.1.0_x64-setup.exe"), "exe");
  assert.equal(installerKind("voxel-maker_0.1.0_amd64.deb"), "deb");
  assert.equal(installerKind("voxel-maker-0.1.0-1.x86_64.rpm"), "rpm");
  assert.equal(installerKind("voxel-maker_0.1.0_amd64.AppImage"), "appimage");
  assert.equal(installerKind("headless-cli.js"), null);
  assert.equal(installerKind("manifest.json"), null);
});

test("hasExpectedInstaller accepts any expected kind per platform", () => {
  assert.equal(
    hasExpectedInstaller("darwin", [
      "Voxel Maker.app.zip",
      "Voxel Maker_0.1.0_aarch64.dmg",
    ]),
    true,
  );
  assert.equal(hasExpectedInstaller("darwin", ["Voxel Maker.app.zip"]), true);
  assert.equal(hasExpectedInstaller("darwin", ["headless-cli.js"]), false);
  assert.equal(
    hasExpectedInstaller("win32", [
      "voxel-maker_0.1.0_x64.msi",
      "voxel-maker_0.1.0_x64-setup.exe",
    ]),
    true,
  );
  assert.equal(
    hasExpectedInstaller("win32", ["voxel-maker_0.1.0_x64.msi"]),
    true,
  );
  assert.equal(
    hasExpectedInstaller("win32", ["voxel-maker_0.1.0_amd64.deb"]),
    false,
  );
  assert.equal(
    hasExpectedInstaller("linux", [
      "voxel-maker_0.1.0_amd64.deb",
      "voxel-maker-0.1.0-1.x86_64.rpm",
      "voxel-maker_0.1.0_amd64.AppImage",
    ]),
    true,
  );
  assert.equal(
    hasExpectedInstaller("linux", ["voxel-maker_0.1.0_amd64.deb"]),
    true,
  );
  assert.equal(
    hasExpectedInstaller("linux", ["voxel-maker_0.1.0_x64.msi"]),
    false,
  );
});

// ---------------------------------------------------------------------------
// Native bundle failure is fatal (issue #70)
// ---------------------------------------------------------------------------

test("a failing tauri build makes packageRelease reject and writes no set", async () => {
  const root = await packageTree();
  await assert.rejects(
    packageRelease({ workspaceRoot: root, spawn: fakeSpawn(17) }),
    /native bundle failure is fatal/,
  );
  assert.equal(existsSync(artifactSet(root)), false);
});

test("an empty installer collection makes packageRelease reject", async () => {
  const root = await packageTree();
  await assert.rejects(
    packageRelease({ workspaceRoot: root, spawn: fakeSpawn(0) }),
    /native bundle failure is fatal/,
  );
  assert.equal(existsSync(artifactSet(root)), false);
});

test("a set without an expected installer kind makes packageRelease reject", async () => {
  const root = await packageTree();
  const allKinds = Object.values(EXPECTED_INSTALLER_KINDS).flat();
  const unexpected = allKinds.find(
    (kind) => !EXPECTED_INSTALLER_KINDS[process.platform].includes(kind),
  );
  const bundleDir = join(
    root,
    "apps/desktop/src-tauri/target/release/bundle",
    unexpected,
  );
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, `artifact.${unexpected}`), "x");
  await assert.rejects(
    packageRelease({ workspaceRoot: root, spawn: fakeSpawn(0) }),
    /native bundle failure is fatal/,
  );
  assert.equal(existsSync(artifactSet(root)), false);
});

test("a ditto failure is fatal: a declared installer that cannot be packaged", async () => {
  const root = await packageTree();
  const bundle = join(root, "apps/desktop/src-tauri/target/release/bundle");
  // Satisfy the platform's expected kinds so the early invariant passes,
  // then add an .app directory that must be ditto-zipped during copy.
  for (const kind of EXPECTED_INSTALLER_KINDS[process.platform]) {
    const dir = join(bundle, kind);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `installer.${kind}`), "x");
  }
  await mkdir(join(bundle, "app", "Foo.app", "Contents"), { recursive: true });
  await writeFile(
    join(bundle, "app", "Foo.app", "Contents", "Info.plist"),
    "<plist/>",
  );
  const spawn = (command) =>
    command === "ditto"
      ? { status: 1, signal: null, error: undefined }
      : { status: 0, signal: null, error: undefined };
  await assert.rejects(
    packageRelease({ workspaceRoot: root, spawn }),
    /ditto failed for Foo.app/,
  );
  // The failure happens after the output directory is created but before
  // any manifest/checksums are written, so no artifact set is published.
  assert.equal(existsSync(join(artifactSet(root), "manifest.json")), false);
});

test("the explicit local-only flag keeps the documented exception path", async () => {
  const root = await packageTree();
  await packageRelease({
    workspaceRoot: root,
    spawn: fakeSpawn(17),
    allowNoBundle: true,
  });
  const manifest = JSON.parse(
    await readFile(join(artifactSet(root), "manifest.json"), "utf8"),
  );
  assert.equal(manifest.bundle.ok, false);
  assert.match(manifest.bundle.reason, /status 17/);
  assert.deepEqual(manifest.bundle.artifacts, []);
  assert.deepEqual(
    manifest.bundle.expectedInstallers,
    EXPECTED_INSTALLER_KINDS[process.platform],
  );
  assert.deepEqual(manifest.bundle.installerKinds, []);
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.name),
    [
      "headless-cli.js",
      "headless-persistence-cli.js",
      "headless-recovery-cli.js",
      "headless-release-smoke-cli.js",
    ],
  );
});
