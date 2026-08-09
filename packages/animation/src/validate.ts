import {
  DEFAULT_DOCUMENT_LIMITS,
  type DocumentLimits,
} from "@voxel-maker/model";
import type {
  AnimationDescriptor,
  AnimationTrack,
  Keyframe,
  SceneNode,
  VoxelDocument,
} from "@voxel-maker/model";

/**
 * Semantic animation invariant validation (plan S10.2, ticket #28). The
 * model package validates the shape of animation records; this module
 * re-asserts the document-aware invariants at the animation layer with
 * stable, animation-scoped findings: targets must exist in the single
 * node hierarchy, every keyframe in a track must speak the same property
 * channel (a track targets exactly one property, CONTEXT.md), keyframe
 * values must be compatible with their channel, and per-clip duplicate
 * (target node, channel) tracks resolve by the clip's stable persisted
 * track order (last track wins) rather than by ambiguity. The check is
 * pure and returns findings; it never throws and never mutates state.
 */

/** A stable, animation-scoped semantic finding. */
export interface AnimationIssue {
  readonly code:
    | "MISSING_TARGET_NODE"
    | "MIXED_PROPERTY_CHANNEL"
    | "INVALID_ROTATION_VALUE"
    | "INVALID_SCALE_VALUE"
    | "INVALID_TRANSLATION_VALUE"
    | "INVALID_KEYFRAME_TIME"
    | "UNSORTED_KEYFRAME_TIMES"
    | "DUPLICATE_KEYFRAME_TIME"
    | "DUPLICATE_TRACK_ID"
    | "INVALID_CLIP_DURATION";
  readonly animationId: string;
  readonly trackId?: string;
  readonly keyframeId?: string;
  readonly message: string;
}

const issue = (
  code: AnimationIssue["code"],
  animationId: string,
  message: string,
  trackId?: string,
  keyframeId?: string,
): AnimationIssue => ({
  code,
  animationId,
  message,
  ...(trackId === undefined ? {} : { trackId }),
  ...(keyframeId === undefined ? {} : { keyframeId }),
});

const isFiniteValue = (value: number): boolean =>
  Number.isFinite(value) && !Object.is(value, -0);

function checkKeyframeValue(
  keyframe: Keyframe,
  animationId: string,
  trackId: string,
  issues: AnimationIssue[],
): void {
  const channel = keyframe.property.channel;
  const value = keyframe.property.value;
  if (channel === "rotation") {
    const normSquared = value.reduce(
      (total, component) => total + component * component,
      0,
    );
    const finite =
      value.length === 4 &&
      value.every((component) => isFiniteValue(component));
    if (!finite || Math.abs(Math.sqrt(normSquared) - 1) > 1e-9) {
      issues.push(
        issue(
          "INVALID_ROTATION_VALUE",
          animationId,
          `Rotation keyframe on ${trackId} must be a finite normalized quaternion`,
          trackId,
          keyframe.keyframeId,
        ),
      );
    }
  } else if (channel === "scale") {
    if (
      value.length !== 3 ||
      !value.every((component) => isFiniteValue(component) && component > 0)
    ) {
      issues.push(
        issue(
          "INVALID_SCALE_VALUE",
          animationId,
          `Scale keyframe on ${trackId} must be a finite strictly positive vector`,
          trackId,
          keyframe.keyframeId,
        ),
      );
    }
  } else {
    if (
      value.length !== 3 ||
      !value.every((component) => isFiniteValue(component))
    ) {
      issues.push(
        issue(
          "INVALID_TRANSLATION_VALUE",
          animationId,
          `Translation keyframe on ${trackId} must be a finite vector`,
          trackId,
          keyframe.keyframeId,
        ),
      );
    }
  }
}

