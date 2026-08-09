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

describe("inspectSummary", () => {
  it("reports identity, revision, and bounded counts", () => {
    const value = ok("inspectSummary", { includeSelection: false });
    const document = value.document as Readonly<Record<string, JsonValue>>;
    expect(document.documentId).toBe(FIXTURE_IDS.document);
    expect(document.revision).toBe(1);
    const counts = value.counts as Readonly<Record<string, JsonValue>>;
    expect(counts.nodes).toBe(4);
    expect(counts.materials).toBe(2);
    expect(counts.volumes).toBe(2);
    expect(counts.animations).toBe(1);
    expect(counts.tracks).toBe(1);
    expect(counts.keyframes).toBe(2);
    expect(counts.occupiedVoxels).toBe(4);
  });

  it("lists per-volume occupancy", () => {
    const value = ok("inspectSummary", { includeSelection: false });
    const volumes = value.volumes as readonly JsonValue[];
    expect(volumes).toHaveLength(2);
    const main = volumes[0] as Readonly<Record<string, JsonValue>>;
    expect(main.volumeId).toBe(FIXTURE_IDS.volumeMain);
    expect(main.occupiedCount).toBe(4);
    const bounds = main.occupiedBounds as Readonly<Record<string, JsonValue>>;
    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max).toEqual([2, 2, 2]); // half-open: occupied coords 0..1
  });
});

describe("inspectHierarchy", () => {
  it("returns the depth-bounded tree from the root", () => {
    const value = ok("inspectHierarchy", {});
    expect(value.rootNodeId).toBe(FIXTURE_IDS.root);
    expect(value.nodeCount).toBe(4);
    const root = value.root as Readonly<Record<string, JsonValue>>;
    expect(root.nodeId).toBe(FIXTURE_IDS.root);
    expect(root.childCount).toBe(2);
    const children = root.children as readonly JsonValue[];
    expect(children).toHaveLength(2);
    const body = children[0] as Readonly<Record<string, JsonValue>>;
    expect(body.nodeId).toBe(FIXTURE_IDS.body);
    const bodyChildren = body.children as readonly JsonValue[];
    expect(bodyChildren).toHaveLength(1);
  });

  it("starts from a requested subtree root", () => {
    const value = ok("inspectHierarchy", { rootNodeId: FIXTURE_IDS.body });
    expect(value.nodeCount).toBe(2);
    const root = value.root as Readonly<Record<string, JsonValue>>;
    expect(root.nodeId).toBe(FIXTURE_IDS.body);
  });

  it("limits depth on request", () => {
    const value = ok("inspectHierarchy", { maxDepth: 0 });
    const root = value.root as Readonly<Record<string, JsonValue>>;
    expect(root.children as readonly JsonValue[]).toHaveLength(0);
    expect(value.nodeCount).toBe(1);
  });
});

describe("inspectNode", () => {
  it("returns identity, children, canonical transform, and components", () => {
    const value = ok("inspectNode", { nodeId: FIXTURE_IDS.arm });
    expect(value.nodeId).toBe(FIXTURE_IDS.arm);
    expect(value.name).toBe("Arm");
    expect(value.parentId).toBe(FIXTURE_IDS.body);
    const transform = value.transform as Readonly<Record<string, JsonValue>>;
    expect(transform.translation).toEqual([1, 0, 0]);
    expect(transform.pivot).toEqual([0, 0, 0]);
    expect(transform.rotation).toEqual([0, 0, 0, 1]);
    expect(transform.scale).toEqual([1, 1, 1]);
    const components = value.components as readonly JsonValue[];
    expect(components).toHaveLength(3);
    expect(components[0]).toEqual({ kind: "pivot", pivot: [0, 0.5, 0] });
    expect(components[1]).toEqual({ kind: "joint" });
  });

  it("decomposes the world transform", () => {
    const value = ok("inspectNode", {
      nodeId: FIXTURE_IDS.arm,
      includeWorldTransform: true,
    });
    const world = value.worldTransform as Readonly<Record<string, JsonValue>>;
    // body at [0,2,0] + arm at [1,0,0] -> world translation [1,2,0]
    expect(world.translation).toEqual([1, 2, 0]);
  });

  it("reports the root parent as null", () => {
    const value = ok("inspectNode", { nodeId: FIXTURE_IDS.root });
    expect(value.parentId).toBeNull();
  });

  it("reports bounded metadata keys", () => {
    const value = ok("inspectNode", { nodeId: FIXTURE_IDS.decoration });
    const metadata = value.metadata as Readonly<Record<string, JsonValue>>;
    expect(metadata.keys).toEqual(["tags", "note"]);
  });
});

