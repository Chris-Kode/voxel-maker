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

/** Smallest positive normal double; squared sums below it are subnormal. */
const NORMAL_MIN = 2 ** -1022;

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
  const normSquared = x * x + y * y + z * z + w * w;
  if (normSquared >= NORMAL_MIN && Number.isFinite(normSquared)) {
    // The squared sum is a normal number, so the norm is accurate to a
    // few ulps and the division cannot overflow or underflow.
    const norm = Math.sqrt(normSquared);
    return signCanonicalize(x / norm, y / norm, z / norm, w / norm);
  }
  // The squared sum overflowed to Infinity, underflowed to zero, or landed
  // in the subnormal range where it carries large relative error (issue
  // #83). Rescale by the largest component so the norm is computed in
  // [1, 2] and cannot overflow.
  const maxComponent = Math.max(
    Math.abs(x),
    Math.abs(y),
    Math.abs(z),
    Math.abs(w),
  );
  if (!(maxComponent > 0)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_QUATERNION",
      message: "Quaternions must have non-zero length",
      ...(path === undefined ? {} : { path }),
    });
  }
  const scaledX = x / maxComponent;
  const scaledY = y / maxComponent;
  const scaledZ = z / maxComponent;
  const scaledW = w / maxComponent;
  const rescaledNorm = Math.sqrt(
    scaledX * scaledX +
      scaledY * scaledY +
      scaledZ * scaledZ +
      scaledW * scaledW,
  );
  // canonicalNumber already normalized -0 to +0, so no division below can
  // produce -0; signCanonicalize additionally maps any negated zero to +0.
  return signCanonicalize(
    scaledX / rescaledNorm,
    scaledY / rescaledNorm,
    scaledZ / rescaledNorm,
    scaledW / rescaledNorm,
  );
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

function nonInvertibleTransform(): never {
  throw new WorkspaceError({
    family: "validation",
    code: "NON_INVERTIBLE_TRANSFORM",
    message: "Transform matrix is not invertible",
  });
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

/**
 * 4x4 affine matrix in column-major storage (plan.md: "Matrices:
 * column-major only inside math/runtime APIs"; ADR-0001: matrices are
 * runtime-only): element `(row, column)` lives at index
 * `row + 4 * column`, so the translation column occupies indices 12-14
 * and the last row is `[0, 0, 0, 1]` at indices 3, 7, 11, 15. This
 * matches the storage convention of standard column-major consumers such
 * as Three.js/WebGL (`Matrix4.fromArray`), so matrices can be handed to
 * them directly. A point is a column vector; `applyMatrix` computes
 * `M * p`.
 */
export type Mat4 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Absolute epsilon for matrix decomposition checks (ADR-0001). */
const MATRIX_EPSILON = 1e-9;

/** Quantization step for platform-sensitive derived transform components. */
const DERIVED_QUANTUM = 1e-9;

/** Rounds a derived component to the ADR-0001 1e-9 grid and drops -0. */
function quantizeDerived(value: number): number {
  const quantized = Math.round(value / DERIVED_QUANTUM) * DERIVED_QUANTUM;
  return Object.is(quantized, -0) ? 0 : quantized;
}

/** Applies a 4x4 affine matrix to a point (column-vector convention). */
export function applyMatrix(matrix: Mat4, point: Vec3): Vec3 {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

/**
 * Converts a canonical transform to its 4x4 affine matrix, evaluating
 * `T(translation) x T(pivot) x R(rotation) x S(scale) x T(-pivot)`.
 */
export function transformToMatrix(transform: Transform): Mat4 {
  const [tx, ty, tz] = transform.translation;
  const [px, py, pz] = transform.pivot;
  const [qx, qy, qz, qw] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  // Rotation matrix from the canonical quaternion.
  const r00 = 1 - 2 * (qy * qy + qz * qz);
  const r01 = 2 * (qx * qy - qz * qw);
  const r02 = 2 * (qx * qz + qy * qw);
  const r10 = 2 * (qx * qy + qz * qw);
  const r11 = 1 - 2 * (qx * qx + qz * qz);
  const r12 = 2 * (qy * qz - qx * qw);
  const r20 = 2 * (qx * qz - qy * qw);
  const r21 = 2 * (qy * qz + qx * qw);
  const r22 = 1 - 2 * (qx * qx + qy * qy);
  // Linear part A = R * S (scale multiplies the rotation columns).
  const a00 = r00 * sx;
  const a01 = r01 * sy;
  const a02 = r02 * sz;
  const a10 = r10 * sx;
  const a11 = r11 * sy;
  const a12 = r12 * sz;
  const a20 = r20 * sx;
  const a21 = r21 * sy;
  const a22 = r22 * sz;
  // Translation tau = t + p - A * p.
  const tauX = tx + px - (a00 * px + a01 * py + a02 * pz);
  const tauY = ty + py - (a10 * px + a11 * py + a12 * pz);
  const tauZ = tz + pz - (a20 * px + a21 * py + a22 * pz);
  // Column-major storage: column 0 = [a00, a10, a20, 0], column 1 =
  // [a01, a11, a21, 0], column 2 = [a02, a12, a22, 0], column 3 =
  // [tauX, tauY, tauZ, 1] (translation at indices 12-14).
  return [
    a00,
    a10,
    a20,
    0,
    a01,
    a11,
    a21,
    0,
    a02,
    a12,
    a22,
    0,
    tauX,
    tauY,
    tauZ,
    1,
  ];
}

/** Multiplies two 4x4 matrices: `a * b` (apply `b` first, then `a`). */
export function multiplyMatrices(a: Mat4, b: Mat4): Mat4 {
  const result: number[] = [];
  // Column-major storage: iterate columns in the outer loop so the pushed
  // order is `row + 4 * column`.
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let inner = 0; inner < 4; inner += 1) {
        sum +=
          (a[row + 4 * inner] as number) * (b[inner + 4 * column] as number);
      }
      result.push(sum);
    }
  }
  return result as unknown as Mat4;
}

