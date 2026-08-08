import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalDocumentHash, parseDocument } from "@voxel-maker/model";
import { runHeadlessTrace } from "./index.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const DEMO_HASH =
  "165ab842532806fbf0677a367b2b43ac188c1d5e009bf212e74944df17c93b24";

describe("headless workspace tracer", () => {
  it("round-trips a versioned document deterministically", () => {
    const output = runHeadlessTrace();
    const parsed = JSON.parse(output) as {
      command: {
        accepted: boolean;
        transactionId: string;
        revisionAfter: number;
      };
      document: {
        documentId: string;
        hash: string;
        nodeCount: number;
        reloadedHash: string;
        roundTripStable: boolean;
      };
      serialized: string;
      voxel: { chunk: number[]; local: number[]; material: number };
      edit: {
        afterSet: number;
        afterUndo: number;
        afterRedo: number;
        revisions: number[];
      };
    };
    expect(parsed.command).toEqual({
      accepted: true,
      transactionId: "transaction:demo:set:0001",
      revisionAfter: 1,
    });
    expect(parsed.document).toEqual({
      documentId: "document:demo:0001",
      hash: DEMO_HASH,
      nodeCount: 2,
      reloadedHash: DEMO_HASH,
      roundTripStable: true,
    });
    expect(typeof parsed.serialized).toBe("string");
    expect(parsed.voxel).toEqual({
      chunk: [-1, 0, 0],
      local: [15, 0, 1],
      material: 1,
    });
    expect(parsed.edit).toEqual({
      afterSet: 1,
      afterUndo: 0,
      afterRedo: 1,
      revisions: [1, 2, 3],
    });
    expect(canonicalDocumentHash(parseDocument(parsed.serialized))).toBe(
      parsed.document.hash,
    );
    expect(runHeadlessTrace()).toBe(output);
  });

  it("serializes byte-identically across fresh processes", () => {
    const first = execFileSync(process.execPath, [CLI_PATH], {
      encoding: "utf8",
    });
    const second = execFileSync(process.execPath, [CLI_PATH], {
      encoding: "utf8",
    });
    expect(first).toBe(second);
    expect(first).toContain('"roundTripStable":true');
    expect(first).toContain('"revisions":[1,2,3]');
  });
});
