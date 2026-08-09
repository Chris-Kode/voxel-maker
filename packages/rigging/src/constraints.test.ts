import { describe, expect, it } from "vitest";
import { componentId, nodeId, volumeId } from "@voxel-maker/shared";
import {
  cloneDocument,
  createDocument,
  type SceneNode,
  type VoxelDocument,
} from "@voxel-maker/model";
import {
  applyMatrix,
  eulerXYZToQuaternion,
  multiplyMatrices,
  quaternionToEulerXYZ,
  transformToMatrix,
  type Mat4,
  type Transform,
} from "@voxel-maker/math";
import {
  applyRotationConstraints,
  applyRotationLimits,
  clampWrappedAngle,
  evaluateConstrainedLocalTransform,
  evaluateConstrainedNodeWorldTransforms,
  rotationConstraintsOf,
} from "./constraints.js";
import { evaluateNodeWorldTransforms } from "./evaluate.js";

/**
 * Rotation constraint evaluation tests (plan S9.5/S9.10, ticket #27):
 * angle wrapping, parent and pivot interactions, non-uniform positive
 * scale policy, constraint order, and document immutability. Goldens are
 * derived by hand (principal-branch Euler extraction + nearest-interval
 * wrap + clamp), so the tests do not re-run the implementation.
 */

const RAD = Math.PI / 180;
const deg = (value: number): number => value * RAD;
const quat = (x: number, y = 0, z = 0) =>
  eulerXYZToQuaternion([deg(x), deg(y), deg(z)]);

/**
 * Normalizes an angle to the principal branch [-180, 180): equivalent
 * rotations (for example -180 and 180) compare equal.
 */
const principalDeg = (value: number): number => {
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
};

const eulerXDeg = (
  rotation: readonly [number, number, number, number],
): number => principalDeg(quaternionToEulerXYZ(rotation)[0] / RAD);

const axis = (axisIndex: 0 | 1 | 2, minDeg: number, maxDeg: number) => {
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  min[axisIndex] = deg(minDeg);
  max[axisIndex] = deg(maxDeg);
  return { min, max };
};

const constraint = (
  id: string,
  limits: {
    readonly min: [number, number, number];
    readonly max: [number, number, number];
  },
) => ({
  componentId: componentId(id),
  type: "rotation-limits" as const,
  limits,
});

describe("clampWrappedAngle", () => {
  it("keeps angles already inside the interval", () => {
    expect(clampWrappedAngle(0.2, -0.5, 0.5)).toBeCloseTo(0.2, 12);
    expect(clampWrappedAngle(-0.4, -0.5, 0.5)).toBeCloseTo(-0.4, 12);
  });

  it("clamps angles outside the interval to the near endpoint", () => {
    expect(clampWrappedAngle(0.7, -0.5, 0.5)).toBeCloseTo(0.5, 12);
    expect(clampWrappedAngle(-0.9, -0.5, 0.5)).toBeCloseTo(-0.5, 12);
  });

  it("wraps negative angles into a non-negative interval via the near endpoint", () => {
    // -45 deg is 45 deg from 0 and 135 deg from 90: nearest valid is 0.
    expect(principalDeg(clampWrappedAngle(deg(-45), 0, deg(90)) / RAD)).toBe(0);
    // -170 deg is 10 deg from 180 (via the +360 representation, which
    // the algorithm returns as -180: the same rotation).
    expect(principalDeg(clampWrappedAngle(deg(-170), 0, deg(180)) / RAD)).toBe(
      principalDeg(180),
    );
    // -170 deg is 100 deg from 90 and 170 deg from 0: nearest is 90
    // (returned as -270, the equivalent rotation).
    expect(principalDeg(clampWrappedAngle(deg(-170), 0, deg(90)) / RAD)).toBe(
      principalDeg(90),
    );
  });

  it("wraps angles above the interval down via the nearest equivalent period", () => {
    // 200 deg is 110 deg from 90 and 160 deg from 360: nearest is 90.
    expect(principalDeg(clampWrappedAngle(deg(200), 0, deg(90)) / RAD)).toBe(
      principalDeg(90),
    );
    // 200 deg is 20 deg from 180: nearest is 180.
    expect(principalDeg(clampWrappedAngle(deg(200), 0, deg(180)) / RAD)).toBe(
      principalDeg(180),
    );
  });

  it("resolves an exact half-turn tie deterministically to the lower endpoint", () => {
    // -45 deg is exactly 135 deg from both 90 (k=0) and -180 (k=-1);
    // the tie resolves to the lower endpoint 90.
    expect(clampWrappedAngle(deg(-45), deg(90), deg(180)) / RAD).toBeCloseTo(
      90,
      12,
    );
    // Positive-offset mirror: 315 deg is exactly 135 deg from both
    // 450 (k=1) and 180 (k=0); round-half-up picks k=1 and clamps to
    // 450, the same rotation as 90.
    expect(clampWrappedAngle(deg(315), deg(90), deg(180)) / RAD).toBeCloseTo(
      450,
      12,
    );
  });

  it("never restricts an axis whose span covers a full revolution", () => {
    for (const angle of [-3.1, -1, 0, 1, 3.1]) {
      expect(clampWrappedAngle(angle, -Math.PI, Math.PI)).toBeCloseTo(
        angle,
        12,
      );
      expect(clampWrappedAngle(angle, -2 * Math.PI, 2 * Math.PI)).toBeCloseTo(
        angle,
        12,
      );
    }
  });
});

