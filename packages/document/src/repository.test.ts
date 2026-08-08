import { describe, expect, it } from "vitest";
import { volumeId } from "@voxel-maker/shared";
import {
  DEFAULT_VOXEL_VOLUME_LIMITS,
  type VoxelWriteCapability,
} from "@voxel-maker/voxel";
import { VoxelRepository } from "./repository.js";

const VOLUME = volumeId("volume:repo:0001");
const capability: VoxelWriteCapability = { __kind: "VoxelWriteCapability" };

function createRepository(): VoxelRepository {
  return new VoxelRepository([VOLUME], DEFAULT_VOXEL_VOLUME_LIMITS, capability);
}

describe("VoxelRepository", () => {
  it("starts with empty volumes and reads empty voxels", () => {
    const repository = createRepository();
    expect(repository.getVolume(VOLUME)?.chunkCount()).toBe(0);
    expect(repository.getVoxel(VOLUME, [0, 0, 0])).toBe(0);
    expect(
      repository.getVolume(volumeId("volume:missing:0001")),
    ).toBeUndefined();
  });

  it("stages copy-on-write clones that never affect committed state", () => {
    const repository = createRepository();
    const staged = repository.stageVolume(VOLUME);
    expect(staged).toBeDefined();
    staged?.setVoxel([0, 0, 0], 1, capability);
    expect(repository.getVoxel(VOLUME, [0, 0, 0])).toBe(0);
    repository.installVolumes(new Map([[VOLUME, staged as never]]));
    expect(repository.getVoxel(VOLUME, [0, 0, 0])).toBe(1);
  });

  it("returns read views that never expose mutable backing storage", () => {
    const repository = createRepository();
    const staged = repository.stageVolume(VOLUME);
    staged?.setVoxel([0, 0, 0], 1, capability);
    repository.installVolumes(new Map([[VOLUME, staged as never]]));
    const view = repository.getVolume(VOLUME);
    const chunk = view?.getChunk([0, 0, 0]);
    if (chunk !== undefined) chunk[0] = 99;
    expect(repository.getVoxel(VOLUME, [0, 0, 0])).toBe(1);
  });
});
