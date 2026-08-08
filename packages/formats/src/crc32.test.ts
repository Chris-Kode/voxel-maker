import { describe, expect, it } from "vitest";
import { crc32, crc32Hex } from "./crc32.js";

const encoder = new TextEncoder();

describe("crc32", () => {
  it("matches the standard check value", () => {
    // The canonical CRC-32 check value (IEEE 802.3).
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf4_3926);
  });

  it("matches known short vectors", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32Hex(encoder.encode("hello world"))).toBe("0d4a1185");
    expect(crc32(encoder.encode("a"))).toBe(0xe8b7_be43);
  });

  it("is deterministic across calls", () => {
    const data = new Uint8Array([0, 1, 2, 3, 255, 254, 128, 7]);
    expect(crc32(data)).toBe(crc32(data.slice()));
  });

  it("sensitively depends on every byte", () => {
    const a = encoder.encode("voxel-maker");
    const b = encoder.encode("voxel-maker!");
    expect(crc32(a)).not.toBe(crc32(b));
  });
});
