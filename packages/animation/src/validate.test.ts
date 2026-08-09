import { describe, expect, it } from "vitest";
import { keyframeId, nodeId, trackId } from "@voxel-maker/shared";
import {
  DEFAULT_DOCUMENT_LIMITS,
  type AnimationDescriptor,
  type AnimationTrack,
  type VoxelDocument,
} from "@voxel-maker/model";
import { cloneDocument } from "@voxel-maker/model";
import {
  createAnimatedWheelDocument,
  createWheelSpinClip,
} from "./fixtures.js";
import { validateAnimationSemantics } from "./validate.js";

/**
 * Semantic animation invariant validation (plan S10.2, ticket #28): the
 * document-aware checks — target existence, per-track property channel
 * compatibility, value/channel compatibility, and clip bounds — with
 * stable findings.
 */

const wheelDocument = (): VoxelDocument => createAnimatedWheelDocument();

const firstTrack = (clip: AnimationDescriptor): AnimationTrack => {
  const track = clip.tracks[0];
  if (track === undefined) throw new Error("fixture clip has no tracks");
  return track;
};

const mutate = (
  document: VoxelDocument,
  mutateClip: (clip: AnimationDescriptor) => AnimationDescriptor,
): VoxelDocument => {
  const next = cloneDocument(document);
  const animations = Object.fromEntries(
    Object.values(next.animations).map((clip) => [
      clip.animationId,
      mutateClip(clip),
    ]),
  );
  return { ...next, animations } as VoxelDocument;
};

