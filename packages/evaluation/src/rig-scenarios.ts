import type { DocumentStoreRead } from "@voxel-maker/document";
import type { EditorSelectionSnapshot, ToolCall } from "@voxel-maker/agent";
import { quaternionFromAxisAngle } from "@voxel-maker/math";
import type { AnimationDescriptor } from "@voxel-maker/model";
import type {
  AnimationId,
  ComponentId,
  NodeId,
  TrackId,
} from "@voxel-maker/shared";
import {
  RIG_CLIP_IDS,
  RIG_IDS,
  evalClipOf,
  fixtureScanRegions,
} from "./rig-fixtures.js";
import { playbackEvidence } from "./playback.js";
import type {
  GeometryScenario,
  PlaybackSignal,
  PreviewSignal,
} from "./scenarios.js";

/**
 * Fixed rig/animation evaluation scenarios (plan S13.7-S13.9, ticket #36
 * AC): five initial rig+animate workflows (chest lid, wheel, wings,
 * linked arm, abstract rig) plus five follow-up modifications (farther,
 * slower, one wing, elbow limit, twice as fast). Every scenario runs a
 * deterministic starting fixture through a recorded golden trace of the
 * registered rigging/animation tools, and the follow-ups assert minimal
 * modification: only the intended nodes and clips change, voxels never
 * do, and the overlay clip plays before Apply.
 */

/** The rig/animation scenario ids (plan S13.7-S13.9). */
export type RigScenarioId =
  | "chest-lid-open"
  | "wheel-spin"
  | "wings-flap"
  | "arm-reach"
  | "abstract-rig"
  | "chest-farther"
  | "wheel-slower"
  | "wings-one"
  | "arm-elbow-limit"
  | "wheel-faster";

/** A fixed rig/animation evaluation scenario. */
export type RigScenario = Omit<GeometryScenario, "id"> & {
  readonly id: RigScenarioId;
};

/** The empty allowed-change region: rig scenarios must change zero voxels. */
const NO_VOXELS = {
  min: [0, 0, 0] as [number, number, number],
  max: [0, 0, 0] as [number, number, number],
};

/** Trace helpers: minimal valid tool calls of the rig/animation surface. */
const summary = (id = "call_summary"): ToolCall => ({
  id,
  name: "inspectSummary",
  arguments: {},
});
const setNodePivot = (
  id: string,
  nodeId: string,
  pivot: readonly [number, number, number],
): ToolCall => ({
  id,
  name: "setNodePivot",
  arguments: { nodeId, pivot: [...pivot] },
});
const addNodeJoint = (id: string, nodeId: string): ToolCall => ({
  id,
  name: "addNodeJoint",
  arguments: { nodeId },
});
const addConstraint = (
  id: string,
  nodeId: string,
  componentId: string,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): ToolCall => ({
  id,
  name: "addConstraint",
  arguments: {
    nodeId,
    componentId,
    limits: { min: [...min], max: [...max] },
  },
});
const createAnimation = (
  id: string,
  animationId: string,
  duration: number,
  loop: "once" | "loop",
  name: string,
): ToolCall => ({
  id,
  name: "createAnimation",
  arguments: { animationId, duration, loop, name },
});
const addTrack = (
  id: string,
  animationId: string,
  trackId: string,
  targetNodeId: string,
  interpolation: "step" | "linear" | "smoothstep",
): ToolCall => ({
  id,
  name: "addTrack",
  arguments: { animationId, trackId, targetNodeId, interpolation },
});
const setKeyframe = (
  id: string,
  animationId: string,
  trackId: string,
  keyframeId: string,
  time: number,
  axis: readonly [number, number, number],
  angle: number,
): ToolCall => ({
  id,
  name: "setKeyframe",
  arguments: {
    animationId,
    trackId,
    keyframeId,
    time,
    channel: "rotation",
    value: [...quaternionFromAxisAngle(axis, angle)],
  },
});
const updateAnimation = (
  id: string,
  animationId: string,
  duration: number,
): ToolCall => ({
  id,
  name: "updateAnimation",
  arguments: { animationId, duration },
});
const removeTrack = (
  id: string,
  animationId: string,
  trackId: string,
): ToolCall => ({
  id,
  name: "removeTrack",
  arguments: { animationId, trackId },
});

/** Shared preview signal of the rig suite: renders complete, non-empty. */
const RIG_NONEMPTY_SIGNAL: PreviewSignal = {
  name: "before and after renders complete with non-empty silhouettes",
  check: (before, after) =>
    before.completed &&
    after.completed &&
    before.silhouettePixels > 0 &&
    after.silhouettePixels > 0,
};

/** One playback signal: the staged clip moves at least the named nodes. */
function moves(nodes: readonly NodeId[]): PlaybackSignal {
  return {
    name: `staged overlay clip moves ${nodes.map((id) => String(id)).join(", ")}`,
    check: (store, clip) => {
      const evidence = playbackEvidence(store, clip);
      return nodes.every((id) => evidence.movedNodes.includes(id));
    },
  };
}

/** One playback signal: the staged clip moves EXACTLY the named nodes. */
function movesExactly(nodes: readonly NodeId[]): PlaybackSignal {
  return {
    name: `staged overlay clip moves exactly ${nodes
      .map((id) => String(id))
      .join(", ")}`,
    check: (store, clip) => {
      const evidence = playbackEvidence(store, clip);
      return (
        evidence.movedNodes.length === nodes.length &&
        nodes.every((id) => evidence.movedNodes.includes(id))
      );
    },
  };
}

/** Task-check helpers over a committed store. */
function pivotOf(store: DocumentStoreRead, nodeId: NodeId) {
  const node = store.getDocument().nodes[nodeId];
  const pivot = node?.components.find(
    (component) => component.kind === "pivot",
  );
  return pivot?.kind === "pivot" ? pivot.pivot : undefined;
}

