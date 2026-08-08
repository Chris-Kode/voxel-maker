import { describe, expect, it } from "vitest";
import {
  animationId,
  documentId,
  keyframeId,
  materialId,
  nodeId,
  trackId,
  type NodeId,
  volumeId,
} from "@voxel-maker/shared";
import type { AnimationDescriptor, SceneNode } from "./types.js";
import {
  canonicalDocumentHash,
  canonicalDocumentJson,
  cloneDocument,
  createDocument,
} from "./index.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function minimalInput() {
  return {
    documentId: documentId("document:test:0001"),
    rootNodeId: nodeId("node:test:root"),
    nodes: [
      {
        nodeId: nodeId("node:test:root"),
        parentId: null,
        children: [] as readonly NodeId[],
        transform: identity,
        components: [],
      },
    ],
  };
}

describe("createDocument", () => {
  it("defaults revision to 0 and empty collections", () => {
    const document = createDocument(minimalInput());
    expect(document.revision).toBe(0);
    expect(document.materials).toEqual({});
    expect(document.volumes).toEqual({});
    expect(document.animations).toEqual({});
    expect(document.metadata).toEqual({});
    expect(document.documentSchemaVersion).toBe(1);
  });

  it("keeps caller-supplied identifiers and values", () => {
    const document = createDocument({
      ...minimalInput(),
      revision: 7,
      metadata: { title: "kept" },
      materials: [
        {
          materialId: materialId(12),
          name: "kept",
          color: "#AABBCC",
          opacity: 0.5,
          roughness: 0.25,
          metallic: 0.75,
          emissive: 1,
        },
      ],
    });
    expect(document.revision).toBe(7);
    expect(document.metadata).toEqual({ title: "kept" });
    expect(document.materials[materialId(12)]?.color).toBe("#aabbcc");
  });

  it("canonicalizes negative zero, rotation signs, and colors", () => {
    const document = createDocument({
      ...minimalInput(),
      nodes: [
        {
          nodeId: nodeId("node:test:root"),
          parentId: null,
          children: [],
          transform: {
            translation: [-0, 0, 0],
            pivot: [0, 0, 0],
            rotation: [0, 0, 0, -1],
            scale: [1, 1, 1],
          },
          components: [],
        },
      ],
    });
    const root = document.nodes[nodeId("node:test:root")] as SceneNode;
    expect(Object.is(root.transform.translation[0], 0)).toBe(true);
    expect(root.transform.rotation).toEqual([0, 0, 0, 1]);
  });

  it("returns a deeply frozen document with no mutable backing data", () => {
    const document = createDocument({
      ...minimalInput(),
      metadata: { nested: { list: [1, 2, 3] } },
      materials: [
        {
          materialId: materialId(1),
          name: "m",
          color: "#ffffff",
          opacity: 1,
          roughness: 0,
          metallic: 0,
          emissive: 0,
        },
      ],
    });
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.nodes)).toBe(true);
    expect(Object.isFrozen(document.metadata)).toBe(true);
    expect(Object.isFrozen(document.metadata.nested)).toBe(true);
    expect(Object.isFrozen(document.materials)).toBe(true);
    expect(Object.isFrozen(document.materials[materialId(1)])).toBe(true);
    const root = document.nodes[nodeId("node:test:root")] as SceneNode;
    expect(Object.isFrozen(root.transform.translation)).toBe(true);
    expect(() => {
      (root as { name?: string }).name = "mutated";
    }).toThrow(TypeError);
  });

  it("does not alias caller-owned arrays or objects", () => {
    const children = [nodeId("node:test:child")];
    const metadata = { list: [1] };
    const document = createDocument({
      documentId: documentId("document:test:0001"),
      rootNodeId: nodeId("node:test:root"),
      nodes: [
        {
          nodeId: nodeId("node:test:root"),
          parentId: null,
          children,
          transform: identity,
          components: [],
          metadata,
        },
        {
          nodeId: nodeId("node:test:child"),
          parentId: nodeId("node:test:root"),
          children: [],
          transform: identity,
          components: [],
        },
      ],
    });
    children.push(nodeId("node:test:extra"));
    (metadata as { list: number[] }).list.push(2);
    expect(
      (document.nodes[nodeId("node:test:root")] as SceneNode).children,
    ).toEqual([nodeId("node:test:child")]);
    expect(document.metadata).toEqual({});
    expect(
      (document.nodes[nodeId("node:test:root")] as SceneNode).metadata,
    ).toEqual({
      list: [1],
    });
  });

  it("rejects duplicate identifiers in input arrays", () => {
    const input = {
      ...minimalInput(),
      nodes: [
        {
          nodeId: nodeId("node:test:root"),
          parentId: null,
          children: [],
          transform: identity,
          components: [],
        },
        {
          nodeId: nodeId("node:test:root"),
          parentId: null,
          children: [],
          transform: identity,
          components: [],
        },
      ],
    };
    expect(() => createDocument(input)).toThrow(/Duplicate node identifier/u);
    expect(() =>
      createDocument({
        ...minimalInput(),
        materials: [
          {
            materialId: materialId(1),
            name: "a",
            color: "#ffffff",
            opacity: 1,
            roughness: 0,
            metallic: 0,
            emissive: 0,
          },
          {
            materialId: materialId(1),
            name: "b",
            color: "#000000",
            opacity: 1,
            roughness: 0,
            metallic: 0,
            emissive: 0,
          },
        ],
      }),
    ).toThrow(/Duplicate material identifier/u);
  });

  it("rejects invalid hierarchy, references, and values with stable errors", () => {
    expect(() =>
      createDocument({
        documentId: documentId("document:test:0001"),
        rootNodeId: nodeId("node:test:missing"),
        nodes: [
          {
            nodeId: nodeId("node:test:root"),
            parentId: null,
            children: [],
            transform: identity,
            components: [],
          },
        ],
      }),
    ).toThrow(/root node does not exist/u);
    expect(() =>
      createDocument({
        ...minimalInput(),
        nodes: [
          {
            nodeId: nodeId("node:test:root"),
            parentId: null,
            children: [],
            transform: { ...identity, scale: [1, 0, 1] },
            components: [],
          },
        ],
      }),
    ).toThrow(/strictly positive/u);
    expect(() =>
      createDocument({
        ...minimalInput(),
        nodes: [
          {
            nodeId: nodeId("node:test:root"),
            parentId: null,
            children: [],
            transform: identity,
            components: [
              {
                kind: "voxel",
                schemaVersion: 1,
                volumeId: volumeId("volume:test:missing"),
              },
            ],
          },
        ],
      }),
    ).toThrow(/unknown volume/u);
  });

  it("accepts IDs that collide with object prototype member names", () => {
    const document = createDocument({
      documentId: documentId("document:test:0001"),
      rootNodeId: nodeId("toString"),
      nodes: [
        {
          nodeId: nodeId("toString"),
          parentId: null,
          children: [nodeId("constructor")],
          transform: identity,
          components: [],
        },
        {
          nodeId: nodeId("constructor"),
          parentId: nodeId("toString"),
          children: [],
          transform: identity,
          components: [],
        },
      ],
    });
    expect(document.nodes[nodeId("toString")]?.children).toEqual([
      nodeId("constructor"),
    ]);
    expect(canonicalDocumentJson(document)).toContain('"toString"');
  });

  it("clones a document without aliasing or changing its identity", () => {
    const document = createDocument({
      ...minimalInput(),
      metadata: { nested: { value: 1 } },
      animations: [
        {
          animationId: animationId("animation:test:clip"),
          duration: 1,
          loop: "once",
          tracks: [
            {
              trackId: trackId("track:test:move"),
              targetNodeId: nodeId("node:test:root"),
              interpolation: "linear",
              keyframes: [
                {
                  keyframeId: keyframeId("keyframe:test:0"),
                  time: 0,
                  property: { channel: "translation", value: [0, 0, 0] },
                },
              ],
            },
          ],
        },
      ],
    });
    const clone = cloneDocument(document);
    expect(clone).not.toBe(document);
    expect(clone).not.toBe(document.nodes);
    expect(canonicalDocumentHash(clone)).toBe(canonicalDocumentHash(document));
    expect(canonicalDocumentJson(clone)).toBe(canonicalDocumentJson(document));
    expect(Object.isFrozen(clone)).toBe(true);
    expect(Object.isFrozen(clone.metadata)).toBe(true);
  });

  it("round-trips animation descriptors through the factory", () => {
    const document = createDocument({
      ...minimalInput(),
      animations: [
        {
          animationId: animationId("animation:test:clip"),
          name: "Clip",
          duration: 2.5,
          loop: "loop",
          tracks: [
            {
              trackId: trackId("track:test:move"),
              targetNodeId: nodeId("node:test:root"),
              interpolation: "linear",
              keyframes: [
                {
                  keyframeId: keyframeId("keyframe:test:0"),
                  time: 0,
                  property: { channel: "translation", value: [0, 0, 0] },
                },
                {
                  keyframeId: keyframeId("keyframe:test:1"),
                  time: 2.5,
                  property: { channel: "translation", value: [1, 0, 0] },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(canonicalDocumentJson(document)).toContain('"loop":"loop"');
    expect(
      (
        document.animations[
          animationId("animation:test:clip")
        ] as AnimationDescriptor
      ).duration,
    ).toBe(2.5);
  });
});
