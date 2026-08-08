import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  CHUNK_EDGE,
  chunkCoordinate,
  chunkIndex,
  chunkKey,
  localCoordinate,
  VoxelVolume,
  type VoxelEntry,
  type VoxelWriteCapability,
} from "./volume.js";

const capability: VoxelWriteCapability = { __kind: "VoxelWriteCapability" };

function createVolume(
  overrides: Partial<{
    maxCoordinate: number;
    maxExtent: number;
    maxChunks: number;
    maxOccupiedVoxels: number;
    maxCoordinatesPerOperation: number;
  }> = {},
): VoxelVolume {
  return new VoxelVolume(
    "volume:test:0001" as never,
    {
      maxCoordinate: 1_048_575,
      maxExtent: 2_048,
      maxChunks: 262_144,
      maxOccupiedVoxels: 1_000_000,
      maxCoordinatesPerOperation: 1_000_000,
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

describe("VoxelVolume.setVoxels", () => {
  it("sets many voxels atomically and returns a compact sorted change set", () => {
    const volume = createVolume();
    const changeSet = volume.setVoxels(
      [
        { coordinate: [1, 0, 0], material: 1 as never },
        { coordinate: [-1, 0, 0], material: 2 as never },
        { coordinate: [0, 1, 0], material: 3 as never },
      ],
      capability,
    );
    expect(volume.getVoxel([1, 0, 0])).toBe(1);
    expect(volume.getVoxel([-1, 0, 0])).toBe(2);
    expect(volume.getVoxel([0, 1, 0])).toBe(3);
    expect(volume.occupiedCount()).toBe(3);
    expect(changeSet.volumeId).toBe(volume.volumeId);
    expect(changeSet.chunks.map((chunk) => chunk.coordinate)).toEqual([
      [-1, 0, 0],
      [0, 0, 0],
    ]);
    const chunkZero = changeSet.chunks.find(
      (chunk) => chunk.coordinate[0] === 0 && chunk.coordinate[1] === 0,
    );
    expect(chunkZero?.patches).toEqual([
      { index: 1, oldValue: 0, newValue: 1 },
      { index: 16, oldValue: 0, newValue: 3 },
    ]);
  });

  it("resolves duplicate coordinates last-write-wins in payload order", () => {
    const volume = createVolume();
    const changeSet = volume.setVoxels(
      [
        { coordinate: [0, 0, 0], material: 1 as never },
        { coordinate: [0, 0, 0], material: 2 as never },
        { coordinate: [0, 0, 0], material: 1 as never },
      ],
      capability,
    );
    expect(volume.getVoxel([0, 0, 0])).toBe(1);
    expect(volume.occupiedCount()).toBe(1);
    expect(changeSet.chunks).toHaveLength(1);
    expect(changeSet.chunks[0]?.patches).toEqual([
      { index: 0, oldValue: 0, newValue: 1 },
    ]);
  });

  it("drops no-op writes and reports overwrites with old values", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    const changeSet = volume.setVoxels(
      [
        { coordinate: [0, 0, 0], material: 1 as never },
        { coordinate: [0, 0, 0], material: 2 as never },
        { coordinate: [5, 5, 5], material: 1 as never },
      ],
      capability,
    );
    expect(changeSet.chunks).toHaveLength(1);
    expect(changeSet.chunks[0]?.patches).toEqual([
      { index: 0, oldValue: 1, newValue: 2 },
      { index: 1365, oldValue: 0, newValue: 1 },
    ]);
    expect(volume.getVoxel([5, 5, 5])).toBe(1);
  });

  it("preflights the per-operation coordinate limit before any write", () => {
    const volume = createVolume({ maxCoordinatesPerOperation: 2 });
    const entries: VoxelEntry[] = [
      { coordinate: [0, 0, 0], material: 1 as never },
      { coordinate: [1, 0, 0], material: 1 as never },
      { coordinate: [2, 0, 0], material: 1 as never },
    ];
    expect(() => volume.setVoxels(entries, capability)).toThrow(
      /per-operation voxel limit/u,
    );
    expect(volume.occupiedCount()).toBe(0);
    expect(volume.chunkCount()).toBe(0);
  });

  it("preflights the occupied-voxel limit and leaves the volume unchanged", () => {
    const volume = createVolume({ maxOccupiedVoxels: 2 });
    volume.setVoxel([0, 0, 0], 1, capability);
    const before = snapshot(volume);
    expect(() =>
      volume.setVoxels(
        [
          { coordinate: [1, 0, 0], material: 1 as never },
          { coordinate: [2, 0, 0], material: 1 as never },
        ],
        capability,
      ),
    ).toThrow(/occupied-voxel limit/u);
    expectSameVoxels(snapshot(volume), before);
    expect(volume.occupiedCount()).toBe(1);
  });

  it("preflights the extent limit before any write", () => {
    const volume = createVolume({ maxExtent: 4 });
    volume.setVoxel([0, 0, 0], 1, capability);
    const before = snapshot(volume);
    expect(() =>
      volume.setVoxels(
        [
          { coordinate: [1, 0, 0], material: 1 as never },
          { coordinate: [4, 0, 0], material: 1 as never },
        ],
        capability,
      ),
    ).toThrow(/extent/u);
    expectSameVoxels(snapshot(volume), before);
  });

  it("preflights the chunk limit before any write", () => {
    const volume = createVolume({ maxChunks: 1 });
    volume.setVoxel([0, 0, 0], 1, capability);
    const before = snapshot(volume);
    expect(() =>
      volume.setVoxels(
        [{ coordinate: [16, 0, 0], material: 1 as never }],
        capability,
      ),
    ).toThrow(/chunk limit/u);
    expectSameVoxels(snapshot(volume), before);
  });

  it("supports exact inversion through applyPatches without snapshots", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    volume.setVoxel([-1, 0, 0], 2, capability);
    const before = snapshot(volume);
    const changeSet = volume.setVoxels(
      [
        { coordinate: [0, 0, 0], material: 3 as never },
        { coordinate: [1, 0, 0], material: 4 as never },
      ],
      capability,
    );
    const removal = volume.removeVoxels([[-1, 0, 0]], capability);
    expect(volume.getVoxel([0, 0, 0])).toBe(3);
    expect(volume.getVoxel([1, 0, 0])).toBe(4);
    expect(volume.getVoxel([-1, 0, 0])).toBe(0);
    for (const change of [changeSet, removal]) {
      volume.applyPatches(
        change.chunks.map((chunk) => ({
          coordinate: chunk.coordinate,
          patches: chunk.patches.map((patch) => ({
            index: patch.index,
            oldValue: patch.oldValue,
          })),
        })),
        capability,
      );
    }
    expectSameVoxels(snapshot(volume), before);
  });

  it("preflights the net occupied count for mixed add/remove patches", () => {
    // A patch list that removes one voxel and adds another keeps the
    // occupied count unchanged, so it must pass at the occupied limit
    // (regression: the preflight used to count additions only).
    const volume = createVolume({ maxOccupiedVoxels: 1 });
    volume.setVoxel([0, 0, 0], 1, capability);
    const changeSet = volume.applyPatches(
      [
        {
          coordinate: [0, 0, 0],
          patches: [{ index: 0, oldValue: 0 }],
        },
        {
          coordinate: [0, 0, 0],
          patches: [{ index: 256, oldValue: 1 }],
        },
      ],
      capability,
    );
    expect(volume.getVoxel([0, 0, 0])).toBe(0);
    expect(volume.getVoxel([0, 0, 1])).toBe(1);
    expect(volume.occupiedCount()).toBe(1);
    expect(changeSet.chunks).toHaveLength(1);
  });
});

describe("VoxelVolume.removeVoxels", () => {
  it("removes many voxels and reclaims empty chunks", () => {
    const volume = createVolume();
    volume.setVoxels(
      [
        { coordinate: [0, 0, 0], material: 1 as never },
        { coordinate: [1, 0, 0], material: 1 as never },
        { coordinate: [16, 0, 0], material: 1 as never },
      ],
      capability,
    );
    const changeSet = volume.removeVoxels(
      [
        [0, 0, 0],
        [1, 0, 0],
        [16, 0, 0],
      ],
      capability,
    );
    expect(volume.occupiedCount()).toBe(0);
    expect(volume.chunkCount()).toBe(0);
    expect(changeSet.chunks).toHaveLength(2);
    expect(changeSet.chunks[0]?.patches).toEqual([
      { index: 0, oldValue: 1, newValue: 0 },
      { index: 1, oldValue: 1, newValue: 0 },
    ]);
  });

  it("ignores already-empty coordinates and duplicate removals", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    const changeSet = volume.removeVoxels(
      [
        [0, 0, 0],
        [0, 0, 0],
        [9, 9, 9],
      ],
      capability,
    );
    expect(changeSet.chunks).toHaveLength(1);
    expect(changeSet.chunks[0]?.patches).toEqual([
      { index: 0, oldValue: 1, newValue: 0 },
    ]);
  });
});