/** True when the node's pivot equals the expected local value. */
function pivotIs(
  store: DocumentStoreRead,
  nodeId: NodeId,
  expected: readonly [number, number, number],
): boolean {
  const pivot = pivotOf(store, nodeId);
  return (
    pivot !== undefined &&
    pivot[0] === expected[0] &&
    pivot[1] === expected[1] &&
    pivot[2] === expected[2]
  );
}
function hasJoint(store: DocumentStoreRead, nodeId: NodeId): boolean {
  const node = store.getDocument().nodes[nodeId];
  return (node?.components ?? []).some(
    (component) => component.kind === "joint",
  );
}
function constraintLimitsOf(
  store: DocumentStoreRead,
  nodeId: NodeId,
  componentId: ComponentId,
):
  | { readonly min: readonly number[]; readonly max: readonly number[] }
  | undefined {
  const node = store.getDocument().nodes[nodeId];
  for (const component of node?.components ?? []) {
    if (component.kind !== "constraint") continue;
    for (const constraint of component.constraints) {
      if (constraint.componentId === componentId) {
        return {
          min: [...constraint.limits.min],
          max: [...constraint.limits.max],
        };
      }
    }
  }
  return undefined;
}
function clipOf(
  store: DocumentStoreRead,
  animationId: AnimationId,
): AnimationDescriptor | undefined {
  return store.getDocument().animations[animationId];
}
function trackOf(
  clip: AnimationDescriptor,
  trackId: TrackId,
): AnimationDescriptor["tracks"][number] | undefined {
  return clip.tracks.find((track) => track.trackId === trackId);
}
function quatCloseTo(
  value: readonly number[],
  axis: readonly [number, number, number],
  angle: number,
): boolean {
  const expected = quaternionFromAxisAngle(axis, angle);
  return value.every(
    (item, index) => Math.abs(item - (expected[index] as number)) < 1e-9,
  );
}

/** Bounds of the whole fixture used as the scenario scan region. */
function scanRegionOf(kind: Parameters<typeof fixtureScanRegions>[0]) {
  const scans = fixtureScanRegions(kind);
  const all = scans.flatMap((scan) => [scan.region.min, scan.region.max]);
  return {
    min: [
      Math.min(...all.map((point) => point[0])),
      Math.min(...all.map((point) => point[1])),
      Math.min(...all.map((point) => point[2])),
    ] as [number, number, number],
    max: [
      Math.max(...all.map((point) => point[0])),
      Math.max(...all.map((point) => point[1])),
      Math.max(...all.map((point) => point[2])),
    ] as [number, number, number],
  };
}

const CHEST_SCAN = scanRegionOf("chest-lid");
const WHEEL_SCAN = scanRegionOf("wheel");
const WINGS_SCAN = scanRegionOf("wings");
const ARM_SCAN = scanRegionOf("linked-arm");
const ABSTRACT_SCAN = scanRegionOf("abstract");

const chest = RIG_IDS.chestLid;
const wheel = RIG_IDS.wheel;
const wings = RIG_IDS.wings;
const arm = RIG_IDS.arm;
const sculpture = RIG_IDS.abstract;

/** chest-lid-open: rig the lid on its hinge and animate it opening. */
const CHEST_LID_OPEN: RigScenario = {
  id: "chest-lid-open",
  name: "Rig and open the chest lid",
  strictShape: false,
  description:
    "Rig the unrigged chest lid (pivot on the back-bottom hinge edge, joint, rotation limits) and stage an open-lid clip that plays before Apply.",
  prompt: "Rig the chest lid on its hinge and make it open.",
  fixtureVersion: "v1",
  fixture: "chest-lid",
  selection: [],
  goldenTrace: [
    {
      text: "I will inspect the unrigged chest first.",
      toolCalls: [summary()],
    },
    {
      text: "Rigging the lid and adding an open clip.",
      toolCalls: [
        setNodePivot("call_pivot", chest.lid, [0, 0, -3]),
        addNodeJoint("call_joint", chest.lid),
        addConstraint(
          "call_hinge",
          chest.lid,
          chest.hinge,
          [-Math.PI / 6, -Math.PI, -Math.PI],
          [Math.PI / 4, Math.PI, Math.PI],
        ),
        createAnimation(
          "call_anim",
          RIG_CLIP_IDS.chestOpen,
          2,
          "once",
          "Open Lid",
        ),
        addTrack(
          "call_track",
          RIG_CLIP_IDS.chestOpen,
          "track:eval:chest-open:lid",
          chest.lid,
          "smoothstep",
        ),
        setKeyframe(
          "call_k0",
          RIG_CLIP_IDS.chestOpen,
          "track:eval:chest-open:lid",
          "keyframe:eval:chest-open:0",
          0,
          [1, 0, 0],
          0,
        ),
        setKeyframe(
          "call_k1",
          RIG_CLIP_IDS.chestOpen,
          "track:eval:chest-open:lid",
          "keyframe:eval:chest-open:1",
          2,
          [1, 0, 0],
          Math.PI / 3,
        ),
      ],
    },
    {
      text: "Verifying the staged rig and clip.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The proposal is ready for approval." },
  ],
  goldenRounds: 4,
  goldenToolCalls: 9,
  goldenCommands: 7,
  scanRegion: CHEST_SCAN,
  scanVolumes: fixtureScanRegions("chest-lid"),
  allowedChangedRegion: NO_VOXELS,
  allowedAddedMaterials: [],
  expectedShape: [],
  allowedChangedNodes: [chest.lid],
  allowedChangedAnimations: [RIG_CLIP_IDS.chestOpen],
  playbackClipId: RIG_CLIP_IDS.chestOpen,
  taskChecks: [
    {
      name: "lid pivot sits on the hinge edge",
      check: (store) => pivotIs(store, chest.lid, [0, 0, -3]),
    },
    {
      name: "lid carries a joint",
      check: (store) => hasJoint(store, chest.lid),
    },
    {
      name: "hinge constraint limits match the golden rig",
      check: (store) => {
        const limits = constraintLimitsOf(store, chest.lid, chest.hinge);
        return (
          limits !== undefined &&
          Math.abs((limits.min[0] as number) + Math.PI / 6) < 1e-9 &&
          Math.abs((limits.max[0] as number) - Math.PI / 4) < 1e-9
        );
      },
    },
    {
      name: "open clip exists with one lid track and two keyframes",
      check: (store) => {
        const clip = clipOf(store, RIG_CLIP_IDS.chestOpen);
        if (clip === undefined || clip.duration !== 2 || clip.loop !== "once")
          return false;
        const track = trackOf(clip, "track:eval:chest-open:lid" as TrackId);
        return (
          track !== undefined &&
          track.targetNodeId === chest.lid &&
          track.interpolation === "smoothstep" &&
          track.keyframes.length === 2 &&
          track.keyframes.at(0)?.time === 0 &&
          track.keyframes.at(1)?.time === 2 &&
          quatCloseTo(
            track.keyframes.at(1)?.property.value ?? [],
            [1, 0, 0],
            Math.PI / 3,
          )
        );
      },
    },
  ],
  previewSignals: [RIG_NONEMPTY_SIGNAL],
  playbackSignals: [movesExactly([chest.lid])],
};

