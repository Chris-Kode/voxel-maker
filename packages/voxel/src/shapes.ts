import { WorkspaceError } from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";

/**
 * Frozen deterministic shape voxelization (plan S3.5 / S3.7, issue #8).
 *
 * Voxelization rules are product policy, not renderer guesses:
 *
 * - **Box**: every integer point in the half-open region `[min, max)`.
 * - **Sphere**: solid sphere — every integer point whose squared distance
 *   from the integer center is at most `radius^2`. Radius `0` yields exactly
 *   the center point. The rule is axis-independent and uses exact integer
 *   arithmetic, so results are identical on every platform.
 * - **Cylinder**: axis-aligned solid cylinder — every integer point whose
 *   coordinate along the chosen axis lies in `[center, center + height)` and
 *   whose squared distance from the axis is at most `radius^2`. Height `0`
 *   yields no points.
 *
 * Radii and heights are non-negative integers in v1. All iterators clip to a
 * caller-supplied half-open region and enforce two hard bounds before and
 * during iteration (ADR-0009): the generated coordinate count never exceeds
 * `maxCoordinates`, and the iteration domain (shape bounds intersected with
 * the clip) never exceeds `2 * maxCoordinates` so a sparse shape cannot force
 * a pathological scan. A sphere or cylinder that could collect at most
 * `maxCoordinates` points always has a domain of at most `~1.91 * maxCoordinates`,
 * so the domain guard never rejects a shape that could legally fit.
 */

/** Axis a cylinder is aligned with. */
export type ShapeAxis = "x" | "y" | "z";

/** Bounds for one shape iteration (plan S3.5). */
export interface ShapeIterationOptions {
  /** Half-open clip region; points outside are excluded. */
  readonly clip: IntAabb;
  /** Hard cap on generated coordinates (ADR-0009: 1,000,000 per operation). */
  readonly maxCoordinates: number;
}

const AXES: readonly ShapeAxis[] = ["x", "y", "z"];

const limitError = (requested: number, limit: number): WorkspaceError =>
  new WorkspaceError({
    family: "limit",
    code: "TOO_MANY_VOXELS",
    message: "Shape voxelization exceeds the per-operation voxel limit",
    context: { requested, limit },
  });

const domainError = (requested: number, limit: number): WorkspaceError =>
  new WorkspaceError({
    family: "limit",
    code: "TOO_MANY_VOXELS",
    message: "Shape iteration domain exceeds the per-operation voxel limit",
    context: { requested, limit, resource: "iterationDomain" },
  });

function assertAxis(axis: ShapeAxis): void {
  if (!AXES.includes(axis)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_AXIS",
      message: 'Shape axis must be one of "x", "y", or "z"',
      context: { value: axis },
    });
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_SHAPE_DIMENSION",
      message: `${name} must be a non-negative integer`,
      context: { [name]: value },
    });
  }
}

/** Half-open intersection of two AABBs; undefined when they do not overlap. */
export function intersectAabb(a: IntAabb, b: IntAabb): IntAabb | undefined {
  const min: Vec3i = [
    Math.max(a.min[0], b.min[0]),
    Math.max(a.min[1], b.min[1]),
    Math.max(a.min[2], b.min[2]),
  ];
  const max: Vec3i = [
    Math.min(a.max[0], b.max[0]),
    Math.min(a.max[1], b.max[1]),
    Math.min(a.max[2], b.max[2]),
  ];
  if (min[0] >= max[0] || min[1] >= max[1] || min[2] >= max[2]) {
    return undefined;
  }
  return { min, max };
}

/** Fails fast when an iteration domain exceeds the ADR-0009 guard. */
export function assertIterationDomain(
  domain: IntAabb,
  maxCoordinates: number,
): void {
  const volume =
    (domain.max[0] - domain.min[0]) *
    (domain.max[1] - domain.min[1]) *
    (domain.max[2] - domain.min[2]);
  if (volume > maxCoordinates * 2) {
    throw domainError(volume, maxCoordinates * 2);
  }
}

function pushPoint(
  points: Vec3i[],
  x: number,
  y: number,
  z: number,
  maxCoordinates: number,
): void {
  if (points.length >= maxCoordinates) {
    throw limitError(points.length + 1, maxCoordinates);
  }
  points.push([x, y, z]);
}

