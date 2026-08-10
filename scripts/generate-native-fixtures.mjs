#!/usr/bin/env node
/**
 * Regenerates the checked-in native `.vxl` fixture corpus in
 * `fixtures/native/` (plan S5.12, ticket #12): a golden round-trip
 * container plus adversarial and compatibility fixtures that
 * `readVxlProject` must reject with stable error codes.
 *
 * Requires a full build first (`pnpm build`), then:
 *   node scripts/generate-native-fixtures.mjs
 *
 * The script self-checks every fixture against `readVxlProject` before
 * writing anything, so the committed corpus and `corpus.json` always agree
 * with the reader's current behavior.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { TextDecoder, TextEncoder } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  documentId,
  materialId,
  nodeId,
  volumeId,
} from "../packages/shared/dist/index.js";
import {
  canonicalDocumentJson,
  createDocument,
} from "../packages/model/dist/index.js";
import { VoxelVolume } from "../packages/voxel/dist/index.js";
import {
  crc32,
  crc32Hex,
  decodeManifest,
  DOCUMENT_ENTRY,
  encodeVoxelVolume,
  encodeVolumeEntryName,
  MANIFEST_ENTRY,
  readVxlProject,
  readZipArchive,
  seedReadView,
  VXL_VOLUME_CHUNK_PAYLOAD_BYTES,
  VXL_VOLUME_CHUNK_RECORD_BYTES,
  VXL_VOLUME_HEADER_BYTES,
  VXL_VOLUME_MAGIC,
  writeVxlProject,
  writeZipArchive,
} from "../packages/formats/dist/index.js";

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "native",
);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const capability = { __kind: "VoxelWriteCapability" };

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

const BODY = volumeId("volume:fixture:body");
const ARM = volumeId("volume:fixture:arm");

function goldenDocument() {
  return createDocument({
    documentId: documentId("document:fixture:0001"),
    metadata: { title: "native fixture corpus" },
    rootNodeId: nodeId("node:fixture:root"),
    nodes: [
      {
        nodeId: nodeId("node:fixture:root"),
        name: "Root",
        parentId: null,
        children: [nodeId("node:fixture:child")],
        transform: identity,
        components: [],
      },
      {
        nodeId: nodeId("node:fixture:child"),
        name: "Child",
        parentId: nodeId("node:fixture:root"),
        children: [nodeId("node:fixture:arm")],
        transform: identity,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: BODY }],
      },
      {
        nodeId: nodeId("node:fixture:arm"),
        name: "Arm",
        parentId: nodeId("node:fixture:child"),
        children: [],
        transform: identity,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: ARM }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "stone",
        color: "#aabbcc",
        opacity: 1,
        roughness: 0.8,
        metallic: 0,
        emissive: 0,
      },
      {
        materialId: materialId(2),
        name: "brick",
        color: "#cc6644",
        opacity: 1,
        roughness: 0.9,
        metallic: 0,
        emissive: 0,
      },
      {
        materialId: materialId(3),
        name: "glass",
        color: "#88ccff",
        opacity: 0.4,
        roughness: 0.1,
        metallic: 0.2,
        emissive: 0,
      },
    ],
    volumes: [{ volumeId: BODY }, { volumeId: ARM }],
    animations: [
      {
        animationId: "animation:fixture:spin",
        name: "Spin",
        duration: 2,
        loop: "loop",
        tracks: [
          {
            trackId: "track:fixture:spin",
            targetNodeId: nodeId("node:fixture:child"),
            interpolation: "linear",
            keyframes: [
              {
                keyframeId: "keyframe:fixture:spin:0",
                time: 0,
                property: { channel: "rotation", value: [0, 0, 0, 1] },
              },
            ],
          },
        ],
      },
    ],
  });
}

const volumeLimits = {
  maxCoordinate: 1_048_575,
  maxExtent: 2_048,
  maxChunks: 262_144,
  maxOccupiedVoxels: 1_000_000,
  maxCoordinatesPerOperation: 1_000_000,
};

function goldenVolumes() {
  const body = new VoxelVolume(BODY, volumeLimits, capability);
  body.setVoxel([0, 0, 0], 1, capability);
  body.setVoxel([-1, 0, 1], 2, capability);
  body.setVoxel([100, -50, 7], 1, capability);
  const arm = new VoxelVolume(ARM, volumeLimits, capability);
  arm.setVoxel([5, 5, 5], 1, capability);
  arm.setVoxel([-30, 2, 0], 3, capability);
  return new Map([
    [BODY, body],
    [ARM, arm],
  ]);
}

/** Builds a raw ZIP with per-record overrides for structural forgeries. */
function buildRawZip(entries, options = {}) {
  const {
    entriesOnDisk,
    totalEntries,
    diskNumber = 0,
    diskWithCentral = 0,
  } = options;
  const prepared = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data ?? new Uint8Array(0);
    const local = entry.local ?? {};
    const central = entry.central ?? {};
    const compressedSize = central.compressedSize ?? data.byteLength;
    return {
      nameBytes,
      data,
      local: {
        method: local.method ?? entry.method ?? 0,
        crc: local.crc ?? entry.crc ?? crc32(data),
        compressedSize: local.compressedSize ?? compressedSize,
        uncompressedSize: local.uncompressedSize ?? compressedSize,
        nameLength: local.nameLength ?? nameBytes.byteLength,
        extraLength: local.extraLength ?? 0,
      },
      central: {
        method: central.method ?? entry.method ?? 0,
        crc: central.crc ?? entry.crc ?? crc32(data),
        compressedSize,
        uncompressedSize: central.uncompressedSize ?? compressedSize,
        nameLength: central.nameLength ?? nameBytes.byteLength,
        extraLength: central.extraLength ?? 0,
        commentLength: central.commentLength ?? 0,
        localOffset: central.localOffset ?? 0,
      },
    };
  });
  let cursor = 0;
  for (const entry of prepared) {
    entry.localOffset = entry.central.localOffset;
    cursor +=
      30 +
      entry.local.nameLength +
      entry.local.extraLength +
      entry.data.byteLength;
  }
  const centralOffset = cursor;
  let centralSize = 0;
  for (const entry of prepared) {
    centralSize +=
      46 +
      entry.central.nameLength +
      entry.central.extraLength +
      entry.central.commentLength;
  }
  const out = new Uint8Array(centralOffset + centralSize + 22);
  const view = new DataView(out.buffer);
  const u16 = (offset, value) => view.setUint16(offset, value & 0xffff, true);
  const u32 = (offset, value) => view.setUint32(offset, value >>> 0, true);
  cursor = 0;
  for (const entry of prepared) {
    u32(cursor, 0x0403_4b50);
    u16(cursor + 4, 20);
    u16(cursor + 6, 0x0800);
    u16(cursor + 8, entry.local.method);
    u16(cursor + 10, 0);
    u16(cursor + 12, 0);
    u32(cursor + 14, entry.local.crc);
    u32(cursor + 18, entry.local.compressedSize);
    u32(cursor + 22, entry.local.uncompressedSize);
    u16(cursor + 26, entry.local.nameLength);
    u16(cursor + 28, entry.local.extraLength);
    cursor += 30;
    out.set(entry.nameBytes, cursor);
    cursor += entry.local.nameLength;
    out.set(entry.data, cursor);
    cursor += entry.data.byteLength;
  }
  for (const entry of prepared) {
    u32(cursor, 0x0201_4b50);
    u16(cursor + 4, 20);
    u16(cursor + 6, 20);
    u16(cursor + 8, 0x0800);
    u16(cursor + 10, entry.central.method);
    u16(cursor + 12, 0);
    u16(cursor + 14, 0);
    u32(cursor + 16, entry.central.crc);
    u32(cursor + 20, entry.central.compressedSize);
    u32(cursor + 24, entry.central.uncompressedSize);
    u16(cursor + 28, entry.central.nameLength);
    u16(cursor + 30, entry.central.extraLength);
    u16(cursor + 32, entry.central.commentLength);
    u16(cursor + 34, 0);
    u16(cursor + 36, 0);
    u32(cursor + 38, 0);
    u32(cursor + 42, entry.localOffset);
    cursor += 46;
    out.set(entry.nameBytes, cursor);
    cursor += entry.central.nameLength;
    cursor += entry.central.extraLength; // zero padding
    cursor += entry.central.commentLength; // zero padding
  }
  u32(cursor, 0x0605_4b50);
  u16(cursor + 4, diskNumber);
  u16(cursor + 6, diskWithCentral);
  u16(cursor + 8, entriesOnDisk ?? prepared.length);
  u16(cursor + 10, totalEntries ?? prepared.length);
  u32(cursor + 12, centralSize);
  u32(cursor + 16, centralOffset);
  u16(cursor + 20, 0);
  return out;
}

