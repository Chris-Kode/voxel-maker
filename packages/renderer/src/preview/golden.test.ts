import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createPreviewFixtureStore } from "./preview-fixtures.js";
import { STANDARD_PREVIEW_VIEWS } from "./preview-protocol.js";
import { renderStandardPreview } from "./preview-renderer.js";

/**
 * Golden image tests (plan S8.5/S15.2, ticket #25): the exact exported
 * pixels of the representative fixture are locked to committed PNG files.
 * The goldens are decoded with an INDEPENDENT decoder (Node's zlib
 * inflate plus a local unfilter), so the renderer, the encoder, and the
 * fixtures all have to agree for the test to pass. The fixture covers
 * camera conventions (all four views), materials (red/blue opaque,
 * half-transparent green), and representative geometry (a 2x2x2 cube,
 * a scaled child-node cube, and a transparent voxel at a shared face).
 *
 * Regenerate the goldens only when the fixed protocol intentionally
 * changes: render each view at 96x96 and store `encodePng` output under
 * `golden/<view>.png` (see docs/renderer/preview-export-v1.md).
 */

const GOLDEN_SIZE = 96;

/** Reads and decodes a golden PNG into `width * height * 4` RGBA. */
function decodeGolden(view: string): Uint8Array {
  const bytes = readFileSync(new URL(`./golden/${view}.png`, import.meta.url));
  // PNG signature.
  expect([...bytes.subarray(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset < bytes.byteLength) {
    const viewData = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const length = viewData.getUint32(0);
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
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  expect(width).toBe(GOLDEN_SIZE);
  expect(height).toBe(GOLDEN_SIZE);
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
    expect(filter).toBe(0);
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const decoded = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const current = row[x] as number;
      const left = x >= 4 ? (decoded[x - 4] as number) : 0;
      const up = previous[x] as number;
      if (filter === 1) decoded[x] = (current + left) & 0xff;
      else if (filter === 2) decoded[x] = (current + up) & 0xff;
      else if (filter === 3) {
        decoded[x] = (current + ((left + up) >> 1)) & 0xff;
      } else if (filter === 4) {
        const upLeft = x >= 4 ? (previous[x - 4] as number) : 0;
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        decoded[x] = (current + predictor) & 0xff;
      } else {
        decoded[x] = current;
      }
    }
    rgba.set(decoded, y * stride);
    previous = decoded;
  }
  return rgba;
}

describe("standard preview golden images", () => {
  const store = createPreviewFixtureStore();

  for (const view of STANDARD_PREVIEW_VIEWS) {
    it(`matches the committed golden image for ${view}`, () => {
      const golden = decodeGolden(view);
      const result = renderStandardPreview({
        store,
        spec: { view, width: GOLDEN_SIZE, height: GOLDEN_SIZE },
      });
      expect(result.width).toBe(GOLDEN_SIZE);
      expect(result.height).toBe(GOLDEN_SIZE);
      expect([...result.rgba]).toEqual([...golden]);
    });
  }
});
