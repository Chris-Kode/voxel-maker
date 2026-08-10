import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyChecksums, writeChecksums } from "./release-checksums.mjs";

const CHECKSUM_FILE = "SHASUMS256.txt";

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** A fresh artifact directory plus a sibling area outside it. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "voxel-checksums-"));
  const set = join(root, "set");
  await mkdir(set);
  return { root, set };
}

async function writeChecksumFile(set, lines) {
  await writeFile(join(set, CHECKSUM_FILE), `${lines.join("\n")}\n`);
}

async function readChecksumFile(set) {
  return readFile(join(set, CHECKSUM_FILE), "utf8");
}

// ---------------------------------------------------------------------------
// Normal sets
// ---------------------------------------------------------------------------

test("a set written by writeChecksums verifies cleanly", async () => {
  const { set } = await fixture();
  await writeFile(join(set, "a.bin"), "alpha\n");
  await writeFile(join(set, "b.bin"), "beta\n");
  assert.equal(await writeChecksums(set), 2);
  assert.deepEqual((await readChecksumFile(set)).trimEnd().split("\n"), [
    `${digest("alpha\n")}  a.bin`,
    `${digest("beta\n")}  b.bin`,
  ]);
  assert.deepEqual(await verifyChecksums(set), []);
});

test("empty lines and a trailing newline are tolerated", async () => {
  const { set } = await fixture();
  await writeFile(join(set, "a.bin"), "alpha\n");
  await writeChecksumFile(set, ["", `${digest("alpha\n")}  a.bin`, "", ""]);
  assert.deepEqual(await verifyChecksums(set), []);
});

// ---------------------------------------------------------------------------
// Path containment (issue #97)
// ---------------------------------------------------------------------------

test("a checksum entry naming a file outside the set is rejected", async () => {
  const { root, set } = await fixture();
  await writeFile(join(root, "secret"), "outside\n");
  await writeFile(join(set, "a.bin"), "alpha\n");
  await writeChecksumFile(set, [
    `${digest("alpha\n")}  a.bin`,
    `${digest("outside\n")}  ../secret`,
  ]);
  const failures = await verifyChecksums(set);
  assert.deepEqual(failures, [
    "../secret: invalid artifact name (name contains a path separator)",
  ]);
});

test("an absolute checksum entry is rejected", async () => {
  const { root, set } = await fixture();
  await writeFile(join(root, "secret"), "outside\n");
  await writeChecksumFile(set, [
    `${digest("outside\n")}  ${join(root, "secret")}`,
  ]);
  const failures = await verifyChecksums(set);
  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /: invalid artifact name \(name contains a path separator\)/,
  );
});

test("dot path segments are rejected", async () => {
  const { set } = await fixture();
  await writeChecksumFile(set, [
    `${"0".repeat(64)}  .`,
    `${"0".repeat(64)}  ..`,
  ]);
  const failures = await verifyChecksums(set);
  assert.equal(failures.length, 2);
  assert.ok(failures.every((f) => f.includes("invalid artifact name")));
});

test("names containing subdirectory or Windows separators are rejected", async () => {
  const { set } = await fixture();
  await writeChecksumFile(set, [
    `${"0".repeat(64)}  sub/file.bin`,
    `${"0".repeat(64)}  back\\slash.bin`,
  ]);
  const failures = await verifyChecksums(set);
  assert.equal(failures.length, 2);
  assert.ok(failures.every((f) => f.includes("invalid artifact name")));
});

test("the checksum file and metadata names are not valid artifact names", async () => {
  const { set } = await fixture();
  await writeChecksumFile(set, [
    `${"0".repeat(64)}  ${CHECKSUM_FILE}`,
    `${"0".repeat(64)}  manifest.json`,
  ]);
  const failures = await verifyChecksums(set);
  assert.equal(failures.length, 2);
  assert.ok(failures.every((f) => f.includes("invalid artifact name")));
});

