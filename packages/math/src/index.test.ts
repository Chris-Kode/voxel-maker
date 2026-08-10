import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  QUATERNION_NORM_EPSILON,
  applyMatrix,
  canonicalIntAabb,
  canonicalNumber,
  canonicalQuat,
  canonicalScale,
  canonicalTransform,
  canonicalVec3,
  canonicalVec3i,
  decomposeMatrix,
  eulerXYZToQuaternion,
  invertMatrix,
  isCanonicalQuat,
  isNormalizedQuat,
  multiplyMatrices,
  quaternionConjugate,
  quaternionFromAxisAngle,
  quaternionMultiply,
  quaternionSlerp,
  quaternionToEulerXYZ,
  resolveLocalTransform,
  rotateVector,
  transformToMatrix,
  transformsEqual,
  type Mat4,
  type Quat,
  type Transform,
} from "./index.js";

const HALF = Math.SQRT1_2; // 0.7071067811865476

/** Returns the `WorkspaceError` code thrown by `fn`, or undefined when it returns. */
const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof WorkspaceError) return error.code;
    throw error;
  }
};

describe("canonical numbers", () => {
  it("normalizes negative zero and rejects non-finite values", () => {
    expect(Object.is(canonicalNumber(-0), 0)).toBe(true);
    expect(canonicalNumber(0.1)).toBe(0.1);
    expect(() => canonicalNumber(Number.NaN)).toThrow(/finite/u);
    expect(() => canonicalNumber(Number.POSITIVE_INFINITY)).toThrow(/finite/u);
  });
});

describe("canonical vectors", () => {
  it("canonicalizes negative zero per component", () => {
    expect(canonicalVec3([-0, 0, -0])).toEqual([0, 0, 0]);
    expect(() => canonicalVec3([0, Number.NaN, 0])).toThrow(/finite/u);
  });

  it("requires integer components within 32-bit bounds", () => {
    expect(canonicalVec3i([-1, 0, 2_147_483_647])).toEqual([
      -1, 0, 2_147_483_647,
    ]);
    expect(() => canonicalVec3i([0.5, 0, 0])).toThrow(/integers/u);
    expect(() => canonicalVec3i([0, 2_147_483_648, 0])).toThrow(/integers/u);
  });
});

describe("canonical quaternions", () => {
  it("normalizes and sign-canonicalizes rotations", () => {
    expect(canonicalQuat([2, 0, 0, 0])).toEqual([1, 0, 0, 0]);
    expect(canonicalQuat([0, 0, 0, -1])).toEqual([0, 0, 0, 1]);
    // positive w is canonical even when earlier components are negative
    expect(canonicalQuat([0, -HALF, 0, HALF])).toEqual([0, -HALF, 0, HALF]);
    expect(canonicalQuat([0, -HALF, 0, -HALF])).toEqual([0, HALF, 0, HALF]);
  });

  it("rejects zero-length and non-finite quaternions", () => {
    expect(() => canonicalQuat([0, 0, 0, 0])).toThrow(/non-zero length/u);
    expect(() => canonicalQuat([Number.NaN, 0, 0, 1])).toThrow(/finite/u);
  });

  it("keeps normalized output within the ADR epsilon", () => {
    const q = canonicalQuat([3, -1, 2, 0.5]);
    expect(isNormalizedQuat(q)).toBe(true);
    expect(isCanonicalQuat(q)).toBe(true);
    expect(Math.abs(q[3])).toBeGreaterThan(0);
  });

  it("detects canonical signs and normalization", () => {
    const canonical: Quat = [HALF, 0, 0, HALF];
    expect(isCanonicalQuat(canonical)).toBe(true);
    expect(isNormalizedQuat(canonical)).toBe(true);
    expect(isCanonicalQuat([HALF, 0, 0, -HALF])).toBe(false);
    expect(isCanonicalQuat([0, -HALF, 0, -HALF])).toBe(false);
    expect(isCanonicalQuat([0, 0, 0, -1])).toBe(false);
    expect(isCanonicalQuat([0, 0, 0, 0])).toBe(false);
    expect(isNormalizedQuat([1, 0, 0, 0])).toBe(true);
    expect(isNormalizedQuat([1 + QUATERNION_NORM_EPSILON * 2, 0, 0, 0])).toBe(
      false,
    );
  });
});

