import { describe, expect, it } from "vitest";
import { documentId, nodeId, volumeId } from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { nodesReferencingVolume } from "./index.js";

/**
 * Document hierarchy/query tests: the volume->owner lookup shared by
 * command handlers and editor projections (plan 5.3, ticket #17).
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:test:root");
const A = nodeId("node:test:a");
const B = nodeId("node:test:b");
const VOLUME = volumeId("volume:test:0001");

function buildDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:test:0001"),
    metadata: { title: "hierarchy-fixture" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [A, B],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: A,
        name: "A",
        parentId: ROOT,
        children: [],
        transform: IDENTITY,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
      {
        nodeId: B,
        name: "B",
        parentId: ROOT,
        children: [],
        transform: IDENTITY,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
    ],
    volumes: [{ volumeId: VOLUME, bounds: { min: [0, 0, 0], max: [4, 4, 4] } }],
  });
}

describe("nodesReferencingVolume", () => {
  it("returns every node with a voxel component referencing the volume", () => {
    const document = buildDocument();
    const ids = nodesReferencingVolume(document, VOLUME);
    expect(ids).toContain(A);
    expect(ids).toContain(B);
    expect(ids).toHaveLength(2);
  });

  it("returns an empty list for a volume no node references", () => {
    const document = buildDocument();
    expect(
      nodesReferencingVolume(document, volumeId("volume:test:other")),
    ).toEqual([]);
  });
});
