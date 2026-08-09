import { describe, expect, it } from "vitest";
import { animationId, keyframeId, trackId } from "@voxel-maker/shared";
import {
  createTimelineStore,
  pixelToTime,
  snapTime,
  timeToPixel,
  TIMELINE_DEFAULT_SNAP_INCREMENT,
  TIMELINE_DEFAULT_ZOOM,
  TIMELINE_MAX_ZOOM,
  TIMELINE_MIN_ZOOM,
} from "./timeline.js";

/**
 * Timeline runtime state (plan S10.9, ticket #29): zoom, scroll,
 * playhead, selection, snapping, and the manual/auto key mode live in
 * the runtime-only timeline store. None of this is ever persisted or
 * authoritative — the document store and command bus own semantic state
 * (ARCHITECTURE.md "Editor interaction").
 */

const CLIP_A = animationId("animation:timeline:a");
const CLIP_B = animationId("animation:timeline:b");
const TRACK_1 = trackId("track:timeline:1");
const TRACK_2 = trackId("track:timeline:2");
const KEY_1 = keyframeId("keyframe:timeline:1");
const KEY_2 = keyframeId("keyframe:timeline:2");

describe("timeline store", () => {
  it("starts with bounded defaults", () => {
    const store = createTimelineStore();
    const state = store.snapshot();
    expect(state.zoom).toBe(TIMELINE_DEFAULT_ZOOM);
    expect(state.scrollSeconds).toBe(0);
    expect(state.playhead).toBe(0);
    expect(state.selectedClipId).toBeUndefined();
    expect(state.selectedTrackIds).toEqual([]);
    expect(state.selectedKeyframeIds).toEqual([]);
    expect(state.snapEnabled).toBe(true);
    expect(state.snapIncrement).toBe(TIMELINE_DEFAULT_SNAP_INCREMENT);
    expect(state.keyMode).toBe("manual");
  });

  it("clamps zoom into [min, max] and rejects non-finite values", () => {
    const store = createTimelineStore();
    store.setZoom(1);
    expect(store.snapshot().zoom).toBe(TIMELINE_MIN_ZOOM);
    store.setZoom(Number.POSITIVE_INFINITY);
    expect(store.snapshot().zoom).toBe(TIMELINE_MAX_ZOOM);
    store.setZoom(120);
    expect(store.snapshot().zoom).toBe(120);
  });

  it("keeps scroll and playhead non-negative and finite", () => {
    const store = createTimelineStore();
    store.setScrollSeconds(-5);
    expect(store.snapshot().scrollSeconds).toBe(0);
    store.setPlayhead(-1);
    expect(store.snapshot().playhead).toBe(0);
    store.setScrollSeconds(12.5);
    store.setPlayhead(3.25);
    expect(store.snapshot().scrollSeconds).toBe(12.5);
    expect(store.snapshot().playhead).toBe(3.25);
  });

  it("selecting a clip clears track and keyframe selection", () => {
    const store = createTimelineStore();
    store.selectClip(CLIP_A);
    store.selectTracks([TRACK_1]);
    store.selectKeyframes([KEY_1, KEY_2]);
    expect(store.snapshot().selectedTrackIds).toEqual([TRACK_1]);
    expect(store.snapshot().selectedKeyframeIds).toEqual([KEY_1, KEY_2]);
    store.selectClip(CLIP_B);
    expect(store.snapshot().selectedClipId).toBe(CLIP_B);
    expect(store.snapshot().selectedTrackIds).toEqual([]);
    expect(store.snapshot().selectedKeyframeIds).toEqual([]);
  });

  it("selecting tracks clears keyframe selection and keeps the clip", () => {
    const store = createTimelineStore();
    store.selectClip(CLIP_A);
    store.selectKeyframes([KEY_1]);
    store.selectTracks([TRACK_1, TRACK_2]);
    expect(store.snapshot().selectedClipId).toBe(CLIP_A);
    expect(store.snapshot().selectedTrackIds).toEqual([TRACK_1, TRACK_2]);
    expect(store.snapshot().selectedKeyframeIds).toEqual([]);
  });

  it("deselecting the clip clears the whole selection", () => {
    const store = createTimelineStore();
    store.selectClip(CLIP_A);
    store.selectTracks([TRACK_1]);
    store.selectKeyframes([KEY_1]);
    store.selectClip(undefined);
    expect(store.snapshot().selectedClipId).toBeUndefined();
    expect(store.snapshot().selectedTrackIds).toEqual([]);
    expect(store.snapshot().selectedKeyframeIds).toEqual([]);
  });

  it("bounds the snap increment to a positive finite range", () => {
    const store = createTimelineStore();
    store.setSnapIncrement(0);
    expect(store.snapshot().snapIncrement).toBeGreaterThan(0);
    store.setSnapIncrement(Number.NaN);
    expect(Number.isFinite(store.snapshot().snapIncrement)).toBe(true);
    store.setSnapIncrement(0.5);
    expect(store.snapshot().snapIncrement).toBe(0.5);
  });

  it("notifies subscribers on every mutation", () => {
    const store = createTimelineStore();
    let count = 0;
    const unsubscribe = store.subscribe(() => {
      count += 1;
    });
    store.setZoom(200);
    store.selectClip(CLIP_A);
    store.setKeyMode("auto");
    unsubscribe();
    store.setPlayhead(2);
    expect(count).toBe(3);
  });
});

describe("timeline geometry helpers", () => {
  it("converts between pixels and time with zoom and scroll", () => {
    const zoom = 100; // px per second
    const scroll = 2; // seconds
    expect(timeToPixel(2, zoom, scroll)).toBe(0);
    expect(timeToPixel(2.5, zoom, scroll)).toBe(50);
    expect(pixelToTime(0, zoom, scroll)).toBe(2);
    expect(pixelToTime(50, zoom, scroll)).toBe(2.5);
    expect(pixelToTime(-10, zoom, scroll)).toBe(1.9);
  });

  it("snaps times to the increment", () => {
    expect(snapTime(0.34, 0.1)).toBe(0.3);
    expect(snapTime(0.37, 0.1)).toBe(0.4);
    expect(snapTime(1.0, 0.25)).toBe(1.0);
    expect(snapTime(-0.06, 0.1)).toBe(-0.1);
    expect(snapTime(0.34, 0)).toBe(0.34);
  });
});
