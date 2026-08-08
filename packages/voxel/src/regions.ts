import { WorkspaceError } from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import type { ShapeAxis } from "./shapes.js";

/**
 * Deterministic voxel-region transformations (plan S3.9-S3.12, issue #9).
 *
 * Every operation uses half-open integer regions `[min, max)` and moves
 * existing voxel content with exact integer semantics:
 *
 * - **Translate** shifts the region content by an integer delta.
 * - **Rotate** turns the region content around the region center by exact
 *   90-degree increments. The mapping is the exact lattice rotation of voxel
 *   centers: `p' = c + R(p + 1/2 - c) - 1/2` with `c = (min + max) / 2`.
 *   This maps integer coordinates to integer coordinates only when the
 *   region extents on the two rotation-plane axes have the same parity
 *   (both even or both odd); otherwise the rotated voxel centers would land
 *   on half-integer positions and the operation is rejected
 *   (`INVALID_ROTATION_REGION`). Resampling is explicitly deferred (plan
 *   S3.11). Four quarter turns are the identity for every exact region.
 * - **Mirror** reflects the region content across the plane through the
 *   region center perpendicular to the chosen axis:
 *   `p' = (min.a + max.a - p.a - 1)` on the mirror axis. This is exact for
 *   every region and mirroring twice is the identity.
 *
 * The destination of a rotation is the axis-aligned bounding box of the
 * rotated content: the same center as the source region with the extents of
 * the two rotation-plane axes swapped (180 degrees keeps the source box).
 * The destination of a mirror is the source region itself.
 */

/** Exact 90-degree rotation increments (plan S3.11). */
export type QuarterTurns = 1 | 2 | 3;

/** Planned rotation of a half-open region (plan S3.11). */
export interface RegionRotationPlan {
  /** Half-open destination AABB of the rotated content. */
  readonly destination: IntAabb;
  /** Maps one source voxel coordinate to its rotated position. */
  map(coordinate: Vec3i): Vec3i;
}

const AXES: readonly ShapeAxis[] = ["x", "y", "z"];

function assertAxis(axis: ShapeAxis): void {
  if (!AXES.includes(axis)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_AXIS",
      message: 'Axis must be one of "x", "y", or "z"',
      context: { value: axis },
    });
  }
}

function assertQuarterTurns(
  quarterTurns: number,
): asserts quarterTurns is QuarterTurns {
  if (quarterTurns !== 1 && quarterTurns !== 2 && quarterTurns !== 3) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_QUARTER_TURNS",
      message: "quarterTurns must be 1, 2, or 3 (exact 90-degree increments)",
      context: { value: String(quarterTurns) },
    });
  }
}

/** Half-open AABB translated by an integer delta (plan S3.10). */
export function translateAabb(region: IntAabb, delta: Vec3i): IntAabb {
  return {
    min: [
      region.min[0] + delta[0],
      region.min[1] + delta[1],
      region.min[2] + delta[2],
    ],
    max: [
      region.max[0] + delta[0],
      region.max[1] + delta[1],
      region.max[2] + delta[2],
    ],
  };
}

/**
 * True when an exact 90-degree rotation of the region around its center maps
 * integer voxel coordinates to integer voxel coordinates: the extents on
 * the two rotation-plane axes must have the same parity. 180 degrees is
 * always exact.
 */
export function canRotateExactly(
  region: IntAabb,
  axis: ShapeAxis,
  quarterTurns: QuarterTurns,
): boolean {
  assertAxis(axis);
  assertQuarterTurns(quarterTurns);
  if (quarterTurns === 2) return true;
  const ex = region.max[0] - region.min[0];
  const ey = region.max[1] - region.min[1];
  const ez = region.max[2] - region.min[2];
  if (axis === "x") return ey % 2 === ez % 2;
  if (axis === "y") return ex % 2 === ez % 2;
  return ex % 2 === ey % 2;
}

/** Throws `INVALID_ROTATION_REGION` when the rotation would not be exact. */
export function assertExactRotationRegion(
  region: IntAabb,
  axis: ShapeAxis,
  quarterTurns: QuarterTurns,
  path?: readonly (string | number)[],
): void {
  if (!canRotateExactly(region, axis, quarterTurns)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_ROTATION_REGION",
      message:
        "Exact 90-degree rotation requires the region extents on the two rotation-plane axes to have the same parity; resampling is deferred in v1",
      ...(path === undefined ? {} : { path }),
      context: {
        axis,
        quarterTurns: String(quarterTurns),
        region: {
          min: [region.min[0], region.min[1], region.min[2]],
          max: [region.max[0], region.max[1], region.max[2]],
        },
      },
    });
  }
}

