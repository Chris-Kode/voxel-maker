import type { MaterialId } from "@voxel-maker/shared";
import type {
  ChunkMeshGeometry,
  ChunkSampler,
  MeshMaterialGroup,
} from "./types.js";

/**
 * Face-culling mesher (plan S6.5): the correctness baseline that emits one
 * unit cube per occupied voxel, culling every face whose neighbor is also
 * occupied, and sampling across chunk boundaries through the injected halo
 * sampler. Output is fully deterministic: voxels iterate in X-fastest chunk
 * order, faces in a fixed table order, and material groups are contiguous
 * ascending index ranges.
 *
 * Greedy meshing later optimizes behind the same seam (S6.17) and must
 * match this output on golden fixtures.
 */

export const CHUNK_EDGE = 16;
export const CHUNK_VOXEL_COUNT = CHUNK_EDGE ** 3;

/** One outward face of a unit voxel: relative corners + normal. */
interface VoxelFace {
  readonly normal: readonly [number, number, number];
  /** Four corners relative to the voxel minimum, in outward CCW order. */
  readonly corners: readonly (readonly [number, number, number])[];
}

/**
 * Face tables follow the three.js `buildPlane` winding convention so the
 * resulting triangles render with `FrontSide` materials.
 */
const FACES: readonly VoxelFace[] = [
  {
    normal: [1, 0, 0],
    corners: [
      [1, 0, 0],
      [1, 0, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
  },
  {
    normal: [-1, 0, 0],
    corners: [
      [0, 0, 1],
      [0, 0, 0],
      [0, 1, 0],
      [0, 1, 1],
    ],
  },
  {
    normal: [0, 1, 0],
    corners: [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
  },
  {
    normal: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
  },
  {
    normal: [0, 0, 1],
    corners: [
      [1, 0, 1],
      [0, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
    ],
  },
  {
    normal: [0, 0, -1],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
  },
];

/** Quad winding: two triangles sharing the diagonal between corners 1 and 2. */
const QUAD_INDICES: readonly number[] = [0, 1, 2, 2, 1, 3];

/**
 * Builds the face-culled mesh for one 16x16x16 chunk. `sample` answers
 * local coordinates including the halo (outside the chunk it must consult
 * neighboring chunks and return 0 beyond the volume). The returned typed
 * arrays are freshly allocated; the input `values` buffer is never
 * retained or mutated.
 */
export function buildChunkMesh(
  values: Uint16Array,
  sample: ChunkSampler,
): ChunkMeshGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const groups: MeshMaterialGroup[] = [];
  let voxelCount = 0;
  let faceCount = 0;
  let groupMaterial = 0 as MaterialId;
  let groupStart = 0;
  let groupOpen = false;

  for (let localZ = 0; localZ < CHUNK_EDGE; localZ += 1) {
    for (let localY = 0; localY < CHUNK_EDGE; localY += 1) {
      for (let localX = 0; localX < CHUNK_EDGE; localX += 1) {
        const material = values[
          localX + localY * CHUNK_EDGE + localZ * CHUNK_EDGE * CHUNK_EDGE
        ] as MaterialId | undefined;
        if (material === undefined || material === 0) continue;
        voxelCount += 1;

        for (const face of FACES) {
          const neighbor = sample(
            localX + face.normal[0],
            localY + face.normal[1],
            localZ + face.normal[2],
          );
          // Cull only faces shared with the same material: faces between
          // different materials are visible from both sides.
          if (neighbor === material) continue;
          faceCount += 1;

          const base = positions.length / 3;
          for (const corner of face.corners) {
            positions.push(
              localX + corner[0],
              localY + corner[1],
              localZ + corner[2],
            );
            normals.push(face.normal[0], face.normal[1], face.normal[2]);
          }
          for (const index of QUAD_INDICES) {
            indices.push(base + index);
          }

          if (!groupOpen || groupMaterial !== material) {
            if (groupOpen) {
              groups.push({
                materialId: groupMaterial,
                start: groupStart,
                count: indices.length - 6 - groupStart,
              });
            }
            groupMaterial = material;
            groupStart = indices.length - 6;
            groupOpen = true;
          }
        }
      }
    }
  }
  if (groupOpen) {
    groups.push({
      materialId: groupMaterial,
      start: groupStart,
      count: indices.length - groupStart,
    });
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    materialGroups: groups,
    voxelCount,
    faceCount,
  };
}
