import { describe, expect, it } from "vitest";
import {
  canonicalDocumentHash,
  canonicalDocumentJson,
  canonicalSemanticBytes,
  createDocument,
  parseDocument,
  validateDocument,
} from "./index.js";
import {
  createAbstractFixture,
  createHouseFixture,
  createVehicleFixture,
} from "./fixtures.js";
import {
  animationId,
  documentId,
  keyframeId,
  materialId,
  nodeId,
  trackId,
  volumeId,
} from "@voxel-maker/shared";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function baseDocument() {
  return createDocument({
    documentId: documentId("document:canonical:0001"),
    rootNodeId: nodeId("node:canonical:root"),
    nodes: [
      {
        nodeId: nodeId("node:canonical:root"),
        parentId: null,
        children: [nodeId("node:canonical:a")],
        transform: identity,
        components: [],
      },
      {
        nodeId: nodeId("node:canonical:a"),
        parentId: nodeId("node:canonical:root"),
        children: [],
        transform: identity,
        components: [],
      },
    ],
  });
}

describe("canonicalDocumentJson", () => {
  it("serializes the same document byte-identically every time", () => {
    const document = baseDocument();
    expect(canonicalDocumentJson(document)).toBe(
      canonicalDocumentJson(document),
    );
    expect(canonicalDocumentJson(document)).toBe(
      canonicalDocumentJson(baseDocument()),
    );
  });

  it("is independent of record insertion order", () => {
    const first = createDocument({
      documentId: documentId("document:canonical:0001"),
      rootNodeId: nodeId("node:canonical:root"),
      nodes: [
        {
          nodeId: nodeId("node:canonical:b"),
          parentId: nodeId("node:canonical:root"),
          children: [],
          transform: identity,
          components: [],
        },
        {
          nodeId: nodeId("node:canonical:root"),
          parentId: null,
          children: [nodeId("node:canonical:a"), nodeId("node:canonical:b")],
          transform: identity,
          components: [],
        },
        {
          nodeId: nodeId("node:canonical:a"),
          parentId: nodeId("node:canonical:root"),
          children: [],
          transform: identity,
          components: [],
        },
      ],
    });
    const second = createDocument({
      documentId: documentId("document:canonical:0001"),
      rootNodeId: nodeId("node:canonical:root"),
      nodes: [
        {
          nodeId: nodeId("node:canonical:root"),
          parentId: null,
          children: [nodeId("node:canonical:a"), nodeId("node:canonical:b")],
          transform: identity,
          components: [],
        },
        {
          nodeId: nodeId("node:canonical:a"),
          parentId: nodeId("node:canonical:root"),
          children: [],
          transform: identity,
          components: [],
        },
        {
          nodeId: nodeId("node:canonical:b"),
          parentId: nodeId("node:canonical:root"),
          children: [],
          transform: identity,
          components: [],
        },
      ],
    });
    expect(canonicalDocumentJson(first)).toBe(canonicalDocumentJson(second));
  });

  it("sorts material records numerically and other records by code unit", () => {
    const document = createDocument({
      documentId: documentId("document:canonical:0001"),
      rootNodeId: nodeId("node:canonical:root"),
      nodes: [
        {
          nodeId: nodeId("node:canonical:root"),
          parentId: null,
          children: [],
          transform: identity,
          components: [],
        },
      ],
      materials: [
        {
          materialId: materialId(10),
          name: "ten",
          color: "#111111",
          opacity: 1,
          roughness: 0,
          metallic: 0,
          emissive: 0,
        },
        {
          materialId: materialId(2),
          name: "two",
          color: "#222222",
          opacity: 1,
          roughness: 0,
          metallic: 0,
          emissive: 0,
        },
      ],
      volumes: [
        { volumeId: volumeId("volume:canonical:z") },
        { volumeId: volumeId("volume:canonical:a") },
      ],
    });
    const serialized = canonicalDocumentJson(document);
    expect(serialized.indexOf('"2":')).toBeLessThan(
      serialized.indexOf('"10":'),
    );
    expect(serialized.indexOf('"volume:canonical:a"')).toBeLessThan(
      serialized.indexOf('"volume:canonical:z"'),
    );
  });

  it("omits absent optional fields and preserves schema order elsewhere", () => {
    const serialized = canonicalDocumentJson(baseDocument());
    expect(serialized).not.toContain('"name"');
    // metadata appears exactly once, at the document level
    expect(serialized.match(/"metadata"/gu)).toHaveLength(1);
    expect(serialized).toContain('"parentId":null');
    expect(serialized).toMatch(/^\{/u);
    expect(serialized).toContain('"documentSchemaVersion":1');
    expect(serialized).toContain('"revision":0');
  });

  it("matches the frozen golden bytes for a fixed document", () => {
    const document = createDocument({
      documentId: documentId("document:golden:0001"),
      revision: 3,
      metadata: { b: 2, a: [1, 2] },
      rootNodeId: nodeId("node:golden:root"),
      nodes: [
        {
          nodeId: nodeId("node:golden:root"),
          parentId: null,
          children: [],
          transform: {
            translation: [1.5, -0, 0],
            pivot: [0, 0, 0],
            rotation: [0.7071067811865475, 0, 0, 0.7071067811865475],
            scale: [1, 2, 3],
          },
          components: [
            {
              kind: "voxel",
              schemaVersion: 1,
              volumeId: volumeId("volume:golden:0001"),
            },
            { kind: "joint", schemaVersion: 1 },
          ],
        },
      ],
      volumes: [{ volumeId: volumeId("volume:golden:0001") }],
    });
    expect(canonicalDocumentJson(document)).toBe(
      '{"animations":{},"documentId":"document:golden:0001","documentSchemaVersion":1,"materials":{},"metadata":{"a":[1,2],"b":2},"nodes":{"node:golden:root":{"children":[],"components":[{"kind":"voxel","schemaVersion":1,"volumeId":"volume:golden:0001"},{"kind":"joint","schemaVersion":1}],"nodeId":"node:golden:root","parentId":null,"transform":{"pivot":[0,0,0],"rotation":[0.7071067811865476,0,0,0.7071067811865476],"scale":[1,2,3],"translation":[1.5,0,0]}}},"revision":3,"rootNodeId":"node:golden:root","volumes":{"volume:golden:0001":{"volumeId":"volume:golden:0001"}}}',
    );
  });

  it("serializes the release fixtures byte-identically across runs", () => {
    for (const fixture of [
      createHouseFixture(),
      createVehicleFixture(),
      createAbstractFixture(),
    ]) {
      expect(canonicalDocumentJson(fixture)).toBe(
        canonicalDocumentJson(fixture),
      );
    }
  });
});

describe("canonicalDocumentHash", () => {
  it("is a stable 64-character SHA-256 over semantic bytes", () => {
    const document = baseDocument();
    const hash = canonicalDocumentHash(document);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).toBe(canonicalDocumentHash(baseDocument()));
  });

  it("changes when any semantic value changes", () => {
    const hash = canonicalDocumentHash(baseDocument());
    const renamed = createDocument({
      documentId: documentId("document:canonical:0001"),
      rootNodeId: nodeId("node:canonical:root"),
      nodes: [
        {
          nodeId: nodeId("node:canonical:root"),
          name: "Renamed",
          parentId: null,
          children: [nodeId("node:canonical:a")],
          transform: identity,
          components: [],
        },
        {
          nodeId: nodeId("node:canonical:a"),
          parentId: nodeId("node:canonical:root"),
          children: [],
          transform: identity,
          components: [],
        },
      ],
    });
    expect(canonicalDocumentHash(renamed)).not.toBe(hash);
    const atRevision = createDocument({
      documentId: documentId("document:canonical:0001"),
      revision: 5,
      rootNodeId: nodeId("node:canonical:root"),
      nodes: [
        {
          nodeId: nodeId("node:canonical:root"),
          parentId: null,
          children: [nodeId("node:canonical:a")],
          transform: identity,
          components: [],
        },
        {
          nodeId: nodeId("node:canonical:a"),
          parentId: nodeId("node:canonical:root"),
          children: [],
          transform: identity,
          components: [],
        },
      ],
    });
    expect(canonicalDocumentHash(atRevision)).not.toBe(hash);
  });

  it("is preserved when a document is serialized and reloaded", () => {
    const document = createVehicleFixture();
    const hash = canonicalDocumentHash(document);
    const reloaded = parseDocument(canonicalDocumentJson(document));
    expect(validateDocument(reloaded)).toEqual([]);
    expect(canonicalDocumentHash(reloaded)).toBe(hash);
    expect(canonicalDocumentJson(reloaded)).toBe(
      canonicalDocumentJson(document),
    );
  });
});

