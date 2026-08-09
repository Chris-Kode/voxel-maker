import { describe, expect, it } from "vitest";
import { type NodeId } from "@voxel-maker/shared";
import {
  validateDocument,
  type SceneNode,
  type VoxelDocument,
} from "@voxel-maker/model";
import { applyMatrix } from "@voxel-maker/math";
import {
  evaluateLocalTransform,
  evaluateNodeWorldTransforms,
  evaluateWorldTransform,
} from "./evaluate.js";
import {
  RIG_FIXTURES,
  createAbstractSculptureFixture,
  createChestLidFixture,
  createLinkedArmFixture,
  createWheelFixture,
  createWingsFixture,
} from "./fixtures.js";
import { validateRigAnnotations } from "./validate.js";

/**
 * Generic rig fixture tests (plan S9.9, ticket #26): every fixture is a
 * valid generic document, uses only the node hierarchy plus pivot/joint
 * annotations, and articulates the intended way under evaluation.
 */

function findNode(document: VoxelDocument, name: string): SceneNode {
  const id = Object.keys(document.nodes).find(
    (key) => document.nodes[key as NodeId]?.name === name,
  );
  const node = id === undefined ? undefined : document.nodes[id as NodeId];
  if (node === undefined) throw new Error(`fixture node "${name}" missing`);
  return node;
}

describe("generic rig fixtures", () => {
  it("registers the five required fixtures", () => {
    expect(RIG_FIXTURES.map((fixture) => fixture.kind)).toEqual([
      "chest-lid",
      "wheel",
      "linked-arm",
      "wings",
      "abstract-sculpture",
    ]);
  });

  for (const fixture of RIG_FIXTURES) {
    it(`${fixture.name} validates and uses only generic articulation symbols`, () => {
      const document = fixture.create();
      expect(validateDocument(document)).toEqual([]);
      expect(validateRigAnnotations(document)).toEqual([]);
      // No category-specific core symbols: only nodes, transforms, voxel
      // components, pivot components, and joint components.
      for (const node of Object.values(document.nodes)) {
        for (const component of node.components) {
          expect(["voxel", "pivot", "joint"]).toContain(component.kind);
        }
      }
      // Every fixture demonstrates at least one joint and one pivot.
      const joints = Object.values(document.nodes).filter((node) =>
        node.components.some((component) => component.kind === "joint"),
      );
      const pivots = Object.values(document.nodes).filter((node) =>
        node.components.some((component) => component.kind === "pivot"),
      );
      expect(joints.length).toBeGreaterThan(0);
      expect(pivots.length).toBeGreaterThan(0);
      // The node hierarchy is the sole parent graph: every annotated node
      // is reachable from the root.
      const world = evaluateNodeWorldTransforms(document);
      expect(world.size).toBe(Object.keys(document.nodes).length);
    });
  }
});

describe("chest lid articulation", () => {
  const document = createChestLidFixture();
  const lid = findNode(document, "Lid");
  const lidId = lid.nodeId;

  it("keeps the hinge edge fixed under rotation about the pivot", () => {
    const hingeLocal = lid.transform.pivot;
    // Identity rotation: the hinge content point lands at translation +
    // pivot (0, 6, -3).
    const identityWorld = evaluateWorldTransform(document, lidId);
    expect(applyMatrix(identityWorld, hingeLocal)).toEqual([0, 6, -3]);
    // Opening 90 degrees about +X keeps the hinge edge fixed because the
    // pivot is the rotation center: the content point equal to the pivot
    // always maps to translation + pivot.
    const rotated = evaluateLocalTransform({
      ...lid.transform,
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    });
    expect(applyMatrix(rotated, hingeLocal)).toEqual([0, 6, -3]);
  });
});

describe("wheel articulation", () => {
  const document = createWheelFixture();
  const wheel = findNode(document, "Wheel");

  it("spins about its center without drifting", () => {
    const spin = evaluateLocalTransform({
      ...wheel.transform,
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    });
    // The wheel center stays put and a rim point keeps its radius.
    expect(applyMatrix(spin, [0, 0, 0])).toEqual([0, 0, 0]);
    const rim = applyMatrix(spin, [3, 0, 0]);
    expect(Math.hypot(rim[0], rim[1], rim[2])).toBeCloseTo(3, 12);
  });
});

