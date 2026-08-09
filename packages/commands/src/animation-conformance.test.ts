import { describe, expect, it } from "vitest";
import {
  animationId,
  commandId,
  keyframeId,
  nodeId,
  trackId,
  transactionId,
} from "@voxel-maker/shared";
import {
  cloneDocument,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import type { DocumentStoreRead } from "@voxel-maker/document";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import { registerNodeCommands } from "./node-commands.js";
import {
  ANIMATION_CREATE_COMMAND,
  ANIMATION_DELETE_COMMAND,
  ANIMATION_UPDATE_COMMAND,
  KEYFRAME_DELETE_COMMAND,
  KEYFRAME_MOVE_COMMAND,
  KEYFRAME_SET_COMMAND,
  TRACK_ADD_COMMAND,
  TRACK_REMOVE_COMMAND,
  TRACK_SET_INTERPOLATION_COMMAND,
  addTrackCommand,
  createAnimationCommand,
  deleteAnimationCommand,
  deleteKeyframeCommand,
  moveKeyframeCommand,
  registerAnimationCommands,
  removeTrackCommand,
  setKeyframeCommand,
  setTrackInterpolationCommand,
  updateAnimationCommand,
} from "./animation-commands.js";
import {
  runCommandConformanceSuite,
  type CommandConformanceSpec,
} from "./conformance.js";
import type { Command } from "./types.js";

/**
 * Clip/track/keyframe command conformance (plan S10.6, ticket #28): every
 * registered animation command runs the full shared command battery —
 * codec, validity, exact-restore undo/redo, determinism, conflict,
 * limits, rollback, idempotency, history, and audit metadata.
 */

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:conformance:anim:root");
const CHILD = nodeId("node:conformance:anim:child");
const CLIP = animationId("animation:conformance:anim:spin");
const OTHER_CLIP = animationId("animation:conformance:anim:other");
const TRACK = trackId("track:conformance:anim:spin");
const OTHER_TRACK = trackId("track:conformance:anim:other");
const KEY = keyframeId("keyframe:conformance:anim:spin:0");
const KEY_2 = keyframeId("keyframe:conformance:anim:spin:1");

function buildFixtureDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:conformance:anim" as never,
    metadata: { title: "animation conformance" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [CHILD],
        transform: identity,
        components: [],
      },
      {
        nodeId: CHILD,
        name: "Child",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: [],
      },
    ],
  });
}

const fixture = buildFixtureDocument();
const createFixture = (): VoxelDocument => cloneDocument(fixture);

const clipRecord = (store: DocumentStoreRead, id = CLIP) =>
  store.getDocument().animations[id];

const trackRecord = (store: DocumentStoreRead, id = TRACK) =>
  clipRecord(store)?.tracks.find((track) => track.trackId === id);

const keyframes = (store: DocumentStoreRead) =>
  trackRecord(store)?.keyframes ?? [];

const register = (registry: CommandRegistry): void => {
  registerNodeCommands(registry);
  registerAnimationCommands(registry);
};

/** Seeds one clip with one track and one keyframe through the bus. */
function seedClip(bus: CommandBus, store: DocumentStoreRead): void {
  const tx = (label: string) => ({
    transactionId: transactionId(`transaction:conformance:anim:${label}`),
    expectedRevision: store.revision,
    source: "ui" as const,
  });
  const steps: Command[] = [
    createAnimationCommand(commandId("command:conformance:anim:create:0001"), {
      animationId: CLIP,
      name: "Spin",
      duration: 2,
      loop: "once",
    }),
    addTrackCommand(commandId("command:conformance:anim:track:0001"), {
      animationId: CLIP,
      trackId: TRACK,
      targetNodeId: CHILD,
      interpolation: "linear",
    }),
    setKeyframeCommand(commandId("command:conformance:anim:key:0001"), {
      animationId: CLIP,
      trackId: TRACK,
      keyframeId: KEY,
      time: 0,
      property: { channel: "rotation", value: [0, 0, 0, 1] },
    }),
  ];
  for (const step of steps) {
    const result = bus.execute(step, tx(step.id));
    if (!result.ok)
      throw new Error(`conformance seed failed: ${result.error.code}`);
  }
}

const createSpec: CommandConformanceSpec = {
  name: "animation.create@1",
  type: ANIMATION_CREATE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register,
  buildValid: (id) =>
    createAnimationCommand(id, {
      animationId: CLIP,
      name: "Spin",
      duration: 2,
      loop: "once",
    }),
  buildInvalid: (id) =>
    createAnimationCommand(id, {
      animationId: CLIP,
      duration: 0,
      loop: "loop",
    }),
  buildSecondValid: (id) =>
    createAnimationCommand(id, {
      animationId: OTHER_CLIP,
      duration: 1,
      loop: "loop",
    }),
  assertApplied: (store) => {
    expect(clipRecord(store)).toMatchObject({
      animationId: CLIP,
      name: "Spin",
      duration: 2,
      loop: "once",
      tracks: [],
    });
  },
  assertUndone: (store) => {
    expect(clipRecord(store)).toBeUndefined();
  },
  assertSecondApplied: (store) => {
    expect(clipRecord(store, OTHER_CLIP)).toMatchObject({
      animationId: OTHER_CLIP,
      duration: 1,
      loop: "loop",
    });
  },
};