describe("canonical scale", () => {
  it("requires strictly positive components", () => {
    expect(canonicalScale([1, 2, 3])).toEqual([1, 2, 3]);
    expect(() => canonicalScale([0, 1, 1])).toThrow(/strictly positive/u);
    expect(() => canonicalScale([-1, 1, 1])).toThrow(/strictly positive/u);
  });
});

describe("canonical transform", () => {
  it("canonicalizes every component", () => {
    const transform: Transform = canonicalTransform({
      translation: [-0, 1, 2],
      pivot: [0, 0, 0],
      rotation: [0, 0, 0, -1],
      scale: [1, 1, 1],
    });
    expect(transform.translation).toEqual([0, 1, 2]);
    expect(transform.rotation).toEqual([0, 0, 0, 1]);
    expect(() =>
      canonicalTransform({
        translation: [0, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 0, 1],
      }),
    ).toThrow(/strictly positive/u);
  });
});

describe("canonical AABB", () => {
  it("accepts half-open boxes and rejects inverted ranges", () => {
    expect(canonicalIntAabb({ min: [-1, -2, 0], max: [0, 2, 4] })).toEqual({
      min: [-1, -2, 0],
      max: [0, 2, 4],
    });
    expect(() => canonicalIntAabb({ min: [0, 0, 0], max: [-1, 1, 1] })).toThrow(
      /must not exceed maximum/u,
    );
  });
});