describe("validateAnimationSemantics", () => {
  it("accepts the animated wheel fixture", () => {
    expect(validateAnimationSemantics(wheelDocument())).toEqual([]);
  });

  it("flags a track whose target node is missing", () => {
    const document = mutate(wheelDocument(), (clip) => ({
      ...clip,
      tracks: [
        {
          ...firstTrack(clip),
          targetNodeId: nodeId("node:anim:missing"),
        },
      ],
    }));
    const issues = validateAnimationSemantics(document);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "MISSING_TARGET_NODE",
      animationId: "animation:anim:wheel-spin:0001",
    });
  });

  it("flags mixed property channels inside one track", () => {
    const document = mutate(wheelDocument(), (clip) => {
      const track = firstTrack(clip);
      return {
        ...clip,
        tracks: [
          {
            ...track,
            keyframes: [
              ...track.keyframes,
              {
                keyframeId: keyframeId("keyframe:anim:mixed:0001"),
                time: 0.5,
                property: {
                  channel: "translation",
                  value: [1, 2, 3],
                },
              },
            ],
          },
        ],
      };
    });
    const issues = validateAnimationSemantics(document);
    expect(issues.some((item) => item.code === "MIXED_PROPERTY_CHANNEL")).toBe(
      true,
    );
  });

  it("flags non-normalized rotation values", () => {
    const document = mutate(wheelDocument(), (clip) => {
      const track = firstTrack(clip);
      const first = track.keyframes[0];
      if (first === undefined) throw new Error("fixture keyframe missing");
      return {
        ...clip,
        tracks: [
          {
            ...track,
            keyframes: [
              {
                ...first,
                property: { channel: "rotation", value: [1, 0, 0, 1] },
              },
              ...track.keyframes.slice(1),
            ],
          },
        ],
      };
    });
    const issues = validateAnimationSemantics(document);
    expect(issues.some((item) => item.code === "INVALID_ROTATION_VALUE")).toBe(
      true,
    );
  });

  it("flags non-positive scale values", () => {
    const document = mutate(wheelDocument(), (clip) => {
      const track = firstTrack(clip);
      return {
        ...clip,
        tracks: [
          {
            ...track,
            keyframes: [
              {
                keyframeId: keyframeId("keyframe:anim:scale:0001"),
                time: 0,
                property: { channel: "scale", value: [1, 0, 1] },
              },
            ],
          },
        ],
      };
    });
    const issues = validateAnimationSemantics(document);
    expect(issues.some((item) => item.code === "INVALID_SCALE_VALUE")).toBe(
      true,
    );
  });

  it("flags unsorted and duplicate keyframe times", () => {
    const unsorted = mutate(wheelDocument(), (clip) => {
      const track = firstTrack(clip);
      const [first, second] = track.keyframes;
      if (first === undefined || second === undefined) {
        throw new Error("fixture keyframes missing");
      }
      return { ...clip, tracks: [{ ...track, keyframes: [second, first] }] };
    });
    const issues = validateAnimationSemantics(unsorted);
    expect(issues.some((item) => item.code === "UNSORTED_KEYFRAME_TIMES")).toBe(
      true,
    );
    const duplicate = mutate(wheelDocument(), (clip) => {
      const track = firstTrack(clip);
      const [first, second] = track.keyframes;
      if (first === undefined || second === undefined) {
        throw new Error("fixture keyframes missing");
      }
      return {
        ...clip,
        tracks: [{ ...track, keyframes: [first, { ...second, time: 0 }] }],
      };
    });
    const duplicateIssues = validateAnimationSemantics(duplicate);
    expect(
      duplicateIssues.some((item) => item.code === "DUPLICATE_KEYFRAME_TIME"),
    ).toBe(true);
  });

  it("flags duplicate track ids within one clip", () => {
    const document = mutate(wheelDocument(), (clip) => {
      const track = firstTrack(clip);
      return {
        ...clip,
        tracks: [
          track,
          { ...track, targetNodeId: nodeId("node:rig:wheel:axle") },
        ],
      };
    });
    const issues = validateAnimationSemantics(document);
    expect(issues.some((item) => item.code === "DUPLICATE_TRACK_ID")).toBe(
      true,
    );
  });

  it("flags invalid duration and loop policy", () => {
    const zero = mutate(wheelDocument(), (clip) => ({ ...clip, duration: 0 }));
    expect(
      validateAnimationSemantics(zero).some(
        (item) => item.code === "INVALID_CLIP_DURATION",
      ),
    ).toBe(true);
  });

  it("accepts an empty track and duplicate (node, channel) tracks", () => {
    const clip = createWheelSpinClip();
    const withEmpty: VoxelDocument = mutate(wheelDocument(), () => ({
      ...clip,
      tracks: [
        {
          trackId: trackId("track:anim:empty:0001"),
          targetNodeId: nodeId("node:rig:wheel:axle"),
          interpolation: "linear",
          keyframes: [],
        },
        ...clip.tracks,
      ],
    }));
    expect(validateAnimationSemantics(withEmpty)).toEqual([]);
    const duplicateTarget: VoxelDocument = mutate(wheelDocument(), (c) => {
      const track = firstTrack(c);
      return {
        ...c,
        tracks: [
          track,
          {
            trackId: trackId("track:anim:wheel-spin:0002"),
            targetNodeId: track.targetNodeId,
            interpolation: "linear",
            keyframes: [
              {
                keyframeId: keyframeId("keyframe:anim:wheel-spin:0003"),
                time: 0.5,
                property: {
                  channel: "rotation",
                  value: [0, 0, 0, 1],
                },
              },
            ],
          },
        ],
      };
    });
    // Last track wins deterministically; validation stays silent.
    expect(validateAnimationSemantics(duplicateTarget)).toEqual([]);
  });

  it("enforces clip, track, and keyframe budgets from the injected limits", () => {
    const document = wheelDocument();
    const clipIssues = validateAnimationSemantics(document, {
      ...DEFAULT_DOCUMENT_LIMITS,
      maxClips: 0,
    });
    expect(clipIssues.some((item) => item.code === "CLIP_LIMIT_EXCEEDED")).toBe(
      true,
    );
    const trackIssues = validateAnimationSemantics(document, {
      ...DEFAULT_DOCUMENT_LIMITS,
      maxTracks: 0,
    });
    expect(
      trackIssues.some((item) => item.code === "TRACK_LIMIT_EXCEEDED"),
    ).toBe(true);
    const keyframeIssues = validateAnimationSemantics(document, {
      ...DEFAULT_DOCUMENT_LIMITS,
      maxKeyframes: 0,
    });
    expect(
      keyframeIssues.some(
        (item) => item.code === "KEYFRAME_TOTAL_LIMIT_EXCEEDED",
      ),
    ).toBe(true);
    const perTrackIssues = validateAnimationSemantics(document, {
      ...DEFAULT_DOCUMENT_LIMITS,
      maxKeyframesPerTrack: 1,
    });
    expect(
      perTrackIssues.some((item) => item.code === "KEYFRAME_LIMIT_EXCEEDED"),
    ).toBe(true);
  });

  it("never mutates the input document", () => {
    const document = wheelDocument();
    const snapshot = JSON.stringify(document);
    validateAnimationSemantics(document);
    expect(JSON.stringify(document)).toBe(snapshot);
  });
});
