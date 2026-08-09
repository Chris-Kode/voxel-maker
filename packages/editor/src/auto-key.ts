import {
  type KeyframeId,
  type NodeId,
  type TrackId,
} from "@voxel-maker/shared";
import {
  NODE_SET_TRANSFORM_COMMAND,
  setKeyframeCommand,
  type Command,
} from "@voxel-maker/commands";
import type { AnimationDescriptor, TrackProperty } from "@voxel-maker/model";
import type { SetNodeTransformPayload } from "@voxel-maker/commands";

/**
 * Auto-key command construction (plan S10.12, ticket #29): the pure
 * builder that turns a transform transaction's `node.setTransform`
 * commands into `keyframe.set` commands for every track of the selected
 * clip that speaks the edited channel. The desktop timeline controller
 * calls it when the timeline key mode is "auto", so a transform edit
 * intentionally targets the selected clip instead of base state; the
 * viewport and inspector stay decoupled from timeline state.
 *
 * Rules (matching the animation data model):
 *
 * - Only `node.setTransform` commands participate (pivot edits never
 *   auto-key; pivots are not animatable in v1).
 * - A track's channel is the channel of its first keyframe. Tracks
 *   without keyframes have no established channel and are skipped.
 * - A keyframe already parked exactly at the key time is updated in
 *   place (same id, same time); otherwise a fresh id is allocated.
 * - Repeated transform commands for the same node in one transaction
 *   dedupe to the last value (a coalesced drag must produce one key).
 * - The key time is clamped into `[0, clip.duration]` so the produced
 *   commands always pass validation.
 */

export interface AutoKeyOptions {
  /** The clip the keyframes are authored into (the timeline selection). */
  readonly clip: AnimationDescriptor;
  /** The playhead time in seconds (already snapped by the caller). */
  readonly time: number;
  /** Allocates a fresh keyframe id per track for newly created keys. */
  readonly nextKeyframeId: (trackId: TrackId) => KeyframeId;
}

interface TransformEdit {
  readonly nodeId: NodeId;
  readonly command: Command;
}

/** Builds the typed property for a track channel from a transform. */
function channelProperty(
  channel: "translation" | "rotation" | "scale",
  transform: SetNodeTransformPayload["transform"],
): TrackProperty {
  const value = [...channelValue(transform, channel)] as unknown as
    | readonly [number, number, number]
    | readonly [number, number, number, number];
  return { channel, value } as TrackProperty;
}

/** Extracts the channel value of a transform for a track channel. */
function channelValue(
  transform: {
    readonly translation: readonly number[];
    readonly rotation: readonly number[];
    readonly scale: readonly number[];
  },
  channel: "translation" | "rotation" | "scale",
): readonly number[] {
  if (channel === "translation") return transform.translation;
  if (channel === "rotation") return transform.rotation;
  return transform.scale;
}

export function buildAutoKeyCommands(
  commands: readonly Command[],
  options: AutoKeyOptions,
): readonly Command[] {
  const { clip, nextKeyframeId } = options;
  const time = Math.min(Math.max(options.time, 0), clip.duration);

  // Last edit wins per node: a coalesced drag commits one transform per
  // node, but multi-command transactions (mixed gestures) must still
  // produce exactly one key per node/track.
  const edits = new Map<NodeId, TransformEdit>();
  for (const command of commands) {
    if (command.type !== NODE_SET_TRANSFORM_COMMAND) continue;
    // The type discriminates the payload shape; the cast is safe because
    // every `node.setTransform` command is canonicalized by its
    // constructor before it reaches the bus.
    const payload = command.payload as SetNodeTransformPayload;
    edits.set(payload.nodeId, { nodeId: payload.nodeId, command });
  }

  const keyCommands: Command[] = [];
  for (const { nodeId } of edits.values()) {
    for (const track of clip.tracks) {
      if (track.targetNodeId !== nodeId) continue;
      const first = track.keyframes[0];
      if (first === undefined) continue; // channel not established
      const edit = edits.get(nodeId);
      if (edit === undefined) continue;
      const payload = edit.command.payload as SetNodeTransformPayload;
      const parked = track.keyframes.find((keyframe) => keyframe.time === time);
      keyCommands.push(
        setKeyframeCommand(keyframeCommandId(nextKeyframeId(track.trackId)), {
          animationId: clip.animationId,
          trackId: track.trackId,
          keyframeId: parked?.keyframeId ?? nextKeyframeId(track.trackId),
          time: parked?.time ?? time,
          property: channelProperty(first.property.channel, payload.transform),
        }),
      );
    }
  }
  return keyCommands;
}

// Command ids come from the host in the real flow (the controller passes
// them through `setKeyframeCommand`); this builder only needs distinct
// ids, so it derives one from the keyframe id deterministically. The
// derivation is stable for a given keyframe id, which keeps the builder
// pure and the tests deterministic.
function keyframeCommandId(keyframeId: KeyframeId): Command["id"] {
  return `command:autokey:${String(keyframeId)}` as Command["id"];
}
