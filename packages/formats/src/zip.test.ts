import {
  INPUT_FILE_LIMIT_EXCEEDED,
  INPUT_FILE_MAX_BYTES,
} from "@voxel-maker/shared";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZIP_ARCHIVE_LIMITS,
  isValidEntryName,
  readZipArchive,
  writeZipArchive,
  type ZipEntry,
} from "./zip.js";

const encoder = new TextEncoder();
const text = (value: string): Uint8Array => encoder.encode(value);

function names(entries: readonly ZipEntry[]): string[] {
  return entries.map((entry) => entry.name);
}

/**
 * Grows a forged archive's central directory by `growBy` zero bytes and
 * lets `mutate` patch the central record, so declared 0xFFFF length fields
 * physically fit and the ZIP64-marker preflight is what rejects them.
 */
function growCentralDirectory(
  bytes: Uint8Array,
  growBy: number,
  mutate: (view: DataView, centralOffset: number) => void,
): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralOffset = view.getUint32(bytes.byteLength - 6, true);
  const centralSize = view.getUint32(bytes.byteLength - 10, true);
  const out = new Uint8Array(bytes.byteLength + growBy);
  out.set(bytes);
  const outView = new DataView(out.buffer);
  outView.setUint32(out.byteLength - 10, centralSize + growBy, true);
  mutate(outView, centralOffset);
  return out;
}

/** Asserts that `fn` throws a WorkspaceError with the exact stable code. */
function expectErrorCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`Expected WorkspaceError ${code}, but nothing was thrown`);
  }
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    (thrown as { code: unknown }).code === code
  ) {
    return;
  }
  throw new Error(
    `Expected WorkspaceError ${code}, got ${
      thrown instanceof Error ? thrown.name : typeof thrown
    }`,
  );
}

describe("isValidEntryName", () => {
  it("accepts relative ASCII container paths", () => {
    expect(isValidEntryName("manifest.json")).toBe(true);
    expect(isValidEntryName("voxels/a.bin")).toBe(true);
    expect(isValidEntryName("previews/front.png")).toBe(true);
    expect(isValidEntryName("a/b/c.txt")).toBe(true);
  });

  it("rejects traversal, absolute, and control paths", () => {
    expect(isValidEntryName("")).toBe(false);
    expect(isValidEntryName("../x")).toBe(false);
    expect(isValidEntryName("a/../x")).toBe(false);
    expect(isValidEntryName("./x")).toBe(false);
    expect(isValidEntryName("a/./x")).toBe(false);
    expect(isValidEntryName("a//x")).toBe(false);
    expect(isValidEntryName("/x")).toBe(false);
    expect(isValidEntryName("a\\b")).toBe(false);
    expect(isValidEntryName("a\u0000b")).toBe(false);
    expect(isValidEntryName("a b")).toBe(true);
    expect(isValidEntryName("caf\u00e9")).toBe(false);
  });
});

describe("writeZipArchive", () => {
  it("writes a deterministic stored-entry archive", () => {
    const bytes = writeZipArchive([
      { name: "a.txt", data: text("alpha") },
      { name: "b.txt", data: text("beta") },
    ]);
    const first = writeZipArchive([
      { name: "a.txt", data: text("alpha") },
      { name: "b.txt", data: text("beta") },
    ]);
    expect(Buffer.from(bytes).equals(Buffer.from(first))).toBe(true);
    const entries = readZipArchive(bytes);
    expect(names(entries)).toEqual(["a.txt", "b.txt"]);
    expect(new TextDecoder().decode(entries[0]?.data)).toBe("alpha");
    expect(new TextDecoder().decode(entries[1]?.data)).toBe("beta");
  });

  it("rejects duplicate names and unsafe names", () => {
    expectErrorCode(
      () =>
        writeZipArchive([
          { name: "a", data: text("1") },
          { name: "a", data: text("2") },
        ]),
      "DUPLICATE_ENTRY",
    );
    expectErrorCode(
      () => writeZipArchive([{ name: "../a", data: text("1") }]),
      "INVALID_ENTRY_NAME",
    );
  });

  it("rejects output above the input-file cap (issue #96)", () => {
    // The writer must never emit a container its own reader rejects, so
    // the same 512 MiB input-file cap binds the output size.
    expectErrorCode(
      () =>
        writeZipArchive([{ name: "big.bin", data: new Uint8Array(8) }], {
          ...DEFAULT_ZIP_ARCHIVE_LIMITS,
          maxInputBytes: 4,
        }),
      INPUT_FILE_LIMIT_EXCEEDED,
    );
    expectErrorCode(
      () =>
        writeZipArchive([{ name: "tiny.bin", data: new Uint8Array(1) }], {
          ...DEFAULT_ZIP_ARCHIVE_LIMITS,
          maxInputBytes: 0,
        }),
      INPUT_FILE_LIMIT_EXCEEDED,
    );
  });
});

