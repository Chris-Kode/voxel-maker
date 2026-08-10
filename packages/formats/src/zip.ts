import {
  INPUT_FILE_LIMIT_EXCEEDED,
  INPUT_FILE_MAX_BYTES,
  WorkspaceError,
} from "@voxel-maker/shared";
import { crc32 } from "./crc32.js";
import { assertNotAboveDefault } from "./limits.js";

/**
 * Deterministic stored-entry ZIP archive codec (plan S5.4/S5.5, ADR-0004).
 * The writer emits only stored (uncompressed) entries with normalized
 * metadata — zero DOS timestamp, no extra fields, no comments, ASCII names,
 * UTF-8 flag, stable order — so the container bytes are stable whenever the
 * entry content is stable. Compression is an adapter detail and is rejected
 * on read: a v1 container never relies on it.
 */

/** One entry of a ZIP archive. */
export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly crc32: number;
}

/** One entry supplied to the deterministic writer. */
export interface ZipEntryInput {
  readonly name: string;
  readonly data: Uint8Array;
}

/** Container-level preflight limits (plan S5.4); callers may only lower. */
export interface ZipArchiveLimits {
  /**
   * Independent raw input-file cap (ADR-0009 "native/external input file
   * 512 MiB", issue #96): the whole archive — not just its declared
   * entries — must fit, so an oversized input is rejected before any
   * parsing or extraction work.
   */
  readonly maxInputBytes: number;
  readonly maxEntries: number;
  readonly maxEntryNameBytes: number;
  readonly maxEntrySize: number;
  readonly maxTotalSize: number;
}

/** ADR-0009-style hard defaults for one container read. */
export const DEFAULT_ZIP_ARCHIVE_LIMITS: ZipArchiveLimits = Object.freeze({
  maxInputBytes: INPUT_FILE_MAX_BYTES,
  maxEntries: 4_096,
  maxEntryNameBytes: 256,
  maxEntrySize: 1 << 30,
  maxTotalSize: 2 * (1 << 30),
});

const LOCAL_HEADER = 0x0403_4b50;
const CENTRAL_HEADER = 0x0201_4b50;
const EOCD_SIGNATURE = 0x0605_4b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;
const U32_MAX = 0xffff_ffff;

const writeU16 = (view: DataView, offset: number, value: number): void => {
  view.setUint16(offset, value, true);
};
const writeU32 = (view: DataView, offset: number, value: number): void => {
  view.setUint32(offset, value, true);
};
const readU16 = (view: DataView, offset: number): number =>
  view.getUint16(offset, true);
const readU32 = (view: DataView, offset: number): number =>
  view.getUint32(offset, true);

/**
 * Validates one entry name against the v1 container rules: non-empty ASCII
 * printable characters, relative path with no empty, ".", or ".." segments
 * and no backslashes. The writer emits only such names; the reader rejects
 * everything else before allocation.
 */
export function isValidEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  if (name.startsWith("/") || name.includes("\\")) return false;
  const segments = name.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

function assertWriteableName(name: string): void {
  if (!isValidEntryName(name)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_ENTRY_NAME",
      message:
        "ZIP entry names must be relative ASCII paths without empty, dot, or dot-dot segments",
      context: { name },
    });
  }
}

const utf8Name = (name: string): Uint8Array => {
  const bytes = new TextEncoder().encode(name);
  if (bytes.byteLength > 255) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_ENTRY_NAME",
      message: "ZIP entry name exceeds 255 bytes",
      context: { name },
    });
  }
  return bytes;
};

/**
 * Writes a deterministic stored-entry ZIP archive. Entry order is the given
 * order (callers supply the canonical container order); every entry is
 * stored uncompressed with a fixed zero DOS timestamp and no extra fields.
 * Throws before producing bytes when a name or size violates the format.
 * The archive's own size is bounded by the same input-file cap the reader
 * enforces (issue #96), so a writer can never emit a container its own
 * reader rejects; callers may only lower the provided limits.
 */
