import { describe, expect, it } from "vitest";
import type { AnimationDescriptor } from "@voxel-maker/model";
import {
  createAnimatedWheelDocument,
  createWheelSpinClip,
} from "./fixtures.js";
import { createPlaybackController, type PlaybackClock } from "./playback.js";
import { evaluateAnimationRuntime } from "./runtime.js";

/**
 * Injectable playback controller (plan S10.7, ticket #28): play, pause,
 * stop, loop, and scrub with an injectable clock; stop restores base state
 * exactly; playback never touches the command bus or document.
 */

const makeClock = (): {
  readonly clock: PlaybackClock;
  readonly advance: (seconds: number) => void;
} => {
  let now = 100;
  return {
    clock: { now: () => now },
    advance: (seconds: number) => {
      now += seconds;
    },
  };
};

describe("createPlaybackController", () => {
  it("starts stopped at time zero with no clip", () => {
    const controller = createPlaybackController(makeClock().clock);
    expect(controller.state).toMatchObject({
      playing: false,
      stopped: true,
      time: 0,
      resolvedTime: 0,
      loopOverride: false,
      clipId: null,
    });
  });

  it("plays, pauses, and resumes with the injected clock", () => {
    const { clock, advance } = makeClock();
    const document = createAnimatedWheelDocument();
    const controller = createPlaybackController(clock);
    controller.load(document, createWheelSpinClip());
    controller.play();
    expect(controller.state.playing).toBe(true);
    advance(0.5);
    controller.tick(clock.now());
    expect(controller.state.time).toBeCloseTo(0.5, 12);
    expect(controller.state.resolvedTime).toBeCloseTo(0.5, 12);
    controller.pause();
    advance(2);
    controller.tick(clock.now());
    expect(controller.state.time).toBeCloseTo(0.5, 12);
    controller.play();
    advance(0.25);
    controller.tick(clock.now());
    expect(controller.state.time).toBeCloseTo(0.75, 12);
  });

  it("wraps a loop clip with the clip's own policy and keeps playing", () => {
    const { clock, advance } = makeClock();
    const document = createAnimatedWheelDocument();
    const controller = createPlaybackController(clock);
    controller.load(document, createWheelSpinClip()); // loop: "loop", duration 1
    controller.play();
    advance(1.5);
    controller.tick(clock.now());
    expect(controller.state.time).toBeCloseTo(1.5, 12);
    expect(controller.state.resolvedTime).toBeCloseTo(0.5, 12);
    expect(controller.state.playing).toBe(true);
  });

  it("auto-pauses a once clip at its end and restarts from zero on play", () => {
    const { clock, advance } = makeClock();
    const document = createAnimatedWheelDocument();
    const clip: AnimationDescriptor = {
      ...createWheelSpinClip(),
      loop: "once",
    };
    const controller = createPlaybackController(clock);
    controller.load(document, clip);
    controller.play();
    advance(3);
    controller.tick(clock.now());
    expect(controller.state.time).toBe(1);
    expect(controller.state.resolvedTime).toBe(1);
    expect(controller.state.playing).toBe(false);
    controller.play();
    expect(controller.state.time).toBe(0);
    expect(controller.state.playing).toBe(true);
  });

  it("forces wrapping for any clip when the transport loop override is on", () => {
    const { clock, advance } = makeClock();
    const document = createAnimatedWheelDocument();
    const clip: AnimationDescriptor = {
      ...createWheelSpinClip(),
      loop: "once",
    };
    const controller = createPlaybackController(clock);
    controller.load(document, clip);
    controller.setLoop(true);
    controller.play();
    advance(2.5);
    controller.tick(clock.now());
    expect(controller.state.time).toBeCloseTo(2.5, 12);
    expect(controller.state.resolvedTime).toBeCloseTo(0.5, 12);
    expect(controller.state.playing).toBe(true);
  });

  it("scrubs to a pose without playing and clamps negative time", () => {
    const controller = createPlaybackController(makeClock().clock);
    const document = createAnimatedWheelDocument();
    controller.load(document, createWheelSpinClip());
    controller.scrub(0.25);
    expect(controller.state.time).toBeCloseTo(0.25, 12);
    expect(controller.state.playing).toBe(false);
    expect(controller.state.stopped).toBe(false);
    controller.scrub(-5);
    expect(controller.state.time).toBe(0);
  });

  it("loads a null document (lifecycle close) without corrupting state", () => {
    const controller = createPlaybackController(makeClock().clock);
    const document = createAnimatedWheelDocument();
    controller.load(document, createWheelSpinClip());
    controller.scrub(0.25);
    controller.load(null, null);
    expect(controller.state).toMatchObject({
      playing: false,
      stopped: false,
      time: 0,
      clipId: null,
    });
    // Evaluate without a document fails loudly with the documented error
    // instead of touching a stale or undefined document.
    expect(() => controller.evaluate()).toThrow(/no document is loaded/);
  });

  it("refresh swaps the document snapshot without rewinding or pausing", () => {
    const { clock, advance } = makeClock();
    const document = createAnimatedWheelDocument();
    const controller = createPlaybackController(clock);
    controller.load(document, createWheelSpinClip());
    controller.scrub(0.5);
    const replaced = createAnimatedWheelDocument();
    controller.refresh(replaced);
    expect(controller.state.time).toBeCloseTo(0.5, 12);
    expect(controller.state.stopped).toBe(false);
    expect(controller.evaluate().clipId).toBe(
      createWheelSpinClip().animationId,
    );
    controller.play();
    advance(0.25);
    controller.tick(clock.now());
    expect(controller.state.time).toBeCloseTo(0.75, 12);
    expect(controller.state.playing).toBe(true);
  });

  it("stop restores base state exactly", () => {
    const { clock, advance } = makeClock();
    const document = createAnimatedWheelDocument();
    const controller = createPlaybackController(clock);
    controller.load(document, createWheelSpinClip());
    controller.play();
    advance(0.5);
    controller.tick(clock.now());
    const animated = controller.evaluate();
    const wheel = "node:rig:wheel:wheel" as never;
    expect(animated.local.get(wheel)?.rotation).not.toEqual([0, 0, 0, 1]);
    controller.stop();
    expect(controller.state).toMatchObject({
      playing: false,
      stopped: true,
      time: 0,
      resolvedTime: 0,
    });
    const base = controller.evaluate();
    expect(base.local.get(wheel)?.rotation).toEqual([0, 0, 0, 1]);
    expect(base.world.get("node:rig:wheel:axle" as never)).toEqual(
      evaluateAnimationRuntime(document, null, 0).world.get(
        "node:rig:wheel:axle" as never,
      ),
    );
  });

  it("evaluate() reflects the current clip at the resolved time", () => {
    const document = createAnimatedWheelDocument();
    const controller = createPlaybackController(makeClock().clock);
    controller.load(document, createWheelSpinClip());
    controller.scrub(0.5);
    const direct = evaluateAnimationRuntime(
      document,
      createWheelSpinClip(),
      0.5,
    );
    const viaController = controller.evaluate();
    expect(viaController.local.get("node:rig:wheel:wheel" as never)).toEqual(
      direct.local.get("node:rig:wheel:wheel" as never),
    );
    expect(viaController.time).toBe(0.5);
  });

  it("evaluates pure base state when no clip is loaded", () => {
    const document = createAnimatedWheelDocument();
    const controller = createPlaybackController(makeClock().clock);
    controller.load(document, null);
    controller.play(); // no-op with no clip
    expect(controller.state.playing).toBe(false);
    const state = controller.evaluate();
    expect(state.clipId).toBeNull();
    expect(state.local.get("node:rig:wheel:wheel" as never)?.rotation).toEqual([
      0, 0, 0, 1,
    ]);
  });

  it("notifies subscribers on state changes and unsubscribes", () => {
    const controller = createPlaybackController(makeClock().clock);
    const seen: string[] = [];
    const unsubscribe = controller.subscribe((state) => {
      seen.push(
        `${String(state.playing)}:${String(state.stopped)}:${String(state.time)}`,
      );
    });
    controller.load(createAnimatedWheelDocument(), createWheelSpinClip());
    controller.play();
    controller.pause();
    controller.stop();
    unsubscribe();
    controller.play();
    expect(seen.length).toBeGreaterThanOrEqual(4);
    const last = seen[seen.length - 1];
    expect(last).not.toBe("true:false:0");
  });

  it("never touches the command bus: document revision stays constant", () => {
    const { clock, advance } = makeClock();
    const document = createAnimatedWheelDocument();
    const revisionBefore = document.revision;
    const controller = createPlaybackController(clock);
    controller.load(document, createWheelSpinClip());
    controller.play();
    advance(1);
    controller.tick(clock.now());
    controller.pause();
    controller.scrub(0.3);
    controller.stop();
    expect(controller.evaluate().clipId).toBeNull();
    expect(document.revision).toBe(revisionBefore);
  });
});
