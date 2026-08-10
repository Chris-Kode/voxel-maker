import { describe, expect, it } from "vitest";
import {
  animationId,
  keyframeId,
  materialId,
  nodeId,
  trackId,
  volumeId,
  type NodeId,
} from "@voxel-maker/shared";
import {
  createDocument,
  type AnimationTrack,
  type VoxelDocument,
} from "@voxel-maker/model";
import {
  DEFAULT_GLTF_EXPORT_LIMITS,
  GLTF_EXPORT_LOSSES,
  type GltfExportLimits,
} from "./gltf-types.js";
import {
  buildTrackSamples,
  planGltfAnimations,
  preflightGltfAnimations,
  type GltfNodeChainTargets,
} from "./gltf-animation.js";
import { planGltfExport, preflightGltfExport } from "./gltf-mapping.js";
import { createDocumentStore } from "@voxel-maker/document";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";

/**
 * Clip -> glTF animation mapping (plan S16.4, ticket #42): TRS channel
 * mapping, interpolation conversion (step/linear direct, smoothstep
 * baked), quaternion values, loop-policy and smoothstep losses, and the
 * deterministic channel targets for pivot helper chains.
 */

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:anim:root");
const BODY = nodeId("node:anim:body");
const ARM = nodeId("node:anim:arm");
const VOLUME_BODY = volumeId("volume:anim:body");
const VOLUME_ARM = volumeId("volume:anim:arm");

const LOW_LIMITS: GltfExportLimits = {
  ...DEFAULT_GLTF_EXPORT_LIMITS,
  maxSmoothstepSamplesPerSegment: 2,
};

const rotationTrack = (
  track: string,
  target: NodeId,
  interpolation: "step" | "linear" | "smoothstep",
  times: number[],
  values: readonly (readonly [number, number, number, number])[],
) => ({
  trackId: trackId(track),
  targetNodeId: target,
  interpolation,
  keyframes: times.map((time, index) => {
    const value = values[index];
    if (value === undefined) throw new Error("missing value");
    return {
      keyframeId: keyframeId(`key:${track}:${String(index)}`),
      time,
      property: { channel: "rotation" as const, value },
    };
  }),
});

function animatedDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:anim:0001" as never,
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [BODY, ARM],
        transform: identity,
        components: [],
      },
      {
        nodeId: BODY,
        name: "Body",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: VOLUME_BODY },
        ],
      },
      {
        nodeId: ARM,
        name: "Arm",
        parentId: ROOT,
        children: [],
        transform: {
          translation: [1, 2, 0],
          pivot: [0, 1, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME_ARM }],
      },
    ],
    volumes: [{ volumeId: VOLUME_BODY }, { volumeId: VOLUME_ARM }],
    materials: [
      {
        materialId: materialId(1),
        name: "body",
        color: "#ffffff",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    animations: [
      {
        animationId: animationId("animation:anim:z"),
        name: "Z Clip",
        duration: 2,
        loop: "loop",
        tracks: [
          rotationTrack(
            "track:anim:z",
            ARM,
            "linear",
            [0, 1, 2],
            [
              [0, 0, 0, 1],
              [0, 0, Math.SQRT1_2, Math.SQRT1_2],
              [0, 0, 1, 0],
            ],
          ),
        ],
      },
      {
        animationId: animationId("animation:anim:a"),
        name: "A Clip",
        duration: 1,
        loop: "once",
        tracks: [
          {
            trackId: trackId("track:anim:a:trans"),
            targetNodeId: BODY,
            interpolation: "linear",
            keyframes: [
              {
                keyframeId: keyframeId("key:anim:a:trans:0"),
                time: 0,
                property: { channel: "translation", value: [0, 0, 0] },
              },
              {
                keyframeId: keyframeId("key:anim:a:trans:1"),
                time: 1,
                property: { channel: "translation", value: [3, 0, 0] },
              },
            ],
          },
          {
            trackId: trackId("track:anim:a:smooth"),
            targetNodeId: ARM,
            interpolation: "smoothstep",
            keyframes: [
              {
                keyframeId: keyframeId("key:anim:a:smooth:0"),
                time: 0,
                property: { channel: "scale", value: [1, 1, 1] },
              },
              {
                keyframeId: keyframeId("key:anim:a:smooth:1"),
                time: 1,
                property: { channel: "scale", value: [2, 1, 1] },
              },
            ],
          },
          {
            trackId: trackId("track:anim:a:empty"),
            targetNodeId: BODY,
            interpolation: "linear",
            keyframes: [],
          },
          {
            trackId: trackId("track:anim:a:single"),
            targetNodeId: BODY,
            interpolation: "step",
            keyframes: [
              {
                keyframeId: keyframeId("key:anim:a:single:0"),
                time: 0.5,
                property: { channel: "translation", value: [9, 9, 9] },
              },
            ],
          },
        ],
      },
    ],
  });
}

