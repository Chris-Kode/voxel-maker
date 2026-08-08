import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  boxCoordinates,
  cylinderCoordinates,
  sphereCoordinates,
  type ShapeIterationOptions,
} from "./shapes.js";

const UNBOUNDED_CLIP = {
  min: [-1_048_575, -1_048_575, -1_048_575],
  max: [1_048_576, 1_048_576, 1_048_576],
} as const;

const options = (
  overrides: Partial<ShapeIterationOptions> = {},
): ShapeIterationOptions => ({
  clip: UNBOUNDED_CLIP,
  maxCoordinates: 1_000_000,
  ...overrides,
});

const key = (coordinate: readonly number[]): string => coordinate.join(",");

const sorted = (coordinates: readonly (readonly number[])[]): string[] =>
  [...coordinates].map(key).sort();

describe("box voxelization (frozen rule: half-open [min, max))", () => {
  it("voxelizes a unit box as its single point", () => {
    expect(
      boxCoordinates({ min: [0, 0, 0], max: [1, 1, 1] }, options()),
    ).toEqual([[0, 0, 0]]);
  });

  it("voxelizes a 2x2x2 box in deterministic X-fastest order", () => {
    expect(
      boxCoordinates({ min: [0, 0, 0], max: [2, 2, 2] }, options()),
    ).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [0, 0, 1],
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
    ]);
  });

  it("handles negative coordinates and empty regions", () => {
    expect(
      boxCoordinates({ min: [-2, -1, 0], max: [-1, 0, 1] }, options()),
    ).toEqual([[-2, -1, 0]]);
    expect(
      boxCoordinates({ min: [1, 0, 0], max: [1, 1, 1] }, options()),
    ).toEqual([]);
    expect(
      boxCoordinates({ min: [0, 2, 0], max: [1, 1, 1] }, options()),
    ).toEqual([]);
  });

  it("clips to the clip region", () => {
    const clip = { min: [0, 0, 0], max: [1, 1, 1] } as const;
    expect(
      boxCoordinates({ min: [-5, -5, -5], max: [5, 5, 5] }, options({ clip })),
    ).toEqual([[0, 0, 0]]);
    expect(
      boxCoordinates({ min: [2, 2, 2], max: [3, 3, 3] }, options({ clip })),
    ).toEqual([]);
  });

  it("enforces the generated-count limit", () => {
    expect(() =>
      boxCoordinates(
        { min: [0, 0, 0], max: [3, 3, 3] },
        options({ maxCoordinates: 26 }),
      ),
    ).toThrowError(WorkspaceError);
    expect(() =>
      boxCoordinates(
        { min: [0, 0, 0], max: [3, 3, 3] },
        options({ maxCoordinates: 27 }),
      ),
    ).not.toThrow();
  });

  it("fails fast when the iteration domain exceeds the guard", () => {
    const error = (() => {
      try {
        boxCoordinates(
          { min: [0, 0, 0], max: [100, 100, 100] },
          options({ maxCoordinates: 10 }),
        );
        return undefined;
      } catch (caught) {
        return caught as WorkspaceError;
      }
    })();
    expect(error?.family).toBe("limit");
    expect(error?.code).toBe("TOO_MANY_VOXELS");
  });
});