function checkTrack(
  animation: AnimationDescriptor,
  track: AnimationTrack,
  issues: AnimationIssue[],
): void {
  const animationId = animation.animationId;
  let channel: "translation" | "rotation" | "scale" | undefined;
  let previousTime: number | undefined;
  for (const keyframe of track.keyframes) {
    if (!isFiniteValue(keyframe.time) || keyframe.time < 0) {
      issues.push(
        issue(
          "INVALID_KEYFRAME_TIME",
          animationId,
          `Keyframe time on ${track.trackId} must be a finite non-negative number`,
          track.trackId,
          keyframe.keyframeId,
        ),
      );
      continue;
    }
    if (previousTime !== undefined && keyframe.time < previousTime) {
      issues.push(
        issue(
          "UNSORTED_KEYFRAME_TIMES",
          animationId,
          `Keyframe times on ${track.trackId} must be sorted in ascending order`,
          track.trackId,
          keyframe.keyframeId,
        ),
      );
    }
    if (previousTime !== undefined && keyframe.time === previousTime) {
      issues.push(
        issue(
          "DUPLICATE_KEYFRAME_TIME",
          animationId,
          `Keyframe times on ${track.trackId} must be unique`,
          track.trackId,
          keyframe.keyframeId,
        ),
      );
    }
    previousTime = keyframe.time;
    if (channel === undefined) {
      channel = keyframe.property.channel;
    } else if (keyframe.property.channel !== channel) {
      issues.push(
        issue(
          "MIXED_PROPERTY_CHANNEL",
          animationId,
          `Track ${track.trackId} mixes property channels; a track targets exactly one property`,
          track.trackId,
          keyframe.keyframeId,
        ),
      );
    }
    checkKeyframeValue(keyframe, animationId, track.trackId, issues);
  }
}

/**
 * Validates every animation descriptor in the document against the
 * document-aware animation invariants. Findings:
 *
 * - `MISSING_TARGET_NODE` — a track targets a node that does not exist in
 *   the document (the node hierarchy is the only transform graph).
 * - `MIXED_PROPERTY_CHANNEL` — keyframes within one track use more than
 *   one property channel.
 * - `INVALID_ROTATION_VALUE` / `INVALID_SCALE_VALUE` /
 *   `INVALID_TRANSLATION_VALUE` — a keyframe value is incompatible with
 *   its channel (non-finite, non-normalized rotation, non-positive scale).
 * - `INVALID_KEYFRAME_TIME` / `UNSORTED_KEYFRAME_TIMES` /
 *   `DUPLICATE_KEYFRAME_TIME` — keyframe time invariants.
 * - `DUPLICATE_TRACK_ID` — two tracks in the same clip share an id.
 * - `INVALID_CLIP_DURATION` — clip-level bounds (loop policy and shape are
 *   structurally guaranteed by the model schema validator).
 *
 * Per-clip duplicate (target node, channel) tracks are legal: evaluation
 * resolves them by the clip's stable persisted track order (last track
 * wins), mirroring the constraint ordering policy of ADR-0006.
 */
export function validateAnimationSemantics(
  document: VoxelDocument,
  limits: DocumentLimits = DEFAULT_DOCUMENT_LIMITS,
): readonly AnimationIssue[] {
  const issues: AnimationIssue[] = [];
  for (const animation of Object.values(document.animations)) {
    if (
      !isFiniteValue(animation.duration) ||
      animation.duration <= 0 ||
      animation.duration > limits.maxClipDurationSeconds
    ) {
      issues.push(
        issue(
          "INVALID_CLIP_DURATION",
          animation.animationId,
          "Clip duration must be finite and within (0, 86400] seconds",
        ),
      );
    }
    const seenTrackIds = new Set<string>();
    for (const track of animation.tracks) {
      if (seenTrackIds.has(track.trackId)) {
        issues.push(
          issue(
            "DUPLICATE_TRACK_ID",
            animation.animationId,
            `Track ${track.trackId} appears more than once in clip ${animation.animationId}`,
            track.trackId,
          ),
        );
      }
      seenTrackIds.add(track.trackId);
      if (document.nodes[track.targetNodeId] === undefined) {
        issues.push(
          issue(
            "MISSING_TARGET_NODE",
            animation.animationId,
            `Track ${track.trackId} targets node ${track.targetNodeId} which is not part of the document`,
            track.trackId,
          ),
        );
      }
      checkTrack(animation, track, issues);
    }
  }
  return issues;
}

/**
 * True when the document carries no animation semantic findings; used by
 * tools and fixtures to assert a valid animation model cheaply.
 */
export function hasValidAnimationSemantics(document: VoxelDocument): boolean {
  return validateAnimationSemantics(document).length === 0;
}

/** The node targeted by a track; undefined when the target is missing. */
export function trackTargetNode(
  document: VoxelDocument,
  track: AnimationTrack,
): SceneNode | undefined {
  return document.nodes[track.targetNodeId];
}

/**
 * The single property channel of a track (all keyframes must share it),
 * or undefined for an empty track.
 */
export function trackChannel(
  track: AnimationTrack,
): AnimationTrack["keyframes"][number]["property"]["channel"] | undefined {
  return track.keyframes[0]?.property.channel;
}
