import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import { rotateRegionPlan } from "./regions.js";
import {
  VoxelVolume,
  chunkKey,
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
    "volume:regions:0001" as never,
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

/** Fills a 2x1x2 region with four distinct materials (golden fixture). */
function seedQuad(volume: VoxelVolume): void {
  volume.setVoxels(
    [
      { coordinate: [0, 0, 0], material: 1 as never },
      { coordinate: [1, 0, 0], material: 2 as never },
      { coordinate: [0, 0, 1], material: 3 as never },
      { coordinate: [1, 0, 1], material: 4 as never },
    ],
    capability,
  );
}

/** Fills a 2x1x2 region at negative coordinates with four materials. */
function seedNegativeQuad(volume: VoxelVolume): void {
  volume.setVoxels(
    [
      { coordinate: [-2, -1, -1], material: 1 as never },
      { coordinate: [-1, -1, -1], material: 2 as never },
      { coordinate: [-2, -1, 0], material: 3 as never },
      { coordinate: [-1, -1, 0], material: 4 as never },
    ],
    capability,
  );
}

/** Fills a 2x2x2 cube with eight distinct materials (issue #93 fixture). */
function seedCube(volume: VoxelVolume): void {
  volume.setVoxels(
    [
      { coordinate: [0, 0, 0], material: 1 as never },
      { coordinate: [1, 0, 0], material: 2 as never },
      { coordinate: [0, 1, 0], material: 3 as never },
      { coordinate: [1, 1, 0], material: 4 as never },
      { coordinate: [0, 0, 1], material: 5 as never },
      { coordinate: [1, 0, 1], material: 6 as never },
      { coordinate: [0, 1, 1], material: 7 as never },
      { coordinate: [1, 1, 1], material: 8 as never },
    ],
    capability,
  );
}

describe("VoxelVolume.translateRegion golden fixtures", () => {
  it("translates a region at negative coordinates by a signed delta", () => {
    const volume = createVolume();
    seedNegativeQuad(volume);
    const changeSet = volume.translateRegion(
      { min: [-2, -1, -1], max: [0, 0, 1] },
      [3, 2, -4],
      capability,
    );
    expect(volume.getVoxel([-2, -1, -1])).toBe(0);
    expect(volume.getVoxel([-1, -1, 0])).toBe(0);
    expect(volume.getVoxel([1, 1, -5])).toBe(1);
    expect(volume.getVoxel([1, 1, -4])).toBe(3);
    expect(volume.getVoxel([2, 1, -5])).toBe(2);
    expect(volume.getVoxel([2, 1, -4])).toBe(4);
    expect(volume.occupiedCount()).toBe(4);
    expect(changeSet.volumeId).toBe(volume.volumeId);
  });

  it("moves content into an overlapping destination from the snapshot", () => {
    const volume = createVolume();
    seedQuad(volume);
    // Shift by +1 on X: (0,0,0)->(1,0,0), (1,0,0)->(2,0,0), etc. The voxel
    // that was at (1,0,0) must move to (2,0,0), not be overwritten by the
    // copy of (0,0,0) before it moves.
    volume.translateRegion(
      { min: [0, 0, 0], max: [2, 1, 2] },
      [1, 0, 0],
      capability,
    );
    expect(volume.getVoxel([0, 0, 0])).toBe(0);
    expect(volume.getVoxel([1, 0, 0])).toBe(1);
    expect(volume.getVoxel([2, 0, 0])).toBe(2);
    expect(volume.getVoxel([1, 0, 1])).toBe(3);
    expect(volume.getVoxel([2, 0, 1])).toBe(4);
    expect(volume.occupiedCount()).toBe(4);
  });

  it("rejects a destination outside the volume coordinate domain", () => {
    const volume = createVolume({ maxCoordinate: 4 });
    seedQuad(volume);
    expect(() =>
      volume.translateRegion(
        { min: [0, 0, 0], max: [2, 1, 2] },
        [4, 0, 0],
        capability,
      ),
    ).toThrow(/domain/u);
    expect(volume.getVoxel([0, 0, 0])).toBe(1);
    expect(volume.occupiedCount()).toBe(4);
  });

  it("rejects a source region outside the volume coordinate domain", () => {
    const volume = createVolume({ maxCoordinate: 4 });
    seedQuad(volume);
    expect(() =>
      volume.translateRegion(
        { min: [3, 0, 0], max: [6, 1, 1] },
        [0, 0, 0],
        capability,
      ),
    ).toThrow(/domain/u);
  });

  it("rejects non-integer deltas", () => {
    const volume = createVolume();
    seedQuad(volume);
    expect(() =>
      volume.translateRegion(
        { min: [0, 0, 0], max: [2, 1, 2] },
        [0.5, 0, 0],
        capability,
      ),
    ).toThrow(/integers/u);
  });

  it("accepts a delta beyond the coordinate domain when the destination is valid", () => {
    // A region at the negative extreme can validly move past the origin by
    // more than maxCoordinate; only the destination AABB bounds the result.
    const volume = createVolume({ maxCoordinate: 4 });
    volume.setVoxel([-4, -4, -4], 1, capability);
    volume.translateRegion(
      { min: [-4, -4, -4], max: [-3, -3, -3] },
      [5, 5, 5],
      capability,
    );
    expect(volume.getVoxel([-4, -4, -4])).toBe(0);
    expect(volume.getVoxel([1, 1, 1])).toBe(1);
    expect(volume.occupiedCount()).toBe(1);
  });
});

describe("VoxelVolume.rotateRegion golden fixtures", () => {
  it("rotates a 2x1x2 region 90 degrees about Y with exact material mapping", () => {
    const volume = createVolume();
    seedQuad(volume);
    volume.rotateRegion({ min: [0, 0, 0], max: [2, 1, 2] }, "y", 1, capability);
    expect(volume.getVoxel([0, 0, 0])).toBe(2);
    expect(volume.getVoxel([1, 0, 0])).toBe(4);
    expect(volume.getVoxel([0, 0, 1])).toBe(1);
    expect(volume.getVoxel([1, 0, 1])).toBe(3);
    expect(volume.occupiedCount()).toBe(4);
  });

  it("rotates 180 and 270 degrees about Y with exact material mapping", () => {
    const half = createVolume();
    seedQuad(half);
    half.rotateRegion({ min: [0, 0, 0], max: [2, 1, 2] }, "y", 2, capability);
    expect(half.getVoxel([0, 0, 0])).toBe(4);
    expect(half.getVoxel([1, 0, 0])).toBe(3);
    expect(half.getVoxel([0, 0, 1])).toBe(2);
    expect(half.getVoxel([1, 0, 1])).toBe(1);

    const three = createVolume();
    seedQuad(three);
    three.rotateRegion({ min: [0, 0, 0], max: [2, 1, 2] }, "y", 3, capability);
    expect(three.getVoxel([0, 0, 0])).toBe(3);
    expect(three.getVoxel([1, 0, 0])).toBe(1);
    expect(three.getVoxel([0, 0, 1])).toBe(4);
    expect(three.getVoxel([1, 0, 1])).toBe(2);
  });

  it("rotates 180 degrees about each axis as an axial rotation (issue #93)", () => {
    // A 180-degree rotation about an axis must preserve the axis
    // coordinate; the old quarterTurns===2 branch reflected all three
    // coordinates (a point reflection). Direct 180 must equal two 90s.
    for (const axis of ["x", "y", "z"] as const) {
      const direct = createVolume();
      seedCube(direct);
      direct.rotateRegion(
        { min: [0, 0, 0], max: [2, 2, 2] },
        axis,
        2,
        capability,
      );

      const composed = createVolume();
      seedCube(composed);
      composed.rotateRegion(
        { min: [0, 0, 0], max: [2, 2, 2] },
        axis,
        1,
        capability,
      );
      composed.rotateRegion(
        { min: [0, 0, 0], max: [2, 2, 2] },
        axis,
        1,
        capability,
      );
      expectSameVoxels(snapshot(direct), snapshot(composed));

      // Axial (not point) reflection: rotating about Y keeps every voxel on
      // its y plane, so (0,1,0) lands on (1,1,1) and (0,0,0) on (1,0,1).
      if (axis === "y") {
        expect(direct.getVoxel([1, 1, 1])).toBe(3);
        expect(direct.getVoxel([1, 0, 1])).toBe(1);
      }
    }
  });

  it("rotates about X and Z with exact material mapping", () => {
    const aboutX = createVolume();
    aboutX.setVoxels(
      [
        { coordinate: [0, 0, 0], material: 1 as never },
        { coordinate: [0, 1, 0], material: 2 as never },
        { coordinate: [0, 0, 1], material: 3 as never },
        { coordinate: [0, 1, 1], material: 4 as never },
      ],
      capability,
    );
    aboutX.rotateRegion({ min: [0, 0, 0], max: [1, 2, 2] }, "x", 1, capability);
    expect(aboutX.getVoxel([0, 0, 0])).toBe(3);
    expect(aboutX.getVoxel([0, 1, 0])).toBe(1);
    expect(aboutX.getVoxel([0, 0, 1])).toBe(4);
    expect(aboutX.getVoxel([0, 1, 1])).toBe(2);

    const aboutZ = createVolume();
    aboutZ.setVoxels(
      [
        { coordinate: [0, 0, 0], material: 1 as never },
        { coordinate: [1, 0, 0], material: 2 as never },
        { coordinate: [0, 1, 0], material: 3 as never },
        { coordinate: [1, 1, 0], material: 4 as never },
      ],
      capability,
    );
    aboutZ.rotateRegion({ min: [0, 0, 0], max: [2, 2, 1] }, "z", 1, capability);
    expect(aboutZ.getVoxel([0, 0, 0])).toBe(3);
    expect(aboutZ.getVoxel([1, 0, 0])).toBe(1);
    expect(aboutZ.getVoxel([0, 1, 0])).toBe(4);
    expect(aboutZ.getVoxel([1, 1, 0])).toBe(2);
  });

  it("rotates a region at negative coordinates with frozen origin semantics", () => {
    const volume = createVolume();
    seedNegativeQuad(volume);
    volume.rotateRegion(
      { min: [-2, -1, -1], max: [0, 0, 1] },
      "y",
      1,
      capability,
    );
    expect(volume.getVoxel([-2, -1, -1])).toBe(2);
    expect(volume.getVoxel([-1, -1, -1])).toBe(4);
    expect(volume.getVoxel([-2, -1, 0])).toBe(1);
    expect(volume.getVoxel([-1, -1, 0])).toBe(3);
  });

  it("swaps the destination extents for a non-cubic region", () => {
    const volume = createVolume();
    volume.fillBox({ min: [0, 0, 0], max: [2, 2, 4] }, 1, capability);
    volume.rotateRegion({ min: [0, 0, 0], max: [2, 2, 4] }, "y", 1, capability);
    // Rotated AABB: x in [-1, 3), z in [1, 3); the source box is cleared.
    expect(volume.getVoxel([-1, 0, 1])).toBe(1);
    expect(volume.getVoxel([2, 1, 2])).toBe(1);
    expect(volume.getVoxel([0, 0, 0])).toBe(0);
    expect(volume.getVoxel([1, 1, 3])).toBe(0);
    expect(volume.occupiedCount()).toBe(16);
    expect(volume.occupiedBounds()).toEqual({
      min: [-1, 0, 1],
      max: [3, 2, 3],
    });
  });

  it("rejects regions whose rotation-plane extents have different parities", () => {
    const volume = createVolume();
    seedQuad(volume);
    // 2x1x1 about Y: ex=2 even, ez=1 odd -> half-integer lattice.
    expect(() =>
      volume.rotateRegion(
        { min: [0, 0, 0], max: [2, 1, 1] },
        "y",
        1,
        capability,
      ),
    ).toThrow(WorkspaceError);
    // 2x1x2 about X: ey=1 odd, ez=2 even -> half-integer lattice.
    expect(() =>
      volume.rotateRegion(
        { min: [0, 0, 0], max: [2, 1, 2] },
        "x",
        1,
        capability,
      ),
    ).toThrow(/parity/u);
    expect(volume.occupiedCount()).toBe(4);
    expect(volume.getVoxel([0, 0, 0])).toBe(1);
  });

  it("rejects invalid quarter turns and axes", () => {
    const volume = createVolume();
    seedQuad(volume);
    expect(() =>
      volume.rotateRegion(
        { min: [0, 0, 0], max: [2, 1, 2] },
        "y",
        4 as never,
        capability,
      ),
    ).toThrow(/quarterTurns/u);
    expect(() =>
      volume.rotateRegion(
        { min: [0, 0, 0], max: [2, 1, 2] },
        "diagonal" as never,
        1,
        capability,
      ),
    ).toThrow(/Axis/u);
  });

  it("rejects a rotation whose destination exceeds the domain", () => {
    const volume = createVolume({ maxCoordinate: 3 });
    // Source [2,4)x[0,1)x[0,4) is inside the domain; rotating about Y swaps
    // the X and Z extents, pushing the destination to [1,5)x[0,1)x[1,3).
    volume.fillBox({ min: [2, 0, 0], max: [4, 1, 4] }, 1, capability);
    expect(() =>
      volume.rotateRegion(
        { min: [2, 0, 0], max: [4, 1, 4] },
        "y",
        1,
        capability,
      ),
    ).toThrow(/domain/u);
    expect(volume.occupiedCount()).toBe(8);
  });
});

describe("VoxelVolume.mirrorRegion golden fixtures", () => {
  it("mirrors across each axis plane with exact material mapping", () => {
    const aboutX = createVolume();
    seedQuad(aboutX);
    aboutX.mirrorRegion({ min: [0, 0, 0], max: [2, 1, 2] }, "x", capability);
    expect(aboutX.getVoxel([0, 0, 0])).toBe(2);
    expect(aboutX.getVoxel([1, 0, 0])).toBe(1);
    expect(aboutX.getVoxel([0, 0, 1])).toBe(4);
    expect(aboutX.getVoxel([1, 0, 1])).toBe(3);

    const aboutY = createVolume();
    seedQuad(aboutY);
    aboutY.mirrorRegion({ min: [0, 0, 0], max: [2, 1, 2] }, "y", capability);
    // The y extent is 1, so the center plane leaves every voxel in place.
    expect(aboutY.getVoxel([0, 0, 0])).toBe(1);
    expect(aboutY.getVoxel([1, 0, 0])).toBe(2);
    expect(aboutY.getVoxel([0, 0, 1])).toBe(3);
    expect(aboutY.getVoxel([1, 0, 1])).toBe(4);

    const aboutZ = createVolume();
    seedQuad(aboutZ);
    aboutZ.mirrorRegion({ min: [0, 0, 0], max: [2, 1, 2] }, "z", capability);
    expect(aboutZ.getVoxel([0, 0, 0])).toBe(3);
    expect(aboutZ.getVoxel([1, 0, 0])).toBe(4);
    expect(aboutZ.getVoxel([0, 0, 1])).toBe(1);
    expect(aboutZ.getVoxel([1, 0, 1])).toBe(2);
  });

  it("mirrors a region at negative coordinates with frozen origin semantics", () => {
    const volume = createVolume();
    seedNegativeQuad(volume);
    volume.mirrorRegion({ min: [-2, -1, -1], max: [0, 0, 1] }, "x", capability);
    expect(volume.getVoxel([-2, -1, -1])).toBe(2);
    expect(volume.getVoxel([-1, -1, -1])).toBe(1);
    expect(volume.getVoxel([-2, -1, 0])).toBe(4);
    expect(volume.getVoxel([-1, -1, 0])).toBe(3);
  });

  it("mirrors a single voxel across the region center plane", () => {
    const volume = createVolume();
    volume.setVoxel([0, 0, 0], 1, capability);
    volume.mirrorRegion({ min: [0, 0, 0], max: [2, 1, 1] }, "x", capability);
    expect(volume.getVoxel([0, 0, 0])).toBe(0);
    expect(volume.getVoxel([1, 0, 0])).toBe(1);
    expect(volume.occupiedCount()).toBe(1);
  });
});

describe("VoxelVolume.copyRegion and deleteRegion", () => {
  it("copies a region to a destination anchor without clearing the source", () => {
    const volume = createVolume();
    seedQuad(volume);
    volume.copyRegion(
      { min: [0, 0, 0], max: [2, 1, 2] },
      [5, 2, -3],
      capability,
    );
    expect(volume.getVoxel([0, 0, 0])).toBe(1);
    expect(volume.getVoxel([1, 0, 1])).toBe(4);
    expect(volume.getVoxel([5, 2, -3])).toBe(1);
    expect(volume.getVoxel([6, 2, -3])).toBe(2);
    expect(volume.getVoxel([5, 2, -2])).toBe(3);
    expect(volume.getVoxel([6, 2, -2])).toBe(4);
    expect(volume.occupiedCount()).toBe(8);
  });

  it("snapshots the source before overlapping destination writes", () => {
    const volume = createVolume();
    seedQuad(volume);
    // Copy onto itself shifted by +1 on X: the copy must read the
    // pre-operation state, so (1,0,0) receives material 1 (not 2).
    volume.copyRegion(
      { min: [0, 0, 0], max: [2, 1, 2] },
      [1, 0, 0],
      capability,
    );
    expect(volume.getVoxel([0, 0, 0])).toBe(1);
    expect(volume.getVoxel([1, 0, 0])).toBe(1);
    expect(volume.getVoxel([2, 0, 0])).toBe(2);
    expect(volume.getVoxel([1, 0, 1])).toBe(3);
    expect(volume.getVoxel([2, 0, 1])).toBe(4);
    expect(volume.occupiedCount()).toBe(6);
  });

  it("deletes every occupied voxel in a region and reclaims empty chunks", () => {
    const volume = createVolume();
    seedQuad(volume);
    volume.setVoxel([9, 9, 9], 1, capability);
    const changeSet = volume.deleteRegion(
      { min: [0, 0, 0], max: [2, 1, 2] },
      capability,
    );
    expect(volume.getVoxel([0, 0, 0])).toBe(0);
    expect(volume.getVoxel([1, 0, 1])).toBe(0);
    expect(volume.getVoxel([9, 9, 9])).toBe(1);
    expect(volume.occupiedCount()).toBe(1);
    expect(changeSet.chunks).toHaveLength(1);
  });

  it("rejects a copy whose destination exceeds the domain", () => {
    const volume = createVolume({ maxCoordinate: 4 });
    seedQuad(volume);
    expect(() =>
      volume.copyRegion(
        { min: [0, 0, 0], max: [2, 1, 2] },
        [4, 0, 0],
        capability,
      ),
    ).toThrow(/domain/u);
    expect(volume.occupiedCount()).toBe(4);
  });
});

describe("VoxelVolume region limits", () => {
  it("preflights the per-operation inspected limit before any write", () => {
    const volume = createVolume({ maxCoordinatesPerOperation: 10 });
    seedQuad(volume);
    expect(() =>
      volume.translateRegion(
        { min: [0, 0, 0], max: [4, 4, 4] },
        [1, 0, 0],
        capability,
      ),
    ).toThrow(/per-operation voxel limit/u);
    expect(volume.occupiedCount()).toBe(4);
  });

  it("accepts a translate that frees voxels near the occupied limit", () => {
    const volume = createVolume({ maxOccupiedVoxels: 4 });
    seedQuad(volume);
    // Moving 4 voxels to an empty destination keeps the count at 4; the
    // preflight must not count the destination writes as pure additions.
    volume.translateRegion(
      { min: [0, 0, 0], max: [2, 1, 2] },
      [10, 0, 0],
      capability,
    );
    expect(volume.occupiedCount()).toBe(4);
    expect(volume.getVoxel([10, 0, 0])).toBe(1);
  });

  it("accepts a translate whose result extent stays within the limit", () => {
    const volume = createVolume({ maxExtent: 4 });
    seedQuad(volume);
    // The union of the old and new positions spans 12 voxels, but the
    // result (content moved to [10, 12)) spans only 2; the exact estimate
    // must accept it.
    volume.translateRegion(
      { min: [0, 0, 0], max: [2, 1, 2] },
      [10, 0, 0],
      capability,
    );
    expect(volume.occupiedBounds()).toEqual({
      min: [10, 0, 0],
      max: [12, 1, 2],
    });
  });

  it("rejects a translate whose result extent exceeds the limit", () => {
    const volume = createVolume({ maxExtent: 4 });
    seedQuad(volume);
    volume.setVoxel([3, 0, 0], 1, capability);
    expect(() =>
      volume.translateRegion(
        { min: [0, 0, 0], max: [2, 1, 2] },
        [10, 0, 0],
        capability,
      ),
    ).toThrow(/extent/u);
    expect(volume.occupiedCount()).toBe(5);
  });

  it("accepts a translate that empties chunks near the chunk limit", () => {
    const volume = createVolume({ maxChunks: 2 });
    seedQuad(volume);
    // The four voxels live in one chunk; moving them to a new chunk keeps
    // the chunk count at 1 (the source chunk is reclaimed).
    volume.translateRegion(
      { min: [0, 0, 0], max: [2, 1, 2] },
      [16, 0, 0],
      capability,
    );
    expect(volume.chunkCount()).toBe(1);
    expect(volume.getVoxel([16, 0, 0])).toBe(1);
  });

  it("rejects a translate that would exceed the chunk limit", () => {
    const volume = createVolume({ maxChunks: 2 });
    seedQuad(volume);
    volume.setVoxel([16, 0, 0], 1, capability);
    // A voxel outside the source region keeps the source chunk allocated,
    // so moving the quad to a third chunk would exceed the limit.
    volume.setVoxel([0, 5, 0], 1, capability);
    expect(() =>
      volume.translateRegion(
        { min: [0, 0, 0], max: [2, 1, 2] },
        [32, 0, 0],
        capability,
      ),
    ).toThrow(/chunk limit/u);
    expect(volume.occupiedCount()).toBe(6);
  });

  it("rejects a pathological iteration domain before scanning", () => {
    const volume = createVolume({ maxCoordinatesPerOperation: 100 });
    expect(() =>
      volume.translateRegion(
        { min: [0, 0, 0], max: [100, 100, 100] },
        [1, 0, 0],
        capability,
      ),
    ).toThrow(/iteration domain/u);
  });

  it("bounds moves by the net changed voxels, not the doubled entries", () => {
    // An in-place rotation of 8 voxels changes 8 voxels (each appears once
    // as a clear and once as a write), so it must pass a limit of 10 even
    // though the raw entry list has 16 entries.
    const inPlace = createVolume({ maxCoordinatesPerOperation: 10 });
    inPlace.fillBox({ min: [0, 0, 0], max: [2, 2, 2] }, 1, capability);
    inPlace.rotateRegion(
      { min: [0, 0, 0], max: [2, 2, 2] },
      "y",
      1,
      capability,
    );
    expect(inPlace.occupiedCount()).toBe(8);

    // A disjoint move of 8 voxels changes 16 voxels (8 removed, 8 added),
    // which exceeds the per-operation limit.
    const disjoint = createVolume({ maxCoordinatesPerOperation: 10 });
    disjoint.fillBox({ min: [0, 0, 0], max: [2, 2, 2] }, 1, capability);
    expect(() =>
      disjoint.translateRegion(
        { min: [0, 0, 0], max: [2, 2, 2] },
        [10, 0, 0],
        capability,
      ),
    ).toThrow(/per-operation voxel limit/u);
    expect(disjoint.occupiedCount()).toBe(8);
  });
});

describe("VoxelVolume region property tests (fixed seed)", () => {
  /** Deterministic LCG so failures are reproducible (plan S3.16). */
  const lcg = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  };

  const invert = (
    volume: VoxelVolume,
    changeSet: ReturnType<VoxelVolume["translateRegion"]>,
  ): void => {
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
  };

  it("translate plus its exact inverse restores the volume (100 rounds)", () => {
    const random = lcg(0x5eed_0003);
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
      const region = randomRegion(random, 4);
      const delta: readonly [number, number, number] = [
        Math.floor(random() * 20) - 10,
        Math.floor(random() * 20) - 10,
        Math.floor(random() * 20) - 10,
      ];
      const changeSet = volume.translateRegion(region, delta, capability);
      invert(volume, changeSet);
      expectSameVoxels(snapshot(volume), before);
    }
  });

  it("mirror twice is the identity (50 rounds)", () => {
    const random = lcg(0x5eed_0004);
    for (let round = 0; round < 50; round += 1) {
      const volume = createVolume();
      volume.fillBox(
        { min: [-4, -4, -4], max: [5, 5, 5] },
        1 + Math.floor(random() * 2),
        capability,
      );
      const before = snapshot(volume);
      const region = randomRegion(random, 3);
      const axis = (["x", "y", "z"] as const)[Math.floor(random() * 3)] as
        | "x"
        | "y"
        | "z";
      volume.mirrorRegion(region, axis, capability);
      volume.mirrorRegion(region, axis, capability);
      expectSameVoxels(snapshot(volume), before);
    }
  });

  it("four quarter turns are the identity (50 rounds)", () => {
    const random = lcg(0x5eed_0005);
    for (let round = 0; round < 50; round += 1) {
      const volume = createVolume();
      volume.fillBox(
        { min: [-4, -4, -4], max: [5, 5, 5] },
        1 + Math.floor(random() * 2),
        capability,
      );
      const before = snapshot(volume);
      // Even extents on every axis keep every rotation exact.
      const region = randomRegion(random, 2);
      const axis = (["x", "y", "z"] as const)[Math.floor(random() * 3)] as
        | "x"
        | "y"
        | "z";
      for (let turn = 0; turn < 4; turn += 1) {
        volume.rotateRegion(region, axis, 1, capability);
      }
      expectSameVoxels(snapshot(volume), before);
    }
  });

  it("translate round trip is the identity when non-colliding (50 rounds)", () => {
    const random = lcg(0x5eed_0006);
    for (let round = 0; round < 50; round += 1) {
      const volume = createVolume();
      volume.fillBox(
        { min: [-4, -4, -4], max: [5, 5, 5] },
        1 + Math.floor(random() * 2),
        capability,
      );
      const before = snapshot(volume);
      const region = {
        min: [-4, -4, -4] as const,
        max: [5, 5, 5] as const,
      };
      const delta: readonly [number, number, number] = [
        10 + Math.floor(random() * 5),
        10 + Math.floor(random() * 5),
        10 + Math.floor(random() * 5),
      ];
      volume.translateRegion(region, delta, capability);
      volume.translateRegion(
        {
          min: [
            region.min[0] + delta[0],
            region.min[1] + delta[1],
            region.min[2] + delta[2],
          ],
          max: [
            region.max[0] + delta[0],
            region.max[1] + delta[1],
            region.max[2] + delta[2],
          ],
        },
        [-delta[0], -delta[1], -delta[2]],
        capability,
      );
      expectSameVoxels(snapshot(volume), before);
    }
  });

  it("rotate plus its exact inverse restores the volume (50 rounds)", () => {
    const random = lcg(0x5eed_0007);
    for (let round = 0; round < 50; round += 1) {
      const volume = createVolume();
      volume.fillBox(
        { min: [-4, -4, -4], max: [5, 5, 5] },
        1 + Math.floor(random() * 2),
        capability,
      );
      const before = snapshot(volume);
      const region = randomRegion(random, 2);
      const axis = (["x", "y", "z"] as const)[Math.floor(random() * 3)] as
        | "x"
        | "y"
        | "z";
      const quarterTurns = (1 + Math.floor(random() * 3)) as 1 | 2 | 3;
      const changeSet = volume.rotateRegion(
        region,
        axis,
        quarterTurns,
        capability,
      );
      invert(volume, changeSet);
      expectSameVoxels(snapshot(volume), before);
    }
  });

  it("a direct 180-degree map equals two 90-degree maps for every axis (issue #93, 100 rounds)", () => {
    const random = lcg(0x5eed_0093);
    for (let round = 0; round < 100; round += 1) {
      // Even (2) and parity-valid odd (3) extents: 90-degree rotations are
      // exact whenever the two rotation-plane extents share parity, so both
      // classes must agree with the always-exact 180-degree map.
      const extent = 2 + Math.floor(random() * 2);
      const region = randomRegion(random, extent);
      const axis = (["x", "y", "z"] as const)[Math.floor(random() * 3)] as
        | "x"
        | "y"
        | "z";
      const point: Vec3i = [
        region.min[0] + Math.floor(random() * extent),
        region.min[1] + Math.floor(random() * extent),
        region.min[2] + Math.floor(random() * extent),
      ];
      const direct = rotateRegionPlan(region, axis, 2).map(point);
      const once = rotateRegionPlan(region, axis, 1).map(point);
      const twice = rotateRegionPlan(region, axis, 1).map(once);
      expect(direct).toEqual(twice);
    }
  });
});

describe("rotateRegionPlan 180-degree axial rotation (issue #93)", () => {
  it("preserves the rotation axis coordinate (issue #93 evidence)", () => {
    // Issue #93 evidence: region [10,20,30)..[12,24,36), point [10,20,30].
    const region: IntAabb = { min: [10, 20, 30], max: [12, 24, 36] };
    const point: Vec3i = [10, 20, 30];
    expect(rotateRegionPlan(region, "x", 2).map(point)).toEqual([10, 23, 35]);
    expect(rotateRegionPlan(region, "y", 2).map(point)).toEqual([11, 20, 35]);
    expect(rotateRegionPlan(region, "z", 2).map(point)).toEqual([11, 23, 30]);
  });
});

/** Random half-open region with the given per-axis extent (plan S3.16). */
function randomRegion(
  random: () => number,
  extent: number,
): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
} {
  const min: [number, number, number] = [
    Math.floor(random() * 20) - 10,
    Math.floor(random() * 20) - 10,
    Math.floor(random() * 20) - 10,
  ];
  return {
    min,
    max: [min[0] + extent, min[1] + extent, min[2] + extent],
  };
}

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
