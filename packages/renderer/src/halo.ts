import type { MaterialId } from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import { CHUNK_EDGE } from "./mesher.js";
import type { ChunkSampler } from "./types.js";

/**
 * Copied immutable chunk-and-halo data (plan S6.4, ticket #23).
 *
 * A meshing worker must never touch authoritative volume storage, so every
 * job carries a COPY of the chunk's 4096 core values plus a COPY of the
 * one-voxel halo around it: the 26 neighbor chunks' boundary data the
 * face-culling mesher samples when deciding whether a face on the chunk
 * surface is visible. The halo is 6 face slices (256 values), 12 edge
 * lines (16 values), and 8 corner voxels: 1,736 values in total.
 *
 * Layout (local coordinates inside the *neighbor* chunk, X-fastest):
 *
 * - `faces` — 6 x 256, ordered -X, +X, -Y, +Y, -Z, +Z. A face slice is the
 *   neighbor's 16x16 plane with the face axis fixed at 15 (negative side)
 *   or 0 (positive side), stored with the two remaining axes in ascending
 *   (x, y, z) order: for the X faces `[y][z]`, for the Y faces `[x][z]`,
 *   for the Z faces `[x][y]`.
 * - `edges` — 12 x 16, ordered X-Y (4), X-Z (4), Y-Z (4); within a pair the
 *   index bits are `(a > 0 ? 1 : 0) + (b > 0 ? 2 : 0)`. An edge line is the
 *   neighbor's 16 voxels along the remaining axis with the two pair axes
 *   fixed at 15 or 0, stored along the remaining axis in ascending order.
 * - `corners` — 8 voxels, index `(x > 0 ? 1 : 0) + (y > 0 ? 2 : 0) +
 *   (z > 0 ? 4 : 0)`, each at the neighbor's fixed corner voxel.
 *
 * The index formulas below are the single source of truth for both the
 * builder and the sampler; `halo.test.ts` proves sampler and direct volume
 * reads agree for every one of the 18^3 local positions on randomized
 * volumes including negative chunk coordinates.
 */

export const HALO_FACE_COUNT = 6;
export const HALO_SLICE_LENGTH = CHUNK_EDGE * CHUNK_EDGE;
export const HALO_EDGE_COUNT = 12;
export const HALO_EDGE_LENGTH = CHUNK_EDGE;
export const HALO_CORNER_COUNT = 8;
export const HALO_VALUE_COUNT =
  HALO_FACE_COUNT * HALO_SLICE_LENGTH +
  HALO_EDGE_COUNT * HALO_EDGE_LENGTH +
  HALO_CORNER_COUNT;

/** Byte stride of one local axis inside a chunk's X-fastest array. */
const STRIDE: readonly [number, number, number] = [
  1,
  CHUNK_EDGE,
  CHUNK_EDGE * CHUNK_EDGE,
];

/** The copied one-voxel halo surrounding one chunk (see module doc). */
export interface ChunkHalo {
  /** 6 x 256 face-slice values, ordered -X, +X, -Y, +Y, -Z, +Z. */
  readonly faces: Uint16Array;
  /** 12 x 16 edge-line values, ordered X-Y, X-Z, Y-Z with direction bits. */
  readonly edges: Uint16Array;
  /** 8 corner voxels indexed by sign bits `(x>0) + 2*(y>0) + 4*(z>0)`. */
  readonly corners: Uint16Array;
}

/** Face slice index for one axis and direction (-1 or +1). */
function faceIndex(axis: number, direction: number): number {
  return axis * 2 + (direction > 0 ? 1 : 0);
}

/**
 * Edge line index for two out-of-range axes (a < b) and directions
 * (-1 or +1 each).
 */
function edgeIndex(
  axisA: number,
  directionA: number,
  axisB: number,
  directionB: number,
): number {
  const group = axisA === 0 ? (axisB === 1 ? 0 : 4) : 8;
  const bits = (directionA > 0 ? 1 : 0) + (directionB > 0 ? 2 : 0);
  return group + bits;
}

