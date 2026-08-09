import { describe, expect, it } from "vitest";
import { createDocumentStore } from "@voxel-maker/document";
import { createDocument } from "@voxel-maker/model";
import { documentId, nodeId, volumeId } from "@voxel-maker/shared";
import {
  createEmptyPreviewStore,
  createPreviewFixtureStore,
} from "./preview-fixtures.js";
import {
  PREVIEW_BACKGROUND,
  PREVIEW_MISSING_MATERIAL,
} from "./preview-protocol.js";
import {
  PreviewCancelledError,
  renderStandardPreview,
} from "./preview-renderer.js";

/**
 * Standard preview renderer tests (plan S8.5/S15.2, ticket #25): the
 * deterministic software renderer over the authoritative read view. These
 * tests prove renders never mutate document semantics or the canonical
 * hash, cancellation is safe, and the fixed camera/light/background
 * conventions produce the expected colors and screen positions.
 * golden.test.ts locks the exact pixels against committed images.
 */

const SPEC = { view: "front", width: 96, height: 96 } as const;

/** Counts pixels by dominant channel relative to the other two. */
function classify(rgba: Uint8Array, width: number, height: number) {
  const counts = { background: 0, red: 0, green: 0, blue: 0, other: 0 };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const r = rgba[offset] as number;
      const g = rgba[offset + 1] as number;
      const b = rgba[offset + 2] as number;
      if (
        r === Math.round(PREVIEW_BACKGROUND[0] * 255) &&
        g === Math.round(PREVIEW_BACKGROUND[1] * 255) &&
        b === Math.round(PREVIEW_BACKGROUND[2] * 255)
      ) {
        counts.background += 1;
      } else if (r - Math.max(g, b) > 40) counts.red += 1;
      else if (g - Math.max(r, b) > 40) counts.green += 1;
      else if (b - Math.max(r, g) > 40) counts.blue += 1;
      else counts.other += 1;
    }
  }
  return counts;
}

/** Bounding box of pixels matching a predicate, or undefined when none. */
function boundsOf(
  rgba: Uint8Array,
  width: number,
  height: number,
  predicate: (r: number, g: number, b: number) => boolean,
):
  | {
      readonly minX: number;
      readonly maxX: number;
      readonly minY: number;
      readonly maxY: number;
    }
  | undefined {
  let bounds:
    | {
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
      }
    | undefined;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (
        predicate(
          rgba[offset] as number,
          rgba[offset + 1] as number,
          rgba[offset + 2] as number,
        )
      ) {
        if (bounds === undefined) {
          bounds = { minX: x, maxX: x, minY: y, maxY: y };
        } else {
          bounds.minX = Math.min(bounds.minX, x);
          bounds.maxX = Math.max(bounds.maxX, x);
          bounds.minY = Math.min(bounds.minY, y);
          bounds.maxY = Math.max(bounds.maxY, y);
        }
      }
    }
  }
  return bounds;
}

const isRed = (r: number, g: number, b: number): boolean =>
  r - Math.max(g, b) > 40;
const isBlue = (r: number, g: number, b: number): boolean =>
  b - Math.max(r, g) > 40;

/** Store whose chunks reference a material id with no document record. */
function createStoreWithoutMaterialRecords(): ReturnType<
  typeof createPreviewFixtureStore
> {
  const root = nodeId("node:preview:nomaterial");
  const volume = volumeId("volume:preview:nomaterial");
  const document = createDocument({
    documentId: documentId("document:preview:nomaterial"),
    metadata: { title: "no material fixture" },
    rootNodeId: root,
    nodes: [
      {
        nodeId: root,
        name: "Root",
        parentId: null,
        children: [],
        transform: {
          translation: [0, 0, 0],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: volume }],
      },
    ],
    materials: [],
    volumes: [{ volumeId: volume, bounds: { min: [0, 0, 0], max: [2, 2, 2] } }],
  });
  const values = new Uint16Array(4096);
  values[0] = 1;
  return createDocumentStore({
    document,
    volumes: new Map([[volume, [{ coordinate: [0, 0, 0], values }]]]),
  }).store;
}

