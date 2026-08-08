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

/**
 * 4x4 affine matrix in row-major order (ADR-0001: matrices are runtime-only).
 * A point is a column vector; `applyMatrix` computes `M * p`.
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
    matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
    matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
    matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11],
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
  return [
    a00,
    a01,
    a02,
    tauX,
    a10,
    a11,
    a12,
    tauY,
    a20,
    a21,
    a22,
    tauZ,
    0,
    0,
    0,
    1,
  ];
}

/** Multiplies two 4x4 matrices: `a * b` (apply `b` first, then `a`). */
export function multiplyMatrices(a: Mat4, b: Mat4): Mat4 {
  const result: number[] = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      let sum = 0;
      for (let inner = 0; inner < 4; inner += 1) {
        sum +=
          (a[row * 4 + inner] as number) * (b[inner * 4 + column] as number);
      }
      result.push(sum);
    }
  }
  return result as unknown as Mat4;
}

/** Inverts a 4x4 affine matrix (linear part inverse plus translation). */
export function invertMatrix(matrix: Mat4): Mat4 {
  const a00 = matrix[0];
  const a01 = matrix[1];
  const a02 = matrix[2];
  const a10 = matrix[4];
  const a11 = matrix[5];
  const a12 = matrix[6];
  const a20 = matrix[8];
  const a21 = matrix[9];
  const a22 = matrix[10];
  const tauX = matrix[3];
  const tauY = matrix[7];
  const tauZ = matrix[11];
  const determinant =
    a00 * (a11 * a22 - a12 * a21) -
    a01 * (a10 * a22 - a12 * a20) +
    a02 * (a10 * a21 - a11 * a20);
  if (!(Math.abs(determinant) > 0)) {
    throw new WorkspaceError({
      family: "validation",
      code: "NON_INVERTIBLE_TRANSFORM",
      message: "Transform matrix is not invertible",
    });
  }
  const invDet = 1 / determinant;
  const b00 = (a11 * a22 - a12 * a21) * invDet;
  const b01 = (a02 * a21 - a01 * a22) * invDet;
  const b02 = (a01 * a12 - a02 * a11) * invDet;
  const b10 = (a12 * a20 - a10 * a22) * invDet;
  const b11 = (a00 * a22 - a02 * a20) * invDet;
  const b12 = (a02 * a10 - a00 * a12) * invDet;
  const b20 = (a10 * a21 - a11 * a20) * invDet;
  const b21 = (a01 * a20 - a00 * a21) * invDet;
  const b22 = (a00 * a11 - a01 * a10) * invDet;
  return [
    b00,
    b01,
    b02,
    -(b00 * tauX + b01 * tauY + b02 * tauZ),
    b10,
    b11,
    b12,
    -(b10 * tauX + b11 * tauY + b12 * tauZ),
    b20,
    b21,
    b22,
    -(b20 * tauX + b21 * tauY + b22 * tauZ),
    0,
    0,
    0,
    1,
  ];
}

/**
 * Decomposes an affine matrix into a canonical `Transform` with the given
 * pivot (ADR-0001). The linear part must be a rotation times a strictly
 * positive diagonal scale; derived components are quantized to 1e-9 and
 * magnitudes below 5e-10 canonicalized to zero. Throws when the
 * decomposition does not recompose within 1e-9 per element.
 */
export function decomposeMatrix(matrix: Mat4, pivot: Vec3): Transform {
  const a00 = matrix[0];
  const a01 = matrix[1];
  const a02 = matrix[2];
  const a10 = matrix[4];
  const a11 = matrix[5];
  const a12 = matrix[6];
  const a20 = matrix[8];
  const a21 = matrix[9];
  const a22 = matrix[10];
  const tauX = matrix[3];
  const tauY = matrix[7];
  const tauZ = matrix[11];
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
  // Recomposition check: R * S must reproduce the linear part within 1e-9.
  const recomposed = [
    r00 * scaleX,
    r01 * scaleY,
    r02 * scaleZ,
    r10 * scaleX,
    r11 * scaleY,
    r12 * scaleZ,
    r20 * scaleX,
    r21 * scaleY,
    r22 * scaleZ,
  ];
  const linear = [a00, a01, a02, a10, a11, a12, a20, a21, a22];
  for (let index = 0; index < 9; index += 1) {
    if (
      Math.abs((recomposed[index] as number) - (linear[index] as number)) >
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
  return {
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
