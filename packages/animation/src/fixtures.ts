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
import {
  createAbstractSculptureFixture,
  createChestLidFixture,
  createLinkedArmFixture,
  createSimpleCharacterFixture,
  createWheelFixture,
  createWingsFixture,
} from "@voxel-maker/rigging";

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

/**
 * Definition-of-done animation demos (plan S10.15, ticket #30): one
 * generic clip + document pair per unrelated asset category — constrained
 * chest lid, continuous wheel, linked arm, flapping wings, simple
 * character, and abstract animation. Each demo embeds one clip into the
 * matching generic rig fixture from ticket #26, so the demos share the
 * same node ids and articulation symbols as the rigging suite and prove
 * that one runtime evaluates every category with no category-specific
 * core component, command, track, or evaluator.
 */

/** Embeds one clip into a generic rig fixture document. */
function withClip(
  fixture: VoxelDocument,
  clip: AnimationDescriptor,
): VoxelDocument {
  return createDocument({
    documentId: fixture.documentId,
    metadata: fixture.metadata,
    rootNodeId: fixture.rootNodeId,
    nodes: Object.values(fixture.nodes),
    materials: Object.values(fixture.materials),
    volumes: Object.values(fixture.volumes),
    animations: [clip],
  });
}

/**
 * Full-revolution wheel clip: the wheel completes one 360-degree spin
 * about its axle per two-second loop, so the wheel turns continuously.
 */
export function createContinuousWheelClip(): AnimationDescriptor {
  return {
    animationId: animationId("animation:anim:wheel-continuous:0001"),
    name: "Continuous Wheel",
    duration: 2,
    loop: "loop",
    tracks: [
      {
        trackId: trackId("track:anim:wheel-continuous:0001"),
        targetNodeId: nodeId("node:rig:wheel:wheel"),
        interpolation: "linear",
        keyframes: [
          rotationKeyframe("keyframe:anim:wheel-continuous:0001", 0, [
            0, 1, 0,
          ], 0),
          rotationKeyframe("keyframe:anim:wheel-continuous:0002", 0.5, [
            0, 1, 0,
          ], Math.PI / 2),
          rotationKeyframe("keyframe:anim:wheel-continuous:0003", 1, [
            0, 1, 0,
          ], Math.PI),
          rotationKeyframe("keyframe:anim:wheel-continuous:0004", 1.5, [
            0, 1, 0,
          ], (3 * Math.PI) / 2),
          rotationKeyframe("keyframe:anim:wheel-continuous:0005", 2, [
            0, 1, 0,
          ], 2 * Math.PI),
        ],
      },
    ],
  };
}

/**
 * Linked-arm reach clip: over-drives the shoulder to 90 degrees (limit
 * 60) and the elbow to 60 degrees (limit 45), and swings the wrist to 30
 * degrees (inside its 45-degree limit), then returns. The constraint
 * layer clamps the over-driven joints; the wrist pose proves the clamped
 * chain composition.
 */
export function createLinkedArmReachClip(): AnimationDescriptor {
  const shoulder = (time: number, angle: number) =>
    rotationKeyframe(`keyframe:anim:arm-reach:shoulder:${String(time)}`, time, [
      1, 0, 0,
    ], angle);
  const elbow = (time: number, angle: number) =>
    rotationKeyframe(
      `keyframe:anim:arm-reach:elbow:${String(time)}`,
      time,
      [0, 0, 1],
      angle,
    );
  const wrist = (time: number, angle: number) =>
    rotationKeyframe(
      `keyframe:anim:arm-reach:wrist:${String(time)}`,
      time,
      [0, 0, 1],
      angle,
    );
  return {
    animationId: animationId("animation:anim:arm-reach:0001"),
    name: "Reach",
    duration: 2,
    loop: "loop",
    tracks: [
      {
        trackId: trackId("track:anim:arm-reach:shoulder"),
        targetNodeId: nodeId("node:rig:arm:link1"),
        interpolation: "linear",
        keyframes: [shoulder(0, 0), shoulder(1, Math.PI / 2), shoulder(2, 0)],
      },
      {
        trackId: trackId("track:anim:arm-reach:elbow"),
        targetNodeId: nodeId("node:rig:arm:link2"),
        interpolation: "linear",
        keyframes: [elbow(0, 0), elbow(1, Math.PI / 3), elbow(2, 0)],
      },
      {
        trackId: trackId("track:anim:arm-reach:wrist"),
        targetNodeId: nodeId("node:rig:arm:link3"),
        interpolation: "linear",
        keyframes: [wrist(0, 0), wrist(1, Math.PI / 6), wrist(2, 0)],
      },
    ],
  };
}

