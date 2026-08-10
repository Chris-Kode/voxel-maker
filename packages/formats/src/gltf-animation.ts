import { WorkspaceError, type NodeId } from "@voxel-maker/shared";
import type {
  AnimationTrack,
  TrackProperty,
  VoxelDocument,
} from "@voxel-maker/model";
import { quaternionSlerp, type Quat } from "@voxel-maker/math";
import {
  GLTF_EXPORT_LOSSES,
  GLTF_INTERPOLATION_LINEAR,
  GLTF_INTERPOLATION_STEP,
  type GltfAnimationChannel,
  type GltfAnimationExport,
  type GltfAnimationSampler,
  type GltfExportLimits,
  type GltfExportLoss,
} from "./gltf-types.js";
import {
  compareCodeUnit,
  NameAllocator,
  sanitizeGltfName,
} from "./gltf-common.js";

/**
 * Clip -> glTF animation mapping (plan S16.4, ADR-0006/ADR-0011, ticket
 * #42). Each Clip becomes one glTF animation; each typed Track becomes one
 * sampler plus one channel targeting the exported glTF node that carries
 * the animated TRS property. Translation tracks target the chain head;
 * rotation and scale tracks target the pivot helper (or the single node
 * when there is no pivot), so the exported pivot chain stays world
 * equivalent while animated.
 *
 * Interpolation mapping (ADR-0011): `step` and `linear` map directly to
 * glTF `STEP` and `LINEAR`; `smoothstep` is deterministically baked to
 * linear samples with at most `maxSmoothstepSamplesPerSegment` interior
 * samples per segment (callers may only lower the default). Rotation
 * samples are the canonical shortest-path values of the model. glTF
 * cannot encode playback looping, so a `loop` clip is reported as a bake
 * loss. The runtime holds the first value before the first keyframe and
 * the last value after the last keyframe, so every multi-keyframe
 * sampler also emits held boundary samples at 0 and `clipDuration`
 * unless an authored key already lies there; a single-keyframe track is
 * constant and is emitted as two samples over the clip duration so the
 * sampler stays valid for every consumer. Tracks with no keyframes carry
 * no motion and are omitted.
 */

/** Where each document node's TRS properties live in the exported chain. */
export interface GltfNodeChainTargets {
  /** The chain node carrying the animated translation. */
  readonly translationNode: number;
  /** The chain node carrying the animated rotation and scale. */
  readonly rotationScaleNode: number;
}

const smoothstepCurve = (u: number): number => u * u * (3 - 2 * u);

const channelOf = (track: AnimationTrack): TrackProperty["channel"] => {
  const first = track.keyframes[0];
  if (first === undefined) return "translation";
  const channel = first.property.channel;
  // Model validation does not yet enforce a single channel per track, and
  // a hostile document could otherwise make the exporter emit a sampler
  // whose output width disagrees with its values. Reject it defensively.
  for (const keyframe of track.keyframes) {
    if (keyframe.property.channel !== channel) {
      throw new WorkspaceError({
        family: "validation",
        code: "GLTF_TRACK_CHANNEL_MISMATCH",
        message:
          "All keyframes of one animation track must target the same property channel",
        context: { trackId: track.trackId },
      });
    }
  }
  return channel;
};

/** Component-wise lerp or shortest-path quaternion SLERP (ADR-0006). */
function blendValue(
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
 * Converts one track to a glTF sampler, or undefined when the track has
 * no keyframes (no motion). `clipDuration` bounds the constant sample of
 * a single-keyframe track.
 */
export function buildTrackSamples(
  track: AnimationTrack,
  clipDuration: number,
  limits: GltfExportLimits,
): GltfAnimationSampler | undefined {
  const keyframes = track.keyframes;
  const first = keyframes[0];
  if (first === undefined) return undefined;
  const channel = channelOf(track);
  const outputType = channel === "rotation" ? "VEC4" : "VEC3";

  if (keyframes.length === 1) {
    // Constant track: one authored sample cannot form a valid glTF
    // sampler (input times must be strictly increasing and consumers
    // expect at least two samples), so emit the constant over the clip.
    const value = first.property.value;
    return {
      input: Float32Array.from([0, clipDuration]),
      output: Float32Array.from([...value, ...value]),
      interpolation: GLTF_INTERPOLATION_LINEAR,
      outputType,
    };
  }

  if (track.interpolation === "step" || track.interpolation === "linear") {
    const input: number[] = [];
    const output: number[] = [];
    const push = (time: number, value: readonly number[]): void => {
      input.push(time);
      output.push(...value);
    };
    // The runtime holds the first value before the first keyframe and the
    // last value after the last keyframe (packages/animation/src/sample.ts),
    // so a sampler over only the authored times would drop the Clip's
    // leading and trailing hold intervals. Emit held boundary samples at 0
    // and clipDuration unless an authored key already lies there (issue
    // #99); identical adjacent values keep LINEAR/STEP segments constant.
    if (first.time > 0) push(0, first.property.value);
    for (const keyframe of keyframes) {
      push(keyframe.time, keyframe.property.value);
    }
    const last = keyframes[keyframes.length - 1];
    if (last !== undefined && last.time < clipDuration) {
      push(clipDuration, last.property.value);
    }
    return {
      input: Float32Array.from(input),
      output: Float32Array.from(output),
      interpolation:
        track.interpolation === "step"
          ? GLTF_INTERPOLATION_STEP
          : GLTF_INTERPOLATION_LINEAR,
      outputType,
    };
  }

  // Smoothstep: bake each segment to linear samples. The first and last
  // authored values are reproduced bit for bit; interior samples follow
  // the frozen ease curve u^2 * (3 - 2u) on the local blend factor,
  // matching the runtime sampler exactly (ADR-0006; the curve and blend
  // mirror packages/animation/src/sample.ts on purpose, because formats
  // must not depend on the animation package).
  const interior = limits.maxSmoothstepSamplesPerSegment;
  const input: number[] = [];
  const output: number[] = [];
  const push = (time: number, value: readonly number[]): void => {
    input.push(time);
    output.push(...value);
  };
  // The runtime holds the first value before the first keyframe and the
  // last value after the last keyframe (packages/animation/src/sample.ts),
  // so the baked sampler must cover [0, clipDuration] with the authored
  // endpoint values held outside the keyframe range (issue #99). The
  // leading sample is pushed before the segments so inputs stay strictly
  // increasing; the trailing sample after the final authored key.
  if (first.time > 0) push(0, first.property.value);
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const lower = keyframes[index];
    const upper = keyframes[index + 1];
    if (lower === undefined || upper === undefined) continue;
    const span = upper.time - lower.time;
    push(lower.time, lower.property.value);
    for (let step = 1; step <= interior; step += 1) {
      const u = step / (interior + 1);
      const time = lower.time + u * span;
      push(
        time,
        blendValue(
          channel,
          lower.property.value,
          upper.property.value,
          smoothstepCurve(u),
        ),
      );
    }
  }
  const last = keyframes[keyframes.length - 1];
  if (last !== undefined) push(last.time, last.property.value);
  if (last !== undefined && last.time < clipDuration) {
    push(clipDuration, last.property.value);
  }
  return {
    input: Float32Array.from(input),
    output: Float32Array.from(output),
    interpolation: GLTF_INTERPOLATION_LINEAR,
    outputType,
  };
}

