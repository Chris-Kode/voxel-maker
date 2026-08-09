/**
 * Public entry point for the formats package: native `.vxl` container
 * codecs (plan S5.1-S5.5, ADR-0004) and, in later tickets, external
 * interchange formats. Platform file I/O never lives here; storage adapters
 * inject bytes.
 */
export { crc32, crc32Hex } from "./crc32.js";
export {
  encodePng,
  PNG_MAX_DIMENSION,
  PNG_MAX_PIXELS,
  validatePngInput,
} from "./png.js";
export {
  DEFAULT_ZIP_ARCHIVE_LIMITS,
  isValidEntryName,
  readZipArchive,
  writeZipArchive,
  type ZipArchiveLimits,
  type ZipEntry,
  type ZipEntryInput,
} from "./zip.js";
export {
  decodeManifest,
  encodeManifest,
  VXL_CHUNK_ENCODING_VERSION,
  VXL_CONTAINER_VERSION,
  VXL_DOCUMENT_VERSION,
  type VxlEntryKind,
  type VxlManifest,
  type VxlManifestEntry,
} from "./manifest.js";
export {
  decodeVoxelVolume,
  encodeVoxelVolume,
  VXL_VOLUME_CHUNK_PAYLOAD_BYTES,
  VXL_VOLUME_CHUNK_RECORD_BYTES,
  VXL_VOLUME_HEADER_BYTES,
  VXL_VOLUME_MAGIC,
} from "./volume-binary.js";
export {
  DOCUMENT_ENTRY,
  decodeVolumeEntryName,
  encodeVolumeEntryName,
  MANIFEST_ENTRY,
  PREVIEWS_PREFIX,
  readVxlProject,
  seedReadView,
  VOXELS_PREFIX,
  writeVxlProject,
  type LoadedVxlProject,
  type LoadedVxlVolume,
  type VxlPreviewInput,
  type VxlReadOptions,
  type VxlWriteInput,
} from "./container.js";