/**
 * Bilateral wing-flap clip: both wings sweep up past the +30-degree limit
 * (clamped) and down past the -45-degree limit (clamped) twice per loop.
 * The left wing mirrors the right through its base 180-degree rotation.
 */
export function createWingFlapClip(): AnimationDescriptor {
  const flap = (id: string, time: number, angle: number) =>
    rotationKeyframe(id, time, [0, 0, 1], angle);
  return {
    animationId: animationId("animation:anim:wing-flap:0001"),
    name: "Flap",
    duration: 2,
    loop: "loop",
    tracks: [
      {
        trackId: trackId("track:anim:wing-flap:right"),
        targetNodeId: nodeId("node:rig:wings:right"),
        interpolation: "linear",
        keyframes: [
          flap("keyframe:anim:wing-flap:right:0", 0, 0),
          flap("keyframe:anim:wing-flap:right:1", 0.5, Math.PI / 3),
          flap("keyframe:anim:wing-flap:right:2", 1.5, -Math.PI / 2),
          flap("keyframe:anim:wing-flap:right:3", 2, 0),
        ],
      },
      {
        trackId: trackId("track:anim:wing-flap:left"),
        targetNodeId: nodeId("node:rig:wings:left"),
        interpolation: "linear",
        keyframes: [
          flap("keyframe:anim:wing-flap:left:0", 0, 0),
          flap("keyframe:anim:wing-flap:left:1", 0.5, Math.PI / 3),
          flap("keyframe:anim:wing-flap:left:2", 1.5, -Math.PI / 2),
          flap("keyframe:anim:wing-flap:left:3", 2, 0),
        ],
      },
    ],
  };
}

/**
 * Character wave clip: the head turn and right-arm raise are over-driven
 * past their limits (clamped), the left arm and both legs stay inside
 * theirs, and everything returns to the base pose each loop.
 */
export function createCharacterWaveClip(): AnimationDescriptor {
  const key = (
    label: string,
    time: number,
    axis: readonly [number, number, number],
    angle: number,
  ) =>
    rotationKeyframe(
      `keyframe:anim:character-wave:${label}:${String(time)}`,
      time,
      axis,
      angle,
    );
  const head = [0, 1, 0] as const;
  const limb = [1, 0, 0] as const;
  return {
    animationId: animationId("animation:anim:character-wave:0001"),
    name: "Wave",
    duration: 2,
    loop: "loop",
    tracks: [
      {
        trackId: trackId("track:anim:character-wave:head"),
        targetNodeId: nodeId("node:rig:character:head"),
        interpolation: "linear",
        keyframes: [key("head", 0, head, 0), key("head", 1, head, Math.PI / 2), key("head", 2, head, 0)],
      },
      {
        trackId: trackId("track:anim:character-wave:right-arm"),
        targetNodeId: nodeId("node:rig:character:right-arm"),
        interpolation: "linear",
        keyframes: [key("right-arm", 0, limb, 0), key("right-arm", 1, limb, Math.PI / 2), key("right-arm", 2, limb, 0)],
      },
      {
        trackId: trackId("track:anim:character-wave:left-arm"),
        targetNodeId: nodeId("node:rig:character:left-arm"),
        interpolation: "linear",
        keyframes: [key("left-arm", 0, limb, 0), key("left-arm", 1, limb, -Math.PI / 4), key("left-arm", 2, limb, 0)],
      },
      {
        trackId: trackId("track:anim:character-wave:right-leg"),
        targetNodeId: nodeId("node:rig:character:right-leg"),
        interpolation: "linear",
        keyframes: [key("right-leg", 0, limb, 0), key("right-leg", 1, limb, Math.PI / 4), key("right-leg", 2, limb, 0)],
      },
      {
        trackId: trackId("track:anim:character-wave:left-leg"),
        targetNodeId: nodeId("node:rig:character:left-leg"),
        interpolation: "linear",
        keyframes: [key("left-leg", 0, limb, 0), key("left-leg", 1, limb, -Math.PI / 4), key("left-leg", 2, limb, 0)],
      },
    ],
  };
}

/**
 * Abstract sculpture clip: the column completes one full turn per
 * four-second loop, the arm swings through 90 degrees about Z, and the
 * finial spins 180 degrees. The sculpture carries no constraints, so the
 * motion is exactly the authored animation.
 */