/** Corner index for three out-of-range directions (-1 or +1 each). */
function cornerIndex(
  directionX: number,
  directionY: number,
  directionZ: number,
): number {
  return (
    (directionX > 0 ? 1 : 0) +
    (directionY > 0 ? 2 : 0) +
    (directionZ > 0 ? 4 : 0)
  );
}

/**
 * The fixed local coordinate inside the neighbor chunk for one direction.
 * The voxel diagonally/face-adjacent to this chunk sits on the neighbor's
 * FAR side: local 15 for a negative direction (world `chunk*16 - 1`) and
 * local 0 for a positive direction (world `(chunk+1)*16`).
 */
function fixedLocal(direction: number): number {
  return direction < 0 ? CHUNK_EDGE - 1 : 0;
}

/**
 * Copies the one-voxel halo around `coordinate` from the volume's read
 * view into fresh typed arrays. The returned halo shares nothing with the
 * volume, so a worker (or test) may read and transfer it freely; mutating
 * it never affects authoritative state. Missing neighbor chunks read as
 * empty (0).
 */
export function createChunkHalo(
  readView: VoxelVolumeReadView,
  coordinate: Vec3i,
): ChunkHalo {
  const faces = new Uint16Array(HALO_FACE_COUNT * HALO_SLICE_LENGTH);
  const edges = new Uint16Array(HALO_EDGE_COUNT * HALO_EDGE_LENGTH);
  const corners = new Uint16Array(HALO_CORNER_COUNT);
  const [chunkX, chunkY, chunkZ] = coordinate;

  for (let index = 0; index < HALO_FACE_COUNT; index += 1) {
    const axis = index >> 1;
    const direction = index % 2 === 0 ? -1 : 1;
    const offset = neighborOffset(axis, direction);
    const neighbor = readView.getChunk([
      chunkX + offset[0],
      chunkY + offset[1],
      chunkZ + offset[2],
    ]);
    if (neighbor === undefined) continue;
    const otherA = axis === 0 ? 1 : 0;
    const otherB = axis === 2 ? 1 : 2;
    for (let b = 0; b < CHUNK_EDGE; b += 1) {
      for (let a = 0; a < CHUNK_EDGE; a += 1) {
        const neighborIndex =
          fixedLocal(direction) * (STRIDE[axis] ?? 1) +
          a * STRIDE[otherA] +
          b * STRIDE[otherB];
        faces[index * HALO_SLICE_LENGTH + a + b * CHUNK_EDGE] =
          neighbor[neighborIndex] ?? 0;
      }
    }
  }

  for (let index = 0; index < HALO_EDGE_COUNT; index += 1) {
    const group = index >> 2;
    const bits = index % 4;
    const directionA = bits % 2 === 0 ? -1 : 1;
    const directionB = bits < 2 ? -1 : 1;
    // Pair (0,1) on line z, (0,2) on line y, (1,2) on line x.
    const axisA = group === 2 ? 1 : 0;
    const axisB = group === 0 ? 1 : 2;
    const lineAxis = group === 0 ? 2 : group === 1 ? 1 : 0;
    const offset = neighborOffsetForPair(axisA, directionA, axisB, directionB);
    const neighbor = readView.getChunk([
      chunkX + offset[0],
      chunkY + offset[1],
      chunkZ + offset[2],
    ]);
    if (neighbor === undefined) continue;
    for (let line = 0; line < CHUNK_EDGE; line += 1) {
      const neighborIndex =
        fixedLocal(directionA) * STRIDE[axisA] +
        fixedLocal(directionB) * STRIDE[axisB] +
        line * STRIDE[lineAxis];
      edges[index * HALO_EDGE_LENGTH + line] = neighbor[neighborIndex] ?? 0;
    }
  }

  for (let index = 0; index < HALO_CORNER_COUNT; index += 1) {
    const directionX = index % 2 === 0 ? -1 : 1;
    const directionY = index % 4 < 2 ? -1 : 1;
    const directionZ = index < 4 ? -1 : 1;
    const neighbor = readView.getChunk([
      chunkX + directionX,
      chunkY + directionY,
      chunkZ + directionZ,
    ]);
    if (neighbor === undefined) continue;
    const neighborIndex =
      fixedLocal(directionX) +
      fixedLocal(directionY) * CHUNK_EDGE +
      fixedLocal(directionZ) * CHUNK_EDGE * CHUNK_EDGE;
    corners[index] = neighbor[neighborIndex] ?? 0;
  }

  return { faces, edges, corners };
}

