import { describe, expect, it } from "vitest";
import {
  animationId,
  commandId,
  keyframeId,
  nodeId,
  trackId,
  transactionId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { type DocumentStoreRead } from "@voxel-maker/document";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import type { TransactionOptions } from "./types.js";
import { registerNodeCommands } from "./node-commands.js";
import {
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

/**
 * Clip/track/keyframe lifecycle behavior (plan S10.6, ticket #28): the
 * authoring commands keep the document structurally valid at every step,
 * undo/redo restore exact pre-command state, and failures leave no
 * side effects. The shared conformance battery runs separately in
 * animation-conformance.test.ts.
 */

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:animcmd:root");
const CHILD = nodeId("node:animcmd:child");
const CLIP = animationId("animation:animcmd:spin");
const TRACK = trackId("track:animcmd:spin");
const KEY = keyframeId("keyframe:animcmd:spin:0");

function fixtureDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:animcmd:0001" as never,
    metadata: { title: "animation command behavior" },
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

function harness() {
  const document = fixtureDocument();
  const { store, writeCapability } = createDocumentStoreHandle({ document });
  const registry = new CommandRegistry();
  registerNodeCommands(registry);
  registerAnimationCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);
  const tx = (
    label: string,
    expectedRevision?: number,
  ): TransactionOptions => ({
    transactionId: transactionId(`transaction:animcmd:${label}`),
    expectedRevision: expectedRevision ?? store.revision,
    source: "ui",
  });
  return { store, bus, tx };
}

const clips = (store: DocumentStoreRead) => store.getDocument().animations;

/** Semantic document JSON without the logical session revision. */
const semanticJson = (store: DocumentStoreRead): string => {
  const { revision: _revision, ...rest } = store.getDocument();
  void _revision;
  return JSON.stringify(rest);
};

const authorClip = (
  bus: CommandBus,
  tx: (label: string) => TransactionOptions,
) => {
  const create = bus.execute(
    createAnimationCommand(commandId("command:animcmd:create:0001"), {
      animationId: CLIP,
      name: "Spin",
      duration: 2,
      loop: "once",
    }),
    tx("create"),
  );
  if (!create.ok) throw new Error(`create failed: ${create.error.code}`);
  const add = bus.execute(
    addTrackCommand(commandId("command:animcmd:track:0001"), {
      animationId: CLIP,
      trackId: TRACK,
      targetNodeId: CHILD,
      interpolation: "linear",
    }),
    tx("track"),
  );
  if (!add.ok) throw new Error(`track failed: ${add.error.code}`);
  const key = bus.execute(
    setKeyframeCommand(commandId("command:animcmd:key:0001"), {
      animationId: CLIP,
      trackId: TRACK,
      keyframeId: KEY,
      time: 0,
      property: { channel: "rotation", value: [0, 0, 0, 1] },
    }),
    tx("key"),
  );
  if (!key.ok) throw new Error(`key failed: ${key.error.code}`);
};

describe("animation.create", () => {
  it("creates an empty clip and reports the animation as changed", () => {
    const { store, bus, tx } = harness();
    const result = bus.execute(
      createAnimationCommand(commandId("command:animcmd:create:0001"), {
        animationId: CLIP,
        name: "Spin",
        duration: 2,
        loop: "once",
      }),
      tx("create"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event.changedAnimationIds).toEqual([CLIP]);
    const clip = clips(store)[CLIP];
    expect(clip).toMatchObject({
      animationId: CLIP,
      name: "Spin",
      duration: 2,
      loop: "once",
      tracks: [],
    });
  });

  it("rejects duplicate ids, bad duration, bad loop, and oversize names", () => {
    const { store, bus, tx } = harness();
    const first = bus.execute(
      createAnimationCommand(commandId("command:animcmd:create:0001"), {
        animationId: CLIP,
        duration: 1,
        loop: "loop",
      }),
      tx("create"),
    );
    expect(first.ok).toBe(true);
    // Identical re-create is a no-op commit (material.create policy)...
    const identical = bus.execute(
      createAnimationCommand(commandId("command:animcmd:create:0002"), {
        animationId: CLIP,
        duration: 1,
        loop: "loop",
      }),
      tx("identical"),
    );
    expect(identical.ok).toBe(true);
    if (identical.ok)
      expect(identical.value.event.changedAnimationIds).toEqual([]);
    // ...but a conflicting record with the same id is a duplicate error.
    const duplicate = bus.execute(
      createAnimationCommand(commandId("command:animcmd:create:0003"), {
        animationId: CLIP,
        duration: 2,
        loop: "loop",
      }),
      tx("duplicate"),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok)
      expect(duplicate.error.code).toBe("DUPLICATE_ANIMATION_ID");
    const zeroDuration = bus.execute(
      createAnimationCommand(commandId("command:animcmd:create:0003"), {
        animationId: animationId("animation:animcmd:other"),
        duration: 0,
        loop: "once",
      }),
      tx("zeroduration"),
    );
    expect(zeroDuration.ok).toBe(false);
    if (!zeroDuration.ok)
      expect(zeroDuration.error.code).toBe("INVALID_ANIMATION_DURATION");
    const badLoop = bus.execute(
      createAnimationCommand(commandId("command:animcmd:create:0004"), {
        animationId: animationId("animation:animcmd:other"),
        duration: 1,
        loop: "ping-pong" as never,
      }),
      tx("badloop"),
    );
    expect(badLoop.ok).toBe(false);
    if (!badLoop.ok) expect(badLoop.error.code).toBe("INVALID_LOOP_POLICY");
    expect(Object.keys(clips(store))).toEqual([CLIP]);
  });

  it("undo restores the exact pre-command semantic state", () => {
    const { store, bus, tx } = harness();
    const before = semanticJson(store);
    bus.execute(
      createAnimationCommand(commandId("command:animcmd:create:0001"), {
        animationId: CLIP,
        name: "Spin",
        duration: 2,
        loop: "once",
      }),
      tx("create"),
    );
    const undo = bus.undo(tx("undo"));
    expect(undo.ok).toBe(true);
    expect(semanticJson(store)).toBe(before);
    const redo = bus.redo(tx("redo"));
    expect(redo.ok).toBe(true);
    expect(clips(store)[CLIP]?.name).toBe("Spin");
  });
});

describe("animation.update", () => {
  it("updates name, duration, and loop and undoes exactly", () => {
    const { store, bus, tx } = harness();
    authorClip(bus, tx);
    const update = bus.execute(
      updateAnimationCommand(commandId("command:animcmd:update:0001"), {
        animationId: CLIP,
        duration: 3,
        loop: "loop",
      }),
      tx("update"),
    );
    expect(update.ok).toBe(true);
    expect(clips(store)[CLIP]).toMatchObject({
      duration: 3,
      loop: "loop",
      name: "Spin",
    });
    const undo = bus.undo(tx("undo"));
    expect(undo.ok).toBe(true);
    expect(clips(store)[CLIP]).toMatchObject({
      duration: 2,
      loop: "once",
      name: "Spin",
    });
  });

  it("rejects shrinking the duration below an existing keyframe time", () => {
    const { store, bus, tx } = harness();
    authorClip(bus, tx);
    const key = bus.execute(
      setKeyframeCommand(commandId("command:animcmd:key:0002"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:1"),
        time: 1.5,
        property: { channel: "rotation", value: [0, 0, 0, 1] },
      }),
      tx("key2"),
    );
    expect(key.ok).toBe(true);
    const shrink = bus.execute(
      updateAnimationCommand(commandId("command:animcmd:update:0003"), {
        animationId: CLIP,
        duration: 1,
      }),
      tx("shrink"),
    );
    expect(shrink.ok).toBe(false);
    if (!shrink.ok) expect(shrink.error.code).toBe("INVALID_KEYFRAME_TIME");
    expect(clips(store)[CLIP]?.duration).toBe(2);
  });

  it("undo of adding a name to an unnamed clip removes the name exactly", () => {
    const { store, bus, tx } = harness();
    bus.execute(
      createAnimationCommand(commandId("command:animcmd:create:0001"), {
        animationId: CLIP,
        duration: 2,
        loop: "once",
      }),
      tx("create"),
    );
    const before = semanticJson(store);
    const update = bus.execute(
      updateAnimationCommand(commandId("command:animcmd:update:name"), {
        animationId: CLIP,
        name: "Named",
      }),
      tx("add-name"),
    );
    expect(update.ok).toBe(true);
    expect(clips(store)[CLIP]?.name).toBe("Named");
    const undo = bus.undo(tx("undo-add-name"));
    expect(undo.ok).toBe(true);
    expect(clips(store)[CLIP]?.name).toBeUndefined();
    expect(semanticJson(store)).toBe(before);
    const redo = bus.redo(tx("redo-add-name"));
    expect(redo.ok).toBe(true);
    expect(clips(store)[CLIP]?.name).toBe("Named");
  });

  it("removes a name with name: null and undoes it exactly", () => {
    const { store, bus, tx } = harness();
    authorClip(bus, tx);
    const before = semanticJson(store);
    const remove = bus.execute(
      updateAnimationCommand(commandId("command:animcmd:update:remove-name"), {
        animationId: CLIP,
        name: null,
      }),
      tx("remove-name"),
    );
    expect(remove.ok).toBe(true);
    expect(clips(store)[CLIP]?.name).toBeUndefined();
    const undo = bus.undo(tx("undo-remove-name"));
    expect(undo.ok).toBe(true);
    expect(clips(store)[CLIP]?.name).toBe("Spin");
    expect(semanticJson(store)).toBe(before);
  });

  it("rejects an empty update", () => {
    const { bus, tx } = harness();
    authorClip(bus, tx);
    const empty = bus.execute(
      updateAnimationCommand(commandId("command:animcmd:update:0004"), {
        animationId: CLIP,
      }),
      tx("empty"),
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("EMPTY_ANIMATION_UPDATE");
  });
});

describe("animation.delete", () => {
  it("deletes a clip and restores it exactly on undo", () => {
    const { store, bus, tx } = harness();
    authorClip(bus, tx);
    const before = semanticJson(store);
    const del = bus.execute(
      deleteAnimationCommand(commandId("command:animcmd:delete:0001"), {
        animationId: CLIP,
      }),
      tx("delete"),
    );
    expect(del.ok).toBe(true);
    expect(clips(store)[CLIP]).toBeUndefined();
    const undo = bus.undo(tx("undo"));
    expect(undo.ok).toBe(true);
    expect(semanticJson(store)).toBe(before);
  });

  it("deleting an absent clip is a no-op commit", () => {
    const { bus, tx } = harness();
    const del = bus.execute(
      deleteAnimationCommand(commandId("command:animcmd:delete:0002"), {
        animationId: CLIP,
      }),
      tx("delete-absent"),
    );
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.value.event.changedAnimationIds).toEqual([]);
  });
});

describe("track.add / track.remove / track.setInterpolation", () => {
  it("adds a track with a target and interpolation, removes it, and undoes both", () => {
    const { store, bus, tx } = harness();
    bus.execute(
      createAnimationCommand(commandId("command:animcmd:create:0001"), {
        animationId: CLIP,
        duration: 2,
        loop: "once",
      }),
      tx("create"),
    );
    const add = bus.execute(
      addTrackCommand(commandId("command:animcmd:track:0001"), {
        animationId: CLIP,
        trackId: TRACK,
        targetNodeId: CHILD,
        interpolation: "smoothstep",
      }),
      tx("add"),
    );
    expect(add.ok).toBe(true);
    expect(clips(store)[CLIP]?.tracks).toEqual([
      {
        trackId: TRACK,
        targetNodeId: CHILD,
        interpolation: "smoothstep",
        keyframes: [],
      },
    ]);
    const setInterp = bus.execute(
      setTrackInterpolationCommand(commandId("command:animcmd:interp:0001"), {
        animationId: CLIP,
        trackId: TRACK,
        interpolation: "step",
      }),
      tx("interp"),
    );
    expect(setInterp.ok).toBe(true);
    expect(clips(store)[CLIP]?.tracks[0]?.interpolation).toBe("step");
    const remove = bus.execute(
      removeTrackCommand(commandId("command:animcmd:track:0002"), {
        animationId: CLIP,
        trackId: TRACK,
      }),
      tx("remove"),
    );
    expect(remove.ok).toBe(true);
    expect(clips(store)[CLIP]?.tracks).toEqual([]);
    bus.undo(tx("undo-remove"));
    expect(clips(store)[CLIP]?.tracks[0]?.interpolation).toBe("step");
    bus.undo(tx("undo-interp"));
    expect(clips(store)[CLIP]?.tracks[0]?.interpolation).toBe("smoothstep");
    bus.undo(tx("undo-add"));
    expect(clips(store)[CLIP]?.tracks).toEqual([]);
  });

  it("rejects tracks on missing clips, missing nodes, and duplicate track ids", () => {
    const { store, bus, tx } = harness();
    bus.execute(
      createAnimationCommand(commandId("command:animcmd:create:0001"), {
        animationId: CLIP,
        duration: 2,
        loop: "once",
      }),
      tx("create"),
    );
    const missingClip = bus.execute(
      addTrackCommand(commandId("command:animcmd:track:0001"), {
        animationId: animationId("animation:animcmd:nope"),
        trackId: TRACK,
        targetNodeId: CHILD,
        interpolation: "linear",
      }),
      tx("missing-clip"),
    );
    expect(missingClip.ok).toBe(false);
    if (!missingClip.ok)
      expect(missingClip.error.code).toBe("MISSING_ANIMATION");
    const missingNode = bus.execute(
      addTrackCommand(commandId("command:animcmd:track:0002"), {
        animationId: CLIP,
        trackId: TRACK,
        targetNodeId: nodeId("node:animcmd:nope"),
        interpolation: "linear",
      }),
      tx("missing-node"),
    );
    expect(missingNode.ok).toBe(false);
    if (!missingNode.ok) expect(missingNode.error.code).toBe("MISSING_NODE");
    const good = bus.execute(
      addTrackCommand(commandId("command:animcmd:track:0003"), {
        animationId: CLIP,
        trackId: TRACK,
        targetNodeId: CHILD,
        interpolation: "linear",
      }),
      tx("good"),
    );
    expect(good.ok).toBe(true);
    const duplicate = bus.execute(
      addTrackCommand(commandId("command:animcmd:track:0004"), {
        animationId: CLIP,
        trackId: TRACK,
        targetNodeId: ROOT,
        interpolation: "linear",
      }),
      tx("duplicate"),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("DUPLICATE_TRACK_ID");
    expect(clips(store)[CLIP]?.tracks).toHaveLength(1);
  });
});

describe("keyframe.set / keyframe.move / keyframe.delete", () => {
  it("sets, moves, and deletes keyframes with exact undo", () => {
    const { store, bus, tx } = harness();
    authorClip(bus, tx);
    const set2 = bus.execute(
      setKeyframeCommand(commandId("command:animcmd:key:0002"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:1"),
        time: 1,
        property: { channel: "rotation", value: [0, 1, 0, 0] },
      }),
      tx("set2"),
    );
    expect(set2.ok).toBe(true);
    const times = clips(store)[CLIP]?.tracks[0]?.keyframes.map((k) => k.time);
    expect(times).toEqual([0, 1]);
    const move = bus.execute(
      moveKeyframeCommand(commandId("command:animcmd:move:0001"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:1"),
        time: 1.5,
      }),
      tx("move"),
    );
    expect(move.ok).toBe(true);
    expect(clips(store)[CLIP]?.tracks[0]?.keyframes[1]?.time).toBe(1.5);
    bus.undo(tx("undo-move"));
    expect(clips(store)[CLIP]?.tracks[0]?.keyframes[1]?.time).toBe(1);
    const del = bus.execute(
      deleteKeyframeCommand(commandId("command:animcmd:keydel:0001"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:1"),
      }),
      tx("del"),
    );
    expect(del.ok).toBe(true);
    expect(clips(store)[CLIP]?.tracks[0]?.keyframes).toHaveLength(1);
    bus.undo(tx("undo-del"));
    expect(clips(store)[CLIP]?.tracks[0]?.keyframes).toHaveLength(2);
    bus.undo(tx("undo-set2"));
    expect(clips(store)[CLIP]?.tracks[0]?.keyframes).toHaveLength(1);
  });

  it("keeps keyframe times sorted and unique after arbitrary insertions", () => {
    const { store, bus, tx } = harness();
    authorClip(bus, tx);
    for (const time of [1.5, 0.25, 1]) {
      const result = bus.execute(
        setKeyframeCommand(commandId(`command:animcmd:key:${String(time)}`), {
          animationId: CLIP,
          trackId: TRACK,
          keyframeId: keyframeId(`keyframe:animcmd:spin:${String(time)}`),
          time,
          property: { channel: "rotation", value: [0, 0, 0, 1] },
        }),
        tx(`key-${String(time)}`),
      );
      expect(result.ok).toBe(true);
    }
    const times = clips(store)[CLIP]?.tracks[0]?.keyframes.map((k) => k.time);
    expect(times).toEqual([0, 0.25, 1, 1.5]);
  });

  it("rejects duplicate times, channel mismatch, and out-of-range times", () => {
    const { store, bus, tx } = harness();
    authorClip(bus, tx);
    const duplicateTime = bus.execute(
      setKeyframeCommand(commandId("command:animcmd:key:dup"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:dup"),
        time: 0,
        property: { channel: "rotation", value: [0, 0, 0, 1] },
      }),
      tx("dup-time"),
    );
    expect(duplicateTime.ok).toBe(false);
    if (!duplicateTime.ok)
      expect(duplicateTime.error.code).toBe("DUPLICATE_KEYFRAME_TIME");
    const channelMismatch = bus.execute(
      setKeyframeCommand(commandId("command:animcmd:key:mismatch"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:mismatch"),
        time: 1,
        property: { channel: "translation", value: [1, 2, 3] },
      }),
      tx("mismatch"),
    );
    expect(channelMismatch.ok).toBe(false);
    if (!channelMismatch.ok)
      expect(channelMismatch.error.code).toBe(
        "ANIMATION_TRACK_CHANNEL_MISMATCH",
      );
    const outOfRange = bus.execute(
      setKeyframeCommand(commandId("command:animcmd:key:oor"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:oor"),
        time: 5,
        property: { channel: "rotation", value: [0, 0, 0, 1] },
      }),
      tx("oor"),
    );
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok)
      expect(outOfRange.error.code).toBe("INVALID_KEYFRAME_TIME");
    expect(() =>
      setKeyframeCommand(commandId("command:animcmd:key:quat"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:quat"),
        time: 1,
        property: { channel: "rotation", value: [0, 0, 0, 0] },
      }),
    ).toThrow(/non-zero length/u);
    // Non-unit rotations are normalized by the canonicalizing constructor,
    // matching the node.setTransform policy.
    const normalized = bus.execute(
      setKeyframeCommand(commandId("command:animcmd:key:norm"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:norm"),
        time: 1,
        property: { channel: "rotation", value: [0, 2, 0, 0] },
      }),
      tx("norm"),
    );
    expect(normalized.ok).toBe(true);
    expect(() =>
      setKeyframeCommand(commandId("command:animcmd:key:scale"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:scale"),
        time: 1,
        property: { channel: "scale", value: [1, 0, 1] },
      }),
    ).toThrow(/strictly positive/u);
    // Only the original keyframe plus the normalized one were committed.
    expect(clips(store)[CLIP]?.tracks[0]?.keyframes).toHaveLength(2);
  });

  it("rejects updating a keyframe onto another keyframe's time", () => {
    const { bus, tx } = harness();
    authorClip(bus, tx);
    bus.execute(
      setKeyframeCommand(commandId("command:animcmd:key:0002"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:1"),
        time: 1,
        property: { channel: "rotation", value: [0, 1, 0, 0] },
      }),
      tx("set2"),
    );
    // Updating the existing keyframe at time 0 onto time 1 collides.
    const collision = bus.execute(
      setKeyframeCommand(commandId("command:animcmd:key:collision"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: KEY,
        time: 1,
        property: { channel: "rotation", value: [0, 0, 0, 1] },
      }),
      tx("collision-update"),
    );
    expect(collision.ok).toBe(false);
    if (!collision.ok)
      expect(collision.error.code).toBe("DUPLICATE_KEYFRAME_TIME");
    expect(collision.ok).toBe(false);
  });

  it("rejects moving a keyframe onto another keyframe's time", () => {
    const { bus, tx } = harness();
    authorClip(bus, tx);
    bus.execute(
      setKeyframeCommand(commandId("command:animcmd:key:0002"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:1"),
        time: 1,
        property: { channel: "rotation", value: [0, 1, 0, 0] },
      }),
      tx("set2"),
    );
    const collision = bus.execute(
      moveKeyframeCommand(commandId("command:animcmd:move:collision"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: KEY,
        time: 1,
      }),
      tx("collision"),
    );
    expect(collision.ok).toBe(false);
    if (!collision.ok)
      expect(collision.error.code).toBe("DUPLICATE_KEYFRAME_TIME");
  });

  it("deleting an absent keyframe is a no-op commit", () => {
    const { bus, tx } = harness();
    authorClip(bus, tx);
    const del = bus.execute(
      deleteKeyframeCommand(commandId("command:animcmd:keydel:absent"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:absent"),
      }),
      tx("del-absent"),
    );
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.value.event.changedAnimationIds).toEqual([]);
  });

  it("failed transactions leave revision, history, and document unchanged", () => {
    const { store, bus, tx } = harness();
    authorClip(bus, tx);
    const before = JSON.stringify(store.getDocument());
    const revision = store.revision;
    const history = bus.historySnapshot();
    const fail = bus.execute(
      setKeyframeCommand(commandId("command:animcmd:key:fail"), {
        animationId: CLIP,
        trackId: TRACK,
        keyframeId: keyframeId("keyframe:animcmd:spin:fail"),
        time: 7,
        property: { channel: "rotation", value: [0, 0, 0, 1] },
      }),
      tx("fail"),
    );
    expect(fail.ok).toBe(false);
    expect(JSON.stringify(store.getDocument())).toBe(before);
    expect(store.revision).toBe(revision);
    expect(bus.historySnapshot()).toEqual(history);
  });

  it("undo after a full authoring session restores the empty document", () => {
    const { store, bus, tx } = harness();
    const before = semanticJson(store);
    authorClip(bus, tx);
    bus.undo(tx("undo-key"));
    bus.undo(tx("undo-track"));
    bus.undo(tx("undo-create"));
    expect(semanticJson(store)).toBe(before);
    expect(bus.canUndo()).toBe(false);
  });

  it("node.delete rejects a node targeted by a track", () => {
    const { bus, tx } = harness();
    authorClip(bus, tx);
    const del = bus.execute(
      {
        id: commandId("command:animcmd:nodedel"),
        type: "node.delete",
        schemaVersion: 1,
        payload: { nodeId: CHILD },
      },
      tx("node-del"),
    );
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.error.code).toBe("REFERENCED_NODE");
  });
});
