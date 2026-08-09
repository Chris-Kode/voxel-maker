import { describe, expect, it } from "vitest";
import type { AnimationDescriptor } from "@voxel-maker/model";
import { resolveClipTime, sampleClip } from "./evaluate.js";
import { createWheelSpinClip } from "./fixtures.js";

/**
 * Clip time and loop evaluation (plan S10.4, ticket #28): the ADR-0006
 * policy — negative time clamps to zero, `once` clamps to the duration,
 * `loop` wraps with mathematical modulo so an exact positive duration
 * evaluates at zero — and per-node clip sampling.
 */

const clip = (loop: "once" | "loop", duration = 2): AnimationDescriptor => ({
  animationId: "animation:anim:test:0001" as never,
  duration,
  loop,
  tracks: [],
});

describe("resolveClipTime", () => {
  it("clamps negative playback time to zero before either policy", () => {
    expect(resolveClipTime(clip("once"), -1)).toBe(0);
    expect(resolveClipTime(clip("loop"), -0.5)).toBe(0);
    expect(resolveClipTime(clip("loop"), Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("clamps once clips to [0, duration]", () => {
    expect(resolveClipTime(clip("once"), 0)).toBe(0);
    expect(resolveClipTime(clip("once"), 1)).toBe(1);
    expect(resolveClipTime(clip("once"), 2)).toBe(2);
    expect(resolveClipTime(clip("once"), 3)).toBe(2);
    expect(resolveClipTime(clip("once"), 1e9)).toBe(2);
  });

  it("wraps loop clips with mathematical modulo into [0, duration)", () => {
    expect(resolveClipTime(clip("loop"), 0)).toBe(0);
    expect(resolveClipTime(clip("loop"), 1)).toBe(1);
    expect(resolveClipTime(clip("loop"), 2)).toBe(0); // exact duration -> zero
    expect(resolveClipTime(clip("loop"), 2.5)).toBe(0.5);
    expect(resolveClipTime(clip("loop"), 7)).toBe(1);
    expect(resolveClipTime(clip("loop"), 2 * 1e6 + 0.25)).toBe(0.25);
  });

  it("keeps non-finite time at zero", () => {
    expect(resolveClipTime(clip("once"), Number.NaN)).toBe(0);
    expect(resolveClipTime(clip("loop"), Number.NaN)).toBe(0);
  });
});

describe("sampleClip", () => {
  it("samples the wheel spin at resolved loop times", () => {
    const spin = createWheelSpinClip();
    const atZero = sampleClip(spin, 0);
    expect(atZero.time).toBe(0);
    expect(
      atZero.overrides.get("node:rig:wheel:wheel" as never)?.rotation?.value,
    ).toEqual([0, 0, 0, 1]);
    // t = 0.5 -> 45 degrees around +Y.
    const atHalf = sampleClip(spin, 0.5);
    expect(atHalf.time).toBe(0.5);
    const value =
      atHalf.overrides.get("node:rig:wheel:wheel" as never)?.rotation?.value ??
      [];
    expect(
      Math.abs(Math.sqrt(value.reduce((s, c) => s + c * c, 0)) - 1),
    ).toBeLessThan(1e-12);
    // t = 1.5 wraps to 0.5 (mathematical modulo).
    const wrapped = sampleClip(spin, 1.5);
    expect(wrapped.time).toBe(0.5);
    expect(
      wrapped.overrides.get("node:rig:wheel:wheel" as never)?.rotation?.value,
    ).toEqual(value);
    // t = 2 (exact duration) evaluates at zero.
    const atDuration = sampleClip(spin, 2);
    expect(atDuration.time).toBe(0);
    expect(
      atDuration.overrides.get("node:rig:wheel:wheel" as never)?.rotation
        ?.value,
    ).toEqual([0, 0, 0, 1]);
  });

  it("clamps once clips at the duration", () => {
    const lid = {
      ...createWheelSpinClip(),
      loop: "once" as const,
    };
    const clamped = sampleClip(lid, 5);
    expect(clamped.time).toBe(1);
  });

  it("leaves nodes without tracks untouched and ignores empty tracks", () => {
    const spin = createWheelSpinClip();
    const sample = sampleClip(spin, 0.25);
    expect(sample.overrides.has("node:rig:wheel:axle" as never)).toBe(false);
  });

  it("resolves duplicate (node, channel) tracks by the last track in order", () => {
    const base = createWheelSpinClip();
    const first = base.tracks[0];
    if (first === undefined) throw new Error("fixture track missing");
    const withDuplicate: AnimationDescriptor = {
      ...base,
      tracks: [
        first,
        {
          trackId: "track:anim:dup:0001" as never,
          targetNodeId: first.targetNodeId,
          interpolation: "linear",
          keyframes: [
            {
              keyframeId: "keyframe:anim:dup:0001" as never,
              time: 0,
              property: { channel: "rotation", value: [0, 0, 0, 1] },
            },
          ],
        },
      ],
    };
    const sample = sampleClip(withDuplicate, 0.5);
    // The last track holds identity at 0.5, overriding the spin.
    expect(
      sample.overrides.get("node:rig:wheel:wheel" as never)?.rotation?.value,
    ).toEqual([0, 0, 0, 1]);
  });
});
