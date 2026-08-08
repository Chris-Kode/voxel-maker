import {
  WorkspaceError,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import {
  canonicalDocumentJson,
  DEFAULT_DOCUMENT_LIMITS,
  parseDocument,
  type DocumentLimits,
  type VoxelDocument,
} from "@voxel-maker/model";
import {
  CHUNK_EDGE,
  CHUNK_VOXEL_COUNT,
  DEFAULT_VOXEL_VOLUME_LIMITS,
  chunkKey,
  type VoxelChunkSeed,
  type VoxelVolumeLimits,
  type VoxelVolumeReadView,
} from "@voxel-maker/voxel";
import { canonicalAssetSemanticHash } from "@voxel-maker/document";
import {
  decodeManifest,
  encodeManifest,
  VXL_CONTAINER_VERSION,
  VXL_DOCUMENT_VERSION,
  VXL_CHUNK_ENCODING_VERSION,
  type VxlManifest,
  type VxlManifestEntry,
} from "./manifest.js";
import { decodeVoxelVolume, encodeVoxelVolume } from "./volume-binary.js";
import {
  DEFAULT_ZIP_ARCHIVE_LIMITS,
  isValidEntryName,
  readZipArchive,
  writeZipArchive,
  type ZipArchiveLimits,
  type ZipEntry,
  type ZipEntryInput,
} from "./zip.js";
import { crc32Hex } from "./crc32.js";

/**
 * Version 1 native `.vxl` container writer and reader (plan S5.2-S5.5,
 * ADR-0004, docs/format/vxl-v1.md). The writer produces a deterministic
 * stored-entry ZIP in canonical order (manifest, document, sorted voxel
 * binaries, optional previews) and indexes every entry with size and CRC-32
 * in the manifest. The reader preflights the ZIP, cross-checks the manifest
 * index against the actual entries, reconstructs the document and volume
 * chunk streams, verifies the semantic hash, and returns a validated load
 * that callers install through `createDocumentStore` (validated lifecycle
 * replacement).
 */

export const MANIFEST_ENTRY = "manifest.json";
export const DOCUMENT_ENTRY = "document.json";
export const VOXELS_PREFIX = "voxels/";
export const PREVIEWS_PREFIX = "previews/";
const VOXELS_SUFFIX = ".bin";

/** One optional preview image; outside the semantic hash. */
export interface VxlPreviewInput {
  /** Full entry name under `previews/`; must satisfy container path rules. */
  readonly name: string;
  readonly data: Uint8Array;
}

/** Inputs for the deterministic container writer. */
export interface VxlWriteInput {
  readonly document: VoxelDocument;
  /**
   * Read views of every volume to persist, keyed by Volume ID. A document
   * volume missing from this map is written as an empty volume so the index
   * stays complete; volumes not in the document are rejected.
   */
  readonly volumes?: ReadonlyMap<VolumeId, VoxelVolumeReadView>;
  readonly previews?: readonly VxlPreviewInput[];
}

/** One decoded volume ready for validated install. */
export interface LoadedVxlVolume {
  readonly volumeId: VolumeId;
  readonly chunks: readonly VoxelChunkSeed[];
}

/** A fully validated container read (plan S5.15 load result). */
export interface LoadedVxlProject {
  readonly manifest: VxlManifest;
  readonly document: VoxelDocument;
  readonly volumes: ReadonlyMap<VolumeId, LoadedVxlVolume>;
  /** Raw preview bytes keyed by entry name; never part of semantic identity. */
  readonly previews: ReadonlyMap<string, Uint8Array>;
  /** Re-verified semantic hash; equal to `manifest.semanticHash`. */
  readonly semanticHash: string;
}

/** Overridable limits for one container read; callers may only lower. */
export interface VxlReadOptions {
  readonly documentLimits?: DocumentLimits;
  readonly volumeLimits?: VoxelVolumeLimits;
  readonly containerLimits?: ZipArchiveLimits;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const isUnreserved = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a);

/**
 * Percent-encodes a Volume ID into an entry-name segment: every UTF-8 byte
 * outside `[A-Za-z0-9]` becomes an uppercase `%XX` escape, so arbitrary
 * caller-supplied IDs (including non-ASCII text) can never form path
 * segments.
 */
export function encodeVolumeEntryName(volumeIdText: string): string {
  let out = "";
  for (const byte of encoder.encode(volumeIdText)) {
    out += isUnreserved(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `${VOXELS_PREFIX}${out}${VOXELS_SUFFIX}`;
}

/**
 * Decodes a `voxels/...bin` entry name back to the Volume ID. Strict: every
 * non-unreserved byte must be an uppercase `%XX` escape and the decoded
 * bytes must be valid UTF-8; the manifest cross-checks the decoded ID
 * against `volumeId` afterwards.
 */
export function decodeVolumeEntryName(name: string): string {
  if (!name.startsWith(VOXELS_PREFIX) || !name.endsWith(VOXELS_SUFFIX)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_ENTRY_NAME",
      message: "Voxel entry names must match voxels/<volume-id>.bin",
      context: { name },
    });
  }
  const encoded = name.slice(VOXELS_PREFIX.length, -VOXELS_SUFFIX.length);
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    const char = encoded[i] as string;
    const code = char.charCodeAt(0);
    if (isUnreserved(code)) {
      bytes.push(code);
      continue;
    }
    if (char !== "%") {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_ENTRY_NAME",
        message: "Voxel entry names must percent-encode non-unreserved bytes",
        context: { name },
      });
    }
    const hex = encoded.slice(i + 1, i + 3);
    if (!/^[0-9A-F]{2}$/u.test(hex)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_ENTRY_NAME",
        message: "Voxel entry percent-escapes must be uppercase two-digit hex",
        context: { name },
      });
    }
    bytes.push(Number.parseInt(hex, 16));
    i += 2;
  }
  try {
    return decoder.decode(new Uint8Array(bytes));
  } catch (cause) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_ENTRY_NAME",
      message: "Voxel entry name does not decode to valid UTF-8",
      context: { name },
      cause,
    });
  }
}

const compareCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** Rejects a caller-supplied limit profile that raises a hard default. */
function assertNotAboveDefault<T extends object>(
  provided: T,
  defaults: T,
  name: string,
): T {
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const limit = provided[key];
    const hard = defaults[key];
    if (typeof limit === "number" && typeof hard === "number" && limit > hard) {
      throw new WorkspaceError({
        family: "limit",
        code: "LIMIT_ABOVE_DEFAULT",
        message: `Callers may only lower the ${name} hard limits`,
        context: { limit: String(key), requested: limit, hard },
      });
    }
  }
  return provided;
}

/**
 * Writes a deterministic `.vxl` container. Entry order is fixed:
 * manifest.json, document.json, voxels sorted by Volume ID, previews sorted
 * by name. Byte stability is promised for stable semantic content: the ZIP
 * uses stored entries, a zero DOS timestamp, and no variable metadata.
 */
export function writeVxlProject(input: VxlWriteInput): Uint8Array {
  const document = input.document;
  if (input.volumes !== undefined) {
    for (const volumeIdText of input.volumes.keys()) {
      if (document.volumes[volumeIdText] === undefined) {
        throw new WorkspaceError({
          family: "validation",
          code: "MISSING_VOLUME",
          message: "Written volume is not part of the document",
          context: { volumeId: volumeIdText },
        });
      }
    }
  }
  // The writer must never emit a container its own reader rejects
  // (ADR-0009 hard limits and the v1 ZIP/entry-index bounds).
  const limits = DEFAULT_ZIP_ARCHIVE_LIMITS;
  const previews = [...(input.previews ?? [])].sort((a, b) =>
    compareCodeUnit(a.name, b.name),
  );
  const entryCount = 2 + Object.keys(document.volumes).length + previews.length;
  if (entryCount > limits.maxEntries) {
    throw new WorkspaceError({
      family: "limit",
      code: "ENTRY_LIMIT_EXCEEDED",
      message: "Container exceeds its entry limit",
      context: { requested: entryCount, limit: limits.maxEntries },
    });
  }
  let totalSize = 0;
  for (const preview of previews) {
    if (
      !isValidEntryName(preview.name) ||
      !preview.name.startsWith(PREVIEWS_PREFIX)
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_ENTRY_NAME",
        message: "Preview entry names must be safe paths under previews/",
        context: { name: preview.name },
      });
    }
    if (preview.data.byteLength > limits.maxEntrySize) {
      throw new WorkspaceError({
        family: "limit",
        code: "ENTRY_SIZE_LIMIT_EXCEEDED",
        message: "Preview entry exceeds its size limit",
        context: {
          name: preview.name,
          requested: preview.data.byteLength,
          limit: limits.maxEntrySize,
        },
      });
    }
    totalSize += preview.data.byteLength;
    if (totalSize > limits.maxTotalSize) {
      throw new WorkspaceError({
        family: "limit",
        code: "TOTAL_SIZE_LIMIT_EXCEEDED",
        message: "Container exceeds its total size limit",
        context: { requested: totalSize, limit: limits.maxTotalSize },
      });
    }
  }
  const volumeIds = Object.keys(document.volumes).sort(compareCodeUnit);
  const volumeBinaries = new Map<string, Uint8Array>();
  for (const volumeIdText of volumeIds) {
    const readView = input.volumes?.get(volumeIdText as VolumeId);
    volumeBinaries.set(
      volumeIdText,
      encodeVoxelVolume(
        readView ?? emptyVolumeReadView(volumeIdText as VolumeId),
      ),
    );
  }
  const semanticHash = canonicalAssetSemanticHash(
    document,
    input.volumes ?? new Map(),
  );
  const documentBytes = encoder.encode(canonicalDocumentJson(document));
  const entries: VxlManifestEntry[] = [
    {
      name: DOCUMENT_ENTRY,
      kind: "document",
      size: documentBytes.byteLength,
      crc32: crc32Hex(documentBytes),
    },
    ...volumeIds.map((volumeIdText) => {
      const bytes = volumeBinaries.get(volumeIdText) as Uint8Array;
      return {
        name: encodeVolumeEntryName(volumeIdText),
        kind: "voxels" as const,
        volumeId: volumeIdText as VolumeId,
        size: bytes.byteLength,
        crc32: crc32Hex(bytes),
      };
    }),
    ...previews.map((preview) => ({
      name: preview.name,
      kind: "preview" as const,
      size: preview.data.byteLength,
      crc32: crc32Hex(preview.data),
    })),
  ];
  const manifest: VxlManifest = {
    containerVersion: VXL_CONTAINER_VERSION,
    documentSchemaVersion: VXL_DOCUMENT_VERSION,
    chunkEncodingVersion: VXL_CHUNK_ENCODING_VERSION,
    features: Object.freeze({}),
    semanticHash,
    entries: Object.freeze(entries),
  };
  const manifestBytes = encodeManifest(manifest);
  const zipEntries: ZipEntryInput[] = [
    { name: MANIFEST_ENTRY, data: manifestBytes },
    { name: DOCUMENT_ENTRY, data: documentBytes },
    ...volumeIds.map((volumeIdText) => ({
      name: encodeVolumeEntryName(volumeIdText),
      data: volumeBinaries.get(volumeIdText) as Uint8Array,
    })),
    ...previews.map((preview) => ({
      name: preview.name,
      data: preview.data,
    })),
  ];
  return writeZipArchive(zipEntries);
}