export function createAbstractSculptureClip(): AnimationDescriptor {
  return {
    animationId: animationId("animation:anim:abstract-turn:0001"),
    name: "Abstract Turn",
    duration: 4,
    loop: "loop",
    tracks: [
      {
        trackId: trackId("track:anim:abstract-turn:column"),
        targetNodeId: nodeId("node:rig:sculpture:column"),
        interpolation: "linear",
        keyframes: [
          rotationKeyframe("keyframe:anim:abstract-turn:column:0001", 0, [
            0, 1, 0,
          ], 0),
          rotationKeyframe("keyframe:anim:abstract-turn:column:0002", 1, [
            0, 1, 0,
          ], Math.PI / 2),
          rotationKeyframe("keyframe:anim:abstract-turn:column:0003", 2, [
            0, 1, 0,
          ], Math.PI),
          rotationKeyframe("keyframe:anim:abstract-turn:column:0004", 3, [
            0, 1, 0,
          ], (3 * Math.PI) / 2),
          rotationKeyframe("keyframe:anim:abstract-turn:column:0005", 4, [
            0, 1, 0,
          ], 2 * Math.PI),
        ],
      },
      {
        trackId: trackId("track:anim:abstract-turn:arm"),
        targetNodeId: nodeId("node:rig:sculpture:arm"),
        interpolation: "linear",
        keyframes: [
          rotationKeyframe("keyframe:anim:abstract-turn:arm:0", 0, [0, 0, 1], 0),
          rotationKeyframe("keyframe:anim:abstract-turn:arm:1", 2, [0, 0, 1], Math.PI / 2),
          rotationKeyframe("keyframe:anim:abstract-turn:arm:2", 4, [0, 0, 1], 0),
        ],
      },
      {
        trackId: trackId("track:anim:abstract-turn:finial"),
        targetNodeId: nodeId("node:rig:sculpture:finial"),
        interpolation: "linear",
        keyframes: [
          rotationKeyframe("keyframe:anim:abstract-turn:finial:0", 0, [0, 1, 0], 0),
          rotationKeyframe("keyframe:anim:abstract-turn:finial:1", 4, [0, 1, 0], Math.PI),
        ],
      },
    ],
  };
}

/** Chest-lid demo: the generic chest rig with its hinged-lid clip. */
export function createConstrainedChestLidDocument(): VoxelDocument {
  return withClip(createChestLidFixture(), createChestLidClip());
}

/** Wheel demo: the generic wheel rig with the continuous-spin clip. */
export function createContinuousWheelDocument(): VoxelDocument {
  return withClip(createWheelFixture(), createContinuousWheelClip());
}

/** Linked-arm demo: the three-link arm rig with the reach clip. */
export function createLinkedArmDocument(): VoxelDocument {
  return withClip(createLinkedArmFixture(), createLinkedArmReachClip());
}

/** Wings demo: the bilateral wing rig with the flap clip. */
export function createWingFlapDocument(): VoxelDocument {
  return withClip(createWingsFixture(), createWingFlapClip());
}

/** Character demo: the simple character rig with the wave clip. */
export function createCharacterWaveDocument(): VoxelDocument {
  return withClip(createSimpleCharacterFixture(), createCharacterWaveClip());
}

/** Abstract demo: the abstract sculpture rig with the turn clip. */
export function createAbstractAnimationDocument(): VoxelDocument {
  return withClip(createAbstractSculptureFixture(), createAbstractSculptureClip());
}

/** One definition-of-done demo category (plan S10.15, ticket #30). */
export interface AnimatedDemo {
  readonly kind:
    | "chest-lid"
    | "wheel"
    | "linked-arm"
    | "wings"
    | "simple-character"
    | "abstract";
  readonly name: string;
  /** The demo document with exactly one embedded clip. */
  readonly create: () => {
    readonly document: VoxelDocument;
    readonly clip: AnimationDescriptor;
  };
}

/** Registry of the six definition-of-done animation demos. */
export const ANIMATED_DEMOS: readonly AnimatedDemo[] = [
  {
    kind: "chest-lid",
    name: "Constrained chest lid",
    create: () => ({
      document: createConstrainedChestLidDocument(),
      clip: createChestLidClip(),
    }),
  },
  {
    kind: "wheel",
    name: "Continuous wheel",
    create: () => ({
      document: createContinuousWheelDocument(),
      clip: createContinuousWheelClip(),
    }),
  },
  {
    kind: "linked-arm",
    name: "Linked arm",
    create: () => ({
      document: createLinkedArmDocument(),
      clip: createLinkedArmReachClip(),
    }),
  },
  {
    kind: "wings",
    name: "Flapping wings",
    create: () => ({
      document: createWingFlapDocument(),
      clip: createWingFlapClip(),
    }),
  },
  {
    kind: "simple-character",
    name: "Simple character",
    create: () => ({
      document: createCharacterWaveDocument(),
      clip: createCharacterWaveClip(),
    }),
  },
  {
    kind: "abstract",
    name: "Abstract animation",
    create: () => ({
      document: createAbstractAnimationDocument(),
      clip: createAbstractSculptureClip(),
    }),
  },
];
