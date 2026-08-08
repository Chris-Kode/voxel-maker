import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  CHUNK_EDGE,
  chunkCoordinate,
  chunkIndex,
  localCoordinate,
  VoxelVolume,
  type VoxelWriteCapability,
} from "./volume.js";

const capability: VoxelWriteCapability = { __kind: "VoxelWriteCapability" };

function createVolume(
  overrides: Partial<{
    maxCoordinate: number;
    maxExtent: number;
    maxChunks: number;
    maxOccupiedVoxels: number;
  }> = {},
): VoxelVolume {
  return new VoxelVolume(
    "volume:test:0001" as never,
    {
      maxCoordinate: 1_048_575,
      maxExtent: 2_048,
      maxChunks: 262_144,
      maxOccupiedVoxels: 1_000_000,
      ...overrides,
    },
    capability,
  );
}

describe("voxel coordinate mapping", () => {
  it("maps signed coordinates with mathematical floor division", () => {
    expect(chunkCoordinate([0, 0, 0])).toEqual([0, 0, 0]);
    expect(localCoordinate([0, 0, 0])).toEqual([0, 0, 0]);
    expect(chunkCoordinate([15, 0, 0])).toEqual([0, 0, 0]);
    expect(chunkCoordinate([16, 0, 0])).toEqual([1, 0, 0]);
    expect(chunkCoordinate([-1, 0, 0])).toEqual([-1, 0, 0]);
    expect(localCoordinate([-1, 0, 0])).toEqual([15, 0, 0]);
    expect(chunkCoordinate([-16, 0, 0])).toEqual([-1, 0, 0]);
    expect(localCoordinate([-16, 0, 0])).toEqual([0, 0, 0]);
    expect(chunkCoordinate([-17, 0, 0])).toEqual([-2, 0, 0]);
    expect(localCoordinate([-17, 0, 0])).toEqual([15, 0, 0]);
  });

  it("indexes X fastest within a chunk", () => {
    expect(chunkIndex([0, 0, 0])).toBe(0);
    expect(chunkIndex([15, 0, 0])).toBe(15);
    expect(chunkIndex([0, 1, 0])).toBe(16);
    expect(chunkIndex([0, 0, 1])).toBe(256);
    expect(chunkIndex([15, 15, 15])).toBe(4095);
  });
});