/**
 * Inverts a 4x4 affine matrix (linear part inverse plus translation).
 *
 * The linear block is column-equilibrated before the cofactor determinant:
 * each column is divided by its largest absolute entry so the normalized
 * block has entries in [-1, 1]. The determinant and cofactor products then
 * cannot underflow (tiny scales) or overflow (huge scales) before the
 * singularity test, and the inverse is rescaled afterwards (issue #84).
 * A zero column, a zero determinant, or a non-finite result is rejected
 * with the stable `NON_INVERTIBLE_TRANSFORM` error.
 */
export function invertMatrix(matrix: Mat4): Mat4 {
  const a00 = matrix[0];
  const a01 = matrix[4];
  const a02 = matrix[8];
  const a10 = matrix[1];
  const a11 = matrix[5];
  const a12 = matrix[9];
  const a20 = matrix[2];
  const a21 = matrix[6];
  const a22 = matrix[10];
  const tauX = matrix[12];
  const tauY = matrix[13];
  const tauZ = matrix[14];
  const columnScale0 = Math.max(Math.abs(a00), Math.abs(a10), Math.abs(a20));
  const columnScale1 = Math.max(Math.abs(a01), Math.abs(a11), Math.abs(a21));
  const columnScale2 = Math.max(Math.abs(a02), Math.abs(a12), Math.abs(a22));
  if (!(columnScale0 > 0) || !(columnScale1 > 0) || !(columnScale2 > 0)) {
    // A zero column makes the linear block singular regardless of the rest.
    nonInvertibleTransform();
  }
  const b00 = a00 / columnScale0;
  const b01 = a01 / columnScale1;
  const b02 = a02 / columnScale2;
  const b10 = a10 / columnScale0;
  const b11 = a11 / columnScale1;
  const b12 = a12 / columnScale2;
  const b20 = a20 / columnScale0;
  const b21 = a21 / columnScale1;
  const b22 = a22 / columnScale2;
  const determinant =
    b00 * (b11 * b22 - b12 * b21) -
    b01 * (b10 * b22 - b12 * b20) +
    b02 * (b10 * b21 - b11 * b20);
  if (!(Math.abs(determinant) > 0)) {
    nonInvertibleTransform();
  }
  const invDet = 1 / determinant;
  const m00 = (b11 * b22 - b12 * b21) * invDet;
  const m01 = (b02 * b21 - b01 * b22) * invDet;
  const m02 = (b01 * b12 - b02 * b11) * invDet;
  const m10 = (b12 * b20 - b10 * b22) * invDet;
  const m11 = (b00 * b22 - b02 * b20) * invDet;
  const m12 = (b02 * b10 - b00 * b12) * invDet;
  const m20 = (b10 * b21 - b11 * b20) * invDet;
  const m21 = (b01 * b20 - b00 * b21) * invDet;
  const m22 = (b00 * b11 - b01 * b10) * invDet;
  // The linear block is `B * diag(columnScale0, columnScale1, columnScale2)`,
  // so its inverse is `diag(1/columnScale0, ...) * B^-1`: row `i` of the
  // normalized inverse is divided by `columnScale_i`.
  const inv00 = m00 / columnScale0;
  const inv01 = m01 / columnScale0;
  const inv02 = m02 / columnScale0;
  const inv10 = m10 / columnScale1;
  const inv11 = m11 / columnScale1;
  const inv12 = m12 / columnScale1;
  const inv20 = m20 / columnScale2;
  const inv21 = m21 / columnScale2;
  const inv22 = m22 / columnScale2;
  // Column-major storage: columns of the inverse linear part, then the
  // inverse translation `-B * tau` at indices 12-14.
  const result: Mat4 = [
    inv00,
    inv10,
    inv20,
    0,
    inv01,
    inv11,
    inv21,
    0,
    inv02,
    inv12,
    inv22,
    0,
    -(inv00 * tauX + inv01 * tauY + inv02 * tauZ),
    -(inv10 * tauX + inv11 * tauY + inv12 * tauZ),
    -(inv20 * tauX + inv21 * tauY + inv22 * tauZ),
    1,
  ];
  // A finite input whose inverse is not representable (for example a scale
  // so small that the reciprocal overflows) must fail with the stable error
  // instead of returning NaN/Infinity entries.
  for (let index = 0; index < 15; index += 1) {
    if (!Number.isFinite(result[index] as number)) {
      nonInvertibleTransform();
    }
  }
  return result;
}