describe("applyRotationLimits", () => {
  it("leaves a rotation inside the limits unchanged (within float round-trip)", () => {
    const result = applyRotationLimits(quat(20), axis(0, -30, 30));
    const eulerOut = quaternionToEulerXYZ(result);
    expect(eulerOut[0]).toBeCloseTo(deg(20), 10);
    expect(eulerOut[1]).toBeCloseTo(0, 10);
    expect(eulerOut[2]).toBeCloseTo(0, 10);
  });

  it("clamps a rotation beyond the limit to the boundary", () => {
    const result = applyRotationLimits(quat(60), axis(0, -30, 30));
    expect(eulerXDeg(result)).toBeCloseTo(30, 10);
  });

  it("clamps per axis independently", () => {
    const result = applyRotationLimits(quat(60, 20, -40), {
      min: [deg(-30), deg(-10), deg(-90)],
      max: [deg(30), deg(10), deg(90)],
    });
    const eulerOut = quaternionToEulerXYZ(result);
    expect(eulerOut[0]).toBeCloseTo(deg(30), 10);
    expect(eulerOut[1]).toBeCloseTo(deg(10), 10);
    expect(eulerOut[2]).toBeCloseTo(deg(-40), 10);
  });

  it("wraps an equivalent-representation rotation into the interval", () => {
    // A 200 deg rotation extracts to -160 deg (principal branch); with a
    // [0, 180] limit the nearest valid rotation is 180.
    const result = applyRotationLimits(quat(200), axis(0, 0, 180));
    expect(eulerXDeg(result)).toBeCloseTo(principalDeg(180), 10);
  });

  it("leaves a full-revolution limit unconstrained even outside the principal branch", () => {
    // -170 deg with [-180, 180] (span 2 pi) stays -170 deg.
    const result = applyRotationLimits(quat(-170), axis(0, -180, 180));
    expect(eulerXDeg(result)).toBeCloseTo(-170, 10);
  });

  it("returns a canonical unit quaternion", () => {
    const result = applyRotationLimits(quat(60), axis(0, -30, 30));
    const [x, y, z, w] = result;
    expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 10);
    expect(w).toBeGreaterThanOrEqual(0);
  });
});

