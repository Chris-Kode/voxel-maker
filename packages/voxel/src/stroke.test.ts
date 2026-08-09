import { describe, expect, it } from "vitest";
import type { Vec3i } from "@voxel-maker/math";
import { WorkspaceError } from "@voxel-maker/shared";
import { segmentCoordinates } from "./index.js";

/**
 * Stroke rasterization tests (plan S7.5, ticket #17): the voxel line used
 * by the pencil/erase tools must be gap-free, endpoint-exact, deterministic,
 * and bounded — including under negative coordinates.
 */

/** Chebyshev distance: every connected pair differs by at most one per axis. */
function chebyshev(a: Vec3i, b: Vec3i): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  );
}

/** Asserts the segment is 26-connected, endpoint-exact, and ordered. */
function expectConnectedSegment(
  points: readonly Vec3i[],
  from: Vec3i,
  to: Vec3i,
): void {
  expect(points[0]).toEqual(from);
  expect(points[points.length - 1]).toEqual(to);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) {
      throw new Error("unreachable");
    }
    expect(chebyshev(previous, current)).toBeLessThanOrEqual(1);
  }
}

describe("segmentCoordinates", () => {
  it("rasterizes axis-aligned segments without gaps", () => {
    expect(segmentCoordinates([0, 0, 0], [4, 0, 0], 100)).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
      [4, 0, 0],
    ]);
    expect(segmentCoordinates([2, 3, 4], [2, 3, 7], 100)).toEqual([
      [2, 3, 4],
      [2, 3, 5],
      [2, 3, 6],
      [2, 3, 7],
    ]);
  });

  it("rasterizes a 3D diagonal as a connected path", () => {
    const points = segmentCoordinates([0, 0, 0], [5, 3, 1], 100);
    expect(points[0]).toEqual([0, 0, 0]);
    expect(points[points.length - 1]).toEqual([5, 3, 1]);
    expect(points).toHaveLength(6);
    expectConnectedSegment(points, [0, 0, 0], [5, 3, 1]);
  });

  it("works exactly under negative coordinates", () => {
    const from: Vec3i = [-3, -2, -1];
    const to: Vec3i = [2, 1, -4];
    const points = segmentCoordinates(from, to, 100);
    expectConnectedSegment(points, from, to);
    expect(points).toHaveLength(Math.max(5, 3, 3) + 1);
  });

  it("returns exactly one voxel for a zero-length segment", () => {
    expect(segmentCoordinates([7, -2, 3], [7, -2, 3], 100)).toEqual([
      [7, -2, 3],
    ]);
  });

  it("covers every integer point of a straight horizontal sweep", () => {
    // Sweep all 2D directions in a small grid: every pair must be connected
    // and both endpoints exact (a randomized property check in miniature).
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const points = segmentCoordinates([0, 0, 0], [dx, dy, 0], 100);
        expectConnectedSegment(points, [0, 0, 0], [dx, dy, 0]);
      }
    }
  });

  it("is deterministic across repeated calls", () => {
    const a = segmentCoordinates([-10, 7, 3], [11, -9, -4], 100);
    const b = segmentCoordinates([-10, 7, 3], [11, -9, -4], 100);
    expect(a).toEqual(b);
  });

  it("rejects segments beyond the caller budget", () => {
    try {
      segmentCoordinates([0, 0, 0], [10, 0, 0], 5);
      throw new Error("expected a limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      const workspaceError = error as WorkspaceError;
      expect(workspaceError.family).toBe("limit");
      expect(workspaceError.code).toBe("TOO_MANY_VOXELS");
    }
  });

  it("accepts a segment that exactly fits the budget", () => {
    expect(segmentCoordinates([0, 0, 0], [4, 0, 0], 5)).toHaveLength(5);
  });
});
