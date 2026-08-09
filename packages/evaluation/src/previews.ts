import type { DocumentStoreRead } from "@voxel-maker/document";
import {
  renderStandardPreview,
  STANDARD_PREVIEW_VIEWS,
  type PreviewRenderResult,
  type PreviewViewId,
} from "@voxel-maker/renderer";
import { sha256Hex } from "@voxel-maker/model";

/**
 * Rendered preview evidence (plan S12.2/S15.2, ticket #35): the suite
 * renders the starting and resulting documents through the deterministic
 * software preview renderer (the SAME face-culled chunk meshes the
 * viewport shows, through the fixed standard-view cameras), so preview
 * scoring never depends on GPU, timing, or a live model. All four
 * standard views are recorded at a fixed evaluation size; signals are
 * computed over the opaque RGBA buffers.
 */

/** Fixed evaluation render size (128x128: fast, deterministic). */
export const EVAL_PREVIEW_SIZE = 128;

/** One rendered standard view of a document. */
export interface RenderedPreviewEvidence {
  readonly view: PreviewViewId;
  readonly width: number;
  readonly height: number;
  /** Straight-alpha RGBA pixels (background opaque). */
  readonly rgba: Uint8Array;
  readonly semanticHash: string;
  readonly opaqueTriangles: number;
  readonly transparentTriangles: number;
  /** SHA-256 of the raw RGBA bytes (stable preview artifact id). */
  readonly pixelHash: string;
}

/** All four standard views of one document state. */
export interface PreviewEvidenceSet {
  readonly views: Readonly<Record<PreviewViewId, RenderedPreviewEvidence>>;
  /** Every view rendered to completion (never cancelled, never threw). */
  readonly completed: boolean;
  /** Total non-background pixel count across the views. */
  readonly silhouettePixels: number;
}

/** Background of the standard preview protocol (#14161a). */
const BACKGROUND = [20, 22, 26] as const;

function isBackground(r: number, g: number, b: number): boolean {
  return r === BACKGROUND[0] && g === BACKGROUND[1] && b === BACKGROUND[2];
}

/** Renders all four standard views of one store at the evaluation size. */
export function renderPreviewEvidence(
  store: DocumentStoreRead,
): PreviewEvidenceSet {
  const views = {} as Record<PreviewViewId, RenderedPreviewEvidence>;
  const completed = true;
  let silhouettePixels = 0;
  for (const view of STANDARD_PREVIEW_VIEWS) {
    const rendered: PreviewRenderResult = renderStandardPreview({
      store,
      spec: { view, width: EVAL_PREVIEW_SIZE, height: EVAL_PREVIEW_SIZE },
    });
    views[view] = {
      view,
      width: rendered.width,
      height: rendered.height,
      rgba: rendered.rgba,
      semanticHash: rendered.semanticHash,
      opaqueTriangles: rendered.opaqueTriangles,
      transparentTriangles: rendered.transparentTriangles,
      pixelHash: sha256Hex(rendered.rgba),
    };
    silhouettePixels += silhouetteCount(rendered.rgba);
  }
  return { views, completed, silhouettePixels };
}

/** Number of non-background pixels of one RGBA buffer. */
export function silhouetteCount(rgba: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (!isBackground(rgba[i] as number, rgba[i + 1] as number, rgba[i + 2] as number)) {
      count += 1;
    }
  }
  return count;
}

/** Fraction of pixels whose value differs between two equal-size buffers. */
export function changedPixelRatio(
  before: Uint8Array,
  after: Uint8Array,
): number {
  if (before.length !== after.length || before.length === 0) return 0;
  let changed = 0;
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== after[i]) changed += 1;
  }
  return changed / before.length;
}

/** Jaccard overlap of the silhouettes: intersection / union of nonzero pixels. */
export function silhouetteOverlap(
  before: Uint8Array,
  after: Uint8Array,
): number {
  if (before.length !== after.length || before.length === 0) return 0;
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < before.length; i += 4) {
    const b = !isBackground(before[i] as number, before[i + 1] as number, before[i + 2] as number);
    const a = !isBackground(after[i] as number, after[i + 1] as number, after[i + 2] as number);
    if (b || a) {
      union += 1;
      if (b && a) intersection += 1;
    }
  }
  return union === 0 ? 1 : intersection / union;
}

/**
 * Framing-robust silhouette similarity: both masks are downsampled to a
 * fixed grid by occupancy fraction, and the score is 1 - mean absolute
 * difference. The standard views reframe automatically to each state's
 * content bounds, so raw pixel overlap is meaningless for shape-changing
 * edits (a shortened chair rescales the whole image); the normalized
 * signature compares shape instead of absolute pixel positions.
 */
export function silhouetteSimilarity(
  before: Uint8Array,
  after: Uint8Array,
  grid = 32,
): number {
  if (before.length !== after.length || before.length === 0) return 0;
  const cells = grid * grid;
  const bCount = new Float64Array(cells);
  const aCount = new Float64Array(cells);
  const bTotal = new Float64Array(cells);
  const aTotal = new Float64Array(cells);
  const width = Math.round(Math.sqrt(before.length / 4));
  const height = before.length / 4 / width;
  const cellWidth = width / grid;
  const cellHeight = height / grid;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const bOccupied = !isBackground(
        before[offset] ?? 0,
        before[offset + 1] ?? 0,
        before[offset + 2] ?? 0,
      );
      const aOccupied = !isBackground(
        after[offset] ?? 0,
        after[offset + 1] ?? 0,
        after[offset + 2] ?? 0,
      );
      const cellY = Math.min(grid - 1, Math.floor(y / cellHeight));
      const cellX = Math.min(grid - 1, Math.floor(x / cellWidth));
      const cell = cellY * grid + cellX;
      if (bOccupied) {
        bCount[cell] = (bCount[cell] ?? 0) + 1;
        bTotal[cell] = (bTotal[cell] ?? 0) + 1;
      } else {
        bTotal[cell] = (bTotal[cell] ?? 0) + 1;
      }
      if (aOccupied) {
        aCount[cell] = (aCount[cell] ?? 0) + 1;
        aTotal[cell] = (aTotal[cell] ?? 0) + 1;
      } else {
        aTotal[cell] = (aTotal[cell] ?? 0) + 1;
      }
    }
  }
  let difference = 0;
  for (let cell = 0; cell < cells; cell += 1) {
    const bCellTotal = bTotal[cell];
    const bCellCount = bCount[cell] ?? 0;
    const aCellTotal = aTotal[cell];
    const aCellCount = aCount[cell] ?? 0;
    const bFraction = bCellTotal === undefined || bCellTotal === 0 ? 0 : bCellCount / bCellTotal;
    const aFraction = aCellTotal === undefined || aCellTotal === 0 ? 0 : aCellCount / aCellTotal;
    difference += Math.abs(bFraction - aFraction);
  }
  return 1 - difference / cells;
}

/** Fraction of pixels that are predominantly red (requested-color check). */
export function redPixelRatio(rgba: Uint8Array): number {
  let red = 0;
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] as number;
    const g = rgba[i + 1] as number;
    const b = rgba[i + 2] as number;
    if (r > 200 && g < 80 && b < 80) red += 1;
    total += 1;
  }
  return total === 0 ? 0 : red / total;
}