/** Golden container entries: manifest, document, both voxel binaries. */
function goldenEntries() {
  const bytes = writeVxlProject({
    document: goldenDocument(),
    volumes: goldenVolumes(),
  });
  return readZipArchive(bytes);
}

function entriesToZip(entries) {
  return writeZipArchive(entries.map(({ name, data }) => ({ name, data })));
}

/** Patches the manifest JSON and rebuilds the container from entries. */
function withPatchedManifest(entries, mutate) {
  const manifestEntry = entries.find((entry) => entry.name === MANIFEST_ENTRY);
  if (manifestEntry === undefined) throw new Error("missing manifest entry");
  const manifest = JSON.parse(decoder.decode(manifestEntry.data));
  mutate(manifest);
  return entriesToZip(
    entries.map((entry) =>
      entry.name === MANIFEST_ENTRY
        ? { name: entry.name, data: encoder.encode(JSON.stringify(manifest)) }
        : entry,
    ),
  );
}

/** Replaces the document JSON (with CRC refresh) and rebuilds the container. */
function withPatchedDocument(entries, mutate) {
  const manifestEntry = entries.find((entry) => entry.name === MANIFEST_ENTRY);
  if (manifestEntry === undefined) throw new Error("missing manifest entry");
  const documentEntry = entries.find((entry) => entry.name === DOCUMENT_ENTRY);
  if (documentEntry === undefined) throw new Error("missing document entry");
  const manifest = JSON.parse(decoder.decode(manifestEntry.data));
  const document = JSON.parse(decoder.decode(documentEntry.data));
  const patched = mutate(document);
  const documentBytes = encoder.encode(JSON.stringify(patched));
  const documentIndex = manifest.entries.findIndex(
    (entry) => entry.name === DOCUMENT_ENTRY,
  );
  manifest.entries[documentIndex].size = documentBytes.byteLength;
  manifest.entries[documentIndex].crc32 = crc32Hex(documentBytes);
  return entriesToZip([
    { name: MANIFEST_ENTRY, data: encoder.encode(JSON.stringify(manifest)) },
    { name: DOCUMENT_ENTRY, data: documentBytes },
    ...entries.filter(
      (entry) => entry.name !== MANIFEST_ENTRY && entry.name !== DOCUMENT_ENTRY,
    ),
  ]);
}