/**
 * Decomposes an affine matrix into a canonical `Transform` with the given
 * pivot (ADR-0001). The linear part must be a rotation times a strictly
 * positive diagonal scale; derived components are quantized to 1e-9 and
 * magnitudes below 5e-10 canonicalized to zero. Throws when the final
 * canonical transform does not recompose the input matrix within 1e-9 per
 * element.
 */
export function decomposeMatrix(matrix: Mat4, pivot: Vec3): Transform {
  const a00 = matrix[0];
  const a01 = matrix[4];
  const a02 = matrix[8];
  const a10 = matrix[1];
  const a11 = matrix[5];
  const a12 = matrix[9];
  const a20 = matrix[2];
  const a21 = matrix[6];
  const a22 = matrix[10];
  const tauX = matrix[12];
  const tauY = matrix[13];
  const tauZ = matrix[14];
  const scaleX = Math.sqrt(a00 * a00 + a10 * a10 + a20 * a20);
  const scaleY = Math.sqrt(a01 * a01 + a11 * a11 + a21 * a21);
  const scaleZ = Math.sqrt(a02 * a02 + a12 * a12 + a22 * a22);
  if (!(scaleX > 0) || !(scaleY > 0) || !(scaleZ > 0)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_TRANSFORM_DECOMPOSITION",
      message:
        "Transform matrix cannot be decomposed into a rotation times positive scale",
    });
  }
  const r00 = a00 / scaleX;
  const r01 = a01 / scaleY;
  const r02 = a02 / scaleZ;
  const r10 = a10 / scaleX;
  const r11 = a11 / scaleY;
  const r12 = a12 / scaleZ;
  const r20 = a20 / scaleX;
  const r21 = a21 / scaleY;
  const r22 = a22 / scaleZ;
  // The normalized columns must form a proper rotation (orthonormal, det > 0).
  const orthonormal =
    Math.abs(r00 * r00 + r10 * r10 + r20 * r20 - 1) <= MATRIX_EPSILON &&
    Math.abs(r01 * r01 + r11 * r11 + r21 * r21 - 1) <= MATRIX_EPSILON &&
    Math.abs(r02 * r02 + r12 * r12 + r22 * r22 - 1) <= MATRIX_EPSILON &&
    Math.abs(r00 * r01 + r10 * r11 + r20 * r21) <= MATRIX_EPSILON &&
    Math.abs(r00 * r02 + r10 * r12 + r20 * r22) <= MATRIX_EPSILON &&
    Math.abs(r01 * r02 + r11 * r12 + r21 * r22) <= MATRIX_EPSILON;
  const determinant =
    r00 * (r11 * r22 - r12 * r21) -
    r01 * (r10 * r22 - r12 * r20) +
    r02 * (r10 * r21 - r11 * r20);
  if (!orthonormal || !(determinant > 0)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_TRANSFORM_DECOMPOSITION",
      message:
        "Transform matrix cannot be decomposed into a rotation times positive scale",
    });
  }
  const [px, py, pz] = pivot;
  const translationX = tauX - px + (a00 * px + a01 * py + a02 * pz);
  const translationY = tauY - py + (a10 * px + a11 * py + a12 * pz);
  const translationZ = tauZ - pz + (a20 * px + a21 * py + a22 * pz);
  const rotation = quaternionFromRotationMatrix([
    r00,
    r01,
    r02,
    r10,
    r11,
    r12,
    r20,
    r21,
    r22,
  ]);
  const transform: Transform = {
    translation: [
      quantizeDerived(translationX),
      quantizeDerived(translationY),
      quantizeDerived(translationZ),
    ],
    pivot: [px, py, pz],
    rotation,
    scale: [
      quantizeDerived(scaleX),
      quantizeDerived(scaleY),
      quantizeDerived(scaleZ),
    ],
  };
  // Recomposition check: the final canonical/quantized transform must
  // reproduce the input matrix within 1e-9 per element (ADR-0001). The
  // orthonormal check above is not sufficient: a matrix whose normalized
  // columns are within epsilon of orthonormal can still decompose to a
  // transform that recomposes far outside the bound (issue #81), so the
  // returned transform is recomposed through `transformToMatrix` and every
  // element is compared against the input.
  const recomposed = transformToMatrix(transform);
  for (let index = 0; index < 16; index += 1) {
    if (
      Math.abs((recomposed[index] as number) - (matrix[index] as number)) >
      MATRIX_EPSILON
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_TRANSFORM_DECOMPOSITION",
        message:
          "Transform matrix decomposition does not recompose within the ADR-0001 epsilon",
      });
    }
  }
  return transform;
}

