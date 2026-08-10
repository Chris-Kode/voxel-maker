import type { Vec3i } from "@voxel-maker/math";
import type { MaterialId, VolumeId } from "@voxel-maker/shared";
import {
  VoxelVolume,
  type VoxelChunkSeed,
  type VoxelVolumeLimits,
  type VoxelVolumeReadView,
  type VoxelWriteCapability,
} from "@voxel-maker/voxel";

/**
 * Document-associated sparse typed-array volumes (ARCHITECTURE.md
 * "Authoritative state and capabilities"). Volumes are installed only by
 * `DocumentStore.commit` or the validated load path of
 * `createDocumentStore`; public consumers receive read views that never
 * expose mutable backing storage.
 */
export class VoxelRepository {
  readonly #volumes = new Map<VolumeId, VoxelVolume>();
  /** Volume resource limits applied to every volume (ADR-0009). */
  readonly volumeLimits: VoxelVolumeLimits;

  constructor(
    volumeIds: readonly VolumeId[],
    limits: VoxelVolumeLimits,
    writeCapability: VoxelWriteCapability,
    seeds?: ReadonlyMap<VolumeId, readonly VoxelChunkSeed[]>,
  ) {
    this.volumeLimits = limits;
    for (const volumeId of volumeIds) {
      const seeded = seeds?.get(volumeId);
      this.#volumes.set(
        volumeId,
        seeded === undefined
          ? new VoxelVolume(volumeId, limits, writeCapability)
          : VoxelVolume.fromChunks(volumeId, limits, writeCapability, seeded),
      );
    }
  }

  getVolume(volumeId: VolumeId): VoxelVolumeReadView | undefined {
    return this.#volumes.get(volumeId);
  }

  /**
   * In-session mutation revision of a committed chunk (issue #86): the
   * commit-time referential check compares staged revisions against these
   * to scan only chunks that changed during staging.
   */
  chunkRevision(volumeId: VolumeId, coordinate: Vec3i): number | undefined {
    return this.#volumes.get(volumeId)?.chunkRevision(coordinate);
  }

  /** Material at a voxel coordinate; 0 when empty or the volume is missing. */
  getVoxel(volumeId: VolumeId, coordinate: Vec3i): MaterialId {
    return (
      this.#volumes.get(volumeId)?.getVoxel(coordinate) ?? (0 as MaterialId)
    );
  }

  /** Deep copy of a volume for transaction staging; only commit installs it. */
  stageVolume(volumeId: VolumeId): VoxelVolume | undefined {
    return this.#volumes.get(volumeId)?.clone();
  }

  /** Installs staged volumes after a successful commit. */
  installVolumes(staged: ReadonlyMap<VolumeId, VoxelVolume>): void {
    for (const [volumeId, volume] of staged) {
      this.#volumes.set(volumeId, volume);
    }
  }

  /** Removes committed volumes after a successful commit (ticket #24). */
  removeVolumes(volumeIds: readonly VolumeId[]): void {
    for (const volumeId of volumeIds) {
      this.#volumes.delete(volumeId);
    }
  }
}