/**
 * Replaces one container entry's bytes and refreshes its manifest index
 * (size and CRC-32) so the zip-level checks pass and the reader reaches the
 * intended per-entry validation.
 */
function withReplacedEntry(entries, name, data) {
  const manifestEntry = entries.find((entry) => entry.name === MANIFEST_ENTRY);
  if (manifestEntry === undefined) throw new Error("missing manifest entry");
  const manifest = JSON.parse(decoder.decode(manifestEntry.data));
  const indexed = manifest.entries.find((entry) => entry.name === name);
  if (indexed === undefined) throw new Error(`entry ${name} is not indexed`);
  indexed.size = data.byteLength;
  indexed.crc32 = crc32Hex(data);
  return entriesToZip(
    entries.map((entry) =>
      entry.name === name
        ? { name: entry.name, data }
        : entry.name === MANIFEST_ENTRY
          ? { name: entry.name, data: encoder.encode(JSON.stringify(manifest)) }
          : entry,
    ),
  );
}

/** A crafted volume binary: header plus optional raw chunk records. */
function volumeBinary(chunkCount, recordBytes = new Uint8Array(0)) {
  const bytes = new Uint8Array(
    VXL_VOLUME_HEADER_BYTES + recordBytes.byteLength,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, VXL_VOLUME_MAGIC, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 16, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, chunkCount, true);
  view.setUint32(24, 0, true);
  bytes.set(recordBytes, VXL_VOLUME_HEADER_BYTES);
  return bytes;
}

/**
 * Encodes hand-crafted chunk seeds into a volume binary (the live encoder
 * never holds an empty chunk or an over-limit volume, so the limit
 * fixtures are built from raw seeds via `seedReadView`, the same read
 * surface the container reader uses after decoding). `values` maps
 * X-fastest local indexes to material values; missing indexes are 0.
 */
function chunkedVolumeBinary(chunks) {
  const seeds = chunks.map((chunk) => {
    const values = new Uint16Array(4096);
    for (const [index, value] of Object.entries(chunk.values)) {
      values[Number(index)] = value;
    }
    return { coordinate: chunk.coordinate, values };
  });
  return encodeVoxelVolume(seedReadView(BODY, seeds));
}

