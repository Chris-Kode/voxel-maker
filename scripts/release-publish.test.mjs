import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import test from "node:test";
import { listFiles, prepareReleaseAssets } from "./release-publish.mjs";

const SHA = "a".repeat(40);
const VERSION = "0.1.0";

/** Installer names are platform-specific; the rest collide across sets. */
const PLATFORM_SETS = {
  macos: { arch: "arm64", installers: ["Voxel Maker_0.1.0_aarch64.dmg"] },
  windows: { arch: "x64", installers: ["Voxel Maker_0.1.0_x64.msi"] },
  linux: { arch: "x64", installers: ["voxel-maker_0.1.0_amd64.deb"] },
};
const SHARED_FILES = [
  "headless-cli.js",
  "headless-persistence-cli.js",
  "headless-recovery-cli.js",
  "headless-release-smoke-cli.js",
  "sbom.cdx.json",
];

/**
 * A three-platform fixture in the exact layout the tag workflow produces:
 * artifacts/<artifact-name>/<version>/<files> (upload-artifact preserves
 * the path hierarchy under release/artifacts, download-artifact keeps
 * each set in its own directory).
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "voxel-release-publish-"));
  for (const [platform, { arch, installers }] of Object.entries(
    PLATFORM_SETS,
  )) {
    const setRoot = join(root, `voxel-maker-${platform}-${SHA}`, VERSION);
    await mkdir(setRoot, { recursive: true });
    const names = [...installers, ...SHARED_FILES];
    for (const name of names) {
      await writeFile(join(setRoot, name), `${platform}/${name}\n`);
    }
    await writeFile(
      join(setRoot, "manifest.json"),
      `${JSON.stringify(
        {
          release: VERSION,
          platform,
          arch,
          bundle: { attempted: true, ok: true, artifacts: installers },
          sbom: {
            ok: true,
            file: "sbom.cdx.json",
            format: "CycloneDX JSON",
            tool: "cargo-cyclonedx",
          },
          artifacts: names.map((name) => ({ name, bytes: name.length })),
          checksums: { file: "SHASUMS256.txt", entries: names.length },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(setRoot, "SHASUMS256.txt"),
      `${names.map((name) => `${"0".repeat(64)}  ${name}`).join("\n")}\n`,
    );
  }
  return root;
}

/** The prefix every published asset of a platform set must carry. */
function prefixOf(platform) {
  return `${platform}-${PLATFORM_SETS[platform].arch}`;
}

test("every published asset name is unique and attributable to a platform", async () => {
  const root = await fixture();
  const files = await prepareReleaseAssets(root);
  const names = files.map((file) => basename(file));
  assert.equal(
    new Set(names).size,
    names.length,
    "duplicate asset names collide in GitHub's flat release-asset namespace",
  );
  for (const name of names) {
    const platform = name.slice(0, name.indexOf("-"));
    assert.ok(
      platform in PLATFORM_SETS,
      `asset ${name} is not attributable to a platform`,
    );
    assert.ok(
      name.startsWith(prefixOf(platform)),
      `asset ${name} is not attributable to a platform/arch`,
    );
  }
});

test("checksums and manifest are regenerated to name the published files", async () => {
  const root = await fixture();
  await prepareReleaseAssets(root);
  for (const platform of Object.keys(PLATFORM_SETS)) {
    const prefix = prefixOf(platform);
    const setRoot = join(root, `voxel-maker-${platform}-${SHA}`, VERSION);
    const checksums = await readFile(
      join(setRoot, `${prefix}-SHASUMS256.txt`),
      "utf8",
    );
    const listed = checksums
      .trim()
      .split("\n")
      .map((line) => {
        const [, ...nameParts] = line.trim().split(/\s+/u);
        return nameParts.join(" ");
      });
    assert.ok(
      listed.every((name) => name.startsWith(`${prefix}-`)),
      `${platform} checksums must list the published (prefixed) names`,
    );
    assert.ok(
      !listed.includes(`${prefix}-SHASUMS256.txt`),
      "the checksum file must not list itself",
    );
    const manifest = JSON.parse(
      await readFile(join(setRoot, `${prefix}-manifest.json`), "utf8"),
    );
    assert.ok(
      manifest.artifacts.every((artifact) =>
        artifact.name.startsWith(`${prefix}-`),
      ),
      `${platform} manifest must name the published artifacts`,
    );
    assert.ok(
      manifest.bundle.artifacts.every((name) => name.startsWith(`${prefix}-`)),
      `${platform} manifest bundle artifacts must be prefixed too`,
    );
    assert.equal(manifest.checksums.file, `${prefix}-SHASUMS256.txt`);
    assert.equal(manifest.sbom.file, `${prefix}-sbom.cdx.json`);
  }
});

test("the returned upload list matches the prepared files on disk", async () => {
  const root = await fixture();
  const files = await prepareReleaseAssets(root);
  const expected = (await listFiles(root)).sort();
  assert.deepEqual([...files].sort(), expected);
  assert.equal(files.length, 3 * (1 + SHARED_FILES.length + 2));
});

test("a set directory that does not match the platform pattern fails loudly", async () => {
  const root = await fixture();
  await mkdir(join(root, "not-a-platform-set"), { recursive: true });
  await assert.rejects(prepareReleaseAssets(root), /does not match/u);
});

test("duplicate basenames inside one set fail loudly", async () => {
  const root = await fixture();
  const setRoot = join(root, `voxel-maker-macos-${SHA}`, VERSION);
  await mkdir(join(setRoot, "nested"), { recursive: true });
  await writeFile(join(setRoot, "nested", "headless-cli.js"), "duplicate\n");
  await assert.rejects(prepareReleaseAssets(root), /duplicate basename/u);
});

test("a three-platform fixture publishes one release successfully (stub gh)", async () => {
  const root = await fixture();
  // Run the CLI exactly as the workflow does, then feed the file list to a
  // stub `gh` that rejects duplicate asset names like the GitHub API does.
  const cli = join(import.meta.dirname, "release-publish.mjs");
  const prepared = spawnSync(process.execPath, [cli, root], {
    encoding: "utf8",
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const files = prepared.stdout.trim().split("\n");

  const bin = await mkdtemp(join(tmpdir(), "voxel-gh-stub-"));
  const ghStub = join(bin, "gh");
  await writeFile(
    ghStub,
    `#!/usr/bin/env node
const { existsSync } = require("node:fs");
const { basename } = require("node:path");
const names = new Set();
for (const arg of process.argv.slice(2)) {
  if (existsSync(arg)) {
    const name = basename(arg);
    if (names.has(name)) {
      console.error("gh: duplicate asset name: " + name);
      process.exit(1);
    }
    names.add(name);
  }
}
console.log("gh: release created with " + names.size + " assets");
`,
  );
  await chmod(ghStub, 0o755);
  const published = spawnSync(
    "gh",
    [
      "v0.1.0",
      ...files,
      "--repo",
      "example/voxel-maker",
      "--title",
      "Voxel Maker v0.1.0",
      "--notes",
      "release notes",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    },
  );
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.stdout, /release created with 24 assets/u);
});