describe("VoxelVolume fills", () => {
  it("fills a box with deterministic voxelization", () => {
    const volume = createVolume();
    const changeSet = volume.fillBox(
      { min: [0, 0, 0], max: [2, 2, 2] },
      1,
      capability,
    );
    expect(volume.occupiedCount()).toBe(8);
    expect(volume.getVoxel([1, 1, 1])).toBe(1);
    expect(volume.getVoxel([2, 0, 0])).toBe(0);
    expect(changeSet.chunks).toHaveLength(1);
    expect(changeSet.chunks[0]?.patches).toHaveLength(8);
  });

  it("fills a sphere with the frozen solid rule", () => {
    const volume = createVolume();
    volume.fillSphere([0, 0, 0], 2, 1, capability);
    expect(volume.occupiedCount()).toBe(33);
    expect(volume.getVoxel([1, 1, 1])).toBe(1);
    expect(volume.getVoxel([2, 1, 0])).toBe(0);
  });

  it("fills a cylinder along each axis", () => {
    const volume = createVolume();
    volume.fillCylinder([0, 0, 0], 1, 2, "y", 1, capability);
    expect(volume.occupiedCount()).toBe(10);
    expect(volume.getVoxel([0, 1, 0])).toBe(1);
    expect(volume.getVoxel([0, 2, 0])).toBe(0);
  });

  it("clips fills to the volume coordinate domain", () => {
    const volume = createVolume({ maxCoordinate: 1 });
    volume.fillBox({ min: [-5, -5, -5], max: [5, 5, 5] }, 1, capability);
    expect(volume.occupiedCount()).toBe(27);
    expect(volume.getVoxel([-1, -1, -1])).toBe(1);
    expect(volume.getVoxel([1, 1, 1])).toBe(1);
  });

  it("clips sphere and cylinder fills with out-of-domain centers", () => {
    const volume = createVolume({ maxCoordinate: 1 });
    volume.fillSphere([2, 0, 0], 1, 1, capability);
    expect(volume.getVoxel([1, 0, 0])).toBe(1);
    expect(volume.getVoxel([0, 0, 0])).toBe(0);
    volume.fillCylinder([0, 1, 0], 0, 4, "y", 2, capability);
    expect(volume.getVoxel([0, 1, 0])).toBe(2);
    expect(volume.occupiedCount()).toBe(2);
  });

  it("rejects non-integer sphere and cylinder centers", () => {
    const volume = createVolume();
    expect(() => volume.fillSphere([0.5, 0, 0], 1, 1, capability)).toThrow(
      /integers/u,
    );
    expect(() =>
      volume.fillCylinder([0, 0.5, 0], 1, 1, "y", 1, capability),
    ).toThrow(/integers/u);
  });

  it("rejects fills that would exceed the occupied limit", () => {
    const volume = createVolume({ maxOccupiedVoxels: 10 });
    const before = snapshot(volume);
    expect(() =>
      volume.fillBox({ min: [0, 0, 0], max: [3, 3, 3] }, 1, capability),
    ).toThrow(/occupied-voxel limit/u);
    expectSameVoxels(snapshot(volume), before);
  });

  it("rejects fills whose iteration domain is pathological", () => {
    const volume = createVolume({ maxCoordinatesPerOperation: 100 });
    expect(() =>
      volume.fillSphere([0, 0, 0], 1_000_000, 1, capability),
    ).toThrow(/iteration domain/u);
    expect(volume.occupiedCount()).toBe(0);
  });
});