describe("sphere voxelization (frozen rule: solid, squared distance <= r^2)", () => {
  it("voxelizes radius 0 as the center point", () => {
    expect(sphereCoordinates([3, -2, 1], 0, options())).toEqual([[3, -2, 1]]);
  });

  it("voxelizes radius 1 as the 7-point cross", () => {
    expect(sorted(sphereCoordinates([0, 0, 0], 1, options()))).toEqual(
      sorted([
        [0, 0, 0],
        [-1, 0, 0],
        [1, 0, 0],
        [0, -1, 0],
        [0, 1, 0],
        [0, 0, -1],
        [0, 0, 1],
      ]),
    );
  });

  it("voxelizes radius 2 as the 33-point solid sphere", () => {
    const points = sphereCoordinates([0, 0, 0], 2, options());
    expect(points).toHaveLength(33);
    for (const [x, y, z] of points) {
      expect(x * x + y * y + z * z).toBeLessThanOrEqual(4);
    }
    expect(sorted(points)).toContain("1,1,1");
    expect(sorted(points)).not.toContain("2,1,0");
  });

  it("is axis-independent and symmetric around the center", () => {
    const centered = sphereCoordinates([0, 0, 0], 3, options());
    const offset = sphereCoordinates([5, 5, 5], 3, options());
    expect(offset).toHaveLength(centered.length);
    for (const [x, y, z] of offset) {
      expect(
        (x - 5) * (x - 5) + (y - 5) * (y - 5) + (z - 5) * (z - 5),
      ).toBeLessThanOrEqual(9);
    }
  });

  it("clips to the clip region", () => {
    const clip = { min: [0, 0, 0], max: [1, 1, 1] } as const;
    const points = sphereCoordinates([0, 0, 0], 2, options({ clip }));
    expect(points).toEqual([[0, 0, 0]]);
  });

  it("rejects negative and fractional radii", () => {
    expect(() => sphereCoordinates([0, 0, 0], -1, options())).toThrow(
      WorkspaceError,
    );
    expect(() => sphereCoordinates([0, 0, 0], 1.5, options())).toThrow(
      WorkspaceError,
    );
  });
});

describe("cylinder voxelization (frozen rule: axis-aligned solid)", () => {
  it("voxelizes a radius-1 height-2 Y cylinder as 10 points", () => {
    const points = cylinderCoordinates([0, 0, 0], 1, 2, "y", options());
    expect(points).toHaveLength(10);
    expect(sorted(points)).toEqual(
      sorted([
        [0, 0, 0],
        [-1, 0, 0],
        [1, 0, 0],
        [0, 0, -1],
        [0, 0, 1],
        [0, 1, 0],
        [-1, 1, 0],
        [1, 1, 0],
        [0, 1, -1],
        [0, 1, 1],
      ]),
    );
  });

  it("spans the axis half-open [center, center + height)", () => {
    const points = cylinderCoordinates([0, 0, 0], 0, 3, "y", options());
    expect(sorted(points)).toEqual(
      sorted([
        [0, 0, 0],
        [0, 1, 0],
        [0, 2, 0],
      ]),
    );
    expect(cylinderCoordinates([0, 0, 0], 0, 0, "y", options())).toEqual([]);
  });

  it("supports every axis with the same radial rule", () => {
    const xAxis = cylinderCoordinates([0, 0, 0], 1, 1, "x", options());
    const yAxis = cylinderCoordinates([0, 0, 0], 1, 1, "y", options());
    const zAxis = cylinderCoordinates([0, 0, 0], 1, 1, "z", options());
    expect(xAxis).toHaveLength(5);
    expect(yAxis).toHaveLength(5);
    expect(zAxis).toHaveLength(5);
    expect(sorted(xAxis)).toEqual(
      sorted([
        [0, 0, 0],
        [0, -1, 0],
        [0, 1, 0],
        [0, 0, -1],
        [0, 0, 1],
      ]),
    );
    expect(sorted(zAxis)).toEqual(
      sorted([
        [0, 0, 0],
        [-1, 0, 0],
        [1, 0, 0],
        [0, -1, 0],
        [0, 1, 0],
      ]),
    );
  });

  it("clips to the clip region and rejects invalid dimensions", () => {
    const clip = { min: [0, 0, 0], max: [1, 1, 1] } as const;
    expect(
      cylinderCoordinates([0, 0, 0], 2, 2, "y", options({ clip })),
    ).toEqual([[0, 0, 0]]);
    expect(() => cylinderCoordinates([0, 0, 0], -1, 1, "y", options())).toThrow(
      WorkspaceError,
    );
    expect(() => cylinderCoordinates([0, 0, 0], 1, -1, "y", options())).toThrow(
      WorkspaceError,
    );
    expect(() =>
      cylinderCoordinates([0, 0, 0], 1, 1, "diagonal" as never, options()),
    ).toThrow(WorkspaceError);
  });
});
