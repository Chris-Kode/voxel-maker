import { describe, expect, it } from "vitest";
import { volumeId } from "@voxel-maker/shared";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";
import { seedReadView } from "./container.js";
import { buildVolumeMesh } from "./gltf-mesh.js";

/**
 * Volume-level face-culled mesher (plan S16.2, ticket #41): deterministic
 * renderer-independent triangles with absolute editor-space coordinates,
 * same-material face culling, ascending material groups, and the
 * per-volume face limit.
 */

const VOLUME = volumeId("volume:gltf:mesh");

/** Builds a read view whose occupied voxels are the given entries. */
function viewWith(
  entries: readonly {
    coordinate: [number, number, number];
    material: number;
  }[],
) {
  const chunks = new Map<string, VoxelChunkSeed>();
  for (const entry of entries) {
    const [x, y, z] = entry.coordinate;
    const cx = Math.floor(x / 16);
    const cy = Math.floor(y / 16);
    const cz = Math.floor(z / 16);
    const key = `${String(cx)},${String(cy)},${String(cz)}`;
    const chunk = chunks.get(key) ?? {
      coordinate: [cx, cy, cz] as [number, number, number],
      values: new Uint16Array(4096),
    };
    const lx = ((x % 16) + 16) % 16;
    const ly = ((y % 16) + 16) % 16;
    const lz = ((z % 16) + 16) % 16;
    chunk.values[lx + 16 * (ly + 16 * lz)] = entry.material;
    chunks.set(key, chunk);
  }
  return seedReadView(VOLUME, [...chunks.values()]);
}

const ALL_FACES = 1_000_000;

describe("buildVolumeMesh", () => {
  it("emits six outward faces for one voxel with exact corners and normals", () => {
    const mesh = buildVolumeMesh(
      viewWith([{ coordinate: [1, 2, 3], material: 1 }]),
      ALL_FACES,
    );
    expect(mesh).toBeDefined();
    if (mesh === undefined) return;
    expect(mesh.voxelCount).toBe(1);
    expect(mesh.faceCount).toBe(6);
    expect(mesh.positions).toHaveLength(72); // 6 faces x 4 corners x 3 axes
    expect(mesh.normals).toHaveLength(72);
    expect(mesh.indices).toHaveLength(36); // 6 faces x 6 indices
    // Every emitted corner is a corner of the unit cube [1,3)x[2,4)x[3,5).
    const corners = new Set<string>();
    for (let i = 0; i < mesh.positions.length; i += 3) {
      corners.add(
        `${String(mesh.positions[i])},${String(mesh.positions[i + 1])},${String(
          mesh.positions[i + 2],
        )}`,
      );
    }
    expect(corners).toEqual(
      new Set([
        "1,2,3",
        "2,2,3",
        "1,3,3",
        "2,3,3",
        "1,2,4",
        "2,2,4",
        "1,3,4",
        "2,3,4",
      ]),
    );
    // Normals are axis-aligned unit vectors and each face is flat.
    const expectedNormals = new Set([
      "1,0,0",
      "-1,0,0",
      "0,1,0",
      "0,-1,0",
      "0,0,1",
      "0,0,-1",
    ]);
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const key = `${String(mesh.normals[i])},${String(
        mesh.normals[i + 1],
      )},${String(mesh.normals[i + 2])}`;
      expect(expectedNormals.has(key)).toBe(true);
    }
    // Indices stay inside the vertex range and one material group covers all.
    for (const index of mesh.indices) {
      expect(index).toBeLessThan(mesh.positions.length / 3);
    }
    expect(mesh.materialGroups).toEqual([
      { materialId: 1, start: 0, count: 36 },
    ]);
  });

  it("culls the shared face between two same-material voxels", () => {
    const mesh = buildVolumeMesh(
      viewWith([
        { coordinate: [0, 0, 0], material: 1 },
        { coordinate: [1, 0, 0], material: 1 },
      ]),
      ALL_FACES,
    );
    expect(mesh?.faceCount).toBe(10); // 12 minus the shared +X/-X pair
    expect(mesh?.positions).toHaveLength(120); // 10 faces x 4 corners x 3 axes
  });

  it("keeps both faces between different materials", () => {
    const mesh = buildVolumeMesh(
      viewWith([
        { coordinate: [0, 0, 0], material: 1 },
        { coordinate: [1, 0, 0], material: 2 },
      ]),
      ALL_FACES,
    );
    expect(mesh?.faceCount).toBe(12);
  });

  it("keeps absolute negative coordinates", () => {
    const mesh = buildVolumeMesh(
      viewWith([{ coordinate: [-3, 2, -5], material: 1 }]),
      ALL_FACES,
    );
    expect(mesh).toBeDefined();
    if (mesh === undefined) return;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      minX = Math.min(minX, mesh.positions[i] as number);
      minY = Math.min(minY, mesh.positions[i + 1] as number);
      minZ = Math.min(minZ, mesh.positions[i + 2] as number);
    }
    expect([minX, minY, minZ]).toEqual([-3, 2, -5]);
  });

  it("emits ascending material groups across materials", () => {
    const mesh = buildVolumeMesh(
      viewWith([
        { coordinate: [0, 0, 0], material: 1 },
        { coordinate: [0, 1, 0], material: 2 },
        { coordinate: [0, 0, 1], material: 1 },
      ]),
      ALL_FACES,
    );
    expect(mesh?.materialGroups.map((group) => group.materialId)).toEqual([
      1, 2, 1,
    ]);
    const groups = mesh?.materialGroups ?? [];
    let total = 0;
    for (const group of groups) {
      expect(group.count % 6).toBe(0);
      total += group.count;
    }
    expect(total).toBe(mesh?.indices.length);
  });

  it("returns undefined for an empty volume", () => {
    expect(buildVolumeMesh(viewWith([]), ALL_FACES)).toBeUndefined();
  });

  it("is deterministic across calls", () => {
    const view = viewWith([
      { coordinate: [1, 2, 3], material: 1 },
      { coordinate: [4, 5, 6], material: 2 },
      { coordinate: [-2, 0, 1], material: 1 },
    ]);
    const first = buildVolumeMesh(view, ALL_FACES);
    const second = buildVolumeMesh(view, ALL_FACES);
    expect(first?.positions).toEqual(second?.positions);
    expect(first?.normals).toEqual(second?.normals);
    expect(first?.indices).toEqual(second?.indices);
  });

  it("throws the structured face-limit error at the cap", () => {
    // A 3x1x1 row of voxels has up to 3*6 faces; cap at 10 faces.
    const view = viewWith([
      { coordinate: [0, 0, 0], material: 1 },
      { coordinate: [1, 0, 0], material: 1 },
      { coordinate: [2, 0, 0], material: 1 },
    ]);
    expectGltfError(
      () => buildVolumeMesh(view, 10),
      "limit",
      "GLTF_FACE_LIMIT",
    );
  });
});

/** Asserts that `fn` throws a WorkspaceError with the exact family/code. */
function expectGltfError(
  fn: () => unknown,
  family: string,
  code: string,
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`Expected ${family}/${code}, but nothing was thrown`);
  }
  const actual =
    typeof thrown === "object" && thrown !== null
      ? (thrown as { family?: unknown; code?: unknown })
      : {};
  if (actual.family === family && actual.code === code) return;
  throw new Error(
    `Expected ${family}/${code}, got ${String(actual.family)}/${String(
      actual.code,
    )}`,
  );
}