/** wheel-spin: rig the wheel and make it spin continuously. */
const WHEEL_SPIN: RigScenario = {
  id: "wheel-spin",
  name: "Rig and spin the wheel",
  strictShape: false,
  description:
    "Rig the unrigged wheel (pivot at its center, joint) and stage a looping full-revolution spin clip.",
  prompt: "Make the wheel spin continuously.",
  fixtureVersion: "v1",
  fixture: "wheel",
  selection: [],
  goldenTrace: [
    {
      text: "I will inspect the unrigged wheel first.",
      toolCalls: [summary()],
    },
    {
      text: "Rigging the wheel and adding a looping spin clip.",
      toolCalls: [
        setNodePivot("call_pivot", wheel.wheel, [0, 0, 0]),
        addNodeJoint("call_joint", wheel.wheel),
        createAnimation(
          "call_anim",
          RIG_CLIP_IDS.wheelSpin,
          2,
          "loop",
          "Wheel Spin",
        ),
        addTrack(
          "call_track",
          RIG_CLIP_IDS.wheelSpin,
          "track:eval:wheel-spin:wheel",
          wheel.wheel,
          "linear",
        ),
        setKeyframe(
          "call_k0",
          RIG_CLIP_IDS.wheelSpin,
          "track:eval:wheel-spin:wheel",
          "keyframe:eval:wheel-spin:0",
          0,
          [0, 1, 0],
          0,
        ),
        setKeyframe(
          "call_k1",
          RIG_CLIP_IDS.wheelSpin,
          "track:eval:wheel-spin:wheel",
          "keyframe:eval:wheel-spin:1",
          2,
          [0, 1, 0],
          2 * Math.PI,
        ),
      ],
    },
    {
      text: "Verifying the staged rig and clip.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The proposal is ready for approval." },
  ],
  goldenRounds: 4,
  goldenToolCalls: 8,
  goldenCommands: 6,
  scanRegion: WHEEL_SCAN,
  scanVolumes: fixtureScanRegions("wheel"),
  allowedChangedRegion: NO_VOXELS,
  allowedAddedMaterials: [],
  expectedShape: [],
  allowedChangedNodes: [wheel.wheel],
  allowedChangedAnimations: [RIG_CLIP_IDS.wheelSpin],
  playbackClipId: RIG_CLIP_IDS.wheelSpin,
  taskChecks: [
    {
      name: "wheel pivot sits at its center",
      check: (store) => pivotIs(store, wheel.wheel, [0, 0, 0]),
    },
    {
      name: "wheel carries a joint",
      check: (store) => hasJoint(store, wheel.wheel),
    },
    {
      name: "spin clip loops with a full revolution",
      check: (store) => {
        const clip = clipOf(store, RIG_CLIP_IDS.wheelSpin);
        if (clip === undefined || clip.duration !== 2 || clip.loop !== "loop")
          return false;
        const track = trackOf(clip, "track:eval:wheel-spin:wheel" as TrackId);
        return (
          track !== undefined &&
          track.targetNodeId === wheel.wheel &&
          track.interpolation === "linear" &&
          track.keyframes.length === 2 &&
          track.keyframes.at(0)?.time === 0 &&
          track.keyframes.at(1)?.time === 2 &&
          quatCloseTo(
            track.keyframes.at(1)?.property.value ?? [],
            [0, 1, 0],
            2 * Math.PI,
          )
        );
      },
    },
  ],
  previewSignals: [RIG_NONEMPTY_SIGNAL],
  playbackSignals: [movesExactly([wheel.wheel])],
};

