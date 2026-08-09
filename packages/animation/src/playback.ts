import { createListenerSet } from "@voxel-maker/shared";
import type { AnimationDescriptor, VoxelDocument } from "@voxel-maker/model";
import type { AnimationId } from "@voxel-maker/shared";
import { resolveClipTime } from "./evaluate.js";
import {
  evaluateAnimationRuntime,
  type AnimationRuntimeState,
} from "./runtime.js";

/**
 * Injectable playback controller (plan S10.7, ticket #28). The controller
 * owns transport-only runtime state — playing, stopped, transport time,
 * the transport loop override, and the active clip — and evaluates the
 * layered runtime projection on demand. It never touches the command bus:
 * playback emits no commands, no revisions, no history, and no journal
 * traffic (ADR-0006: playback never writes Commands per frame).
 *
 * State machine:
 *
 * - `play()` starts advancing from the current transport time; a `once`
 *   clip that already reached its end restarts from zero.
 * - `pause()` freezes the transport time.
 * - `stop()` pauses, rewinds to zero, and marks the transport stopped, so
 *   `evaluate()` returns the pure base state — the exact document
 *   transforms with no animation override (ADR-0006: stopping restores
 *   base state exactly).
 * - `scrub(t)` jumps to a transport time (clamped to zero) and shows the
 *   animated pose there without playing.
 * - `setLoop(on)` toggles the transport loop override. When on, playback
 *   wraps at the clip duration for any clip. When off, the clip's own
 *   persisted loop policy applies: `loop` clips keep wrapping while
 *   `once` clips stop (auto-pause) at the end of the clip.
 *
 * The clock is injectable (`{ now(): number }`, seconds) so tests drive
 * playback deterministically; the default reads the wall clock, which is
 * fine because transport state is runtime-only.
 */

export interface PlaybackClock {
  readonly now: () => number;
}

/** Transport state of one playback controller. */
export interface PlaybackState {
  /** True while the transport advances with the clock. */
  readonly playing: boolean;
  /** True after `stop()`: evaluation shows base state, time is zero. */
  readonly stopped: boolean;
  /** Raw transport time in seconds; never negative. */
  readonly time: number;
  /** Clip-loop-resolved sample time (`resolveClipTime`). */
  readonly resolvedTime: number;
  /**
   * Transport loop override (setLoop). When true, playback wraps at the
   * clip duration for any clip; when false, the clip's own persisted loop
   * policy applies (`loop` clips keep wrapping, `once` clips stop at the
   * end). For the effective wrapping behavior, read `resolvedTime`.
   */
  readonly loopOverride: boolean;
  /** The active clip, or null when no clip is loaded. */
  readonly clipId: AnimationId | null;
}

export interface PlaybackController {
  readonly state: Readonly<PlaybackState>;
  /**
   * Loads a document snapshot and an optional clip. The document is the
   * immutable committed snapshot; callers refresh it after commit events
   * (evaluation is a pure projection of the current snapshot). Loading a
   * clip rewinds the transport to zero and keeps the stopped/paused state.
   */
  load(document: VoxelDocument, clip: AnimationDescriptor | null): void;
  play(): void;
  pause(): void;
  /** Stops playback and restores base state exactly (ADR-0006). */
  stop(): void;
  /** Jumps to a transport time and shows the animated pose there. */
  scrub(time: number): void;
  /**
   * Toggles the transport loop override. On, playback wraps at the clip
   * duration for any clip; off, the clip's own persisted loop policy
   * applies (`loop` clips keep wrapping, `once` clips auto-pause at the
   * end).
   */
  setLoop(enabled: boolean): void;
  /**
   * Advances the transport with the clock when playing. `now` is in
   * seconds; the first tick after `play()` starts the interval from the
   * clock's current reading.
   */
  tick(now: number): void;
  /** Evaluates the layered runtime state for the current transport. */
  evaluate(): AnimationRuntimeState;
  /** Subscribes to transport state changes; returns an unsubscribe fn. */
  subscribe(listener: (state: Readonly<PlaybackState>) => void): () => void;
}

const wallClock = (): PlaybackClock => ({ now: () => Date.now() / 1000 });

export function createPlaybackController(
  clock: PlaybackClock = wallClock(),
  document: VoxelDocument | null = null,
  clip: AnimationDescriptor | null = null,
): PlaybackController {
  const listeners = createListenerSet<Readonly<PlaybackState>>();
  let currentDocument: VoxelDocument | null = document;
  let currentClip: AnimationDescriptor | null = clip;
  let playing = false;
  let stopped = true;
  let time = 0;
  let loopOverride = false;
  let lastTick: number | undefined;

  const resolvedTime = (): number => {
    if (currentClip === null) return 0;
    // The transport loop override wraps any clip at its duration; without
    // the override the clip's own persisted loop policy applies.
    if (loopOverride) return time % currentClip.duration;
    return resolveClipTime(currentClip, time);
  };

  const emit = (): void => {
    listeners.emit(stateSnapshot());
  };

  const stateSnapshot = (): Readonly<PlaybackState> =>
    Object.freeze({
      playing,
      stopped,
      time,
      resolvedTime: resolvedTime(),
      loopOverride,
      clipId: currentClip?.animationId ?? null,
    });

  const atClipEnd = (): boolean => {
    if (currentClip === null) return false;
    if (loopOverride || currentClip.loop === "loop") return false;
    return time >= currentClip.duration;
  };

  return {
    get state() {
      return stateSnapshot();
    },

    load(documentValue, clipValue) {
      currentDocument = documentValue;
      currentClip = clipValue;
      time = 0;
      lastTick = undefined;
      emit();
    },

    play() {
      if (currentClip === null) return;
      if (atClipEnd()) time = 0;
      playing = true;
      stopped = false;
      lastTick = clock.now();
      emit();
    },

    pause() {
      if (!playing) return;
      playing = false;
      emit();
    },

    stop() {
      playing = false;
      stopped = true;
      time = 0;
      lastTick = undefined;
      emit();
    },

    scrub(scrubTime) {
      time = Number.isFinite(scrubTime) && scrubTime > 0 ? scrubTime : 0;
      playing = false;
      stopped = false;
      lastTick = undefined;
      emit();
    },

    setLoop(enabled) {
      if (enabled === loopOverride) return;
      loopOverride = enabled;
      emit();
    },

    tick(now) {
      if (!playing) return;
      const previous = lastTick ?? now;
      lastTick = now;
      const delta = now - previous;
      if (!(delta > 0)) return;
      time += delta;
      if (atClipEnd()) {
        // A `once` clip with the transport loop override off reaches its
        // end: clamp and auto-pause exactly at the duration.
        time = currentClip === null ? time : currentClip.duration;
        playing = false;
      }
      emit();
    },

    evaluate() {
      if (currentDocument === null) {
        throw new Error(
          "PlaybackController: no document is loaded; call load(document, clip) first",
        );
      }
      if (stopped || currentClip === null) {
        return evaluateAnimationRuntime(currentDocument, null, 0);
      }
      return evaluateAnimationRuntime(
        currentDocument,
        currentClip,
        resolvedTime(),
      );
    },

    subscribe(listener) {
      return listeners.add(listener);
    },
  };
}
