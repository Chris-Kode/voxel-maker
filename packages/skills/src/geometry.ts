/**
 * Minimal structural geometry types used by generators (plan S14.3).
 * The skills package intentionally stays off the `math` package: these
 * types are structurally identical to the engine's `IntAabb`/`Vec3i`, so
 * canonicalizing command constructors accept them directly, while the
 * generators themselves stay pure parameter-to-command mappings with no
 * engine import beyond the generic command proposal contracts.
 */

/** Integer voxel coordinate triple. */
export type Vec3i = readonly [number, number, number];

/** Half-open integer axis-aligned box `[min, max)` with `min <= max`. */
export type IntAabb = {
  readonly min: Vec3i;
  readonly max: Vec3i;
};

/** Axis a pattern is aligned with (matches the engine ShapeAxis values). */
export type ShapeAxis = "x" | "y" | "z";

/** Integer size triple (width, height, depth in voxels). */
export type Vec3Size = readonly [number, number, number];

/** Volume of a half-open box, or 0 for malformed boxes. */
export function boxVolume(aabb: IntAabb): number {
  const dx = aabb.max[0] - aabb.min[0];
  const dy = aabb.max[1] - aabb.min[1];
  const dz = aabb.max[2] - aabb.min[2];
  if (dx < 0 || dy < 0 || dz < 0) return 0;
  return dx * dy * dz;
}

/** Component-wise minimum of two integer vectors. */
export function minVec3(a: Vec3i, b: Vec3i): Vec3i {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
}

/** Component-wise maximum of two integer vectors. */
export function maxVec3(a: Vec3i, b: Vec3i): Vec3i {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
}

/** Smallest half-open box containing both inputs. */
export function unionAabb(a: IntAabb, b: IntAabb): IntAabb {
  return { min: minVec3(a.min, b.min), max: maxVec3(a.max, b.max) };
}

/** Box translated by an integer delta. */
export function translateAabb(aabb: IntAabb, delta: Vec3i): IntAabb {
  return {
    min: [
      aabb.min[0] + delta[0],
      aabb.min[1] + delta[1],
      aabb.min[2] + delta[2],
    ],
    max: [
      aabb.max[0] + delta[0],
      aabb.max[1] + delta[1],
      aabb.max[2] + delta[2],
    ],
  };
}

/** Half-open box covering `[min, min + size)` for a positive size triple. */
export function boxFromMinSize(min: Vec3i, size: Vec3Size): IntAabb {
  return {
    min: [...min],
    max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]],
  };
}

/** True when `value` is a valid integer vector of length three. */
export function isVec3i(value: unknown): value is Vec3i {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((part) => Number.isInteger(part))
  );
}