function storeWithVoxels(document: VoxelDocument) {
  const chunks = new Map<string, VoxelChunkSeed>();
  const chunk = {
    coordinate: [0, 0, 0] as [number, number, number],
    values: new Uint16Array(4096),
  };
  chunk.values[0] = 1;
  chunks.set("0,0,0", chunk);
  return createDocumentStore({
    document,
    volumes: new Map([
      [VOLUME_BODY, [chunk]],
      [VOLUME_ARM, [chunk]],
    ]),
  });
}

describe("preflightGltfAnimations", () => {
  it("reports the loop-policy limitation per loop clip", () => {
    const losses = preflightGltfAnimations(animatedDocument());
    const loop = losses.filter(
      (loss) => loss.code === GLTF_EXPORT_LOSSES.clipLoop,
    );
    expect(loop).toHaveLength(1);
    expect(loop[0]?.context).toMatchObject({ animationId: "animation:anim:z" });
  });

  it("reports one bake loss per smoothstep track", () => {
    const losses = preflightGltfAnimations(animatedDocument());
    const smooth = losses.filter(
      (loss) => loss.code === GLTF_EXPORT_LOSSES.smoothstep,
    );
    expect(smooth).toHaveLength(1);
    expect(smooth[0]?.context).toMatchObject({
      trackId: "track:anim:a:smooth",
    });
  });

  it("does not report smoothstep for a track without keyframes", () => {
    const rebuilt = createDocument({
      documentId: "document:anim:emptysmooth" as never,
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [BODY],
          transform: identity,
          components: [],
        },
        {
          nodeId: BODY,
          name: "Body",
          parentId: ROOT,
          children: [],
          transform: identity,
          components: [
            { kind: "voxel", schemaVersion: 1, volumeId: VOLUME_BODY },
          ],
        },
      ],
      materials: [],
      volumes: [{ volumeId: VOLUME_BODY }],
      animations: [
        {
          animationId: animationId("animation:anim:emptysmooth"),
          name: "Empty Smooth",
          duration: 1,
          loop: "once",
          tracks: [
            {
              trackId: trackId("track:anim:emptysmooth"),
              targetNodeId: BODY,
              interpolation: "smoothstep",
              keyframes: [],
            },
          ],
        },
      ],
    });
    expect(preflightGltfAnimations(rebuilt)).toEqual([]);
  });

  it("reports nothing for a clip with once/linear content only", () => {
    // Rebuild through createDocument to canonicalize the record.
    const rebuilt = createDocument({
      documentId: "document:anim:clean" as never,
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [BODY],
          transform: identity,
          components: [],
        },
        {
          nodeId: BODY,
          name: "Body",
          parentId: ROOT,
          children: [],
          transform: identity,
          components: [],
        },
      ],
      materials: [],
      volumes: [],
      animations: [
        {
          animationId: animationId("animation:anim:clean"),
          name: "Clean",
          duration: 1,
          loop: "once",
          tracks: [
            rotationTrack(
              "track:anim:clean",
              BODY,
              "step",
              [0, 1],
              [
                [0, 0, 0, 1],
                [0, 0, 0, 1],
              ],
            ),
          ],
        },
      ],
    });
    expect(preflightGltfAnimations(rebuilt)).toEqual([]);
  });
});