describe("renderStandardPreview", () => {
  it("is byte-deterministic for the same store and spec", () => {
    const store = createPreviewFixtureStore();
    const first = renderStandardPreview({ store, spec: SPEC });
    const second = renderStandardPreview({ store, spec: SPEC });
    expect([...first.rgba]).toEqual([...second.rgba]);
    expect(first.width).toBe(96);
    expect(first.height).toBe(96);
    expect(first.rgba.byteLength).toBe(96 * 96 * 4);
  });

  it("never mutates the document revision or canonical hash", () => {
    const store = createPreviewFixtureStore();
    const before = {
      revision: store.revision,
      hash: renderStandardPreview({ store, spec: SPEC }).semanticHash,
    };
    for (const view of ["perspective", "front", "side", "top"] as const) {
      const result = renderStandardPreview({
        store,
        spec: { view, width: 64, height: 64 },
      });
      expect(result.revision).toBe(before.revision);
      expect(result.semanticHash).toBe(before.hash);
    }
    expect(store.revision).toBe(before.revision);
  });

  it("renders only the fixed background for an empty document", () => {
    const store = createEmptyPreviewStore();
    const result = renderStandardPreview({ store, spec: SPEC });
    const counts = classify(result.rgba, result.width, result.height);
    expect(counts.background).toBe(96 * 96);
    expect(counts.red + counts.green + counts.blue).toBe(0);
    expect(result.opaqueTriangles).toBe(0);
    expect(result.transparentTriangles).toBe(0);
  });

  it("reports the expected triangle mix for the fixture", () => {
    const store = createPreviewFixtureStore();
    const result = renderStandardPreview({ store, spec: SPEC });
    // Red cube 24 faces, blue scaled cube 6 faces, green voxel 6 faces.
    expect(result.opaqueTriangles).toBe((24 + 6) * 2);
    expect(result.transparentTriangles).toBe(6 * 2);
  });

  it("shows all three materials in the perspective view", () => {
    const store = createPreviewFixtureStore();
    const result = renderStandardPreview({
      store,
      spec: { view: "perspective", width: 96, height: 96 },
    });
    const counts = classify(result.rgba, result.width, result.height);
    expect(counts.red).toBeGreaterThan(0);
    expect(counts.green).toBeGreaterThan(0);
    expect(counts.blue).toBeGreaterThan(0);
  });

  it("occludes the red cube behind the blue cube in the front view", () => {
    const store = createPreviewFixtureStore();
    const result = renderStandardPreview({ store, spec: SPEC });
    const counts = classify(result.rgba, result.width, result.height);
    // The blue cube (z 3..5) sits in front of the red cube (z 0..2).
    expect(counts.blue).toBeGreaterThan(0);
    expect(counts.red).toBe(0);
  });

  it("keeps the viewport top-view orientation (asset front faces down)", () => {
    const store = createPreviewFixtureStore();
    const result = renderStandardPreview({
      store,
      spec: { view: "top", width: 96, height: 96 },
    });
    // Red cube at z 0..2 renders toward the TOP of the image; the blue
    // cube at z 3..5 toward the BOTTOM (screen-up is -Z).
    const red = boundsOf(result.rgba, 96, 96, isRed);
    const blue = boundsOf(result.rgba, 96, 96, isBlue);
    expect(red).toBeDefined();
    expect(blue).toBeDefined();
    expect(red?.maxY ?? -1).toBeLessThan(blue?.minY ?? 0);
  });

  it("blends transparent green over red at the shared boundary", () => {
    const store = createPreviewFixtureStore();
    // Side view: the green voxel sits at x=2 beside the red cube; the
    // -X face of the green voxel touches the +X face of the red cube, so
    // the transparent green blends with the red surface behind it. The
    // blended pixels have no dominant channel and land in "other".
    const result = renderStandardPreview({
      store,
      spec: { view: "side", width: 96, height: 96 },
    });
    const counts = classify(result.rgba, result.width, result.height);
    expect(counts.green).toBeGreaterThan(0);
    expect(counts.other).toBeGreaterThan(0);
  });

  it("shows the magenta fallback for a missing material record", () => {
    expect(PREVIEW_MISSING_MATERIAL).toEqual([1, 0, 1]);
    const store = createStoreWithoutMaterialRecords();
    const result = renderStandardPreview({ store, spec: SPEC });
    const magenta = boundsOf(
      result.rgba,
      result.width,
      result.height,
      (r, g, b) => r > 150 && g < 60 && b > 150,
    );
    expect(magenta).toBeDefined();
    expect(result.opaqueTriangles).toBeGreaterThan(0);
  });

  it("honors cancellation even for an empty document", () => {
    const store = createEmptyPreviewStore();
    expect(() =>
      renderStandardPreview({
        store,
        spec: SPEC,
        shouldCancel: () => true,
      }),
    ).toThrow(PreviewCancelledError);
  });

  it("cancels cooperatively through the shouldCancel poll", () => {
    const store = createPreviewFixtureStore();
    let calls = 0;
    expect(() =>
      renderStandardPreview({
        store,
        spec: { view: "front", width: 32, height: 32 },
        shouldCancel: () => {
          calls += 1;
          return calls > 2;
        },
      }),
    ).toThrow(PreviewCancelledError);
  });

  it("rejects an invalid spec with a structured error", () => {
    const store = createPreviewFixtureStore();
    expect(() =>
      renderStandardPreview({
        store,
        spec: { view: "front", width: 0, height: 32 },
      }),
    ).toThrow(/positive/);
  });
});
