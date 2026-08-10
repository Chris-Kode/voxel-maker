import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  createSeededRng,
  mutateBytes,
  randomBytes,
} from "@voxel-maker/testkit";
import { createDocument } from "@voxel-maker/model";
import { encodeVox, parseVox } from "./vox.js";
import {
  DEFAULT_ZIP_ARCHIVE_LIMITS,
  readZipArchive,
  writeZipArchive,
  type ZipArchiveLimits,
} from "./zip.js";
import { readVxlProject, writeVxlProject } from "./container.js";
import { encodeManifest } from "./manifest.js";
import { encodePng } from "./png.js";

/**
 * Adversarial and deterministic-fuzz suite for every binary/text parse
 * surface in the formats package (issue #44, plan §10.1 "Fuzz/adversarial",
 * §11.2). Two guarantees are asserted across the whole corpus:
 *
 * 1. STRUCTURED FAILURE ONLY - every reader either returns a value or
 *    throws a `WorkspaceError` (families validation/io/limit/
 *    compatibility). No crash, no RangeError, no raw Error, no OOM.
 * 2. LIMITS BEFORE ALLOCATION - count/size/ratio/nesting preflights run
 *    before bulk work; adversarial inputs that violate a limit fail with
 *    a stable `limit`-family code or a documented `io`-family rejection.
 *
 * All fuzz corpora are seeded and deterministic (xorshift32), so the
 * suite is a regression gate, not a flaky probe.
 */

// ---------------------------------------------------------------------------
// Corpus builders (seeded RNG helpers live in @voxel-maker/testkit)
// ---------------------------------------------------------------------------

interface StructuredResult<T> {
  readonly ok: true;
  readonly value: T;
}

type StructuredOutcome<T> =
  | StructuredResult<T>
  | { readonly ok: false; readonly error: WorkspaceError };

/** Asserts structured failure or success; returns the outcome for checks. */
function structured<T>(fn: () => T): StructuredOutcome<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (!(error instanceof WorkspaceError)) {
      throw new Error(
        `Reader threw a non-structured error: ${
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
        }`,
      );
    }
    return { ok: false, error };
  }
}

/** Narrows a structured outcome to its error; throws when it succeeded. */
function failure<T>(outcome: StructuredOutcome<T>): WorkspaceError {
  if (outcome.ok) {
    throw new Error("Expected a structured failure, but the call succeeded");
  }
  return outcome.error;
}

function expectErrorCode(fn: () => unknown, code: string): void {
  const outcome = structured(fn);
  if (outcome.ok) {
    throw new Error(`Expected WorkspaceError ${code}, but the call succeeded`);
  }
  expect(outcome.error.code).toBe(code);
}

const tinyZipLimits: ZipArchiveLimits = Object.freeze({
  ...DEFAULT_ZIP_ARCHIVE_LIMITS,
  maxEntries: 8,
  maxEntryNameBytes: 64,
  maxEntrySize: 1_048_576,
  maxTotalSize: 4_194_304,
});

function singleEntryZip(name: string, data: Uint8Array): Uint8Array {
  return writeZipArchive([{ name, data }]);
}

function patchU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(
    offset,
    value,
    true,
  );
}

/** Patches the central-directory name of the entry at `index`. */
function patchCentralName(
  bytes: Uint8Array,
  index: number,
  name: string,
): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const eocd = out.byteLength - 22;
  const centralOffset = view.getUint32(eocd + 16, true);
  const centralSize = view.getUint32(eocd + 12, true);
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  let seen = 0;
  const nameBytes = new TextEncoder().encode(name);
  while (cursor < centralEnd) {
    const nameLength = view.getUint16(cursor + 28, true);
    if (seen === index) {
      if (nameLength !== nameBytes.byteLength) {
        throw new Error(
          `test bug: name length ${String(nameLength)} != ${String(nameBytes.byteLength)}`,
        );
      }
      out.set(nameBytes, cursor + 46);
      return out;
    }
    cursor +=
      46 +
      nameLength +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
    seen += 1;
  }
  throw new Error(`test bug: central record ${String(index)} not found`);
}