/** Golden body volume binary extracted from the golden container. */
function goldenBodyBinary(entries) {
  const entry = entries.find(
    (entry) =>
      entry.name.startsWith("voxels/") && entry.name.endsWith("body.bin"),
  );
  if (entry === undefined) throw new Error("missing body voxel entry");
  return entry.data;
}

const encoderText = (text) => encoder.encode(text);

/** Builds every fixture. `build` must return `{ bytes, expected }`. */
const fixtures = {
  "traversal-path": {
    vector: "zip entry name escapes the container with .. segments",
    build: () => ({
      bytes: buildRawZip([
        { name: "../escape", data: encoderText("x") },
        { name: "document.json", data: encoderText("{}") },
      ]),
      expected: { family: "io", code: "INVALID_ENTRY_NAME" },
    }),
  },
  "traversal-backslash": {
    vector: "zip entry name uses a backslash separator",
    build: () => ({
      bytes: buildRawZip([
        { name: "a\\b", data: encoderText("x") },
        { name: "document.json", data: encoderText("{}") },
      ]),
      expected: { family: "io", code: "INVALID_ENTRY_NAME" },
    }),
  },
  "duplicate-entries": {
    vector: "two zip central records share one entry name",
    build: () => ({
      bytes: buildRawZip([
        { name: "document.json", data: encoderText("x") },
        { name: "document.json", data: encoderText("y") },
      ]),
      expected: { family: "io", code: "DUPLICATE_ENTRY" },
    }),
  },
  "compressed-entry": {
    vector: "zip entry uses deflate instead of the stored-only v1 method",
    build: () => ({
      bytes: buildRawZip([
        { name: "document.json", data: encoderText("x"), method: 8 },
      ]),
      expected: { family: "compatibility", code: "UNSUPPORTED_ZIP_METHOD" },
    }),
  },
  "bomb-declared-sizes": {
    vector: "tiny file declares a gigabyte of stored content (ratio preflight)",
    build: () => ({
      bytes: buildRawZip([
        {
          name: "document.json",
          data: encoderText("x"),
          central: { compressedSize: 1 << 20, uncompressedSize: 1 << 20 },
          local: { compressedSize: 1 << 20, uncompressedSize: 1 << 20 },
        },
      ]),
      expected: { family: "io", code: "DECLARED_SIZE_EXCEEDS_ARCHIVE" },
    }),
  },
  "huge-entry-count": {
    vector: "EOCD claims thousands of entries in a one-entry archive",
    build: () => ({
      bytes: buildRawZip([{ name: "document.json", data: encoderText("x") }], {
        entriesOnDisk: 5_000,
        totalEntries: 5_000,
      }),
      expected: { family: "limit", code: "ENTRY_LIMIT_EXCEEDED" },
    }),
  },
  "zip64-extra-length": {
    vector: "central record uses the 0xFFFF ZIP64 marker for extra length",
    build: () => ({
      bytes: buildRawZip([
        {
          name: "document.json",
          data: encoderText("x"),
          central: { extraLength: 0xffff },
        },
      ]),
      expected: { family: "io", code: "INVALID_ZIP_ARCHIVE" },
    }),
  },
  "zip64-offset": {
    vector: "central record uses the 0xFFFFFFFF ZIP64 marker for local offset",
    build: () => ({
      bytes: buildRawZip([
        {
          name: "document.json",
          data: encoderText("x"),
          central: { localOffset: 0xffff_ffff },
        },
      ]),
      expected: { family: "io", code: "INVALID_ZIP_ARCHIVE" },
    }),
  },
  "empty-archive": {
    vector: "valid EOCD with zero entries",
    build: () => ({
      bytes: buildRawZip([]),
      expected: { family: "io", code: "INVALID_ZIP_ARCHIVE" },
    }),
  },
  "multi-disk-archive": {
    vector: "EOCD claims a multi-disk archive",
    build: () => ({
      bytes: buildRawZip([{ name: "document.json", data: encoderText("x") }], {
        diskNumber: 1,
      }),
      expected: { family: "io", code: "INVALID_ZIP_ARCHIVE" },
    }),
  },
  "truncated-archive": {
    vector: "valid container cut off before its end-of-central-directory",
    build: () => {
      const entries = goldenEntries();
      const bytes = entriesToZip(entries);
      return {
        bytes: bytes.slice(0, Math.floor(bytes.byteLength * 0.4)),
        expected: { family: "io", code: "INVALID_ZIP_ARCHIVE" },
      };
    },
  },
  "checksum-mismatch": {
    vector: "one data byte flipped inside document.json",
    build: () => {
      const entries = goldenEntries();
      const bytes = entriesToZip(entries);
      const corrupt = bytes.slice();
      // Local header 1 (30) + name "manifest.json" (12) + manifest data,
      // then local header 2 (30) + name "document.json" (13) + data.
      const manifestEntry = entries.find(
        (entry) => entry.name === MANIFEST_ENTRY,
      );
      if (manifestEntry === undefined)
        throw new Error("missing manifest entry");
      const documentDataStart =
        30 +
        MANIFEST_ENTRY.length +
        manifestEntry.data.byteLength +
        30 +
        DOCUMENT_ENTRY.length;
      corrupt[documentDataStart + 10] ^= 0xff;
      return {
        bytes: corrupt,
        expected: { family: "io", code: "CRC_MISMATCH" },
      };
    },
  },
  "manifest-checksum-mismatch": {
    vector: "manifest index checksum disagrees with the document entry",
    build: () => ({
      bytes: withPatchedManifest(goldenEntries(), (manifest) => {
        const document = manifest.entries.find(
          (entry) => entry.name === DOCUMENT_ENTRY,
        );
        document.crc32 = "00000000";
      }),
      expected: { family: "io", code: "ENTRY_CHECKSUM_MISMATCH" },
    }),
  },
  "missing-indexed-entry": {
    vector: "manifest indexes a voxel entry absent from the zip",
    build: () => {
      const entries = goldenEntries().filter(
        (entry) => !entry.name.startsWith("voxels/"),
      );
      return {
        bytes: entriesToZip(entries),
        expected: { family: "io", code: "MISSING_ENTRY" },
      };
    },
  },
  "unindexed-entry": {
    vector: "zip carries an entry the manifest index does not list",
    build: () => {
      const entries = goldenEntries();
      return {
        bytes: entriesToZip([
          ...entries,
          { name: "previews/extra.png", data: encoderText("png") },
        ]),
        expected: { family: "io", code: "UNINDEXED_ENTRY" },
      };
    },
  },
  "missing-manifest": {
    vector: "zip has no manifest.json entry at all",
    build: () => ({
      bytes: entriesToZip(
        goldenEntries().filter((entry) => entry.name !== MANIFEST_ENTRY),
      ),
      expected: { family: "io", code: "MISSING_MANIFEST" },
    }),
  },
  "dangling-material-reference": {
    vector: "voxel values reference a material the document does not declare",
    build: () => ({
      bytes: withPatchedDocument(goldenEntries(), (document) => {
        delete document.materials["3"];
        return document;
      }),
      expected: { family: "validation", code: "MISSING_MATERIAL" },
    }),
  },
  "document-missing-volume": {
    vector: "document references a volume with no container entry",
    build: () => {
      const entries = goldenEntries().filter(
        (entry) =>
          !entry.name.startsWith("voxels/") || entry.name.endsWith("body.bin"),
      );
      const manifestEntry = entries.find(
        (entry) => entry.name === MANIFEST_ENTRY,
      );
      const manifest = JSON.parse(decoder.decode(manifestEntry.data));
      manifest.entries = manifest.entries.filter(
        (entry) =>
          !entry.name.startsWith("voxels/") || entry.name.endsWith("body.bin"),
      );
      return {
        bytes: entriesToZip(
          entries.map((entry) =>
            entry.name === MANIFEST_ENTRY
              ? {
                  name: entry.name,
                  data: encoder.encode(JSON.stringify(manifest)),
                }
              : entry,
          ),
        ),
        expected: { family: "io", code: "MISSING_VOLUME_ENTRY" },
      };
    },
  },
  "volume-not-in-document": {
    vector: "container carries a voxel entry for an unknown volume",
    build: () => {
      const extraId = "volume:extra:0001";
      const extraName = encodeVolumeEntryName(extraId);
      const emptyBinary = volumeBinary(0);
      const entries = goldenEntries();
      const manifestEntry = entries.find(
        (entry) => entry.name === MANIFEST_ENTRY,
      );
      const manifest = JSON.parse(decoder.decode(manifestEntry.data));
      manifest.entries.push({
        name: extraName,
        kind: "voxels",
        volumeId: extraId,
        size: emptyBinary.byteLength,
        crc32: crc32Hex(emptyBinary),
      });
      return {
        bytes: entriesToZip([
          {
            name: MANIFEST_ENTRY,
            data: encoder.encode(JSON.stringify(manifest)),
          },
          ...entries.filter((entry) => entry.name !== MANIFEST_ENTRY),
          { name: extraName, data: emptyBinary },
        ]),
        expected: { family: "io", code: "VOLUME_NOT_IN_DOCUMENT" },
      };
    },
  },
  "cycle-hierarchy": {
    vector: "document node parent graph contains a cycle",
    build: () => {
      const nodes = {
        "node:cycle:root": {
          nodeId: "node:cycle:root",
          parentId: null,
          children: [],
          transform: identity,
          components: [],
        },
        "node:cycle:a": {
          nodeId: "node:cycle:a",
          parentId: "node:cycle:b",
          children: ["node:cycle:b"],
          transform: identity,
          components: [],
        },
        "node:cycle:b": {
          nodeId: "node:cycle:b",
          parentId: "node:cycle:a",
          children: ["node:cycle:a"],
          transform: identity,
          components: [],
        },
      };
      return {
        bytes: withPatchedDocument(goldenEntries(), (document) => ({
          ...document,
          rootNodeId: "node:cycle:root",
          nodes,
          volumes: {},
          animations: {},
        })),
        expected: { family: "validation", code: "CYCLIC_HIERARCHY" },
      };
    },
  },
  "huge-chunk-table": {
    vector: "volume binary declares an impossible chunk count",
    build: () => {
      const binary = volumeBinary(0xffff_ffff);
      return {
        bytes: withReplacedEntry(
          goldenEntries(),
          encodeVolumeEntryName(BODY),
          binary,
        ),
        expected: { family: "limit", code: "TOO_MANY_CHUNKS" },
      };
    },
  },
  "chunk-offset-overflow": {
    vector:
      "volume chunk record claims a u64 offset beyond the safe integer domain",
    build: () => {
      const record = new Uint8Array(VXL_VOLUME_CHUNK_RECORD_BYTES);
      const view = new DataView(record.buffer);
      view.setInt32(0, 0, true);
      view.setInt32(4, 0, true);
      view.setInt32(8, 0, true);
      view.setBigUint64(12, 0xffff_ffff_ffff_ffffn, true);
      view.setUint32(20, VXL_VOLUME_CHUNK_PAYLOAD_BYTES, true);
      const payload = new Uint8Array(VXL_VOLUME_CHUNK_PAYLOAD_BYTES);
      const binary = new Uint8Array(
        VXL_VOLUME_HEADER_BYTES + record.byteLength + payload.byteLength,
      );
      binary.set(volumeBinary(1, record));
      binary.set(payload, VXL_VOLUME_HEADER_BYTES + record.byteLength);
      return {
        bytes: withReplacedEntry(
          goldenEntries(),
          encodeVolumeEntryName(BODY),
          binary,
        ),
        expected: { family: "io", code: "INVALID_CHUNK_OFFSET" },
      };
    },
  },
  "chunk-crc-mismatch": {
    vector: "volume chunk payload byte flipped after the table was written",
    build: () => {
      const binary = goldenBodyBinary(goldenEntries()).slice();
      binary[VXL_VOLUME_HEADER_BYTES + 3 * VXL_VOLUME_CHUNK_RECORD_BYTES + 5] ^=
        0xff;
      return {
        bytes: withReplacedEntry(
          goldenEntries(),
          encodeVolumeEntryName(BODY),
          binary,
        ),
        expected: { family: "io", code: "CRC_MISMATCH" },
      };
    },
  },
  "semantic-hash-mismatch": {
    vector: "manifest semantic hash disagrees with the reconstructed asset",
    build: () => ({
      bytes: withPatchedManifest(goldenEntries(), (manifest) => {
        manifest.semanticHash = "0".repeat(64);
      }),
      expected: { family: "io", code: "SEMANTIC_HASH_MISMATCH" },
    }),
  },
  "unknown-document-field": {
    vector:
      "document.json carries a top-level field the v1 schema does not know",
    build: () => ({
      bytes: withPatchedDocument(goldenEntries(), (document) => ({
        ...document,
        bogusField: true,
      })),
      expected: { family: "validation", code: "UNKNOWN_FIELD" },
    }),
  },
  "unknown-component-version": {
    vector: "document node component claims an unsupported schema version",
    build: () => ({
      bytes: withPatchedDocument(goldenEntries(), (document) => {
        document.nodes["node:fixture:child"].components[0].schemaVersion = 2;
        return document;
      }),
      expected: { family: "validation", code: "UNSUPPORTED_COMPONENT_VERSION" },
    }),
  },
  "lying-document-version": {
    vector: "manifest claims v1 while document.json claims a future version",
    build: () => ({
      bytes: withPatchedDocument(goldenEntries(), (document) => ({
        ...document,
        documentSchemaVersion: 2,
      })),
      expected: {
        family: "compatibility",
        code: "UNSUPPORTED_DOCUMENT_VERSION",
      },
    }),
  },
  "future-container-v2": {
    vector: "unknown future container version",
    build: () => ({
      bytes: withPatchedManifest(goldenEntries(), (manifest) => {
        manifest.containerVersion = 2;
      }),
      expected: {
        family: "compatibility",
        code: "UNSUPPORTED_CONTAINER_VERSION",
      },
    }),
  },
  "future-document-v2": {
    vector: "manifest declares an unknown future document schema version",
    build: () => ({
      bytes: withPatchedManifest(goldenEntries(), (manifest) => {
        manifest.documentSchemaVersion = 2;
      }),
      expected: {
        family: "compatibility",
        code: "UNSUPPORTED_DOCUMENT_VERSION",
      },
    }),
  },
  "future-chunk-encoding-v2": {
    vector: "manifest declares an unknown future chunk encoding version",
    build: () => ({
      bytes: withPatchedManifest(goldenEntries(), (manifest) => {
        manifest.chunkEncodingVersion = 2;
      }),
      expected: {
        family: "compatibility",
        code: "UNSUPPORTED_CHUNK_ENCODING_VERSION",
      },
    }),
  },
  "unknown-manifest-field": {
    vector: "manifest carries a field this version does not know",
    build: () => ({
      bytes: withPatchedManifest(goldenEntries(), (manifest) => {
        manifest.bogusField = true;
      }),
      expected: { family: "compatibility", code: "UNKNOWN_MANIFEST_FIELD" },
    }),
  },
  "unknown-entry-field": {
    vector: "manifest entry carries a field this version does not know",
    build: () => ({
      bytes: withPatchedManifest(goldenEntries(), (manifest) => {
        manifest.entries[0].bogusField = true;
      }),
      expected: { family: "compatibility", code: "UNKNOWN_MANIFEST_FIELD" },
    }),
  },
  "empty-chunk": {
    vector:
      "volume chunk record with an all-zero payload (canonical non-emptiness)",
    build: () => ({
      bytes: withReplacedEntry(
        goldenEntries(),
        encodeVolumeEntryName(BODY),
        chunkedVolumeBinary([{ coordinate: [0, 0, 0], values: {} }]),
      ),
      expected: { family: "validation", code: "EMPTY_CHUNK" },
    }),
  },
  "over-extent": {
    vector: "occupied voxel extent exceeds the ADR-0009 per-axis limit",
    build: () => ({
      // Voxels at x=0 and x=2064 span an occupied extent of 2064 > 2048.
      bytes: withReplacedEntry(
        goldenEntries(),
        encodeVolumeEntryName(BODY),
        chunkedVolumeBinary([
          { coordinate: [0, 0, 0], values: { 0: 1 } },
          { coordinate: [129, 0, 0], values: { 0: 1 } },
        ]),
      ),
      expected: { family: "limit", code: "EXTENT_LIMIT_EXCEEDED" },
    }),
  },
  "over-occupied": {
    vector: "occupied voxel count exceeds the ADR-0009 1,000,000 limit",
    build: () => {
      // 256 fully occupied chunks = 1,048,576 voxels within the 2048
      // extent box (128 x-chunks by 2 y-chunks), so only the occupied-
      // voxel limit trips.
      const full = {};
      for (let i = 0; i < 4096; i += 1) full[i] = 1;
      const chunks = [];
      for (let x = 0; x < 128; x += 1) {
        for (let y = 0; y < 2; y += 1) {
          chunks.push({ coordinate: [x, y, 0], values: full });
        }
      }
      return {
        bytes: withReplacedEntry(
          goldenEntries(),
          encodeVolumeEntryName(BODY),
          chunkedVolumeBinary(chunks),
        ),
        expected: { family: "limit", code: "TOO_MANY_OCCUPIED_VOXELS" },
      };
    },
  },
};

