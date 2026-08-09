import { describe, expect, it } from "vitest";
import { documentId, nodeId, volumeId } from "@voxel-maker/shared";
import {
  createDocument,
  type SceneNode,
  type VoxelDocument,
} from "@voxel-maker/model";
import {
  hasJointAnnotation,
  hasPivotAnnotation,
  pivotAnnotation,
  validateRigAnnotations,
} from "./validate.js";

/**
 * Rig annotation semantics (plan S9.1, ticket #26): joints annotate nodes
 * in the single transform hierarchy and never introduce a second parent
 * graph; pivots are singleton finite annotations.
 */

const ROOT = nodeId("node:rig:validate:root");
const ARTICULATED = nodeId("node:rig:validate:articulated");
const ORPHAN = nodeId("node:rig:validate:orphan");

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function buildDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:rig:validate:0001"),
    metadata: { title: "rig validation fixture" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [ARTICULATED],
        transform: identity,
        components: [],
      },
      {
        nodeId: ARTICULATED,
        name: "Articulated",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: [
          { kind: "pivot", schemaVersion: 1, pivot: [1, 0, 0] },
          { kind: "joint", schemaVersion: 1 },
        ],
      },
    ],
    volumes: [{ volumeId: volumeId("volume:rig:validate:0001") }],
  });
}

describe("validateRigAnnotations", () => {
  it("accepts a clean annotated hierarchy", () => {
    expect(validateRigAnnotations(buildDocument())).toEqual([]);
  });

  it("reports duplicate singleton annotations per node", () => {
    const document = buildDocument();
    const node = document.nodes[ARTICULATED];
    const tampered: VoxelDocument = {
      ...document,
      nodes: {
        ...document.nodes,
        [ARTICULATED]: {
          ...(node as SceneNode),
          components: [
            { kind: "joint", schemaVersion: 1 },
            { kind: "joint", schemaVersion: 1 },
          ],
        },
      },
    };
    const issues = validateRigAnnotations(tampered);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "DUPLICATE_ANNOTATION",
      nodeId: ARTICULATED,
      componentKind: "joint",
    });
  });

  it("reports annotations on nodes outside the single hierarchy", () => {
    const document = buildDocument();
    const orphan: VoxelDocument = {
      ...document,
      nodes: {
        ...document.nodes,
        [ORPHAN]: {
          nodeId: ORPHAN,
          name: "Orphan",
          parentId: nodeId("node:rig:validate:missing"),
          children: [],
          transform: identity,
          components: [{ kind: "joint", schemaVersion: 1 }],
        },
      },
    };
    // The orphan's parent id does not exist, so its parent chain cannot
    // reach the root: the annotation sits outside the single hierarchy.
    const issues = validateRigAnnotations(orphan);
    expect(issues.some((issue) => issue.nodeId === ORPHAN)).toBe(true);
    expect(issues.find((issue) => issue.nodeId === ORPHAN)).toMatchObject({
      code: "UNREACHABLE_ANNOTATION",
      componentKind: "joint",
    });
  });

  it("reports non-finite pivot annotations", () => {
    const document = buildDocument();
    const node = document.nodes[ARTICULATED];
    const tampered: VoxelDocument = {
      ...document,
      nodes: {
        ...document.nodes,
        [ARTICULATED]: {
          ...(node as SceneNode),
          components: [
            { kind: "pivot", schemaVersion: 1, pivot: [Infinity, 0, 0] },
          ],
        },
      },
    };
    const issues = validateRigAnnotations(tampered);
    expect(issues.some((issue) => issue.code === "NON_FINITE_PIVOT")).toBe(
      true,
    );
  });
});

describe("annotation helpers", () => {
  const document = buildDocument();
  const articulated = document.nodes[ARTICULATED];
  const root = document.nodes[ROOT];
  if (articulated === undefined || root === undefined) {
    throw new Error("fixture nodes missing");
  }

  it("detects joint and pivot annotations", () => {
    expect(hasJointAnnotation(articulated)).toBe(true);
    expect(hasPivotAnnotation(articulated)).toBe(true);
    expect(hasJointAnnotation(root)).toBe(false);
  });

  it("returns the pivot annotation value", () => {
    expect(pivotAnnotation(articulated)).toEqual({
      kind: "pivot",
      schemaVersion: 1,
      pivot: [1, 0, 0],
    });
    expect(pivotAnnotation(root)).toBeUndefined();
  });
});
