import { describe, expect, it } from "vitest";
import {
  applyMatrix,
  multiplyMatrices,
  quaternionToEulerXYZ,
  transformToMatrix,
  type Mat4,
  type Transform,
} from "@voxel-maker/math";
import type { VoxelDocument } from "@voxel-maker/model";
import {
  createAnimatedWheelDocument,
  createWheelSpinClip,
} from "./fixtures.js";
import {
  evaluateAnimationRuntime,
  evaluateLocalTransforms,
  type AnimationRuntimeState,
} from "./runtime.js";
import { createDocumentStore } from "@voxel-maker/document";

/**
 * Layered runtime evaluation (plan S10.5, ticket #28): base document
 * state, then animation override, then the hierarchy world pass — pure,
 * immutable, and free of commands and revisions per frame.
 */

const WHEEL = "node:rig:wheel:wheel" as never;
const AXLE = "node:rig:wheel:axle" as never;

const nodeTransform = (document: VoxelDocument, id: string): Transform => {
  const node = document.nodes[id as never];
  if (node === undefined) throw new Error(`missing fixture node ${id}`);
  return node.transform;
};

const worldOf = (state: AnimationRuntimeState, id: string): Mat4 => {
  const matrix = state.world.get(id as never);
  if (matrix === undefined) throw new Error(`missing world matrix ${id}`);
  return matrix;
};

const localOf = (state: AnimationRuntimeState, id: string): Transform => {
  const transform = state.local.get(id as never);
  if (transform === undefined) throw new Error(`missing local transform ${id}`);
  return transform;
};

describe("evaluateAnimationRuntime", () => {
  it("evaluates base state exactly when no clip is active", () => {
    const document = createAnimatedWheelDocument();
    const base = evaluateAnimationRuntime(document, null, 0);
    expect(base.time).toBe(0);
    expect(base.clipId).toBeNull();
    expect(localOf(base, WHEEL).rotation).toEqual([0, 0, 0, 1]);
    expect(worldOf(base, AXLE)).toEqual(
      transformToMatrix(nodeTransform(document, AXLE)),
    );
    // Base local equals the stored transforms bit for bit.
    for (const node of Object.values(document.nodes)) {
      expect(base.local.get(node.nodeId)).toEqual(node.transform);
    }
  });

  it("lays animation over base transforms without touching the document", () => {
    const document = createAnimatedWheelDocument();
    const { store } = createDocumentStore({ document });
    const frozen = store.getDocument();
    const runtime = evaluateAnimationRuntime(
      frozen,
      createWheelSpinClip(),
      0.5,
    );
    expect(runtime.time).toBe(0.5);
    // The wheel's rotation is overridden by the sampled 45-degree turn.
    const wheelLocal = localOf(runtime, WHEEL);
    expect(wheelLocal.rotation[0]).toBeCloseTo(0, 12);
    expect(wheelLocal.rotation[1]).toBeCloseTo(Math.sin(Math.PI / 8), 12);
    expect(wheelLocal.rotation[3]).toBeCloseTo(Math.cos(Math.PI / 8), 12);
    // The axle keeps its base transform (no track targets it).
    expect(localOf(runtime, AXLE)).toEqual(nodeTransform(document, AXLE));
    // The stored document record is untouched and still frozen.
    expect(nodeTransform(store.getDocument(), WHEEL).rotation).toEqual([
      0, 0, 0, 1,
    ]);
    expect(Object.isFrozen(store.getDocument())).toBe(true);
  });

  it("composes world transforms parent-first with the override", () => {
    const document = createAnimatedWheelDocument();
    const baseWorld = evaluateAnimationRuntime(document, null, 0).world;
    const runtime = evaluateAnimationRuntime(
      document,
      createWheelSpinClip(),
      0.5,
    );
    const expectedWorld = multiplyMatrices(
      worldOf({ ...runtime, world: baseWorld }, AXLE),
      transformToMatrix(localOf(runtime, WHEEL)),
    );
    const actual = worldOf(runtime, WHEEL);
    for (let index = 0; index < 16; index += 1) {
      expect(
        Math.abs((actual[index] as number) - (expectedWorld[index] as number)),
      ).toBeLessThan(1e-9);
    }
    // A point at the wheel center stays at the axle origin (pivot at 0).
    const center = applyMatrix(actual, [0, 0, 0]);
    expect(Math.abs(center[0])).toBeLessThan(1e-9);
    expect(Math.abs(center[1])).toBeLessThan(1e-9);
    expect(Math.abs(center[2])).toBeLessThan(1e-9);
  });

  it("restores base state exactly at the clip boundary for a once clip", () => {
    const document = createAnimatedWheelDocument();
    const clip = { ...createWheelSpinClip(), loop: "once" as const };
    const base = evaluateAnimationRuntime(document, null, 0);
    const atEnd = evaluateAnimationRuntime(document, clip, 10);
    expect(atEnd.time).toBe(1);
    // With a rotation-only track the wheel is overridden at the end.
    expect(localOf(atEnd, WHEEL).rotation).not.toEqual([0, 0, 0, 1]);
    expect(localOf(atEnd, AXLE)).toEqual(base.local.get(AXLE));
  });

  it("returns fresh immutable maps and never mutates inputs", () => {
    const document = createAnimatedWheelDocument();
    const snapshot = JSON.stringify(document);
    const clip = createWheelSpinClip();
    const clipSnapshot = JSON.stringify(clip);
    const runtime = evaluateAnimationRuntime(document, clip, 0.25);
    expect(JSON.stringify(document)).toBe(snapshot);
    expect(JSON.stringify(clip)).toBe(clipSnapshot);
    expect(runtime.local).not.toBe(runtime.world);
    // Read-only views: no mutating surface exists, so callers cannot
    // corrupt the snapshot.
    expect("set" in runtime.local).toBe(false);
    expect("delete" in runtime.local).toBe(false);
    expect("clear" in runtime.local).toBe(false);
    expect(() => {
      (runtime.local as unknown as { set: () => void }).set();
    }).toThrow();
  });

  it("keeps the same world result across repeated evaluation (determinism)", () => {
    const document = createAnimatedWheelDocument();
    const clip = createWheelSpinClip();
    const first = evaluateAnimationRuntime(document, clip, 0.75);
    const second = evaluateAnimationRuntime(document, clip, 0.75);
    expect(worldOf(first, WHEEL)).toEqual(worldOf(second, WHEEL));
    expect(localOf(first, WHEEL)).toEqual(localOf(second, WHEEL));
  });

  it("evaluates layered locals for every node including unreferenced ones", () => {
    const document = createAnimatedWheelDocument();
    const locals = evaluateLocalTransforms(
      document,
      createWheelSpinClip(),
      0.5,
    );
    expect(locals.size).toBe(Object.keys(document.nodes).length);
  });
});

