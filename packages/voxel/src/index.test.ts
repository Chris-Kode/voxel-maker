import { describe, expect, it } from "vitest";
import {
  CHUNK_EDGE,
  DEFAULT_VOXEL_VOLUME_LIMITS,
  chunkBounds,
  chunkKey,
} from "./index.js";

describe("voxel package public surface", () => {
  it("exposes the frozen chunk edge and ADR-0009 defaults", () => {
    expect(CHUNK_EDGE).toBe(16);
    expect(DEFAULT_VOXEL_VOLUME_LIMITS).toEqual({
      maxCoordinate: 1_048_575,
      maxExtent: 2_048,
      maxChunks: 262_144,
      maxOccupiedVoxels: 1_000_000,
      maxCoordinatesPerOperation: 1_000_000,
    });
  });

  it("formats stable chunk keys for signed coordinates", () => {
    expect(chunkKey([-1, 0, 0])).toBe("-1,0,0");
    expect(chunkKey([16, -16, 1])).toBe("16,-16,1");
  });

  it("computes half-open chunk bounds in voxel space", () => {
    expect(chunkBounds([-1, 0, 0])).toEqual({
      min: [-16, 0, 0],
      max: [0, 16, 16],
    });
    expect(chunkBounds([1, 2, 3])).toEqual({
      min: [16, 32, 48],
      max: [32, 48, 64],
    });
  });
});