describe("buildTrackSamples", () => {
  it("maps step and linear tracks directly with authored values", () => {
    const linear =
      animatedDocument().animations[animationId("animation:anim:z")];
    const track = linear?.tracks[0];
    expect(track).toBeDefined();
    const samples = buildTrackSamples(
      track as never,
      linear?.duration ?? 0,
      LOW_LIMITS,
    );
    expect(samples?.interpolation).toBe("LINEAR");
    expect(samples?.outputType).toBe("VEC4");
    expect([...(samples?.input ?? [])]).toEqual([0, 1, 2]);
    expect([...(samples?.output ?? [])]).toEqual([
      0,
      0,
      0,
      1, //
      0,
      0,
      Math.fround(Math.SQRT1_2),
      Math.fround(Math.SQRT1_2), //
      0,
      0,
      1,
      0,
    ]);
  });

  it("maps step interpolation to STEP", () => {
    const document = createDocument({
      documentId: "document:anim:step" as never,
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [BODY],
          transform: identity,
          components: [],
        },
        {
          nodeId: BODY,
          name: "Body",
          parentId: ROOT,
          children: [],
          transform: identity,
          components: [
            { kind: "voxel", schemaVersion: 1, volumeId: VOLUME_BODY },
          ],
        },
      ],
      materials: [],
      volumes: [{ volumeId: VOLUME_BODY }],
      animations: [
        {
          animationId: animationId("animation:anim:step"),
          name: "Step",
          duration: 1,
          loop: "once",
          tracks: [
            rotationTrack(
              "track:anim:step",
              BODY,
              "step",
              [0, 1],
              [
                [0, 0, 0, 1],
                [0, 0, 0, 1],
              ],
            ),
          ],
        },
      ],
    });
    const animations = document.animations as Readonly<
      Record<
        string,
        (typeof document.animations)[keyof typeof document.animations]
      >
    >;
    const clip = animations["animation:anim:step"];
    const track = clip?.tracks[0];
    const samples = buildTrackSamples(
      track as never,
      clip?.duration ?? 1,
      LOW_LIMITS,
    );
    expect(samples?.interpolation).toBe("STEP");
    expect(samples?.outputType).toBe("VEC4");
    expect([...(samples?.input ?? [])]).toEqual([0, 1]);
  });

  it("holds the first and last values across the whole clip duration (issue #99)", () => {
    // A 4-second clip keyed at 1s and 2s must export the runtime's
    // leading and trailing hold intervals: strictly increasing inputs
    // [0, 1, 2, 4] with the endpoint values held bit for bit, so a
    // consumer sampling the exported sampler matches the runtime
    // (packages/animation/src/sample.ts holds the first value before the
    // first keyframe and the last value after the last keyframe).
    const track: AnimationTrack = {
      trackId: trackId("track:issue99:linear"),
      targetNodeId: BODY,
      interpolation: "linear",
      keyframes: [
        {
          keyframeId: keyframeId("key:issue99:linear:0"),
          time: 1,
          property: { channel: "translation", value: [10, 0, 0] },
        },
        {
          keyframeId: keyframeId("key:issue99:linear:1"),
          time: 2,
          property: { channel: "translation", value: [20, 0, 0] },
        },
      ],
    };
    const samples = buildTrackSamples(track, 4, LOW_LIMITS);
    expect(samples?.interpolation).toBe("LINEAR");
    expect([...(samples?.input ?? [])]).toEqual([0, 1, 2, 4]);
    expect([...(samples?.output ?? [])]).toEqual([
      10,
      0,
      0, //
      10,
      0,
      0, //
      20,
      0,
      0, //
      20,
      0,
      0,
    ]);
  });

  it("matches the runtime's hold semantics across the whole clip (issue #99)", () => {
    // Evaluate the exported LINEAR sampler at regular times and compare
    // against the runtime policy documented by packages/animation/src/
    // sample.ts: hold the first value before the first keyframe, lerp
    // between authored keys, hold the last value after the last keyframe.
    const track: AnimationTrack = {
      trackId: trackId("track:issue99:match"),
      targetNodeId: BODY,
      interpolation: "linear",
      keyframes: [
        {
          keyframeId: keyframeId("key:issue99:match:0"),
          time: 1,
          property: { channel: "translation", value: [10, 0, 0] },
        },
        {
          keyframeId: keyframeId("key:issue99:match:1"),
          time: 2,
          property: { channel: "translation", value: [20, 0, 0] },
        },
      ],
    };
    const samples = buildTrackSamples(track, 4, LOW_LIMITS);
    const input = [...(samples?.input ?? [])];
    const output = [...(samples?.output ?? [])];
    const at = (time: number): readonly number[] => {
      const upper = input.findIndex((candidate) => candidate > time);
      if (upper === -1) {
        return output.slice((input.length - 1) * 3, input.length * 3);
      }
      if (upper <= 0) return output.slice(0, 3);
      const lower = upper - 1;
      const a = output.slice(lower * 3, lower * 3 + 3);
      const b = output.slice(upper * 3, upper * 3 + 3);
      const span = (input[upper] ?? 0) - (input[lower] ?? 0);
      const u = (time - (input[lower] ?? 0)) / span;
      return [0, 1, 2].map(
        (index) => (a[index] ?? 0) + ((b[index] ?? 0) - (a[index] ?? 0)) * u,
      );
    };
    // Runtime policy: [10,0,0] over [0,1], lerp 10->20 over [1,2],
    // [20,0,0] over [2,4].
    const expected: readonly (readonly [number, readonly number[]])[] = [
      [0, [10, 0, 0]],
      [0.5, [10, 0, 0]],
      [1, [10, 0, 0]],
      [1.5, [15, 0, 0]],
      [2, [20, 0, 0]],
      [2.5, [20, 0, 0]],
      [3, [20, 0, 0]],
      [3.5, [20, 0, 0]],
      [4, [20, 0, 0]],
    ];
    for (const [time, value] of expected) {
      expect(at(time), `time ${String(time)}`).toEqual(value);
    }
  });

  it("holds STEP boundaries without changing the interpolation mode (issue #99)", () => {
    const track: AnimationTrack = {
      trackId: trackId("track:issue99:step"),
      targetNodeId: BODY,
      interpolation: "step",
      keyframes: [
        {
          keyframeId: keyframeId("key:issue99:step:0"),
          time: 1,
          property: { channel: "translation", value: [10, 0, 0] },
        },
        {
          keyframeId: keyframeId("key:issue99:step:1"),
          time: 2,
          property: { channel: "translation", value: [20, 0, 0] },
        },
      ],
    };
    const samples = buildTrackSamples(track, 4, LOW_LIMITS);
    expect(samples?.interpolation).toBe("STEP");
    expect([...(samples?.input ?? [])]).toEqual([0, 1, 2, 4]);
    expect([...(samples?.output ?? [])]).toEqual([
      10,
      0,
      0, //
      10,
      0,
      0, //
      20,
      0,
      0, //
      20,
      0,
      0,
    ]);
  });

  it("holds smoothstep boundaries around the baked segment (issue #99)", () => {
    const track: AnimationTrack = {
      trackId: trackId("track:issue99:smooth"),
      targetNodeId: BODY,
      interpolation: "smoothstep",
      keyframes: [
        {
          keyframeId: keyframeId("key:issue99:smooth:0"),
          time: 1,
          property: { channel: "scale", value: [1, 1, 1] },
        },
        {
          keyframeId: keyframeId("key:issue99:smooth:1"),
          time: 2,
          property: { channel: "scale", value: [2, 1, 1] },
        },
      ],
    };
    const samples = buildTrackSamples(track, 4, LOW_LIMITS);
    expect(samples?.interpolation).toBe("LINEAR");
    // Segment [1,2] with 2 interior samples: 1, 4/3, 5/3, 2 (float32),
    // plus the held boundaries at 0 and 4.
    expect([...(samples?.input ?? [])]).toEqual([
      0,
      1,
      Math.fround(4 / 3),
      Math.fround(5 / 3),
      2,
      4,
    ]);
    const scale = (u: number) => 1 + (2 - 1) * (u * u * (3 - 2 * u));
    const outputs = [...(samples?.output ?? [])];
    expect(outputs.slice(0, 3)).toEqual([1, 1, 1]);
    expect(outputs.slice(3, 6)).toEqual([1, 1, 1]);
    expect(outputs.slice(6, 9)).toEqual([Math.fround(scale(1 / 3)), 1, 1]);
    expect(outputs.slice(9, 12)).toEqual([Math.fround(scale(2 / 3)), 1, 1]);
    expect(outputs.slice(12, 15)).toEqual([2, 1, 1]);
    expect(outputs.slice(15, 18)).toEqual([2, 1, 1]);
  });

  it("adds only the missing boundary sample on each side (issue #99)", () => {
    // First key already at 0: only the trailing hold is added.
    const leading = buildTrackSamples(
      {
        trackId: trackId("track:issue99:leading"),
        targetNodeId: BODY,
        interpolation: "linear",
        keyframes: [
          {
            keyframeId: keyframeId("key:issue99:leading:0"),
            time: 0,
            property: { channel: "translation", value: [1, 0, 0] },
          },
          {
            keyframeId: keyframeId("key:issue99:leading:1"),
            time: 0.5,
            property: { channel: "translation", value: [2, 0, 0] },
          },
        ],
      },
      1,
      LOW_LIMITS,
    );
    expect([...(leading?.input ?? [])]).toEqual([0, 0.5, 1]);
    // Last key already at the clip duration: only the leading hold is added.
    const trailing = buildTrackSamples(
      {
        trackId: trackId("track:issue99:trailing"),
        targetNodeId: BODY,
        interpolation: "linear",
        keyframes: [
          {
            keyframeId: keyframeId("key:issue99:trailing:0"),
            time: 0.5,
            property: { channel: "translation", value: [1, 0, 0] },
          },
          {
            keyframeId: keyframeId("key:issue99:trailing:1"),
            time: 1,
            property: { channel: "translation", value: [2, 0, 0] },
          },
        ],
      },
      1,
      LOW_LIMITS,
    );
    expect([...(trailing?.input ?? [])]).toEqual([0, 0.5, 1]);
    expect([...(trailing?.output ?? [])]).toEqual([
      1,
      0,
      0, //
      1,
      0,
      0, //
      2,
      0,
      0,
    ]);
  });

  it("bakes smoothstep to linear samples with the frozen ease curve", () => {
    const clip = animatedDocument().animations[animationId("animation:anim:a")];
    const track = clip?.tracks.find(
      (candidate) => candidate.trackId === "track:anim:a:smooth",
    );
    const samples = buildTrackSamples(
      track as never,
      clip?.duration ?? 1,
      LOW_LIMITS,
    );
    expect(samples?.interpolation).toBe("LINEAR");
    expect(samples?.outputType).toBe("VEC3");
    // Segment [0,1] with 2 interior samples: 0, 1/3, 2/3, 1 (float32).
    const oneThird = Math.fround(1 / 3);
    const twoThirds = Math.fround(2 / 3);
    expect([...(samples?.input ?? [])]).toEqual([0, oneThird, twoThirds, 1]);
    const scale = (u: number) => 1 + (2 - 1) * (u * u * (3 - 2 * u));
    const outputs = [...(samples?.output ?? [])];
    expect(outputs.slice(0, 3)).toEqual([1, 1, 1]);
    expect(outputs.slice(3, 6)).toEqual([Math.fround(scale(1 / 3)), 1, 1]);
    expect(outputs.slice(6, 9)).toEqual([Math.fround(scale(2 / 3)), 1, 1]);
    expect(outputs.slice(9, 12)).toEqual([2, 1, 1]);
  });

  it("emits a constant two-sample sampler for a single-keyframe track", () => {
    const clip = animatedDocument().animations[animationId("animation:anim:a")];
    const track = clip?.tracks.find(
      (candidate) => candidate.trackId === "track:anim:a:single",
    );
    const samples = buildTrackSamples(
      track as never,
      clip?.duration ?? 1,
      LOW_LIMITS,
    );
    expect([...(samples?.input ?? [])]).toEqual([0, 1]);
    expect([...(samples?.output ?? [])]).toEqual([9, 9, 9, 9, 9, 9]);
    expect(samples?.interpolation).toBe("LINEAR");
  });

  it("returns undefined for a track without keyframes", () => {
    const clip = animatedDocument().animations[animationId("animation:anim:a")];
    const track = clip?.tracks.find(
      (candidate) => candidate.trackId === "track:anim:a:empty",
    );
    expect(
      buildTrackSamples(track as never, clip?.duration ?? 1, LOW_LIMITS),
    ).toBeUndefined();
  });

  it("rejects a track whose keyframes mix property channels", () => {
    const track: AnimationTrack = {
      trackId: trackId("track:anim:mixed"),
      targetNodeId: BODY,
      interpolation: "linear",
      keyframes: [
        {
          keyframeId: keyframeId("key:anim:mixed:0"),
          time: 0,
          property: { channel: "rotation", value: [0, 0, 0, 1] },
        },
        {
          keyframeId: keyframeId("key:anim:mixed:1"),
          time: 1,
          property: { channel: "scale", value: [1, 1, 1] },
        },
      ],
    };
    let thrown: unknown;
    try {
      buildTrackSamples(track, 1, LOW_LIMITS);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ family: "validation" });
  });
});