/** Converts a 3x3 rotation matrix to a canonical quaternion (ADR-0001). */
function quaternionFromRotationMatrix(
  rotation: readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ],
): Quat {
  const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = rotation;
  const trace = r00 + r11 + r22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (r21 - r12) / s;
    y = (r02 - r20) / s;
    z = (r10 - r01) / s;
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    w = (r21 - r12) / s;
    x = 0.25 * s;
    y = (r01 + r10) / s;
    z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    w = (r02 - r20) / s;
    x = (r01 + r10) / s;
    y = 0.25 * s;
    z = (r12 + r21) / s;
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    w = (r10 - r01) / s;
    x = (r02 + r20) / s;
    y = (r12 + r21) / s;
    z = 0.25 * s;
  }
  return canonicalQuat([x, y, z, w]);
}

/**
 * Exact component-wise transform equality (canonical values compare equal).
 * Shared by the gizmo, inspector, and command packages so drag/inspector
 * no-op detection stays identical.
 */
export function transformsEqual(a: Transform, b: Transform): boolean {
  return (
    a.translation[0] === b.translation[0] &&
    a.translation[1] === b.translation[1] &&
    a.translation[2] === b.translation[2] &&
    a.pivot[0] === b.pivot[0] &&
    a.pivot[1] === b.pivot[1] &&
    a.pivot[2] === b.pivot[2] &&
    a.rotation[0] === b.rotation[0] &&
    a.rotation[1] === b.rotation[1] &&
    a.rotation[2] === b.rotation[2] &&
    a.rotation[3] === b.rotation[3] &&
    a.scale[0] === b.scale[0] &&
    a.scale[1] === b.scale[1] &&
    a.scale[2] === b.scale[2]
  );
}