/** wings-flap: rig both wings and flap them. */
const WINGS_FLAP: RigScenario = {
  id: "wings-flap",
  name: "Rig and flap the wings",
  strictShape: false,
  description:
    "Rig the unrigged paired wings (pivots at the shoulder roots, joints, flap limits) and stage a looping flap clip for both wings.",
  prompt: "Flap both wings.",
  fixtureVersion: "v1",
  fixture: "wings",
  selection: [],
  goldenTrace: [
    {
      text: "I will inspect the unrigged wings first.",
      toolCalls: [summary()],
    },
    {
      text: "Rigging both wings and adding a flap clip.",
      toolCalls: [
        setNodePivot("call_pivot_r", wings.right, [0, 0, 0]),
        setNodePivot("call_pivot_l", wings.left, [0, 0, 0]),
        addNodeJoint("call_joint_r", wings.right),
        addNodeJoint("call_joint_l", wings.left),
        addConstraint(
          "call_flap_r",
          wings.right,
          wings.rightFlap,
          [-Math.PI, -Math.PI, -Math.PI / 4],
          [Math.PI, Math.PI, Math.PI / 6],
        ),
        addConstraint(
          "call_flap_l",
          wings.left,
          wings.leftFlap,
          [-Math.PI, -Math.PI, -Math.PI / 4],
          [Math.PI, Math.PI, Math.PI / 6],
        ),
        createAnimation("call_anim", RIG_CLIP_IDS.wingsFlap, 1, "loop", "Flap"),
        addTrack(
          "call_track_r",
          RIG_CLIP_IDS.wingsFlap,
          "track:eval:wings-flap:right",
          wings.right,
          "smoothstep",
        ),
        addTrack(
          "call_track_l",
          RIG_CLIP_IDS.wingsFlap,
          "track:eval:wings-flap:left",
          wings.left,
          "smoothstep",
        ),
        setKeyframe(
          "call_kr0",
          RIG_CLIP_IDS.wingsFlap,
          "track:eval:wings-flap:right",
          "keyframe:eval:wings-flap:right:0",
          0,
          [0, 0, 1],
          0,
        ),
        setKeyframe(
          "call_kr1",
          RIG_CLIP_IDS.wingsFlap,
          "track:eval:wings-flap:right",
          "keyframe:eval:wings-flap:right:1",
          1,
          [0, 0, 1],
          Math.PI / 4,
        ),
        setKeyframe(
          "call_kl0",
          RIG_CLIP_IDS.wingsFlap,
          "track:eval:wings-flap:left",
          "keyframe:eval:wings-flap:left:0",
          0,
          [0, 0, 1],
          0,
        ),
        setKeyframe(
          "call_kl1",
          RIG_CLIP_IDS.wingsFlap,
          "track:eval:wings-flap:left",
          "keyframe:eval:wings-flap:left:1",
          1,
          [0, 0, 1],
          -Math.PI / 4,
        ),
      ],
    },
    {
      text: "Verifying the staged rig and clip.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The proposal is ready for approval." },
  ],
  goldenRounds: 4,
  goldenToolCalls: 15,
  goldenCommands: 13,
  scanRegion: WINGS_SCAN,
  scanVolumes: fixtureScanRegions("wings"),
  allowedChangedRegion: NO_VOXELS,
  allowedAddedMaterials: [],
  expectedShape: [],
  allowedChangedNodes: [wings.right, wings.left],
  allowedChangedAnimations: [RIG_CLIP_IDS.wingsFlap],
  playbackClipId: RIG_CLIP_IDS.wingsFlap,
  taskChecks: [
    {
      name: "both wings pivot at their shoulder roots",
      check: (store) =>
        pivotIs(store, wings.right, [0, 0, 0]) &&
        pivotIs(store, wings.left, [0, 0, 0]),
    },
    {
      name: "both wings carry joints and flap constraints",
      check: (store) =>
        hasJoint(store, wings.right) &&
        hasJoint(store, wings.left) &&
        constraintLimitsOf(store, wings.right, wings.rightFlap) !== undefined &&
        constraintLimitsOf(store, wings.left, wings.leftFlap) !== undefined,
    },
    {
      name: "flap clip loops with one track per wing",
      check: (store) => {
        const clip = clipOf(store, RIG_CLIP_IDS.wingsFlap);
        if (clip === undefined || clip.duration !== 1 || clip.loop !== "loop")
          return false;
        const right = trackOf(clip, "track:eval:wings-flap:right" as TrackId);
        const left = trackOf(clip, "track:eval:wings-flap:left" as TrackId);
        return (
          right?.targetNodeId === wings.right &&
          left?.targetNodeId === wings.left &&
          right.keyframes.length === 2 &&
          left.keyframes.length === 2 &&
          quatCloseTo(
            right.keyframes[1]?.property.value ?? [],
            [0, 0, 1],
            Math.PI / 4,
          ) &&
          quatCloseTo(
            left.keyframes[1]?.property.value ?? [],
            [0, 0, 1],
            -Math.PI / 4,
          )
        );
      },
    },
  ],
  previewSignals: [RIG_NONEMPTY_SIGNAL],
  playbackSignals: [movesExactly([wings.right, wings.left])],
};