/**
 * Reads and validates a `.vxl` container (plan S5.4/S5.15). Every check —
 * ZIP structure, path safety, manifest index consistency, version fields,
 * per-entry checksums, volume chunk tables, and the semantic hash — runs
 * before any data is handed back, so a corrupt or hostile file can never
 * yield a partial asset.
 */
export function readVxlProject(
  bytes: Uint8Array,
  options: VxlReadOptions = {},
): LoadedVxlProject {
  // ADR-0009: hard defaults may only be lowered, never raised, by callers.
  const documentLimits = assertNotAboveDefault(
    options.documentLimits ?? DEFAULT_DOCUMENT_LIMITS,
    DEFAULT_DOCUMENT_LIMITS,
    "document",
  );
  const volumeLimits = assertNotAboveDefault(
    options.volumeLimits ?? DEFAULT_VOXEL_VOLUME_LIMITS,
    DEFAULT_VOXEL_VOLUME_LIMITS,
    "volume",
  );
  const containerLimits = assertNotAboveDefault(
    options.containerLimits ?? DEFAULT_ZIP_ARCHIVE_LIMITS,
    DEFAULT_ZIP_ARCHIVE_LIMITS,
    "container",
  );
  const entries = readZipArchive(bytes, containerLimits);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const manifestEntry = byName.get(MANIFEST_ENTRY);
  if (manifestEntry === undefined) {
    throw new WorkspaceError({
      family: "io",
      code: "MISSING_MANIFEST",
      message: "Container has no manifest.json entry",
    });
  }
  const manifest = decodeManifest(manifestEntry.data);

  // The manifest is the entry index: names, sizes, and checksums must match
  // the ZIP exactly (manifest.json itself is not indexed).
  const manifestNames = new Set(manifest.entries.map((entry) => entry.name));
  for (const entry of entries) {
    if (entry.name !== MANIFEST_ENTRY && !manifestNames.has(entry.name)) {
      throw new WorkspaceError({
        family: "io",
        code: "UNINDEXED_ENTRY",
        message: "Container entry is missing from the manifest index",
        context: { name: entry.name },
      });
    }
  }
  for (const indexed of manifest.entries) {
    const entry = byName.get(indexed.name);
    if (entry === undefined) {
      throw new WorkspaceError({
        family: "io",
        code: "MISSING_ENTRY",
        message: "Manifest index references a missing container entry",
        context: { name: indexed.name },
      });
    }
    if (
      entry.data.byteLength !== indexed.size ||
      crc32Hex(entry.data) !== indexed.crc32
    ) {
      throw new WorkspaceError({
        family: "io",
        code: "ENTRY_CHECKSUM_MISMATCH",
        message: "Container entry does not match its manifest index",
        context: { name: indexed.name },
      });
    }
  }

  const documentEntry = manifest.entries.find(
    (entry) => entry.kind === "document",
  );
  if (documentEntry === undefined || documentEntry.name !== DOCUMENT_ENTRY) {
    throw new WorkspaceError({
      family: "io",
      code: "MISSING_DOCUMENT",
      message: "Manifest must index exactly one document.json entry",
    });
  }
  const documentBytes = (byName.get(DOCUMENT_ENTRY) as ZipEntry).data;
  let documentJson: string;
  try {
    documentJson = decoder.decode(documentBytes);
  } catch (cause) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_JSON",
      message: "document.json is not valid UTF-8",
      cause,
    });
  }
  const document = parseDocument(documentJson, documentLimits);

  const volumes = new Map<VolumeId, LoadedVxlVolume>();
  for (const indexed of manifest.entries) {
    if (indexed.kind !== "voxels") continue;
    const entryVolumeId = indexed.volumeId;
    if (entryVolumeId === undefined) {
      throw new WorkspaceError({
        family: "io",
        code: "INVALID_ENTRY_NAME",
        message: "Voxel entry is missing its indexed volume ID",
        context: { name: indexed.name },
      });
    }
    if (indexed.name !== encodeVolumeEntryName(entryVolumeId)) {
      throw new WorkspaceError({
        family: "io",
        code: "INVALID_ENTRY_NAME",
        message: "Voxel entry name does not match its indexed volume ID",
        context: { name: indexed.name, volumeId: entryVolumeId },
      });
    }
    if (document.volumes[entryVolumeId] === undefined) {
      throw new WorkspaceError({
        family: "io",
        code: "VOLUME_NOT_IN_DOCUMENT",
        message: "Container volume is not part of the document",
        context: { volumeId: entryVolumeId },
      });
    }
    const binary = (byName.get(indexed.name) as ZipEntry).data;
    volumes.set(entryVolumeId, {
      volumeId: entryVolumeId,
      chunks: Object.freeze(
        decodeVoxelVolume(binary, entryVolumeId, volumeLimits),
      ),
    });
  }
  for (const volumeIdText of Object.keys(document.volumes)) {
    if (!volumes.has(volumeIdText as VolumeId)) {
      throw new WorkspaceError({
        family: "io",
        code: "MISSING_VOLUME_ENTRY",
        message: "Document volume has no container entry",
        context: { volumeId: volumeIdText },
      });
    }
  }

  const previews = new Map<string, Uint8Array>();
  for (const indexed of manifest.entries) {
    if (indexed.kind !== "preview") continue;
    if (!indexed.name.startsWith(PREVIEWS_PREFIX)) {
      throw new WorkspaceError({
        family: "io",
        code: "INVALID_ENTRY_NAME",
        message: "Preview entries must live under previews/",
        context: { name: indexed.name },
      });
    }
    previews.set(indexed.name, (byName.get(indexed.name) as ZipEntry).data);
  }

  const semanticHash = canonicalAssetSemanticHash(
    document,
    new Map(
      [...volumes.entries()].map(([id, loaded]) => [
        id,
        seedReadView(id, loaded.chunks),
      ]),
    ),
  );
  if (semanticHash !== manifest.semanticHash) {
    throw new WorkspaceError({
      family: "io",
      code: "SEMANTIC_HASH_MISMATCH",
      message:
        "Container semantic hash does not match its document and voxel content",
    });
  }
  return {
    manifest,
    document,
    volumes: Object.freeze(volumes),
    previews: Object.freeze(previews),
    semanticHash,
  };
}