/**
 * Resolves the local transform that places a child under `parentWorld` while
 * preserving its world placement: `inverse(parentWorld) * world`, decomposed
 * with the given pivot (ADR-0001 derived-transform policy).
 */
export function resolveLocalTransform(
  world: Mat4,
  parentWorld: Mat4,
  pivot: Vec3,
): Transform {
  return decomposeMatrix(
    multiplyMatrices(invertMatrix(parentWorld), world),
    pivot,
  );
}

/**
 * Hamilton product of two unit quaternions. The result represents the
 * composition that applies `b` first and then `a` (matrix order `A * B`);
 * to apply `a` first and then `b`, call `quaternionMultiply(b, a)`. Used
 * by the rotate gizmo (pre-multiplication applies a delta in the node's
 * local frame) and Euler conversions (plan S7.8).
 */
export function quaternionMultiply(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return canonicalQuat([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

/**
 * Conjugate of a unit quaternion (the inverse rotation). The result is
 * canonical for a canonical input.
 */
export function quaternionConjugate(
  value: readonly [number, number, number, number],
): Quat {
  const [x, y, z, w] = value;
  return signCanonicalize(-x, -y, -z, w);
}

/**
 * Unit quaternion rotating `angle` radians around `axis` (right-hand rule).
 * The axis must have non-zero length; it is normalized before use.
 */
export function quaternionFromAxisAngle(axis: Vec3, angle: number): Quat {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (!(length > 0) || !Number.isFinite(length)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_AXIS",
      message: "Rotation axes must have non-zero finite length",
      context: { axis: String(axis) },
    });
  }
  const half = angle / 2;
  const s = Math.sin(half);
  return canonicalQuat([
    (axis[0] / length) * s,
    (axis[1] / length) * s,
    (axis[2] / length) * s,
    Math.cos(half),
  ]);
}

/**
 * Shortest-path spherical interpolation between two unit quaternions
 * (plan S10.3, ticket #28). The interpolation travels the shorter arc on
 * the unit 3-sphere: when the dot product of the two quaternions is
 * negative, the second quaternion is negated first (q and -q describe the
 * same rotation, so this picks the short way). `t` is clamped to [0, 1];
 * `t = 0` returns `a` exactly and `t = 1` returns `b` exactly (the input
 * references), so sampling at exact keyframe boundaries reproduces the
 * stored values bit for bit; for `0 < t < 1` the result is normalized and
 * ADR-0001 sign-canonicalized. The degenerate parallel/antipodal cases
 * fall back to a normalized linear blend (the shortest path is not unique
 * there; the blend is deterministic).
 */
export function quaternionSlerp(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
  t: number,
): Quat {
  const u = Math.min(1, Math.max(0, t));
  if (u === 0) return a;
  if (u === 1) return b;
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    // Shortest path: interpolate toward the negated endpoint.
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }
  if (dot > 1 - QUATERNION_NORM_EPSILON) {
    // Parallel or antipodal endpoints: the great-circle arc degenerates,
    // so a normalized linear blend is the deterministic shortest path.
    const x = a[0] + (bx - a[0]) * u;
    const y = a[1] + (by - a[1]) * u;
    const z = a[2] + (bz - a[2]) * u;
    const w = a[3] + (bw - a[3]) * u;
    const normSquared = x * x + y * y + z * z + w * w;
    if (normSquared < 1e-24) {
      // Antipodal blend midpoint (a and -a cancel): the rotation is
      // constant along the chosen arc, so either endpoint is exact.
      return a;
    }
    return canonicalQuat([x, y, z, w]);
  }
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const weightA = Math.sin((1 - u) * theta) / sinTheta;
  const weightB = Math.sin(u * theta) / sinTheta;
  return canonicalQuat([
    weightA * a[0] + weightB * bx,
    weightA * a[1] + weightB * by,
    weightA * a[2] + weightB * bz,
    weightA * a[3] + weightB * bw,
  ]);
}

