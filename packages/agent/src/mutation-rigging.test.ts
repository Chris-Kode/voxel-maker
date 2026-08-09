import { describe, expect, it } from "vitest";
import { animationId } from "@voxel-maker/shared";
import { CommandBus } from "@voxel-maker/commands";
import { transactionId } from "@voxel-maker/shared";
import type { DocumentStoreRead } from "@voxel-maker/document";
import { FIXTURE_IDS, createInspectionStore } from "./fixtures.js";
import { createMutator, type Mutator } from "./mutator.js";
import { createPreviewRegistry } from "./registry.js";
import { createPreviewSession, previewSessionId } from "./preview.js";

/**
 * Rigging and animation mutation tools (plan S13.5, ticket #36 AC):
 * pivots/joints/constraints and clips/tracks/keyframes construct only the
 * registered articulation and animation commands, carry the animation
 * deltas the session budget ledger reserves, fail with stable errors on
 * missing references and malformed values, and stage/apply atomically
 * through the preview session with no live side effects until Apply.
 */

const { store } = createInspectionStore();

function makeMutator(): {
  readonly mutator: Mutator;
  readonly registry: ReturnType<typeof createPreviewRegistry>;
} {
  const registry = createPreviewRegistry();
  const mutator = createMutator({ store, registry });
  return { mutator, registry };
}

function constructOk(
  mutator: Mutator,
  name: string,
  args: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const result = mutator.construct(name, args as never);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.value as Readonly<Record<string, unknown>>;
}

