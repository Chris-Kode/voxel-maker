import { describe, expect, it } from "vitest";
import {
  ANIMATION_TRACK_COUNTS,
  BENCHMARK_SCENE_KINDS,
  createAnimationScaleDocument,
  createBenchmarkFixture,
  mulberry32,
  sceneEntries,
} from "./fixtures.js";

describe("mulberry32", () => {
  it("is deterministic for a fixed seed", () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    const first = a();
    expect(b()).toBe(first);
    expect(a()).toBe(b());
  });

  it("produces unit-interval values", () => {
    const random = mulberry32(7);
    for (let i = 0; i < 100; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("sceneEntries", () => {
  it("compact scenes fill a slab exactly", () => {
    const entries = sceneEntries("compact", 100_000);
    expect(entries).toHaveLength(100_000);
    expect(entries[0]).toEqual([0, 0, 0]);
    const last = entries[entries.length - 1];
    expect(last).toEqual([99, 99, 9]);
  });

  it("checkerboard scenes occupy exactly half their box", () => {
    const entries = sceneEntries("checkerboard", 100_000);
    expect(entries).toHaveLength(100_000);
    // (0,0,0) is occupied; (0,0,1) is not.
    expect(entries).toContainEqual([0, 0, 0]);
    expect(entries).not.toContainEqual([0, 0, 1]);
  });

  it("sparse scenes reach the exact target occupancy deterministically", () => {
    const a = sceneEntries("sparse", 100_000);
    const b = sceneEntries("sparse", 100_000);
    expect(a).toHaveLength(100_000);
    expect(a).toEqual(b);
    const unique = new Set(
      a.map(([x, y, z]) => `${String(x)},${String(y)},${String(z)}`),
    );
    expect(unique.size).toBe(100_000);
  });

  it("large deterministic scenes stay inside volume limits", () => {
    for (const kind of BENCHMARK_SCENE_KINDS) {
      // Sparse generation draws ~20x its target, so unit tests cap it at
      // 100k; the 500k/1M matrix runs in the benchmark CLI instead.
      const target = kind === "sparse" ? 100_000 : 500_000;
      const entries = sceneEntries(kind, target);
      expect(entries).toHaveLength(target);
      for (const [x, y, z] of entries) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(z).toBeGreaterThanOrEqual(0);
      }
    }
  }, 30_000);
});

describe("createBenchmarkFixture", () => {
  it("commits the exact occupied count with a stable hash", () => {
    const fixture = createBenchmarkFixture("compact", 100_000);
    expect(fixture.occupiedCount).toBe(100_000);
    const again = createBenchmarkFixture("compact", 100_000);
    expect(again.semanticHash).toBe(fixture.semanticHash);
    expect(again.store.revision).toBe(1);
  });

  it("the localized edit coordinate is inside every extent and occupied", () => {
    for (const kind of BENCHMARK_SCENE_KINDS) {
      const fixture = createBenchmarkFixture(kind, 100_000);
      const [x, y, z] = fixture.editCoordinate;
      const { min, max } = fixture.extent;
      expect(x).toBeGreaterThanOrEqual(min[0]);
      expect(x).toBeLessThan(max[0]);
      expect(y).toBeGreaterThanOrEqual(min[1]);
      expect(y).toBeLessThan(max[1]);
      expect(z).toBeGreaterThanOrEqual(min[2]);
      expect(z).toBeLessThan(max[2]);
      expect(
        fixture.store.getVoxel(fixture.volumeId, fixture.editCoordinate),
      ).not.toBe(0);
    }
  });

  it("sparse fixtures commit the exact target", () => {
    const fixture = createBenchmarkFixture("sparse", 100_000);
    expect(fixture.occupiedCount).toBe(100_000);
  });
});

describe("createAnimationScaleDocument", () => {
  it("creates two keyframes per track and targets existing nodes", () => {
    const { document, clip, trackCount } = createAnimationScaleDocument(100);
    expect(trackCount).toBe(100);
    expect(clip.tracks).toHaveLength(100);
    expect(Object.keys(document.animations)).toHaveLength(1);
    for (const track of clip.tracks) {
      expect(track.keyframes).toHaveLength(2);
      expect(document.nodes[track.targetNodeId]).toBeDefined();
    }
  });

  it("supports the 10k-track ADR-0008 matrix inside document limits", () => {
    expect(ANIMATION_TRACK_COUNTS).toContain(10_000);
    const { document, clip } = createAnimationScaleDocument(10_000);
    expect(clip.tracks).toHaveLength(10_000);
    // Two tracks per node: 5,000 animated nodes + root stays under the
    // 10,000-node document limit.
    expect(Object.keys(document.nodes)).toHaveLength(5_001);
  });
});
