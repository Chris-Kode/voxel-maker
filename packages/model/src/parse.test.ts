import { describe, expect, it } from "vitest";
import {
  WorkspaceError,
  animationId,
  documentId,
  materialId,
  nodeId,
  trackId,
  volumeId,
} from "@voxel-maker/shared";
import type { SceneNode } from "./types.js";
import {
  canonicalDocumentHash,
  canonicalDocumentJson,
  createDocument,
  parseDocument,
} from "./index.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function sampleDocument() {
  return createDocument({
    documentId: documentId("document:parse:0001"),
    metadata: { note: "round trip" },
    rootNodeId: nodeId("node:parse:root"),
    nodes: [
      {
        nodeId: nodeId("node:parse:root"),
        parentId: null,
        children: [nodeId("node:parse:leaf")],
        transform: identity,
        components: [],
      },
      {
        nodeId: nodeId("node:parse:leaf"),
        parentId: nodeId("node:parse:root"),
        children: [],
        transform: {
          translation: [2, -3, 0.5],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:parse:0001"),
          },
        ],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "m",
        color: "#abcdef",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [{ volumeId: volumeId("volume:parse:0001") }],
  });
}

function expectWorkspaceError(
  run: () => unknown,
  code: string,
): WorkspaceError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError);
    const workspaceError = error as WorkspaceError;
    expect(workspaceError.code).toBe(code);
    return workspaceError;
  }
  throw new Error(`Expected ${code} to be thrown`);
}

describe("parseDocument", () => {
  it("reloads a serialized document with identical hash and frozen state", () => {
    const document = sampleDocument();
    const serialized = canonicalDocumentJson(document);
    const reloaded = parseDocument(serialized);
    expect(canonicalDocumentHash(reloaded)).toBe(
      canonicalDocumentHash(document),
    );
    expect(canonicalDocumentJson(reloaded)).toBe(serialized);
    expect(Object.isFrozen(reloaded)).toBe(true);
    expect(Object.isFrozen(reloaded.nodes)).toBe(true);
    expect(
      Object.isFrozen(
        (reloaded.nodes[nodeId("node:parse:leaf")] as SceneNode).transform,
      ),
    ).toBe(true);
    expect(() => {
      (reloaded as { revision: number }).revision = 99;
    }).toThrow(TypeError);
  });

  it("rejects malformed JSON with a stable code", () => {
    const error = expectWorkspaceError(
      () => parseDocument("{not json"),
      "INVALID_JSON",
    );
    expect(error.family).toBe("validation");
  });

  it("rejects unknown future schema versions with a compatibility error", () => {
    const document = sampleDocument();
    const serialized = canonicalDocumentJson(document);
    const future = serialized.replace(
      '"documentSchemaVersion":1',
      '"documentSchemaVersion":2',
    );
    const error = expectWorkspaceError(
      () => parseDocument(future),
      "UNSUPPORTED_DOCUMENT_VERSION",
    );
    expect(error.family).toBe("compatibility");
    expect(error.message).toMatch(/refusing to guess/u);
  });

  it("rejects unknown top-level fields", () => {
    const serialized = canonicalDocumentJson(sampleDocument());
    const withUnknown = serialized.replace(
      '"documentId"',
      '"surprise":true,"documentId"',
    );
    const error = expectWorkspaceError(
      () => parseDocument(withUnknown),
      "UNKNOWN_FIELD",
    );
    expect(error.path).toEqual(["surprise"]);
  });

  it("rejects serialized negative zero", () => {
    const serialized = canonicalDocumentJson(sampleDocument());
    const withNegativeZero = serialized.replace(
      '"translation":[2,-3,0.5]',
      '"translation":[-0,-3,0.5]',
    );
    const error = expectWorkspaceError(
      () => parseDocument(withNegativeZero),
      "INVALID_CANONICAL_NUMBER",
    );
    expect(error.path).toEqual([
      "nodes",
      "node:parse:leaf",
      "transform",
      "translation",
      0,
    ]);
  });

  it("rejects referential failures with paths", () => {
    const serialized = canonicalDocumentJson(sampleDocument());
    const broken = serialized.replace(
      '"parentId":"node:parse:root"',
      '"parentId":"node:parse:ghost"',
    );
    const error = expectWorkspaceError(
      () => parseDocument(broken),
      "MISSING_REFERENCE",
    );
    expect(error.path).toEqual(["nodes", "node:parse:leaf", "parentId"]);
  });

  it("rebuilds ID-keyed records as null-prototype maps (issue #103)", () => {
    const reloaded = parseDocument(canonicalDocumentJson(sampleDocument()));
    for (const record of [
      reloaded.nodes,
      reloaded.materials,
      reloaded.volumes,
      reloaded.animations,
    ]) {
      expect(Object.getPrototypeOf(record)).toBeNull();
    }
    // Absent caller-supplied IDs that collide with Object.prototype member
    // names must resolve as absent instead of leaking inherited members.
    const nodes = reloaded.nodes as Record<string, unknown>;
    expect(nodes["toString"]).toBeUndefined();
    expect(nodes["constructor"]).toBeUndefined();
    expect(nodes["__proto__"]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(nodes, "toString")).toBe(false);
  });

  it("round-trips records whose own IDs collide with prototype member names (issue #103)", () => {
    const document = createDocument({
      documentId: documentId("document:parse:prototype"),
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
      volumes: [
        { volumeId: volumeId("__proto__") },
        { volumeId: volumeId("constructor") },
      ],
      animations: [
        {
          animationId: animationId("toString"),
          duration: 1,
          loop: "once",
          tracks: [
            {
              trackId: trackId("track:parse:prototype"),
              targetNodeId: nodeId("toString"),
              interpolation: "linear",
              keyframes: [],
            },
          ],
        },
      ],
    });
    const serialized = canonicalDocumentJson(document);
    const reloaded = parseDocument(serialized);
    expect(canonicalDocumentHash(reloaded)).toBe(
      canonicalDocumentHash(document),
    );
    expect(reloaded.nodes[nodeId("toString")]?.children).toEqual([
      nodeId("constructor"),
    ]);
    expect(
      Object.prototype.hasOwnProperty.call(reloaded.nodes, "constructor"),
    ).toBe(true);
    expect(reloaded.volumes[volumeId("__proto__")]?.volumeId).toBe(
      volumeId("__proto__"),
    );
    expect(
      reloaded.animations[animationId("toString")]?.tracks[0]?.targetNodeId,
    ).toBe(nodeId("toString"));
  });
});
