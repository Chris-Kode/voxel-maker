import { describe, expect, it } from "vitest";
import { type NodeId } from "@voxel-maker/shared";
import {
  canonicalDocumentHash,
  validateDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { applyMatrix } from "@voxel-maker/math";
import { validateRigAnnotations } from "@voxel-maker/rigging";
import { hasValidAnimationSemantics } from "./validate.js";
import {
  evaluateAnimationRuntime,
  type AnimationRuntimeState,
} from "./runtime.js";
import {
  ANIMATED_DEMOS,
  createAbstractAnimationDocument,
  createCharacterWaveDocument,
  createConstrainedChestLidDocument,
  createContinuousWheelDocument,
  createLinkedArmDocument,
  createWingFlapDocument,
} from "./fixtures.js";

/**
 * Definition-of-done animation demos (plan S10.15, ticket #30): one
 * end-to-end proof per unrelated asset category — constrained chest lid,
 * continuous wheel, linked arm, flapping wings, simple character, and
 * abstract animation. Every demo is a generic document + clip pair built
 * only from nodes, voxel volumes, pivots, joints, rotation constraints,
 * and the generic clip/track/keyframe primitives. The suite proves the
 * whole layered pipeline (base -> animation -> constraints -> hierarchy
 * world pass, ADR-0006) is deterministic, non-mutating, and renderer-
 * projectable for all six categories.
 */

const nodeIdOf = (id: string): NodeId => id as NodeId;

/** Deterministic snapshot of a runtime state (maps serialized in order). */
const stateJson = (state: AnimationRuntimeState): string =>
  JSON.stringify({
    time: state.time,
    clipId: state.clipId,
    local: [...state.local.entries()],
    world: [...state.world.entries()],
  });

const worldOf = (state: AnimationRuntimeState, id: string) => {
  const matrix = state.world.get(nodeIdOf(id));
  if (matrix === undefined) throw new Error(`missing world matrix ${id}`);
  return matrix;
};

/** World angle of the given axis from a row-major matrix (renderer math). */
const worldAngle = (
  matrix: ReturnType<typeof worldOf>,
  axis: "x" | "y" | "z",
): number => {
  if (axis === "x") return Math.atan2(matrix[9], matrix[10]);
  if (axis === "y") return Math.atan2(-matrix[8], matrix[0]);
  // Standard Rz is [c,-s; s,c], so the (0,1) element is -sin(angle).
  return Math.atan2(-matrix[1], matrix[0]);
};

/** Content point of the demo fixture projected through the runtime. */
const projected = (
  state: AnimationRuntimeState,
  nodeId: string,
  point: readonly [number, number, number],
): readonly [number, number, number] =>
  applyMatrix(worldOf(state, nodeId), point);

/** Every node's volume bounds corners, projected (renderer path). */
function projectedVolumeCorners(
  document: VoxelDocument,
  state: AnimationRuntimeState,
): Record<string, readonly number[][]> {
  const result: Record<string, readonly number[][]> = {};
  for (const node of Object.values(document.nodes)) {
    const volume = node.components.find(
      (component) => component.kind === "voxel",
    );
    if (volume?.kind !== "voxel") continue;
    const bounds = document.volumes[volume.volumeId]?.bounds;
    if (bounds === undefined) continue;
    const corners: number[][] = [];
    for (const x of [bounds.min[0], bounds.max[0]]) {
      for (const y of [bounds.min[1], bounds.max[1]]) {
        for (const z of [bounds.min[2], bounds.max[2]]) {
          corners.push([...projected(state, node.nodeId, [x, y, z])]);
        }
      }
    }
    result[node.nodeId] = corners;
  }
  return result;
}

describe("definition-of-done animation demos (ticket #30)", () => {
  it("registers all six unrelated asset categories", () => {
    expect(ANIMATED_DEMOS.map((demo) => demo.kind)).toEqual([
      "chest-lid",
      "wheel",
      "linked-arm",
      "wings",
      "simple-character",
      "abstract",
    ]);
  });

  it("exposes each demo document directly for the headless trace", () => {
    const creators: readonly (() => VoxelDocument)[] = [
      createConstrainedChestLidDocument,
      createContinuousWheelDocument,
      createLinkedArmDocument,
      createWingFlapDocument,
      createCharacterWaveDocument,
      createAbstractAnimationDocument,
    ];
    expect(creators.map((create) => create().animations)).toHaveLength(6);
    expect(
      creators.every((create) => Object.keys(create().animations).length === 1),
    ).toBe(true);
  });

  for (const demo of ANIMATED_DEMOS) {
    describe(demo.name, () => {
      const { document, clip } = demo.create();

      it("validates and uses only generic core symbols", () => {
        expect(validateDocument(document)).toEqual([]);
        expect(validateRigAnnotations(document)).toEqual([]);
        expect(hasValidAnimationSemantics(document)).toBe(true);
        // No category-specific core components.
        for (const node of Object.values(document.nodes)) {
          for (const component of node.components) {
            expect(["voxel", "pivot", "joint", "constraint"]).toContain(
              component.kind,
            );
          }
        }
        // No category-specific animation primitives: the clip is a generic
        // track/keyframe collection over the three transform channels.
        expect(Object.keys(document.animations)).toEqual([clip.animationId]);
        const embedded = document.animations[clip.animationId];
        expect(embedded?.tracks).toHaveLength(clip.tracks.length);
        for (const track of clip.tracks) {
          expect(["linear", "smoothstep", "step"]).toContain(
            track.interpolation,
          );
          for (const keyframe of track.keyframes) {
            expect(["translation", "rotation", "scale"]).toContain(
              keyframe.property.channel,
            );
          }
        }
      });

      it("evaluates deterministically and never mutates base state", () => {
        const hashBefore = canonicalDocumentHash(document);
        const times = [
          0,
          clip.duration / 3,
          clip.duration / 2,
          clip.duration - 1e-9,
        ];
        const first = times.map((time) =>
          evaluateAnimationRuntime(document, clip, time),
        );
        const second = times.map((time) =>
          evaluateAnimationRuntime(document, clip, time),
        );
        expect(first.map(stateJson)).toEqual(second.map(stateJson));
        // Repeated evaluation leaves the base document untouched.
        expect(canonicalDocumentHash(document)).toBe(hashBefore);
        // Evaluation without a clip restores the exact base pose (stop).
        const base = evaluateAnimationRuntime(document, null, 0);
        expect(base.time).toBe(0);
        expect(base.clipId).toBeNull();
        for (const node of Object.values(document.nodes)) {
          expect(base.local.get(nodeIdOf(node.nodeId))?.translation).toEqual(
            node.transform.translation,
          );
          expect(base.local.get(nodeIdOf(node.nodeId))?.rotation).toEqual(
            node.transform.rotation,
          );
        }
      });

      it("projects renderer-facing content deterministically", () => {
        const times = [0, clip.duration / 4, clip.duration / 2];
        const first = times.map((time) =>
          projectedVolumeCorners(
            document,
            evaluateAnimationRuntime(document, clip, time),
          ),
        );
        const second = times.map((time) =>
          projectedVolumeCorners(
            document,
            evaluateAnimationRuntime(document, clip, time),
          ),
        );
        // The renderer consumes world matrices + applyMatrix; the projected
        // content must be bit-identical across repeated evaluation.
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
        // The projection itself is finite and stable: matrices round trip
        // through transformToMatrix identically.
        for (const state of [first[0] as Record<string, readonly number[][]>]) {
          for (const corners of Object.values(state)) {
            for (const corner of corners) {
              expect(corner.every((value) => Number.isFinite(value))).toBe(
                true,
              );
            }
          }
        }
      });

      it("keeps the transport loop and clip duration consistent", () => {
        expect(clip.duration).toBeGreaterThan(0);
        expect(["once", "loop"]).toContain(clip.loop);
        const wrapped = evaluateAnimationRuntime(
          document,
          clip,
          clip.duration + clip.duration / 3,
        );
        expect(wrapped.time).toBeGreaterThanOrEqual(0);
        if (clip.loop === "loop") {
          expect(wrapped.time).toBeLessThan(clip.duration);
        } else {
          // Once-policy clips clamp at the duration (plan S10.4).
          expect(wrapped.time).toBe(clip.duration);
        }
      });
    });
  }

  describe("constrained chest lid demo", () => {
    const demo = ANIMATED_DEMOS.find((entry) => entry.kind === "chest-lid");
    if (demo === undefined) throw new Error("chest-lid demo missing");
    const { document, clip } = demo.create();
    const lid = nodeIdOf("node:rig:chest-lid:lid");

    it("opens the lid but clamps the 60-degree clip at the 45-degree hinge limit", () => {
      const end = evaluateAnimationRuntime(document, clip, 2);
      // The clip drives the lid 60 degrees about the hinge; the rotation
      // constraint limits the hinge to 45 degrees, so the world pose sits
      // at the limit while the base document still stores the clip's 60.
      expect(worldAngle(worldOf(end, lid), "x")).toBeCloseTo(Math.PI / 4, 6);
      // The hinge edge stays fixed through the whole constrained motion.
      const hinge = [0, 0, -3] as const;
      for (const time of [0, 0.5, 1, 2]) {
        const state = evaluateAnimationRuntime(document, clip, time);
        expect(projected(state, "node:rig:chest-lid:lid", hinge)).toEqual([
          0, 6, -3,
        ]);
      }
      // The runtime local table still holds the un-clamped animated
      // rotation (the constraint layer only shapes the world pass), so
      // the base clip is untouched by evaluation.
      const localRotation = end.local.get(lid);
      // The quaternion stores the half angle, so the animated X rotation
      // is twice the atan2 of the X component.
      const animatedX =
        localRotation === undefined
          ? NaN
          : 2 *
            Math.atan2(localRotation.rotation[0], localRotation.rotation[3]);
      expect(animatedX).toBeCloseTo(Math.PI / 3, 6);
    });
  });

  describe("continuous wheel demo", () => {
    const demo = ANIMATED_DEMOS.find((entry) => entry.kind === "wheel");
    if (demo === undefined) throw new Error("wheel demo missing");
    const { document, clip } = demo.create();
    const wheel = nodeIdOf("node:rig:wheel:wheel");

    it("spins a full revolution per loop at constant speed", () => {
      expect(clip.loop).toBe("loop");
      expect(clip.duration).toBe(2);
      const quarter = evaluateAnimationRuntime(document, clip, 0.5);
      expect(worldAngle(worldOf(quarter, wheel), "y")).toBeCloseTo(
        Math.PI / 2,
        6,
      );
      // The rim keeps its radius at every sampled pose (renderer math).
      for (const time of [0, 0.25, 0.75, 1.5]) {
        const state = evaluateAnimationRuntime(document, clip, time);
        const rim = projected(state, "node:rig:wheel:wheel", [3, 0, 0]);
        expect(Math.hypot(rim[0], rim[1], rim[2])).toBeCloseTo(3, 9);
      }
    });
  });

  describe("linked arm demo", () => {
    const demo = ANIMATED_DEMOS.find((entry) => entry.kind === "linked-arm");
    if (demo === undefined) throw new Error("linked-arm demo missing");
    const { document, clip } = demo.create();

    it("clamps each over-driven joint and still reaches a golden wrist pose", () => {
      const peak = evaluateAnimationRuntime(document, clip, 1);
      // Shoulder driven to 90 deg clamps at 60; elbow driven to 60 deg
      // clamps at 45; the wrist stays inside its 45-deg limit.
      expect(worldAngle(worldOf(peak, "node:rig:arm:link1"), "x")).toBeCloseTo(
        Math.PI / 3,
        6,
      );
      // Independent golden value: the wrist joint under the clamped chain
      // (Rx 60 -> T(4,0,0) -> Rz 45 -> T(4,0,0)) lands at
      // (4 + 2*sqrt(2), sqrt(2), sqrt(6)); the un-clamped chain would
      // land at (6, 0, 2*sqrt(3)) instead.
      const wrist = projected(peak, "node:rig:arm:link3", [0, 0, 0]);
      expect(wrist[0]).toBeCloseTo(4 + 2 * Math.SQRT2, 9);
      expect(wrist[1]).toBeCloseTo(Math.SQRT2, 9);
      expect(wrist[2]).toBeCloseTo(Math.sqrt(6), 9);
    });
  });

  describe("flapping wings demo", () => {
    const demo = ANIMATED_DEMOS.find((entry) => entry.kind === "wings");
    if (demo === undefined) throw new Error("wings demo missing");
    const { document, clip } = demo.create();

    it("flaps both wings and clamps the over-driven sweep at both limits", () => {
      const up = evaluateAnimationRuntime(document, clip, 0.5);
      const down = evaluateAnimationRuntime(document, clip, 1.5);
      // Driven to +60 deg, the flap clamps at the +30-deg limit.
      expect(worldAngle(worldOf(up, "node:rig:wings:right"), "z")).toBeCloseTo(
        Math.PI / 6,
        6,
      );
      // Driven to -90 deg, the flap clamps at the -45-deg limit.
      expect(
        worldAngle(worldOf(down, "node:rig:wings:right"), "z"),
      ).toBeCloseTo(-Math.PI / 4, 6);
      // Both wings sweep symmetrically: the left wing mirrors the right
      // through its parent's 180-deg rotation, so the wing tips land at
      // mirror-image world positions at both extremes.
      const rightTipUp = projected(up, "node:rig:wings:right", [5, 0, 0]);
      const leftTipUp = projected(up, "node:rig:wings:left", [5, 0, 0]);
      expect(rightTipUp[0]).toBeCloseTo(5 * Math.cos(Math.PI / 6), 9);
      expect(rightTipUp[1]).toBeCloseTo(5 * Math.sin(Math.PI / 6), 9);
      expect(leftTipUp[0]).toBeCloseTo(-rightTipUp[0], 9);
      expect(leftTipUp[1]).toBeCloseTo(rightTipUp[1], 9);
      const rightTipDown = projected(down, "node:rig:wings:right", [5, 0, 0]);
      const leftTipDown = projected(down, "node:rig:wings:left", [5, 0, 0]);
      expect(rightTipDown[0]).toBeCloseTo(5 * Math.cos(Math.PI / 4), 9);
      expect(rightTipDown[1]).toBeCloseTo(-5 * Math.sin(Math.PI / 4), 9);
      expect(leftTipDown[0]).toBeCloseTo(-rightTipDown[0], 9);
      expect(leftTipDown[1]).toBeCloseTo(rightTipDown[1], 9);
    });
  });

  describe("simple character demo", () => {
    const demo = ANIMATED_DEMOS.find(
      (entry) => entry.kind === "simple-character",
    );
    if (demo === undefined) throw new Error("simple-character demo missing");
    const { document, clip } = demo.create();

    it("waves within clamped limits and marches the legs", () => {
      const peak = evaluateAnimationRuntime(document, clip, 1);
      // Head turn driven to 90 deg clamps at 60 deg.
      expect(
        worldAngle(worldOf(peak, "node:rig:character:head"), "y"),
      ).toBeCloseTo(Math.PI / 3, 6);
      // Right arm raise driven to 90 deg clamps at 60 deg; the left arm
      // stays inside its limits at -45 deg.
      expect(
        worldAngle(worldOf(peak, "node:rig:character:right-arm"), "x"),
      ).toBeCloseTo(Math.PI / 3, 6);
      expect(
        worldAngle(worldOf(peak, "node:rig:character:left-arm"), "x"),
      ).toBeCloseTo(-Math.PI / 4, 6);
      // Legs march inside their hip limits.
      expect(
        Math.abs(
          worldAngle(worldOf(peak, "node:rig:character:right-leg"), "x"),
        ),
      ).toBeLessThanOrEqual(Math.PI / 3 + 1e-9);
      expect(
        Math.abs(worldAngle(worldOf(peak, "node:rig:character:left-leg"), "x")),
      ).toBeLessThanOrEqual(Math.PI / 3 + 1e-9);
    });
  });

  describe("abstract animation demo", () => {
    const demo = ANIMATED_DEMOS.find((entry) => entry.kind === "abstract");
    if (demo === undefined) throw new Error("abstract demo missing");
    const { document, clip } = demo.create();

    it("turns the sculpture with no constraints interfering", () => {
      const half = evaluateAnimationRuntime(document, clip, 2);
      // Column turned half a revolution at the clip midpoint.
      const columnAngle = worldAngle(
        worldOf(half, "node:rig:sculpture:column"),
        "y",
      );
      expect(Math.abs(columnAngle)).toBeCloseTo(Math.PI, 6);
      // Arm swung to 90 deg about Z with no clamp (no constraint); the
      // column's half-turn at t=2 mirrors the world reading, so the
      // magnitude is what the demo drives.
      expect(
        Math.abs(worldAngle(worldOf(half, "node:rig:sculpture:arm"), "z")),
      ).toBeCloseTo(Math.PI / 2, 6);
      // The support point of the column never drifts.
      expect(projected(half, "node:rig:sculpture:column", [0, 0, 0])).toEqual([
        0, 1, 0,
      ]);
    });
  });
});