/**
 * Plans an exact 90-degree rotation of a region around its center
 * (plan S3.11). The destination is the AABB of the rotated content: the
 * source center with the two rotation-plane extents swapped (180 degrees
 * keeps the source box). Throws `INVALID_ROTATION_REGION` when the exact
 * lattice rotation is impossible.
 */
export function rotateRegionPlan(
  region: IntAabb,
  axis: ShapeAxis,
  quarterTurns: QuarterTurns,
): RegionRotationPlan {
  assertAxis(axis);
  assertQuarterTurns(quarterTurns);
  assertExactRotationRegion(region, axis, quarterTurns);
  const min = region.min;
  const max = region.max;
  const ex = max[0] - min[0];
  const ey = max[1] - min[1];
  const ez = max[2] - min[2];
  // Region center; integer or half-integer per axis.
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;
  let destination: IntAabb;
  if (quarterTurns === 2) {
    destination = { min, max };
  } else if (axis === "x") {
    destination = {
      min: [min[0], cy - ez / 2, cz - ey / 2],
      max: [max[0], cy + ez / 2, cz + ey / 2],
    };
  } else if (axis === "y") {
    destination = {
      min: [cx - ez / 2, min[1], cz - ex / 2],
      max: [cx + ez / 2, max[1], cz + ex / 2],
    };
  } else {
    destination = {
      min: [cx - ey / 2, cy - ex / 2, min[2]],
      max: [cx + ey / 2, cy + ex / 2, max[2]],
    };
  }
  return { destination, map: rotationMap(axis, quarterTurns, cx, cy, cz) };
}

/** Exact lattice rotation of voxel centers around `c` (plan S3.11). */
function rotationMap(
  axis: ShapeAxis,
  quarterTurns: QuarterTurns,
  cx: number,
  cy: number,
  cz: number,
): (coordinate: Vec3i) => Vec3i {
  if (quarterTurns === 2) {
    // 180 degrees: p' = 2c - p - 1 on every axis.
    return (p) => [
      reflectAboutCenter(cx, p[0]),
      reflectAboutCenter(cy, p[1]),
      reflectAboutCenter(cz, p[2]),
    ];
  }
  if (axis === "x") {
    if (quarterTurns === 1) {
      return (p) => [p[0], cy + cz - p[2] - 1, cz - cy + p[1]];
    }
    return (p) => [p[0], cy - cz + p[2], cy + cz - p[1] - 1];
  }
  if (axis === "y") {
    if (quarterTurns === 1) {
      return (p) => [cx + p[2] - cz, p[1], cz - p[0] + cx - 1];
    }
    return (p) => [cx + cz - p[2] - 1, p[1], cz - cx + p[0]];
  }
  if (quarterTurns === 1) {
    return (p) => [cx + cy - p[1] - 1, cy - cx + p[0], p[2]];
  }
  return (p) => [cx - cy + p[1], cx + cy - p[0] - 1, p[2]];
}

/** 180-degree reflection of one component about a center: `2c - p - 1`. */
const reflectAboutCenter = (center: number, component: number): number =>
  2 * center - component - 1;

/**
 * Mirrors a voxel coordinate across the plane through the region center
 * perpendicular to `axis` (plan S3.12): `p' = (min.a + max.a - p.a - 1)`
 * on the mirror axis. The destination AABB is the source region itself.
 */
export function mirrorCoordinate(
  region: IntAabb,
  axis: ShapeAxis,
  coordinate: Vec3i,
): Vec3i {
  assertAxis(axis);
  const axisIndex = AXES.indexOf(axis);
  const sum =
    (region.min[axisIndex] as number) + (region.max[axisIndex] as number);
  if (axisIndex === 0) {
    return [sum - coordinate[0] - 1, coordinate[1], coordinate[2]];
  }
  if (axisIndex === 1) {
    return [coordinate[0], sum - coordinate[1] - 1, coordinate[2]];
  }
  return [coordinate[0], coordinate[1], sum - coordinate[2] - 1];
}
