import { WorkspaceError } from "@voxel-maker/shared";
import type { Vec3 } from "@voxel-maker/math";
import type { WorldBounds } from "../pick.js";

/**
 * Standard preview render protocol (plan S15.1/S8.5, ticket #25): the
 * four standard viewpoints users can export, with FIXED framing, light,
 * background, orientation, and bounded requested dimensions.
 *
 * Everything here is pure deterministic policy: given the same document
 * and the same `PreviewSpec`, the produced image is byte-identical on any
 * platform. Camera conventions reuse the viewport's ADR-0001 frame
 * (`+X right, +Y up, +Z forward`, camera.ts): the perspective view uses
 * the default viewport direction, the axis-aligned views use the same
 * directions as the viewport's standard views, and the top view keeps the
 * viewport's screen-up convention (the asset front faces the bottom of
 * the image). Framing, lighting, and background are constants below; the
 * only caller-controlled inputs are the view id and the dimensions.
 */

/** The four standard export viewpoints (plan S15.1). */
export type PreviewViewId = "perspective" | "front" | "side" | "top";

/** All standard views in canonical export order. */
export const STANDARD_PREVIEW_VIEWS: readonly PreviewViewId[] = [
  "perspective",
  "front",
  "side",
  "top",
];

/** Requested output dimensions for one standard preview. */
export interface PreviewSpec {
  readonly view: PreviewViewId;
  readonly width: number;
  readonly height: number;
}

/** Default export size (1024x1024). */
export const DEFAULT_PREVIEW_SIZE = 1024;

/** Maximum width or height of one exported preview (ARCHITECTURE.md bounds). */
export const MAX_PREVIEW_DIMENSION = 4096;

/** Maximum total pixels of one exported preview (16 MiB decoded RGBA). */
export const MAX_PREVIEW_PIXELS = 4_194_304;

/** Fixed vertical field of view in radians (matches the viewport, 50 deg). */
export const PREVIEW_FOV_Y = (50 * Math.PI) / 180;

/** Extra framing margin around the content bounding sphere. */
export const PREVIEW_FRAME_MARGIN = 1.2;

/** Near/far planes for the perspective projection. */
export const PREVIEW_NEAR = 0.1;
export const PREVIEW_FAR = 100000;

/** Near/far planes for the orthographic projection. */
export const PREVIEW_ORTHO_NEAR = -100000;
export const PREVIEW_ORTHO_FAR = 100000;

/** Fixed orthographic viewing distance (framing does not depend on it). */
export const PREVIEW_ORTHO_DISTANCE = 1000;

/**
 * Fixed background color (sRGB-encoded 0..1), matching the shell's base
 * background (`--bg`, #14161a).
 */
export const PREVIEW_BACKGROUND: Vec3 = [20 / 255, 22 / 255, 26 / 255];

/** Fixed ambient light factor (shaded = color * (ambient + diffuse*dot)). */
export const PREVIEW_AMBIENT = 0.35;

/** Fixed diffuse light factor; ambient + diffuse = 1 so lit colors never blow out. */
export const PREVIEW_DIFFUSE = 0.65;

/**
 * Fixed light direction (unit vector the light travels, world space):
 * from the upper-front-left of the asset. Constant across all views so
 * exported images share one consistent look.
 */
export const PREVIEW_LIGHT_DIRECTION: Vec3 = normalize([-0.5, 0.8, 0.5]);

/** Fallback color for a material id missing from the document (magenta). */
export const PREVIEW_MISSING_MATERIAL: Vec3 = [1, 0, 1];

/** Unit camera direction for each standard view (toward the camera). */
const VIEW_DIRECTIONS: Readonly<Record<PreviewViewId, Vec3>> = {
  // Same direction as the viewport's default camera (24, 20, 24).
  perspective: normalize([24, 20, 24]),
  front: [0, 0, 1],
  // "Side" is the asset's right side, matching the viewport's right view.
  side: [1, 0, 0],
  top: [0, 1, 0],
};

/** Camera up for each view (matches the viewport's `cameraUpVector`). */
const VIEW_UPS: Readonly<Record<PreviewViewId, Vec3>> = {
  perspective: [0, 1, 0],
  front: [0, 1, 0],
  side: [0, 1, 0],
  // Looking straight down: screen-up is -Z so the asset front (+Z)
  // points toward the bottom of the image (viewport convention).
  top: [0, 0, -1],
};

