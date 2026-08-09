import {
  WorkspaceError,
  PREVIEW_IMAGE_MAX_DIMENSION,
  PREVIEW_IMAGE_MAX_PIXELS,
} from "@voxel-maker/shared";
import { crc32 } from "./crc32.js";

/**
 * Deterministic PNG encoder (plan S8.5/S15.2, ticket #25): RGBA pixels to
 * a byte-exact, browser-safe PNG without any native or third-party codec.
 *
 * PNG 1.2 (RGBA8, color type 6, bit depth 8, no interlace, filter 0 on
 * every scanline) is wrapped in a stored ("no compression") DEFLATE
 * stream: each scanline is prefixed with its filter byte, the stream is
 * split into 65535-byte stored blocks, and the zlib wrapper carries the
 * RFC 1950 header and Adler-32 checksum. Stored blocks keep the encoder
 * dependency-free and deterministic across Node and the Tauri webview;
 * real compression is a documented follow-up behind this seam (the
 * decoder-facing bytes are identical either way).
 *
 * Every input is validated and bounded before allocation: dimensions are
 * positive integers within `PNG_MAX_DIMENSION` and the total pixel count
 * is bounded by `PNG_MAX_PIXELS` (ADR-0009-style limits, ARCHITECTURE.md
 * "preview image 2048x2048 and 16 MiB decoded RGBA").
 */

/** Maximum width or height of one encoded image (ARCHITECTURE.md). */
export const PNG_MAX_DIMENSION = PREVIEW_IMAGE_MAX_DIMENSION;

/** Maximum total pixels of one encoded image (16 MiB decoded RGBA). */
export const PNG_MAX_PIXELS = PREVIEW_IMAGE_MAX_PIXELS;

/** The raw RGBA row length for one scanline including its filter byte. */
const ROW_STRIDE_OFFSET = 1;

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

/** Maximum payload of one stored DEFLATE block (65535 bytes). */
const STORED_BLOCK_MAX = 0xffff;

/** zlib stream header: CMF=8 (deflate), FLG=0x01 (no dict, FCHECK valid). */
const ZLIB_HEADER = Uint8Array.of(0x78, 0x01);

/** Validates dimensions and the pixel buffer before any allocation. */
export function validatePngInput(
  rgba: Uint8Array,
  width: number,
  height: number,
): void {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_IMAGE_DIMENSIONS",
      message: `PNG dimensions must be integers, got ${String(width)}x${String(height)}`,
      context: { width, height },
    });
  }
  if (width < 1 || height < 1) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_IMAGE_DIMENSIONS",
      message: `PNG dimensions must be positive, got ${String(width)}x${String(height)}`,
      context: { width, height },
    });
  }
  if (width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION) {
    throw new WorkspaceError({
      family: "limit",
      code: "IMAGE_DIMENSION_LIMIT",
      message: `PNG dimensions exceed the ${String(PNG_MAX_DIMENSION)}px limit: ${String(width)}x${String(height)}`,
      context: { width, height },
    });
  }
  if (width * height > PNG_MAX_PIXELS) {
    throw new WorkspaceError({
      family: "limit",
      code: "IMAGE_PIXEL_LIMIT",
      message: `PNG pixel count exceeds the ${String(PNG_MAX_PIXELS)}px limit: ${String(width * height)}`,
      context: { width, height },
    });
  }
  if (rgba.byteLength !== width * height * 4) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_IMAGE_BUFFER_LENGTH",
      message: `PNG buffer holds ${String(rgba.byteLength)} bytes, expected ${String(width * height * 4)} for ${String(width)}x${String(height)} RGBA`,
      context: { width, height },
    });
  }
}

/** Adler-32 (RFC 1950) over the raw scanline bytes. */
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < data.byteLength; i += 1) {
    a = (a + (data[i] as number)) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** Appends one PNG chunk (length, type, data, CRC-32 over type+data). */
function appendChunk(out: number[], type: string, data: Uint8Array): void {
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = new Uint8Array(typeBytes.byteLength + data.byteLength);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.byteLength);
  const crc = crc32(crcInput);
  pushUint32(out, data.byteLength);
  for (const byte of typeBytes) out.push(byte);
  for (const byte of data) out.push(byte);
  pushUint32(out, crc);
}

function pushUint32(out: number[], value: number): void {
  out.push(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

/**
 * Builds the stored-DEFLATE zlib stream for the raw scanline bytes:
 * `0x78 0x01`, 65535-byte stored blocks (final block flagged), Adler-32.
 */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.byteLength / STORED_BLOCK_MAX));
  const out = new Uint8Array(2 + blocks * 5 + raw.byteLength + 4);
  out.set(ZLIB_HEADER, 0);
  let offset = 2;
  let rawOffset = 0;
  for (let block = 0; block < blocks; block += 1) {
    const length = Math.min(STORED_BLOCK_MAX, raw.byteLength - rawOffset);
    const final = block === blocks - 1 ? 1 : 0;
    out[offset] = final;
    offset += 1;
    out[offset] = length & 0xff;
    out[offset + 1] = (length >>> 8) & 0xff;
    out[offset + 2] = ~length & 0xff;
    out[offset + 3] = (~length >>> 8) & 0xff;
    offset += 4;
    out.set(raw.subarray(rawOffset, rawOffset + length), offset);
    offset += length;
    rawOffset += length;
  }
  const checksum = adler32(raw);
  out[offset] = (checksum >>> 24) & 0xff;
  out[offset + 1] = (checksum >>> 16) & 0xff;
  out[offset + 2] = (checksum >>> 8) & 0xff;
  out[offset + 3] = checksum & 0xff;
  return out;
}

/** Encodes RGBA8 pixels as a byte-exact PNG image (filter 0, stored DEFLATE). */
export function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  validatePngInput(rgba, width, height);

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const raw = new Uint8Array(height * (width * 4 + ROW_STRIDE_OFFSET));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + ROW_STRIDE_OFFSET);
    raw[rowStart] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }
  const idat = zlibStored(raw);

  const chunks: number[] = [];
  appendChunk(chunks, "IHDR", ihdr);
  appendChunk(chunks, "IDAT", idat);
  appendChunk(chunks, "IEND", new Uint8Array(0));

  const out = new Uint8Array(PNG_SIGNATURE.byteLength + chunks.length);
  out.set(PNG_SIGNATURE, 0);
  out.set(chunks, PNG_SIGNATURE.byteLength);
  return out;
}
