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

describe("queryVoxels", () => {
  it("returns every occupied voxel with deterministic X-then-Y-then-Z order", () => {
    const value = ok("queryVoxels", { volumeId: FIXTURE_IDS.volumeMain });
    expect(value.total).toBe(4);
    expect(value.scanTruncated).toBe(false);
    const voxels = value.voxels as readonly JsonValue[];
    expect(voxels).toEqual([
      { coordinate: [0, 0, 0], material: 1 },
      { coordinate: [1, 0, 0], material: 1 },
      { coordinate: [0, 1, 0], material: 2 },
      { coordinate: [0, 0, 1], material: 1 },
    ]);
  });

  it("paginates voxels predictably", () => {
    const page1 = ok("queryVoxels", {
      volumeId: FIXTURE_IDS.volumeMain,
      pageSize: 2,
    });
    expect(page1.total).toBe(4);
    expect(page1.hasMore).toBe(true);
    expect(page1.voxels as readonly JsonValue[]).toHaveLength(2);
    const page2 = ok("queryVoxels", {
      volumeId: FIXTURE_IDS.volumeMain,
      pageSize: 2,
      page: 2,
    });
    expect(page2.hasMore).toBe(false);
    expect(page2.voxels as readonly JsonValue[]).toHaveLength(2);
  });

  it("restricts to a half-open region", () => {
    const value = ok("queryVoxels", {
      volumeId: FIXTURE_IDS.volumeMain,
      region: { min: [0, 0, 0], max: [1, 1, 1] },
    });
    // only [0,0,0] lies in [0,1) x [0,1) x [0,1)
    expect(value.total).toBe(1);
    expect(value.voxels).toEqual([{ coordinate: [0, 0, 0], material: 1 }]);
  });

  it("returns empty results for empty volumes", () => {
    const value = ok("queryVoxels", { volumeId: FIXTURE_IDS.volumeEmpty });
    expect(value.total).toBe(0);
    expect(value.voxels).toEqual([]);
    expect(value.region).toBeNull();
  });

  it("truncates scans at the configured voxel cap deterministically", () => {
    const capped = createInspector({ store, limits: { maxVoxelsPerQuery: 2 } });
    const result = capped.inspect("queryVoxels", {
      volumeId: FIXTURE_IDS.volumeMain,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Readonly<Record<string, JsonValue>>;
      expect(value.scanTruncated).toBe(true);
      expect(value.voxels as readonly JsonValue[]).toHaveLength(2);
      expect(value.total).toBe(2);
    }
  });

  it("honors a caller-lowered maxVoxels cap", () => {
    const value = ok("queryVoxels", {
      volumeId: FIXTURE_IDS.volumeMain,
      maxVoxels: 3,
    });
    expect(value.scanTruncated).toBe(true);
    expect(value.voxels as readonly JsonValue[]).toHaveLength(3);
  });
});

describe("raycast", () => {
  it("hits the first occupied voxel along the ray", () => {
    const value = ok("raycast", {
      origin: [-1, 0.5, 0.5],
      direction: [1, 0, 0],
      volumeId: FIXTURE_IDS.volumeMain,
    });
    expect(value.hit).toBe(true);
    expect(value.coordinate).toEqual([0, 0, 0]);
    expect(value.material).toBe(1);
    expect(value.distance).toBeCloseTo(1, 9);
    expect(value.stepLimit).toBe(false);
    expect(value.searchedVolumes).toEqual([FIXTURE_IDS.volumeMain]);
  });

  it("skips empty voxels and hits a later one", () => {
    // Ray along X at y=1: voxel [0,1,0] is material 2 at x=0.
    const value = ok("raycast", {
      origin: [-1, 1, 0.5],
      direction: [1, 0, 0],
      volumeId: FIXTURE_IDS.volumeMain,
    });
    expect(value.hit).toBe(true);
    expect(value.coordinate).toEqual([0, 1, 0]);
    expect(value.material).toBe(2);
  });

  it("searches every volume when volumeId is omitted", () => {
    const value = ok("raycast", {
      origin: [-1, 0.5, 0.5],
      direction: [1, 0, 0],
    });
    expect(value.hit).toBe(true);
    expect(value.searchedVolumes).toEqual([
      FIXTURE_IDS.volumeMain,
      FIXTURE_IDS.volumeEmpty,
    ]);
  });

  it("reports misses with step accounting", () => {
    const value = ok("raycast", {
      origin: [10, 10, 10],
      direction: [1, 0, 0],
      volumeId: FIXTURE_IDS.volumeMain,
    });
    expect(value.hit).toBe(false);
    expect(value.steps).toBeGreaterThan(0);
    expect(value.stepLimit).toBe(true);
  });

  it("bounds traversal by maxSteps", () => {
    const value = ok("raycast", {
      origin: [-100, 0.5, 0.5],
      direction: [1, 0, 0],
      volumeId: FIXTURE_IDS.volumeMain,
      maxSteps: 5,
    });
    expect(value.hit).toBe(false);
    expect(value.steps).toBe(5);
    expect(value.stepLimit).toBe(true);
  });

  it("respects maxDistance", () => {
    const value = ok("raycast", {
      origin: [-1, 0.5, 0.5],
      direction: [1, 0, 0],
      volumeId: FIXTURE_IDS.volumeMain,
      maxDistance: 0.5,
    });
    expect(value.hit).toBe(false);
  });
});