/** arm-reach: rig the linked arm and make it reach. */
const ARM_REACH: RigScenario = {
  id: "arm-reach",
  name: "Rig and reach with the linked arm",
  strictShape: false,
  description:
    "Rig the unrigged three-link arm (shoulder/elbow/wrist pivots, joints, rotation limits) and stage a reach clip.",
  prompt: "Make the robot arm reach forward.",
  fixtureVersion: "v1",
  fixture: "linked-arm",
  selection: [],
  goldenTrace: [
    { text: "I will inspect the unrigged arm first.", toolCalls: [summary()] },
    {
      text: "Rigging the three links and adding a reach clip.",
      toolCalls: [
        setNodePivot("call_pivot_1", arm.link1, [0, 0, 0]),
        setNodePivot("call_pivot_2", arm.link2, [0, 0, 0]),
        setNodePivot("call_pivot_3", arm.link3, [0, 0, 0]),
        addNodeJoint("call_joint_1", arm.link1),
        addNodeJoint("call_joint_2", arm.link2),
        addNodeJoint("call_joint_3", arm.link3),
        addConstraint(
          "call_shoulder",
          arm.link1,
          arm.shoulder,
          [-Math.PI / 3, -Math.PI / 6, -Math.PI],
          [Math.PI / 3, Math.PI / 6, Math.PI],
        ),
        addConstraint(
          "call_elbow",
          arm.link2,
          arm.elbow,
          [-Math.PI, -Math.PI, -Math.PI / 2],
          [Math.PI, Math.PI, Math.PI / 4],
        ),
        addConstraint(
          "call_wrist",
          arm.link3,
          arm.wrist,
          [-Math.PI, -Math.PI, -Math.PI / 4],
          [Math.PI, Math.PI, Math.PI / 4],
        ),
        createAnimation("call_anim", RIG_CLIP_IDS.armReach, 2, "once", "Reach"),
        addTrack(
          "call_track_1",
          RIG_CLIP_IDS.armReach,
          "track:eval:arm-reach:shoulder",
          arm.link1,
          "linear",
        ),
        addTrack(
          "call_track_2",
          RIG_CLIP_IDS.armReach,
          "track:eval:arm-reach:elbow",
          arm.link2,
          "linear",
        ),
        addTrack(
          "call_track_3",
          RIG_CLIP_IDS.armReach,
          "track:eval:arm-reach:wrist",
          arm.link3,
          "linear",
        ),
        setKeyframe(
          "call_s0",
          RIG_CLIP_IDS.armReach,
          "track:eval:arm-reach:shoulder",
          "keyframe:eval:arm-reach:shoulder:0",
          0,
          [1, 0, 0],
          0,
        ),
        setKeyframe(
          "call_s1",
          RIG_CLIP_IDS.armReach,
          "track:eval:arm-reach:shoulder",
          "keyframe:eval:arm-reach:shoulder:1",
          2,
          [1, 0, 0],
          Math.PI / 2,
        ),
        setKeyframe(
          "call_e0",
          RIG_CLIP_IDS.armReach,
          "track:eval:arm-reach:elbow",
          "keyframe:eval:arm-reach:elbow:0",
          0,
          [0, 0, 1],
          0,
        ),
        setKeyframe(
          "call_e1",
          RIG_CLIP_IDS.armReach,
          "track:eval:arm-reach:elbow",
          "keyframe:eval:arm-reach:elbow:1",
          2,
          [0, 0, 1],
          Math.PI / 3,
        ),
        setKeyframe(
          "call_w0",
          RIG_CLIP_IDS.armReach,
          "track:eval:arm-reach:wrist",
          "keyframe:eval:arm-reach:wrist:0",
          0,
          [0, 0, 1],
          0,
        ),
        setKeyframe(
          "call_w1",
          RIG_CLIP_IDS.armReach,
          "track:eval:arm-reach:wrist",
          "keyframe:eval:arm-reach:wrist:1",
          2,
          [0, 0, 1],
          Math.PI / 6,
        ),
      ],
    },
    {
      text: "Verifying the staged rig and clip.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The proposal is ready for approval." },
  ],
  goldenRounds: 4,
  goldenToolCalls: 21,
  goldenCommands: 19,
  scanRegion: ARM_SCAN,
  scanVolumes: fixtureScanRegions("linked-arm"),
  allowedChangedRegion: NO_VOXELS,
  allowedAddedMaterials: [],
  expectedShape: [],
  allowedChangedNodes: [arm.link1, arm.link2, arm.link3],
  allowedChangedAnimations: [RIG_CLIP_IDS.armReach],
  playbackClipId: RIG_CLIP_IDS.armReach,
  taskChecks: [
    {
      name: "every link pivots at its joint origin",
      check: (store) =>
        [arm.link1, arm.link2, arm.link3].every((id) =>
          pivotIs(store, id, [0, 0, 0]),
        ) &&
        [arm.link1, arm.link2, arm.link3].every((id) => hasJoint(store, id)),
    },
    {
      name: "elbow constraint limits the forearm bend",
      check: (store) => {
        const limits = constraintLimitsOf(store, arm.link2, arm.elbow);
        return (
          limits !== undefined &&
          Math.abs((limits.min[2] as number) + Math.PI / 2) < 1e-9 &&
          Math.abs((limits.max[2] as number) - Math.PI / 4) < 1e-9
        );
      },
    },
    {
      name: "reach clip has one track per link",
      check: (store) => {
        const clip = clipOf(store, RIG_CLIP_IDS.armReach);
        if (clip === undefined || clip.duration !== 2 || clip.loop !== "once")
          return false;
        const shoulder = trackOf(
          clip,
          "track:eval:arm-reach:shoulder" as TrackId,
        );
        const elbow = trackOf(clip, "track:eval:arm-reach:elbow" as TrackId);
        const wrist = trackOf(clip, "track:eval:arm-reach:wrist" as TrackId);
        return (
          shoulder?.targetNodeId === arm.link1 &&
          elbow?.targetNodeId === arm.link2 &&
          wrist?.targetNodeId === arm.link3 &&
          shoulder.keyframes.length === 2 &&
          elbow.keyframes.length === 2 &&
          wrist.keyframes.length === 2 &&
          quatCloseTo(
            shoulder.keyframes[1]?.property.value ?? [],
            [1, 0, 0],
            Math.PI / 2,
          ) &&
          quatCloseTo(
            elbow.keyframes[1]?.property.value ?? [],
            [0, 0, 1],
            Math.PI / 3,
          )
        );
      },
    },
  ],
  previewSignals: [RIG_NONEMPTY_SIGNAL],
  playbackSignals: [moves([arm.link3])],
};

