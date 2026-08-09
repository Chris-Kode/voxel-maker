import { quaternionSlerp, type Quat, type Vec3 } from "@voxel-maker/math";
import type { AnimationTrack, TrackProperty } from "@voxel-maker/model";

/**
 * Track sampling (plan S10.3, ticket #28). A track is an ordered set of
 * typed keyframes targeting one property channel of one node. Sampling
 * holds the first value before the first keyframe and the last value after
 * the last keyframe; at an exact keyframe time the stored value is returned
 * bit for bit, so boundary samples reproduce authored values exactly.
 *
 * Interpolation modes (ADR-0006):
 *
 * - `step` — hold the value of the keyframe at or before the sample time.
 * - `linear` — component-wise lerp for translation/scale; shortest-path
 *   quaternion SLERP for rotation.
 * - `smoothstep` — the frozen ease curve `u² × (3 - 2u)` applied to the
 *   local blend factor before the same lerp/SLERP (ADR-0006).
 *
 * Rotation values are canonical quaternions; interpolation always travels
 * the shortest arc. Sampling is pure and deterministic: it reads the track
 * and returns a new value or undefined for an empty track.
 */

const smoothstepCurve = (u: number): number => u * u * (3 - 2 * u);

function lerpValue(
  channel: TrackProperty["channel"],
  a: readonly number[],
  b: readonly number[],
  u: number,
): readonly number[] {
  if (channel === "rotation") {
    return quaternionSlerp(a as Quat, b as Quat, u);
  }
  return [
    (a[0] as number) + ((b[0] as number) - (a[0] as number)) * u,
    (a[1] as number) + ((b[1] as number) - (a[1] as number)) * u,
    (a[2] as number) + ((b[2] as number) - (a[2] as number)) * u,
  ];
}

/**
 * Samples one track at a resolved clip time. Returns the sampled property
 * (channel plus value) or undefined when the track has no keyframes. The
 * caller resolves clip time/loop policy before calling; this function
 * treats `time` as an absolute position on the track timeline and holds
 * the first/last value outside the keyframe range.
 */
export function sampleTrack(
  track: AnimationTrack,
  time: number,
): TrackProperty | undefined {
  const keyframes = track.keyframes;
  const first = keyframes[0];
  if (first === undefined) return undefined;
  const last = keyframes[keyframes.length - 1];
  if (last === undefined) return undefined;
  const channel = first.property.channel;
  // Exact boundary: return the stored value bit for bit.
  if (time <= first.time) return first.property;
  if (time >= last.time) return last.property;
  // Bracketing keyframes: the last keyframe at or before `time` and the
  // first keyframe after it. Times are sorted and unique (validated), so
  // the pair is unique.
  let lowerIndex = 0;
  for (let index = 0; index < keyframes.length; index += 1) {
    const keyframe = keyframes[index];
    if (keyframe !== undefined && keyframe.time <= time) lowerIndex = index;
    else break;
  }
  const lower = keyframes[lowerIndex];
  const upper = keyframes[lowerIndex + 1];
  if (lower === undefined || upper === undefined) {
    return lower === undefined ? undefined : lower.property;
  }
  const span = upper.time - lower.time;
  if (!(span > 0)) return lower.property;
  let u = (time - lower.time) / span;
  if (track.interpolation === "smoothstep") u = smoothstepCurve(u);
  if (track.interpolation === "step") return lower.property;
  const blended = lerpValue(
    channel,
    lower.property.value,
    upper.property.value,
    u,
  );
  if (channel === "rotation") {
    return { channel, value: blended as Quat };
  }
  return { channel, value: blended as Vec3 };
}