/**
 * Applies a unit quaternion rotation to a vector. The result is exact for
 * unit input quaternions; no renormalization is performed.
 */
export function rotateVector(
  quaternion: readonly [number, number, number, number],
  vector: Vec3,
): Vec3 {
  const [x, y, z, w] = quaternion;
  const [vx, vy, vz] = vector;
  const ux = x * 2;
  const uy = y * 2;
  const uz = z * 2;
  const uux = x * ux;
  const uuy = y * uy;
  const uuz = z * uz;
  const uwx = w * ux;
  const uwy = w * uy;
  const uwz = w * uz;
  return [
    vx * (1 - uuy - uuz) + vy * (ux * y - uwz) + vz * (ux * z + uwy),
    vx * (ux * y + uwz) + vy * (1 - uux - uuz) + vz * (uy * z - uwx),
    vx * (ux * z - uwy) + vy * (uy * z + uwx) + vz * (1 - uux - uuy),
  ];
}

/**
 * Converts an intrinsic XYZ Euler rotation (radians, applied as
 * `R = Rx * Ry * Rz`) to a canonical unit quaternion. This is the Euler
 * convention the inspector and rotate gizmo expose; angles are arbitrary
 * finite radians and the composed rotation is normalized.
 */
export function eulerXYZToQuaternion(euler: Vec3): Quat {
  const cx = Math.cos(euler[0] / 2);
  const sx = Math.sin(euler[0] / 2);
  const cy = Math.cos(euler[1] / 2);
  const sy = Math.sin(euler[1] / 2);
  const cz = Math.cos(euler[2] / 2);
  const sz = Math.sin(euler[2] / 2);
  return canonicalQuat([
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ]);
}

/**
 * Extracts intrinsic XYZ Euler angles (radians) from a canonical unit
 * quaternion, matching `eulerXYZToQuaternion`. The extraction returns the
 * principal branch: `x` in `[-pi, pi]`, `z` in `[-pi, pi]`, and `y` in
 * `[-pi/2, pi/2]`; a gimbal-locked configuration (cos(y) ~ 0) resolves z
 * to zero and folds the remaining rotation into x. Values are finite and
 * never serialized negative zero.
 */
export function quaternionToEulerXYZ(
  quaternion: readonly [number, number, number, number],
): Vec3 {
  const [x, y, z, w] = quaternion;
  // Intrinsic XYZ composition R = Rx*Ry*Rz gives sinY at row 0 col 2 of
  // the rotation matrix, i.e. 2*(x*z + y*w).
  const sinY = 2 * (x * z + y * w);
  const clamped = Math.max(-1, Math.min(1, sinY));
  const yAngle = Math.asin(clamped);
  if (Math.abs(Math.cos(yAngle)) <= 1e-9) {
    // Gimbal lock: fold the remaining rotation into x with z = 0. With
    // z = 0 the matrix entries R[1][0] = sinX*sinY and R[2][0] =
    // -cosX*sinY recover x; dividing by sinY (magnitude ~1) removes the
    // sign of the locked pole.
    const xAngle = Math.atan2(
      (2 * (x * y + z * w)) / sinY,
      (-2 * (x * z - y * w)) / sinY,
    );
    return canonicalVec3([xAngle, yAngle, 0]);
  }
  const xAngle = Math.atan2(2 * (x * w - y * z), 1 - 2 * (x * x + y * y));
  const zAngle = Math.atan2(2 * (z * w - x * y), 1 - 2 * (y * y + z * z));
  return canonicalVec3([xAngle, yAngle, zAngle]);
}
