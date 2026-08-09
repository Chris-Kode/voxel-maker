import { describe, expect, it } from "vitest";
import { evaluateAnimationRuntime } from "./runtime.js";
import { createWingFlapDocument, createWingFlapClip, createContinuousWheelDocument, createContinuousWheelClip, createAbstractAnimationDocument, createAbstractSculptureClip, createConstrainedChestLidDocument, createChestLidClip } from "./fixtures.js";

describe("probe", () => {
  it("wings", () => {
    const { document } = { document: createWingFlapDocument() };
    const clip = createWingFlapClip();
    const up = evaluateAnimationRuntime(document, clip, 0.5);
    const m = up.world.get("node:rig:wings:right" as never);
    console.log("right up m0,m1:", m?.[0], m?.[1], "angle:", Math.atan2(-(m?.[1] ?? 0), m?.[0] ?? 0));
    const left = up.world.get("node:rig:wings:left" as never);
    console.log("left up m0,m1:", left?.[0], left?.[1], "angle:", Math.atan2(-(left?.[1] ?? 0), left?.[0] ?? 0));
    const down = evaluateAnimationRuntime(document, clip, 1.5);
    const m2 = down.world.get("node:rig:wings:right" as never);
    console.log("right down angle:", Math.atan2(-(m2?.[1] ?? 0), m2?.[0] ?? 0));
  });
  it("wheel", () => {
    const document = createContinuousWheelDocument();
    const clip = createContinuousWheelClip();
    const s = evaluateAnimationRuntime(document, clip, 0.5);
    const m = s.world.get("node:rig:wheel:wheel" as never);
    console.log("wheel m8,m0:", m?.[8], m?.[0], "angle:", Math.atan2(-(m?.[8] ?? 0), m?.[0] ?? 0));
  });
  it("abstract", () => {
    const document = createAbstractAnimationDocument();
    const clip = createAbstractSculptureClip();
    const s = evaluateAnimationRuntime(document, clip, 2);
    const m = s.world.get("node:rig:sculpture:column" as never);
    console.log("column m8,m0:", m?.[8], m?.[0], "angle:", Math.atan2(-(m?.[8] ?? 0), m?.[0] ?? 0));
    expect(1).toBe(1);
  });
  it("chest animatedX", () => {
    const document = createConstrainedChestLidDocument();
    const clip = createChestLidClip();
    const end = evaluateAnimationRuntime(document, clip, 2);
    const rot = end.local.get("node:rig:chest-lid:lid" as never)?.rotation;
    console.log("chest local rot:", rot, "atan2(quat0,w):", Math.atan2(rot?.[0] ?? 0, rot?.[3] ?? 0));
  });
});