const updateSpec: CommandConformanceSpec = {
  name: "animation.update@1",
  type: ANIMATION_UPDATE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register,
  seed: seedClip,
  buildValid: (id) =>
    updateAnimationCommand(id, {
      animationId: CLIP,
      duration: 3,
      loop: "loop",
    }),
  buildInvalid: (id) =>
    updateAnimationCommand(id, { animationId: CLIP, duration: -1 }),
  buildSecondValid: (id) =>
    updateAnimationCommand(id, { animationId: CLIP, name: "Renamed" }),
  assertApplied: (store) => {
    expect(clipRecord(store)).toMatchObject({
      name: "Spin",
      duration: 3,
      loop: "loop",
    });
  },
  assertUndone: (store) => {
    expect(clipRecord(store)).toMatchObject({
      name: "Spin",
      duration: 2,
      loop: "once",
    });
  },
  assertSecondApplied: (store) => {
    expect(clipRecord(store)).toMatchObject({ name: "Renamed" });
  },
};

const deleteSpec: CommandConformanceSpec = {
  name: "animation.delete@1",
  type: ANIMATION_DELETE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register,
  seed: seedClip,
  buildValid: (id) => deleteAnimationCommand(id, { animationId: CLIP }),
  buildInvalid: (id) => ({
    id,
    type: ANIMATION_DELETE_COMMAND,
    schemaVersion: 1,
    payload: { animationId: 42 },
  }),
  buildSecondValid: (id) =>
    deleteAnimationCommand(id, {
      animationId: animationId("animation:conformance:absent"),
    }),
  assertApplied: (store) => {
    expect(clipRecord(store)).toBeUndefined();
  },
  assertUndone: (store) => {
    expect(clipRecord(store)).toMatchObject({ animationId: CLIP, duration: 2 });
    expect(keyframes(store)).toHaveLength(1);
  },
  assertSecondApplied: (store) => {
    expect(clipRecord(store)).toBeUndefined();
  },
};

const addTrackSpec: CommandConformanceSpec = {
  name: "track.add@1",
  type: TRACK_ADD_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register,
  seed: (bus, store) => {
    const result = bus.execute(
      createAnimationCommand(
        commandId("command:conformance:anim:create:0001"),
        {
          animationId: CLIP,
          duration: 2,
          loop: "once",
        },
      ),
      {
        transactionId: transactionId(
          "transaction:conformance:anim:create:0001",
        ),
        expectedRevision: store.revision,
        source: "ui",
      },
    );
    if (!result.ok)
      throw new Error(`conformance seed failed: ${result.error.code}`);
  },
  buildValid: (id) =>
    addTrackCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      targetNodeId: CHILD,
      interpolation: "linear",
    }),
  buildInvalid: (id) =>
    addTrackCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      targetNodeId: nodeId("node:conformance:anim:missing"),
      interpolation: "linear",
    }),
  buildSecondValid: (id) =>
    addTrackCommand(id, {
      animationId: CLIP,
      trackId: OTHER_TRACK,
      targetNodeId: ROOT,
      interpolation: "smoothstep",
    }),
  assertApplied: (store) => {
    expect(trackRecord(store)).toMatchObject({
      trackId: TRACK,
      targetNodeId: CHILD,
      interpolation: "linear",
      keyframes: [],
    });
  },
  assertUndone: (store) => {
    expect(trackRecord(store)).toBeUndefined();
  },
  assertSecondApplied: (store) => {
    expect(trackRecord(store, OTHER_TRACK)).toMatchObject({
      targetNodeId: ROOT,
      interpolation: "smoothstep",
    });
  },
};

const removeTrackSpec: CommandConformanceSpec = {
  name: "track.remove@1",
  type: TRACK_REMOVE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register,
  seed: seedClip,
  buildValid: (id) =>
    removeTrackCommand(id, { animationId: CLIP, trackId: TRACK }),
  buildInvalid: (id) =>
    removeTrackCommand(id, {
      animationId: animationId("animation:conformance:missing"),
      trackId: TRACK,
    }),
  buildSecondValid: (id) =>
    removeTrackCommand(id, {
      animationId: CLIP,
      trackId: trackId("track:conformance:anim:absent"),
    }),
  assertApplied: (store) => {
    expect(trackRecord(store)).toBeUndefined();
  },
  assertUndone: (store) => {
    expect(trackRecord(store)).toMatchObject({ trackId: TRACK });
    // The removed track's keyframe comes back with it.
    expect(keyframes(store)).toHaveLength(1);
  },
  assertSecondApplied: (store) => {
    expect(trackRecord(store)).toBeUndefined();
  },
};

