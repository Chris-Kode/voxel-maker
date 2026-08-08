import { WorkspaceError } from "@voxel-maker/shared";

/** Three-component real vector used for translation, scale, and extents. */
export type Vec3 = readonly [number, number, number];

/** Three-component integer vector used for voxel-scale coordinates. */
export type Vec3i = readonly [number, number, number];

/** Quaternion serialized as `[x, y, z, w]` in canonical normalized form. */
export type Quat = readonly [number, number, number, number];

/** Canonical node transform: `T(translation) x T(pivot) x R(rotation) x S(scale) x T(-pivot)`. */
export interface Transform {
  readonly translation: Vec3;
  readonly pivot: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

/** Loose transform input accepted by canonicalizing constructors. */
export interface TransformInput {
  readonly translation: readonly [number, number, number];
  readonly pivot: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

/** Integer half-open axis-aligned box `[min, max)`; `min <= max` per axis. */
export interface IntAabb {
  readonly min: Vec3i;
  readonly max: Vec3i;
}

/**
 * Absolute epsilon for math predicates (ADR-0001). Used to accept quaternions
 * whose length differs from 1 only by floating-point rounding.
 */
export const QUATERNION_NORM_EPSILON = 1e-9;

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

type Path = readonly (string | number)[] | undefined;

const at = (path: Path, key: string | number): Path =>
  path === undefined ? undefined : [...path, key];

function invalidNumber(
  value: number,
  path: Path,
  code = "INVALID_CANONICAL_NUMBER",
  message = "Canonical numbers must be finite and must not be negative zero",
): never {
  throw new WorkspaceError({
    family: "validation",
    code,
    message,
    ...(path === undefined ? {} : { path }),
    context: { value: String(value) },
  });
}

/** Rejects non-finite values and canonicalizes serialized negative zero. */
export function canonicalNumber(value: number, path?: Path): number {
  if (!Number.isFinite(value)) {
    invalidNumber(value, path);
  }
  return Object.is(value, -0) ? 0 : value;
}

/** Returns a canonical finite `Vec3` copy with negative zero normalized. */
export function canonicalVec3(
  value: readonly [number, number, number],
  path?: Path,
): Vec3 {
  return [
    canonicalNumber(value[0], at(path, 0)),
    canonicalNumber(value[1], at(path, 1)),
    canonicalNumber(value[2], at(path, 2)),
  ];
}

/** Returns a canonical integer `Vec3i` copy within signed 32-bit bounds. */
export function canonicalVec3i(
  value: readonly [number, number, number],
  path?: Path,
): Vec3i {
  return [
    canonicalInteger(value[0], at(path, 0)),
    canonicalInteger(value[1], at(path, 1)),
    canonicalInteger(value[2], at(path, 2)),
  ];
}

function canonicalInteger(value: number, path: Path): number {
  const canonical = canonicalNumber(value, path);
  if (
    !Number.isInteger(canonical) ||
    canonical < INT32_MIN ||
    canonical > INT32_MAX
  ) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_INTEGER_VECTOR",
      message:
        "Integer vector components must be integers within 32-bit bounds",
      ...(path === undefined ? {} : { path }),
      context: { value: String(canonical) },
    });
  }
  return canonical;
}

const negate = (value: number): number => (value === 0 ? 0 : -value);

function signCanonicalize(x: number, y: number, z: number, w: number): Quat {
  // ADR-0001: canonical form has w > 0; when w is 0 the first non-zero
  // component among x, y, z must be positive.
  if (w < 0) return [negate(x), negate(y), negate(z), negate(w)];
  if (w === 0) {
    if (x < 0) return [negate(x), negate(y), negate(z), negate(w)];
    if (x === 0 && y < 0) return [negate(x), negate(y), negate(z), negate(w)];
    if (x === 0 && y === 0 && z < 0)
      return [negate(x), negate(y), negate(z), negate(w)];
  }
  return [x, y, z, w];
}

/**
 * Normalizes and sign-canonicalizes a finite quaternion (ADR-0001).
 * Rejects non-finite components and zero-length quaternions.
 */
export function canonicalQuat(
  value: readonly [number, number, number, number],
  path?: Path,
): Quat {
  const x = canonicalNumber(value[0], at(path, 0));
  const y = canonicalNumber(value[1], at(path, 1));
  const z = canonicalNumber(value[2], at(path, 2));
  const w = canonicalNumber(value[3], at(path, 3));
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!(norm > 0)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_QUATERNION",
      message: "Quaternions must have non-zero length",
      ...(path === undefined ? {} : { path }),
    });
  }
  return signCanonicalize(x / norm, y / norm, z / norm, w / norm);
}

/** Returns a canonical strictly positive scale vector (ADR-0001). */
export function canonicalScale(
  value: readonly [number, number, number],
  path?: Path,
): Vec3 {
  return [
    canonicalPositive(value[0], at(path, 0)),
    canonicalPositive(value[1], at(path, 1)),
    canonicalPositive(value[2], at(path, 2)),
  ];
}

function canonicalPositive(value: number, path: Path): number {
  const canonical = canonicalNumber(value, path);
  if (canonical <= 0) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_SCALE",
      message: "Scale must be strictly positive",
      ...(path === undefined ? {} : { path }),
      context: { value: String(canonical) },
    });
  }
  return canonical;
}

/** Returns a canonical transform with normalized rotation and canonicalized numbers. */
export function canonicalTransform(
  input: TransformInput,
  path?: Path,
): Transform {
  return {
    translation: canonicalVec3(input.translation, at(path, "translation")),
    pivot: canonicalVec3(input.pivot, at(path, "pivot")),
    rotation: canonicalQuat(input.rotation, at(path, "rotation")),
    scale: canonicalScale(input.scale, at(path, "scale")),
  };
}

/** Returns a canonical integer half-open AABB with `min <= max` per axis. */
export function canonicalIntAabb(
  input: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  },
  path?: Path,
): IntAabb {
  const min = canonicalVec3i(input.min, at(path, "min"));
  const max = canonicalVec3i(input.max, at(path, "max"));
  if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_AABB",
      message: "AABB minimum must not exceed maximum on any axis",
      ...(path === undefined ? {} : { path }),
      context: {
        min: String(min),
        max: String(max),
      },
    });
  }
  return { min, max };
}

/** True when the quaternion is finite and its length is 1 within epsilon. */
export function isNormalizedQuat(
  value: readonly [number, number, number, number],
): boolean {
  if (value.some((component) => !Number.isFinite(component))) return false;
  const normSquared =
    value[0] * value[0] +
    value[1] * value[1] +
    value[2] * value[2] +
    value[3] * value[3];
  return Math.abs(Math.sqrt(normSquared) - 1) <= QUATERNION_NORM_EPSILON;
}

/** True when the quaternion satisfies the ADR-0001 sign canonicalization. */
export function isCanonicalQuat(
  value: readonly [number, number, number, number],
): boolean {
  const [x, y, z, w] = value;
  if (w > 0) return true;
  if (w < 0) return false;
  if (x > 0) return true;
  if (x < 0) return false;
  if (y > 0) return true;
  if (y < 0) return false;
  return z > 0;
}
