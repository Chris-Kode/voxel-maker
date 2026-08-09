import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  DEFAULT_PREVIEW_SIZE,
  MAX_PREVIEW_DIMENSION,
  MAX_PREVIEW_PIXELS,
  PREVIEW_FRAME_MARGIN,
  PREVIEW_ORTHO_DISTANCE,
  STANDARD_PREVIEW_VIEWS,
  frameStandardView,
  validatePreviewSpec,
  type PreviewSpec,
} from "./preview-protocol.js";

/**
 * Standard preview protocol tests (plan S15.1, ticket #25): the four
 * views use fixed framing, orientation, and bounded requested dimensions.
 * These tests lock the camera math; golden.test.ts locks the pixels.
 */

const BOUNDS = {
  min: [0, 0, 0],
  max: [2, 2, 2],
} as const;

const length = (v: readonly number[]): number =>
  Math.hypot(v[0] as number, v[1] as number, v[2] as number);

describe("STANDARD_PREVIEW_VIEWS", () => {
  it("has the canonical perspective/front/side/top order", () => {
    expect(STANDARD_PREVIEW_VIEWS).toEqual([
      "perspective",
      "front",
      "side",
      "top",
    ]);
  });
});

describe("validatePreviewSpec", () => {
  it("accepts the default size", () => {
    expect(
      validatePreviewSpec({
        view: "front",
        width: DEFAULT_PREVIEW_SIZE,
        height: DEFAULT_PREVIEW_SIZE,
      }),
    ).toEqual({
      view: "front",
      width: DEFAULT_PREVIEW_SIZE,
      height: DEFAULT_PREVIEW_SIZE,
    });
  });

  it("rejects unknown views with a structured error", () => {
    const spec = {
      view: "back",
      width: 16,
      height: 16,
    } as unknown as PreviewSpec;
    let caught: unknown;
    try {
      validatePreviewSpec(spec);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceError);
    const error = caught as WorkspaceError;
    expect(error.family).toBe("validation");
    expect(error.code).toBe("INVALID_PREVIEW_VIEW");
    expect(error.message).toContain("back");
  });

  it("rejects non-integer, zero, negative, and oversized dimensions", () => {
    const base = { view: "front", width: 16, height: 16 } as const;
    expect(() => validatePreviewSpec({ ...base, width: 16.5 })).toThrow(
      /integers/,
    );
    expect(() => validatePreviewSpec({ ...base, height: 0 })).toThrow(
      /positive/,
    );
    expect(() => validatePreviewSpec({ ...base, width: -1 })).toThrow(
      /positive/,
    );
    expect(() =>
      validatePreviewSpec({ ...base, width: MAX_PREVIEW_DIMENSION + 1 }),
    ).toThrow(/limit/);
    expect(() =>
      validatePreviewSpec({ ...base, height: MAX_PREVIEW_DIMENSION + 1 }),
    ).toThrow(/limit/);
    // The pixel budget equals 2048x2048 (16 MiB decoded RGBA), so every
    // in-bounds size is at or below it; the check stays as defense.
    expect(MAX_PREVIEW_PIXELS).toBe(MAX_PREVIEW_DIMENSION ** 2);
  });
});

