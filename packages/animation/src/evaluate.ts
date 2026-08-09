import type { AnimationDescriptor, TrackProperty } from "@voxel-maker/model";
import type { NodeId } from "@voxel-maker/shared";
import { sampleTrack } from "./sample.js";

/**
 * Clip time and loop evaluation (plan S10.4, ticket #28). A clip owns a
 * duration and a loop policy; a transport time is resolved into a sample
 * time before any track is read. ADR-0006 freezes the policy:
 *
 * - Negative playback time clamps to zero before either policy applies.
 * - `once` clamps time to `[0, duration]`.
 * - `loop` maps time with mathematical modulo into `[0, duration)`, so
 *   an exact positive multiple of the duration evaluates at zero.
 *
 * Zero-duration clips are rejected by validation (the model schema
 * requires `(0, maxClipDurationSeconds]`), so modulo never divides by
 * zero here.
 */

/**
 * Resolves a raw playback time against one clip under the ADR-0006 loop
 * policy. Returns the sample time in `[0, duration]` for `once` and in
 * `[0, duration)` for `loop`.
 */
export function resolveClipTime(
  clip: Pick<AnimationDescriptor, "duration" | "loop">,
  time: number,
): number {
  if (!Number.isFinite(time) || time < 0) return 0;
  const duration = clip.duration;
  if (clip.loop === "loop") {
    // Mathematical modulo: the result is in [0, duration) for any
    // non-negative input, and exact positive duration maps to zero.
    return time % duration;
  }
  return Math.min(time, duration);
}

/**
 * One sampled property override for a node. Values are the sampled
 * property at the resolved clip time; keys are the typed property channel.
 */
export type NodeOverrides = Readonly<
  Partial<Record<"translation" | "rotation" | "scale", TrackProperty>>
>;

/**
 * The result of sampling one clip: per-target-node property overrides plus
 * the resolved sample time. Tracks with no keyframes contribute nothing.
 * When several tracks in a clip target the same node and channel, the
 * clip's stable persisted track order decides: the last track wins
 * (ADR-0006 orders constraints the same way).
 */
export interface ClipSample {
  readonly time: number;
  readonly overrides: ReadonlyMap<NodeId, NodeOverrides>;
}

/**
 * Samples every track of a clip at a raw playback time. The raw time is
 * resolved through the clip's loop policy first, so callers may pass
 * transport time (including values beyond the duration and negative
 * values) directly. Pure and deterministic; never mutates the clip.
 */
export function sampleClip(
  clip: AnimationDescriptor,
  time: number,
): ClipSample {
  const resolved = resolveClipTime(clip, time);
  const overrides = new Map<NodeId, NodeOverrides>();
  for (const track of clip.tracks) {
    const property = sampleTrack(track, resolved);
    if (property === undefined) continue;
    const current = overrides.get(track.targetNodeId);
    const next: NodeOverrides = { ...current, [property.channel]: property };
    overrides.set(track.targetNodeId, next);
  }
  return { time: resolved, overrides };
}
