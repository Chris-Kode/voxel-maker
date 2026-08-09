import { WorkspaceError, type MaterialId } from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import type { VoxelEntry } from "@voxel-maker/voxel";

/**
 * Compact JSON-safe encoding of voxel entries for `volume.create` payloads
 * (ticket #24). The command bus budgets command payloads in canonical JSON
 * bytes, so raw coordinate/material objects would cap imports far below the
 * volume limits; the binary encoding carries the same data in 14 bytes per
 * voxel and keeps a full 1,000,000-voxel volume inside the transaction
 * envelope when split across commands.
 *
 * Layout (format 1, little-endian, 14 bytes per entry):
 *   offset  size  field
 *   0       4     x as signed 32-bit
 *   4       4     y as signed 32-bit
 *   8       4     z as signed 32-bit
 *   12      2     material as unsigned 16-bit
 *
 * The base64 string is produced by a self-contained codec so the package
 * stays platform-neutral (no Buffer dependency in the browser build).
 */

/** Current binary payload format version. */
export const VOLUME_ENTRY_PAYLOAD_FORMAT = 1 as const;

/** Encoded size of one entry in the format-1 payload. */
export const VOLUME_ENTRY_BINARY_BYTES = 14;

/** Maximum entries one payload may carry (ADR-0009 per-operation bound). */
export const MAX_VOLUME_ENTRY_PAYLOAD_COUNT = 1_000_000;

/** JSON payload shape carried by `volume.create`. */
export interface VolumeEntriesPayload {
  readonly format: typeof VOLUME_ENTRY_PAYLOAD_FORMAT;
  readonly count: number;
  /** Base64 (RFC 4648, no whitespace) of `count * 14` little-endian bytes. */
  readonly data: string;
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const base64Encode = (bytes: Uint8Array): string => {
  let out = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset] as number;
    const b = bytes[offset + 1];
    const c = bytes[offset + 2];
    out += BASE64_ALPHABET.charAt(a >> 2);
    out += BASE64_ALPHABET.charAt(((a & 0x03) << 4) | ((b ?? 0) >> 4));
    out +=
      b === undefined
        ? "="
        : BASE64_ALPHABET.charAt(((b & 0x0f) << 2) | ((c ?? 0) >> 6));
    out += c === undefined ? "=" : BASE64_ALPHABET.charAt(c & 0x3f);
  }
  return out;
};

const base64Decode = (
  value: string,
  path: readonly (string | number)[],
): Uint8Array => {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_BASE64",
      message: "Payload data must be a canonical base64 string",
      path,
    });
  }
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  const out = new Uint8Array((value.length / 4) * 3 - padding);
  let cursor = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const a = BASE64_ALPHABET.indexOf(value[offset] as string);
    const b = BASE64_ALPHABET.indexOf(value[offset + 1] as string);
    const cValue = value[offset + 2] as string;
    const dValue = value[offset + 3] as string;
    const c = cValue === "=" ? 0 : BASE64_ALPHABET.indexOf(cValue);
    const d = dValue === "=" ? 0 : BASE64_ALPHABET.indexOf(dValue);
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_BASE64",
        message: "Payload data must be a canonical base64 string",
        path,
      });
    }
    if (cursor < out.length) out[cursor] = (a << 2) | (b >> 4);
    if (cValue !== "=" && cursor + 1 < out.length)
      out[cursor + 1] = ((b & 0x0f) << 4) | (c >> 2);
    if (dValue !== "=" && cursor + 2 < out.length)
      out[cursor + 2] = ((c & 0x03) << 6) | d;
    cursor += 3;
  }
  return out;
};

/** Encodes entries into the compact payload shape. */
export function encodeVolumeEntries(
  entries: readonly VoxelEntry[],
): VolumeEntriesPayload {
  const bytes = new Uint8Array(entries.length * VOLUME_ENTRY_BINARY_BYTES);
  const view = new DataView(bytes.buffer);
  entries.forEach((entry, index) => {
    const offset = index * VOLUME_ENTRY_BINARY_BYTES;
    view.setInt32(offset, entry.coordinate[0], true);
    view.setInt32(offset + 4, entry.coordinate[1], true);
    view.setInt32(offset + 8, entry.coordinate[2], true);
    view.setUint16(offset + 12, entry.material, true);
  });
  return {
    format: VOLUME_ENTRY_PAYLOAD_FORMAT,
    count: entries.length,
    data: base64Encode(bytes),
  };
}

/**
 * Decodes and bounds a compact payload. Rejects unknown formats, declared
 * counts that exceed the per-operation voxel limit, and byte streams whose
 * length does not exactly match the declared count.
 */
export function decodeVolumeEntries(
  value: unknown,
  path: readonly (string | number)[],
): readonly VoxelEntry[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected an entries payload object",
      path,
    });
  }
  const record = value as Record<string, unknown>;
  if (record.format !== VOLUME_ENTRY_PAYLOAD_FORMAT) {
    throw new WorkspaceError({
      family: "compatibility",
      code: "UNSUPPORTED_PAYLOAD_FORMAT",
      message: `Unsupported volume entry payload format ${String(record.format)}`,
      path: [...path, "format"],
    });
  }
  if (
    typeof record.count !== "number" ||
    !Number.isSafeInteger(record.count) ||
    record.count < 0 ||
    record.count > MAX_VOLUME_ENTRY_PAYLOAD_COUNT
  ) {
    throw new WorkspaceError({
      family: "limit",
      code: "TOO_MANY_VOXELS",
      message: `Volume entry payload exceeds the limit of ${String(MAX_VOLUME_ENTRY_PAYLOAD_COUNT)} voxels`,
      path: [...path, "count"],
    });
  }
  if (typeof record.data !== "string") {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a base64 data string",
      path: [...path, "data"],
    });
  }
  const bytes = base64Decode(record.data, [...path, "data"]);
  if (bytes.byteLength !== record.count * VOLUME_ENTRY_BINARY_BYTES) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_PAYLOAD_LENGTH",
      message: "Entry payload byte length does not match the declared count",
      path,
      context: {
        declared: record.count,
        bytes: bytes.byteLength,
        perEntry: VOLUME_ENTRY_BINARY_BYTES,
      },
    });
  }
  const view = new DataView(bytes.buffer);
  const entries: VoxelEntry[] = [];
  for (let index = 0; index < record.count; index += 1) {
    const offset = index * VOLUME_ENTRY_BINARY_BYTES;
    const coordinate: Vec3i = [
      view.getInt32(offset, true),
      view.getInt32(offset + 4, true),
      view.getInt32(offset + 8, true),
    ];
    const material = view.getUint16(offset + 12, true) as MaterialId;
    entries.push({ coordinate, material });
  }
  return entries;
}