describe("frameStandardView", () => {
  it("centers the target on the content bounds", () => {
    for (const view of STANDARD_PREVIEW_VIEWS) {
      const framing = frameStandardView(view, BOUNDS, 512, 512);
      expect(framing.target).toEqual([1, 1, 1]);
    }
  });

  it("uses fixed axis-aligned directions and ups for the standard views", () => {
    const front = frameStandardView("front", BOUNDS, 512, 512);
    expect(normalize(sub(front.eye, front.target))).toEqual([0, 0, 1]);
    expect(front.up).toEqual([0, 1, 0]);
    expect(front.projection.kind).toBe("orthographic");
    if (front.projection.kind === "orthographic") {
      expect(typeof front.projection.halfWidth).toBe("number");
      expect(typeof front.projection.halfHeight).toBe("number");
    }

    const side = frameStandardView("side", BOUNDS, 512, 512);
    expect(normalize(sub(side.eye, side.target))).toEqual([1, 0, 0]);
    expect(side.up).toEqual([0, 1, 0]);

    const top = frameStandardView("top", BOUNDS, 512, 512);
    expect(normalize(sub(top.eye, top.target))).toEqual([0, 1, 0]);
    // Viewport convention: looking down, screen-up is -Z so the asset
    // front (+Z) points toward the bottom of the image.
    expect(top.up).toEqual([0, 0, -1]);

    const perspective = frameStandardView("perspective", BOUNDS, 512, 512);
    expect(perspective.up).toEqual([0, 1, 0]);
    expect(perspective.projection.kind).toBe("perspective");
    // The perspective direction matches the viewport's default camera
    // direction (24, 20, 24); floating-point framing keeps it within
    // 1e-9 of the exact normalized direction.
    const direction = normalize(sub(perspective.eye, perspective.target));
    const expected = normalize([24, 20, 24]);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(direction[axis]).toBeCloseTo(expected[axis] as number, 9);
    }
  });

  it("frames the bounding sphere with margin on both axes", () => {
    const radius = length([2, 2, 2]) / 2;
    const framing = frameStandardView("front", BOUNDS, 512, 512);
    if (framing.projection.kind !== "orthographic") throw new Error("ortho");
    const expectedHalf = radius * PREVIEW_FRAME_MARGIN;
    expect(framing.projection.halfHeight).toBeCloseTo(expectedHalf, 10);
    expect(framing.projection.halfWidth).toBeCloseTo(expectedHalf, 10);
  });

  it("widens the framing for portrait images so the sphere still fits", () => {
    const radius = length([2, 2, 2]) / 2;
    const framing = frameStandardView("front", BOUNDS, 256, 512);
    if (framing.projection.kind !== "orthographic") throw new Error("ortho");
    // Aspect 0.5: the sphere's horizontal fit is the binding constraint,
    // so the half-height widens to keep the half-width at radius*margin.
    const expectedHalfWidth = radius * PREVIEW_FRAME_MARGIN;
    expect(framing.projection.halfWidth).toBeCloseTo(expectedHalfWidth, 10);
    expect(framing.projection.halfHeight).toBeCloseTo(
      expectedHalfWidth / 0.5,
      10,
    );
  });

  it("uses a deterministic fallback framing for empty content", () => {
    const framing = frameStandardView("front", undefined, 512, 512);
    expect(framing.target).toEqual([0, 0, 0]);
    expect(framing.contentBounds).toBeUndefined();
    if (framing.projection.kind !== "orthographic") throw new Error("ortho");
    expect(framing.projection.halfHeight).toBeCloseTo(
      8 * PREVIEW_FRAME_MARGIN,
      10,
    );
  });

  it("places orthographic cameras at the fixed distance", () => {
    for (const view of ["front", "side", "top"] as const) {
      const framing = frameStandardView(view, BOUNDS, 512, 512);
      expect(length(sub(framing.eye, framing.target))).toBe(
        PREVIEW_ORTHO_DISTANCE,
      );
    }
  });

  it("computes the perspective distance from the fitted half-height", () => {
    const radius = length([2, 2, 2]) / 2;
    const framing = frameStandardView("perspective", BOUNDS, 512, 512);
    if (framing.projection.kind !== "perspective") throw new Error("persp");
    const halfHeight = radius * PREVIEW_FRAME_MARGIN;
    expect(length(sub(framing.eye, framing.target))).toBeCloseTo(
      halfHeight / Math.tan(framing.projection.fovY / 2),
      10,
    );
  });
});

function normalize(
  v: readonly [number, number, number],
): readonly [number, number, number] {
  const magnitude = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / magnitude, v[1] / magnitude, v[2] / magnitude];
}

function sub(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): readonly [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
