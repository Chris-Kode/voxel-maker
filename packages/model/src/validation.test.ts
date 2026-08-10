import { describe, expect, it } from "vitest";
import { validateDocument, type DocumentIssue } from "./index.js";
import type { DocumentLimits } from "./limits.js";

function buildDocument(): Record<string, unknown> {
  return structuredClone({
    documentId: "document:test:0001",
    documentSchemaVersion: 1,
    revision: 0,
    metadata: {},
    rootNodeId: "node:test:root",
    nodes: {
      "node:test:root": {
        nodeId: "node:test:root",
        parentId: null,
        children: ["node:test:child"],
        transform: {
          translation: [0, 0, 0],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [],
      },
      "node:test:child": {
        nodeId: "node:test:child",
        parentId: "node:test:root",
        children: [],
        transform: {
          translation: [0, 0, 0],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: "volume:test:0001" },
        ],
      },
    },
    materials: {
      "1": {
        materialId: 1,
        name: "m",
        color: "#ffffff",
        opacity: 1,
        roughness: 0,
        metallic: 0,
        emissive: 0,
      },
    },
    volumes: {
      "volume:test:0001": {
        volumeId: "volume:test:0001",
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    },
    animations: {
      "animation:test:clip": {
        animationId: "animation:test:clip",
        duration: 1,
        loop: "once",
        tracks: [
          {
            trackId: "track:test:move",
            targetNodeId: "node:test:child",
            interpolation: "linear",
            keyframes: [
              {
                keyframeId: "keyframe:test:0",
                time: 0,
                property: { channel: "translation", value: [0, 0, 0] },
              },
              {
                keyframeId: "keyframe:test:1",
                time: 1,
                property: { channel: "translation", value: [1, 0, 0] },
              },
            ],
          },
        ],
      },
    },
  });
}

function findIssue(
  issues: readonly DocumentIssue[],
  code: string,
): DocumentIssue | undefined {
  return issues.find((candidate) => candidate.code === code);
}

function expectSingleCode(document: unknown, code: string): DocumentIssue {
  const issues = validateDocument(document);
  const match = findIssue(issues, code);
  if (match === undefined) {
    throw new Error(`Expected ${code}; got ${JSON.stringify(issues)}`);
  }
  return match;
}

describe("validateDocument", () => {
  it("accepts a well-formed document with all record kinds", () => {
    expect(validateDocument(buildDocument())).toEqual([]);
  });

  describe("hierarchy integrity", () => {
    it("rejects parent cycles with a stable code and path", () => {
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      const root = nodes["node:test:root"] as Record<string, unknown>;
      const child = nodes["node:test:child"] as Record<string, unknown>;
      root.parentId = "node:test:child";
      root.children = ["node:test:child"];
      child.children = ["node:test:root"];
      const issue = expectSingleCode(document, "CYCLIC_HIERARCHY");
      expect(issue.path[0]).toBe("nodes");
    });

    it("rejects self-parenting through parentId and children", () => {
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      const child = nodes["node:test:child"] as Record<string, unknown>;
      child.parentId = "node:test:child";
      expect(expectSingleCode(document, "SELF_PARENT").path).toEqual([
        "nodes",
        "node:test:child",
        "parentId",
      ]);
      const root = nodes["node:test:root"] as Record<string, unknown>;
      root.children = ["node:test:root"];
      const document2 = buildDocument();
      const nodes2 = document2.nodes as Record<string, unknown>;
      (nodes2["node:test:root"] as Record<string, unknown>).children = [
        "node:test:root",
      ];
      expect(expectSingleCode(document2, "SELF_PARENT").path).toEqual([
        "nodes",
        "node:test:root",
        "children",
        0,
      ]);
    });

    it("rejects duplicate children", () => {
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      (nodes["node:test:root"] as Record<string, unknown>).children = [
        "node:test:child",
        "node:test:child",
      ];
      const issue = expectSingleCode(document, "DUPLICATE_CHILD");
      expect(issue.path).toEqual(["nodes", "node:test:root", "children", 1]);
    });

    it("rejects missing parent and missing child references", () => {
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      (nodes["node:test:child"] as Record<string, unknown>).parentId =
        "node:test:ghost";
      const missingParent = expectSingleCode(document, "MISSING_REFERENCE");
      expect(missingParent.path).toEqual([
        "nodes",
        "node:test:child",
        "parentId",
      ]);
      const document2 = buildDocument();
      const nodes2 = document2.nodes as Record<string, unknown>;
      (nodes2["node:test:root"] as Record<string, unknown>).children = [
        "node:test:ghost",
      ];
      const missingChild = expectSingleCode(document2, "MISSING_REFERENCE");
      expect(missingChild.path).toEqual([
        "nodes",
        "node:test:root",
        "children",
        0,
      ]);
    });

    it("rejects reciprocal-reference mismatches in both directions", () => {
      // A node references a parent that does not list it as a child.
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      (nodes["node:test:root"] as Record<string, unknown>).children = [];
      const childSide = expectSingleCode(document, "RECIPROCAL_REFERENCE");
      expect(childSide.path).toEqual(["nodes", "node:test:child", "parentId"]);

      // A parent lists a child whose parent reference points elsewhere.
      const document2 = buildDocument();
      const nodes2 = document2.nodes as Record<string, unknown>;
      (nodes2["node:test:child"] as Record<string, unknown>).parentId = null;
      const parentSide = expectSingleCode(document2, "RECIPROCAL_REFERENCE");
      expect(parentSide.path).toEqual([
        "nodes",
        "node:test:root",
        "children",
        0,
      ]);
    });

    it("rejects multiple roots and a root with a parent", () => {
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      const child = nodes["node:test:child"] as Record<string, unknown>;
      child.parentId = null;
      expect(expectSingleCode(document, "INVALID_ROOT").message).toMatch(
        /more than one root/u,
      );
      const document2 = buildDocument();
      const nodes2 = document2.nodes as Record<string, unknown>;
      (nodes2["node:test:root"] as Record<string, unknown>).parentId =
        "node:test:child";
      (nodes2["node:test:root"] as Record<string, unknown>).children = [];
      (nodes2["node:test:child"] as Record<string, unknown>).parentId = null;
      (nodes2["node:test:child"] as Record<string, unknown>).children = [];
      expect(expectSingleCode(document2, "INVALID_ROOT").path).toEqual([
        "rootNodeId",
      ]);
    });

    it("rejects a missing root node and disconnected nodes", () => {
      const document = buildDocument();
      document.rootNodeId = "node:test:ghost";
      expect(expectSingleCode(document, "MISSING_REFERENCE").path).toEqual([
        "rootNodeId",
      ]);
      const document2 = buildDocument();
      const nodes2 = document2.nodes as Record<string, unknown>;
      (nodes2["node:test:root"] as Record<string, unknown>).children = [];
      expect(expectSingleCode(document2, "DISCONNECTED_NODE").path).toEqual([
        "nodes",
        "node:test:child",
      ]);
    });
  });

  describe("component validation", () => {
    it("rejects unsupported component kinds and versions", () => {
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      const child = nodes["node:test:child"] as Record<string, unknown>;
      child.components = [{ kind: "skeleton", schemaVersion: 1 }];
      expect(expectSingleCode(document, "UNSUPPORTED_COMPONENT").path).toEqual([
        "nodes",
        "node:test:child",
        "components",
        0,
        "kind",
      ]);
      const document2 = buildDocument();
      const nodes2 = document2.nodes as Record<string, unknown>;
      (nodes2["node:test:child"] as Record<string, unknown>).components = [
        { kind: "voxel", schemaVersion: 2, volumeId: "volume:test:0001" },
      ];
      expect(
        expectSingleCode(document2, "UNSUPPORTED_COMPONENT_VERSION").path,
      ).toEqual(["nodes", "node:test:child", "components", 0, "schemaVersion"]);
    });

    it("rejects duplicate singleton components per node", () => {
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      (nodes["node:test:child"] as Record<string, unknown>).components = [
        { kind: "voxel", schemaVersion: 1, volumeId: "volume:test:0001" },
        { kind: "voxel", schemaVersion: 1, volumeId: "volume:test:0001" },
      ];
      const issue = expectSingleCode(document, "DUPLICATE_COMPONENT");
      expect(issue.path).toEqual(["nodes", "node:test:child", "components", 1]);
    });

    it("rejects duplicate constraint component IDs across the document", () => {
      const constraint = {
        componentId: "component:test:same",
        type: "rotation-limits",
        limits: { min: [-1, 0, 0], max: [1, 0, 0] },
      };
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      // child sorts before root, so the duplicate is reported on the root
      (nodes["node:test:child"] as Record<string, unknown>).components = [
        { kind: "constraint", schemaVersion: 1, constraints: [constraint] },
      ];
      (nodes["node:test:root"] as Record<string, unknown>).components = [
        { kind: "constraint", schemaVersion: 1, constraints: [constraint] },
      ];
      expect(expectSingleCode(document, "DUPLICATE_COMPONENT_ID").path).toEqual(
        [
          "nodes",
          "node:test:root",
          "components",
          0,
          "constraints",
          0,
          "componentId",
        ],
      );
    });

    it("rejects constraint limits with min greater than max", () => {
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      (nodes["node:test:child"] as Record<string, unknown>).components = [
        {
          kind: "constraint",
          schemaVersion: 1,
          constraints: [
            {
              componentId: "component:test:limit",
              type: "rotation-limits",
              limits: { min: [1, 0, 0], max: [-1, 0, 0] },
            },
          ],
        },
      ];
      expect(expectSingleCode(document, "INVALID_CONSTRAINT").path).toEqual([
        "nodes",
        "node:test:child",
        "components",
        0,
        "constraints",
        0,
        "limits",
      ]);
    });
  });

  describe("canonical value validation", () => {
    it("rejects non-finite and negative-zero numbers with stable paths", () => {
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      const child = nodes["node:test:child"] as Record<string, unknown>;
      const childTransform = {
        translation: [Number.NaN, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      };
      child.transform = childTransform;
      const issue = expectSingleCode(document, "INVALID_CANONICAL_NUMBER");
      expect(issue.path).toEqual([
        "nodes",
        "node:test:child",
        "transform",
        "translation",
        0,
      ]);

      const document2 = buildDocument();
      const nodes2 = document2.nodes as Record<string, unknown>;
      (nodes2["node:test:child"] as Record<string, unknown>).transform = {
        translation: [-0, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      };
      expect(
        expectSingleCode(document2, "INVALID_CANONICAL_NUMBER").path,
      ).toEqual(["nodes", "node:test:child", "transform", "translation", 0]);
    });

    it("rejects non-positive scale", () => {
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      (nodes["node:test:child"] as Record<string, unknown>).transform = {
        translation: [0, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 0, 1],
      };
      expect(expectSingleCode(document, "INVALID_SCALE").path).toEqual([
        "nodes",
        "node:test:child",
        "transform",
        "scale",
        1,
      ]);
    });

    it("rejects unnormalized and non-canonical quaternions", () => {
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      (nodes["node:test:child"] as Record<string, unknown>).transform = {
        translation: [0, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0.5, 0, 0, 0.5],
        scale: [1, 1, 1],
      };
      expect(expectSingleCode(document, "INVALID_QUATERNION").path).toEqual([
        "nodes",
        "node:test:child",
        "transform",
        "rotation",
      ]);
      const document2 = buildDocument();
      const nodes2 = document2.nodes as Record<string, unknown>;
      (nodes2["node:test:child"] as Record<string, unknown>).transform = {
        translation: [0, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0, 0, 0, -1],
        scale: [1, 1, 1],
      };
      expect(
        expectSingleCode(document2, "NON_CANONICAL_QUATERNION").path,
      ).toEqual(["nodes", "node:test:child", "transform", "rotation"]);
    });

    it("rejects invalid colors and out-of-range material fields", () => {
      const document = buildDocument();
      const materials = document.materials as Record<string, unknown>;
      (materials["1"] as Record<string, unknown>).color = "#GGGGGG";
      expect(expectSingleCode(document, "INVALID_COLOR").path).toEqual([
        "materials",
        "1",
        "color",
      ]);
      const document2 = buildDocument();
      const materials2 = document2.materials as Record<string, unknown>;
      (materials2["1"] as Record<string, unknown>).opacity = 1.5;
      expect(
        expectSingleCode(document2, "INVALID_MATERIAL_RANGE").path,
      ).toEqual(["materials", "1", "opacity"]);
    });

    it("rejects record keys that disagree with embedded identifiers", () => {
      const document = buildDocument();
      const nodes = document.nodes as Record<string, unknown>;
      (nodes["node:test:child"] as Record<string, unknown>).nodeId =
        "node:test:other";
      expect(expectSingleCode(document, "MISMATCHED_RECORD_ID").path).toEqual([
        "nodes",
        "node:test:child",
        "nodeId",
      ]);
      const document2 = buildDocument();
      const volumes2 = document2.volumes as Record<string, unknown>;
      (volumes2["volume:test:0001"] as Record<string, unknown>).volumeId =
        "volume:test:other";
      expect(expectSingleCode(document2, "MISMATCHED_RECORD_ID").path).toEqual([
        "volumes",
        "volume:test:0001",
        "volumeId",
      ]);
      const document3 = buildDocument();
      const animations3 = document3.animations as Record<string, unknown>;
      (
        animations3["animation:test:clip"] as Record<string, unknown>
      ).animationId = "animation:test:other";
      expect(expectSingleCode(document3, "MISMATCHED_RECORD_ID").path).toEqual([
        "animations",
        "animation:test:clip",
        "animationId",
      ]);
    });

    it("rejects mismatched record keys and unknown fields", () => {
      const document = buildDocument();
      const materials = document.materials as Record<string, unknown>;
      materials["2"] = {
        materialId: 3,
        name: "second",
        color: "#ffffff",
        opacity: 1,
        roughness: 0,
        metallic: 0,
        emissive: 0,
      };
      expect(expectSingleCode(document, "MISMATCHED_RECORD_ID").path).toEqual([
        "materials",
        "2",
        "materialId",
      ]);
      const document2 = buildDocument();
      document2.unknownTopLevel = true;
      expect(expectSingleCode(document2, "UNKNOWN_FIELD").path).toEqual([
        "unknownTopLevel",
      ]);
      const document3 = buildDocument();
      const nodes3 = document3.nodes as Record<string, unknown>;
      (nodes3["node:test:child"] as Record<string, unknown>).extra = 1;
      expect(expectSingleCode(document3, "UNKNOWN_FIELD").path).toEqual([
        "nodes",
        "node:test:child",
        "extra",
      ]);
    });

    it("rejects invalid revisions and schema versions", () => {
      const document = buildDocument();
      document.revision = -1;
      expect(expectSingleCode(document, "INVALID_REVISION").path).toEqual([
        "revision",
      ]);
      const document2 = buildDocument();
      document2.documentSchemaVersion = 2;
      expect(
        expectSingleCode(document2, "INVALID_DOCUMENT_SCHEMA_VERSION").path,
      ).toEqual(["documentSchemaVersion"]);
    });
  });

  describe("animation validation", () => {
    it("rejects invalid durations, loop policies, and interpolation modes", () => {
      const document = buildDocument();
      const animations = document.animations as Record<string, unknown>;
      (animations["animation:test:clip"] as Record<string, unknown>).duration =
        0;
      expect(
        expectSingleCode(document, "INVALID_ANIMATION_DURATION").path,
      ).toEqual(["animations", "animation:test:clip", "duration"]);
      const document2 = buildDocument();
      const animations2 = document2.animations as Record<string, unknown>;
      (animations2["animation:test:clip"] as Record<string, unknown>).loop =
        "pingpong";
      expect(expectSingleCode(document2, "INVALID_LOOP_POLICY").path).toEqual([
        "animations",
        "animation:test:clip",
        "loop",
      ]);
      const document3 = buildDocument();
      const animations3 = document3.animations as Record<string, unknown>;
      const tracks = (
        animations3["animation:test:clip"] as Record<string, unknown>
      ).tracks as Record<string, unknown>[];
      (tracks[0] as Record<string, unknown>).interpolation = "easeInOut";
      expect(expectSingleCode(document3, "INVALID_INTERPOLATION").path).toEqual(
        ["animations", "animation:test:clip", "tracks", 0, "interpolation"],
      );
    });

    it("rejects unsorted and duplicate keyframe times and ranges", () => {
      const document = buildDocument();
      const animations = document.animations as Record<string, unknown>;
      const tracks = (
        animations["animation:test:clip"] as Record<string, unknown>
      ).tracks as Record<string, unknown>[];
      (tracks[0] as Record<string, unknown>).keyframes = [
        {
          keyframeId: "keyframe:test:0",
          time: 0.5,
          property: { channel: "translation", value: [0, 0, 0] },
        },
        {
          keyframeId: "keyframe:test:1",
          time: 0.25,
          property: { channel: "translation", value: [1, 0, 0] },
        },
      ];
      expect(
        expectSingleCode(document, "UNSORTED_KEYFRAME_TIMES").path,
      ).toEqual([
        "animations",
        "animation:test:clip",
        "tracks",
        0,
        "keyframes",
        1,
        "time",
      ]);
      const document2 = buildDocument();
      const animations2 = document2.animations as Record<string, unknown>;
      const tracks2 = (
        animations2["animation:test:clip"] as Record<string, unknown>
      ).tracks as Record<string, unknown>[];
      (tracks2[0] as Record<string, unknown>).keyframes = [
        {
          keyframeId: "keyframe:test:0",
          time: 0,
          property: { channel: "translation", value: [0, 0, 0] },
        },
        {
          keyframeId: "keyframe:test:1",
          time: 0,
          property: { channel: "translation", value: [1, 0, 0] },
        },
      ];
      expect(
        expectSingleCode(document2, "DUPLICATE_KEYFRAME_TIME").path,
      ).toEqual([
        "animations",
        "animation:test:clip",
        "tracks",
        0,
        "keyframes",
        1,
        "time",
      ]);
      const document3 = buildDocument();
      const animations3 = document3.animations as Record<string, unknown>;
      const tracks3 = (
        animations3["animation:test:clip"] as Record<string, unknown>
      ).tracks as Record<string, unknown>[];
      (tracks3[0] as Record<string, unknown>).keyframes = [
        {
          keyframeId: "keyframe:test:0",
          time: -0.1,
          property: { channel: "translation", value: [0, 0, 0] },
        },
      ];
      expect(expectSingleCode(document3, "INVALID_KEYFRAME_TIME").path).toEqual(
        [
          "animations",
          "animation:test:clip",
          "tracks",
          0,
          "keyframes",
          0,
          "time",
        ],
      );
    });

    it("rejects keyframe values that mismatch their channel", () => {
      const document = buildDocument();
      const animations = document.animations as Record<string, unknown>;
      const tracks = (
        animations["animation:test:clip"] as Record<string, unknown>
      ).tracks as Record<string, unknown>[];
      (tracks[0] as Record<string, unknown>).keyframes = [
        {
          keyframeId: "keyframe:test:0",
          time: 0,
          property: { channel: "rotation", value: [0.5, 0, 0, 0.5] },
        },
      ];
      expect(expectSingleCode(document, "INVALID_QUATERNION").path).toEqual([
        "animations",
        "animation:test:clip",
        "tracks",
        0,
        "keyframes",
        0,
        "property",
        "value",
      ]);
      const document2 = buildDocument();
      const animations2 = document2.animations as Record<string, unknown>;
      const tracks2 = (
        animations2["animation:test:clip"] as Record<string, unknown>
      ).tracks as Record<string, unknown>[];
      (tracks2[0] as Record<string, unknown>).keyframes = [
        {
          keyframeId: "keyframe:test:0",
          time: 0,
          property: { channel: "scale", value: [1, -1, 1] },
        },
      ];
      expect(
        expectSingleCode(document2, "INVALID_KEYFRAME_VALUE").path,
      ).toEqual([
        "animations",
        "animation:test:clip",
        "tracks",
        0,
        "keyframes",
        0,
        "property",
        "value",
        1,
      ]);
    });

    it("rejects missing animation targets and duplicate track and keyframe IDs", () => {
      const document = buildDocument();
      const animations = document.animations as Record<string, unknown>;
      const tracks = (
        animations["animation:test:clip"] as Record<string, unknown>
      ).tracks as Record<string, unknown>[];
      (tracks[0] as Record<string, unknown>).targetNodeId = "node:test:ghost";
      expect(expectSingleCode(document, "MISSING_REFERENCE").path).toEqual([
        "animations",
        "animation:test:clip",
        "tracks",
        0,
        "targetNodeId",
      ]);
      const document2 = buildDocument();
      const animations2 = document2.animations as Record<string, unknown>;
      (animations2["animation:test:clip"] as Record<string, unknown>).tracks = [
        {
          trackId: "track:test:same",
          targetNodeId: "node:test:child",
          interpolation: "linear",
          keyframes: [],
        },
        {
          trackId: "track:test:same",
          targetNodeId: "node:test:child",
          interpolation: "linear",
          keyframes: [],
        },
      ];
      expect(expectSingleCode(document2, "DUPLICATE_TRACK_ID").path).toEqual([
        "animations",
        "animation:test:clip",
        "tracks",
        1,
        "trackId",
      ]);
      const document3 = buildDocument();
      const animations3 = document3.animations as Record<string, unknown>;
      (animations3["animation:test:clip"] as Record<string, unknown>).tracks = [
        {
          trackId: "track:test:move",
          targetNodeId: "node:test:child",
          interpolation: "linear",
          keyframes: [
            {
              keyframeId: "keyframe:test:same",
              time: 0,
              property: { channel: "translation", value: [0, 0, 0] },
            },
            {
              keyframeId: "keyframe:test:same",
              time: 1,
              property: { channel: "translation", value: [1, 0, 0] },
            },
          ],
        },
      ];
      expect(expectSingleCode(document3, "DUPLICATE_KEYFRAME_ID").path).toEqual(
        [
          "animations",
          "animation:test:clip",
          "tracks",
          0,
          "keyframes",
          1,
          "keyframeId",
        ],
      );
    });
  });

  describe("deep hierarchies", () => {
    it("validates a within-limits 10,000-node chain without overflowing", () => {
      const count = 10_000;
      const nodes: Record<string, unknown> = {};
      for (let index = 0; index < count; index += 1) {
        const id = `node:chain:${String(index).padStart(5, "0")}`;
        const parent =
          index === 0
            ? null
            : `node:chain:${String(index - 1).padStart(5, "0")}`;
        nodes[id] = {
          nodeId: id,
          parentId: parent,
          children:
            index === count - 1
              ? []
              : [`node:chain:${String(index + 1).padStart(5, "0")}`],
          transform: {
            translation: [0, 0, 0],
            pivot: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          components: [],
        };
      }
      const document = buildDocument();
      document.nodes = nodes;
      document.animations = {};
      document.rootNodeId = "node:chain:00000";
      expect(validateDocument(document)).toEqual([]);
    });
  });

  describe("limits and metadata bounds", () => {
    it("rejects metadata that is too deep, too large, or non-finite", () => {
      let nested: Record<string, unknown> = { leaf: true };
      for (let depth = 0; depth < 20; depth += 1) {
        nested = { child: nested };
      }
      const document = buildDocument();
      document.metadata = { root: nested };
      expect(expectSingleCode(document, "LIMIT_EXCEEDED").family).toBe("limit");

      const document2 = buildDocument();
      const nodes2 = document2.nodes as Record<string, unknown>;
      (nodes2["node:test:child"] as Record<string, unknown>).metadata = {
        value: Number.NaN,
      };
      expect(
        expectSingleCode(document2, "INVALID_CANONICAL_NUMBER").path,
      ).toEqual(["nodes", "node:test:child", "metadata", "value"]);
    });

    it("honors injected limits", () => {
      const limits: DocumentLimits = {
        maxNodes: 1,
        maxVolumes: 1_024,
        maxMaterials: 4_096,
        maxClips: 256,
        maxTracks: 10_000,
        maxKeyframes: 1_000_000,
        maxKeyframesPerTrack: 100_000,
        maxClipDurationSeconds: 86_400,
        maxNameBytes: 256,
        maxMetadataDepth: 16,
        maxMetadataMembers: 10_000,
        maxMetadataBytes: 1_048_576,
        maxMetadataStringBytes: 65_536,
        maxVoxelCoordinate: 1_048_575,
        maxChunks: 262_144,
        maxOccupiedVoxels: 1_000_000,
        maxRevision: Number.MAX_SAFE_INTEGER,
      };
      const limited = validateDocument(buildDocument(), limits);
      const nodeLimit = limited.find(
        (candidate) =>
          candidate.code === "LIMIT_EXCEEDED" && candidate.path[0] === "nodes",
      );
      expect(nodeLimit).toBeDefined();
      if (nodeLimit === undefined) {
        throw new Error("expected a node limit issue");
      }
      expect(nodeLimit.family).toBe("limit");
      expect(nodeLimit.message).toMatch(/1-node limit/u);
    });

    it("rejects volume bounds outside the coordinate limits", () => {
      const document = buildDocument();
      const volumes = document.volumes as Record<string, unknown>;
      (volumes["volume:test:0001"] as Record<string, unknown>).bounds = {
        min: [0, 0, 0],
        max: [2_000_000, 1, 1],
      };
      expect(expectSingleCode(document, "INVALID_INTEGER_VECTOR").path).toEqual(
        ["volumes", "volume:test:0001", "bounds", "max", 0],
      );
    });
  });
});