/** Verifies one fixture against the reader; returns nothing or throws. */
function assertRejected(name, bytes, expected) {
  let thrown = undefined;
  try {
    readVxlProject(bytes);
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(
      `fixture ${name} unexpectedly loaded; expected ${expected.family}/${expected.code}`,
    );
  }
  const actual = { family: thrown.family, code: thrown.code };
  if (actual.family !== expected.family || actual.code !== expected.code) {
    throw new Error(
      `fixture ${name} rejected with ${actual.family}/${actual.code}; expected ${expected.family}/${expected.code}`,
    );
  }
}

async function main() {
  const golden = writeVxlProject({
    document: goldenDocument(),
    volumes: goldenVolumes(),
  });
  const loaded = readVxlProject(golden);
  const manifest = decodeManifest(
    readZipArchive(golden).find((entry) => entry.name === MANIFEST_ENTRY).data,
  );
  const documentJson = canonicalDocumentJson(loaded.document);
  const goldenRecord = {
    file: "golden-roundtrip.vxl",
    documentJson: "golden-roundtrip.document.json",
    semanticHash: loaded.semanticHash,
    byteLength: golden.byteLength,
    entryCount: manifest.entries.length,
  };

  const rejected = [];
  for (const [name, fixture] of Object.entries(fixtures)) {
    const { bytes, expected } = fixture.build();
    assertRejected(name, bytes, expected);
    rejected.push({
      file: `${name}.vxl`,
      vector: fixture.vector,
      family: expected.family,
      code: expected.code,
    });
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, goldenRecord.file), golden);
  await writeFile(join(OUT_DIR, goldenRecord.documentJson), documentJson);
  for (const [name] of Object.entries(fixtures)) {
    const { bytes } = fixtures[name].build();
    await writeFile(join(OUT_DIR, `${name}.vxl`), bytes);
  }
  await writeFile(
    join(OUT_DIR, "corpus.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generator: "scripts/generate-native-fixtures.mjs",
        golden: goldenRecord,
        rejected,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(OUT_DIR, "README.md"),
    `# Native \`.vxl\` fixture corpus (ticket #12, plan S5.12)

Checked-in golden and adversarial \`.vxl\` containers used by
\`packages/formats/src/fixtures.test.ts\` to prove that the reader preflights
every untrusted surface (plan S5.4, ADR-0004): paths, duplicate entries,
entry counts, compressed and uncompressed sizes, ratios, offsets, lengths,
dimensions, checksums, integer overflow, and unknown versions — and that a
rejected or incompatible file can never yield a partial asset or overwrite
its source.

- \`golden-roundtrip.vxl\` + \`golden-roundtrip.document.json\`: the byte-
  stable output of the deterministic writer for the fixed fixture asset.
  Reloading it must succeed, reproduce the recorded semantic hash, and the
  writer must reproduce the exact bytes (writer drift is a test failure).
- \`corpus.json\`: machine-readable index; every other fixture is expected
  to be rejected with exactly the listed \`family\`/\`code\`.
- \`empty-chunk.vxl\`, \`over-extent.vxl\`, \`over-occupied.vxl\` (issue #100):
  volume binaries that are structurally well-formed but violate canonical
  non-emptiness, the ADR-0009 per-axis occupied extent, or the
  occupied-voxel limit; the reader must reject them with
  \`EMPTY_CHUNK\`/\`EXTENT_LIMIT_EXCEEDED\`/\`TOO_MANY_OCCUPIED_VOXELS\`
  before any seed is returned.
- The golden semantic hash follows the frozen v1 chunk framing of exactly
  8,192 payload bytes per chunk (issue #85): the writer was corrected to
  the contract (it had framed 16,384 bytes per chunk), so the corpus was
  regenerated and needs no reader-side migration; manifests written with
  the old framing fail \`readVxlProject\` with \`SEMANTIC_HASH_MISMATCH\`.

Every fixture is generated by \`scripts/generate-native-fixtures.mjs\`,
which self-checks each file against \`readVxlProject\` before writing, so
the corpus can never drift from the reader. Regenerate after a build with:

\`\`\`sh
pnpm build
node scripts/generate-native-fixtures.mjs
\`\`\`
`,
  );
  console.log(
    `Wrote ${1 + rejected.length} fixtures to ${OUT_DIR} (golden ${golden.byteLength} bytes).`,
  );
}

await main();