/** Neighbor offset of one face (axis + direction). */
function neighborOffset(axis: number, direction: number): Vec3i {
  const offset: [number, number, number] = [0, 0, 0];
  offset[axis] = direction;
  return offset;
}

/** Neighbor offset of one edge pair (axisA/directionA, axisB/directionB). */
function neighborOffsetForPair(
  axisA: number,
  directionA: number,
  axisB: number,
  directionB: number,
): Vec3i {
  const offset: [number, number, number] = [0, 0, 0];
  offset[axisA] = directionA;
  offset[axisB] = directionB;
  return offset;
}

/**
 * Builds a chunk-local material sampler over copied core values plus a
 * copied halo. The returned sampler answers every local position in the
 * mesher's halo range `[-1, 16)` per axis: core positions read `values`,
 * out-of-range positions read the matching face slice, edge line, or
 * corner voxel of `halo`. Positions two or more voxels outside the chunk
 * are outside the contract and read as empty.
 */
export function createHaloSampler(
  values: Uint16Array,
  halo: ChunkHalo,
): ChunkSampler {
  return (localX, localY, localZ) => {
    if (
      localX >= 0 &&
      localX < CHUNK_EDGE &&
      localY >= 0 &&
      localY < CHUNK_EDGE &&
      localZ >= 0 &&
      localZ < CHUNK_EDGE
    ) {
      return values[
        localX + localY * CHUNK_EDGE + localZ * CHUNK_EDGE * CHUNK_EDGE
      ] as MaterialId;
    }
    const directionX = localX < 0 ? -1 : localX >= CHUNK_EDGE ? 1 : 0;
    const directionY = localY < 0 ? -1 : localY >= CHUNK_EDGE ? 1 : 0;
    const directionZ = localZ < 0 ? -1 : localZ >= CHUNK_EDGE ? 1 : 0;
    const outCount =
      (directionX === 0 ? 0 : 1) +
      (directionY === 0 ? 0 : 1) +
      (directionZ === 0 ? 0 : 1);

    if (outCount === 1) {
      if (directionX !== 0) {
        return halo.faces[
          faceIndex(0, directionX) * HALO_SLICE_LENGTH +
            localY +
            localZ * CHUNK_EDGE
        ] as MaterialId;
      }
      if (directionY !== 0) {
        return halo.faces[
          faceIndex(1, directionY) * HALO_SLICE_LENGTH +
            localX +
            localZ * CHUNK_EDGE
        ] as MaterialId;
      }
      return halo.faces[
        faceIndex(2, directionZ) * HALO_SLICE_LENGTH +
          localX +
          localY * CHUNK_EDGE
      ] as MaterialId;
    }

    if (outCount === 2) {
      if (directionX !== 0 && directionY !== 0) {
        return halo.edges[
          edgeIndex(0, directionX, 1, directionY) * HALO_EDGE_LENGTH + localZ
        ] as MaterialId;
      }
      if (directionX !== 0 && directionZ !== 0) {
        return halo.edges[
          edgeIndex(0, directionX, 2, directionZ) * HALO_EDGE_LENGTH + localY
        ] as MaterialId;
      }
      return halo.edges[
        edgeIndex(1, directionY, 2, directionZ) * HALO_EDGE_LENGTH + localX
      ] as MaterialId;
    }

    return halo.corners[
      cornerIndex(directionX, directionY, directionZ)
    ] as MaterialId;
  };
}