describe("applyRotationConstraints", () => {
  it("applies constraints in deterministic persisted order", () => {
    const first = constraint("c1", axis(0, 0, 30));
    const second = constraint("c2", axis(0, 60, 90));
    // c1 then c2: 0 stays in c1, c2 pushes it to 60 (outside c1).
    const forward = applyRotationConstraints(quat(0), [first, second]);
    expect(eulerXDeg(forward)).toBeCloseTo(60, 10);
    // c2 then c1: c2 pushes 0 to 60, c1 clamps it back to 30.
    const reversed = applyRotationConstraints(quat(0), [second, first]);
    expect(eulerXDeg(reversed)).toBeCloseTo(30, 10);
  });

  it("treats an empty constraint list as no-op", () => {
    const result = applyRotationConstraints(quat(20), []);
    expect(result).toEqual(quat(20));
  });
});

const IDENTITY: Transform = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

const ROOT = nodeId("node:rig:constraint:root");
const PARENT = nodeId("node:rig:constraint:parent");
const CHILD = nodeId("node:rig:constraint:child");
const VOLUME = volumeId("volume:rig:constraint:0001");

const PARENT_TRANSFORM: Transform = {
  translation: [2, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [2, 1, 1],
};

const CHILD_TRANSFORM: Transform = {
  translation: [1, 0, 0],
  pivot: [1, 0, 0],
  rotation: quat(60),
  scale: [1, 1, 1],
};

const CHILD_CONSTRAINT = constraint(
  "component:rig:constraint:child",
  axis(0, -30, 30),
);

function buildDocument(constrained: boolean): VoxelDocument {
  return createDocument({
    documentId: "document:rig:constraint" as never,
    metadata: { title: "constraint evaluation" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [PARENT],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: PARENT,
        name: "Parent",
        parentId: ROOT,
        children: [CHILD],
        transform: PARENT_TRANSFORM,
        components: [],
      },
      {
        nodeId: CHILD,
        name: "Child",
        parentId: PARENT,
        children: [],
        transform: CHILD_TRANSFORM,
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
          ...(constrained
            ? [
                {
                  kind: "constraint" as const,
                  schemaVersion: 1 as const,
                  constraints: [CHILD_CONSTRAINT],
                },
              ]
            : []),
        ],
      },
    ],
    volumes: [{ volumeId: VOLUME }],
  });
}

describe("evaluateConstrainedLocalTransform", () => {
  it("clamps the rotation and keeps every other field", () => {
    const transform: Transform = {
      translation: [1, 2, 3],
      pivot: [4, 5, 6],
      rotation: quat(60),
      scale: [1, 2, 3],
    };
    const result = evaluateConstrainedLocalTransform(transform, [
      constraint("c:local", axis(0, -30, 30)),
    ]);
    expect(result.translation).toEqual([1, 2, 3]);
    expect(result.pivot).toEqual([4, 5, 6]);
    expect(result.scale).toEqual([1, 2, 3]);
    expect(eulerXDeg(result.rotation)).toBeCloseTo(30, 10);
    expect(result).not.toBe(transform);
  });

  it("returns the same transform object when nothing is clamped", () => {
    const transform: Transform = { ...IDENTITY, rotation: quat(10) };
    const result = evaluateConstrainedLocalTransform(transform, [
      constraint("c:local", axis(0, -30, 30)),
    ]);
    expect(result).toBe(transform);
  });
});