function patchCentralU32(
  bytes: Uint8Array,
  index: number,
  fieldOffset: number,
  value: number,
): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const eocd = out.byteLength - 22;
  const centralOffset = view.getUint32(eocd + 16, true);
  const centralSize = view.getUint32(eocd + 12, true);
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  let seen = 0;
  while (cursor < centralEnd) {
    const nameLength = view.getUint16(cursor + 28, true);
    if (seen === index) {
      view.setUint32(cursor + fieldOffset, value, true);
      return out;
    }
    cursor +=
      46 +
      nameLength +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
    seen += 1;
  }
  throw new Error(`test bug: central record ${String(index)} not found`);
}

function patchLocalU32(
  bytes: Uint8Array,
  index: number,
  fieldOffset: number,
  value: number,
): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const eocd = out.byteLength - 22;
  const centralOffset = view.getUint32(eocd + 16, true);
  const centralSize = view.getUint32(eocd + 12, true);
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  let seen = 0;
  while (cursor < centralEnd) {
    const nameLength = view.getUint16(cursor + 28, true);
    if (seen === index) {
      const localOffset = view.getUint32(cursor + 42, true);
      view.setUint32(localOffset + fieldOffset, value, true);
      return out;
    }
    cursor +=
      46 +
      nameLength +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
    seen += 1;
  }
  throw new Error(`test bug: central record ${String(index)} not found`);
}

function localOffsetOf(bytes: Uint8Array, index: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.byteLength - 22;
  const centralOffset = view.getUint32(eocd + 16, true);
  const centralSize = view.getUint32(eocd + 12, true);
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  let seen = 0;
  while (cursor < centralEnd) {
    const nameLength = view.getUint16(cursor + 28, true);
    if (seen === index) return view.getUint32(cursor + 42, true);
    cursor +=
      46 +
      nameLength +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
    seen += 1;
  }
  throw new Error(`test bug: central record ${String(index)} not found`);
}

// ---------------------------------------------------------------------------
// Seeded fuzz: random and mutated bytes never crash any reader
// ---------------------------------------------------------------------------

describe("fuzz: random bytes never crash a reader", () => {
  const rng = createSeededRng(0x44_f0_0001);
  const sizes = [
    0, 1, 2, 3, 4, 5, 8, 12, 16, 22, 30, 31, 46, 64, 100, 128, 256, 512, 777,
    1024, 2048, 4096,
  ];

  it("readZipArchive stays structured over random bytes", () => {
    for (let i = 0; i < 250; i += 1) {
      const size = sizes[Math.floor(rng() * sizes.length)] ?? 64;
      const bytes = randomBytes(rng, size);
      const outcome = structured(() => readZipArchive(bytes, tinyZipLimits));
      if (outcome.ok) {
        for (const entry of outcome.value) {
          expect(entry.name.length).toBeGreaterThan(0);
          expect(entry.name.length).toBeLessThanOrEqual(
            tinyZipLimits.maxEntryNameBytes,
          );
          expect(entry.data.byteLength).toBeLessThanOrEqual(
            tinyZipLimits.maxEntrySize,
          );
        }
      }
    }
  });

  it("parseVox stays structured over random bytes", () => {
    for (let i = 0; i < 250; i += 1) {
      const size = sizes[Math.floor(rng() * sizes.length)] ?? 64;
      structured(() => parseVox(randomBytes(rng, size)));
    }
  });

  it("readVxlProject stays structured over random bytes", () => {
    for (let i = 0; i < 120; i += 1) {
      const size = sizes[Math.floor(rng() * sizes.length)] ?? 64;
      structured(() => readVxlProject(randomBytes(rng, size)));
    }
  });

  it("mutated and truncated valid ZIPs stay structured", () => {
    const valid = singleEntryZip(
      "hello.txt",
      new TextEncoder().encode("hello world"),
    );
    for (let i = 0; i < 200; i += 1) {
      structured(() =>
        readZipArchive(mutateBytes(valid, rng, 8), tinyZipLimits),
      );
    }
    for (let offset = 0; offset <= valid.byteLength; offset += 1) {
      structured(() => readZipArchive(valid.slice(0, offset), tinyZipLimits));
    }
  });

  it("mutated and truncated valid VOX stays structured", () => {
    const valid = encodeVox({
      models: [
        {
          sizeX: 1,
          sizeY: 1,
          sizeZ: 1,
          voxels: [{ x: 0, y: 0, z: 0, colorIndex: 1 }],
        },
      ],
    });
    expect(structured(() => parseVox(valid)).ok).toBe(true);
    for (let i = 0; i < 200; i += 1) {
      structured(() => parseVox(mutateBytes(valid, rng, 8)));
    }
    for (let offset = 0; offset <= valid.byteLength; offset += 1) {
      structured(() => parseVox(valid.slice(0, offset)));
    }
  });
});

