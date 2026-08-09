import type { MaterialId } from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";

/**
 * Shared types for the MagicaVoxel VOX version-150 interchange codec
 * (ADR-0011, plan S8.1-S8.4, ticket #24). The codec works in VOX file
 * space: `x`/`y`/`z` are the unsigned file coordinates and `colorIndex` is
 * the 1-based palette index; the document mapping layer converts axes and
 * materials (see `vox-mapping.ts`).
 */

/** One RGBA palette entry in file byte order. */
export interface VoxColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** One voxel in VOX file space; `colorIndex` 1..255 (0 is empty). */
export interface VoxVoxel {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly colorIndex: number;
}

/** One SIZE/XYZI model pair in VOX file space. */
export interface VoxModel {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly voxels: readonly VoxVoxel[];
}

/** Bounds enforced by one `parseVox` call; callers may only lower. */
export interface VoxParseLimits {
  /** Maximum input file bytes (plan: input file 512 MiB). */
  readonly maxFileBytes: number;
  /** Maximum SIZE/XYZI models. */
  readonly maxModels: number;
  /** Maximum voxels of one model (ADR-0009 volume occupancy). */
  readonly maxVoxelsPerModel: number;
  /** Maximum voxels across all models of one file. */
  readonly maxTotalVoxels: number;
  /** Maximum chunk records (including unknown and nested chunks). */
  readonly maxChunks: number;
  /** Maximum total bytes of unknown chunk content+children that are skipped. */
  readonly maxUnknownChunkBytes: number;
}

/** ADR-0009-style hard defaults for one VOX read. */
export const DEFAULT_VOX_PARSE_LIMITS: VoxParseLimits = Object.freeze({
  maxFileBytes: 512 * 1024 * 1024,
  maxModels: 1_024,
  maxVoxelsPerModel: 1_000_000,
  maxTotalVoxels: 1_000_000,
  maxChunks: 100_000,
  maxUnknownChunkBytes: 64 * 1024 * 1024,
});

/** A structural warning that did not prevent the import (plan S8.2). */
export interface VoxWarning {
  readonly code: string;
  readonly message: string;
  readonly context?: Readonly<Record<string, number | string | boolean>>;
}

/** One unknown chunk id skipped because its declared lengths were valid. */
export interface VoxUnknownChunk {
  readonly id: string;
  readonly count: number;
  /** Total skipped bytes (content + children). */
  readonly totalBytes: number;
}

/** Successful parse of a VOX version-150 file. */
export interface VoxParseResult {
  readonly version: 150;
  readonly models: readonly VoxModel[];
  /** 256 palette entries; index 0 is the empty color. */
  readonly palette: readonly VoxColor[];
  /** True when an explicit RGBA chunk was present. */
  readonly paletteExplicit: boolean;
  readonly warnings: readonly VoxWarning[];
  /** Unknown chunk ids in first-seen order. */
  readonly unknownChunks: readonly VoxUnknownChunk[];
  /** Voxels dropped because they referenced palette index 0 (empty). */
  readonly skippedEmptyIndexVoxels: number;
}

/** One material record produced by the import mapping. */
export interface VoxImportMaterial {
  readonly materialId: MaterialId;
  readonly name: string;
  readonly color: string;
  readonly opacity: number;
}

/** One volume produced by the import mapping, already in editor space. */
export interface VoxImportVolume {
  readonly volumeId: import("@voxel-maker/shared").VolumeId;
  readonly name: string;
  /** Half-open occupied bounds in editor space. */
  readonly bounds: { readonly min: Vec3i; readonly max: Vec3i };
  /** Editor-space voxel entries (material ids are palette-derived). */
  readonly entries: readonly {
    readonly coordinate: Vec3i;
    readonly material: MaterialId;
  }[];
}

/** One node produced by the import mapping (root-level child). */
export interface VoxImportNode {
  readonly nodeId: import("@voxel-maker/shared").NodeId;
  readonly name: string;
  readonly volumeId: import("@voxel-maker/shared").VolumeId;
}

/** The complete import intent: materials, volumes, and root-level nodes. */
export interface VoxImportPlan {
  readonly materials: readonly VoxImportMaterial[];
  readonly volumes: readonly VoxImportVolume[];
  readonly nodes: readonly VoxImportNode[];
  readonly warnings: readonly VoxWarning[];
}

/** Stable import warning codes. */
export const VOX_IMPORT_WARNINGS = {
  sceneGraph: "VOX_SCENE_GRAPH_NOT_INTERPRETED",
  unknownChunks: "VOX_UNKNOWN_CHUNKS_SKIPPED",
  defaultPalette: "VOX_DEFAULT_PALETTE_USED",
  emptyIndexVoxels: "VOX_EMPTY_INDEX_VOXELS_SKIPPED",
  modelName: "VOX_MODEL_NAMES_UNAVAILABLE",
} as const;

/** Stable export loss codes (ADR-0011 loss report). */
export const VOX_EXPORT_LOSSES = {
  hierarchy: "VOX_LOSS_HIERARCHY",
  transform: "VOX_LOSS_TRANSFORM",
  origin: "VOX_LOSS_ORIGIN",
  dimensions: "VOX_LOSS_DIMENSIONS",
  colorLimit: "VOX_LOSS_COLOR_LIMIT",
  materialSemantics: "VOX_LOSS_MATERIAL_SEMANTICS",
  materialDistinction: "VOX_LOSS_MATERIAL_DISTINCTION",
  metadata: "VOX_LOSS_METADATA",
  emptyModel: "VOX_LOSS_EMPTY_MODEL",
} as const;

/** One reported export loss; `blocked` losses abort the export. */
export interface VoxExportLoss {
  readonly code: string;
  readonly message: string;
  /** "bake" losses are applied by an explicit choice; "block" losses abort. */
  readonly severity: "bake" | "block";
  readonly context?: Readonly<Record<string, number | string | boolean>>;
}

/** Result of the export preflight: either a loss report or a block. */
export type VoxExportPreflight =
  | { readonly ok: true; readonly losses: readonly VoxExportLoss[] }
  | { readonly ok: false; readonly blocked: readonly VoxExportLoss[] };

/** Explicit bake/loss choices for one export (ADR-0011). */
export interface VoxExportChoices {
  /**
   * Rebase every volume's occupied bounds to the local unsigned cube origin
   * (`min` maps to (0, 0, 0)); reports the origin loss. Absent when bounds
   * are already non-negative or a supported transform bake exists.
   */
  readonly rebaseOrigins?: boolean;
  /**
   * Export every voxel-component volume as a separate model regardless of
   * hierarchy depth; reports the hierarchy loss. Absent when every voxel
   * volume is a direct child of the document root.
   */
  readonly flattenHierarchy?: boolean;
}

/** One model prepared for `encodeVox` after export mapping. */
export interface VoxExportModel {
  readonly name: string;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  /** VOX-space voxels; colorIndex 1..255. */
  readonly voxels: readonly VoxVoxel[];
  /** Palette index assigned to each material id (1..255). */
  readonly materialToIndex: ReadonlyMap<MaterialId, number>;
}

/** The complete export preparation: palette + models + loss report. */
export interface VoxExportPlan {
  readonly palette: readonly VoxColor[];
  readonly models: readonly VoxExportModel[];
  readonly losses: readonly VoxExportLoss[];
}

/** One model supplied to the deterministic encoder. */
export interface VoxEncodeInput {
  readonly models: readonly VoxModel[];
  /** Palette to write; absent writes the version-150 default palette. */
  readonly palette?: readonly VoxColor[];
}
