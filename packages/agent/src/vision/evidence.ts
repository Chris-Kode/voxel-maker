import {
  WorkspaceError,
  PREVIEW_IMAGE_MAX_DIMENSION,
  PREVIEW_IMAGE_MAX_PIXELS,
  type JsonValue,
} from "@voxel-maker/shared";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { DocumentId } from "@voxel-maker/shared";

/**
 * Bounded visual evidence for the refinement loop (plan S15.1/S15.2,
 * ticket #40): the four fixed standard views, captured from a specific
 * live or preview revision, as bounded PNG bytes plus deterministic
 * camera/source metadata. Images are evidence for proposed commands,
 * never authoritative state (ARCHITECTURE.md).
 *
 * The `EvidenceCapture` seam keeps rendering platform details (software
 * rasterizer, PNG encoder) OUT of the agent package: the desktop
 * composition root implements it with the renderer preview service, and
 * deterministic tests use the scripted fake below. Capture is pure and
 * synchronous; every captured set is validated and bounded before the
 * loop may transmit it.
 */

/** The four fixed standard views (plan S15.1, fixed render protocol). */
export const STANDARD_VIEWS = ["perspective", "front", "side", "top"] as const;

export type StandardViewId = (typeof STANDARD_VIEWS)[number];

/** Maximum width or height of one evidence image (ARCHITECTURE.md bounds). */
export const MAX_EVIDENCE_DIMENSION = PREVIEW_IMAGE_MAX_DIMENSION;

/** Maximum total pixels of one evidence image (16 MiB decoded RGBA). */
export const MAX_EVIDENCE_PIXELS = PREVIEW_IMAGE_MAX_PIXELS;

/**
 * Upper bound of the PNG byte size for a validated image: stored-DEFLATE
 * adds one filter byte per row, a zlib wrapper, and 5 bytes per 65535-byte
 * block; the slack covers the PNG signature, IHDR, and IEND chunks.
 */
export function maxPngBytes(width: number, height: number): number {
  return width * height * 4 + height + 8192;
}

/** Maximum images in one evidence set (one per standard view). */
export const MAX_EVIDENCE_IMAGES = STANDARD_VIEWS.length;

/** One bounded standard-view image captured from a specific revision. */
export interface VisualEvidenceImage {
  readonly view: StandardViewId;
  readonly width: number;
  readonly height: number;
  /**
   * Byte-exact PNG of the rendered view (bounded). This is the payload
   * that MAY be transmitted under image consent.
   */
  readonly pngBytes: Uint8Array;
  /**
   * Straight-alpha RGBA pixels (`width * height * 4` bytes) of the same
   * render. Local-only: used by the deterministic visual comparison,
   * never transmitted and never retained.
   */
  readonly rgbaBytes: Uint8Array;
  /** Store revision the image was rendered from. */
  readonly revision: number;
  /** Canonical asset semantic hash at render time. */
  readonly semanticHash: string;
  /** Which store the image came from: live or staged preview. */
  readonly source: "live" | "preview";
  /** Preview session id when `source` is "preview". */
  readonly sessionId?: string;
}

/** One captured evidence set: the standard views of ONE revision. */
export interface VisualEvidenceSet {
  readonly documentId: DocumentId;
  /** Revision of the store the views were rendered from. */
  readonly revision: number;
  /** Canonical asset semantic hash of the rendered store. */
  readonly semanticHash: string;
  readonly source: "live" | "preview";
  readonly sessionId?: string;
  /** One image per requested view, in canonical `STANDARD_VIEWS` order. */
  readonly images: readonly VisualEvidenceImage[];
  /** Sum of the PNG byte lengths. */
  readonly totalPngBytes: number;
}

export interface EvidenceCaptureRequest {
  /** Read surface to render (live store or preview session). */
  readonly store: DocumentStoreRead;
  readonly source: "live" | "preview";
  /** Preview session id when the store is a preview session. */
  readonly sessionId?: string;
  /** Views to capture; defaults to all four standard views. */
  readonly views?: readonly StandardViewId[];
  /** Square output size; defaults to `DEFAULT_EVIDENCE_SIZE`. */
  readonly width?: number;
  readonly height?: number;
}

/** Default evidence resolution for visual refinement (512x512). */
export const DEFAULT_EVIDENCE_SIZE = 512;

/**
 * Evidence capture seam (plan S15.2/S15.3): renders the fixed standard
 * views of a live or staged store into bounded PNG evidence. Implemented
 * by the composition root with the renderer preview service; never
 * implemented by the loop itself.
 */
export interface EvidenceCapture {
  captureEvidence(request: EvidenceCaptureRequest): VisualEvidenceSet;
}

function evidenceError(
  code: string,
  message: string,
  context?: Readonly<Record<string, JsonValue>>,
): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code,
    message,
    ...(context === undefined ? {} : { context }),
  });
}

