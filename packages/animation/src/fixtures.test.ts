import { describe, expect, it } from "vitest";
import { hasValidAnimationSemantics } from "./validate.js";
import { sampleTrack } from "./sample.js";
import { resolveClipTime, sampleClip } from "./evaluate.js";
import {
  createAnimatedWheelDocument,
  createWheelSpinClip,
  createChestLidClip,
} from "./fixtures.js";

/** Fixture sanity: every animation fixture validates and samples cleanly. */
describe("animation fixtures", () => {
  it("creates a valid animated wheel document", () => {
    const document = createAnimatedWheelDocument();
    expect(hasValidAnimationSemantics(document)).toBe(true);
    expect(Object.keys(document.animations)).toHaveLength(1);
  });

  it("wheel spin samples golden values", () => {
    const clip = createWheelSpinClip();
    const wheel = "node:rig:wheel:wheel" as never;
    expect(sampleClip(clip, 0).overrides.get(wheel)?.rotation?.value).toEqual([
      0, 0, 0, 1,
    ]);
    const halfValue = sampleClip(clip, 0.5).overrides.get(wheel)?.rotation
      ?.value;
    expect(halfValue).toBeDefined();
    const half: readonly [number, number, number, number] = (halfValue ?? [
      0, 0, 0, 1,
    ]) as readonly [number, number, number, number];
    expect(Math.abs(half[1] - Math.sin(Math.PI / 8))).toBeLessThan(1e-12);
    expect(Math.abs(half[3] - Math.cos(Math.PI / 8))).toBeLessThan(1e-12);
  });

  it("chest lid clip is once, smoothstep, and 60 degrees at its end", () => {
    const clip = createChestLidClip();
    expect(clip.loop).toBe("once");
    expect(clip.tracks[0]?.interpolation).toBe("smoothstep");
    const track = clip.tracks[0];
    expect(track?.keyframes[1]?.property.value[0]).toBeCloseTo(
      Math.sin(Math.PI / 6),
      12,
    );
    expect(resolveClipTime(clip, 10)).toBe(2);
    const atEnd = track === undefined ? undefined : sampleTrack(track, 2);
    expect(atEnd?.value[3]).toBeCloseTo(Math.cos(Math.PI / 6), 12);
  });
});