describe("VoxelVolume.replaceMaterial", () => {
  it("replaces a source material inside a region only", () => {
    const volume = createVolume();
    volume.fillBox({ min: [0, 0, 0], max: [3, 3, 3] }, 1, capability);
    volume.setVoxel([5, 5, 5], 1, capability);
    const changeSet = volume.replaceMaterial(
      { min: [0, 0, 0], max: [2, 2, 2] },
      1,
      2,
      capability,
    );
    expect(volume.getVoxel([0, 0, 0])).toBe(2);
    expect(volume.getVoxel([2, 2, 2])).toBe(1);
    expect(volume.getVoxel([5, 5, 5])).toBe(1);
    expect(changeSet.chunks[0]?.patches).toHaveLength(8);
  });

  it("emits region-replace patches in canonical index order", () => {
    const volume = createVolume();
    volume.fillBox({ min: [0, 0, 0], max: [3, 3, 3] }, 1, capability);
    const changeSet = volume.replaceMaterial(
      { min: [0, 0, 0], max: [2, 2, 2] },
      1,
      2,
      capability,
    );
    const indexes = (changeSet.chunks[0]?.patches ?? []).map(
      (patch) => patch.index,
    );
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("replaces across the whole volume when no region is given", () => {
    const volume = createVolume();
    volume.fillBox({ min: [0, 0, 0], max: [2, 2, 2] }, 1, capability);
    volume.setVoxel([10, 10, 10], 1, capability);
    volume.replaceMaterial(undefined, 1, 3, capability);
    expect(volume.occupiedCount()).toBe(9);
    expect(volume.getVoxel([0, 0, 0])).toBe(3);
    expect(volume.getVoxel([10, 10, 10])).toBe(3);
  });

  it("paints empty voxels only with an explicit region", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    volume.replaceMaterial(
      { min: [0, 0, 0], max: [2, 2, 2] },
      0,
      2,
      capability,
    );
    expect(volume.getVoxel([0, 0, 0])).toBe(1);
    expect(volume.getVoxel([1, 1, 1])).toBe(2);
    expect(volume.occupiedCount()).toBe(8);
  });

  it("erases a material by replacing it with empty", () => {
    const volume = createVolume();
    volume.fillBox({ min: [0, 0, 0], max: [2, 2, 2] }, 1, capability);
    volume.replaceMaterial(undefined, 1, 0, capability);
    expect(volume.occupiedCount()).toBe(0);
    expect(volume.chunkCount()).toBe(0);
  });

  it("requires a region when the source filter is empty", () => {
    const volume = createVolume();
    expect(() => volume.replaceMaterial(undefined, 0, 1, capability)).toThrow(
      /explicit region/u,
    );
  });

  it("is a no-op when source and target materials match", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    const changeSet = volume.replaceMaterial(undefined, 1, 1, capability);
    expect(changeSet.chunks).toEqual([]);
    expect(volume.occupiedCount()).toBe(1);
  });

  it("supports exact inversion through applyPatches", () => {
    const volume = createVolume();
    volume.fillBox({ min: [0, 0, 0], max: [3, 3, 3] }, 1, capability);
    const before = snapshot(volume);
    const changeSet = volume.replaceMaterial(
      { min: [0, 0, 0], max: [2, 2, 2] },
      1,
      2,
      capability,
    );
    volume.applyPatches(
      changeSet.chunks.map((chunk) => ({
        coordinate: chunk.coordinate,
        patches: chunk.patches.map((patch) => ({
          index: patch.index,
          oldValue: patch.oldValue,
        })),
      })),
      capability,
    );
    expectSameVoxels(snapshot(volume), before);
  });
});

