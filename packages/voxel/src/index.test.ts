import { describe, expect, it } from "vitest";
import { traceVoxel } from "./index.js";

describe("headless voxel tracer", () => {
  it("maps negative integer coordinates with positive local values", () => {
    expect(traceVoxel([-1, 0, 1], 1)).toEqual({
      chunk: [-1, 0, 0],
      local: [15, 0, 1],
      material: 1,
    });
  });

  it("rejects unbounded public inputs before arithmetic", () => {
    expect(() => traceVoxel([0.5, 0, 0], 1)).toThrow(/bounded integers/u);
    expect(() => traceVoxel([0, 0, 0], 0)).toThrow(/1 through 65535/u);
    expect(() => traceVoxel([Number.POSITIVE_INFINITY, 0, 0], 1)).toThrow(
      /bounded integers/u,
    );
  });
});
