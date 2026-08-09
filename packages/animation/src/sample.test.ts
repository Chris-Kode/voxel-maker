import { describe, expect, it } from "vitest";
import { keyframeId, trackId } from "@voxel-maker/shared";
import { quaternionFromAxisAngle } from "@voxel-maker/math";
import type { AnimationTrack } from "@voxel-maker/model";
import { sampleTrack } from "./sample.js";

/**
 * Track sampling (plan S10.3, ticket #28): step/linear/frozen smoothstep
 * ease, shortest-path quaternion SLERP, exact boundaries, and hold
 * behavior outside the keyframe range.
 */

const identityQuat = [0, 0, 0, 1] as const;

const rotationTrack = (
  interpolation: AnimationTrack["interpolation"],
  keyframes: Array<{ time: number; angle: number }>,
): AnimationTrack => ({
  trackId: trackId("track:anim:sample:rotation"),
  targetNodeId: "node:anim:sample" as never,
  interpolation,
  keyframes: keyframes.map(({ time, angle }, index) => ({
    keyframeId: keyframeId(
      `keyframe:anim:sample:${String(index)}:${String(time)}`,
    ),
    time,
    property: {
      channel: "rotation",
      value: quaternionFromAxisAngle([0, 1, 0], angle),
    },
  })),
});

const translationTrack = (
  interpolation: AnimationTrack["interpolation"],
  values: Array<{ time: number; value: readonly [number, number, number] }>,
): AnimationTrack => ({
  trackId: trackId("track:anim:sample:translation"),
  targetNodeId: "node:anim:sample" as never,
  interpolation,
  keyframes: values.map(({ time, value }, index) => ({
    keyframeId: keyframeId(`keyframe:anim:sample:t:${String(index)}`),
    time,
    property: { channel: "translation", value: [...value] },
  })),
});

describe("sampleTrack", () => {
  it("returns undefined for an empty track", () => {
    const track: AnimationTrack = {
      trackId: trackId("track:anim:sample:empty"),
      targetNodeId: "node:anim:sample" as never,
      interpolation: "linear",
      keyframes: [],
    };
    expect(sampleTrack(track, 0)).toBeUndefined();
    expect(sampleTrack(track, 1.5)).toBeUndefined();
  });

  it("holds the first and last values outside the keyframe range", () => {
    const track = translationTrack("linear", [
      { time: 1, value: [1, 0, 0] },
      { time: 2, value: [2, 0, 0] },
    ]);
    expect(sampleTrack(track, 0)?.value).toEqual([1, 0, 0]);
    expect(sampleTrack(track, 0.999)?.value).toEqual([1, 0, 0]);
    expect(sampleTrack(track, 3)?.value).toEqual([2, 0, 0]);
  });

  it("returns exact keyframe values at exact boundaries (bit for bit)", () => {
    const track = translationTrack("linear", [
      { time: 1, value: [1.25, -0.5, 3] },
      { time: 2, value: [2, 0, 0] },
    ]);
    expect(sampleTrack(track, 1)).toEqual({
      channel: "translation",
      value: [1.25, -0.5, 3],
    });
    expect(sampleTrack(track, 2)).toEqual({
      channel: "translation",
      value: [2, 0, 0],
    });
  });

  it("samples linear translation at the exact midpoint", () => {
    const track = translationTrack("linear", [
      { time: 0, value: [0, 0, 0] },
      { time: 2, value: [4, 6, -2] },
    ]);
    expect(sampleTrack(track, 1)?.value).toEqual([2, 3, -1]);
    expect(sampleTrack(track, 0.5)?.value).toEqual([1, 1.5, -0.5]);
  });

  it("holds the lower keyframe in step mode", () => {
    const track = translationTrack("step", [
      { time: 0, value: [0, 0, 0] },
      { time: 2, value: [10, 0, 0] },
    ]);
    expect(sampleTrack(track, 1.999)?.value).toEqual([0, 0, 0]);
    expect(sampleTrack(track, 2)?.value).toEqual([10, 0, 0]);
  });

  it("applies the frozen smoothstep ease curve u^2*(3-2u)", () => {
    const track = translationTrack("smoothstep", [
      { time: 0, value: [0, 0, 0] },
      { time: 1, value: [1, 0, 0] },
    ]);
    // u = 0.5 -> ease 0.5; u = 0.25 -> ease 0.15625; u = 0.75 -> 0.84375.
    expect(sampleTrack(track, 0.5)?.value[0]).toBeCloseTo(0.5, 12);
    expect(sampleTrack(track, 0.25)?.value[0]).toBeCloseTo(0.15625, 12);
    expect(sampleTrack(track, 0.75)?.value[0]).toBeCloseTo(0.84375, 12);
  });

  it("interpolates rotation with shortest-path slerp", () => {
    const track = rotationTrack("linear", [
      { time: 0, angle: 0 },
      { time: 1, angle: Math.PI / 2 },
    ]);
    const mid = sampleTrack(track, 0.5);
    const expected = quaternionFromAxisAngle([0, 1, 0], Math.PI / 4);
    const value = mid?.value ?? [];
    for (let index = 0; index < 4; index += 1) {
      expect(
        Math.abs((value[index] as number) - (expected[index] as number)),
      ).toBeLessThan(1e-12);
    }
  });

  it("takes the short way around for rotation keyframes far apart", () => {
    // 170 degrees forward, -170 degrees back: the shortest arc crosses
    // 180 degrees (20 degrees the short way), so the midpoint is a
    // half-turn around +Y.
    const track = rotationTrack("linear", [
      { time: 0, angle: Math.PI - 0.2 },
      { time: 1, angle: -(Math.PI - 0.2) },
    ]);
    const mid = sampleTrack(track, 0.5);
    const expected = quaternionFromAxisAngle([0, 1, 0], Math.PI);
    const midValue: readonly [number, number, number, number] = (mid?.value ?? [
      0, 0, 0, 1,
    ]) as readonly [number, number, number, number];
    const [mx, my, mz, mw] = midValue;
    const [ex, ey, ez, ew] = expected;
    expect(Math.abs(mx - ex)).toBeLessThan(1e-9);
    expect(Math.abs(my - ey)).toBeLessThan(1e-9);
    expect(Math.abs(mz - ez)).toBeLessThan(1e-9);
    expect(Math.abs(mw - ew)).toBeLessThan(1e-9);
    // The long way around would land at ~ -10 degrees (a 0.174-radian
    // turn near identity), which the shortest path must never produce.
    const longWay = quaternionFromAxisAngle([0, 1, 0], 0.1745);
    expect(Math.abs(midValue[1] - longWay[1])).toBeGreaterThan(0.5);
  });

  it("samples translation against identity rotation base without drift", () => {
    const track = rotationTrack("linear", [
      { time: 0, angle: 0 },
      { time: 1, angle: 0 },
    ]);
    expect(sampleTrack(track, 0.5)?.value).toEqual(identityQuat);
  });
});