/**
 * Preflight losses for animated export (ADR-0011): loop policy is not
 * representable in glTF and is reported per `loop` clip; smoothstep
 * tracks are deterministically baked and reported per track. Callers
 * merge these into the export loss report.
 */
export function preflightGltfAnimations(
  document: VoxelDocument,
): readonly GltfExportLoss[] {
  const losses: GltfExportLoss[] = [];
  // Canonical animation-id order, so the loss report is identical whether
  // the document was created in memory or parsed from disk (ARCHITECTURE
  // determinism goal; the plan sorts the same way).
  const clips = Object.entries(document.animations).sort((a, b) =>
    compareCodeUnit(a[0], b[0]),
  );
  for (const [, animation] of clips) {
    if (animation.loop === "loop") {
      losses.push({
        code: GLTF_EXPORT_LOSSES.clipLoop,
        message:
          "glTF cannot encode playback looping; downstream playback must enable looping for this clip",
        severity: "bake",
        context: {
          animationId: animation.animationId,
          name: animation.name ?? "",
        },
      });
    }
    for (const track of animation.tracks) {
      if (track.interpolation === "smoothstep" && track.keyframes.length > 0) {
        losses.push({
          code: GLTF_EXPORT_LOSSES.smoothstep,
          message:
            "Smoothstep interpolation is baked to linear samples within the export limits",
          severity: "bake",
          context: { trackId: track.trackId },
        });
      }
    }
  }
  return losses;
}

/**
 * Builds the deterministic glTF animations for a document after a
 * successful preflight: clips in canonical animation-id order, tracks in
 * canonical track-id order, channels targeting the exported node chains.
 * Clips whose tracks all carry no keyframes produce no animation.
 */
export function planGltfAnimations(
  document: VoxelDocument,
  chainTargets: ReadonlyMap<NodeId, GltfNodeChainTargets>,
  limits: GltfExportLimits,
): {
  readonly animations: readonly GltfAnimationExport[];
  readonly clips: number;
} {
  const animations: GltfAnimationExport[] = [];
  const names = new NameAllocator();
  const clips = Object.entries(document.animations).sort((a, b) =>
    compareCodeUnit(a[0], b[0]),
  );
  clips.forEach(([, clip], clipIndex) => {
    const name = names.allocate(
      sanitizeGltfName(clip.name),
      `Clip ${String(clipIndex + 1)}`,
    );
    const samplers: GltfAnimationSampler[] = [];
    const channels: GltfAnimationChannel[] = [];
    const tracks = [...clip.tracks].sort((a, b) =>
      compareCodeUnit(a.trackId, b.trackId),
    );
    for (const track of tracks) {
      const samples = buildTrackSamples(track, clip.duration, limits);
      if (samples === undefined) continue;
      const targets = chainTargets.get(track.targetNodeId);
      if (targets === undefined) {
        // Every document node gets an exported chain; unreachable, and a
        // silent drop would lose a track without a loss report (ADR-0011).
        throw new WorkspaceError({
          family: "internal",
          code: "GLTF_NODE_MISSING",
          message: "Animated node missing from the export node table",
          context: { nodeId: track.targetNodeId, trackId: track.trackId },
        });
      }
      const channel = channelOf(track);
      const node =
        channel === "rotation" || channel === "scale"
          ? targets.rotationScaleNode
          : targets.translationNode;
      samplers.push(samples);
      channels.push({ sampler: samplers.length - 1, node, path: channel });
    }
    if (channels.length === 0) return;
    animations.push({ name, channels, samplers });
  });
  return { animations, clips: animations.length };
}