export function writeZipArchive(
  entries: readonly ZipEntryInput[],
  limits: ZipArchiveLimits = DEFAULT_ZIP_ARCHIVE_LIMITS,
): Uint8Array {
  const seen = new Set<string>();
  const prepared = entries.map((entry) => {
    assertWriteableName(entry.name);
    if (seen.has(entry.name)) {
      throw new WorkspaceError({
        family: "validation",
        code: "DUPLICATE_ENTRY",
        message: "ZIP archive contains a duplicate entry name",
        context: { name: entry.name },
      });
    }
    seen.add(entry.name);
    const size = entry.data.byteLength;
    if (size > U32_MAX) {
      throw new WorkspaceError({
        family: "limit",
        code: "ENTRY_SIZE_LIMIT_EXCEEDED",
        message: "ZIP entry exceeds the 4 GiB format limit",
        context: { name: entry.name, size },
      });
    }
    return {
      name: entry.name,
      nameBytes: utf8Name(entry.name),
      data: entry.data,
      size,
      crc: crc32(entry.data),
    };
  });

  const localBytes =
    prepared.reduce(
      (sum, entry) =>
        sum + LOCAL_HEADER_BYTES + entry.nameBytes.byteLength + entry.size,
      0,
    ) +
    prepared.length * CENTRAL_HEADER_BYTES +
    prepared.reduce((sum, entry) => sum + entry.nameBytes.byteLength, 0) +
    EOCD_BYTES;
  if (localBytes > limits.maxInputBytes) {
    throw limitError(
      INPUT_FILE_LIMIT_EXCEEDED,
      "ZIP archive exceeds the input-file size limit",
      {
        requested: localBytes,
        limit: limits.maxInputBytes,
      },
    );
  }
  if (localBytes > U32_MAX) {
    throw new WorkspaceError({
      family: "limit",
      code: "TOTAL_SIZE_LIMIT_EXCEEDED",
      message: "ZIP archive exceeds the 4 GiB format limit",
    });
  }

  const out = new Uint8Array(localBytes);
  const view = new DataView(out.buffer);
  let cursor = 0;
  const central: Array<{ offset: number }> = [];

  for (const entry of prepared) {
    central.push({ offset: cursor });
    writeU32(view, cursor, LOCAL_HEADER);
    // Version needed 2.0 (UTF-8 flag), bit 11 set, stored method, zero time.
    writeU16(view, cursor + 4, 20);
    writeU16(view, cursor + 6, 0x0800);
    writeU16(view, cursor + 8, 0);
    writeU16(view, cursor + 10, 0);
    writeU16(view, cursor + 12, 0);
    writeU32(view, cursor + 14, entry.crc);
    writeU32(view, cursor + 18, entry.size);
    writeU32(view, cursor + 22, entry.size);
    writeU16(view, cursor + 26, entry.nameBytes.byteLength);
    writeU16(view, cursor + 28, 0);
    cursor += LOCAL_HEADER_BYTES;
    out.set(entry.nameBytes, cursor);
    cursor += entry.nameBytes.byteLength;
    out.set(entry.data, cursor);
    cursor += entry.size;
  }

  const centralOffset = cursor;
  for (let index = 0; index < prepared.length; index += 1) {
    const entry = prepared[index] as (typeof prepared)[number];
    const localOffset = (central[index] as { offset: number }).offset;
    writeU32(view, cursor, CENTRAL_HEADER);
    writeU16(view, cursor + 4, 20);
    writeU16(view, cursor + 6, 20);
    writeU16(view, cursor + 8, 0x0800);
    writeU16(view, cursor + 10, 0);
    writeU16(view, cursor + 12, 0);
    writeU16(view, cursor + 14, 0);
    writeU32(view, cursor + 16, entry.crc);
    writeU32(view, cursor + 20, entry.size);
    writeU32(view, cursor + 24, entry.size);
    writeU16(view, cursor + 28, entry.nameBytes.byteLength);
    writeU16(view, cursor + 30, 0);
    writeU16(view, cursor + 32, 0);
    writeU16(view, cursor + 34, 0);
    writeU16(view, cursor + 36, 0);
    writeU32(view, cursor + 38, 0);
    writeU32(view, cursor + 42, localOffset);
    cursor += CENTRAL_HEADER_BYTES;
    out.set(entry.nameBytes, cursor);
    cursor += entry.nameBytes.byteLength;
  }

  writeU32(view, cursor, EOCD_SIGNATURE);
  writeU16(view, cursor + 4, 0);
  writeU16(view, cursor + 6, 0);
  writeU16(view, cursor + 8, prepared.length);
  writeU16(view, cursor + 10, prepared.length);
  writeU32(view, cursor + 12, cursor - centralOffset);
  writeU32(view, cursor + 16, centralOffset);
  writeU16(view, cursor + 20, 0);
  return out;
}