/** Projection half-planes: perspective keeps fov, ortho gets half extents. */
export type PreviewProjection =
  | { readonly kind: "perspective"; readonly fovY: number }
  | {
      readonly kind: "orthographic";
      readonly halfWidth: number;
      readonly halfHeight: number;
    };

/** Fully determined camera for one standard view (S15.2 metadata). */
export interface PreviewFraming {
  readonly view: PreviewViewId;
  readonly width: number;
  readonly height: number;
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  readonly projection: PreviewProjection;
  /** The world-space content bounds that were framed (undefined when empty). */
  readonly contentBounds: WorldBounds | undefined;
}

/** Validates a preview spec; rejects non-integer, zero, and oversized inputs. */
export function validatePreviewSpec(spec: PreviewSpec): PreviewSpec {
  const { view, width, height } = spec;
  if (!STANDARD_PREVIEW_VIEWS.includes(view)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_PREVIEW_VIEW",
      message: `Unknown standard preview view: ${view}`,
      context: { view },
    });
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_PREVIEW_DIMENSIONS",
      message: `Preview dimensions must be integers, got ${String(width)}x${String(height)}`,
    });
  }
  if (width < 1 || height < 1) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_PREVIEW_DIMENSIONS",
      message: `Preview dimensions must be positive, got ${String(width)}x${String(height)}`,
    });
  }
  if (width > MAX_PREVIEW_DIMENSION || height > MAX_PREVIEW_DIMENSION) {
    throw new WorkspaceError({
      family: "limit",
      code: "PREVIEW_DIMENSION_LIMIT",
      message: `Preview dimensions exceed the ${String(MAX_PREVIEW_DIMENSION)}px limit: ${String(width)}x${String(height)}`,
      context: { width, height },
    });
  }
  if (width * height > MAX_PREVIEW_PIXELS) {
    throw new WorkspaceError({
      family: "limit",
      code: "PREVIEW_PIXEL_LIMIT",
      message: `Preview pixel count exceeds the ${String(MAX_PREVIEW_PIXELS)}px limit: ${String(width * height)}`,
      context: { width, height },
    });
  }
  return spec;
}

/** Fallback framing for a document with no voxel content. */
const EMPTY_CONTENT_RADIUS = 8;

/**
 * Frames one standard view: centers the target on the content bounds and
 * fits the bounding sphere with `PREVIEW_FRAME_MARGIN` on BOTH axes (a
 * portrait image frames the horizontal axis too, not just the vertical
 * one). The perspective camera distance follows from the fitted
 * half-height; the orthographic views use the fitted half-extents
 * directly with a fixed viewing distance.
 */
export function frameStandardView(
  view: PreviewViewId,
  bounds: WorldBounds | undefined,
  width: number,
  height: number,
): PreviewFraming {
  const aspect = width / height;
  const center: Vec3 =
    bounds === undefined
      ? [0, 0, 0]
      : [
          (bounds.min[0] + bounds.max[0]) / 2,
          (bounds.min[1] + bounds.max[1]) / 2,
          (bounds.min[2] + bounds.max[2]) / 2,
        ];
  const radius =
    bounds === undefined
      ? EMPTY_CONTENT_RADIUS
      : Math.hypot(
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2],
        ) / 2;
  // Fit the sphere on the vertical axis, then widen for portrait aspect
  // so the horizontal axis fits too.
  let halfHeight = radius * PREVIEW_FRAME_MARGIN;
  if (halfHeight * aspect < radius * PREVIEW_FRAME_MARGIN) {
    halfHeight = (radius * PREVIEW_FRAME_MARGIN) / aspect;
  }
  const halfWidth = halfHeight * aspect;
  const direction = VIEW_DIRECTIONS[view];
  const up = VIEW_UPS[view];
  const eye =
    view === "perspective"
      ? add(center, scale(direction, halfHeight / Math.tan(PREVIEW_FOV_Y / 2)))
      : add(center, scale(direction, PREVIEW_ORTHO_DISTANCE));
  return {
    view,
    width,
    height,
    eye,
    target: center,
    up,
    projection:
      view === "perspective"
        ? { kind: "perspective", fovY: PREVIEW_FOV_Y }
        : { kind: "orthographic", halfWidth, halfHeight },
    contentBounds: bounds,
  };
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length === 0) return [0, 0, 0];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function scale(v: Vec3, factor: number): Vec3 {
  return [v[0] * factor, v[1] * factor, v[2] * factor];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
