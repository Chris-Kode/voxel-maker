import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectLicenses } from "./check-licenses.mjs";
import { scanContent, scanFile } from "./check-secrets.mjs";
import { auditFindings } from "./check-audit.mjs";

// ---------------------------------------------------------------------------
// License gate
// ---------------------------------------------------------------------------

async function licenseTree(packages) {
  const root = await mkdtemp(join(tmpdir(), "voxel-licenses-"));
  for (const [name, pkg] of Object.entries(packages)) {
    const dir = join(
      root,
      `node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`,
    );
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
  }
  return root;
}

test("license gate accepts allowlisted licenses", async () => {
  const root = await licenseTree({
    "good-mit": { name: "good-mit", version: "1.0.0", license: "MIT" },
    "good-array": {
      name: "good-array",
      version: "1.0.0",
      licenses: [{ type: "Apache-2.0" }, { type: "ISC" }],
    },
  });
  assert.deepEqual(await inspectLicenses(root), []);
});

test("license gate flags missing and forbidden licenses", async () => {
  const root = await licenseTree({
    "no-license": { name: "no-license", version: "1.0.0" },
    "bad-license": {
      name: "bad-license",
      version: "1.0.0",
      license: "GPL-3.0",
    },
    "see-file": {
      name: "see-file",
      version: "1.0.0",
      license: "SEE LICENSE IN LICENSE",
    },
  });
  const problems = await inspectLicenses(root);
  assert.ok(problems.some((problem) => problem.includes("no-license")));
  assert.ok(problems.some((problem) => problem.includes("bad-license")));
  assert.ok(problems.some((problem) => problem.includes("see-file")));
});

// ---------------------------------------------------------------------------
// Secret gate
// ---------------------------------------------------------------------------

test("secret scan flags keys, tokens, and private keys", () => {
  const cases = [
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow",
    "aws AKIA1234567890ABCDEF key",
    "token ghp_123456789012345678901234567890123456",
    "openai sk-abcdefghijklmnopqrstuvwxyz123456",
    `google AIza${"1".repeat(35)}`,
  ];
  for (const content of cases) {
    assert.ok(scanContent("file.txt", content).length > 0, content);
  }
  assert.deepEqual(scanContent("file.txt", "hello world"), []);
});

test("secret scan flags forbidden tracked file names", () => {
  assert.ok(scanFile(".env", "DATABASE_URL=x").length > 0);
  assert.ok(scanFile("keys/prod.pem", "x").length > 0);
  assert.ok(scanFile("certs/client.key", "x").length > 0);
  assert.deepEqual(scanFile("src/index.ts", "export const x = 1;"), []);
  assert.deepEqual(scanFile(".env.example", "DATABASE_URL=x"), []);
});

test("secret scan skips binary content", () => {
  assert.deepEqual(
    scanContent("blob.bin", "\0\0\0sk-abcdefghijklmnopqrstuvwxyz"),
    [],
  );
});

// ---------------------------------------------------------------------------
// Audit gate
// ---------------------------------------------------------------------------

test("audit gate extracts blocking findings by severity", () => {
  const report = {
    vulnerabilities: {
      "safe-pkg": { severity: "moderate", via: [{ url: "u1", title: "t1" }] },
      "bad-pkg": { severity: "high", via: [{ url: "u2", title: "t2" }] },
      "crit-pkg": { severity: "critical", via: [{ url: "u3", title: "t3" }] },
    },
  };
  const findings = auditFindings(report);
  const severities = findings.map((finding) => finding.severity).sort();
  assert.deepEqual(severities, ["critical", "high", "moderate"]);
});