describe("VoxelVolume batch property tests (fixed seed)", () => {
  /** Deterministic LCG so failures are reproducible (plan S3.16). */
  const lcg = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  };

  it("batch writes plus their exact inverse restore the volume (100 rounds)", () => {
    const random = lcg(0x5eed_0001);
    for (let round = 0; round < 100; round += 1) {
      const volume = createVolume();
      const seedCount = 1 + Math.floor(random() * 20);
      const seedEntries: VoxelEntry[] = [];
      for (let i = 0; i < seedCount; i += 1) {
        seedEntries.push({
          coordinate: [
            Math.floor(random() * 40) - 20,
            Math.floor(random() * 40) - 20,
            Math.floor(random() * 40) - 20,
          ],
          material: (1 + Math.floor(random() * 3)) as never,
        });
      }
      volume.setVoxels(seedEntries, capability);
      const before = snapshot(volume);

      const batchCount = 1 + Math.floor(random() * 30);
      const entries: VoxelEntry[] = [];
      for (let i = 0; i < batchCount; i += 1) {
        entries.push({
          coordinate: [
            Math.floor(random() * 40) - 20,
            Math.floor(random() * 40) - 20,
            Math.floor(random() * 40) - 20,
          ],
          material: (1 + Math.floor(random() * 3)) as never,
        });
      }
      const changeSet = volume.setVoxels(entries, capability);
      volume.applyPatches(
        changeSet.chunks.map((chunk) => ({
          coordinate: chunk.coordinate,
          patches: chunk.patches.map((patch) => ({
            index: patch.index,
            oldValue: patch.oldValue,
          })),
        })),
        capability,
      );
      expectSameVoxels(snapshot(volume), before);
    }
  });

  it("replaceMaterial plus its inverse restore the volume (50 rounds)", () => {
    const random = lcg(0x5eed_0002);
    for (let round = 0; round < 50; round += 1) {
      const volume = createVolume();
      volume.fillBox(
        { min: [-4, -4, -4], max: [5, 5, 5] },
        1 + Math.floor(random() * 2),
        capability,
      );
      const before = snapshot(volume);
      const from = 1 + Math.floor(random() * 2);
      const to = 1 + Math.floor(random() * 2);
      const changeSet = volume.replaceMaterial(undefined, from, to, capability);
      volume.applyPatches(
        changeSet.chunks.map((chunk) => ({
          coordinate: chunk.coordinate,
          patches: chunk.patches.map((patch) => ({
            index: patch.index,
            oldValue: patch.oldValue,
          })),
        })),
        capability,
      );
      expectSameVoxels(snapshot(volume), before);
    }
  });
});

