import { describe, expect, it } from "vitest";
import { documentId, nodeId, volumeId } from "@voxel-maker/shared";
import {
  createDocument,
  type SceneNode,
  type VoxelDocument,
} from "@voxel-maker/model";
import { worldTransformMatrix } from "@voxel-maker/document";
import {
  multiplyMatrices,
  transformToMatrix,
  type Mat4,
  type Transform,
} from "@voxel-maker/math";
import {
  evaluateLocalTransform,
  evaluateNodeWorldTransforms,
  evaluateWorldTransform,
} from "./evaluate.js";

/**
 * Pivot-aware transform evaluation tests (plan S9.2/S9.10, ticket #26):
 * the approved transform formula `T(t) x T(p) x R x S x T(-p)` under
 * parents, rotation, and positive (including non-uniform) scale. The
 * golden matrices are derived by hand (see the comments below), so the
 * tests do not merely re-run the implementation.
 */

const ROOT = nodeId("node:rig:eval:root");
const PARENT = nodeId("node:rig:eval:parent");
const CHILD = nodeId("node:rig:eval:child");
const GRANDCHILD = nodeId("node:rig:eval:grandchild");
const VOLUME = volumeId("volume:rig:eval:0001");

/** Parent: non-uniform positive scale (2, 1, 1), no rotation, no pivot. */
const parentTransform: Transform = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [2, 1, 1],
};

/**
 * Child: translated to (1, 0, 0) with pivot at (1, 0, 0) and a 180 degree
 * rotation about +Y (exact components, so the golden is float-exact). The
 * rotation matrix is `diag(-1, 1, -1)`, so the local matrix is
 * `T(3,0,0) x R`:
 *   tau = t + p - R.p = (1,0,0) + (1,0,0) - (-1,0,0) = (3, 0, 0)
 *   local = [-1, 0, 0, 3 | 0, 1, 0, 0 | 0, 0, -1, 0 | 0, 0, 0, 1]
 */
const childTransform: Transform = {
  translation: [1, 0, 0],
  pivot: [1, 0, 0],
  rotation: [0, 1, 0, 0],
  scale: [1, 1, 1],
};

// Column-major storage (issue #82): columns of the linear part, then the
// translation column at indices 12-14.
const CHILD_LOCAL_GOLDEN: Mat4 = [
  -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 3, 0, 0, 1,
];

/**
 * World of the child under the scaled parent:
 * `S(2,1,1) x local`, column 0 scaled by 2:
 *   world = [-2, 0, 0 | 0, 1, 0 | 0, 0, -1 | 6, 0, 0]
 */
const CHILD_WORLD_GOLDEN: Mat4 = [
  -2, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 6, 0, 0, 1,
];