/** abstract-rig: animate the abstract sculpture. */
const ABSTRACT_RIG: RigScenario = {
  id: "abstract-rig",
  name: "Rig and animate the abstract sculpture",
  strictShape: false,
  description:
    "Rig the unrigged abstract sculpture (column pivot/joint, arm pivot/joint) and stage a looping arm-swing clip.",
  prompt: "Animate the abstract sculpture.",
  fixtureVersion: "v1",
  fixture: "abstract",
  selection: [],
  goldenTrace: [
    {
      text: "I will inspect the unrigged sculpture first.",
      toolCalls: [summary()],
    },
    {
      text: "Rigging the column and arm, then adding a swing clip.",
      toolCalls: [
        setNodePivot("call_pivot_c", sculpture.column, [0, 0, 0]),
        addNodeJoint("call_joint_c", sculpture.column),
        setNodePivot("call_pivot_a", sculpture.arm, [0, 0, -1]),
        addNodeJoint("call_joint_a", sculpture.arm),
        createAnimation(
          "call_anim",
          RIG_CLIP_IDS.abstractSpin,
          2,
          "loop",
          "Abstract Spin",
        ),
        addTrack(
          "call_track",
          RIG_CLIP_IDS.abstractSpin,
          "track:eval:abstract-spin:arm",
          sculpture.arm,
          "smoothstep",
        ),
        setKeyframe(
          "call_k0",
          RIG_CLIP_IDS.abstractSpin,
          "track:eval:abstract-spin:arm",
          "keyframe:eval:abstract-spin:0",
          0,
          [0, 0, 1],
          0,
        ),
        setKeyframe(
          "call_k1",
          RIG_CLIP_IDS.abstractSpin,
          "track:eval:abstract-spin:arm",
          "keyframe:eval:abstract-spin:1",
          2,
          [0, 0, 1],
          Math.PI / 2,
        ),
      ],
    },
    {
      text: "Verifying the staged rig and clip.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The proposal is ready for approval." },
  ],
  goldenRounds: 4,
  goldenToolCalls: 10,
  goldenCommands: 8,
  scanRegion: ABSTRACT_SCAN,
  scanVolumes: fixtureScanRegions("abstract"),
  allowedChangedRegion: NO_VOXELS,
  allowedAddedMaterials: [],
  expectedShape: [],
  allowedChangedNodes: [sculpture.column, sculpture.arm],
  allowedChangedAnimations: [RIG_CLIP_IDS.abstractSpin],
  playbackClipId: RIG_CLIP_IDS.abstractSpin,
  taskChecks: [
    {
      name: "column and arm carry pivots and joints",
      check: (store) =>
        pivotIs(store, sculpture.column, [0, 0, 0]) &&
        pivotIs(store, sculpture.arm, [0, 0, -1]) &&
        hasJoint(store, sculpture.column) &&
        hasJoint(store, sculpture.arm),
    },
    {
      name: "swing clip loops and animates the arm",
      check: (store) => {
        const clip = clipOf(store, RIG_CLIP_IDS.abstractSpin);
        if (clip === undefined || clip.duration !== 2 || clip.loop !== "loop")
          return false;
        const track = trackOf(clip, "track:eval:abstract-spin:arm" as TrackId);
        return (
          track?.targetNodeId === sculpture.arm &&
          track.interpolation === "smoothstep" &&
          track.keyframes.length === 2 &&
          quatCloseTo(
            track.keyframes.at(1)?.property.value ?? [],
            [0, 0, 1],
            Math.PI / 2,
          )
        );
      },
    },
  ],
  previewSignals: [RIG_NONEMPTY_SIGNAL],
  playbackSignals: [movesExactly([sculpture.arm])],
};

/** chest-farther: follow-up that opens the lid farther (one keyframe). */
const CHEST_FARTHER: RigScenario = {
  id: "chest-farther",
  name: "Open the chest lid farther",
  strictShape: false,
  description:
    "Follow-up on the rigged chest: replace only the open keyframe with a wider angle; clip, tracks, pivot, and constraints stay untouched.",
  prompt: "Open the chest lid farther.",
  fixtureVersion: "v1",
  fixture: "chest-lid-rigged",
  selection: [],
  goldenTrace: [
    { text: "I will inspect the rigged chest first.", toolCalls: [summary()] },
    {
      text: "Replacing the open keyframe with a wider angle.",
      toolCalls: [
        setKeyframe(
          "call_farther",
          RIG_CLIP_IDS.chestOpen,
          "track:eval:chest-open:lid",
          "keyframe:eval:chest-open:1",
          2,
          [1, 0, 0],
          Math.PI / 2,
        ),
      ],
    },
    {
      text: "Verifying the staged result.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The proposal is ready for approval." },
  ],
  goldenRounds: 4,
  goldenToolCalls: 3,
  goldenCommands: 1,
  scanRegion: CHEST_SCAN,
  scanVolumes: fixtureScanRegions("chest-lid"),
  allowedChangedRegion: NO_VOXELS,
  allowedAddedMaterials: [],
  expectedShape: [],
  allowedChangedNodes: [chest.lid],
  allowedChangedAnimations: [RIG_CLIP_IDS.chestOpen],
  playbackClipId: RIG_CLIP_IDS.chestOpen,
  taskChecks: [
    {
      name: "the open keyframe now swings wider (90 degrees)",
      check: (store) => {
        const clip = clipOf(store, RIG_CLIP_IDS.chestOpen);
        const track = trackOf(
          clip ?? ({} as AnimationDescriptor),
          "track:eval:chest-open:lid" as TrackId,
        );
        return (
          clip !== undefined &&
          track !== undefined &&
          track.keyframes.length === 2 &&
          quatCloseTo(
            track.keyframes.at(1)?.property.value ?? [],
            [1, 0, 0],
            Math.PI / 2,
          ) &&
          !quatCloseTo(
            track.keyframes.at(1)?.property.value ?? [],
            [1, 0, 0],
            Math.PI / 3,
          )
        );
      },
    },
    {
      name: "no other clip state changed",
      check: (store) => {
        const clip = clipOf(store, RIG_CLIP_IDS.chestOpen);
        const track = clip?.tracks.at(0);
        return (
          clip !== undefined &&
          clip.duration === 2 &&
          clip.tracks.length === 1 &&
          track !== undefined &&
          track.keyframes.length === 2 &&
          track.keyframes.at(0)?.time === 0
        );
      },
    },
  ],
  previewSignals: [RIG_NONEMPTY_SIGNAL],
  playbackSignals: [movesExactly([chest.lid])],
};

