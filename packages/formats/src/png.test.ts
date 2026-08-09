import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { WorkspaceError } from "@voxel-maker/shared";
import { encodePng, PNG_MAX_DIMENSION, validatePngInput } from "./png.js";

/**
 * PNG encoder tests (plan S8.5/S15.2, ticket #25). The encoder is
 * dependency-free and byte-exact; these tests verify validity with an
 * INDEPENDENT decoder (Node's zlib inflate + a local unfilter) so a
 * self-consistent encoder/decoder bug cannot pass. Determinism and the
 * bounded-input contract are asserted directly.
 */

/** Minimal PNG reader: signature + chunks; independent of the encoder. */
interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const PNG_SIGNATURE = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
);

function decodePng(bytes: Uint8Array): DecodedPng {
  expect([...bytes.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (offset < bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const length = view.getUint32(0);
    const type = new TextDecoder().decode(
      bytes.subarray(offset + 4, offset + 8),
    );
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      const header = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      width = header.getUint32(0);
      height = header.getUint32(4);
      bitDepth = data[8] as number;
      colorType = data[9] as number;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  expect(bitDepth).toBe(8);
  expect(colorType).toBe(6);
  const joined = new Uint8Array(
    idat.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let at = 0;
  for (const part of idat) {
    joined.set(part, at);
    at += part.byteLength;
  }
  const raw = inflateSync(joined);
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const decoded = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const current = row[x] as number;
      const left = x >= 4 ? (decoded[x - 4] as number) : 0;
      const up = previous[x] as number;
      const upLeft = x >= 4 ? (previous[x - 4] as number) : 0;
      let value = current;
      if (filter === 1) value = (current + left) & 0xff;
      else if (filter === 2) value = (current + up) & 0xff;
      else if (filter === 3) value = (current + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        value = (current + predictor) & 0xff;
      } else {
        expect(filter).toBe(0);
      }
      decoded[x] = value;
    }
    rgba.set(decoded, y * stride);
    previous = decoded;
  }
  return { width, height, rgba };
}

/** Deterministic 2x2 RGBA pattern exercising alpha and color channels. */
function pattern2x2(): Uint8Array {
  return Uint8Array.of(
    255,
    0,
    0,
    255, // red
    0,
    255,
    0,
    128, // half-transparent green
    0,
    0,
    255,
    255, // blue
    255,
    255,
    255,
    0, // fully transparent white
  );
}

describe("encodePng", () => {
  it("round-trips through an independent decoder", () => {
    const pixels = pattern2x2();
    const encoded = encodePng(pixels, 2, 2);
    const decoded = decodePng(encoded);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect([...decoded.rgba]).toEqual([...pixels]);
  });

  it("round-trips an odd-size image", () => {
    const width = 17;
    const height = 3;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 7) & 0xff;
    const decoded = decodePng(encodePng(pixels, width, height));
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect([...decoded.rgba]).toEqual([...pixels]);
  });

  it("splits large payloads across multiple stored blocks", () => {
    // 2048x10 raw scanlines exceed the 65535-byte stored block limit.
    // The work is ~10ms; the 20s budget below keeps a loaded CI runner
    // (turbo runs every package's suite concurrently) from flaking.
    const width = PNG_MAX_DIMENSION;
    const height = 10;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 13) & 0xff;
    const decoded = decodePng(encodePng(pixels, width, height));
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect([...decoded.rgba]).toEqual([...pixels]);
  }, 20_000);

  it("is byte-deterministic", () => {
    const pixels = pattern2x2();
    const first = encodePng(pixels, 2, 2);
    const second = encodePng(pixels, 2, 2);
    expect([...first]).toEqual([...second]);
  });

  it("produces the canonical PNG structure", () => {
    const encoded = encodePng(pattern2x2(), 2, 2);
    expect([...encoded.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    // IHDR: length 13 at offset 8, type at 12, data (width/height) at 16.
    const header = new DataView(encoded.buffer, encoded.byteOffset + 8, 21);
    expect(header.getUint32(0)).toBe(13);
    expect(new TextDecoder().decode(encoded.subarray(12, 16))).toBe("IHDR");
    expect(header.getUint32(8)).toBe(2);
    expect(header.getUint32(12)).toBe(2);
    // IEND terminates the file.
    expect(
      new TextDecoder().decode(
        encoded.subarray(encoded.length - 8, encoded.length - 4),
      ),
    ).toBe("IEND");
  });

  it("rejects non-integer, zero, oversized, and mismatched inputs", () => {
    const pixels = pattern2x2();
    expect(() => encodePng(pixels, 2.5, 2)).toThrow(/integers/);
    expect(() => encodePng(pixels, 0, 2)).toThrow(/positive/);
    expect(() => encodePng(pixels, -2, 2)).toThrow(/positive/);
    expect(() => encodePng(pixels, PNG_MAX_DIMENSION + 1, 2)).toThrow(/limit/);
    expect(() => encodePng(pixels, 2, PNG_MAX_DIMENSION + 1)).toThrow(/limit/);
    expect(() => encodePng(new Uint8Array(15), 2, 2)).toThrow(/expected 16/);
  });

  it("throws structured WorkspaceError codes for rejected inputs", () => {
    let caught: unknown;
    try {
      validatePngInput(pattern2x2(), PNG_MAX_DIMENSION + 1, 2);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceError);
    expect((caught as WorkspaceError).family).toBe("limit");
    expect((caught as WorkspaceError).code).toBe("IMAGE_DIMENSION_LIMIT");
    let bufferError: unknown;
    try {
      validatePngInput(new Uint8Array(15), 2, 2);
    } catch (error) {
      bufferError = error;
    }
    expect((bufferError as WorkspaceError).code).toBe(
      "INVALID_IMAGE_BUFFER_LENGTH",
    );
  });
});
