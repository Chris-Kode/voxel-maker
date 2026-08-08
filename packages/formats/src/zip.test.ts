import { describe, expect, it } from "vitest";
import {
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
});

describe("readZipArchive", () => {
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

  it("accepts zero-length entries", () => {
    const bytes = writeZipArchive([
      { name: "empty.bin", data: new Uint8Array(0) },
    ]);
    const entries = readZipArchive(bytes);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data.byteLength).toBe(0);
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