// ---------------------------------------------------------------------------
// ZIP adversarial cases: counts, sizes, paths, overlap, methods
// ---------------------------------------------------------------------------

describe("adversarial ZIP", () => {
  it("rejects more entries than the configured limit", () => {
    const many = writeZipArchive(
      Array.from({ length: 12 }, (_, i) => ({
        name: `entry-${String(i)}.txt`,
        data: new TextEncoder().encode(`v${String(i)}`),
      })),
    );
    const outcome = structured(() => readZipArchive(many, tinyZipLimits));
    const error = failure(outcome);
    expect(error.code).toBe("ENTRY_LIMIT_EXCEEDED");
    expect(error.family).toBe("limit");
  });

  it("rejects entries whose declared size exceeds the archive (stored-format size bomb)", () => {
    // Hard defaults: the forged 256 MiB declarations stay under the 1 GiB
    // per-entry default, so the stored-format ratio preflight is what
    // rejects the bomb (raising limits would itself be a LIMIT_ABOVE_DEFAULT
    // violation since callers may only lower).
    const valid = singleEntryZip("bomb.bin", new TextEncoder().encode("tiny"));
    const forged = patchLocalU32(
      patchLocalU32(
        patchCentralU32(
          patchCentralU32(valid, 0, 20, 0x0fff_ffff),
          0,
          24,
          0x0fff_ffff,
        ),
        0,
        18,
        0x0fff_ffff,
      ),
      0,
      22,
      0x0fff_ffff,
    );
    const outcome = structured(() =>
      readZipArchive(forged, DEFAULT_ZIP_ARCHIVE_LIMITS),
    );
    expect(failure(outcome).code).toBe("DECLARED_SIZE_EXCEEDS_ARCHIVE");
  });

  it("rejects path-traversal and absolute entry names", () => {
    for (const evil of [
      "../escape",
      "/etc/passwd",
      "a/../../b",
      "..",
      ".",
      "a\b",
      "a//b",
    ]) {
      const valid = singleEntryZip(
        "a".repeat(evil.length),
        new TextEncoder().encode("x"),
      );
      expectErrorCode(
        () => readZipArchive(patchCentralName(valid, 0, evil), tinyZipLimits),
        "INVALID_ENTRY_NAME",
      );
    }
  });

  it("rejects duplicate entry names", () => {
    // writeZipArchive already refuses duplicates; forge a second record with a
    // distinct name and patch it to collide.
    const distinct = writeZipArchive([
      { name: "entry.aaa", data: new TextEncoder().encode("one") },
      { name: "entry.bbb", data: new TextEncoder().encode("two") },
    ]);
    const forged = patchCentralName(distinct, 1, "entry.aaa");
    expectErrorCode(
      () => readZipArchive(forged, tinyZipLimits),
      "DUPLICATE_ENTRY",
    );
  });

  it("rejects overlapping entry data ranges", () => {
    const two = writeZipArchive([
      { name: "first.txt", data: new TextEncoder().encode("0123456789") },
      { name: "second.txt", data: new TextEncoder().encode("abcdefghij") },
    ]);
    const firstOffset = localOffsetOf(two, 0);
    const forged = patchCentralU32(two, 1, 42, firstOffset + 5);
    expectErrorCode(
      () => readZipArchive(forged, tinyZipLimits),
      "INVALID_ZIP_ARCHIVE",
    );
  });

  it("rejects multi-disk archives", () => {
    const valid = singleEntryZip("a.txt", new TextEncoder().encode("x"));
    patchU16(valid, valid.byteLength - 22 + 4, 1);
    expectErrorCode(
      () => readZipArchive(valid, tinyZipLimits),
      "INVALID_ZIP_ARCHIVE",
    );
  });

  it("rejects ZIP64 size markers", () => {
    const valid = singleEntryZip("a.txt", new TextEncoder().encode("x"));
    const forged = patchCentralU32(valid, 0, 20, 0xffff_ffff);
    expectErrorCode(
      () => readZipArchive(forged, tinyZipLimits),
      "INVALID_ZIP_ARCHIVE",
    );
  });

  it("rejects unsupported compression methods", () => {
    const valid = singleEntryZip("a.txt", new TextEncoder().encode("x"));
    const forged = patchCentralU32(valid, 0, 10, 8); // deflate
    expectErrorCode(
      () => readZipArchive(forged, tinyZipLimits),
      "UNSUPPORTED_ZIP_METHOD",
    );
  });

  it("rejects trailing bytes after the end of the central directory", () => {
    const valid = singleEntryZip("a.txt", new TextEncoder().encode("x"));
    const trailing = new Uint8Array(valid.byteLength + 4);
    trailing.set(valid);
    expectErrorCode(
      () => readZipArchive(trailing, tinyZipLimits),
      "INVALID_ZIP_ARCHIVE",
    );
  });

  it("rejects checksum mismatches", () => {
    const valid = singleEntryZip(
      "a.txt",
      new TextEncoder().encode("hello world"),
    );
    const corrupted = valid.slice();
    const dataStart = localOffsetOf(corrupted, 0) + 30 + 5; // name "a.txt" is 5 chars
    corrupted[dataStart + 3] = (corrupted[dataStart + 3] ?? 0) ^ 0xff;
    const outcome = structured(() => readZipArchive(corrupted, tinyZipLimits));
    expect(failure(outcome).code).toBe("CRC_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// VOX adversarial cases: counts, sizes, nesting, truncation
// ---------------------------------------------------------------------------

describe("adversarial VOX", () => {
  const header = [0x56, 0x4f, 0x58, 0x20, 0x96, 0x00, 0x00, 0x00];
  const main = (content: number): number[] => [
    0x4d,
    0x41,
    0x49,
    0x4e,
    0x00,
    0x00,
    0x00,
    0x00,
    content & 0xff,
    (content >>> 8) & 0xff,
    (content >>> 16) & 0xff,
    (content >>> 24) & 0xff,
  ];
  const chunkHeader = (
    id: string,
    content: number,
    children: number,
  ): number[] => [
    id.charCodeAt(0),
    id.charCodeAt(1),
    id.charCodeAt(2),
    id.charCodeAt(3),
    content & 0xff,
    (content >>> 8) & 0xff,
    (content >>> 16) & 0xff,
    (content >>> 24) & 0xff,
    children & 0xff,
    (children >>> 8) & 0xff,
    (children >>> 16) & 0xff,
    (children >>> 24) & 0xff,
  ];

  it("rejects files over the byte limit", () => {
    const bytes = new Uint8Array([
      ...header,
      ...main(0),
      ...chunkHeader("SIZE", 12, 0),
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    const outcome = structured(() =>
      parseVox(bytes, {
        maxFileBytes: 16,
        maxModels: 1,
        maxVoxelsPerModel: 1,
        maxTotalVoxels: 1,
        maxChunks: 4,
        maxUnknownChunkBytes: 0,
      }),
    );
    expect(failure(outcome).code).toBe("VOX_FILE_TOO_LARGE");
  });

  it("rejects chunk-count floods", () => {
    const chunks: number[] = [];
    for (let i = 0; i < 100; i += 1) chunks.push(...chunkHeader("ABCD", 0, 0));
    const bytes = new Uint8Array([
      ...header,
      ...main(chunks.length),
      ...chunks,
    ]);
    const outcome = structured(() =>
      parseVox(bytes, {
        maxFileBytes: 1 << 20,
        maxModels: 1,
        maxVoxelsPerModel: 1,
        maxTotalVoxels: 1,
        maxChunks: 8,
        maxUnknownChunkBytes: 4096,
      }),
    );
    expect(failure(outcome).code).toBe("VOX_TOO_MANY_CHUNKS");
  });

  it("rejects declared chunk sizes beyond the file", () => {
    const bytes = new Uint8Array([
      ...header,
      ...main(12),
      ...chunkHeader("SIZE", 0x7fff_ffff, 0),
    ]);
    const outcome = structured(() => parseVox(bytes));
    expect(["VOX_CHUNK_OVERFLOW", "VOX_TRUNCATED"]).toContain(
      failure(outcome).code,
    );
  });

  it("rejects PACK with zero models", () => {
    const bytes = new Uint8Array([
      ...header,
      ...main(4),
      ...chunkHeader("PACK", 4, 0),
      0,
      0,
      0,
      0,
    ]);
    const outcome = structured(() => parseVox(bytes));
    expect(outcome.ok).toBe(false);
  });

  it("rejects model axes beyond the 256 cap", () => {
    const size = [
      ...chunkHeader("SIZE", 12, 0),
      0x01,
      0x01,
      0x00,
      0x00,
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
    ];
    const bytes = new Uint8Array([...header, ...main(size.length), ...size]);
    const outcome = structured(() => parseVox(bytes));
    expect(outcome.ok).toBe(false);
  });

  it("rejects voxel counts exceeding the remaining bytes", () => {
    const xyzi = [
      ...chunkHeader("XYZI", 4, 0),
      0xff,
      0xff,
      0xff,
      0xff,
      0,
      0,
      0,
      1,
    ];
    const bytes = new Uint8Array([...header, ...main(xyzi.length), ...xyzi]);
    const outcome = structured(() => parseVox(bytes));
    expect(outcome.ok).toBe(false);
  });

  it("rejects total voxel floods across models", () => {
    const size = [
      ...chunkHeader("SIZE", 12, 0),
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
    ];
    const xyzi = [...chunkHeader("XYZI", 4, 0), 1, 0, 0, 0, 0, 0, 0, 1];
    const content = [...size, ...xyzi, ...size, ...xyzi];
    const bytes = new Uint8Array([
      ...header,
      ...main(content.length),
      ...content,
    ]);
    const outcome = structured(() =>
      parseVox(bytes, {
        maxFileBytes: 1 << 20,
        maxModels: 4,
        maxVoxelsPerModel: 1,
        maxTotalVoxels: 1,
        maxChunks: 16,
        maxUnknownChunkBytes: 4096,
      }),
    );
    expect(outcome.ok).toBe(false);
  });

  it("rejects unknown-chunk floods beyond the skip budget", () => {
    const unknown = [
      ...chunkHeader("JUNK", 64, 0),
      ...new Array<number>(64).fill(0),
    ];
    const bytes = new Uint8Array([
      ...header,
      ...main(unknown.length),
      ...unknown,
    ]);
    const outcome = structured(() =>
      parseVox(bytes, {
        maxFileBytes: 1 << 20,
        maxModels: 1,
        maxVoxelsPerModel: 1,
        maxTotalVoxels: 1,
        maxChunks: 16,
        maxUnknownChunkBytes: 8,
      }),
    );
    expect(outcome.ok).toBe(false);
  });

  it("rejects unsupported versions", () => {
    const bytes = new Uint8Array([
      0x56, 0x4f, 0x58, 0x20, 0x01, 0x00, 0x00, 0x00,
    ]);
    expectErrorCode(() => parseVox(bytes), "VOX_UNSUPPORTED_VERSION");
  });

  it("rejects wrong magic", () => {
    const bytes = new Uint8Array([
      0x00, 0x4f, 0x58, 0x20, 0x96, 0x00, 0x00, 0x00,
    ]);
    expectErrorCode(() => parseVox(bytes), "VOX_INVALID_MAGIC");
  });
});

// ---------------------------------------------------------------------------
// Container adversarial cases
// ---------------------------------------------------------------------------

describe("adversarial .vxl container", () => {
  const emptyManifest = (): Uint8Array =>
    encodeManifest({
      containerVersion: 1,
      documentSchemaVersion: 1,
      chunkEncodingVersion: 1,
      features: {},
      semanticHash: "0".repeat(64),
      entries: [],
    });

  it("rejects an index that omits the document entry", () => {
    // The manifest decoder enforces "exactly one document entry" (the
    // reader's MISSING_DOCUMENT check is defense in depth behind it).
    const valid = singleEntryZip("manifest.json", emptyManifest());
    const outcome = structured(() => readVxlProject(valid));
    expect(failure(outcome).code).toBe("INVALID_MANIFEST");
  });

  it("rejects an index that references a missing archive entry", () => {
    const manifest = encodeManifest({
      containerVersion: 1,
      documentSchemaVersion: 1,
      chunkEncodingVersion: 1,
      features: {},
      semanticHash: "0".repeat(64),
      entries: [
        { name: "document.json", kind: "document", size: 4, crc32: "00000000" },
      ],
    });
    const valid = singleEntryZip("manifest.json", manifest);
    const outcome = structured(() => readVxlProject(valid));
    expect(failure(outcome).code).toBe("MISSING_ENTRY");
  });

  it("rejects corrupted manifest JSON", () => {
    const bytes = singleEntryZip(
      "manifest.json",
      new TextEncoder().encode("{not json"),
    );
    const outcome = structured(() => readVxlProject(bytes));
    expect(failure(outcome).code).toBe("INVALID_MANIFEST");
  });

  it("rejects a document entry that is not valid JSON", () => {
    const archive = writeZipArchive([
      { name: "manifest.json", data: emptyManifest() },
      { name: "document.json", data: new TextEncoder().encode("{broken") },
    ]);
    // The reader must fail structured (unindexed entry or document parse).
    const outcome = structured(() => readVxlProject(archive));
    expect(outcome.ok).toBe(false);
  });

  it("stays structured when every byte of a valid container is flipped", () => {
    const rng = createSeededRng(0x44_f0_0002);
    const valid = writeVxlProject({
      document: createDocument({
        documentId: "document:adversarial:1" as never,
        metadata: {},
        rootNodeId: "node:adversarial:root" as never,
        nodes: [
          {
            nodeId: "node:adversarial:root" as never,
            name: "Root",
            parentId: null,
            children: [],
            transform: {
              translation: [0, 0, 0],
              pivot: [0, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
            components: [],
          },
        ],
        materials: [],
        volumes: [],
        animations: [],
      }),
    });
    for (let i = 0; i < 250; i += 1) {
      structured(() => readVxlProject(mutateBytes(valid, rng, 6)));
    }
    for (let offset = 0; offset <= valid.byteLength; offset += 1) {
      structured(() => readVxlProject(valid.slice(0, offset)));
    }
  });
});

// ---------------------------------------------------------------------------
// PNG encoder input validation (encode-side adversarial inputs)
// ---------------------------------------------------------------------------

describe("adversarial PNG encode inputs", () => {
  it("rejects non-finite and non-positive dimensions", () => {
    for (const dims of [
      [0, 1],
      [1, 0],
      [-1, 1],
      [1, -2],
      [Number.NaN, 1],
      [1, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, 1],
    ]) {
      expectErrorCode(
        () =>
          encodePng(new Uint8Array(4), dims[0] as number, dims[1] as number),
        "INVALID_IMAGE_DIMENSIONS",
      );
    }
  });

  it("rejects pixel bombs beyond the dimension and pixel caps", () => {
    const dims = [2049, 1];
    expectErrorCode(
      () => encodePng(new Uint8Array(4), dims[0] as number, dims[1] as number),
      "IMAGE_DIMENSION_LIMIT",
    );
    // PNG_MAX_PIXELS equals 2048x2048, so the dimension cap subsumes the
    // pixel cap; the pixel cap stays as defense in depth.
    expectErrorCode(
      () => encodePng(new Uint8Array(2049 * 2049 * 4), 2049, 2049),
      "IMAGE_DIMENSION_LIMIT",
    );
  });

  it("rejects mismatched pixel buffer lengths", () => {
    expectErrorCode(
      () => encodePng(new Uint8Array(4 * 2 * 2 - 1), 2, 2),
      "INVALID_IMAGE_BUFFER_LENGTH",
    );
    expectErrorCode(
      () => encodePng(new Uint8Array(4 * 2 * 2 + 1), 2, 2),
      "INVALID_IMAGE_BUFFER_LENGTH",
    );
  });
});