interface CentralRecord {
  readonly name: string;
  readonly crc: number;
  readonly size: number;
  readonly localOffset: number;
}

/**
 * Reads and fully validates a stored-entry ZIP archive before returning
 * entry data (plan S5.4): end-of-central-directory sanity, central directory
 * integrity, path safety, entry-name byte limits, duplicate rejection,
 * stored-only method, size and total limits, local-header consistency,
 * non-overlapping data ranges, and per-entry CRC-32 verification. Any
 * violation throws a structured error before the caller can allocate from
 * untrusted data. The supplied limit profile may only lower the hard
 * defaults (ADR-0009).
 */
export function readZipArchive(
  bytes: Uint8Array,
  limits: ZipArchiveLimits = DEFAULT_ZIP_ARCHIVE_LIMITS,
): ZipEntry[] {
  // ADR-0009: hard defaults are immutable; callers may only lower them, and
  // a raised profile is rejected before any byte of the archive is parsed.
  const safeLimits = assertNotAboveDefault(
    limits,
    DEFAULT_ZIP_ARCHIVE_LIMITS,
    "ZIP archive",
  );
  // ADR-0009 input-file cap (issue #96): the raw input is bounded before
  // any scan, so a hostile oversized file is rejected without touching its
  // body. This is independent of the per-entry and expanded-total limits,
  // which only apply once the archive is known to fit.
  if (bytes.byteLength > safeLimits.maxInputBytes) {
    throw limitError(
      INPUT_FILE_LIMIT_EXCEEDED,
      "ZIP archive exceeds the input-file size limit",
      {
        requested: bytes.byteLength,
        limit: safeLimits.maxInputBytes,
      },
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes, view);
  if (eocd === undefined) {
    throw corrupt(
      "INVALID_ZIP_ARCHIVE",
      "ZIP end-of-central-directory not found",
    );
  }
  if (readU16(view, eocd + 4) !== 0 || readU16(view, eocd + 6) !== 0) {
    throw corrupt(
      "INVALID_ZIP_ARCHIVE",
      "Multi-disk ZIP archives are not supported",
    );
  }
  const entriesOnDisk = readU16(view, eocd + 8);
  const entryCount = readU16(view, eocd + 10);
  const centralSize = readU32(view, eocd + 12);
  const centralOffset = readU32(view, eocd + 16);
  if (entriesOnDisk !== entryCount) {
    throw corrupt(
      "INVALID_ZIP_ARCHIVE",
      "ZIP entry counts disagree between the EOCD fields",
      { entriesOnDisk, entryCount },
    );
  }
  if (entryCount > safeLimits.maxEntries) {
    throw limitError(
      "ENTRY_LIMIT_EXCEEDED",
      "ZIP archive exceeds its entry limit",
      {
        requested: entryCount,
        limit: safeLimits.maxEntries,
      },
    );
  }
  if (
    centralOffset + centralSize > bytes.byteLength ||
    centralSize < entryCount * CENTRAL_HEADER_BYTES
  ) {
    throw corrupt(
      "INVALID_ZIP_ARCHIVE",
      "ZIP central directory is outside the file",
    );
  }
  if (centralOffset + centralSize + EOCD_BYTES !== bytes.byteLength) {
    // Normalized v1 containers have no trailing bytes after the EOCD.
    throw corrupt(
      "INVALID_ZIP_ARCHIVE",
      "ZIP archive has trailing or overlapping data",
    );
  }

  const records: CentralRecord[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  while (cursor < centralEnd) {
    if (readU32(view, cursor) !== CENTRAL_HEADER) {
      throw corrupt(
        "INVALID_ZIP_ARCHIVE",
        "ZIP central directory is malformed",
      );
    }
    const method = readU16(view, cursor + 10);
    const crc = readU32(view, cursor + 16);
    const compressedSize = readU32(view, cursor + 20);
    const uncompressedSize = readU32(view, cursor + 24);
    const nameLength = readU16(view, cursor + 28);
    const extraLength = readU16(view, cursor + 30);
    const commentLength = readU16(view, cursor + 32);
    const localOffset = readU32(view, cursor + 42);
    const recordSize =
      CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
    if (cursor + recordSize > centralEnd) {
      throw corrupt(
        "INVALID_ZIP_ARCHIVE",
        "ZIP central directory record is truncated",
      );
    }
    // Issue #98: enforce the configured byte limit on the raw name length
    // before slicing or decoding, so a lowered profile rejects oversized
    // names with a stable limit error before any name allocation.
    if (nameLength > safeLimits.maxEntryNameBytes) {
      throw limitError(
        "ENTRY_NAME_LIMIT_EXCEEDED",
        "ZIP entry name exceeds its byte limit",
        { requested: nameLength, limit: safeLimits.maxEntryNameBytes },
      );
    }
    const nameBytes = bytes.slice(
      cursor + CENTRAL_HEADER_BYTES,
      cursor + CENTRAL_HEADER_BYTES + nameLength,
    );
    const name = decodeEntryName(nameBytes);
    if (!isValidEntryName(name)) {
      throw corrupt(
        "INVALID_ENTRY_NAME",
        "ZIP entry name violates container path rules",
        { name },
      );
    }
    if (names.has(name)) {
      throw corrupt(
        "DUPLICATE_ENTRY",
        "ZIP archive contains a duplicate entry name",
        { name },
      );
    }
    names.add(name);
    if (method !== 0) {
      throw new WorkspaceError({
        family: "compatibility",
        code: "UNSUPPORTED_ZIP_METHOD",
        message:
          "v1 containers store entries uncompressed; compressed entries are unsupported",
        context: { name, method },
      });
    }
    if (
      compressedSize !== uncompressedSize ||
      compressedSize === U32_MAX ||
      uncompressedSize === U32_MAX ||
      nameLength === 0xffff ||
      extraLength === 0xffff ||
      commentLength === 0xffff ||
      localOffset === U32_MAX
    ) {
      throw corrupt(
        "INVALID_ZIP_ARCHIVE",
        "ZIP record uses unsupported sizes or ZIP64 markers",
        { name },
      );
    }
    if (uncompressedSize > safeLimits.maxEntrySize) {
      throw limitError(
        "ENTRY_SIZE_LIMIT_EXCEEDED",
        "ZIP entry exceeds its size limit",
        {
          name,
          requested: uncompressedSize,
          limit: safeLimits.maxEntrySize,
        },
      );
    }
    if (uncompressedSize > 0 && localOffset >= bytes.byteLength) {
      throw corrupt(
        "INVALID_ZIP_ARCHIVE",
        "ZIP local header offset is outside the file",
        { name },
      );
    }
    records.push({ name, crc, size: uncompressedSize, localOffset });
    cursor += recordSize;
  }
  if (records.length !== entryCount) {
    throw corrupt(
      "INVALID_ZIP_ARCHIVE",
      "ZIP entry count does not match the central directory",
    );
  }
  if (records.length === 0) {
    throw corrupt("INVALID_ZIP_ARCHIVE", "ZIP archive has no entries");
  }

  let totalSize = 0;
  const dataRanges: Array<{ start: number; end: number }> = [];
  const extracted: ZipEntry[] = [];
  for (const record of records) {
    totalSize += record.size;
    // Ratio preflight for the stored-only v1 format: declared uncompressed
    // content cannot exceed the archive byte length, so a small file that
    // declares gigabytes is a size bomb and is rejected before extraction.
    if (totalSize > bytes.byteLength) {
      throw corrupt(
        "DECLARED_SIZE_EXCEEDS_ARCHIVE",
        "Declared entry sizes exceed the archive size; refusing a stored-format size bomb",
        { requested: totalSize, archiveSize: bytes.byteLength },
      );
    }
    if (totalSize > safeLimits.maxTotalSize) {
      throw limitError(
        "TOTAL_SIZE_LIMIT_EXCEEDED",
        "ZIP archive exceeds its total size limit",
        {
          requested: totalSize,
          limit: safeLimits.maxTotalSize,
        },
      );
    }
    if (record.size === 0) {
      extracted.push({
        name: record.name,
        data: new Uint8Array(0),
        crc32: record.crc,
      });
      continue;
    }
    if (readU32(view, record.localOffset) !== LOCAL_HEADER) {
      throw corrupt(
        "INVALID_ZIP_ARCHIVE",
        "ZIP local header signature missing",
        { name: record.name },
      );
    }
    const localMethod = readU16(view, record.localOffset + 8);
    const localCrc = readU32(view, record.localOffset + 14);
    const localCompressed = readU32(view, record.localOffset + 18);
    const localUncompressed = readU32(view, record.localOffset + 22);
    const localNameLength = readU16(view, record.localOffset + 26);
    const localExtraLength = readU16(view, record.localOffset + 28);
    if (
      localMethod !== 0 ||
      localCrc !== record.crc ||
      localCompressed !== record.size ||
      localUncompressed !== record.size
    ) {
      throw corrupt(
        "INVALID_ZIP_ARCHIVE",
        "ZIP local header does not match its central record",
        { name: record.name },
      );
    }
    const localNameBytes = bytes.slice(
      record.localOffset + LOCAL_HEADER_BYTES,
      record.localOffset + LOCAL_HEADER_BYTES + localNameLength,
    );
    if (decodeEntryName(localNameBytes) !== record.name) {
      throw corrupt(
        "INVALID_ZIP_ARCHIVE",
        "ZIP local header name does not match its central record",
        { name: record.name },
      );
    }
    const dataStart =
      record.localOffset +
      LOCAL_HEADER_BYTES +
      localNameLength +
      localExtraLength;
    const dataEnd = dataStart + record.size;
    if (dataEnd > bytes.byteLength) {
      throw corrupt(
        "TRUNCATED_ENTRY",
        "ZIP entry data extends beyond the file",
        { name: record.name },
      );
    }
    dataRanges.push({ start: dataStart, end: dataEnd });
    const data = bytes.slice(dataStart, dataEnd);
    if (crc32(data) !== record.crc) {
      throw corrupt(
        "CRC_MISMATCH",
        "ZIP entry checksum does not match its content",
        { name: record.name },
      );
    }
    extracted.push({ name: record.name, data, crc32: record.crc });
  }
  // Defense in depth: entry data ranges must not overlap.
  const ordered = [...dataRanges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (
      (ordered[i] as { start: number }).start <
      (ordered[i - 1] as { end: number }).end
    ) {
      throw corrupt("INVALID_ZIP_ARCHIVE", "ZIP entry data ranges overlap");
    }
  }
  return extracted;
}

/** Finds a zero-comment EOCD whose record ends exactly at the file end. */
function findEocd(bytes: Uint8Array, view: DataView): number | undefined {
  const maxBack = Math.min(bytes.byteLength, EOCD_BYTES + 65_535);
  const start = bytes.byteLength - maxBack;
  for (
    let offset = bytes.byteLength - EOCD_BYTES;
    offset >= start;
    offset -= 1
  ) {
    if (readU32(view, offset) !== EOCD_SIGNATURE) continue;
    const commentLength = readU16(view, offset + 20);
    if (offset + EOCD_BYTES + commentLength === bytes.byteLength) {
      return commentLength === 0 ? offset : undefined;
    }
  }
  return undefined;
}

/** Decodes an entry name; v1 requires ASCII so UTF-8 and ASCII coincide. */
function decodeEntryName(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if (byte > 0x7f) return "";
    out += String.fromCharCode(byte);
  }
  return out;
}

const corrupt = (
  code: string,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): WorkspaceError =>
  new WorkspaceError({
    family: "io",
    code,
    message,
    ...(context === undefined ? {} : { context: context as never }),
  });

const limitError = (
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>>,
): WorkspaceError =>
  new WorkspaceError({
    family: "limit",
    code,
    message,
    context: context as never,
  });