describe("inspectMaterials", () => {
  it("paginates materials by id with totals", () => {
    const value = ok("inspectMaterials", { pageSize: 1 });
    expect(value.total).toBe(2);
    expect(value.page).toBe(1);
    expect(value.hasMore).toBe(true);
    const materials = value.materials as readonly JsonValue[];
    expect(materials).toHaveLength(1);
    const first = materials[0] as Readonly<Record<string, JsonValue>>;
    expect(first.materialId).toBe(1);
    expect(first.name).toBe("accent");
    expect(first.color).toBe("#ff8800");
    const second = ok("inspectMaterials", { pageSize: 1, page: 2 });
    expect(second.hasMore).toBe(false);
    expect(second.materials as readonly JsonValue[]).toHaveLength(1);
  });
});

describe("inspectBounds", () => {
  it("returns occupied bounds, counts, and owners for every volume", () => {
    const value = ok("inspectBounds", {});
    const volumes = value.volumes as readonly JsonValue[];
    expect(volumes).toHaveLength(2);
    const main = volumes[0] as Readonly<Record<string, JsonValue>>;
    expect(main.occupiedCount).toBe(4);
    expect(main.ownerNodeIds).toEqual([FIXTURE_IDS.body]);
    expect(main.occupiedBounds).toEqual({ min: [0, 0, 0], max: [2, 2, 2] });
    const empty = volumes[1] as Readonly<Record<string, JsonValue>>;
    expect(empty.occupiedCount).toBe(0);
    expect(empty.occupiedBounds).toBeUndefined();
  });

  it("restricts to one volume", () => {
    const value = ok("inspectBounds", { volumeId: FIXTURE_IDS.volumeEmpty });
    expect(value.volumes as readonly JsonValue[]).toHaveLength(1);
  });
});

describe("inspectRigging", () => {
  it("lists nodes with pivot/joint/constraint annotations", () => {
    const value = ok("inspectRigging", {});
    expect(value.total).toBe(1);
    const nodes = value.nodes as readonly JsonValue[];
    const arm = nodes[0] as Readonly<Record<string, JsonValue>>;
    expect(arm.nodeId).toBe(FIXTURE_IDS.arm);
    expect(arm.pivot).toEqual([0, 0.5, 0]);
    expect(arm.hasJoint).toBe(true);
    const constraints = arm.constraints as readonly JsonValue[];
    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toEqual({
      componentId: "component:arm:limits",
      type: "rotation-limits",
      limits: { min: [-1, -1, -1], max: [1, 1, 1] },
    });
  });
});

describe("searchNodes", () => {
  it("matches node names case-insensitively", () => {
    const value = ok("searchNodes", { query: "arm" });
    expect(value.total).toBe(1);
    const matches = value.matches as readonly JsonValue[];
    expect(matches[0]).toEqual({ nodeId: FIXTURE_IDS.arm, name: "Arm" });
  });

  it("matches metadata tags", () => {
    const value = ok("searchNodes", { tag: "decor" });
    expect(value.total).toBe(1);
    const matches = value.matches as readonly JsonValue[];
    expect((matches[0] as Readonly<Record<string, JsonValue>>).nodeId).toBe(
      FIXTURE_IDS.decoration,
    );
  });

  it("matches exact metadata string values", () => {
    const value = ok("searchNodes", { tag: "shiny" });
    expect(value.total).toBe(1);
  });

  it("returns an empty page for no matches", () => {
    const value = ok("searchNodes", { query: "zzz" });
    expect(value.total).toBe(0);
    expect(value.matches).toEqual([]);
    expect(value.hasMore).toBe(false);
  });
});

describe("measureDistance", () => {
  it("measures world-space distance between node origins", () => {
    const value = ok("measureDistance", {
      fromNodeId: FIXTURE_IDS.root,
      toNodeId: FIXTURE_IDS.arm,
    });
    expect(value.distance).toBeCloseTo(Math.sqrt(1 + 4), 9); // [1,2,0]
  });

  it("measures point-to-point distance", () => {
    const value = ok("measureDistance", {
      fromPoint: [0, 0, 0],
      toPoint: [3, 4, 0],
    });
    expect(value.distance).toBe(5);
  });

  it("measures node-to-point distance", () => {
    const value = ok("measureDistance", {
      fromNodeId: FIXTURE_IDS.root,
      toPoint: [0, 2, 0],
    });
    expect(value.distance).toBe(2);
  });
});