describe("planGltfAnimations", () => {
  it("orders clips and tracks canonically and maps channels to chain targets", () => {
    const document = animatedDocument();
    const targets = new Map<NodeId, GltfNodeChainTargets>([
      [BODY, { translationNode: 1, rotationScaleNode: 1 }],
      [ARM, { translationNode: 2, rotationScaleNode: 3 }],
      [ROOT, { translationNode: 0, rotationScaleNode: 0 }],
    ]);
    const { animations, clips } = planGltfAnimations(
      document,
      targets,
      LOW_LIMITS,
    );
    expect(clips).toBe(2);
    // Canonical animation-id order: animation:anim:a before animation:anim:z.
    expect(animations.map((animation) => animation.name)).toEqual([
      "A Clip",
      "Z Clip",
    ]);
    const a = animations[0];
    expect(a?.channels.map((channel) => channel.path)).toEqual([
      "translation",
      "scale",
      "translation",
    ]);
    expect(a?.channels[0]?.node).toBe(1); // BODY translation -> chain head
    expect(a?.channels[1]?.node).toBe(3); // ARM scale -> pivot helper
    expect(a?.channels[2]?.node).toBe(1); // BODY single-keyframe translation
    // The empty track produced no channel.
    expect(a?.samplers).toHaveLength(3);
    expect(a?.channels[0]?.sampler).toBe(0);
    expect(a?.channels[1]?.sampler).toBe(1);
    expect(a?.channels[2]?.sampler).toBe(2);
    const z = animations[1];
    expect(z?.channels).toEqual([{ sampler: 0, node: 3, path: "rotation" }]);
  });

  it("skips clips whose tracks all carry no keyframes", () => {
    const document = createDocument({
      documentId: "document:anim:empty" as never,
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [BODY],
          transform: identity,
          components: [],
        },
        {
          nodeId: BODY,
          name: "Body",
          parentId: ROOT,
          children: [],
          transform: identity,
          components: [],
        },
      ],
      materials: [],
      volumes: [],
      animations: [
        {
          animationId: animationId("animation:anim:empty"),
          name: "Empty",
          duration: 1,
          loop: "once",
          tracks: [
            {
              trackId: trackId("track:anim:empty"),
              targetNodeId: BODY,
              interpolation: "linear",
              keyframes: [],
            },
          ],
        },
      ],
    });
    const { animations } = planGltfAnimations(
      document,
      new Map<NodeId, GltfNodeChainTargets>(),
      LOW_LIMITS,
    );
    expect(animations).toEqual([]);
  });
});

