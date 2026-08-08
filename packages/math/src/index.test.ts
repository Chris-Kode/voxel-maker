import { describe, expect, it } from "vitest";
import {
  QUATERNION_NORM_EPSILON,
  canonicalIntAabb,
  canonicalNumber,
  canonicalQuat,
  canonicalScale,
  canonicalTransform,
  canonicalVec3,
  canonicalVec3i,
  isCanonicalQuat,
  isNormalizedQuat,
  type Quat,
  type Transform,
} from "./index.js";

const HALF = Math.SQRT1_2; // 0.7071067811865476

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
