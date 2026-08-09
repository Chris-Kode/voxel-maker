import { WorkspaceError, type MaterialId } from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import { CHUNK_EDGE, type VoxelVolumeReadView } from "@voxel-maker/voxel";
import {
  GLTF_ERROR_CODES,
  type GltfMeshData,
  type GltfMeshMaterialGroup,
} from "./gltf-types.js";

/**
 * Renderer-independent volume mesher for glTF export (plan S16.2, ticket
 * #41): face-culled indexed triangles over a whole Voxel Volume with
 * absolute editor-space coordinates. The face table, winding, and
 * same-material culling rule are copied from the renderer mesher
 * (`packages/renderer/src/mesher.ts`, plan S6.5) so export geometry
 * matches the viewport exactly; this module only depends on the voxel
 * read view, never on three.js or `BufferGeometry`.
 *
 * Output is fully deterministic: chunks iterate in stable X/Y/Z order and
 * voxels in X-fastest order inside each chunk. Positions are in meters
 * (one voxel edge maps to one meter, ADR-0011), so the integers are also
 * the glTF coordinates.
 */

/** One outward face of a unit voxel: normal + corners in outward CCW order. */
interface VoxelFace {
  readonly normal: readonly [number, number, number];
  /** Four corners relative to the voxel minimum, in outward CCW order. */
  readonly corners: readonly (readonly [number, number, number])[];
}

/**
 * Face tables follow the three.js `buildPlane` winding convention (see the
 * renderer mesher) so the triangles are CCW front-facing in the shared
 * right-handed `+Y`-up basis that glTF uses (ADR-0011). Keep in sync with
 * `packages/renderer/src/mesher.ts`.
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

/** True when the point lies outside the volume coordinate domain. */
const outsideDomain = (coordinate: Vec3i, maxCoordinate: number): boolean =>
  Math.abs(coordinate[0]) > maxCoordinate ||
  Math.abs(coordinate[1]) > maxCoordinate ||
  Math.abs(coordinate[2]) > maxCoordinate;

/**
 * Builds the face-culled mesh of one volume in absolute editor
 * coordinates. Returns undefined for an empty volume. `maxFaces` caps the
 * emitted face count (ADR-0009): the mesher counts faces as it emits and
 * throws `GLTF_FACE_LIMIT` at the cap, so a hostile or sparse volume can
 * never allocate unbounded geometry.
 */
export function buildVolumeMesh(
  volume: VoxelVolumeReadView,
  maxFaces: number,
): GltfMeshData | undefined {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const groups: GltfMeshMaterialGroup[] = [];
  let voxelCount = 0;
  let faceCount = 0;
  let groupMaterial = 0 as MaterialId;
  let groupStart = 0;
  let groupOpen = false;
  const maxCoordinate = volume.limits.maxCoordinate;

  // Neighbor sampling beyond the volume coordinate domain is empty space
  // (a voxel at the domain edge has no further neighbor).
  const sample = (x: number, y: number, z: number): MaterialId => {
    const coordinate: Vec3i = [x, y, z];
    if (outsideDomain(coordinate, maxCoordinate)) return 0 as MaterialId;
    return volume.getVoxel(coordinate);
  };

  for (const coordinate of volume.chunkCoordinates()) {
    const chunk = volume.getChunk(coordinate);
    if (chunk === undefined) continue;
    const origin: Vec3i = [
      coordinate[0] * CHUNK_EDGE,
      coordinate[1] * CHUNK_EDGE,
      coordinate[2] * CHUNK_EDGE,
    ];
    for (let localZ = 0; localZ < CHUNK_EDGE; localZ += 1) {
      for (let localY = 0; localY < CHUNK_EDGE; localY += 1) {
        for (let localX = 0; localX < CHUNK_EDGE; localX += 1) {
          const material = chunk[
            localX + localY * CHUNK_EDGE + localZ * CHUNK_EDGE * CHUNK_EDGE
          ] as MaterialId | undefined;
          if (material === undefined || material === 0) continue;
          voxelCount += 1;
          const x = origin[0] + localX;
          const y = origin[1] + localY;
          const z = origin[2] + localZ;

          for (const face of FACES) {
            const neighbor = sample(
              x + face.normal[0],
              y + face.normal[1],
              z + face.normal[2],
            );
            // Cull only faces shared with the same material: faces between
            // different materials are visible from both sides.
            if (neighbor === material) continue;
            faceCount += 1;
            if (faceCount > maxFaces) {
              throw new WorkspaceError({
                family: "limit",
                code: GLTF_ERROR_CODES.faceLimit,
                message:
                  "Volume exceeds the glTF export face limit; the mesh is too large to export",
                context: {
                  volumeId: volume.volumeId,
                  faces: faceCount,
                  limit: maxFaces,
                },
              });
            }

            const base = positions.length / 3;
            for (const corner of face.corners) {
              positions.push(x + corner[0], y + corner[1], z + corner[2]);
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
  }
  if (voxelCount === 0) return undefined;
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