describe("VoxelVolume lazy allocation and primitives", () => {
  it("reads empty before any chunk is allocated", () => {
    const volume = createVolume();
    expect(volume.getVoxel([0, 0, 0])).toBe(0);
    expect(volume.getVoxel([-1, 0, 1])).toBe(0);
    expect(volume.chunkCount()).toBe(0);
    expect(volume.occupiedCount()).toBe(0);
    expect(volume.occupiedBounds()).toBeUndefined();
  });

  it("allocates a chunk lazily on first set and maps negative boundaries", () => {
    const volume = createVolume();
    const change = volume.setVoxel([-1, 0, 1], 1, capability);
    expect(volume.getVoxel([-1, 0, 1])).toBe(1);
    expect(volume.chunkCount()).toBe(1);
    expect(volume.occupiedCount()).toBe(1);
    expect(change).toEqual({
      coordinate: [-1, 0, 0],
      revision: 1,
      patches: [{ index: chunkIndex([15, 0, 1]), oldValue: 0, newValue: 1 }],
    });
    expect(volume.occupiedBounds()).toEqual({
      min: [-1, 0, 1],
      max: [0, 1, 2],
    });
  });

  it("round-trips values across chunk boundaries", () => {
    const volume = createVolume();
    volume.setVoxel([15, 0, 0], 2, capability);
    volume.setVoxel([16, 0, 0], 3, capability);
    volume.setVoxel([-1, 0, 0], 4, capability);
    expect(volume.getVoxel([15, 0, 0])).toBe(2);
    expect(volume.getVoxel([16, 0, 0])).toBe(3);
    expect(volume.getVoxel([-1, 0, 0])).toBe(4);
    expect(volume.getVoxel([0, 0, 0])).toBe(0);
    expect(volume.chunkCount()).toBe(3);
    expect(volume.occupiedCount()).toBe(3);
  });

  it("overwrites an occupied voxel and reports the old value", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    const change = volume.setVoxel([0, 0, 0], 2, capability);
    expect(volume.getVoxel([0, 0, 0])).toBe(2);
    expect(volume.occupiedCount()).toBe(1);
    expect(change?.patches).toEqual([{ index: 0, oldValue: 1, newValue: 2 }]);
  });

  it("treats setting the same value as a no-op", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    const change = volume.setVoxel([0, 0, 0], 1, capability);
    expect(change).toBeUndefined();
    expect(volume.chunkCount()).toBe(1);
  });

  it("removes a voxel and reclaims the empty chunk canonically", () => {
    const volume = createVolume();
    volume.setVoxel([-1, 0, 1], 1, capability);
    const change = volume.removeVoxel([-1, 0, 1], capability);
    expect(volume.getVoxel([-1, 0, 1])).toBe(0);
    expect(volume.chunkCount()).toBe(0);
    expect(volume.occupiedCount()).toBe(0);
    expect(change).toEqual({
      coordinate: [-1, 0, 0],
      revision: 2,
      patches: [{ index: chunkIndex([15, 0, 1]), oldValue: 1, newValue: 0 }],
    });
  });

  it("treats removing an empty voxel as a no-op", () => {
    const volume = createVolume();
    expect(volume.removeVoxel([0, 0, 0], capability)).toBeUndefined();
    expect(volume.chunkCount()).toBe(0);
  });

  it("keeps a chunk when only part of it is emptied", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    volume.setVoxel([1, 0, 0], 1, capability);
    volume.removeVoxel([0, 0, 0], capability);
    expect(volume.chunkCount()).toBe(1);
    expect(volume.occupiedCount()).toBe(1);
    expect(volume.getVoxel([1, 0, 0])).toBe(1);
  });

  it("increments the chunk revision on each mutation", () => {
    const volume = createVolume();
    const first = volume.setVoxel([0, 0, 0], 1, capability);
    const second = volume.setVoxel([1, 0, 0], 1, capability);
    const third = volume.removeVoxel([0, 0, 0], capability);
    expect(first?.revision).toBe(1);
    expect(second?.revision).toBe(2);
    expect(third?.revision).toBe(3);
  });

  it("rejects unbounded coordinates and invalid materials before mutation", () => {
    const volume = createVolume({ maxCoordinate: 1_048_575 });
    expect(() => volume.setVoxel([1_048_576, 0, 0], 1, capability)).toThrow(
      WorkspaceError,
    );
    expect(() => volume.setVoxel([0.5, 0, 0], 1, capability)).toThrow(
      WorkspaceError,
    );
    expect(() => volume.setVoxel([0, 0, 0], 0, capability)).toThrow(
      /1 through 65535/u,
    );
    expect(() => volume.setVoxel([0, 0, 0], 65_536, capability)).toThrow(
      /1 through 65535/u,
    );
    expect(volume.chunkCount()).toBe(0);
  });

  it("enforces chunk and occupied-voxel limits", () => {
    const chunkLimited = createVolume({ maxChunks: 1, maxOccupiedVoxels: 2 });
    chunkLimited.setVoxel([0, 0, 0], 1, capability);
    expect(() => chunkLimited.setVoxel([16, 0, 0], 1, capability)).toThrow(
      /chunk/u,
    );
    const occupiedLimited = createVolume({
      maxChunks: 2,
      maxOccupiedVoxels: 1,
    });
    occupiedLimited.setVoxel([0, 0, 0], 1, capability);
    expect(() => occupiedLimited.setVoxel([1, 0, 0], 1, capability)).toThrow(
      /occupied/u,
    );
  });

  it("rejects a set past the occupied limit without allocating a chunk", () => {
    const volume = createVolume({ maxChunks: 2, maxOccupiedVoxels: 1 });
    volume.setVoxel([0, 0, 0], 1, capability);
    expect(() => volume.setVoxel([16, 0, 0], 1, capability)).toThrow(
      /occupied/u,
    );
    // The failed set must not leak an empty chunk (regression: the chunk was
    // allocated before the occupied-limit check).
    expect(volume.chunkCount()).toBe(1);
    expect(volume.occupiedCount()).toBe(1);
    expect(volume.occupiedBounds()).toEqual({
      min: [0, 0, 0],
      max: [1, 1, 1],
    });
  });

  it("enforces the occupied extent limit before mutation", () => {
    const volume = createVolume({ maxExtent: 2 });
    volume.setVoxel([0, 0, 0], 1, capability);
    volume.setVoxel([1, 0, 0], 1, capability);
    expect(() => volume.setVoxel([2, 0, 0], 1, capability)).toThrow(/extent/u);
    expect(() => volume.setVoxel([-1, 0, 0], 1, capability)).toThrow(/extent/u);
    expect(volume.occupiedCount()).toBe(2);
    expect(volume.chunkCount()).toBe(1);
    expect(volume.occupiedBounds()).toEqual({
      min: [0, 0, 0],
      max: [2, 1, 1],
    });
  });

  it("applies the ADR-0009 default extent of 2048", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    volume.setVoxel([2047, 0, 0], 1, capability);
    expect(() => volume.setVoxel([2048, 0, 0], 1, capability)).toThrow(
      /extent/u,
    );
    expect(volume.occupiedBounds()).toEqual({
      min: [0, 0, 0],
      max: [2048, 1, 1],
    });
  });

  it("recomputes occupied bounds after boundary removals", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    volume.setVoxel([1, 0, 0], 1, capability);
    volume.setVoxel([2, 0, 0], 1, capability);
    expect(volume.occupiedBounds()).toEqual({
      min: [0, 0, 0],
      max: [3, 1, 1],
    });
    volume.removeVoxel([0, 0, 0], capability);
    expect(volume.occupiedBounds()).toEqual({
      min: [1, 0, 0],
      max: [3, 1, 1],
    });
    volume.removeVoxel([1, 0, 0], capability);
    volume.removeVoxel([2, 0, 0], capability);
    expect(volume.occupiedBounds()).toBeUndefined();
    expect(volume.chunkCount()).toBe(0);
  });

  it("requires the exact write capability for mutation", () => {
    const volume = createVolume();
    const other: VoxelWriteCapability = { __kind: "VoxelWriteCapability" };
    expect(() => volume.setVoxel([0, 0, 0], 1, other)).toThrow(/capability/u);
    expect(() => volume.removeVoxel([0, 0, 0], other)).toThrow(/capability/u);
    expect(volume.chunkCount()).toBe(0);
  });

  it("returns chunk copies that never alias backing storage", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    const chunk = volume.getChunk([0, 0, 0]);
    expect(chunk).toBeInstanceOf(Uint16Array);
    expect(chunk?.[0]).toBe(1);
    if (chunk !== undefined) chunk[0] = 99;
    expect(volume.getVoxel([0, 0, 0])).toBe(1);
    expect(volume.getChunk([9, 9, 9])).toBeUndefined();
  });

  it("clones independently for copy-on-write staging", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    const clone = volume.clone();
    clone.setVoxel([1, 0, 0], 2, capability);
    expect(volume.getVoxel([1, 0, 0])).toBe(0);
    expect(clone.getVoxel([1, 0, 0])).toBe(2);
    expect(clone.getVoxel([0, 0, 0])).toBe(1);
    expect(clone.chunkCount()).toBe(1);
    expect(volume.chunkCount()).toBe(1);
  });

  it("lists chunk coordinates in stable X,Y,Z order", () => {
    const volume = createVolume();
    volume.setVoxel([16, 0, 0], 1, capability);
    volume.setVoxel([-1, 0, 0], 1, capability);
    volume.setVoxel([0, 0, 0], 1, capability);
    expect(volume.chunkCoordinates()).toEqual([
      [-1, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
    ]);
  });
});

describe("VoxelVolume limits contract", () => {
  it("exposes the chunk edge constant", () => {
    expect(CHUNK_EDGE).toBe(16);
  });
});