describe("readZipArchive", () => {
  it("rejects input above the input-file cap before parsing (issue #96)", () => {
    expectErrorCode(
      () =>
        readZipArchive(new Uint8Array(8), {
          ...DEFAULT_ZIP_ARCHIVE_LIMITS,
          maxInputBytes: 4,
        }),
      INPUT_FILE_LIMIT_EXCEEDED,
    );
  });

  it("pins the default input cap to the shared 512 MiB hard limit", () => {
    expect(DEFAULT_ZIP_ARCHIVE_LIMITS.maxInputBytes).toBe(INPUT_FILE_MAX_BYTES);
  });
  it("rejects truncated and empty inputs", () => {
    expectErrorCode(
      () => readZipArchive(new Uint8Array(0)),
      "INVALID_ZIP_ARCHIVE",
    );
    const bytes = writeZipArchive([{ name: "a", data: text("x") }]);
    expectErrorCode(
      () => readZipArchive(bytes.subarray(0, bytes.byteLength - 1)),
      "INVALID_ZIP_ARCHIVE",
    );
  });

  it("rejects entry name traversal before allocation", () => {
    // Forge a single-entry archive whose central and local names are the
    // one-byte backslash (invalid, same length, so the record stays
    // structurally intact and the name check is what fails).
    const bytes = writeZipArchive([{ name: "a", data: text("x") }]);
    const forged = bytes.slice();
    const dv = new DataView(forged.buffer);
    const centralOffset = dv.getUint32(bytes.byteLength - 6, true);
    forged[30] = 0x5c; // local header name byte -> backslash
    forged[centralOffset + 46] = 0x5c; // central name byte -> backslash
    expectErrorCode(() => readZipArchive(forged), "INVALID_ENTRY_NAME");
  });

  it("rejects unsupported compression methods", () => {
    const bytes = writeZipArchive([{ name: "a", data: text("x") }]);
    const deflated = bytes.slice();
    const dv = new DataView(deflated.buffer);
    const centralOffset = dv.getUint32(deflated.byteLength - 6, true);
    dv.setUint16(centralOffset + 10, 8, true); // deflate
    expectErrorCode(() => readZipArchive(deflated), "UNSUPPORTED_ZIP_METHOD");
  });

  it("detects CRC mismatches", () => {
    const bytes = writeZipArchive([{ name: "a", data: text("payload") }]);
    const corrupt = bytes.slice();
    const dv = new DataView(corrupt.buffer);
    const centralOffset = dv.getUint32(bytes.byteLength - 6, true);
    // Patch both the central and local CRCs so the mismatch surfaces when
    // the extracted content is verified.
    dv.setUint32(centralOffset + 16, 0xdead_beef, true);
    dv.setUint32(14, 0xdead_beef, true);
    expectErrorCode(() => readZipArchive(corrupt), "CRC_MISMATCH");
  });

  it("enforces entry and total size limits", () => {
    const limits = {
      ...DEFAULT_ZIP_ARCHIVE_LIMITS,
      maxEntries: 1,
      maxEntryNameBytes: 256,
      maxEntrySize: 1 << 20,
      maxTotalSize: 1 << 20,
    };
    const bytes = writeZipArchive([
      { name: "a", data: new Uint8Array(16) },
      { name: "b", data: new Uint8Array(16) },
    ]);
    expectErrorCode(
      () => readZipArchive(bytes, limits),
      "ENTRY_LIMIT_EXCEEDED",
    );
    const big = writeZipArchive([{ name: "a", data: new Uint8Array(16) }]);
    expectErrorCode(
      () =>
        readZipArchive(big, {
          ...limits,
          maxEntries: 8,
          maxEntrySize: 4,
        }),
      "ENTRY_SIZE_LIMIT_EXCEEDED",
    );
  });

  it("rejects ZIP64 marker fields before trusting the record", () => {
    // extraLength = 0xFFFF is the ZIP64 marker for a 16-bit length. The
    // central directory is grown so the forged record physically fits and
    // the marker check — not the truncation check — is what rejects it.
    const base = writeZipArchive([{ name: "a", data: text("x") }]);
    const forged = growCentralDirectory(base, 0xffff, (view, centralOffset) => {
      view.setUint16(centralOffset + 30, 0xffff, true);
    });
    expectErrorCode(() => readZipArchive(forged), "INVALID_ZIP_ARCHIVE");
  });

  it("rejects ZIP64 comment-length markers", () => {
    const base = writeZipArchive([{ name: "a", data: text("x") }]);
    const forged = growCentralDirectory(base, 0xffff, (view, centralOffset) => {
      view.setUint16(centralOffset + 32, 0xffff, true);
    });
    expectErrorCode(() => readZipArchive(forged), "INVALID_ZIP_ARCHIVE");
  });

  it("rejects ZIP64 size markers in central and local records", () => {
    const bytes = writeZipArchive([{ name: "a", data: text("x") }]);
    const forged = bytes.slice();
    const dv = new DataView(forged.buffer);
    const centralOffset = dv.getUint32(forged.byteLength - 6, true);
    dv.setUint32(centralOffset + 20, 0xffff_ffff, true);
    dv.setUint32(centralOffset + 24, 0xffff_ffff, true);
    dv.setUint32(18, 0xffff_ffff, true);
    dv.setUint32(22, 0xffff_ffff, true);
    expectErrorCode(() => readZipArchive(forged), "INVALID_ZIP_ARCHIVE");
  });

  it("rejects ZIP64 local offsets", () => {
    const bytes = writeZipArchive([{ name: "a", data: text("x") }]);
    const dv = new DataView(bytes.buffer);
    const centralOffset = dv.getUint32(bytes.byteLength - 6, true);
    dv.setUint32(centralOffset + 42, 0xffff_ffff, true);
    expectErrorCode(() => readZipArchive(bytes), "INVALID_ZIP_ARCHIVE");
  });

  it("rejects declared sizes that exceed the archive (stored-format bomb)", () => {
    const bytes = writeZipArchive([{ name: "a", data: text("x") }]);
    const forged = bytes.slice();
    const dv = new DataView(forged.buffer);
    const centralOffset = dv.getUint32(forged.byteLength - 6, true);
    // Both central and local records declare 1 MiB while the file holds one
    // byte: the ratio preflight must reject before per-entry extraction.
    dv.setUint32(centralOffset + 20, 1 << 20, true);
    dv.setUint32(centralOffset + 24, 1 << 20, true);
    dv.setUint32(18, 1 << 20, true);
    dv.setUint32(22, 1 << 20, true);
    expectErrorCode(
      () => readZipArchive(forged),
      "DECLARED_SIZE_EXCEEDS_ARCHIVE",
    );
  });

  it("rejects EOCD entry counts that disagree with the disk", () => {
    const bytes = writeZipArchive([{ name: "a", data: text("x") }]);
    const forged = bytes.slice();
    const dv = new DataView(forged.buffer);
    dv.setUint16(forged.byteLength - 14, 2, true); // entries on this disk
    expectErrorCode(() => readZipArchive(forged), "INVALID_ZIP_ARCHIVE");
  });

  it("accepts zero-length entries", () => {
    const bytes = writeZipArchive([
      { name: "empty.bin", data: new Uint8Array(0) },
    ]);
    const entries = readZipArchive(bytes);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data.byteLength).toBe(0);
  });

  it("rejects entry names above a lowered byte limit before decoding", () => {
    // Issue #98: a caller-configured maxEntryNameBytes must be enforced on
    // the raw central-directory length before the name is sliced or
    // decoded, not only through the fixed 255-character format rule.
    const bytes = writeZipArchive([{ name: "123456789.txt", data: text("x") }]);
    expectErrorCode(
      () =>
        readZipArchive(bytes, {
          ...DEFAULT_ZIP_ARCHIVE_LIMITS,
          maxEntryNameBytes: 4,
        }),
      "ENTRY_NAME_LIMIT_EXCEEDED",
    );
  });

  it("accepts entry names at the lowered byte limit boundary", () => {
    const bytes = writeZipArchive([{ name: "1234", data: text("x") }]);
    const entries = readZipArchive(bytes, {
      ...DEFAULT_ZIP_ARCHIVE_LIMITS,
      maxEntryNameBytes: 4,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("1234");
  });

  it("accepts the longest writer-produced names under default limits", () => {
    const bytes = writeZipArchive([{ name: "a".repeat(255), data: text("x") }]);
    const entries = readZipArchive(bytes);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toHaveLength(255);
  });

  it("rejects limit profiles that raise hard defaults", () => {
    const bytes = writeZipArchive([{ name: "a", data: text("x") }]);
    expectErrorCode(
      () =>
        readZipArchive(bytes, {
          ...DEFAULT_ZIP_ARCHIVE_LIMITS,
          maxEntryNameBytes: 4_096,
        }),
      "LIMIT_ABOVE_DEFAULT",
    );
    expectErrorCode(
      () =>
        readZipArchive(bytes, {
          ...DEFAULT_ZIP_ARCHIVE_LIMITS,
          maxEntries: 9_999,
        }),
      "LIMIT_ABOVE_DEFAULT",
    );
  });
});

describe("archive round-trip property", () => {
  it("round-trips many entries byte-identically", () => {
    const entries = Array.from({ length: 64 }, (_, i) => ({
      name: `dir/file-${String(i).padStart(3, "0")}.bin`,
      data: new Uint8Array([i, i * 2, 255 - i]),
    }));
    const bytes = writeZipArchive(entries);
    const read = readZipArchive(bytes);
    expect(names(read)).toEqual(entries.map((entry) => entry.name));
    for (let i = 0; i < entries.length; i += 1) {
      expect(
        Buffer.from(read[i]?.data as Uint8Array).equals(
          Buffer.from((entries[i] as { data: Uint8Array }).data),
        ),
      ).toBe(true);
    }
  });
});