test("a symlink inside the set that escapes it is rejected", async () => {
  const { root, set } = await fixture();
  await writeFile(join(root, "secret"), "outside\n");
  await symlink(join(root, "secret"), join(set, "leak.bin"));
  await writeChecksumFile(set, [`${digest("outside\n")}  leak.bin`]);
  const failures = await verifyChecksums(set);
  assert.deepEqual(failures, ["leak.bin: escapes the artifact directory"]);
});

// ---------------------------------------------------------------------------
// Entry shape (issue #97)
// ---------------------------------------------------------------------------

test("malformed lines (missing or extra fields) are rejected", async () => {
  const { set } = await fixture();
  await writeChecksumFile(set, [
    `${"0".repeat(64)}`,
    `${"0".repeat(64)}  a.bin  extra`,
  ]);
  const failures = await verifyChecksums(set);
  assert.equal(failures.length, 2);
  assert.ok(failures.every((f) => f.includes("malformed entry")));
});

test("hashes that are not exactly 64 lowercase hex digits are rejected", async () => {
  const { set } = await fixture();
  await writeChecksumFile(set, [
    "abc  a.bin",
    `${"z".repeat(64)}  b.bin`,
    `${"0".repeat(65)}  c.bin`,
    `${"A".repeat(64)}  d.bin`,
  ]);
  const failures = await verifyChecksums(set);
  assert.equal(failures.length, 4);
  assert.ok(failures.every((f) => f.includes("invalid checksum hash")));
});

test("duplicate artifact names are rejected", async () => {
  const { set } = await fixture();
  await writeFile(join(set, "a.bin"), "alpha\n");
  await writeChecksumFile(set, [
    `${digest("alpha\n")}  a.bin`,
    `${digest("alpha\n")}  a.bin`,
  ]);
  assert.deepEqual(await verifyChecksums(set), [
    "a.bin: duplicate checksum entry",
  ]);
});

// ---------------------------------------------------------------------------
// Set containment (issue #97)
// ---------------------------------------------------------------------------

test("a listed directory is reported as not a file", async () => {
  const { set } = await fixture();
  await mkdir(join(set, "subdir"));
  await writeChecksumFile(set, [`${"0".repeat(64)}  subdir`]);
  assert.deepEqual(await verifyChecksums(set), ["subdir: not a file"]);
});

test("a listed but absent artifact is reported missing", async () => {
  const { set } = await fixture();
  await writeChecksumFile(set, [`${"0".repeat(64)}  ghost.bin`]);
  assert.deepEqual(await verifyChecksums(set), ["ghost.bin: artifact missing"]);
});

test("a present but unlisted artifact is reported extra", async () => {
  const { set } = await fixture();
  await writeFile(join(set, "extra.bin"), "extra\n");
  await writeChecksumFile(set, [`${digest("extra\n")}  other.bin`]);
  assert.deepEqual(await verifyChecksums(set), [
    "other.bin: artifact missing",
    "extra.bin: artifact not listed in SHASUMS256.txt",
  ]);
});

test("a hash mismatch is reported", async () => {
  const { set } = await fixture();
  await writeFile(join(set, "a.bin"), "alpha\n");
  await writeChecksumFile(set, [`${"0".repeat(64)}  a.bin`]);
  const failures = await verifyChecksums(set);
  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /^a\.bin: checksum mismatch \(expected 0{64}, got /,
  );
});

// ---------------------------------------------------------------------------
// Writer consistency (issue #97)
// ---------------------------------------------------------------------------

test("the writer skips names that the verifier cannot accept", async () => {
  const { set } = await fixture();
  await writeFile(join(set, "ok.bin"), "ok\n");
  await writeFile(join(set, "back\\slash.bin"), "weird\n");
  await mkdir(join(set, "subdir"));
  assert.equal(await writeChecksums(set), 1);
  assert.deepEqual((await readChecksumFile(set)).trimEnd().split("\n"), [
    `${digest("ok\n")}  ok.bin`,
  ]);
});
