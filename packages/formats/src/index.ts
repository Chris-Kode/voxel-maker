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
export { VOX_DEFAULT_PALETTE } from "./vox-palette.js";
export {
  VOX_MAGIC,
  VOX_MAX_AXIS_SIZE,
  VOX_MAX_COLOR_INDEX,
  VOX_PALETTE_ENTRIES,
  VOX_RGBA_CHUNK_BYTES,
  VOX_VERSION,
  encodeVox,
  parseVox,
} from "./vox.js";
export {
  hexColor,
  mapVoxImport,
  planVoxExport,
  preflightVoxExport,
  type VoxImportIdFactory,
  type VoxVolumeAccess,
} from "./vox-mapping.js";
export {
  DEFAULT_VOX_PARSE_LIMITS,
  VOX_EXPORT_LOSSES,
  VOX_IMPORT_WARNINGS,
  type VoxColor,
  type VoxEncodeInput,
  type VoxExportChoices,
  type VoxExportLoss,
  type VoxExportModel,
  type VoxExportPlan,
  type VoxExportPreflight,
  type VoxImportMaterial,
  type VoxImportNode,
  type VoxImportPlan,
  type VoxImportVolume,
  type VoxModel,
  type VoxParseLimits,
  type VoxParseResult,
  type VoxUnknownChunk,
  type VoxVoxel,
  type VoxWarning,
} from "./vox-types.js";
