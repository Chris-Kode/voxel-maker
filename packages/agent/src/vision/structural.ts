import type { DocumentStoreRead } from "@voxel-maker/document";
import type { MaterialId, NodeId, VolumeId } from "@voxel-maker/shared";

/**
 * Deterministic structural metrics of a document store (plan S15.9,
 * ticket #40): a compact, bounded summary of occupied voxels, chunks,
 * volumes, nodes, material coverage, and occupied bounds. The
 * refinement evaluation compares these before/after a critique
 * iteration and flags silent regressions; the metrics are pure reads
 * over `DocumentStoreRead` and never mutate state.
 */

/** Local (volume-space) occupied bounds; undefined when nothing is occupied. */
export interface StructuralBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** One structural snapshot of a document store. */
export interface StructuralMetrics {
  readonly revision: number;
  /** Total occupied (non-zero) voxels across every volume. */
  readonly occupiedVoxels: number;
  /** Total allocated non-empty chunks. */
  readonly nonEmptyChunks: number;
  /** Total volumes in the document. */
  readonly volumeCount: number;
  /** Volumes referenced by at least one voxel component. */
  readonly voxelVolumeCount: number;
  /** Total nodes in the document. */
  readonly nodeCount: number;
  /** Nodes carrying at least one voxel component. */
  readonly voxelNodeCount: number;
  /** Distinct materials with at least one occupied voxel. */
  readonly materialCount: number;
  /** Union of occupied volume bounds, in volume-local coordinates. */
  readonly bounds: StructuralBounds | undefined;
}

/** Measures one store deterministically (pure read; no mutation). */
export function measureStructure(store: DocumentStoreRead): StructuralMetrics {
  const document = store.getDocument();
  let occupiedVoxels = 0;
  let nonEmptyChunks = 0;
  let materialCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let hasBounds = false;
  const materials = new Set<MaterialId>();
  const voxelVolumes = new Set<VolumeId>();
  const voxelNodes = new Set<NodeId>();
  for (const key of Object.keys(document.volumes)) {
    const volumeId = key as VolumeId;
    const volume = store.getVolume(volumeId);
    if (volume === undefined) continue;
    occupiedVoxels += volume.occupiedCount();
    nonEmptyChunks += volume.chunkCount();
    const bounds = volume.occupiedBounds();
    if (bounds !== undefined) {
      hasBounds = true;
      minX = Math.min(minX, bounds.min[0]);
      minY = Math.min(minY, bounds.min[1]);
      minZ = Math.min(minZ, bounds.min[2]);
      maxX = Math.max(maxX, bounds.max[0] - 1);
      maxY = Math.max(maxY, bounds.max[1] - 1);
      maxZ = Math.max(maxZ, bounds.max[2] - 1);
    }
    for (const coordinate of volume.chunkCoordinates()) {
      const values = volume.getChunk(coordinate);
      if (values === undefined) continue;
      for (const value of values) {
        if (value !== 0) materials.add(value as MaterialId);
      }
    }
  }
  for (const key of Object.keys(document.nodes)) {
    const nodeId = key as NodeId;
    const node = document.nodes[nodeId];
    if (node === undefined) continue;
    for (const component of node.components) {
      if (component.kind !== "voxel") continue;
      voxelNodes.add(nodeId);
      voxelVolumes.add(component.volumeId);
    }
  }
  materialCount = materials.size;
  return Object.freeze({
    revision: store.revision,
    occupiedVoxels,
    nonEmptyChunks,
    volumeCount: Object.keys(document.volumes).length,
    voxelVolumeCount: voxelVolumes.size,
    nodeCount: Object.keys(document.nodes).length,
    voxelNodeCount: voxelNodes.size,
    materialCount,
    bounds: hasBounds
      ? Object.freeze({
          min: Object.freeze([minX, minY, minZ] as const),
          max: Object.freeze([maxX, maxY, maxZ] as const),
        })
      : undefined,
  });
}

/** Signed delta between two snapshots (after - before). */
export interface StructuralDelta {
  readonly occupiedVoxels: number;
  readonly occupiedFraction: number;
  readonly nonEmptyChunks: number;
  readonly voxelVolumeCount: number;
  readonly voxelNodeCount: number;
  readonly materialCount: number;
  /** Bounds diagonal growth factor (after/before); 1 when either is empty. */
  readonly boundsDiagonalFactor: number;
}

/** Bounds diagonal length of a snapshot (0 when unbounded). */
function diagonal(bounds: StructuralBounds | undefined): number {
  if (bounds === undefined) return 0;
  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  return Math.hypot(dx, dy, dz);
}

/** Computes the deterministic delta between two structural snapshots. */
export function structuralDelta(
  before: StructuralMetrics,
  after: StructuralMetrics,
): StructuralDelta {
  const beforeDiagonal = diagonal(before.bounds);
  const afterDiagonal = diagonal(after.bounds);
  return Object.freeze({
    occupiedVoxels: after.occupiedVoxels - before.occupiedVoxels,
    occupiedFraction:
      before.occupiedVoxels === 0
        ? after.occupiedVoxels === 0
          ? 0
          : Infinity
        : (after.occupiedVoxels - before.occupiedVoxels) /
          before.occupiedVoxels,
    nonEmptyChunks: after.nonEmptyChunks - before.nonEmptyChunks,
    voxelVolumeCount: after.voxelVolumeCount - before.voxelVolumeCount,
    voxelNodeCount: after.voxelNodeCount - before.voxelNodeCount,
    materialCount: after.materialCount - before.materialCount,
    boundsDiagonalFactor:
      beforeDiagonal === 0
        ? afterDiagonal === 0
          ? 1
          : Infinity
        : afterDiagonal / beforeDiagonal,
  });
}
