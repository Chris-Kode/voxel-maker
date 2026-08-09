import { describe, expect, it } from "vitest";
import type { JsonValue } from "@voxel-maker/shared";
import { createInspector } from "./inspector.js";
import { FIXTURE_IDS, createInspectionStore } from "./fixtures.js";

const { store } = createInspectionStore();
const inspector = createInspector({ store });

function ok(
  name: string,
  args: JsonValue = {},
): Readonly<Record<string, JsonValue>> {
  const result = inspector.inspect(name, args);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) return result.value as Readonly<Record<string, JsonValue>>;
  throw new Error("unreachable");
}

describe("inspectClips", () => {
  it("summarizes clips with track and keyframe counts", () => {
    const value = ok("inspectClips", {});
    expect(value.total).toBe(1);
    const clips = value.clips as readonly JsonValue[];
    const clip = clips[0] as Readonly<Record<string, JsonValue>>;
    expect(clip.animationId).toBe(FIXTURE_IDS.animationWave);
    expect(clip.name).toBe("wave");
    expect(clip.duration).toBe(1);
    expect(clip.loop).toBe("loop");
    expect(clip.trackCount).toBe(1);
    expect(clip.keyframeCount).toBe(2);
  });
});

describe("inspectTracks", () => {
  it("summarizes tracks across clips with channels", () => {
    const value = ok("inspectTracks", {});
    expect(value.total).toBe(1);
    const tracks = value.tracks as readonly JsonValue[];
    const track = tracks[0] as Readonly<Record<string, JsonValue>>;
    expect(track.trackId).toBe(FIXTURE_IDS.trackWave);
    expect(track.animationId).toBe(FIXTURE_IDS.animationWave);
    expect(track.targetNodeId).toBe(FIXTURE_IDS.arm);
    expect(track.interpolation).toBe("smoothstep");
    expect(track.keyframeCount).toBe(2);
    expect(track.channels).toEqual(["rotation"]);
  });

  it("restricts to one clip", () => {
    const value = ok("inspectTracks", {
      animationId: FIXTURE_IDS.animationWave,
    });
    expect(value.total).toBe(1);
  });
});

describe("inspectKeyframes", () => {
  it("returns paginated keyframes with canonical values", () => {
    const value = ok("inspectKeyframes", { trackId: FIXTURE_IDS.trackWave });
    expect(value.trackId).toBe(FIXTURE_IDS.trackWave);
    expect(value.total).toBe(2);
    const keyframes = value.keyframes as readonly JsonValue[];
    expect(keyframes[0]).toEqual({
      keyframeId: FIXTURE_IDS.keyframeStart,
      time: 0,
      channel: "rotation",
      value: [0, 0, 0, 1],
    });
    expect(keyframes[1]).toEqual({
      keyframeId: FIXTURE_IDS.keyframeEnd,
      time: 1,
      channel: "rotation",
      value: [0, 0, 1, 0],
    });
  });

  it("paginates keyframes", () => {
    const page1 = ok("inspectKeyframes", {
      trackId: FIXTURE_IDS.trackWave,
      pageSize: 1,
    });
    expect(page1.total).toBe(2);
    expect(page1.hasMore).toBe(true);
    const page2 = ok("inspectKeyframes", {
      trackId: FIXTURE_IDS.trackWave,
      pageSize: 1,
      page: 2,
    });
    expect(page2.hasMore).toBe(false);
  });
});

describe("pagination consistency across tools", () => {
  it("keeps totals and hasMore consistent for every paginated tool", () => {
    const calls: ReadonlyArray<readonly [string, JsonValue]> = [
      ["inspectMaterials", { pageSize: 1 }],
      ["inspectRigging", { pageSize: 1 }],
      ["inspectClips", { pageSize: 1 }],
      ["inspectTracks", { pageSize: 1 }],
      ["inspectKeyframes", { trackId: FIXTURE_IDS.trackWave, pageSize: 1 }],
      ["searchNodes", { tag: "decor", pageSize: 1 }],
    ];
    for (const [name, args] of calls) {
      const value = ok(name, args);
      const total = value.total as number;
      const pageSize = value.pageSize as number;
      const hasMore = value.hasMore as boolean;
      expect(total).toBeGreaterThanOrEqual(0);
      expect(hasMore).toBe(total > pageSize);
    }
  });
});