/** Byte-identical snapshot of every allocated chunk (plan S3.16). */
function snapshot(volume: VoxelVolume): Map<string, Uint16Array> {
  const result = new Map<string, Uint16Array>();
  for (const coordinate of volume.chunkCoordinates()) {
    const values = volume.getChunk(coordinate);
    if (values !== undefined) {
      result.set(chunkKey(coordinate), values);
    }
  }
  return result;
}

/**
 * Byte-identical chunk comparison. Vitest's `toEqual` on Maps of typed
 * arrays is pathologically slow (seconds per comparison) and times out on
 * CI; joining each chunk to a canonical string is deterministic, linear in
 * the occupied chunk bytes, and fast on every platform.
 */
function expectSameVoxels(
  actual: Map<string, Uint16Array>,
  expected: Map<string, Uint16Array>,
): void {
  expect(actual.size).toBe(expected.size);
  for (const [key, values] of expected) {
    const actualValues = actual.get(key);
    expect(actualValues).toBeDefined();
    if (actualValues === undefined) continue;
    expect(actualValues.join(",")).toBe(values.join(","));
  }
}

/** Asserts that `fn` throws a WorkspaceError with the exact stable code. */
function expectErrorCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`Expected WorkspaceError ${code}, but nothing was thrown`);
  }
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    (thrown as { code: unknown }).code === code
  ) {
    return;
  }
  throw new Error(
    `Expected WorkspaceError ${code}, got ${
      thrown instanceof Error ? thrown.name : typeof thrown
    }`,
  );
}