const grandchildTransform: Transform = {
  translation: [1, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

function buildDocument(): VoxelDocument {
  const identity: Transform = {
    translation: [0, 0, 0],
    pivot: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
  const root: SceneNode = {
    nodeId: ROOT,
    name: "Root",
    parentId: null,
    children: [PARENT],
    transform: identity,
    components: [],
  };
  const parent: SceneNode = {
    nodeId: PARENT,
    name: "Parent",
    parentId: ROOT,
    children: [CHILD],
    transform: parentTransform,
    components: [],
  };
  const child: SceneNode = {
    nodeId: CHILD,
    name: "Child",
    parentId: PARENT,
    children: [GRANDCHILD],
    transform: childTransform,
    components: [{ kind: "pivot", schemaVersion: 1, pivot: [1, 0, 0] }],
  };
  const grandchild: SceneNode = {
    nodeId: GRANDCHILD,
    name: "Grandchild",
    parentId: CHILD,
    children: [],
    transform: grandchildTransform,
    components: [{ kind: "joint", schemaVersion: 1 }],
  };
  return createDocument({
    documentId: documentId("document:rig:eval:0001"),
    metadata: { title: "rig evaluation fixture" },
    rootNodeId: ROOT,
    nodes: [root, parent, child, grandchild],
    volumes: [{ volumeId: VOLUME }],
  });
}

describe("evaluateLocalTransform", () => {
  it("matches the approved pivot formula golden", () => {
    expect(evaluateLocalTransform(childTransform)).toEqual(CHILD_LOCAL_GOLDEN);
  });

  it("equals the direct formula composition for arbitrary transforms", () => {
    const transforms: readonly Transform[] = [
      {
        translation: [3, -2, 0.5],
        pivot: [1, 2, 3],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      {
        translation: [0, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0.1, 0.2, 0.3, 0.9279],
        scale: [2, 1, 0.5],
      },
      {
        translation: [5, 5, 5],
        pivot: [-1, 0, 1],
        rotation: [0.5, 0.5, 0.5, 0.5],
        scale: [0.25, 3, 1],
      },
    ];
    for (const transform of transforms) {
      const expected = composePivotFormula(transform);
      const actual = evaluateLocalTransform(transform);
      for (let index = 0; index < 16; index += 1) {
        expect(actual[index]).toBeCloseTo(expected[index] as number, 12);
      }
    }
  });

  it("ignores the pivot when rotation and scale are identity", () => {
    const transform: Transform = {
      translation: [4, 5, 6],
      pivot: [9, 9, 9],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
    // Column-major storage (issue #82): translation at indices 12-14.
    expect(evaluateLocalTransform(transform)).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1,
    ]);
  });
});

describe("evaluateWorldTransform", () => {
  it("matches the world golden under parent scale and child pivot rotation", () => {
    const document = buildDocument();
    expect(evaluateWorldTransform(document, CHILD)).toEqual(CHILD_WORLD_GOLDEN);
  });

  it("composes ancestor local matrices in root-to-node order", () => {
    const document = buildDocument();
    const expected = multiplyMatrices(
      multiplyMatrices(
        multiplyMatrices(
          transformToMatrix(document.nodes[ROOT]?.transform as Transform),
          transformToMatrix(parentTransform),
        ),
        transformToMatrix(childTransform),
      ),
      transformToMatrix(grandchildTransform),
    );
    const actual = evaluateWorldTransform(document, GRANDCHILD);
    for (let index = 0; index < 16; index += 1) {
      expect(actual[index]).toBeCloseTo(expected[index] as number, 9);
    }
  });

  it("matches the document read-model world matrix", () => {
    const document = buildDocument();
    for (const nodeIdValue of [ROOT, PARENT, CHILD, GRANDCHILD]) {
      expect(evaluateWorldTransform(document, nodeIdValue)).toEqual(
        worldTransformMatrix(document, nodeIdValue),
      );
    }
  });
});

describe("evaluateNodeWorldTransforms", () => {
  it("evaluates every node in deterministic pre-order", () => {
    const document = buildDocument();
    const world = evaluateNodeWorldTransforms(document);
    expect([...world.keys()]).toEqual([ROOT, PARENT, CHILD, GRANDCHILD]);
    for (const nodeIdValue of [ROOT, PARENT, CHILD, GRANDCHILD]) {
      expect(world.get(nodeIdValue)).toEqual(
        worldTransformMatrix(document, nodeIdValue),
      );
    }
  });

  it("is deterministic across repeated calls", () => {
    const document = buildDocument();
    const first = evaluateNodeWorldTransforms(document);
    const second = evaluateNodeWorldTransforms(document);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it("never mutates the document", () => {
    const document = buildDocument();
    const before = JSON.stringify(document);
    evaluateNodeWorldTransforms(document);
    expect(JSON.stringify(document)).toBe(before);
  });
});

/** Independent formula composition `T(t) x T(p) x R x S x T(-p)`. */
function composePivotFormula(transform: Transform): Mat4 {
  const [tx, ty, tz] = transform.translation;
  const [px, py, pz] = transform.pivot;
  const [sx, sy, sz] = transform.scale;
  const rotation = transformToMatrix({
    translation: [0, 0, 0],
    pivot: [0, 0, 0],
    rotation: transform.rotation,
    scale: [1, 1, 1],
  });
  const scale = [
    sx,
    0,
    0,
    0,
    0,
    sy,
    0,
    0,
    0,
    0,
    sz,
    0,
    0,
    0,
    0,
    1,
  ] as const as Mat4;
  const translate = (v: readonly [number, number, number]): Mat4 => [
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    v[0],
    v[1],
    v[2],
    1,
  ];
  return multiplyMatrices(
    translate([tx, ty, tz]),
    multiplyMatrices(
      translate([px, py, pz]),
      multiplyMatrices(
        rotation,
        multiplyMatrices(scale, translate([-px, -py, -pz])),
      ),
    ),
  );
}
