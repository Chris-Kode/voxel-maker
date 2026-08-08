import {
  WorkspaceError,
  canonicalJson,
  volumeId,
  type JsonValue,
  type VolumeId,
} from "@voxel-maker/shared";
import { isValidEntryName } from "./zip.js";

/**
 * Version 1 native container manifest (plan S5.1/S5.2, ADR-0004): an
 * indexed canonical document plus entry index, independent version fields,
 * and checksums. Serialized as RFC 8785 canonical JSON so the manifest bytes
 * are stable for stable content. The manifest is container metadata — it is
 * never part of the semantic identity hash, but its `semanticHash` lets the
 * reader verify the reconstructed asset before install.
 */

/** Frozen v1 independent version fields (ADR-0004). */
export const VXL_CONTAINER_VERSION = 1;
export const VXL_DOCUMENT_VERSION = 1;
export const VXL_CHUNK_ENCODING_VERSION = 1;

export type VxlEntryKind = "document" | "voxels" | "preview";

/** One indexed container entry (plan 5.6). */
export interface VxlManifestEntry {
  readonly name: string;
  readonly kind: VxlEntryKind;
  /** Present exactly when `kind` is `voxels`; must equal the decoded name. */
  readonly volumeId?: VolumeId;
  readonly size: number;
  /** 8 lowercase hex digits; CRC-32 of the entry bytes. */
  readonly crc32: string;
}

/** Parsed and validated v1 manifest. */
export interface VxlManifest {
  readonly containerVersion: 1;
  readonly documentSchemaVersion: 1;
  readonly chunkEncodingVersion: 1;
  /** Reserved feature flags; empty in v1 and ignored by readers. */
  readonly features: Readonly<Record<string, JsonValue>>;
  /** SHA-256 over the canonical semantic bytes (document + chunk streams). */
  readonly semanticHash: string;
  readonly entries: readonly VxlManifestEntry[];
}

const SEMANTIC_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const CRC32_PATTERN = /^[0-9a-f]{8}$/u;
const KNOWN_KINDS: readonly VxlEntryKind[] = ["document", "voxels", "preview"];

/**
 * Encodes a manifest as canonical JSON. Entry order is the given order,
 * which is the container entry order (the index is semantic).
 */
export function encodeManifest(manifest: VxlManifest): Uint8Array {
  const value = {
    containerVersion: manifest.containerVersion,
    documentSchemaVersion: manifest.documentSchemaVersion,
    chunkEncodingVersion: manifest.chunkEncodingVersion,
    features: manifest.features,
    semanticHash: manifest.semanticHash,
    entries: manifest.entries.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      ...(entry.volumeId === undefined ? {} : { volumeId: entry.volumeId }),
      size: entry.size,
      crc32: entry.crc32,
    })),
  };
  return new TextEncoder().encode(canonicalJson(value as JsonValue));
}