describe("VoxelVolume.fromChunks", () => {
  const seed = (
    coordinate: readonly [number, number, number],
    values?: Partial<Record<number, number>>,
  ) => {
    const all = new Uint16Array(4096);
    for (const [index, value] of Object.entries(values ?? {})) {
      all[Number(index)] = value as number;
    }
    return { coordinate, values: all };
  };

  it("installs sorted chunks with computed occupancy and bounds", () => {
    const volume = VoxelVolume.fromChunks(
      "volume:test:0001" as never,
      {
        maxCoordinate: 1_048_575,
        maxExtent: 2_048,
        maxChunks: 262_144,
        maxOccupiedVoxels: 1_000_000,
        maxCoordinatesPerOperation: 1_000_000,
      },
      capability,
      [seed([1, 0, 0], { 0: 3, 17: 5 }), seed([-2, 3, 1], { 4095: 7 })],
    );
    expect(volume.chunkCount()).toBe(2);
    expect(volume.chunkCoordinates()).toEqual([
      [-2, 3, 1],
      [1, 0, 0],
    ]);
    expect(volume.occupiedCount()).toBe(3);
    expect(volume.getVoxel([16, 0, 0])).toBe(3);
    expect(volume.getVoxel([17, 1, 0])).toBe(5);
    expect(volume.getVoxel([-17, 63, 31])).toBe(7);
    expect(volume.occupiedBounds()).toEqual({
      min: [-17, 0, 0],
      max: [18, 64, 32],
    });
    // Installed chunks start at in-session revision 0 and copy loader data.
    const before = volume.getChunk([1, 0, 0]);
    expect(before).toBeDefined();
    if (before !== undefined) {
      before[0] = 99;
    }
    expect(volume.getVoxel([16, 0, 0])).toBe(3);
  });

  it("accepts an empty chunk list as an empty volume", () => {
    const volume = VoxelVolume.fromChunks(
      "volume:test:0001" as never,
      {
        maxCoordinate: 1_048_575,
        maxExtent: 2_048,
        maxChunks: 262_144,
        maxOccupiedVoxels: 1_000_000,
        maxCoordinatesPerOperation: 1_000_000,
      },
      capability,
      [],
    );
    expect(volume.chunkCount()).toBe(0);
    expect(volume.occupiedCount()).toBe(0);
    expect(volume.occupiedBounds()).toBeUndefined();
  });

  it("rejects empty and duplicate chunks", () => {
    const limits = {
      maxCoordinate: 1_048_575,
      maxExtent: 2_048,
      maxChunks: 262_144,
      maxOccupiedVoxels: 1_000_000,
      maxCoordinatesPerOperation: 1_000_000,
    };
    expectErrorCode(
      () =>
        VoxelVolume.fromChunks(
          "volume:test:0001" as never,
          limits,
          capability,
          [seed([0, 0, 0], {})],
        ),
      "EMPTY_CHUNK",
    );
    expectErrorCode(
      () =>
        VoxelVolume.fromChunks(
          "volume:test:0001" as never,
          limits,
          capability,
          [seed([0, 0, 0], { 0: 1 }), seed([0, 0, 0], { 1: 1 })],
        ),
      "UNORDERED_CHUNK_TABLE",
    );
    // Inputs are sorted canonically before install, so an unordered input is
    // accepted; strict ordering is enforced on the resulting table.
    const sorted = VoxelVolume.fromChunks(
      "volume:test:0001" as never,
      limits,
      capability,
      [seed([1, 0, 0], { 0: 1 }), seed([0, 0, 0], { 0: 1 })],
    );
    expect(sorted.chunkCoordinates()).toEqual([
      [0, 0, 0],
      [1, 0, 0],
    ]);
  });

  it("rejects wrong-sized values and out-of-domain coordinates", () => {
    const limits = {
      maxCoordinate: 1_048_575,
      maxExtent: 2_048,
      maxChunks: 262_144,
      maxOccupiedVoxels: 1_000_000,
      maxCoordinatesPerOperation: 1_000_000,
    };
    expectErrorCode(
      () =>
        VoxelVolume.fromChunks(
          "volume:test:0001" as never,
          limits,
          capability,
          [{ coordinate: [0, 0, 0], values: new Uint16Array(10) }],
        ),
      "INVALID_CHUNK_LENGTH",
    );
    expectErrorCode(
      () =>
        VoxelVolume.fromChunks(
          "volume:test:0001" as never,
          limits,
          capability,
          [seed([1_048_576, 0, 0], { 0: 1 })],
        ),
      "INVALID_CHUNK_COORDINATE",
    );
  });

  it("enforces chunk, occupied-voxel, and extent limits before install", () => {
    const small = {
      maxCoordinate: 1_048_575,
      maxExtent: 2_048,
      maxChunks: 1,
      maxOccupiedVoxels: 2,
      maxCoordinatesPerOperation: 1_000_000,
    };
    expectErrorCode(
      () =>
        VoxelVolume.fromChunks("volume:test:0001" as never, small, capability, [
          seed([0, 0, 0], { 0: 1 }),
          seed([1, 0, 0], { 0: 1 }),
        ]),
      "TOO_MANY_CHUNKS",
    );
    expectErrorCode(
      () =>
        VoxelVolume.fromChunks("volume:test:0001" as never, small, capability, [
          seed([0, 0, 0], { 0: 1, 1: 1, 2: 1 }),
        ]),
      "TOO_MANY_OCCUPIED_VOXELS",
    );
    const narrow = {
      maxCoordinate: 1_048_575,
      maxExtent: 10,
      maxChunks: 262_144,
      maxOccupiedVoxels: 1_000_000,
      maxCoordinatesPerOperation: 1_000_000,
    };
    expectErrorCode(
      () =>
        VoxelVolume.fromChunks(
          "volume:test:0001" as never,
          narrow,
          capability,
          [seed([0, 0, 0], { 0: 1, 4095: 1 })],
        ),
      "EXTENT_LIMIT_EXCEEDED",
    );
  });
});