/** wheel-slower: follow-up that doubles the spin duration. */
const WHEEL_SLOWER: RigScenario = {
  id: "wheel-slower",
  name: "Make the wheel spin slower",
  strictShape: false,
  description:
    "Follow-up on the rigged wheel: only the clip duration doubles; tracks, keyframes, and the rig stay untouched.",
  prompt: "Make the wheel spin slower.",
  fixtureVersion: "v1",
  fixture: "wheel-rigged",
  selection: [],
  goldenTrace: [
    { text: "I will inspect the rigged wheel first.", toolCalls: [summary()] },
    {
      text: "Doubling the clip duration.",
      toolCalls: [updateAnimation("call_slower", RIG_CLIP_IDS.wheelSpin, 4)],
    },
    {
      text: "Verifying the staged result.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The proposal is ready for approval." },
  ],
  goldenRounds: 4,
  goldenToolCalls: 3,
  goldenCommands: 1,
  scanRegion: WHEEL_SCAN,
  scanVolumes: fixtureScanRegions("wheel"),
  allowedChangedRegion: NO_VOXELS,
  allowedAddedMaterials: [],
  expectedShape: [],
  allowedChangedNodes: [],
  allowedChangedAnimations: [RIG_CLIP_IDS.wheelSpin],
  playbackClipId: RIG_CLIP_IDS.wheelSpin,
  taskChecks: [
    {
      name: "the spin clip duration doubled to 4 seconds",
      check: (store) => clipOf(store, RIG_CLIP_IDS.wheelSpin)?.duration === 4,
    },
    {
      name: "tracks and keyframes are untouched",
      check: (store) => {
        const clip = clipOf(store, RIG_CLIP_IDS.wheelSpin);
        const track = trackOf(
          clip ?? ({} as AnimationDescriptor),
          "track:eval:wheel-spin:wheel" as TrackId,
        );
        return (
          clip !== undefined &&
          clip.loop === "loop" &&
          clip.tracks.length === 1 &&
          track?.keyframes.length === 2 &&
          track.keyframes.at(0)?.time === 0 &&
          track.keyframes.at(1)?.time === 2 &&
          quatCloseTo(
            track.keyframes.at(1)?.property.value ?? [],
            [0, 1, 0],
            2 * Math.PI,
          )
        );
      },
    },
  ],
  previewSignals: [RIG_NONEMPTY_SIGNAL],
  playbackSignals: [movesExactly([wheel.wheel])],
};

/** wings-one: follow-up that keeps only the left wing flapping. */
const WINGS_ONE: RigScenario = {
  id: "wings-one",
  name: "Flap only the left wing",
  strictShape: false,
  description:
    "Follow-up on the rigged wings: remove only the right wing's track; the left track, keyframes, pivots, and constraints stay untouched.",
  prompt: "Only flap the left wing.",
  fixtureVersion: "v1",
  fixture: "wings-rigged",
  selection: [],
  goldenTrace: [
    { text: "I will inspect the rigged wings first.", toolCalls: [summary()] },
    {
      text: "Removing the right wing track.",
      toolCalls: [
        removeTrack(
          "call_one",
          RIG_CLIP_IDS.wingsFlap,
          "track:eval:wings-flap:right",
        ),
      ],
    },
    {
      text: "Verifying the staged result.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The proposal is ready for approval." },
  ],
  goldenRounds: 4,
  goldenToolCalls: 3,
  goldenCommands: 1,
  scanRegion: WINGS_SCAN,
  scanVolumes: fixtureScanRegions("wings"),
  allowedChangedRegion: NO_VOXELS,
  allowedAddedMaterials: [],
  expectedShape: [],
  allowedChangedNodes: [],
  allowedChangedAnimations: [RIG_CLIP_IDS.wingsFlap],
  playbackClipId: RIG_CLIP_IDS.wingsFlap,
  taskChecks: [
    {
      name: "only the left wing track remains",
      check: (store) => {
        const clip = clipOf(store, RIG_CLIP_IDS.wingsFlap);
        const track = clip?.tracks.at(0);
        return (
          clip !== undefined &&
          track !== undefined &&
          clip.tracks.length === 1 &&
          track.targetNodeId === wings.left &&
          track.keyframes.length === 2 &&
          trackOf(clip, "track:eval:wings-flap:right" as TrackId) === undefined
        );
      },
    },
    {
      name: "the left wing still flaps and the rig is untouched",
      check: (store) =>
        hasJoint(store, wings.right) &&
        hasJoint(store, wings.left) &&
        constraintLimitsOf(store, wings.right, wings.rightFlap) !== undefined,
    },
  ],
  previewSignals: [RIG_NONEMPTY_SIGNAL],
  playbackSignals: [movesExactly([wings.left])],
};

