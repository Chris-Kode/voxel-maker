import { describe, expect, it } from "vitest";
import { materialId, nodeId, volumeId } from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  addSelectionEntry,
  applySelectionIntent,
  pruneSelection,
  selectionContains,
  selectionKey,
  spanRegion,
  toggleSelectionEntry,
} from "./index.js";
import type { SelectionEntry } from "./types.js";

/**
 * Runtime selection semantics (plan S7.2, ticket #18): canonical entry
 * identity, replace/add/toggle intent, region spanning, and pruning of
 * deleted node/volume references.
 */

const NODE_A = nodeId("node:a");
const VOLUME = volumeId("volume:1");

const nodeEntry = (nodeIdValue: string): SelectionEntry => ({
  kind: "node",
  nodeId: nodeIdValue as never,
});
const voxelEntry = (voxel: [number, number, number]): SelectionEntry => ({
  kind: "voxel",
  volumeId: VOLUME,
  voxel,
});
const regionEntry = (
  min: [number, number, number],
  max: [number, number, number],
): SelectionEntry => ({
  kind: "region",
  volumeId: VOLUME,
  region: { min, max },
});

function buildDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:test:selection" as never,
    metadata: { title: "selection-fixture" },
    rootNodeId: NODE_A,
    nodes: [
      {
        nodeId: NODE_A,
        name: "Root",
        parentId: null,
        children: [],
        transform: {
          translation: [0, 0, 0],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "red",
        color: "#ff0000",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [{ volumeId: VOLUME }],
  });
}

describe("selection entries", () => {
  it("gives each entry kind a canonical identity", () => {
    expect(selectionKey(nodeEntry("node:a"))).toBe("node:node:a");
    expect(selectionKey(voxelEntry([1, 2, 3]))).toBe("voxel:volume:1:1,2,3");
    expect(selectionKey(regionEntry([0, 0, 0], [2, 2, 2]))).toBe(
      "region:volume:1:0,0,0..2,2,2",
    );
    // Same entry shape, same key (canonical region identity).
    expect(selectionKey(regionEntry([0, 0, 0], [2, 2, 2]))).toBe(
      selectionKey(regionEntry([0, 0, 0], [2, 2, 2])),
    );
    expect(selectionContains([nodeEntry("node:a")], nodeEntry("node:a"))).toBe(
      true,
    );
    expect(
      selectionContains([nodeEntry("node:a")], voxelEntry([0, 0, 0])),
    ).toBe(false);
  });

  it("spans two voxels into an inclusive half-open region", () => {
    expect(spanRegion([2, -3, 4], [-1, 5, 4])).toEqual({
      min: [-1, -3, 4],
      max: [3, 6, 5],
    });
    expect(spanRegion([0, 0, 0], [0, 0, 0])).toEqual({
      min: [0, 0, 0],
      max: [1, 1, 1],
    });
    // Order does not matter.
    expect(spanRegion([5, 5, 5], [1, 1, 1])).toEqual(
      spanRegion([1, 1, 1], [5, 5, 5]),
    );
  });
});

describe("selection intent", () => {
  const existing: SelectionEntry[] = [nodeEntry("node:a")];

  it("replaces the selection on a plain click", () => {
    expect(
      applySelectionIntent(existing, nodeEntry("node:b"), {
        additive: false,
        toggle: false,
      }),
    ).toEqual([nodeEntry("node:b")]);
  });

  it("adds on Shift and never duplicates", () => {
    expect(
      applySelectionIntent(existing, nodeEntry("node:b"), {
        additive: true,
        toggle: false,
      }),
    ).toEqual([nodeEntry("node:a"), nodeEntry("node:b")]);
    expect(
      applySelectionIntent(existing, nodeEntry("node:a"), {
        additive: true,
        toggle: false,
      }),
    ).toEqual([nodeEntry("node:a")]);
  });

  it("toggles on Ctrl/Cmd", () => {
    expect(
      applySelectionIntent(existing, nodeEntry("node:a"), {
        additive: false,
        toggle: true,
      }),
    ).toEqual([]);
    expect(
      applySelectionIntent(existing, nodeEntry("node:b"), {
        additive: false,
        toggle: true,
      }),
    ).toEqual([nodeEntry("node:a"), nodeEntry("node:b")]);
  });

  it("clears on a plain miss and keeps the selection on modified misses", () => {
    expect(
      applySelectionIntent(existing, undefined, {
        additive: false,
        toggle: false,
      }),
    ).toEqual([]);
    expect(
      applySelectionIntent(existing, undefined, {
        additive: true,
        toggle: false,
      }),
    ).toEqual(existing);
    expect(
      applySelectionIntent(existing, undefined, {
        additive: false,
        toggle: true,
      }),
    ).toEqual(existing);
  });

  it("add and toggle helpers keep order and dedupe", () => {
    expect(addSelectionEntry(existing, nodeEntry("node:a"))).toEqual(existing);
    expect(toggleSelectionEntry(existing, nodeEntry("node:a"))).toEqual([]);
    expect(toggleSelectionEntry(existing, nodeEntry("node:b"))).toEqual([
      nodeEntry("node:a"),
      nodeEntry("node:b"),
    ]);
  });
});

describe("selection pruning", () => {
  it("drops node entries whose node is deleted", () => {
    const document = buildDocument();
    const selection: SelectionEntry[] = [
      nodeEntry("node:a"),
      nodeEntry("node:b"),
    ];
    const pruned = pruneSelection(selection, document);
    expect(pruned).toEqual([nodeEntry("node:a")]);
  });

  it("drops voxel and region entries whose volume is deleted", () => {
    const document = buildDocument();
    const selection: SelectionEntry[] = [
      { kind: "voxel", volumeId: volumeId("volume:gone"), voxel: [1, 1, 1] },
      {
        kind: "region",
        volumeId: volumeId("volume:gone"),
        region: { min: [0, 0, 0], max: [2, 2, 2] },
      },
    ];
    const pruned = pruneSelection(selection, document);
    expect(pruned).toEqual([]);
  });

  it("keeps mixed entries referencing live nodes and volumes", () => {
    const document = buildDocument();
    const selection: SelectionEntry[] = [
      nodeEntry("node:a"),
      voxelEntry([1, 1, 1]),
      nodeEntry("node:b"),
      { kind: "voxel", volumeId: volumeId("volume:gone"), voxel: [0, 0, 0] },
    ];
    const pruned = pruneSelection(selection, document);
    expect(pruned).toEqual([nodeEntry("node:a"), voxelEntry([1, 1, 1])]);
  });

  it("never mutates the input selection", () => {
    const document = buildDocument();
    const selection: SelectionEntry[] = [nodeEntry("node:b")];
    const pruned = pruneSelection(selection, document);
    expect(pruned).toEqual([]);
    expect(selection).toEqual([nodeEntry("node:b")]);
  });
});
