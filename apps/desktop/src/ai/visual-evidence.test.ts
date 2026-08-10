import { describe, expect, it } from "vitest";
import { STANDARD_VIEWS } from "@voxel-maker/agent";
import { STANDARD_PREVIEW_VIEWS } from "@voxel-maker/renderer";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { validateEvidenceSet } from "@voxel-maker/agent";
import {
  createDocumentStoreHandle,
  type DocumentStore,
} from "@voxel-maker/document/internal";
import { createRendererEvidenceCapture } from "./visual-evidence.js";

/**
 * Renderer-backed evidence capture tests (ticket #40): the desktop
 * adapter renders the fixed standard views through the deterministic
 * preview renderer, encodes bounded PNG bytes, and ties every image to
 * the exact store revision and canonical semantic hash.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function smallFixture(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:evidence:0001"),
    metadata: { title: "evidence" },
    rootNodeId: nodeId("node:root"),
    nodes: [
      {
        nodeId: nodeId("node:root"),
        name: "Root",
        parentId: null,
        children: [],
        transform: IDENTITY,
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: volumeId("volume:box") },
        ],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "box",
        color: "#ff8800",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: volumeId("volume:box"),
        bounds: { min: [0, 0, 0], max: [4, 4, 4] },
      },
    ],
  });
}

function populatedStore(): DocumentStore {
  const handle = createDocumentStoreHandle({ document: smallFixture() });
  const { store, writeCapability } = handle;
  const staged = store.stageVolume(volumeId("volume:box"));
  if (staged === undefined) throw new Error("fixture volume missing");
  for (let x = 0; x < 4; x += 1) {
    for (let y = 0; y < 4; y += 1) {
      for (let z = 0; z < 4; z += 1) {
        staged.setVoxel([x, y, z], materialId(1), writeCapability);
      }
    }
  }
  const document = {
    ...store.getDocument(),
    revision: store.revision + 1,
  };
  store.commit(
    {
      document,
      volumes: new Map([[volumeId("volume:box"), staged]]),
      removedVolumes: [],
    },
    {
      revisionBefore: 0,
      revisionAfter: 1,
      transactionId: transactionId("transaction:evidence:seed"),
      source: "system",
      commandIds: [commandId("command:evidence:seed")],
      commandTypes: ["seedFixtureVoxels"],
      changedNodeIds: [],
      changedMaterialIds: [],
      changedAnimationIds: [],
      changedVolumes: [
        {
          volumeId: volumeId("volume:box"),
          chunks: [],
          bounds: { min: [0, 0, 0], max: [16, 16, 16] },
        },
      ],
      label: "seed",
    },
    writeCapability,
  );
  return store;
}

describe("createRendererEvidenceCapture", () => {
  it("renders the four standard views as bounded PNG evidence of one revision", () => {
    const store = populatedStore();
    const capture = createRendererEvidenceCapture();
    const set = validateEvidenceSet(
      capture.captureEvidence({
        store,
        source: "live",
        width: 8,
        height: 8,
      }),
    );
    expect(set.images).toHaveLength(4);
    expect(set.revision).toBe(1);
    expect(set.documentId).toBe(documentId("document:evidence:0001"));
    for (const image of set.images) {
      // PNG signature + bounded size + metadata consistency.
      expect(image.pngBytes[0]).toBe(0x89);
      expect(image.pngBytes[1]).toBe(0x50);
      expect(image.pngBytes[2]).toBe(0x4e);
      expect(image.pngBytes[3]).toBe(0x47);
      expect(image.pngBytes.byteLength).toBeLessThan(4096);
      expect(image.revision).toBe(1);
      expect(image.semanticHash).toBe(set.semanticHash);
      expect(image.source).toBe("live");
      expect(image.width).toBe(8);
      expect(image.height).toBe(8);
    }
    // Deterministic: the same store and spec produce identical bytes.
    const again = capture.captureEvidence({
      store,
      source: "live",
      width: 8,
      height: 8,
    });
    expect(again.images.map((image) => [...image.pngBytes])).toEqual(
      set.images.map((image) => [...image.pngBytes]),
    );
  });

  it("captures staged preview evidence under the preview session id", () => {
    const store = populatedStore();
    const capture = createRendererEvidenceCapture();
    const set = capture.captureEvidence({
      store,
      source: "preview",
      sessionId: "preview:evidence:test",
      width: 4,
      height: 4,
      views: ["perspective", "top"],
    });
    expect(set.source).toBe("preview");
    expect(set.sessionId).toBe("preview:evidence:test");
    expect(set.images.map((image) => image.view)).toEqual([
      "perspective",
      "top",
    ]);
    for (const image of set.images) {
      expect(image.source).toBe("preview");
      expect(image.sessionId).toBe("preview:evidence:test");
    }
  });

  it("is a pure read: capturing never mutates the store", () => {
    const store = populatedStore();
    const before = store.revision;
    createRendererEvidenceCapture().captureEvidence({
      store,
      source: "live",
      width: 4,
      height: 4,
    });
    expect(store.revision).toBe(before);
  });
});

describe("standard-view seam conformance (ticket #40)", () => {
  it("pins the agent evidence views to the renderer preview protocol", () => {
    // The agent package cannot import the renderer; the composition
    // adapter bridges the two vocabularies with a cast. This test keeps
    // that cast honest: the fixed render protocol and the evidence
    // protocol must name the same four views in the same order.
    expect([...STANDARD_VIEWS]).toEqual([...STANDARD_PREVIEW_VIEWS]);
  });
});