describe("affine transform matrices", () => {
  const identity: Transform = {
    translation: [0, 0, 0],
    pivot: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };

  it("converts the identity transform to the identity matrix", () => {
    expect(transformToMatrix(identity)).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
  });

  it("places translation in the fourth column", () => {
    const matrix = transformToMatrix({
      ...identity,
      translation: [1, -2, 3],
    });
    expect(applyMatrix(matrix, [0, 0, 0])).toEqual([1, -2, 3]);
  });

  it("evaluates T(t) x T(p) x R x S x T(-p) around the pivot", () => {
    const transform: Transform = {
      translation: [10, 0, 0],
      pivot: [2, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
    // A 180-degree rotation around the pivot at x=2 maps x=3 to x=1,
    // then the translation moves the result to x=11.
    const rotated: Transform = {
      ...transform,
      rotation: [0, 0, 1, 0],
    };
    expect(applyMatrix(transformToMatrix(rotated), [3, 0, 0])).toEqual([
      11, 0, 0,
    ]);
  });

  it("multiplies matrices in the given order", () => {
    const a = transformToMatrix({ ...identity, translation: [1, 0, 0] });
    const b = transformToMatrix({ ...identity, translation: [0, 2, 0] });
    expect(applyMatrix(multiplyMatrices(a, b), [0, 0, 0])).toEqual([1, 2, 0]);
    expect(applyMatrix(multiplyMatrices(b, a), [0, 0, 0])).toEqual([1, 2, 0]);
  });

  it("inverts affine matrices exactly", () => {
    const transform: Transform = {
      translation: [3, -1, 2],
      pivot: [1, 0, -1],
      rotation: [0, HALF, 0, HALF],
      scale: [2, 0.5, 3],
    };
    const matrix = transformToMatrix(transform);
    const inverse = invertMatrix(matrix);
    const product = multiplyMatrices(matrix, inverse);
    for (let i = 0; i < 16; i += 1) {
      const expected = i % 5 === 0 ? 1 : 0;
      expect(Math.abs((product[i] as number) - expected)).toBeLessThan(1e-9);
    }
  });

  it("decomposes a transform matrix back into canonical TRS with the given pivot", () => {
    const transform: Transform = {
      translation: [3, -1, 2],
      pivot: [1, 0, -1],
      rotation: [0, HALF, 0, HALF],
      scale: [2, 0.5, 3],
    };
    const decomposed = decomposeMatrix(
      transformToMatrix(transform),
      [1, 0, -1],
    );
    expect(decomposed.pivot).toEqual([1, 0, -1]);
    expect(decomposed.translation).toEqual([3, -1, 2]);
    expect(decomposed.rotation[0]).toBeCloseTo(0, 12);
    expect(decomposed.rotation[1]).toBeCloseTo(HALF, 12);
    expect(decomposed.rotation[2]).toBeCloseTo(0, 12);
    expect(decomposed.rotation[3]).toBeCloseTo(HALF, 12);
    expect(decomposed.scale).toEqual([2, 0.5, 3]);
  });

  it("quantizes derived components to 1e-9 and canonicalizes tiny magnitudes", () => {
    const transform: Transform = {
      translation: [1.0000000004, 0, 0],
      pivot: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1.0000000004, 1, 1],
    };
    const decomposed = decomposeMatrix(transformToMatrix(transform), [0, 0, 0]);
    expect(decomposed.translation[0]).toBe(1);
    expect(decomposed.scale[0]).toBe(1);
    expect(Object.is(decomposed.translation[1], -0)).toBe(false);
  });

  it("rejects matrices that are not a rotation times positive scale", () => {
    // A shear matrix cannot be represented as TRS with positive scale.
    const shear: Mat4 = [1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(() => decomposeMatrix(shear, [0, 0, 0])).toThrow(
      /decompos|represent/u,
    );
  });

  it("rejects a sheared preserve-world matrix that recomposes outside 1e-9 (issue #81)", () => {
    // A tiny child rotation under a huge non-uniform parent scale produces a
    // world matrix whose normalized columns pass the orthonormal epsilon but
    // that is not representable as positive-scale TRS: the returned transform
    // would move the world placement by ~450 units.
    const parent: Transform = {
      translation: [0, 0, 0],
      pivot: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1e12, 1e9, 1],
    };
    const local: Transform = {
      translation: [0, 0, 0],
      pivot: [0, 0, 0],
      rotation: quaternionFromAxisAngle([0, 0, 1], 9e-13),
      scale: [1, 1000, 1],
    };
    const world = multiplyMatrices(
      transformToMatrix(parent),
      transformToMatrix(local),
    );
    const identity: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(
      errorCode(() => resolveLocalTransform(world, identity, [0, 0, 0])),
    ).toBe("INVALID_TRANSFORM_DECOMPOSITION");
  });

  it("rejects a smaller sheared matrix that drifts 450x the 1e-9 bound (issue #81)", () => {
    const parent: Transform = {
      translation: [0, 0, 0],
      pivot: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1000, 1, 1],
    };
    const local: Transform = {
      translation: [0, 0, 0],
      pivot: [0, 0, 0],
      rotation: quaternionFromAxisAngle([0, 0, 1], 9e-13),
      scale: [1, 1, 1],
    };
    const world = multiplyMatrices(
      transformToMatrix(parent),
      transformToMatrix(local),
    );
    const identity: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(
      errorCode(() => resolveLocalTransform(world, identity, [0, 0, 0])),
    ).toBe("INVALID_TRANSFORM_DECOMPOSITION");
  });

  it("accepts a representable local matrix under a large parent scale (issue #81)", () => {
    // The same composition resolved under its actual parent yields a local
    // matrix that IS representable as positive-scale TRS within 1e-9, so the
    // decomposition must be accepted and recompose within the bound.
    const parent: Transform = {
      translation: [0, 0, 0],
      pivot: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1e12, 1e9, 1],
    };
    const local: Transform = {
      translation: [0, 0, 0],
      pivot: [0, 0, 0],
      rotation: quaternionFromAxisAngle([0, 0, 1], 9e-13),
      scale: [1, 1000, 1],
    };
    const parentWorld = transformToMatrix(parent);
    const world = multiplyMatrices(parentWorld, transformToMatrix(local));
    const resolved = resolveLocalTransform(world, parentWorld, [0, 0, 0]);
    const localMatrix = multiplyMatrices(invertMatrix(parentWorld), world);
    const recomposed = transformToMatrix(resolved);
    for (let index = 0; index < 16; index += 1) {
      expect(
        Math.abs(
          (recomposed[index] as number) - (localMatrix[index] as number),
        ),
      ).toBeLessThan(1e-9);
    }
  });

  it("round-trips representable TRS with a non-zero pivot within 1e-9 (issue #81)", () => {
    // The acceptance criterion promises that representable TRS still
    // round-trips within 1e-9; a non-zero pivot must not break that.
    const parent: Transform = {
      translation: [5, -2, 1],
      pivot: [0, 0, 0],
      rotation: [0, 0, HALF, HALF], // 90 degrees around Z
      scale: [2, 1, 1],
    };
    const local: Transform = {
      translation: [1, 0, 0],
      pivot: [1, 0, -1],
      rotation: [0, HALF, 0, HALF], // 90 degrees around Y
      scale: [2, 0.5, 3],
    };
    const parentWorld = transformToMatrix(parent);
    const world = multiplyMatrices(parentWorld, transformToMatrix(local));
    const resolved = resolveLocalTransform(world, parentWorld, [1, 0, -1]);
    const recomposed = multiplyMatrices(
      parentWorld,
      transformToMatrix(resolved),
    );
    for (let index = 0; index < 16; index += 1) {
      expect(
        Math.abs((recomposed[index] as number) - (world[index] as number)),
      ).toBeLessThan(1e-9);
    }
  });

  it("resolves a local transform that preserves the world placement", () => {
    const parent: Transform = {
      translation: [5, 0, 0],
      pivot: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
    const local: Transform = {
      translation: [1, 2, 0],
      pivot: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
    const world = multiplyMatrices(
      transformToMatrix(parent),
      transformToMatrix(local),
    );
    const resolved = resolveLocalTransform(
      world,
      transformToMatrix(parent),
      [0, 0, 0],
    );
    expect(resolved.translation).toEqual([1, 2, 0]);
    expect(resolved.rotation).toEqual([0, 0, 0, 1]);
    expect(resolved.scale).toEqual([1, 1, 1]);
  });

  it("resolves a rotated and scaled parent so the world placement round-trips", () => {
    const parent: Transform = {
      translation: [5, -2, 1],
      pivot: [0, 0, 0],
      rotation: [0, 0, HALF, HALF], // 90 degrees around Z
      scale: [2, 1, 1],
    };
    const local: Transform = {
      translation: [1, 0, 0],
      pivot: [0, 0, 0],
      rotation: [0, HALF, 0, HALF], // 90 degrees around Y
      scale: [1, 3, 1],
    };
    const world = multiplyMatrices(
      transformToMatrix(parent),
      transformToMatrix(local),
    );
    const resolved = resolveLocalTransform(
      world,
      transformToMatrix(parent),
      [0, 0, 0],
    );
    // The resolved local transform reproduces the original local transform
    // (up to the 1e-9 derived-component quantization)...
    expect(resolved.translation[0]).toBeCloseTo(1, 9);
    expect(resolved.translation[1]).toBeCloseTo(0, 9);
    expect(resolved.translation[2]).toBeCloseTo(0, 9);
    expect(resolved.rotation[1]).toBeCloseTo(HALF, 9);
    expect(resolved.rotation[3]).toBeCloseTo(HALF, 9);
    expect(resolved.scale[1]).toBeCloseTo(3, 9);
    // ...and composing it under the parent reproduces the world matrix.
    const recomposed = multiplyMatrices(
      transformToMatrix(parent),
      transformToMatrix(resolved),
    );
    for (let index = 0; index < 16; index += 1) {
      expect(
        Math.abs((recomposed[index] as number) - (world[index] as number)),
      ).toBeLessThan(1e-9);
    }
  });
});

describe("quaternion composition utilities", () => {
  it("multiplies quaternions and composes rotations in order", () => {
    // 90 deg around Z then 90 deg around X equals 120 deg around
    // (1,-1,1)/sqrt3 (Rx(90)*Rz(90) fixes that axis).
    const qz = [0, 0, HALF, HALF] as const;
    const qx = [HALF, 0, 0, HALF] as const;
    const composed = quaternionMultiply(qx, qz);
    const axis = [
      1 / Math.sqrt(3),
      -1 / Math.sqrt(3),
      1 / Math.sqrt(3),
    ] as const;
    const expected = quaternionFromAxisAngle(axis, (2 * Math.PI) / 3);
    expect(composed[0]).toBeCloseTo(expected[0], 9);
    expect(composed[1]).toBeCloseTo(expected[1], 9);
    expect(composed[2]).toBeCloseTo(expected[2], 9);
    expect(composed[3]).toBeCloseTo(expected[3], 9);
  });

  it("conjugates a unit quaternion to its inverse rotation", () => {
    const q = quaternionFromAxisAngle([0, 1, 0], Math.PI / 3);
    const identity = quaternionMultiply(q, quaternionConjugate(q));
    expect(identity[0]).toBeCloseTo(0, 9);
    expect(identity[1]).toBeCloseTo(0, 9);
    expect(identity[2]).toBeCloseTo(0, 9);
    expect(identity[3]).toBeCloseTo(1, 9);
  });

  it("builds axis-angle quaternions and normalizes the axis", () => {
    const q = quaternionFromAxisAngle([0, 2, 0], Math.PI);
    expect(q[1]).toBeCloseTo(1, 9);
    expect(q[3]).toBeCloseTo(0, 9);
    expect(isNormalizedQuat(q)).toBe(true);
    expect(() => quaternionFromAxisAngle([0, 0, 0], 1)).toThrow(/axes/u);
  });

  it("rotates vectors like the rotation matrix", () => {
    const q = quaternionFromAxisAngle([0, 0, 1], Math.PI / 2);
    const rotated = rotateVector(q, [1, 0, 0]);
    expect(rotated[0]).toBeCloseTo(0, 9);
    expect(rotated[1]).toBeCloseTo(1, 9);
    expect(rotated[2]).toBeCloseTo(0, 9);
  });

  it("round-trips Euler angles through the quaternion", () => {
    const euler: [number, number, number] = [0.4, -0.7, 1.2];
    const quaternion = eulerXYZToQuaternion(euler);
    const back = quaternionToEulerXYZ(quaternion);
    expect(back[0]).toBeCloseTo(euler[0], 9);
    expect(back[1]).toBeCloseTo(euler[1], 9);
    expect(back[2]).toBeCloseTo(euler[2], 9);
    expect(isNormalizedQuat(quaternion)).toBe(true);
  });

  it("compares transforms exactly", () => {
    const a: Transform = {
      translation: [1, 2, 3],
      pivot: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
    expect(transformsEqual(a, { ...a })).toBe(true);
    expect(transformsEqual(a, { ...a, translation: [1, 2, 4] })).toBe(false);
    expect(transformsEqual(a, { ...a, rotation: [0, 0, 1, 0] })).toBe(false);
    expect(transformsEqual(a, { ...a, scale: [2, 1, 1] })).toBe(false);
  });

  it("extracts the principal Euler branch and handles gimbal lock", () => {
    // Gimbal lock: y = 90 deg folds z into x with z reported as zero.
    const locked = quaternionToEulerXYZ(
      eulerXYZToQuaternion([0.3, Math.PI / 2, 0.7]),
    );
    expect(locked[1]).toBeCloseTo(Math.PI / 2, 9);
    expect(locked[2]).toBeCloseTo(0, 9);
    // The folded x reproduces the same rotation.
    const recomposed = eulerXYZToQuaternion(locked);
    const expected = eulerXYZToQuaternion([0.3, Math.PI / 2, 0.7]);
    for (let index = 0; index < 4; index += 1) {
      expect(
        Math.abs((recomposed[index] as number) - (expected[index] as number)),
      ).toBeLessThan(1e-9);
    }
    // Principal branch: x/z in [-pi, pi], y in [-pi/2, pi/2].
    const q = quaternionFromAxisAngle([0, 1, 0], Math.PI);
    const euler = quaternionToEulerXYZ(q);
    expect(euler[1]).toBeGreaterThanOrEqual(-Math.PI / 2);
    expect(euler[1]).toBeLessThanOrEqual(Math.PI / 2);
  });
});

describe("quaternion slerp", () => {
  it("returns exact endpoints and clamps the blend factor", () => {
    const a = canonicalQuat([0.2, -0.3, 0.4, 0.84]);
    const b = quaternionFromAxisAngle([1, 0, 0], 2.2);
    expect(quaternionSlerp(a, b, 0)).toBe(a);
    expect(quaternionSlerp(a, b, 1)).toBe(b);
    expect(quaternionSlerp(a, b, -1)).toBe(a);
    expect(quaternionSlerp(a, b, 2)).toBe(b);
  });

  it("interpolates halfway between identity and a 90-degree Y turn to 45 degrees", () => {
    const identity: Quat = [0, 0, 0, 1];
    const quarter = quaternionFromAxisAngle([0, 1, 0], Math.PI / 2);
    const half = quaternionSlerp(identity, quarter, 0.5);
    const expected = quaternionFromAxisAngle([0, 1, 0], Math.PI / 4);
    for (let index = 0; index < 4; index += 1) {
      expect(
        Math.abs((half[index] as number) - (expected[index] as number)),
      ).toBeLessThan(1e-9);
    }
    expect(isNormalizedQuat(half)).toBe(true);
    expect(isCanonicalQuat(half)).toBe(true);
  });

  it("travels the shortest arc when the endpoints are far apart", () => {
    // 170 degrees one way; the short way is 10 degrees the other way.
    const a = quaternionFromAxisAngle([0, 1, 0], Math.PI - 0.2);
    const b = quaternionFromAxisAngle([0, 1, 0], -(Math.PI - 0.2));
    const mid = quaternionSlerp(a, b, 0.5);
    // Shortest path: half of the 0.4-radian arc (0.2 radians from a).
    const expected = quaternionFromAxisAngle([0, 1, 0], Math.PI - 0.2 + 0.2);
    for (let index = 0; index < 4; index += 1) {
      expect(
        Math.abs((mid[index] as number) - (expected[index] as number)),
      ).toBeLessThan(1e-9);
    }
  });

  it("handles identical and antipodal endpoints deterministically", () => {
    const q = quaternionFromAxisAngle([0, 0, 1], 1.1);
    expect(quaternionSlerp(q, q, 0.3)).toEqual(q);
    // Antipodal inputs describe the same rotation; the result is a
    // canonical quaternion equal to the rotation itself.
    const negated: Quat = [-q[0], -q[1], -q[2], -q[3]];
    const mid = quaternionSlerp(q, negated, 0.5);
    expect(isNormalizedQuat(mid)).toBe(true);
    expect(quaternionSlerp(q, negated, 0.25)).toEqual(
      quaternionSlerp(q, negated, 0.75),
    );
  });

  it("is symmetric under reversed endpoints at the midpoint", () => {
    const a = quaternionFromAxisAngle([1, 1, 0], 0.8);
    const b = quaternionFromAxisAngle([0, 1, 1], 1.7);
    const forward = quaternionSlerp(a, b, 0.5);
    const backward = quaternionSlerp(b, a, 0.5);
    expect(Math.abs(forward[0] - backward[0])).toBeLessThan(1e-9);
    expect(Math.abs(forward[1] - backward[1])).toBeLessThan(1e-9);
    expect(Math.abs(forward[2] - backward[2])).toBeLessThan(1e-9);
    expect(Math.abs(forward[3] - backward[3])).toBeLessThan(1e-9);
  });

  it("matches golden slerp samples at fixed factors", () => {
    const a: Quat = [0, 0, 0, 1];
    const b = quaternionFromAxisAngle([0, 1, 0], 2);
    // u = 1/3: sin(2/3) / sin(2) * w + ... computed independently here
    // via the closed-form axis-angle equivalent (golden reference).
    const reference = quaternionFromAxisAngle([0, 1, 0], 2 / 3);
    const sample = quaternionSlerp(a, b, 1 / 3);
    for (let index = 0; index < 4; index += 1) {
      expect(
        Math.abs((sample[index] as number) - (reference[index] as number)),
      ).toBeLessThan(1e-12);
    }
  });
});