const setInterpolationSpec: CommandConformanceSpec = {
  name: "track.setInterpolation@1",
  type: TRACK_SET_INTERPOLATION_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register,
  seed: seedClip,
  buildValid: (id) =>
    setTrackInterpolationCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      interpolation: "step",
    }),
  buildInvalid: (id) =>
    setTrackInterpolationCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      interpolation: "ease-in" as never,
    }),
  buildSecondValid: (id) =>
    setTrackInterpolationCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      interpolation: "smoothstep",
    }),
  assertApplied: (store) => {
    expect(trackRecord(store)?.interpolation).toBe("step");
  },
  assertUndone: (store) => {
    expect(trackRecord(store)?.interpolation).toBe("linear");
  },
  assertSecondApplied: (store) => {
    expect(trackRecord(store)?.interpolation).toBe("smoothstep");
  },
};

const setKeyframeSpec: CommandConformanceSpec = {
  name: "keyframe.set@1",
  type: KEYFRAME_SET_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register,
  seed: seedClip,
  buildValid: (id) =>
    setKeyframeCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      keyframeId: KEY_2,
      time: 1,
      property: { channel: "rotation", value: [0, 1, 0, 0] },
    }),
  buildInvalid: (id) =>
    setKeyframeCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      keyframeId: KEY_2,
      time: 5,
      property: { channel: "rotation", value: [0, 0, 0, 1] },
    }),
  buildSecondValid: (id) =>
    setKeyframeCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      keyframeId: KEY,
      time: 0,
      property: { channel: "rotation", value: [0, 0, 0, 1] },
    }),
  assertApplied: (store) => {
    expect(keyframes(store)).toHaveLength(2);
    expect(keyframes(store)[1]).toMatchObject({ time: 1 });
  },
  assertUndone: (store) => {
    expect(keyframes(store)).toHaveLength(1);
  },
  assertSecondApplied: (store) => {
    // Updating the existing keyframe in place keeps one keyframe.
    expect(keyframes(store)).toHaveLength(2);
  },
};

const moveKeyframeSpec: CommandConformanceSpec = {
  name: "keyframe.move@1",
  type: KEYFRAME_MOVE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register,
  seed: seedClip,
  buildValid: (id) =>
    moveKeyframeCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      keyframeId: KEY,
      time: 1.5,
    }),
  buildInvalid: (id) =>
    moveKeyframeCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      keyframeId: keyframeId("keyframe:conformance:missing"),
      time: 1,
    }),
  buildSecondValid: (id) =>
    moveKeyframeCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      keyframeId: KEY,
      time: 0,
    }),
  assertApplied: (store) => {
    expect(keyframes(store)[0]?.time).toBe(1.5);
  },
  assertUndone: (store) => {
    expect(keyframes(store)[0]?.time).toBe(0);
  },
  assertSecondApplied: (store) => {
    // Moving back to the original time is a no-op commit (unchanged).
    expect(keyframes(store)[0]?.time).toBe(0);
  },
};

const deleteKeyframeSpec: CommandConformanceSpec = {
  name: "keyframe.delete@1",
  type: KEYFRAME_DELETE_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register,
  seed: seedClip,
  buildValid: (id) =>
    deleteKeyframeCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      keyframeId: KEY,
    }),
  buildInvalid: (id) =>
    deleteKeyframeCommand(id, {
      animationId: animationId("animation:conformance:missing"),
      trackId: TRACK,
      keyframeId: KEY,
    }),
  buildSecondValid: (id) =>
    deleteKeyframeCommand(id, {
      animationId: CLIP,
      trackId: TRACK,
      keyframeId: keyframeId("keyframe:conformance:anim:absent"),
    }),
  assertApplied: (store) => {
    expect(keyframes(store)).toHaveLength(0);
  },
  assertUndone: (store) => {
    expect(keyframes(store)).toHaveLength(1);
    expect(keyframes(store)[0]).toMatchObject({ keyframeId: KEY, time: 0 });
  },
  assertSecondApplied: (store) => {
    expect(keyframes(store)).toHaveLength(0);
  },
};

describe("animation command conformance", () => {
  runCommandConformanceSuite(createSpec, { describe, it, expect });
  runCommandConformanceSuite(updateSpec, { describe, it, expect });
  runCommandConformanceSuite(deleteSpec, { describe, it, expect });
  runCommandConformanceSuite(addTrackSpec, { describe, it, expect });
  runCommandConformanceSuite(removeTrackSpec, { describe, it, expect });
  runCommandConformanceSuite(setInterpolationSpec, { describe, it, expect });
  runCommandConformanceSuite(setKeyframeSpec, { describe, it, expect });
  runCommandConformanceSuite(moveKeyframeSpec, { describe, it, expect });
  runCommandConformanceSuite(deleteKeyframeSpec, { describe, it, expect });
});