/** Read view over decoded chunk seeds (hash verification and inspection). */
export function seedReadView(
  volumeId: VolumeId,
  chunks: readonly VoxelChunkSeed[],
): VoxelVolumeReadView {
  const byKey = new Map(
    chunks.map((chunk) => [chunkKey(chunk.coordinate), chunk]),
  );
  let occupied = 0;
  let bounds: IntAabb | undefined;
  for (const chunk of chunks) {
    for (let index = 0; index < CHUNK_VOXEL_COUNT; index += 1) {
      const value = chunk.values[index] as number;
      if (value === 0) continue;
      occupied += 1;
      const x = chunk.coordinate[0] * CHUNK_EDGE + (index % CHUNK_EDGE);
      const y =
        chunk.coordinate[1] * CHUNK_EDGE +
        (Math.floor(index / CHUNK_EDGE) % CHUNK_EDGE);
      const z =
        chunk.coordinate[2] * CHUNK_EDGE +
        Math.floor(index / (CHUNK_EDGE * CHUNK_EDGE));
      const point: Vec3i = [x, y, z];
      bounds =
        bounds === undefined
          ? { min: point, max: addOne(point) }
          : unionBounds(bounds, point);
    }
  }
  return {
    volumeId,
    getVoxel(coordinate: Vec3i): MaterialId {
      const chunkCoordinate: Vec3i = [
        Math.floor(coordinate[0] / CHUNK_EDGE),
        Math.floor(coordinate[1] / CHUNK_EDGE),
        Math.floor(coordinate[2] / CHUNK_EDGE),
      ];
      const chunk = byKey.get(chunkKey(chunkCoordinate));
      if (chunk === undefined) return 0 as MaterialId;
      const localX = ((coordinate[0] % CHUNK_EDGE) + CHUNK_EDGE) % CHUNK_EDGE;
      const localY = ((coordinate[1] % CHUNK_EDGE) + CHUNK_EDGE) % CHUNK_EDGE;
      const localZ = ((coordinate[2] % CHUNK_EDGE) + CHUNK_EDGE) % CHUNK_EDGE;
      const index = localX + CHUNK_EDGE * (localY + CHUNK_EDGE * localZ);
      return chunk.values[index] as MaterialId;
    },
    getChunk(coordinate: Vec3i): Uint16Array | undefined {
      const chunk = byKey.get(chunkKey(coordinate));
      return chunk === undefined ? undefined : chunk.values.slice();
    },
    chunkCount(): number {
      return chunks.length;
    },
    chunkCoordinates(): readonly Vec3i[] {
      return chunks.map((chunk) => chunk.coordinate);
    },
    occupiedCount(): number {
      return occupied;
    },
    occupiedBounds(): IntAabb | undefined {
      return bounds;
    },
  };
}

const addOne = (point: Vec3i): Vec3i => [
  point[0] + 1,
  point[1] + 1,
  point[2] + 1,
];

const unionBounds = (bounds: IntAabb, point: Vec3i): IntAabb => ({
  min: [
    Math.min(bounds.min[0], point[0]),
    Math.min(bounds.min[1], point[1]),
    Math.min(bounds.min[2], point[2]),
  ],
  max: [
    Math.max(bounds.max[0], point[0] + 1),
    Math.max(bounds.max[1], point[1] + 1),
    Math.max(bounds.max[2], point[2] + 1),
  ],
});

/** Empty volume read view used when a document volume has no backing data. */
function emptyVolumeReadView(volumeId: VolumeId): VoxelVolumeReadView {
  return {
    volumeId,
    getVoxel(): MaterialId {
      return 0 as MaterialId;
    },
    getChunk(): Uint16Array | undefined {
      return undefined;
    },
    chunkCount(): number {
      return 0;
    },
    chunkCoordinates(): readonly Vec3i[] {
      return [];
    },
    occupiedCount(): number {
      return 0;
    },
    occupiedBounds(): IntAabb | undefined {
      return undefined;
    },
  };
}
