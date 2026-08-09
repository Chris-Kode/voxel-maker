import { describe, expect, it } from "vitest";
import {
  animationId,
  commandId,
  keyframeId,
  nodeId,
  trackId,
} from "@voxel-maker/shared";
import type { AnimationDescriptor } from "@voxel-maker/model";
import {
  setNodeTransformCommand,
  setKeyframeCommand,
  type Command,
  type SetKeyframePayload,
} from "@voxel-maker/commands";
import { buildAutoKeyCommands } from "./auto-key.js";


/** Narrow helper: treats a keyframe.set command as its payload. */
function keyPayload(
  command: Command | undefined,
): SetKeyframePayload | undefined {
  if (command === undefined || command.type !== "keyframe.set") return undefined;
  return command.payload as SetKeyframePayload;
}

/**
 * Auto-key command construction (plan S10.12, ticket #29): when the
 * timeline key mode is "auto", transform edits must intentionally target
 * the selected clip. The pure builder turns the transaction's
 * `node.setTransform` commands into `keyframe.set` commands for every
 * track of the selected clip that speaks the edited channel — creating
 * keyframes at the playhead or updating the keyframe already parked
 * there. Tracks without an established channel are skipped (the data
 * model derives a track's channel from its first keyframe).
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:autokey:root");
const WHEEL = nodeId("node:autokey:wheel");
const ARM = nodeId("node:autokey:arm");
const CLIP = animationId("animation:autokey:spin");
const ROT_TRACK = trackId("track:autokey:rot");
const POS_TRACK = trackId("track:autokey:pos");
const EMPTY_TRACK = trackId("track:autokey:empty");
const EXISTING_KEY = keyframeId("keyframe:autokey:existing");

function clip(): AnimationDescriptor {
  return {
    animationId: CLIP,
    name: "spin",
    duration: 2,
    loop: "loop",
    tracks: [
      {
        trackId: ROT_TRACK,
        targetNodeId: WHEEL,
        interpolation: "linear",
        keyframes: [
          {
            keyframeId: EXISTING_KEY,
            time: 1,
            property: { channel: "rotation", value: [0, 0, 0, 1] },
          },
        ],
      },
      {
        trackId: POS_TRACK,
        targetNodeId: ARM,
        interpolation: "linear",
        keyframes: [
          {
            keyframeId: keyframeId("keyframe:autokey:pos:0"),
            time: 0,
            property: { channel: "translation", value: [0, 0, 0] },
          },
        ],
      },
      {
        trackId: EMPTY_TRACK,
        targetNodeId: WHEEL,
        interpolation: "step",
        keyframes: [],
      },
    ],
  };
}

function transformCommands(): readonly Command[] {
  return [
    setNodeTransformCommand(commandId("command:autokey:move:0001"), {
      nodeId: WHEEL,
      transform: {
        ...IDENTITY,
        rotation: [0, 0.7071067811865476, 0, 0.7071067811865476],
      },
    }),
    setNodeTransformCommand(commandId("command:autokey:move:0002"), {
      nodeId: ARM,
      transform: { ...IDENTITY, translation: [2, 0, 0] },
    }),
  ];
}

describe("buildAutoKeyCommands", () => {
  it("produces no keyframe commands without transform commands", () => {
    const commands = buildAutoKeyCommands([], {
      clip: clip(),
      time: 1,
      nextKeyframeId: () => keyframeId("keyframe:autokey:none"),
    });
    expect(commands).toEqual([]);
  });

  it("creates keyframes at the playhead for matching tracks", () => {
    const commands = buildAutoKeyCommands(transformCommands(), {
      clip: clip(),
      time: 1.5,
      nextKeyframeId: (track) => keyframeId(`keyframe:autokey:new:${track}`),
    });
    expect(commands).toHaveLength(2);
    const rotation = keyPayload(commands[0]);
    const translation = keyPayload(commands[1]);
    expect(rotation).toBeDefined();
    expect(translation).toBeDefined();
    if (rotation === undefined || translation === undefined)
      throw new Error("unexpected command list");
    expect(rotation.animationId).toBe(CLIP);
    expect(rotation.trackId).toBe(ROT_TRACK);
    expect(rotation.time).toBe(1.5);
    expect(rotation.property.channel).toBe("rotation");
    expect(rotation.keyframeId).toBe(
      keyframeId(`keyframe:autokey:new:${ROT_TRACK}`),
    );
    expect(translation.trackId).toBe(POS_TRACK);
    expect(translation.time).toBe(1.5);
    expect(translation.property.channel).toBe("translation");
    expect(translation.property.value).toEqual([2, 0, 0]);
  });

  it("updates the keyframe already parked at the playhead", () => {
    const commands = buildAutoKeyCommands(
      [
        setNodeTransformCommand(commandId("command:autokey:move:0003"), {
          nodeId: WHEEL,
          transform: {
            ...IDENTITY,
            rotation: [0, 1, 0, 0],
          },
        }),
      ],
      {
        clip: clip(),
        time: 1,
        nextKeyframeId: () => keyframeId("keyframe:autokey:never"),
      },
    );
    expect(commands).toHaveLength(1);
    const key = keyPayload(commands[0]);
    if (key === undefined) throw new Error("unexpected command list");
    expect(key.keyframeId).toBe(EXISTING_KEY);
    expect(key.time).toBe(1);
    expect(key.property.value).toEqual([0, 1, 0, 0]);
  });

  it("skips tracks without an established channel", () => {
    const commands = buildAutoKeyCommands(
      [
        setNodeTransformCommand(commandId("command:autokey:move:0004"), {
          nodeId: WHEEL,
          transform: { ...IDENTITY, translation: [5, 0, 0] },
        }),
      ],
      {
        clip: clip(),
        time: 1,
        nextKeyframeId: (track) => keyframeId(`keyframe:autokey:new:${track}`),
      },
    );
    // EMPTY_TRACK has no keyframes, so its channel is unknown and it must
    // not receive a keyframe — only the established rotation track keys.
    expect(commands).toHaveLength(1);
    const key = keyPayload(commands[0]);
    if (key === undefined) throw new Error("unexpected command list");
    expect(key.trackId).toBe(ROT_TRACK);
  });

  it("clamps the key time into the clip duration", () => {
    const commands = buildAutoKeyCommands(
      [
        setNodeTransformCommand(commandId("command:autokey:move:0005"), {
          nodeId: ARM,
          transform: { ...IDENTITY, translation: [1, 1, 1] },
        }),
      ],
      {
        clip: clip(),
        time: 99,
        nextKeyframeId: (track) => keyframeId(`keyframe:autokey:new:${track}`),
      },
    );
    expect(commands).toHaveLength(1);
    const key = keyPayload(commands[0]);
    if (key === undefined) throw new Error("unexpected command list");
    expect(key.time).toBe(2);
  });

  it("dedupes repeated transforms of one node to the last value", () => {
    const commands = buildAutoKeyCommands(
      [
        setNodeTransformCommand(commandId("command:autokey:move:0006"), {
          nodeId: ARM,
          transform: { ...IDENTITY, translation: [1, 0, 0] },
        }),
        setNodeTransformCommand(commandId("command:autokey:move:0007"), {
          nodeId: ARM,
          transform: { ...IDENTITY, translation: [7, 0, 0] },
        }),
      ],
      {
        clip: clip(),
        time: 1,
        nextKeyframeId: (track) => keyframeId(`keyframe:autokey:new:${track}`),
      },
    );
    expect(commands).toHaveLength(1);
    const key = keyPayload(commands[0]);
    if (key === undefined) throw new Error("unexpected command list");
    expect(key.property.value).toEqual([7, 0, 0]);
  });

  it("ignores commands that are not node.setTransform", () => {
    const commands = buildAutoKeyCommands(
      [
        setKeyframeCommand(commandId("command:autokey:other:0001"), {
          animationId: CLIP,
          trackId: ROT_TRACK,
          keyframeId: keyframeId("keyframe:autokey:other"),
          time: 0.5,
          property: { channel: "rotation", value: [0, 0, 0, 1] },
        }),
      ],
      {
        clip: clip(),
        time: 1,
        nextKeyframeId: () => keyframeId("keyframe:autokey:none"),
      },
    );
    expect(commands).toEqual([]);
  });

  it("ignores transform commands for nodes without matching tracks", () => {
    const commands = buildAutoKeyCommands(
      [
        setNodeTransformCommand(commandId("command:autokey:move:0008"), {
          nodeId: ROOT,
          transform: { ...IDENTITY, translation: [3, 0, 0] },
        }),
      ],
      {
        clip: clip(),
        time: 1,
        nextKeyframeId: () => keyframeId("keyframe:autokey:none"),
      },
    );
    expect(commands).toEqual([]);
  });
});