/** arm-elbow-limit: follow-up that restricts the elbow to 90 degrees. */
const ARM_ELBOW_LIMIT: RigScenario = {
  id: "arm-elbow-limit",
  name: "Limit the elbow to 90 degrees",
  strictShape: false,
  description:
    "Follow-up on the rigged arm: replace only the elbow constraint limits with +/-90 degrees; shoulder and wrist limits stay untouched.",
  prompt: "Limit the elbow to 90 degrees.",
  fixtureVersion: "v1",
  fixture: "linked-arm-rigged",
  selection: [],
  goldenTrace: [
    { text: "I will inspect the rigged arm first.", toolCalls: [summary()] },
    {
      text: "Replacing the elbow constraint limits.",
      toolCalls: [
        {
          id: "call_elbow_limit",
          name: "setConstraint",
          arguments: {
            nodeId: arm.link2,
            componentId: arm.elbow,
            limits: {
              min: [-Math.PI, -Math.PI, -Math.PI / 2],
              max: [Math.PI, Math.PI, Math.PI / 2],
            },
          },
        },
      ],
    },
    {
      text: "Verifying the staged result.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The proposal is ready for approval." },
  ],
  goldenRounds: 4,
  goldenToolCalls: 3,
  goldenCommands: 1,
  scanRegion: ARM_SCAN,
  scanVolumes: fixtureScanRegions("linked-arm"),
  allowedChangedRegion: NO_VOXELS,
  allowedAddedMaterials: [],
  expectedShape: [],
  allowedChangedNodes: [arm.link2],
  allowedChangedAnimations: [],
  playbackClipId: RIG_CLIP_IDS.armReach,
  taskChecks: [
    {
      name: "elbow limits are now +/-90 degrees about Z",
      check: (store) => {
        const limits = constraintLimitsOf(store, arm.link2, arm.elbow);
        return (
          limits !== undefined &&
          Math.abs((limits.min[2] as number) + Math.PI / 2) < 1e-9 &&
          Math.abs((limits.max[2] as number) - Math.PI / 2) < 1e-9
        );
      },
    },
    {
      name: "shoulder and wrist limits are untouched",
      check: (store) => {
        const shoulder = constraintLimitsOf(store, arm.link1, arm.shoulder);
        const wrist = constraintLimitsOf(store, arm.link3, arm.wrist);
        return (
          shoulder !== undefined &&
          Math.abs((shoulder.max[0] as number) - Math.PI / 3) < 1e-9 &&
          wrist !== undefined &&
          Math.abs((wrist.max[2] as number) - Math.PI / 4) < 1e-9
        );
      },
    },
  ],
  previewSignals: [RIG_NONEMPTY_SIGNAL],
  playbackSignals: [moves([arm.link3])],
};

/** wheel-faster: follow-up that halves the spin duration. */
const WHEEL_FASTER: RigScenario = {
  id: "wheel-faster",
  name: "Make the wheel spin twice as fast",
  strictShape: false,
  description:
    "Follow-up on the rigged wheel: only the clip duration halves; tracks, keyframes, and the rig stay untouched.",
  prompt: "Make the wheel spin twice as fast.",
  fixtureVersion: "v1",
  fixture: "wheel-rigged",
  selection: [],
  goldenTrace: [
    { text: "I will inspect the rigged wheel first.", toolCalls: [summary()] },
    {
      text: "Moving the loop-point keyframe to 1s, then halving the duration.",
      toolCalls: [
        {
          id: "call_retime",
          name: "moveKeyframe",
          arguments: {
            animationId: RIG_CLIP_IDS.wheelSpin,
            trackId: "track:eval:wheel-spin:wheel",
            keyframeId: "keyframe:eval:wheel-spin:1",
            time: 1,
          },
        },
        updateAnimation("call_faster", RIG_CLIP_IDS.wheelSpin, 1),
      ],
    },
    {
      text: "Verifying the staged result.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The proposal is ready for approval." },
  ],
  goldenRounds: 4,
  goldenToolCalls: 4,
  goldenCommands: 2,
  scanRegion: WHEEL_SCAN,
  scanVolumes: fixtureScanRegions("wheel"),
  allowedChangedRegion: NO_VOXELS,
  allowedAddedMaterials: [],
  expectedShape: [],
  allowedChangedNodes: [],
  allowedChangedAnimations: [RIG_CLIP_IDS.wheelSpin],
  playbackClipId: RIG_CLIP_IDS.wheelSpin,
  taskChecks: [
    {
      name: "the spin clip duration halved to 1 second",
      check: (store) => clipOf(store, RIG_CLIP_IDS.wheelSpin)?.duration === 1,
    },
    {
      name: "the loop point moved to 1s with an unchanged full revolution",
      check: (store) => {
        const clip = clipOf(store, RIG_CLIP_IDS.wheelSpin);
        const track = trackOf(
          clip ?? ({} as AnimationDescriptor),
          "track:eval:wheel-spin:wheel" as TrackId,
        );
        return (
          clip !== undefined &&
          clip.loop === "loop" &&
          clip.tracks.length === 1 &&
          track?.keyframes.length === 2 &&
          track.keyframes.at(0)?.time === 0 &&
          track.keyframes[1]?.time === 1 &&
          quatCloseTo(
            track.keyframes.at(1)?.property.value ?? [],
            [0, 1, 0],
            2 * Math.PI,
          )
        );
      },
    },
  ],
  previewSignals: [RIG_NONEMPTY_SIGNAL],
  playbackSignals: [movesExactly([wheel.wheel])],
};

/** Every fixed rig/animation scenario in canonical order. */
export const RIG_SCENARIOS: readonly RigScenario[] = Object.freeze([
  CHEST_LID_OPEN,
  WHEEL_SPIN,
  WINGS_FLAP,
  ARM_REACH,
  ABSTRACT_RIG,
  CHEST_FARTHER,
  WHEEL_SLOWER,
  WINGS_ONE,
  ARM_ELBOW_LIMIT,
  WHEEL_FASTER,
]);

/** Looks up one rig scenario by id (stable error for unknown ids). */
export function rigScenarioById(id: RigScenarioId): RigScenario {
  const scenario = RIG_SCENARIOS.find((entry) => entry.id === id);
  if (scenario === undefined) throw new Error(`Unknown rig scenario: ${id}`);
  return scenario;
}

/** The golden clip of a rig scenario (reference end state). */
export function goldenClipOf(id: RigScenarioId): AnimationDescriptor {
  const fixture = rigScenarioById(id).fixture;
  if (fixture.endsWith("-rigged")) {
    return evalClipOf(
      fixture.slice(0, -"-rigged".length) as Parameters<typeof evalClipOf>[0],
    );
  }
  return evalClipOf(fixture as Parameters<typeof evalClipOf>[0]);
}

/** Re-export shared scenario helpers for the rig suite tests. */
export type { AnimationDescriptor, EditorSelectionSnapshot };