describe("preflightGltfExport with animations", () => {
  it("maps clips by default and reports only unrepresentable parts", () => {
    const document = animatedDocument();
    const store = storeWithVoxels(document);
    const preflight = preflightGltfExport(document, (id) =>
      store.getVolume(id),
    );
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const codes = new Set(preflight.losses.map((loss) => loss.code));
    expect(codes.has(GLTF_EXPORT_LOSSES.clips)).toBe(false);
    expect(codes.has(GLTF_EXPORT_LOSSES.clipLoop)).toBe(true);
    expect(codes.has(GLTF_EXPORT_LOSSES.smoothstep)).toBe(true);
  });

  it("reports the clips loss in static-only mode", () => {
    const document = animatedDocument();
    const store = storeWithVoxels(document);
    const preflight = preflightGltfExport(
      document,
      (id) => store.getVolume(id),
      { includeAnimations: false },
    );
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const codes = new Set(preflight.losses.map((loss) => loss.code));
    expect(codes.has(GLTF_EXPORT_LOSSES.clips)).toBe(true);
    expect(codes.has(GLTF_EXPORT_LOSSES.clipLoop)).toBe(false);
    expect(codes.has(GLTF_EXPORT_LOSSES.smoothstep)).toBe(false);
  });
});

describe("planGltfExport with animations", () => {
  it("plans animations with channels targeting the exported chains", () => {
    const document = animatedDocument();
    const store = storeWithVoxels(document);
    const preflight = preflightGltfExport(document, (id) =>
      store.getVolume(id),
    );
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const plan = planGltfExport(
      document,
      (id) => store.getVolume(id),
      preflight,
      LOW_LIMITS,
    );
    expect(plan.metadata.clips).toBe(2);
    expect(plan.animations).toBeDefined();
    expect(plan.animations ?? []).toHaveLength(2);
    // Canonical node order: node:anim:arm (pivot chain: arm, arm pivot,
    // arm pivot offset), node:anim:body, node:anim:root.
    expect(plan.nodes.map((node) => node.name)).toEqual([
      "Arm",
      "Arm pivot",
      "Arm pivot offset",
      "Body",
      "Root",
    ]);
    const animations = plan.animations ?? [];
    const a = animations[0];
    const z = animations[1];
    // ARM rotation channel targets the pivot helper (index 1).
    expect(z?.channels[0]?.node).toBe(1);
    expect(z?.channels[0]?.path).toBe("rotation");
    // BODY translation targets the single node (index 3).
    expect(a?.channels[0]?.node).toBe(3);
    // ARM scale targets the pivot helper (index 1).
    expect(a?.channels[1]?.node).toBe(1);
  });

  it("omits animations in static-only mode", () => {
    const document = animatedDocument();
    const store = storeWithVoxels(document);
    const preflight = preflightGltfExport(
      document,
      (id) => store.getVolume(id),
      { includeAnimations: false },
    );
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const plan = planGltfExport(
      document,
      (id) => store.getVolume(id),
      preflight,
      LOW_LIMITS,
      { includeAnimations: false },
    );
    expect(plan.metadata.clips).toBe(0);
    expect(plan.animations ?? []).toEqual([]);
  });
});
