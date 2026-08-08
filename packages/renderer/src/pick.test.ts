import { describe, expect, it } from "vitest";
import {
  documentId,
  materialId,
  nodeId,
  volumeId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import { createDocument } from "@voxel-maker/model";
import type { Transform, Vec3i } from "@voxel-maker/math";
import {
  createDocumentStore,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import {
  chunkCoordinate,
  chunkIndex,
  chunkKey,
  localCoordinate,
  type VoxelChunkSeed,
} from "@voxel-maker/voxel";
import {
  nodeWorldMatrices,
  pickScene,
  worldBoundsForNodes,
  worldContentBounds,
  type PickRay,
} from "./index.js";

/**
 * Picking tests (plan S6.12, ADR-0005, ticket #16). Every assertion uses
 * fixed documents and exact ray geometry; no wall-clock, random, or GPU
 * input is involved. The seam is the pure `pickScene` function over the
 * immutable store read surface.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:pick:root");
const BOX_A = nodeId("node:pick:box-a");
const BOX_B = nodeId("node:pick:box-b");
const VOLUME_A = volumeId("volume:pick:box-a");
const VOLUME_B = volumeId("volume:pick:box-b");

/** Builds chunk seeds covering every voxel in the half-open box. */
function boxSeeds(min: Vec3i, max: Vec3i): VoxelChunkSeed[] {
  const chunks = new Map<string, { coordinate: Vec3i; values: Uint16Array }>();
  for (let z = min[2]; z < max[2]; z += 1) {
    for (let y = min[1]; y < max[1]; y += 1) {
      for (let x = min[0]; x < max[0]; x += 1) {
        const coordinate: Vec3i = [x, y, z];
        const chunk = chunkCoordinate(coordinate);
        const key = chunkKey(chunk);
        let entry = chunks.get(key);
        if (entry === undefined) {
          entry = { coordinate: chunk, values: new Uint16Array(4096) };
          chunks.set(key, entry);
        }
        entry.values[chunkIndex(localCoordinate(coordinate))] = 1;
      }
    }
  }
  return [...chunks.values()].map(({ coordinate, values }) => ({
    coordinate,
    values,
  }));
}

interface NodeSpec {
  readonly nodeId: NodeId;
  readonly name: string;
  readonly parentId: NodeId | null;
  readonly children?: readonly NodeId[];
  readonly transform?: Transform;
  readonly volumeId?: VolumeId;
}

interface DocumentSpec {
  readonly nodes: readonly NodeSpec[];
  readonly volumes: readonly {
    readonly volumeId: VolumeId;
    readonly min: Vec3i;
    readonly max: Vec3i;
  }[];
}

function buildStore(spec: DocumentSpec): DocumentStoreRead {
  const document = createDocument({
    documentId: documentId("document:pick:0001"),
    metadata: { title: "pick fixture" },
    rootNodeId: ROOT,
    nodes: spec.nodes.map((node) => ({
      nodeId: node.nodeId,
      name: node.name,
      parentId: node.parentId,
      children: [...(node.children ?? [])],
      transform: node.transform ?? IDENTITY,
      components:
        node.volumeId === undefined
          ? []
          : [{ kind: "voxel", schemaVersion: 1, volumeId: node.volumeId }],
    })),
    materials: [
      {
        materialId: materialId(1),
        name: "pick",
        color: "#ff8800",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: spec.volumes.map((volume) => ({
      volumeId: volume.volumeId,
      bounds: { min: volume.min, max: volume.max },
    })),
  });
  const { store } = createDocumentStore({
    document,
    volumes: new Map(
      spec.volumes.map((volume) => [
        volume.volumeId,
        boxSeeds(volume.min, volume.max),
      ]),
    ),
  });
  return store;
}

function boxSpec(
  volumeId: VolumeId,
  nodeId: NodeId,
  min: Vec3i,
  max: Vec3i,
  transform?: Transform,
): DocumentSpec {
  return {
    nodes: [
      { nodeId: ROOT, name: "Root", parentId: null, children: [nodeId] },
      {
        nodeId,
        name: "Box",
        parentId: ROOT,
        ...(transform === undefined ? {} : { transform }),
        volumeId,
      },
    ],
    volumes: [{ volumeId, min, max }],
  };
}

const ray = (
  origin: [number, number, number],
  direction: [number, number, number],
): PickRay => ({
  origin,
  direction,
});

describe("pickScene", () => {
  it("returns the nearest voxel, its local face, and world distance", () => {
    const store = buildStore(boxSpec(VOLUME_A, BOX_A, [0, 0, 0], [4, 4, 4]));
    const hit = pickScene(store, ray([2.5, 2.5, 20], [0, 0, -1]));
    expect(hit).toEqual({
      nodeId: BOX_A,
      volumeId: VOLUME_A,
      voxel: [2, 2, 3],
      face: [0, 0, 1],
      distance: 16,
      point: [2.5, 2.5, 4],
    });
  });

  it("picks voxels at negative coordinates", () => {
    const store = buildStore(
      boxSpec(VOLUME_A, BOX_A, [-4, -4, -4], [-1, -1, -1]),
    );
    const hit = pickScene(store, ray([-2.5, -2.5, -20], [0, 0, 1]));
    expect(hit?.voxel).toEqual([-3, -3, -4]);
    expect(hit?.face).toEqual([0, 0, -1]);
    expect(hit?.distance).toBeCloseTo(16, 9);
  });

  it("resolves an exact corner tie at negative coordinates by X, Y, Z", () => {
    // The ray passes exactly through the corner (-2, -2, -1) shared by
    // eight occupied voxels; smallest X, then Y, then Z wins.
    const store = buildStore(
      boxSpec(VOLUME_A, BOX_A, [-4, -4, -4], [-1, -1, -1]),
    );
    const hit = pickScene(store, ray([-2, -2, 20], [0, 0, -1]));
    expect(hit?.voxel).toEqual([-3, -3, -2]);
    expect(hit?.distance).toBeCloseTo(21, 9);
  });

  it("picks through a non-uniformly scaled node", () => {
    const store = buildStore(
      boxSpec(VOLUME_A, BOX_A, [0, 0, 0], [4, 4, 4], {
        translation: [0, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [2, 1, 1],
      }),
    );
    // World x = 5 maps to local x = 2.5 -> voxel x = 2.
    const hit = pickScene(store, ray([5, 1.5, 20], [0, 0, -1]));
    expect(hit?.voxel).toEqual([2, 1, 3]);
    expect(hit?.face).toEqual([0, 0, 1]);
    expect(hit?.point).toEqual([5, 1.5, 4]);
  });

  it("picks through a rotated node with the correct local face", () => {
    // 90 degrees about +Y maps local (x,y,z) to world (z,y,-x); the box
    // occupies world z in [-3, 0] and the entry face is the local -X face.
    const store = buildStore(
      boxSpec(VOLUME_A, BOX_A, [0, 0, 0], [4, 4, 4], {
        translation: [0, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        scale: [1, 1, 1],
      }),
    );
    const hit = pickScene(store, ray([1.5, 1.5, 20], [0, 0, -1]));
    expect(hit?.voxel).toEqual([0, 1, 1]);
    expect(hit?.face).toEqual([-1, 0, 0]);
    expect(hit?.nodeId).toBe(BOX_A);
  });

  it("picks through a pivoted and translated node", () => {
    // Pivot (1,0,0) with a 90-degree Y rotation: local x range [0,3]
    // sweeps world z range [-2, 1] around the pivot line x = 1.
    const store = buildStore(
      boxSpec(VOLUME_A, BOX_A, [0, 0, 0], [4, 4, 4], {
        translation: [0, 0, 0],
        pivot: [1, 0, 0],
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        scale: [1, 1, 1],
      }),
    );
    const hit = pickScene(store, ray([1, 1.5, 20], [0, 0, -1]));
    expect(hit?.voxel).toEqual([0, 1, 0]);
    expect(hit?.face).toEqual([-1, 0, 0]);
  });

  it("resolves an exact face-boundary tie by smallest X voxel", () => {
    // The ray runs exactly along the shared x = 1 face of two voxels.
    const store = buildStore(boxSpec(VOLUME_A, BOX_A, [0, 0, 0], [2, 1, 1]));
    const hit = pickScene(store, ray([1, 0.5, 20], [0, 0, -1]));
    expect(hit?.voxel).toEqual([0, 0, 0]);
    expect(hit?.face).toEqual([0, 0, 1]);
  });

  it("resolves an exact corner tie across chunk borders by X, then Y, then Z", () => {
    // Voxels at (15,0,0) and (16,0,0) straddle the x = 16 chunk boundary;
    // the ray passes exactly through the shared corner x = 16, y = 0.
    const store = buildStore(boxSpec(VOLUME_A, BOX_A, [15, 0, 0], [17, 1, 1]));
    const hit = pickScene(store, ray([16, 0, 20], [0, 0, -1]));
    expect(hit?.voxel).toEqual([15, 0, 0]);
    expect(hit?.face).toEqual([0, 0, 1]);
  });

  it("resolves an exact corner tie by X before Y before Z", () => {
    // Voxels at (0,0,0) and (-1,-1,0) both touch the corner (0,0,1); the
    // ray passes exactly through it, so smallest X wins.
    const store = buildStore({
      nodes: [
        { nodeId: ROOT, name: "Root", parentId: null, children: [BOX_A] },
        { nodeId: BOX_A, name: "Box", parentId: ROOT, volumeId: VOLUME_A },
      ],
      volumes: [{ volumeId: VOLUME_A, min: [-1, -1, 0], max: [1, 1, 1] }],
    });
    const hit = pickScene(store, ray([0, 0, 20], [0, 0, -1]));
    expect(hit?.voxel).toEqual([-1, -1, 0]);
  });

  it("resolves cross-volume ties by local X/Y/Z before node id", () => {
    // Two volumes hit at the same world point and distance; the ADR-0005
    // lexicographic key compares volume-local voxel coordinates first, so
    // the smaller local X wins regardless of the stable IDs.
    const store = buildStore({
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [BOX_A, BOX_B],
        },
        {
          nodeId: BOX_A,
          name: "A",
          parentId: ROOT,
          transform: { ...IDENTITY, translation: [10, 0, 0] },
          volumeId: VOLUME_A,
        },
        {
          nodeId: BOX_B,
          name: "B",
          parentId: ROOT,
          volumeId: VOLUME_B,
        },
      ],
      volumes: [
        { volumeId: VOLUME_A, min: [-10, 0, 0], max: [-9, 1, 1] },
        { volumeId: VOLUME_B, min: [0, 0, 0], max: [1, 1, 1] },
      ],
    });
    // Both voxels occupy the same world cell [0,1) x [0,1) x [0,1).
    const hit = pickScene(store, ray([0.5, 0.5, 20], [0, 0, -1]));
    expect(hit?.nodeId).toBe(BOX_A);
    expect(hit?.voxel).toEqual([-10, 0, 0]);
  });

  it("breaks overlapping-volume ties by stable node and volume id", () => {
    const store = buildStore({
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [BOX_A, BOX_B],
        },
        { nodeId: BOX_A, name: "A", parentId: ROOT, volumeId: VOLUME_A },
        { nodeId: BOX_B, name: "B", parentId: ROOT, volumeId: VOLUME_B },
      ],
      volumes: [
        { volumeId: VOLUME_A, min: [0, 0, 0], max: [1, 1, 1] },
        { volumeId: VOLUME_B, min: [0, 0, 0], max: [1, 1, 1] },
      ],
    });
    const hit = pickScene(store, ray([0.5, 0.5, 20], [0, 0, -1]));
    expect(hit?.nodeId).toBe(BOX_A);
    expect(hit?.volumeId).toBe(VOLUME_A);
  });

  it("returns the closest of two voxels along the ray", () => {
    const store = buildStore(boxSpec(VOLUME_A, BOX_A, [0, 0, 0], [1, 1, 6]));
    const hit = pickScene(store, ray([0.5, 0.5, 20], [0, 0, -1]));
    expect(hit?.voxel).toEqual([0, 0, 5]);
    expect(hit?.distance).toBeCloseTo(14, 9);
  });

  it("misses when the ray does not cross any voxel", () => {
    const store = buildStore(boxSpec(VOLUME_A, BOX_A, [0, 0, 0], [1, 1, 1]));
    expect(pickScene(store, ray([2.5, 0.5, 20], [0, 0, -1]))).toBeUndefined();
  });

  it("misses when every hit is behind the ray origin", () => {
    const store = buildStore(boxSpec(VOLUME_A, BOX_A, [0, 0, 0], [1, 1, 1]));
    expect(pickScene(store, ray([0.5, 0.5, -20], [0, 0, -1]))).toBeUndefined();
  });

  it("honors maxDistance", () => {
    const store = buildStore(boxSpec(VOLUME_A, BOX_A, [0, 0, 0], [1, 1, 1]));
    expect(
      pickScene(store, ray([0.5, 0.5, 20], [0, 0, -1]), {
        maxDistance: 10,
      }),
    ).toBeUndefined();
    const hit = pickScene(store, ray([0.5, 0.5, 20], [0, 0, -1]), {
      maxDistance: 30,
    });
    expect(hit?.voxel).toEqual([0, 0, 0]);
  });

  it("hits with distance zero when the origin is inside a voxel", () => {
    const store = buildStore(boxSpec(VOLUME_A, BOX_A, [0, 0, 0], [1, 1, 1]));
    const hit = pickScene(store, ray([0.5, 0.5, 0.5], [0, 0, -1]));
    expect(hit?.voxel).toEqual([0, 0, 0]);
    expect(hit?.distance).toBe(0);
  });

  it("ignores empty volumes and nodes without voxel components", () => {
    const store = buildStore({
      nodes: [
        { nodeId: ROOT, name: "Root", parentId: null, children: [BOX_A] },
        { nodeId: BOX_A, name: "Empty", parentId: ROOT, volumeId: VOLUME_A },
      ],
      volumes: [{ volumeId: VOLUME_A, min: [0, 0, 0], max: [0, 0, 0] }],
    });
    expect(pickScene(store, ray([0.5, 0.5, 20], [0, 0, -1]))).toBeUndefined();
  });

  it("is deterministic for identical input", () => {
    const store = buildStore(
      boxSpec(VOLUME_A, BOX_A, [-3, 0, 0], [5, 4, 2], {
        translation: [1, 2, 3],
        pivot: [0.5, 0, 0],
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        scale: [1.5, 1, 2],
      }),
    );
    const first = pickScene(store, ray([5, 3.4, 30], [0, 0, -1]));
    const second = pickScene(store, ray([5, 3.4, 30], [0, 0, -1]));
    expect(first).toEqual(second);
    expect(first).toMatchObject({ voxel: [-3, 1, 1], face: [-1, 0, 0] });
    expect(first?.distance).toBeCloseTo(21.75, 9);
  });

  it("computes world content bounds across transformed nodes", () => {
    const store = buildStore(
      boxSpec(VOLUME_A, BOX_A, [0, 0, 0], [2, 2, 2], {
        translation: [10, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [2, 1, 1],
      }),
    );
    const bounds = worldContentBounds(store);
    expect(bounds).toEqual({
      min: [10, 0, 0],
      max: [14, 2, 2],
    });
  });

  it("computes selection bounds for a subset of nodes", () => {
    const store = buildStore({
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [BOX_A, BOX_B],
        },
        {
          nodeId: BOX_A,
          name: "A",
          parentId: ROOT,
          transform: { ...IDENTITY, translation: [0, 0, 0] },
          volumeId: VOLUME_A,
        },
        {
          nodeId: BOX_B,
          name: "B",
          parentId: ROOT,
          transform: { ...IDENTITY, translation: [10, 0, 0] },
          volumeId: VOLUME_B,
        },
      ],
      volumes: [
        { volumeId: VOLUME_A, min: [0, 0, 0], max: [2, 2, 2] },
        { volumeId: VOLUME_B, min: [0, 0, 0], max: [2, 2, 2] },
      ],
    });
    expect(worldBoundsForNodes(store, [BOX_B])).toEqual({
      min: [10, 0, 0],
      max: [12, 2, 2],
    });
    expect(worldBoundsForNodes(store, [])).toBeUndefined();
  });

  it("computes nested world matrices in child order", () => {
    const store = buildStore({
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [BOX_A],
        },
        {
          nodeId: BOX_A,
          name: "A",
          parentId: ROOT,
          transform: { ...IDENTITY, translation: [1, 2, 3] },
          children: [BOX_B],
        },
        {
          nodeId: BOX_B,
          name: "B",
          parentId: BOX_A,
          transform: { ...IDENTITY, translation: [4, 0, 0] },
          volumeId: VOLUME_B,
        },
      ],
      volumes: [{ volumeId: VOLUME_B, min: [0, 0, 0], max: [1, 1, 1] }],
    });
    const matrices = nodeWorldMatrices(store);
    expect(matrices.get(BOX_A)?.[3]).toBe(1);
    expect(matrices.get(BOX_A)?.[7]).toBe(2);
    expect(matrices.get(BOX_A)?.[11]).toBe(3);
    expect(matrices.get(BOX_B)?.[3]).toBe(5);
    expect(matrices.get(BOX_B)?.[7]).toBe(2);
    expect(matrices.get(BOX_B)?.[11]).toBe(3);
  });

  it("picks a child volume through its parent transform", () => {
    const store = buildStore({
      nodes: [
        { nodeId: ROOT, name: "Root", parentId: null, children: [BOX_A] },
        {
          nodeId: BOX_A,
          name: "Parent",
          parentId: ROOT,
          transform: { ...IDENTITY, translation: [0, 0, 0] },
          children: [BOX_B],
        },
        {
          nodeId: BOX_B,
          name: "Child",
          parentId: BOX_A,
          transform: { ...IDENTITY, translation: [0, 0, 0] },
          volumeId: VOLUME_B,
        },
      ],
      volumes: [{ volumeId: VOLUME_B, min: [0, 0, 0], max: [2, 2, 2] }],
    });
    const hit = pickScene(store, ray([1.5, 1.5, 20], [0, 0, -1]));
    expect(hit?.nodeId).toBe(BOX_B);
    expect(hit?.voxel).toEqual([1, 1, 1]);
    expect(hit?.face).toEqual([0, 0, 1]);
    expect(hit?.distance).toBeCloseTo(18, 9);
  });
});