/** Parses and validates a v1 manifest; throws structured errors. */
export function decodeManifest(bytes: Uint8Array): VxlManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_MANIFEST",
      message: "Container manifest is not valid UTF-8 JSON",
      cause,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw manifestError(
      "INVALID_MANIFEST",
      "Container manifest must be a JSON object",
    );
  }
  const record = value as Record<string, unknown>;
  const KNOWN_MANIFEST_FIELDS = new Set([
    "containerVersion",
    "documentSchemaVersion",
    "chunkEncodingVersion",
    "features",
    "semanticHash",
    "entries",
  ]);
  for (const field of Object.keys(record)) {
    if (!KNOWN_MANIFEST_FIELDS.has(field)) {
      throw new WorkspaceError({
        family: "compatibility",
        code: "UNKNOWN_MANIFEST_FIELD",
        message:
          "Manifest contains a field this version does not support; refusing to guess at unknown data",
        context: { field },
      });
    }
  }
  const containerVersion = record.containerVersion;
  if (
    typeof containerVersion !== "number" ||
    !Number.isInteger(containerVersion)
  ) {
    throw manifestError(
      "INVALID_MANIFEST",
      "Container manifest is missing its container version",
    );
  }
  if (containerVersion !== VXL_CONTAINER_VERSION) {
    throw new WorkspaceError({
      family: "compatibility",
      code: "UNSUPPORTED_CONTAINER_VERSION",
      message:
        "Container version is not the supported version 1; refusing to guess at unknown data",
      context: { version: containerVersion },
    });
  }
  const documentSchemaVersion = record.documentSchemaVersion;
  if (documentSchemaVersion !== VXL_DOCUMENT_VERSION) {
    throw new WorkspaceError({
      family: "compatibility",
      code: "UNSUPPORTED_DOCUMENT_VERSION",
      message:
        "Manifest document version is not the supported version 1; refusing to guess at unknown data",
      context: { version: documentSchemaVersion as number },
    });
  }
  const chunkEncodingVersion = record.chunkEncodingVersion;
  if (chunkEncodingVersion !== VXL_CHUNK_ENCODING_VERSION) {
    throw new WorkspaceError({
      family: "compatibility",
      code: "UNSUPPORTED_CHUNK_ENCODING_VERSION",
      message:
        "Chunk encoding version is not the supported version 1; refusing to guess at unknown data",
      context: { version: chunkEncodingVersion as number },
    });
  }
  const features = record.features;
  if (
    typeof features !== "object" ||
    features === null ||
    Array.isArray(features)
  ) {
    throw manifestError(
      "INVALID_MANIFEST",
      "Manifest features must be an object",
    );
  }
  const semanticHash = record.semanticHash;
  if (
    typeof semanticHash !== "string" ||
    !SEMANTIC_HASH_PATTERN.test(semanticHash)
  ) {
    throw manifestError(
      "INVALID_MANIFEST",
      "Manifest semantic hash must be 64 lowercase hex digits",
    );
  }
  const rawEntries = record.entries;
  if (!Array.isArray(rawEntries)) {
    throw manifestError(
      "INVALID_MANIFEST",
      "Manifest entries must be an array",
    );
  }
  if (rawEntries.length > 4_095) {
    throw new WorkspaceError({
      family: "limit",
      code: "ENTRY_LIMIT_EXCEEDED",
      message: "Manifest entry index exceeds its limit",
      context: { requested: rawEntries.length, limit: 4_095 },
    });
  }
  const entries: VxlManifestEntry[] = [];
  const names = new Set<string>();
  let documentEntries = 0;
  for (const raw of rawEntries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw manifestError(
        "INVALID_MANIFEST",
        "Manifest entry must be an object",
      );
    }
    const entry = raw as Record<string, unknown>;
    const KNOWN_ENTRY_FIELDS = new Set([
      "name",
      "kind",
      "volumeId",
      "size",
      "crc32",
    ]);
    for (const field of Object.keys(entry)) {
      if (!KNOWN_ENTRY_FIELDS.has(field)) {
        throw new WorkspaceError({
          family: "compatibility",
          code: "UNKNOWN_MANIFEST_FIELD",
          message:
            "Manifest entry contains a field this version does not support; refusing to guess at unknown data",
          context: { field, name: String(entry.name) },
        });
      }
    }
    const name = entry.name;
    const kind = entry.kind;
    const size = entry.size;
    const crc = entry.crc32;
    if (typeof name !== "string" || !isValidEntryName(name)) {
      throw manifestError(
        "INVALID_ENTRY_NAME",
        "Manifest entry name violates container path rules",
        { name: String(name) },
      );
    }
    if (names.has(name)) {
      throw manifestError(
        "DUPLICATE_ENTRY",
        "Manifest indexes a duplicate entry name",
        { name },
      );
    }
    names.add(name);
    if (
      typeof kind !== "string" ||
      !KNOWN_KINDS.includes(kind as VxlEntryKind)
    ) {
      throw manifestError(
        "INVALID_MANIFEST",
        "Manifest entry has an unknown kind",
        { name, kind: String(kind) },
      );
    }
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw manifestError(
        "INVALID_MANIFEST",
        "Manifest entry size must be a non-negative integer",
        { name },
      );
    }
    if (typeof crc !== "string" || !CRC32_PATTERN.test(crc)) {
      throw manifestError(
        "INVALID_MANIFEST",
        "Manifest entry checksum must be 8 lowercase hex digits",
        { name },
      );
    }
    let entryVolumeId: VolumeId | undefined;
    if (kind === "voxels") {
      if (typeof entry.volumeId !== "string") {
        throw manifestError(
          "INVALID_MANIFEST",
          "Voxel entries must carry a volumeId",
          { name },
        );
      }
      entryVolumeId = volumeId(entry.volumeId);
    } else if (entry.volumeId !== undefined) {
      throw manifestError(
        "INVALID_MANIFEST",
        "Only voxel entries carry a volumeId",
        { name },
      );
    }
    if (kind === "document") documentEntries += 1;
    entries.push({
      name,
      kind: kind as VxlEntryKind,
      ...(entryVolumeId === undefined ? {} : { volumeId: entryVolumeId }),
      size,
      crc32: crc,
    });
  }
  if (documentEntries !== 1) {
    throw manifestError(
      "INVALID_MANIFEST",
      "Manifest must index exactly one document entry",
      { requested: documentEntries },
    );
  }
  return {
    containerVersion: VXL_CONTAINER_VERSION,
    documentSchemaVersion: VXL_DOCUMENT_VERSION,
    chunkEncodingVersion: VXL_CHUNK_ENCODING_VERSION,
    features: Object.freeze({ ...(features as Record<string, JsonValue>) }),
    semanticHash,
    entries: Object.freeze(entries),
  };
}

const manifestError = (
  code: string,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): WorkspaceError =>
  new WorkspaceError({
    family: "validation",
    code,
    message,
    ...(context === undefined ? {} : { context: context as never }),
  });
