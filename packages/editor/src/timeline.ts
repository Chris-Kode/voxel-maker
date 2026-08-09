import {
  createListenerSet,
  type AnimationId,
  type KeyframeId,
  type TrackId,
} from "@voxel-maker/shared";

/**
 * Timeline runtime state (plan S10.9, ticket #29): zoom, horizontal
 * scroll, playhead, clip/track/keyframe selection, snapping, and the
 * manual/auto key mode. Like the rest of `EditorStore`, none of this is
 * ever persisted or authoritative — the document store and command bus
 * own semantic state (ARCHITECTURE.md "Editor interaction"). The store
 * stays dumb (no command construction, no document reads); the desktop
 * timeline controller composes it with the playback controller, the
 * session, and the command bus.
 */

/** Zoom bounds in pixels per second. */
export const TIMELINE_MIN_ZOOM = 20;
export const TIMELINE_MAX_ZOOM = 500;
export const TIMELINE_DEFAULT_ZOOM = 100;
export const TIMELINE_DEFAULT_SNAP_INCREMENT = 0.1;
/** Maximum snap increment in seconds. */
export const TIMELINE_MAX_SNAP_INCREMENT = 10;

/** Manual-key vs auto-key transform routing (plan S10.12, ticket #29). */
export type KeyMode = "manual" | "auto";

export interface TimelineStoreSnapshot {
  /** Timeline scale in pixels per second; bounded `[min, max]`. */
  readonly zoom: number;
  /** Left-edge time of the visible window in seconds; never negative. */
  readonly scrollSeconds: number;
  /** Transport playhead in seconds; never negative. */
  readonly playhead: number;
  /** The clip the timeline edits, or undefined for base state. */
  readonly selectedClipId: AnimationId | undefined;
  /** Selected tracks within the selected clip (S10.11 multi-select). */
  readonly selectedTrackIds: readonly TrackId[];
  /** Selected keyframes within the selected tracks (S10.11). */
  readonly selectedKeyframeIds: readonly KeyframeId[];
  /** Snapping toggle; when on, edit times snap to `snapIncrement`. */
  readonly snapEnabled: boolean;
  /** Snap grid in seconds; positive and finite. */
  readonly snapIncrement: number;
  /** Transform-edit routing: base state or the selected clip (S10.12). */
  readonly keyMode: KeyMode;
}

export interface TimelineStore {
  snapshot(): TimelineStoreSnapshot;
  setZoom(zoom: number): void;
  setScrollSeconds(seconds: number): void;
  setPlayhead(seconds: number): void;
  /** Selects a clip; track and keyframe selection clear (S10.11). */
  selectClip(animationId: AnimationId | undefined): void;
  /** Selects tracks; keyframe selection clears. */
  selectTracks(trackIds: readonly TrackId[]): void;
  /** Selects keyframes; the clip and tracks stay selected. */
  selectKeyframes(keyframeIds: readonly KeyframeId[]): void;
  setSnapEnabled(enabled: boolean): void;
  setSnapIncrement(seconds: number): void;
  setKeyMode(mode: KeyMode): void;
  /** Subscribes to state changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

function clampFinite(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  // Non-finite infinities clamp to the bound instead of leaking through.
  return Math.min(max, Math.max(min, value));
}

export function createTimelineStore(): TimelineStore {
  let zoom = TIMELINE_DEFAULT_ZOOM;
  let scrollSeconds = 0;
  let playhead = 0;
  let selectedClipId: AnimationId | undefined;
  let selectedTrackIds: readonly TrackId[] = [];
  let selectedKeyframeIds: readonly KeyframeId[] = [];
  let snapEnabled = true;
  let snapIncrement = TIMELINE_DEFAULT_SNAP_INCREMENT;
  let keyMode: KeyMode = "manual";
  const listeners = createListenerSet<undefined>();

  const notify = (): void => {
    listeners.emit(undefined);
  };

  return {
    snapshot() {
      return {
        zoom,
        scrollSeconds,
        playhead,
        selectedClipId,
        selectedTrackIds,
        selectedKeyframeIds,
        snapEnabled,
        snapIncrement,
        keyMode,
      };
    },
    setZoom(value: number) {
      zoom = clampFinite(value, TIMELINE_MIN_ZOOM, TIMELINE_MAX_ZOOM);
      notify();
    },
    setScrollSeconds(value: number) {
      scrollSeconds = clampFinite(value, 0, Number.MAX_SAFE_INTEGER);
      notify();
    },
    setPlayhead(value: number) {
      playhead = clampFinite(value, 0, Number.MAX_SAFE_INTEGER);
      notify();
    },
    selectClip(animationId: AnimationId | undefined) {
      selectedClipId = animationId;
      selectedTrackIds = [];
      selectedKeyframeIds = [];
      notify();
    },
    selectTracks(trackIds: readonly TrackId[]) {
      selectedTrackIds = [...trackIds];
      selectedKeyframeIds = [];
      notify();
    },
    selectKeyframes(keyframeIds: readonly KeyframeId[]) {
      selectedKeyframeIds = [...keyframeIds];
      notify();
    },
    setSnapEnabled(enabled: boolean) {
      snapEnabled = enabled;
      notify();
    },
    setSnapIncrement(value: number) {
      snapIncrement = clampFinite(
        value,
        Number.MIN_VALUE,
        TIMELINE_MAX_SNAP_INCREMENT,
      );
      notify();
    },
    setKeyMode(mode: KeyMode) {
      keyMode = mode;
      notify();
    },
    subscribe(listener: () => void) {
      return listeners.add(listener);
    },
  };
}

/** Rounds a time to the snap grid; a non-positive increment disables it. */
export function snapTime(time: number, increment: number): number {
  if (!Number.isFinite(increment) || increment <= 0) return time;
  // Round the quotient first, then the product, so float noise never
  // leaks into snapped times (0.34 @ 0.1s is exactly 0.3, not 0.300000…4).
  const snapped = Math.round(time / increment) * increment;
  return Math.round(snapped * 1e9) / 1e9;
}

/** Converts a time to a lane x position for a zoom/scroll window. */
export function timeToPixel(
  time: number,
  zoom: number,
  scrollSeconds: number,
): number {
  return (time - scrollSeconds) * zoom;
}

/** Converts a lane x position to a time for a zoom/scroll window. */
export function pixelToTime(
  pixel: number,
  zoom: number,
  scrollSeconds: number,
): number {
  return scrollSeconds + pixel / zoom;
}