function constructError(
  mutator: Mutator,
  name: string,
  args: Record<string, unknown>,
  code: string,
): void {
  const result = mutator.construct(name, args as never);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe("rigging mutation tools (plan S13.5)", () => {
  it("constructs registered articulation commands with canonical payloads", () => {
    const { mutator } = makeMutator();
    const pivot = constructOk(mutator, "setNodePivot", {
      commandId: "command:test:pivot",
      nodeId: FIXTURE_IDS.arm,
      pivot: [1.5, 0, -2],
    });
    expect(pivot.voxelEstimate).toBe(0);
    const pivotCommand = pivot.command as Record<string, unknown>;
    expect(pivotCommand.type).toBe("node.setPivot");
    expect((pivotCommand.payload as Record<string, unknown>).pivot).toEqual([
      1.5, 0, -2,
    ]);

    const joint = constructOk(mutator, "addNodeJoint", {
      nodeId: FIXTURE_IDS.arm,
    });
    expect((joint.command as Record<string, unknown>).type).toBe(
      "node.addJoint",
    );

    const constraint = constructOk(mutator, "addConstraint", {
      nodeId: FIXTURE_IDS.arm,
      componentId: "component:test:hinge",
      limits: { min: [-1, 0, 0], max: [1, 0, 0] },
    });
    expect((constraint.command as Record<string, unknown>).type).toBe(
      "node.addConstraint",
    );
    const payload = (constraint.command as Record<string, unknown>)
      .payload as Record<string, unknown>;
    expect(payload.componentId).toBe("component:test:hinge");
    expect(payload.limits).toEqual({ min: [-1, 0, 0], max: [1, 0, 0] });

    const remove = constructOk(mutator, "removeConstraint", {
      nodeId: FIXTURE_IDS.arm,
      componentId: "component:test:hinge",
    });
    expect((remove.command as Record<string, unknown>).type).toBe(
      "node.removeConstraint",
    );
  });

  it("rejects missing nodes and malformed limits with stable errors", () => {
    const { mutator } = makeMutator();
    constructError(
      mutator,
      "setNodePivot",
      { nodeId: "node:missing", pivot: [0, 0, 0] },
      "UNKNOWN_NODE",
    );
    constructError(
      mutator,
      "setNodePivot",
      { nodeId: FIXTURE_IDS.arm, pivot: [0, 0] },
      "INVALID_ARGUMENT",
    );
    constructError(
      mutator,
      "addConstraint",
      {
        nodeId: FIXTURE_IDS.arm,
        componentId: "component:x",
        limits: { min: [2, 0, 0], max: [1, 0, 0] },
      },
      "INVALID_ARGUMENT",
    );
  });
});

describe("animation mutation tools (plan S13.5)", () => {
  it("constructs registered animation commands with animation reservations", () => {
    const { mutator } = makeMutator();
    const create = constructOk(mutator, "createAnimation", {
      commandId: "command:test:anim",
      animationId: "anim:test:new",
      name: "Spin",
      duration: 2,
      loop: "loop",
    });
    expect((create.command as Record<string, unknown>).type).toBe(
      "animation.create",
    );
    expect(create.animation).toEqual({ clipDurationSeconds: 2 });

    const track = constructOk(mutator, "addTrack", {
      animationId: FIXTURE_IDS.animationWave,
      trackId: "track:test:new",
      targetNodeId: FIXTURE_IDS.body,
      interpolation: "linear",
    });
    expect((track.command as Record<string, unknown>).type).toBe("track.add");
    expect(track.animation).toEqual({ tracks: 1 });

    const keyframe = constructOk(mutator, "setKeyframe", {
      animationId: FIXTURE_IDS.animationWave,
      trackId: FIXTURE_IDS.trackWave,
      keyframeId: "keyframe:test:new",
      time: 0.5,
      channel: "rotation",
      value: [0, 1, 0, 0],
    });
    expect((keyframe.command as Record<string, unknown>).type).toBe(
      "keyframe.set",
    );
    expect(keyframe.animation).toEqual({ keyframes: 1 });
    const payload = (keyframe.command as Record<string, unknown>)
      .payload as Record<string, unknown>;
    expect(payload.time).toBe(0.5);
    expect((payload.property as Record<string, unknown>).channel).toBe(
      "rotation",
    );
  });

  it("updateAnimation changes only the supplied fields and reports duration", () => {
    const { mutator } = makeMutator();
    const update = constructOk(mutator, "updateAnimation", {
      animationId: FIXTURE_IDS.animationWave,
      duration: 4,
    });
    expect((update.command as Record<string, unknown>).type).toBe(
      "animation.update",
    );
    expect(update.animation).toEqual({ clipDurationSeconds: 4 });
    const payload = (update.command as Record<string, unknown>)
      .payload as Record<string, unknown>;
    expect(payload.duration).toBe(4);
    expect(payload.loop).toBeUndefined();
    expect(payload.name).toBeUndefined();
  });

  it("rejects missing references and malformed values with stable errors", () => {
    const { mutator } = makeMutator();
    constructError(
      mutator,
      "deleteAnimation",
      { animationId: "anim:missing" },
      "UNKNOWN_ANIMATION",
    );
    constructError(
      mutator,
      "removeTrack",
      {
        animationId: FIXTURE_IDS.animationWave,
        trackId: "track:missing",
      },
      "UNKNOWN_TRACK",
    );
    constructError(
      mutator,
      "setKeyframe",
      {
        animationId: FIXTURE_IDS.animationWave,
        trackId: FIXTURE_IDS.trackWave,
        keyframeId: "keyframe:x",
        time: -1,
        channel: "rotation",
        value: [0, 0, 0, 1],
      },
      "INVALID_ARGUMENT",
    );
    constructError(
      mutator,
      "setKeyframe",
      {
        animationId: FIXTURE_IDS.animationWave,
        trackId: FIXTURE_IDS.trackWave,
        keyframeId: "keyframe:x",
        time: 0,
        channel: "rotation",
        value: [0, 0, 0],
      },
      "INVALID_ARGUMENT",
    );
    constructError(
      mutator,
      "updateAnimation",
      { animationId: FIXTURE_IDS.animationWave },
      "INVALID_ARGUMENT",
    );
    constructError(
      mutator,
      "addTrack",
      {
        animationId: FIXTURE_IDS.animationWave,
        trackId: "track:x",
        targetNodeId: "node:missing",
        interpolation: "linear",
      },
      "UNKNOWN_NODE",
    );
  });
});

describe("rigging/animation staging through the preview session (plan S13.5)", () => {
  it("stages registered commands on the overlay and applies atomically", () => {
    const { handle } = createInspectionStore();
    const registry = createPreviewRegistry();
    const bus = new CommandBus(handle.store, registry, handle.writeCapability);
    const preview = createPreviewSession({
      live: handle.store,
      applyBus: bus,
      sessionId: previewSessionId("preview:rig:test"),
    });
    const mutator = createMutator({
      store: preview,
      registry,
      session: preview,
    });

    const constructAndStage = (
      name: string,
      args: Record<string, unknown>,
    ): void => {
      const value = constructOk(mutator, name, args);
      const result = preview.stage(value.command as never);
      expect(result.ok, JSON.stringify(result)).toBe(true);
    };

    constructAndStage("setNodePivot", {
      nodeId: FIXTURE_IDS.body,
      pivot: [0, 1, 0],
    });
    constructAndStage("addNodeJoint", { nodeId: FIXTURE_IDS.body });
    constructAndStage("addConstraint", {
      nodeId: FIXTURE_IDS.body,
      componentId: "component:test:hinge",
      limits: { min: [-1, 0, 0], max: [1, 0, 0] },
    });
    constructAndStage("createAnimation", {
      animationId: animationId("anim:test:rig"),
      duration: 2,
      loop: "loop",
    });
    constructAndStage("addTrack", {
      animationId: animationId("anim:test:rig"),
      trackId: "track:test:rig",
      targetNodeId: FIXTURE_IDS.arm,
      interpolation: "linear",
    });
    constructAndStage("setKeyframe", {
      animationId: animationId("anim:test:rig"),
      trackId: "track:test:rig",
      keyframeId: "keyframe:test:rig:0",
      time: 0,
      channel: "rotation",
      value: [0, 0, 0, 1],
    });
    constructAndStage("setKeyframe", {
      animationId: animationId("anim:test:rig"),
      trackId: "track:test:rig",
      keyframeId: "keyframe:test:rig:1",
      time: 2,
      channel: "rotation",
      value: [0, 1, 0, 0],
    });

    // The live store must be untouched while staged.
    const liveBefore = handle.store.getDocument();
    expect(liveBefore.animations[animationId("anim:test:rig")]).toBeUndefined();
    expect(
      (liveBefore.nodes[FIXTURE_IDS.body]?.components ?? []).some(
        (component) => component.kind === "pivot",
      ),
    ).toBe(false);

    // The staged overlay sees the rig and the clip.
    const stagedDocument = preview.getDocument();
    expect(
      stagedDocument.animations[animationId("anim:test:rig")],
    ).toBeDefined();
    expect(
      stagedDocument.animations[animationId("anim:test:rig")]?.tracks[0]
        ?.keyframes,
    ).toHaveLength(2);
    expect(
      (stagedDocument.nodes[FIXTURE_IDS.body]?.components ?? []).some(
        (component) => component.kind === "joint",
      ),
    ).toBe(true);

    // The overlay clip is readable for pre-Apply playback.
    const overlay = preview.overlayClip(animationId("anim:test:rig") as never);
    expect(overlay?.animationId).toBe(animationId("anim:test:rig"));
    expect(overlay?.duration).toBe(2);

    // Diff reports the changed animation id.
    const diff = preview.diff();
    expect(diff.ok).toBe(true);
    if (diff.ok) {
      expect(diff.value.changedAnimationIds).toContain(
        animationId("anim:test:rig"),
      );
      expect(diff.value.changedNodeIds).toContain(FIXTURE_IDS.body);
    }

    // Apply commits one labeled transaction; live now has the rig+clip.
    const applied = preview.apply({ label: "AI rig proposal" });
    expect(applied.ok).toBe(true);
    const liveAfter = handle.store.getDocument();
    expect(liveAfter.animations[animationId("anim:test:rig")]).toBeDefined();
    expect(
      (liveAfter.nodes[FIXTURE_IDS.body]?.components ?? []).some(
        (component) => component.kind === "pivot",
      ),
    ).toBe(true);
    expect(handle.store.revision).toBe(liveBefore.revision + 1);
  });

  it("apply is one undoable history entry: undo restores, redo reapplies", () => {
    const { handle } = createInspectionStore();
    const registry = createPreviewRegistry();
    const bus = new CommandBus(handle.store, registry, handle.writeCapability);
    const preview = createPreviewSession({
      live: handle.store,
      applyBus: bus,
      sessionId: previewSessionId("preview:rig:undo"),
    });
    const mutator = createMutator({
      store: preview,
      registry,
      session: preview,
    });
    const revisionBefore = handle.store.revision;
    const historyBefore = bus.historySnapshot().past.length;

    const value = constructOk(mutator, "createAnimation", {
      animationId: "anim:test:undo",
      duration: 1,
      loop: "once",
    });
    const stageResult = preview.stage(value.command as never);
    expect(stageResult.ok).toBe(true);
    const applied = preview.apply({ label: "AI rig proposal" });
    expect(applied.ok).toBe(true);
    expect(handle.store.revision).toBe(revisionBefore + 1);
    expect(bus.historySnapshot().past.length).toBe(historyBefore + 1);
    expect(
      handle.store.getDocument().animations["anim:test:undo" as never],
    ).toBeDefined();

    // Undo restores the exact pre-apply semantic state as one new
    // transaction (ADR-0003: revision is monotonic; content restores).
    const revisionAfterApply = handle.store.revision;
    const undone = bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: revisionAfterApply,
      source: "ui",
    });
    expect(undone.ok).toBe(true);
    expect(handle.store.revision).toBe(revisionAfterApply + 1);
    expect(
      handle.store.getDocument().animations["anim:test:undo" as never],
    ).toBeUndefined();

    // Redo reapplies the same registered command atomically.
    const redone = bus.redo({
      transactionId: transactionId("transaction:test:redo"),
      expectedRevision: handle.store.revision,
      source: "ui",
    });
    expect(redone.ok).toBe(true);
    expect(handle.store.revision).toBe(revisionAfterApply + 2);
    expect(
      handle.store.getDocument().animations["anim:test:undo" as never],
    ).toBeDefined();
  });

  it("discard releases the staged rig/animation with no live effect", () => {
    const { handle } = createInspectionStore();
    const registry = createPreviewRegistry();
    const bus = new CommandBus(handle.store, registry, handle.writeCapability);
    const preview = createPreviewSession({
      live: handle.store,
      applyBus: bus,
      sessionId: previewSessionId("preview:rig:discard"),
    });
    const mutator = createMutator({
      store: preview,
      registry,
      session: preview,
    });
    const revisionBefore = handle.store.revision;

    const value = constructOk(mutator, "createAnimation", {
      animationId: animationId("anim:test:discard"),
      duration: 1,
      loop: "once",
    });
    const result = preview.stage(value.command as never);
    expect(result.ok).toBe(true);
    preview.discard();
    expect(preview.closed).toBe(true);
    expect(handle.store.revision).toBe(revisionBefore);
    expect(
      handle.store.getDocument().animations[animationId("anim:test:discard")],
    ).toBeUndefined();
    expect(() =>
      preview.overlayClip(animationId("anim:test:discard") as never),
    ).toThrow();
  });
});

/** Re-export used types for the test file (keeps imports explicit). */
export type { DocumentStoreRead };