/**
 * Every integer point in the half-open box `[min, max)`, clipped to
 * `options.clip` and bounded by `options.maxCoordinates`.
 */
export function boxCoordinates(
  region: IntAabb,
  options: ShapeIterationOptions,
): readonly Vec3i[] {
  const domain = intersectAabb(region, options.clip);
  if (domain === undefined) return [];
  assertIterationDomain(domain, options.maxCoordinates);
  const points: Vec3i[] = [];
  for (let z = domain.min[2]; z < domain.max[2]; z += 1) {
    for (let y = domain.min[1]; y < domain.max[1]; y += 1) {
      for (let x = domain.min[0]; x < domain.max[0]; x += 1) {
        pushPoint(points, x, y, z, options.maxCoordinates);
      }
    }
  }
  return points;
}

/**
 * Every integer point of the solid sphere with integer center and integer
 * radius: `(x-cx)^2 + (y-cy)^2 + (z-cz)^2 <= radius^2`.
 */
export function sphereCoordinates(
  center: Vec3i,
  radius: number,
  options: ShapeIterationOptions,
): readonly Vec3i[] {
  assertNonNegativeInteger(radius, "radius");
  const [cx, cy, cz] = center;
  const domain = intersectAabb(
    {
      min: [cx - radius, cy - radius, cz - radius],
      max: [cx + radius + 1, cy + radius + 1, cz + radius + 1],
    },
    options.clip,
  );
  if (domain === undefined) return [];
  assertIterationDomain(domain, options.maxCoordinates);
  const radiusSquared = radius * radius;
  const points: Vec3i[] = [];
  for (let z = domain.min[2]; z < domain.max[2]; z += 1) {
    const dz = z - cz;
    for (let y = domain.min[1]; y < domain.max[1]; y += 1) {
      const dy = y - cy;
      for (let x = domain.min[0]; x < domain.max[0]; x += 1) {
        const dx = x - cx;
        if (dx * dx + dy * dy + dz * dz <= radiusSquared) {
          pushPoint(points, x, y, z, options.maxCoordinates);
        }
      }
    }
  }
  return points;
}

/**
 * Every integer point of the axis-aligned solid cylinder with integer
 * center, radius, and height. Along `axis`, points span
 * `[center[axis], center[axis] + height)`; the other two axes must satisfy
 * `dx^2 + dz^2 <= radius^2` (for the default `"y"` axis, `dx^2 + dz^2`).
 */
export function cylinderCoordinates(
  center: Vec3i,
  radius: number,
  height: number,
  axis: ShapeAxis,
  options: ShapeIterationOptions,
): readonly Vec3i[] {
  assertAxis(axis);
  assertNonNegativeInteger(radius, "radius");
  assertNonNegativeInteger(height, "height");
  const [cx, cy, cz] = center;
  const axisIndex = AXES.indexOf(axis);
  const min: number[] = [cx - radius, cy - radius, cz - radius];
  const max: number[] = [cx + radius + 1, cy + radius + 1, cz + radius + 1];
  min[axisIndex] = center[axisIndex] as number;
  max[axisIndex] = (center[axisIndex] as number) + height;
  const domain = intersectAabb(
    {
      min: [min[0] as number, min[1] as number, min[2] as number],
      max: [max[0] as number, max[1] as number, max[2] as number],
    },
    options.clip,
  );
  if (domain === undefined) return [];
  assertIterationDomain(domain, options.maxCoordinates);
  const radiusSquared = radius * radius;
  const points: Vec3i[] = [];
  for (let z = domain.min[2]; z < domain.max[2]; z += 1) {
    for (let y = domain.min[1]; y < domain.max[1]; y += 1) {
      for (let x = domain.min[0]; x < domain.max[0]; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        const radialSquared =
          axis === "x"
            ? dy * dy + dz * dz
            : axis === "y"
              ? dx * dx + dz * dz
              : dx * dx + dy * dy;
        if (radialSquared <= radiusSquared) {
          pushPoint(points, x, y, z, options.maxCoordinates);
        }
      }
    }
  }
  return points;
}