describe("linked arm articulation", () => {
  const document = createLinkedArmFixture();

  it("chains joints so a shoulder rotation swings the whole arm", () => {
    const link1 = findNode(document, "Link 1").nodeId;
    const link2 = findNode(document, "Link 2").nodeId;
    const link3 = findNode(document, "Link 3").nodeId;
    // Straight arm: joints at (0,0,0), (4,0,0), and (8,0,0).
    const world = evaluateNodeWorldTransforms(document);
    expect(applyMatrix(world.get(link1) as never, [0, 0, 0])).toEqual([
      0, 0, 0,
    ]);
    expect(applyMatrix(world.get(link2) as never, [0, 0, 0])).toEqual([
      4, 0, 0,
    ]);
    expect(applyMatrix(world.get(link3) as never, [0, 0, 0])).toEqual([
      8, 0, 0,
    ]);
    // Rotating link 1 by 90 degrees about +Y swings links 2 and 3.
    const rotated = {
      ...document,
      nodes: {
        ...document.nodes,
        [link1]: {
          ...(document.nodes[link1] as SceneNode),
          transform: {
            ...(document.nodes[link1] as SceneNode).transform,
            rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
          },
        },
      },
    };
    const rotatedWorld = evaluateNodeWorldTransforms(rotated);
    const elbow = applyMatrix(rotatedWorld.get(link2) as never, [0, 0, 0]);
    const wrist = applyMatrix(rotatedWorld.get(link3) as never, [0, 0, 0]);
    expect(elbow[0]).toBeCloseTo(0, 12);
    expect(elbow[2]).toBeCloseTo(-4, 12);
    expect(wrist[0]).toBeCloseTo(0, 12);
    expect(wrist[2]).toBeCloseTo(-8, 12);
  });
});

describe("bilateral wings articulation", () => {
  const document = createWingsFixture();
  const right = findNode(document, "Right Wing").nodeId;
  const left = findNode(document, "Left Wing").nodeId;

  it("mirrors the left wing with a rotation, not negative scale", () => {
    const world = evaluateNodeWorldTransforms(document);
    const rightTip = applyMatrix(world.get(right) as never, [5, 0, 0]);
    const leftTip = applyMatrix(world.get(left) as never, [5, 0, 0]);
    expect(rightTip).toEqual([5, 0, 0]);
    // 180 degrees about +Y maps +X to -X.
    expect(leftTip[0]).toBeCloseTo(-5, 12);
    expect(leftTip[1]).toBeCloseTo(0, 12);
    expect(leftTip[2]).toBeCloseTo(0, 12);
    // Both wings flap about their shoulder joint at the body.
    const flapped = {
      ...document,
      nodes: {
        ...document.nodes,
        [right]: {
          ...(document.nodes[right] as SceneNode),
          transform: {
            ...(document.nodes[right] as SceneNode).transform,
            rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
          },
        },
      },
    };
    const flappedWorld = evaluateNodeWorldTransforms(flapped);
    const tip = applyMatrix(flappedWorld.get(right) as never, [5, 0, 0]);
    expect(tip[1]).toBeCloseTo(5, 12);
  });
});

describe("abstract sculpture articulation", () => {
  const document = createAbstractSculptureFixture();
  const column = findNode(document, "Column");

  it("rotates the column about its support point", () => {
    const spun = evaluateLocalTransform({
      ...column.transform,
      rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    });
    // The pivot content point (0,0,0) — the column base — always lands at
    // translation + pivot = (0,1,0), so spinning keeps the support fixed
    // while the top (0,5,0) sweeps to (-5,1,0).
    expect(applyMatrix(spun, [0, 0, 0])).toEqual([0, 1, 0]);
    const top = applyMatrix(spun, [0, 5, 0]);
    expect(top[0]).toBeCloseTo(-5, 12);
    expect(top[1]).toBeCloseTo(1, 12);
    expect(top[2]).toBeCloseTo(0, 12);
  });
});