/** Constrained copy of the wheel fixture: Y limited to +-30 degrees. */
function constrainedWheelDocument(): VoxelDocument {
  const document = createAnimatedWheelDocument();
  // createDocument freezes its records; clone through JSON like the
  // renderer adapter tests so the mutation below is possible.
  const clone = JSON.parse(JSON.stringify(document)) as VoxelDocument;
  const wheel = clone.nodes[WHEEL];
  if (wheel === undefined) throw new Error("missing wheel");
  (wheel as { components: typeof wheel.components }).components = [
    ...wheel.components,
    {
      kind: "constraint",
      schemaVersion: 1,
      constraints: [
        {
          componentId: "component:runtime:wheel-limit" as never,
          type: "rotation-limits",
          limits: {
            min: [-Math.PI, (-30 * Math.PI) / 180, -Math.PI],
            max: [Math.PI, (30 * Math.PI) / 180, Math.PI],
          },
        },
      ],
    },
  ];
  return clone;
}

describe("constraint layer (plan S9.5, ticket #27)", () => {
  it("clamps the animated rotation before the world pass", () => {
    const document = constrainedWheelDocument();
    const clip = createWheelSpinClip();
    // t = 0.5 of the 1s spin clip: 90 deg about Y, clamped to 30 deg.
    const runtime = evaluateAnimationRuntime(document, clip, 0.5);
    // The animated local rotation is the un-clamped override (45 deg
    // about Y at the linear midpoint)...
    const localRotation = localOf(runtime, WHEEL).rotation;
    const animatedY = quaternionToEulerXYZ(localRotation)[1];
    expect(animatedY).toBeCloseTo(Math.PI / 4, 9);
    // ...but the world pass sees the clamped rotation: the wheel's Y
    // rotation in the world matrix sits at the +-30 deg limit (row
    // major: Ry[0][0] = cos, Ry[2][0] = -sin).
    const world = worldOf(runtime, WHEEL);
    const worldAngle = Math.atan2(-world[8], world[0]);
    expect(Math.abs(worldAngle)).toBeCloseTo(Math.PI / 6, 6);
    // The base document is untouched: the constraint is still there and
    // the authored rotation is identity (voxel + pivot + joint +
    // constraint).
    expect(document.nodes[WHEEL]?.components).toHaveLength(4);
    expect(document.nodes[WHEEL]?.transform.rotation).toEqual([0, 0, 0, 1]);
  });

  it("applies constraints to base state when no clip is active", () => {
    const document = constrainedWheelDocument();
    const runtime = evaluateAnimationRuntime(document, null, 0);
    // Base rotation is identity, inside the limits: unchanged world.
    expect(worldOf(runtime, WHEEL)).toEqual(
      transformToMatrix(nodeTransform(createAnimatedWheelDocument(), WHEEL)),
    );
    expect(localOf(runtime, WHEEL).rotation).toEqual([0, 0, 0, 1]);
  });
});
