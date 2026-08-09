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

export {
  DEFAULT_GLTF_EXPORT_LIMITS,
  GLTF_COMPONENT_FLOAT,
  GLTF_COMPONENT_UNSIGNED_INT,
  GLTF_ERROR_CODES,
  GLTF_EXPORT_LOSSES,
  GLTF_GENERATOR,
  GLTF_JSON_VERSION,
  GLTF_METERS_PER_VOXEL,
  GLTF_MODE_TRIANGLES,
  GLTF_TARGET_ARRAY_BUFFER,
  GLTF_TARGET_ELEMENT_ARRAY_BUFFER,
  type GltfExportLimits,
  type GltfExportLoss,
  type GltfExportMetadata,
  type GltfExportPreflight,
  type GltfMaterialExport,
  type GltfMeshData,
  type GltfMeshExport,
  type GltfMeshMaterialGroup,
  type GltfNodeExport,
  type GltfPivotHelperReport,
  type GltfPrimitiveExport,
  type GltfSceneGraph,
  type GltfVolumeAccess,
} from "./gltf-types.js";
export { buildVolumeMesh } from "./gltf-mesh.js";
export {
  planGltfExport,
  preflightGltfExport,
  sanitizeGltfName,
} from "./gltf-mapping.js";
export { encodeGlb, encodeGltfJson, type GltfJsonEncoded } from "./gltf.js";
