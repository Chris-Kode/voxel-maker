import { describe, expect, it } from "vitest";
import {
  commandId,
  documentId,
  keyframeId,
  materialId,
  nodeId,
  trackId,
  volumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  registerAnimationCommands,
  registerNodeCommands,
  setNodeTransformCommand,
} from "@voxel-maker/commands";
import { createDocumentSession, type DocumentSession } from "@voxel-maker/session";
import { createEditorStore } from "@voxel-maker/editor";
import {
  createTimelineController,
  type TimelineController,
} from "./timeline-controller.js";

/** Narrow helper: treats a keyframe.set command as its payload. */
function keyPayload(
  command: { readonly type: string; readonly payload: unknown } | undefined,
): { readonly time: number; readonly property: { readonly channel: string; readonly value: readonly number[] } } | undefined {
  if (command === undefined || command.type !== "keyframe.set") return undefined;
  return command.payload as {
    readonly time: number;
    readonly property: { readonly channel: string; readonly value: readonly number[] };
  };
}

/**
 * Timeline controller (plan S10.9-S10.13, ticket #29): the headless seam
 * between the timeline UI and the session command bus. Every authored
 * change — clip CRUD, tracks, keyframes, interpolation, manual keys, and
 * the auto-key augmentation — compiles to the registered animation
 * commands and commits through the bus as one labeled atomic undoable
 * transaction. Transport (play/pause/stop/loop/scrub) drives the
 * playback controller; zoom/scroll/playhead/selection/snap/key-mode stay
 * runtime-only.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:timeline:root");
const WHEEL = nodeId("node:timeline:wheel");
const ARM = nodeId("node:timeline:arm");
const MATERIAL = materialId(1);
const VOLUME = volumeId("volume:timeline:0001");

function fixtureDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:timeline:0001"),
    metadata: { title: "timeline controller" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [WHEEL, ARM],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: WHEEL,
        name: "Wheel",
        parentId: ROOT,
        children: [],
        transform: { ...IDENTITY, translation: [1, 0, 0] },
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
      {
        nodeId: ARM,
        name: "Arm",
        parentId: ROOT,
        children: [],
        transform: { ...IDENTITY, rotation: [0, 0, 0, 1] },
        components: [],
      },
    ],
    materials: [
      {
        materialId: MATERIAL,
        name: "red",
        color: "#ff0000",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [{ volumeId: VOLUME, bounds: { min: [-4, -4, -4], max: [4, 4, 4] } }],
  });
}

function makeSession(): DocumentSession {
  return createDocumentSession({
    registerCommands: [registerNodeCommands, registerAnimationCommands],
  });
}

function controller(
  session: DocumentSession,
): TimelineController {
  const editor = createEditorStore();
  const timeline = createTimelineController({ session, editor });
  return timeline;
}

function openFixture(
  timeline: TimelineController,
  session: DocumentSession,
): void {
  session.open({
    document: fixtureDocument(),
    source: "system",
  });
}

function state(timeline: TimelineController) {
  return timeline.state;
}

describe("timeline controller", () => {
  it("is inert without an open document", () => {
    const session = makeSession();
    const timeline = controller(session);
    expect(state(timeline).open).toBe(false);
    expect(state(timeline).clips).toEqual([]);
    expect(timeline.createClip("spin", 1, "loop")).toBeDefined();
    timeline.dispose();
  });

  it("creates a clip and selects it, loading it into the transport", () => {
    const session = makeSession();
    const timeline = controller(session);
    openFixture(timeline, session);
    const error = timeline.createClip("spin", 2, "loop");
    expect(error).toBeUndefined();
    const s = state(timeline);
    expect(s.clips).toHaveLength(1);
    expect(s.selectedClipId).toBe(s.clips[0]?.animationId);
    expect(s.selectedClip?.name).toBe("spin");
    expect(s.selectedClip?.duration).toBe(2);
    expect(s.selectedClip?.loop).toBe("loop");
    expect(s.playhead).toBe(0);
    timeline.dispose();
  });

  it("adds tracks for nodes with a chosen channel and selects them", () => {
    const session = makeSession();
    const timeline = controller(session);
    openFixture(timeline, session);
    timeline.createClip("spin", 2, "loop");
    const error = timeline.addTracks([WHEEL, ARM], "rotation");
    expect(error).toBeUndefined();
    const s = state(timeline);
    expect(s.tracks).toHaveLength(2);
    expect(s.tracks.map((entry) => entry.nodeName)).toEqual(["Wheel", "Arm"]);
    expect(s.selectedTrackIds).toHaveLength(2);
    timeline.dispose();
  });

  it("keys the selected clip at the playhead from node transforms", () => {
    const session = makeSession();
    const timeline = controller(session);
    openFixture(timeline, session);
    timeline.createClip("spin", 2, "loop");
    timeline.addTracks([WHEEL], "translation");
    timeline.scrub(0.5);
    const error = timeline.keySelection();
    expect(error).toBeUndefined();
    const s = state(timeline);
    expect(s.selectedClip?.tracks[0]?.keyframes).toHaveLength(1);
    const keyframe = s.selectedClip?.tracks[0]?.keyframes[0];
    expect(keyframe?.time).toBe(0.5);
    // Wheel base translation is [1,0,0]; the key captures it.
    expect(keyframe?.property).toEqual({
      channel: "translation",
      value: [1, 0, 0],
    });
    expect(s.selectedKeyframeIds).toEqual([keyframe?.keyframeId]);
    timeline.dispose();
  });

  it("creates, moves, and deletes keyframes through commands with undo", () => {
    const session = makeSession();
    const timeline = controller(session);
    openFixture(timeline, session);
    timeline.createClip("spin", 2, "loop");
    timeline.addTracks([WHEEL], "rotation");
    const trackIdValue = state(timeline).tracks[0]?.track.trackId;
    if (trackIdValue === undefined) throw new Error("missing track");
    const error = timeline.setKeyframe(trackIdValue, 0.5, {
      channel: "rotation",
      value: [0, 0.7071067811865476, 0, 0.7071067811865476],
    });
    expect(error).toBeUndefined();
    let clip = state(timeline).selectedClip;
    expect(clip?.tracks[0]?.keyframes).toHaveLength(1);
    const key = clip?.tracks[0]?.keyframes[0];
    if (key === undefined) throw new Error("missing keyframe");

    // Move the keyframe to 1.25s.
    const moveError = timeline.moveKeyframes([
      { trackId: trackIdValue, keyframeId: key.keyframeId, time: 1.3 },
    ]);
    expect(moveError).toBeUndefined();
    clip = state(timeline).selectedClip;
    expect(clip?.tracks[0]?.keyframes[0]?.time).toBe(1.3);

    // Update in place: same keyframe id, new value, same time.
    const updateError = timeline.setKeyframe(trackIdValue, 1.3, {
      channel: "rotation",
      value: [0, 1, 0, 0],
    });
    expect(updateError).toBeUndefined();
    clip = state(timeline).selectedClip;
    expect(clip?.tracks[0]?.keyframes).toHaveLength(1);
    expect(clip?.tracks[0]?.keyframes[0]?.keyframeId).toBe(key.keyframeId);
    expect(clip?.tracks[0]?.keyframes[0]?.property.value).toEqual([0, 1, 0, 0]);

    // Delete it.
    timeline.selectKeyframes([key.keyframeId]);
    const deleteError = timeline.deleteSelectedKeyframes();
    expect(deleteError).toBeUndefined();
    clip = state(timeline).selectedClip;
    expect(clip?.tracks[0]?.keyframes).toHaveLength(0);
    expect(state(timeline).selectedKeyframeIds).toEqual([]);

    // Undo walks the authored history back exactly: delete, update, move,
    // create — each reversal restores the precise prior state.
    expect(timeline.undo()).toBeUndefined();
    clip = state(timeline).selectedClip;
    expect(clip?.tracks[0]?.keyframes).toHaveLength(1);
    expect(timeline.undo()).toBeUndefined();
    clip = state(timeline).selectedClip;
    expect(clip?.tracks[0]?.keyframes[0]?.property.value).toEqual([0, 0.7071067811865476, 0, 0.7071067811865476]);
    expect(timeline.undo()).toBeUndefined();
    clip = state(timeline).selectedClip;
    expect(clip?.tracks[0]?.keyframes[0]?.time).toBe(0.5);
    expect(timeline.undo()).toBeUndefined();
    clip = state(timeline).selectedClip;
    expect(clip?.tracks[0]?.keyframes).toHaveLength(0);
    timeline.dispose();
  });

  it("sets interpolation and updates clip properties", () => {
    const session = makeSession();
    const timeline = controller(session);
    openFixture(timeline, session);
    timeline.createClip("spin", 2, "loop");
    timeline.addTracks([WHEEL], "rotation");
    const trackIdValue = state(timeline).tracks[0]?.track.trackId;
    if (trackIdValue === undefined) throw new Error("missing track");
    expect(timeline.setInterpolation(trackIdValue, "smoothstep")).toBeUndefined();
    expect(timeline.updateClip({ name: "wheel-spin", duration: 4, loop: "once" })).toBeUndefined();
    const clip = state(timeline).selectedClip;
    expect(clip?.name).toBe("wheel-spin");
    expect(clip?.duration).toBe(4);
    expect(clip?.loop).toBe("once");
    expect(clip?.tracks[0]?.interpolation).toBe("smoothstep");
    timeline.dispose();
  });

  it("deletes the selected clip and clears the selection", () => {
    const session = makeSession();
    const timeline = controller(session);
    openFixture(timeline, session);
    timeline.createClip("spin", 2, "loop");
    timeline.addTracks([WHEEL], "rotation");
    expect(timeline.deleteClip()).toBeUndefined();
    const s = state(timeline);
    expect(s.selectedClipId).toBeUndefined();
    expect(s.clips).toEqual([]);
    expect(s.selectedTrackIds).toEqual([]);
    timeline.dispose();
  });

  it("prunes selections when referenced clips/tracks vanish", () => {
    const session = makeSession();
    const timeline = controller(session);
    openFixture(timeline, session);
    timeline.createClip("spin", 2, "loop");
    timeline.addTracks([WHEEL], "rotation");
    const trackIdValue = state(timeline).tracks[0]?.track.trackId;
    if (trackIdValue === undefined) throw new Error("missing track");
    timeline.setKeyframe(trackIdValue, 0.5, {
      channel: "rotation",
      value: [0, 0, 0, 1],
    });
    timeline.selectKeyframes([state(timeline).selectedKeyframeIds[0] ?? keyframeId("x")]);
    // Delete the whole clip through the bus; the controller must clear
    // track/keyframe selection.
    expect(timeline.deleteClip()).toBeUndefined();
    const s = state(timeline);
    expect(s.selectedClipId).toBeUndefined();
    expect(s.selectedTrackIds).toEqual([]);
    expect(s.selectedKeyframeIds).toEqual([]);
    timeline.dispose();
  });

  it("scrubs with snapping and clamps into the clip duration", () => {
    const session = makeSession();
    const timeline = controller(session);
    openFixture(timeline, session);
    timeline.createClip("spin", 2, "loop");
    timeline.scrub(0.34);
    expect(timeline.playhead).toBe(0.3); // snap increment 0.1
    timeline.scrub(9);
    expect(timeline.playhead).toBe(2);
    timeline.setSnapEnabled(false);
    timeline.scrub(0.34);
    expect(timeline.playhead).toBe(0.34);
    timeline.dispose();
  });

  it("plays, pauses, stops, and loops through the playback controller", () => {
    let now = 1000;
    const session = makeSession();
    const editor = createEditorStore();
    const timeline = createTimelineController({
      session,
      editor,
      clock: { now: () => now },
    });
    openFixture(timeline, session);
    timeline.createClip("spin", 2, "loop");
    timeline.play();
    expect(state(timeline).playing).toBe(true);
    now += 0.5;
    timeline.tick(now);
    expect(timeline.playhead).toBeCloseTo(0.5, 9);
    timeline.pause();
    expect(state(timeline).playing).toBe(false);
    timeline.toggleLoop();
    expect(state(timeline).loopOverride).toBe(true);
    timeline.stop();
    expect(state(timeline).stopped).toBe(true);
    expect(timeline.playhead).toBe(0);
    timeline.dispose();
  });

  it("auto-key mode augments transform transactions into the selected clip", () => {
    const session = makeSession();
    const timeline = controller(session);
    openFixture(timeline, session);
    timeline.createClip("spin", 2, "loop");
    timeline.addTracks([WHEEL], "rotation");
    timeline.setKeyframe(state(timeline).tracks[0]?.track.trackId ?? trackId("x"), 0, {
      channel: "rotation",
      value: [0, 0, 0, 1],
    });
    timeline.scrub(1);
    // Manual mode: the transaction passes through unchanged.
    const manualCommands = [
      setNodeTransformCommand(commandId("command:timeline:move:0001"), {
        nodeId: WHEEL,
        transform: { ...IDENTITY, rotation: [0, 1, 0, 0] },
      }),
    ];
    expect(timeline.autoKeyCommands(manualCommands)).toBe(manualCommands);
    timeline.setKeyMode("auto");
    const extra = timeline.autoKeyCommands([
      setNodeTransformCommand(commandId("command:timeline:move:0002"), {
        nodeId: WHEEL,
        transform: { ...IDENTITY, rotation: [0, 1, 0, 0] },
      }),
    ]);
    expect(extra).toHaveLength(2);
    // The transaction keeps its transform command and gains the key.
    expect(extra[0]?.type).toBe("node.setTransform");
    const key = keyPayload(extra[1]);
    if (key === undefined) throw new Error("unexpected command list");
    expect(key.time).toBe(1);
    expect(key.property.channel).toBe("rotation");
    expect(key.property.value).toEqual([0, 1, 0, 0]);
    timeline.dispose();
  });

  it("derives keyframe values from the track channel and node transform", () => {
    const session = makeSession();
    const timeline = controller(session);
    openFixture(timeline, session);
    timeline.createClip("spin", 2, "loop");
    timeline.addTracks([ARM], "rotation");
    const trackIdValue = state(timeline).tracks[0]?.track.trackId;
    if (trackIdValue === undefined) throw new Error("missing track");
    expect(timeline.channelForTrack(trackIdValue)).toBe("rotation");
    // Omitted property: value comes from the node's base rotation.
    const error = timeline.setKeyframe(trackIdValue, 0.5);
    expect(error).toBeUndefined();
    const keyframe = state(timeline).selectedClip?.tracks[0]?.keyframes[0];
    expect(keyframe?.property).toEqual({
      channel: "rotation",
      value: [0, 0, 0, 1],
    });
    timeline.dispose();
  });

  it("refreshes the playback snapshot after document commits", () => {
    const session = makeSession();
    const timeline = controller(session);
    openFixture(timeline, session);
    timeline.createClip("spin", 2, "loop");
    timeline.scrub(1.3);
    // A commit through the bus (keyframe edit) must not rewind the playhead.
    timeline.addTracks([WHEEL], "rotation");
    expect(timeline.playhead).toBe(1.3);
    timeline.dispose();
  });
});