describe("canonicalSemanticBytes", () => {
  it("frames the version tag, length, and document bytes", () => {
    const document = baseDocument();
    const bytes = canonicalSemanticBytes(document);
    expect(new TextDecoder().decode(bytes.slice(0, 16))).toBe(
      "vxl-semantic-v1\n",
    );
    const length = new DataView(bytes.buffer, 16, 8).getBigUint64(0, true);
    expect(length).toBe(BigInt(bytes.byteLength - 16 - 8));
    const payload = new TextDecoder().decode(
      bytes.slice(16 + 8, 16 + 8 + Number(length)),
    );
    expect(payload).toBe(canonicalDocumentJson(document));
  });
});

describe("round-trip identity", () => {
  it("reloads every fixture to the identical canonical bytes and hash", () => {
    for (const fixture of [
      createHouseFixture(),
      createVehicleFixture(),
      createAbstractFixture(),
    ]) {
      const serialized = canonicalDocumentJson(fixture);
      const reloaded = parseDocument(serialized);
      expect(canonicalDocumentJson(reloaded)).toBe(serialized);
      expect(canonicalDocumentHash(reloaded)).toBe(
        canonicalDocumentHash(fixture),
      );
    }
  });

  it("round-trips animation descriptors exactly", () => {
    const document = createDocument({
      documentId: documentId("document:roundtrip:0001"),
      rootNodeId: nodeId("node:roundtrip:root"),
      nodes: [
        {
          nodeId: nodeId("node:roundtrip:root"),
          parentId: null,
          children: [],
          transform: identity,
          components: [],
        },
      ],
      animations: [
        {
          animationId: animationId("animation:roundtrip:clip"),
          duration: 4,
          loop: "loop",
          tracks: [
            {
              trackId: trackId("track:roundtrip:t"),
              targetNodeId: nodeId("node:roundtrip:root"),
              interpolation: "smoothstep",
              keyframes: [
                {
                  keyframeId: keyframeId("keyframe:roundtrip:0"),
                  time: 0.25,
                  property: {
                    channel: "rotation",
                    value: [0, 0.7071067811865475, 0, 0.7071067811865475],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const reloaded = parseDocument(canonicalDocumentJson(document));
    expect(
      reloaded.animations[animationId("animation:roundtrip:clip")],
    ).toEqual(document.animations[animationId("animation:roundtrip:clip")]);
  });
});