/** Validates one capture request before any render work. */
export function validateEvidenceRequest(
  request: EvidenceCaptureRequest,
): EvidenceCaptureRequest {
  const views =
    request.views === undefined ? [...STANDARD_VIEWS] : [...request.views];
  if (views.length === 0 || views.length > MAX_EVIDENCE_IMAGES) {
    throw evidenceError(
      "INVALID_EVIDENCE_VIEWS",
      `Evidence capture needs between 1 and ${String(MAX_EVIDENCE_IMAGES)} standard views`,
    );
  }
  for (const view of views) {
    if (!STANDARD_VIEWS.includes(view)) {
      throw evidenceError(
        "INVALID_EVIDENCE_VIEW",
        `Unknown standard view: ${view}`,
      );
    }
  }
  if (new Set(views).size !== views.length) {
    throw evidenceError(
      "INVALID_EVIDENCE_VIEWS",
      "Evidence views must not repeat",
    );
  }
  const width = request.width ?? DEFAULT_EVIDENCE_SIZE;
  const height = request.height ?? DEFAULT_EVIDENCE_SIZE;
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw evidenceError(
      "INVALID_EVIDENCE_DIMENSIONS",
      `Evidence dimensions must be integers, got ${String(width)}x${String(height)}`,
    );
  }
  if (width < 1 || height < 1) {
    throw evidenceError(
      "INVALID_EVIDENCE_DIMENSIONS",
      `Evidence dimensions must be positive, got ${String(width)}x${String(height)}`,
    );
  }
  if (width > MAX_EVIDENCE_DIMENSION || height > MAX_EVIDENCE_DIMENSION) {
    throw evidenceError(
      "EVIDENCE_DIMENSION_LIMIT",
      `Evidence dimensions exceed the ${String(MAX_EVIDENCE_DIMENSION)}px limit: ${String(width)}x${String(height)}`,
      { width, height },
    );
  }
  if (width * height > MAX_EVIDENCE_PIXELS) {
    throw evidenceError(
      "EVIDENCE_PIXEL_LIMIT",
      `Evidence pixel count exceeds the ${String(MAX_EVIDENCE_PIXELS)}px limit: ${String(width * height)}`,
    );
  }
  if (
    request.sessionId !== undefined &&
    (request.sessionId.length === 0 || request.sessionId.length > 128)
  ) {
    throw evidenceError(
      "INVALID_EVIDENCE_SESSION_ID",
      "Evidence session ids must be non-empty strings of at most 128 characters",
    );
  }
  return Object.freeze({
    store: request.store,
    source: request.source,
    ...(request.sessionId === undefined
      ? {}
      : { sessionId: request.sessionId }),
    views: Object.freeze(views),
    width,
    height,
  });
}

/**
 * Validates one captured evidence set (defense in depth: the loop checks
 * the capture output before transmission). Rejects missing, oversized,
 * mislabeled, or cross-revision images.
 */
export function validateEvidenceSet(
  set: VisualEvidenceSet,
): VisualEvidenceSet {
  if (set.images.length === 0 || set.images.length > MAX_EVIDENCE_IMAGES) {
    throw evidenceError(
      "INVALID_EVIDENCE_SET",
      `An evidence set must hold between 1 and ${String(MAX_EVIDENCE_IMAGES)} images`,
    );
  }
  let total = 0;
  const seen = new Set<string>();
  for (const image of set.images) {
    if (!STANDARD_VIEWS.includes(image.view)) {
      throw evidenceError(
        "INVALID_EVIDENCE_SET",
        `Unknown view in evidence set: ${image.view}`,
      );
    }
    if (seen.has(image.view)) {
      throw evidenceError(
        "INVALID_EVIDENCE_SET",
        `Duplicate view in evidence set: ${image.view}`,
      );
    }
    seen.add(image.view);
    if (
      !Number.isInteger(image.width) ||
      !Number.isInteger(image.height) ||
      image.width < 1 ||
      image.height < 1 ||
      image.width > MAX_EVIDENCE_DIMENSION ||
      image.height > MAX_EVIDENCE_DIMENSION ||
      image.width * image.height > MAX_EVIDENCE_PIXELS
    ) {
      throw evidenceError(
        "INVALID_EVIDENCE_SET",
        "Evidence image dimensions are out of bounds",
      );
    }
    if (image.pngBytes.byteLength > maxPngBytes(image.width, image.height)) {
      throw evidenceError(
        "INVALID_EVIDENCE_SET",
        "Evidence image bytes exceed the bounded PNG size",
      );
    }
    if (
      image.rgbaBytes.byteLength !== image.width * image.height * 4
    ) {
      throw evidenceError(
        "INVALID_EVIDENCE_SET",
        "Evidence image RGBA buffer must match the image dimensions",
      );
    }
    if (image.revision !== set.revision) {
      throw evidenceError(
        "INVALID_EVIDENCE_SET",
        "Every evidence image must belong to the set revision",
      );
    }
    if (image.semanticHash !== set.semanticHash) {
      throw evidenceError(
        "INVALID_EVIDENCE_SET",
        "Every evidence image must belong to the set semantic hash",
      );
    }
    if (image.source !== set.source) {
      throw evidenceError(
        "INVALID_EVIDENCE_SET",
        "Evidence image source must match the set source",
      );
    }
    if (
      set.sessionId !== undefined &&
      (image.sessionId === undefined || image.sessionId !== set.sessionId)
    ) {
      throw evidenceError(
        "INVALID_EVIDENCE_SET",
        "Evidence image session id must match the set session id",
      );
    }
    total += image.pngBytes.byteLength;
  }
  return Object.freeze({
    documentId: set.documentId,
    revision: set.revision,
    semanticHash: set.semanticHash,
    source: set.source,
    ...(set.sessionId === undefined ? {} : { sessionId: set.sessionId }),
    images: Object.freeze([...set.images]),
    totalPngBytes: total,
  });
}

/** Builds a frozen evidence set from validated images (capture helper). */
export function buildEvidenceSet(input: {
  readonly documentId: DocumentId;
  readonly revision: number;
  readonly semanticHash: string;
  readonly source: "live" | "preview";
  readonly sessionId?: string;
  readonly images: readonly VisualEvidenceImage[];
}): VisualEvidenceSet {
  return validateEvidenceSet({
    documentId: input.documentId,
    revision: input.revision,
    semanticHash: input.semanticHash,
    source: input.source,
    ...(input.sessionId === undefined
      ? {}
      : { sessionId: input.sessionId }),
    images: input.images,
    totalPngBytes: 0,
  });
}
