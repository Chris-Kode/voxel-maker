import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256.js";

function referenceSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const encoder = new TextEncoder();

describe("sha256Hex", () => {
  it("matches node:crypto for FIPS vectors and varied payloads", () => {
    const vectors = [
      "",
      "abc",
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "a".repeat(1_000_000),
      '{"documentId":"document:demo:0001","documentSchemaVersion":1}',
      "\u0000\u0001\u0002 binary-ish \uffff",
    ];
    for (const vector of vectors) {
      const bytes = encoder.encode(vector);
      expect(sha256Hex(bytes)).toBe(referenceSha256(bytes));
    }
    expect(sha256Hex(new Uint8Array([0, 1, 2, 3, 255]))).toBe(
      referenceSha256(new Uint8Array([0, 1, 2, 3, 255])),
    );
  });

  it("produces stable lowercase hex output", () => {
    expect(sha256Hex(encoder.encode(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
