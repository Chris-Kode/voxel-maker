import { describe, expect, it } from "vitest";
import type { MaterialId } from "@voxel-maker/shared";
import { buildChunkMesh, CHUNK_VOXEL_COUNT } from "./index.js";

function emptyChunk(): Uint16Array {
  return new Uint16Array(CHUNK_VOXEL_COUNT);
}

/** Sampler over a plain 3D array (x-fastest layout), 0 outside bounds. */
function arraySampler(
  values: Uint16Array,
  edge = 16,
): (x: number, y: number, z: number) => MaterialId {
  return (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= edge || y >= edge || z >= edge) {
      return 0 as MaterialId;
    }
    return values[x + y * edge + z * edge * edge] as MaterialId;
  };
}

describe("face-culling mesher", () => {
  it("emits nothing for an empty chunk", () => {
    const values = emptyChunk();
    const mesh = buildChunkMesh(values, arraySampler(values));
    expect(mesh.positions.length).toBe(0);
    expect(mesh.indices.length).toBe(0);
    expect(mesh.materialGroups).toEqual([]);
    expect(mesh.voxelCount).toBe(0);
    expect(mesh.faceCount).toBe(0);
  });

  it("emits a unit cube for one isolated voxel", () => {
    const values = emptyChunk();
    values[0] = 7;
    const mesh = buildChunkMesh(values, arraySampler(values));
    expect(mesh.voxelCount).toBe(1);
    expect(mesh.faceCount).toBe(6);
    // 6 faces x 4 verts x 3 components; 6 faces x 6 indices.
    expect(mesh.positions.length).toBe(72);
    expect(mesh.indices.length).toBe(36);
    expect(mesh.normals.length).toBe(72);
    expect(mesh.materialGroups).toEqual([
      { materialId: 7, start: 0, count: 36 },
    ]);
  });

  it("culls internal faces between adjacent voxels", () => {
    const values = emptyChunk();
    values[0] = 1; // (0,0,0)
    values[1] = 1; // (1,0,0)
    const mesh = buildChunkMesh(values, arraySampler(values));
    expect(mesh.voxelCount).toBe(2);
    // 12 faces minus the shared +X/-X pair = 10.
    expect(mesh.faceCount).toBe(10);
    expect(mesh.positions.length).toBe(10 * 4 * 3);
    expect(mesh.indices.length).toBe(10 * 6);
  });

  it("keeps faces between different materials visible", () => {
    const values = emptyChunk();
    values[0] = 1; // (0,0,0)
    values[1] = 2; // (1,0,0)
    const mesh = buildChunkMesh(values, arraySampler(values));
    expect(mesh.faceCount).toBe(12);
    expect(mesh.materialGroups).toHaveLength(2);
    const first = mesh.materialGroups[0];
    const second = mesh.materialGroups[1];
    expect(first?.materialId).toBe(1);
    expect(second?.materialId).toBe(2);
    // Groups cover every index exactly once, in order.
    const total =
      (mesh.materialGroups[0]?.count ?? 0) +
      (mesh.materialGroups[1]?.count ?? 0);
    expect(total).toBe(mesh.indices.length);
    expect(first?.start).toBe(0);
    expect(second?.start).toBe(first?.count);
  });

  it("culls faces across the chunk boundary via the halo sampler", () => {
    const values = emptyChunk();
    values[15] = 1; // (15,0,0): +X neighbor lives in the next chunk.
    const neighbor = emptyChunk();
    neighbor[0] = 1; // (16,0,0) in world terms = (0,0,0) of the next chunk.
    const mesh = buildChunkMesh(values, (x, y, z) => {
      if (x === 16 && y === 0 && z === 0) return 1 as MaterialId;
      return arraySampler(values)(x, y, z);
    });
    expect(mesh.faceCount).toBe(5); // +X face culled by the halo.
    void neighbor;
  });

  it("treats the space beyond the volume as empty", () => {
    const values = emptyChunk();
    values[15] = 1;
    const mesh = buildChunkMesh(values, arraySampler(values));
    expect(mesh.faceCount).toBe(6);
  });

  it("is deterministic across identical inputs", () => {
    const values = emptyChunk();
    values[0] = 1;
    values[1] = 2;
    values[256 + 17] = 3; // (1,1,1)
    values[512 + 5] = 4; // (5,0,2)
    const sampler = arraySampler(values);
    const first = buildChunkMesh(values, sampler);
    const second = buildChunkMesh(values, sampler);
    expect(first.positions).toEqual(second.positions);
    expect(first.normals).toEqual(second.normals);
    expect(first.indices).toEqual(second.indices);
    expect(first.materialGroups).toEqual(second.materialGroups);
  });

  it("produces outward normals per face", () => {
    const values = emptyChunk();
    values[0] = 1;
    const mesh = buildChunkMesh(values, arraySampler(values));
    const normals = new Set<string>();
    for (let index = 0; index < mesh.normals.length; index += 3) {
      const x = mesh.normals[index] as number;
      const y = mesh.normals[index + 1] as number;
      const z = mesh.normals[index + 2] as number;
      normals.add(`${String(x)},${String(y)},${String(z)}`);
    }
    expect(normals).toEqual(
      new Set(["1,0,0", "-1,0,0", "0,1,0", "0,-1,0", "0,0,1", "0,0,-1"]),
    );
  });
});
