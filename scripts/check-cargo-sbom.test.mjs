import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateCargoSbom, SBOM_FILE } from "./check-cargo-sbom.mjs";

test("generateCargoSbom runs cargo cyclonedx in the crate directory", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "voxel-sbom-"));
  const crateDir = await mkdtemp(join(tmpdir(), "voxel-crate-"));
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    // The real tool writes <override>.json into the crate directory;
    // the fake records the invocation and writes the file the same way.
    writeFileSync(join(crateDir, "sbom.cdx.json"), "{}");
    return {
      status: 0,
      signal: null,
      error: undefined,
      stdout: "",
      stderr: "",
    };
  };
  const sbomPath = generateCargoSbom({ crateDir, outDir, spawn });
  assert.equal(sbomPath, join(outDir, SBOM_FILE));
  assert.equal(existsSync(sbomPath), true);
  assert.deepEqual(calls, [
    {
      command: "cargo",
      args: [
        "cyclonedx",
        "--format",
        "json",
        "--override-filename",
        "sbom.cdx",
      ],
      options: { cwd: crateDir, encoding: "utf8", maxBuffer: 67108864 },
    },
  ]);
});

test("generateCargoSbom fails when cargo cyclonedx exits non-zero", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "voxel-sbom-"));
  const crateDir = await mkdtemp(join(tmpdir(), "voxel-crate-"));
  const spawn = () => ({
    status: 1,
    signal: null,
    error: undefined,
    stdout: "",
    stderr: "cyclonedx exploded",
  });
  assert.throws(
    () => generateCargoSbom({ crateDir, outDir, spawn }),
    /cargo cyclonedx exited with status 1/,
  );
});

test("generateCargoSbom surfaces spawn errors (missing cargo-cyclonedx)", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "voxel-sbom-"));
  const crateDir = await mkdtemp(join(tmpdir(), "voxel-crate-"));
  const spawn = () => ({ error: new Error("spawn cargo ENOENT") });
  assert.throws(
    () => generateCargoSbom({ crateDir, outDir, spawn }),
    /spawn cargo ENOENT/,
  );
});

test("generateCargoSbom fails when the SBOM file is not produced", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "voxel-sbom-"));
  const crateDir = await mkdtemp(join(tmpdir(), "voxel-crate-"));
  const spawn = () => ({
    status: 0,
    signal: null,
    error: undefined,
    stdout: "",
    stderr: "",
  });
  assert.throws(
    () => generateCargoSbom({ crateDir, outDir, spawn }),
    /SBOM file .* was not produced/,
  );
});
