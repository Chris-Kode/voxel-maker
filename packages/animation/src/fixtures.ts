import {
  animationId,
  documentId,
  keyframeId,
  materialId,
  nodeId,
  trackId,
  volumeId,
} from "@voxel-maker/shared";
import {
  createDocument,
  type AnimationDescriptor,
  type VoxelDocument,
} from "@voxel-maker/model";
import { quaternionFromAxisAngle, type Transform } from "@voxel-maker/math";

/**
 * Generic animation fixtures (plan S10.15 groundwork, ticket #28): clips
 * that animate generic rigs — a continuously spinning wheel and a hinged
 * chest lid — using only generic core symbols (nodes, tracks, keyframes).
 * The wheel document mirrors the rigging package's wheel fixture (same
 * node ids, so tests can cross-reference `@voxel-maker/rigging`); the
 * demo-level multi-category proofs land with ticket #30.
 */

const identity: Transform = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

const rotationKeyframe = (
  id: string,
  time: number,
  axis: readonly [number, number, number],
  angle: number,
) => ({
  keyframeId: keyframeId(id),
  time,
  property: {
    channel: "rotation" as const,
    value: quaternionFromAxisAngle(axis, angle),
  },
});

/** 90-degree spin of the wheel node around +Y over one second, looping. */
export function createWheelSpinClip(): AnimationDescriptor {
  return {
    animationId: animationId("animation:anim:wheel-spin:0001"),
    name: "Wheel Spin",
    duration: 1,
    loop: "loop",
    tracks: [
      {
        trackId: trackId("track:anim:wheel-spin:0001"),
        targetNodeId: nodeId("node:rig:wheel:wheel"),
        interpolation: "linear",
        keyframes: [
          rotationKeyframe("keyframe:anim:wheel-spin:0001", 0, [0, 1, 0], 0),
          rotationKeyframe(
            "keyframe:anim:wheel-spin:0002",
            1,
            [0, 1, 0],
            Math.PI / 2,
          ),
        ],
      },
    ],
  };
}

/**
 * A wheel document with the spin clip embedded: the fixture pair tests
 * sampling, clip evaluation, layered runtime evaluation, and playback
 * against the generic wheel rig from ticket #26.
 */
export function createAnimatedWheelDocument(): VoxelDocument {
  const wheel = nodeId("node:rig:wheel:wheel");
  const axle = nodeId("node:rig:wheel:axle");
  return createDocument({
    documentId: documentId("document:anim:wheel:0001"),
    metadata: { title: "animated wheel", kind: "fixture" },
    rootNodeId: axle,
    nodes: [
      {
        nodeId: axle,
        name: "Axle",
        parentId: null,
        children: [wheel],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:anim:wheel:axle"),
          },
        ],
      },
      {
        nodeId: wheel,
        name: "Wheel",
        parentId: axle,
        children: [],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:anim:wheel:wheel"),
          },
          { kind: "pivot", schemaVersion: 1, pivot: [0, 0, 0] },
          { kind: "joint", schemaVersion: 1 },
        ],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "primary",
        color: "#c8b89a",
        opacity: 1,
        roughness: 0.7,
        metallic: 0.05,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: volumeId("volume:anim:wheel:axle"),
        bounds: { min: [-1, -1, -4], max: [1, 1, 4] },
      },
      {
        volumeId: volumeId("volume:anim:wheel:wheel"),
        bounds: { min: [-3, -3, -1], max: [3, 3, 1] },
      },
    ],
    animations: [createWheelSpinClip()],
  });
}

/** A chest-lid clip: opens the lid 60 degrees over two seconds, once. */
export function createChestLidClip(): AnimationDescriptor {
  return {
    animationId: animationId("animation:anim:chest-lid:0001"),
    name: "Open Lid",
    duration: 2,
    loop: "once",
    tracks: [
      {
        trackId: trackId("track:anim:chest-lid:0001"),
        targetNodeId: nodeId("node:rig:chest-lid:lid"),
        interpolation: "smoothstep",
        keyframes: [
          rotationKeyframe("keyframe:anim:chest-lid:0001", 0, [1, 0, 0], 0),
          rotationKeyframe(
            "keyframe:anim:chest-lid:0002",
            2,
            [1, 0, 0],
            Math.PI / 3,
          ),
        ],
      },
    ],
  };
}