describe("evaluateConstrainedNodeWorldTransforms", () => {
  it("clamps the child rotation before composing with the parent", () => {
    const document = buildDocument(true);
    const world = evaluateConstrainedNodeWorldTransforms(document).get(
      CHILD,
    ) as Mat4;
    // Expected: parent T(2,0,0) S(2,1,1) composed with the child's
    // pivot formula using the CLAMPED 30 deg rotation:
    // T(1,0,0) T(1,0,0) R(30deg X) S(1) T(-1,0,0).
    const childTransform: Transform = {
      ...CHILD_TRANSFORM,
      rotation: quat(30),
    };
    const expected: Mat4 = multiplyMatrices(
      transformToMatrix(PARENT_TRANSFORM),
      transformToMatrix(childTransform),
    );
    for (let index = 0; index < 16; index += 1) {
      expect(world[index]).toBeCloseTo(expected[index] as number, 9);
    }
  });

  it("supports positive non-uniform ancestor scale without decomposing shear", () => {
    const document = buildDocument(true);
    const world = evaluateConstrainedNodeWorldTransforms(document).get(
      CHILD,
    ) as Mat4;
    const point = applyMatrix(world, [0, 0, 0]);
    // Hand-computed: child local maps (0,0,0) ->
    //   T(2,0,0) R(30deg X) T(-1,0,0) (0,0,0) = (1,0,0);
    // parent T(2,0,0) S(2,1,1) maps (1,0,0) -> (2*1+2, 0, 0) = (4,0,0).
    // The shear from parent S(2,1,1) x child R is composed, never
    // decomposed (ADR-0006).
    expect(point[0]).toBeCloseTo(4, 9);
    expect(point[1]).toBeCloseTo(0, 9);
    expect(point[2]).toBeCloseTo(0, 9);
  });

  it("leaves the authored rotation and document untouched", () => {
    const document = buildDocument(true);
    const frozen = deepFreeze(cloneDocument(document));
    const before = JSON.stringify(frozen);
    const world = evaluateConstrainedNodeWorldTransforms(frozen);
    expect(world.size).toBe(Object.keys(frozen.nodes).length);
    expect(JSON.stringify(frozen)).toBe(before);
    // The authored child rotation is still 60 deg in the document.
    const child = frozen.nodes[CHILD];
    expect(child).toBeDefined();
    if (child !== undefined) {
      expect(quaternionToEulerXYZ(child.transform.rotation)[0]).toBeCloseTo(
        deg(60),
        10,
      );
    }
  });

  it("matches the unconstrained world pass when no node is constrained", () => {
    const free = buildDocument(false);
    const base = evaluateNodeWorldTransforms(free);
    const constrained = evaluateConstrainedNodeWorldTransforms(free);
    expect(constrained.size).toBe(base.size);
    for (const [nodeId, matrix] of base) {
      expect(constrained.get(nodeId)).toEqual(matrix);
    }
  });

  it("walks parents before children in deterministic pre-order", () => {
    const document = buildDocument(true);
    const world = evaluateConstrainedNodeWorldTransforms(document);
    expect([...world.keys()]).toEqual([ROOT, PARENT, CHILD]);
    // Parent world does not depend on the child's clamp.
    const parentWorld = world.get(PARENT) as Mat4;
    const expectedParent: Mat4 = transformToMatrix(PARENT_TRANSFORM);
    for (let index = 0; index < 16; index += 1) {
      expect(parentWorld[index]).toBeCloseTo(
        expectedParent[index] as number,
        9,
      );
    }
  });
});

describe("rotationConstraintsOf", () => {
  it("returns the ordered descriptors of the constraint component", () => {
    const node: SceneNode = {
      nodeId: nodeId("node:rig:constraint:probe"),
      name: "Probe",
      parentId: null,
      children: [],
      transform: IDENTITY,
      components: [
        { kind: "joint", schemaVersion: 1 },
        {
          kind: "constraint",
          schemaVersion: 1,
          constraints: [
            constraint("c:a", axis(0, -1, 1)),
            constraint("c:b", axis(1, -1, 1)),
          ],
        },
      ],
    };
    expect(
      rotationConstraintsOf(node).map((entry) => entry.componentId),
    ).toEqual([componentId("c:a"), componentId("c:b")]);
  });

  it("returns an empty list without a constraint component", () => {
    const node: SceneNode = {
      nodeId: nodeId("node:rig:constraint:probe"),
      name: "Probe",
      parentId: null,
      children: [],
      transform: IDENTITY,
      components: [{ kind: "joint", schemaVersion: 1 }],
    };
    expect(rotationConstraintsOf(node)).toEqual([]);
  });
});

/** Recursively freezes a cloned document so mutation attempts throw. */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  return value;
}
