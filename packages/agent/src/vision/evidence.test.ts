import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import { createInspectionStore } from "../fixtures.js";
import {
  DEFAULT_EVIDENCE_SIZE,
  MAX_EVIDENCE_DIMENSION,
  MAX_EVIDENCE_IMAGES,
  STANDARD_VIEWS,
  buildEvidenceSet,
  maxPngBytes,
  validateEvidenceRequest,
  validateEvidenceSet,
} from "./evidence.js";
import { createFakeEvidenceCapture } from "./test-fixtures.js";

/**
 * Visual evidence tests (plan S15.1/S15.2, ticket #40): the fixed
 * standard-view protocol is validated and bounded before any render or
 * transmission, and every evidence set is tied to the exact live or
 * preview revision and semantic hash it was rendered from.
 */

describe("evidence capture requests", () => {
  it("defaults to the four standard views and the default size", () => {
    const { handle } = createInspectionStore();
    const request = validateEvidenceRequest({
      store: handle.store,
      source: "live",
    });
    expect(request.views).toEqual(STANDARD_VIEWS);
    expect(request.width).toBe(DEFAULT_EVIDENCE_SIZE);
    expect(request.height).toBe(DEFAULT_EVIDENCE_SIZE);
    expect(request.source).toBe("live");
  });

  it("rejects unknown, repeated, or empty views", () => {
    const { handle } = createInspectionStore();
    for (const views of [
      [],
      ["perspective", "north"],
      ["front", "front"],
      ["perspective", "front", "side", "top", "front"],
    ]) {
      expect(() =>
        validateEvidenceRequest({
          store: handle.store,
          source: "live",
          views: views as never,
        }),
      ).toThrow(WorkspaceError);
    }
  });

  it("rejects zero, non-integer, and oversized dimensions", () => {
    const { handle } = createInspectionStore();
    for (const size of [0, -4, 1.5, MAX_EVIDENCE_DIMENSION + 1]) {
      expect(() =>
        validateEvidenceRequest({
          store: handle.store,
          source: "live",
          width: size as never,
          height: size as never,
        }),
      ).toThrow(WorkspaceError);
    }
  });

  it("rejects unbounded session ids", () => {
    const { handle } = createInspectionStore();
    expect(() =>
      validateEvidenceRequest({
        store: handle.store,
        source: "preview",
        sessionId: "x".repeat(129),
      }),
    ).toThrow(WorkspaceError);
  });
});

describe("evidence sets", () => {
  it("captures the four standard views tied to one revision and hash", () => {
    const { handle } = createInspectionStore();
    const capture = createFakeEvidenceCapture();
    const set = validateEvidenceSet(
      capture.captureEvidence({
        store: handle.store,
        source: "live",
        sessionId: undefined,
      }),
    );
    expect(set.images.map((image) => image.view)).toEqual(STANDARD_VIEWS);
    expect(set.revision).toBe(handle.store.revision);
    expect(set.documentId).toBe(handle.store.getDocument().documentId);
    for (const image of set.images) {
      expect(image.revision).toBe(set.revision);
      expect(image.semanticHash).toBe(set.semanticHash);
      expect(image.source).toBe("live");
    }
    expect(set.totalPngBytes).toBeGreaterThan(0);
  });

  it("marks preview evidence with the session id", () => {
    const { handle } = createInspectionStore();
    const capture = createFakeEvidenceCapture();
    const set = validateEvidenceSet(
      capture.captureEvidence({
        store: handle.store,
        source: "preview",
        sessionId: "preview:abc",
      }),
    );
    expect(set.source).toBe("preview");
    expect(set.sessionId).toBe("preview:abc");
    for (const image of set.images) {
      expect(image.source).toBe("preview");
      expect(image.sessionId).toBe("preview:abc");
    }
  });

  it("rejects images that are oversized or cross-revision", () => {
    const { handle } = createInspectionStore();
    const capture = createFakeEvidenceCapture();
    const base = capture.captureEvidence({
      store: handle.store,
      source: "live",
    });
    const image = base.images[0];
    if (image === undefined) throw new Error("expected an image");
    expect(() =>
      validateEvidenceSet({
        documentId: base.documentId,
        revision: base.revision,
        semanticHash: base.semanticHash,
        source: base.source,
        images: [{ ...image, pngBytes: new Uint8Array(10_000_000) }],
        totalPngBytes: 0,
      }),
    ).toThrow(WorkspaceError);
    expect(() =>
      validateEvidenceSet({
        documentId: base.documentId,
        revision: base.revision + 1,
        semanticHash: base.semanticHash,
        source: base.source,
        images: base.images,
        totalPngBytes: 0,
      }),
    ).toThrow(WorkspaceError);
    expect(() =>
      validateEvidenceSet({
        documentId: base.documentId,
        revision: base.revision,
        semanticHash: "different-hash",
        source: base.source,
        images: base.images,
        totalPngBytes: 0,
      }),
    ).toThrow(WorkspaceError);
  });

  it("rejects empty, duplicate-view, and mismatched-source sets", () => {
    const { handle } = createInspectionStore();
    const capture = createFakeEvidenceCapture();
    const base = capture.captureEvidence({
      store: handle.store,
      source: "live",
    });
    expect(() =>
      validateEvidenceSet({
        documentId: base.documentId,
        revision: base.revision,
        semanticHash: base.semanticHash,
        source: base.source,
        images: [],
        totalPngBytes: 0,
      }),
    ).toThrow(WorkspaceError);
    const duplicated = [...base.images, base.images[0]];
    if (duplicated[4] === undefined) throw new Error("expected image");
    expect(() =>
      validateEvidenceSet({
        documentId: base.documentId,
        revision: base.revision,
        semanticHash: base.semanticHash,
        source: base.source,
        images: duplicated,
        totalPngBytes: 0,
      }),
    ).toThrow(WorkspaceError);
    expect(() =>
      validateEvidenceSet({
        documentId: base.documentId,
        revision: base.revision,
        semanticHash: base.semanticHash,
        source: "preview",
        images: base.images,
        totalPngBytes: 0,
      }),
    ).toThrow(WorkspaceError);
  });

  it("bounds the expected PNG byte size per image", () => {
    expect(maxPngBytes(1, 1)).toBe(4 + 1 + 8192);
    expect(maxPngBytes(MAX_EVIDENCE_DIMENSION, MAX_EVIDENCE_DIMENSION)).toBe(
      MAX_EVIDENCE_DIMENSION * MAX_EVIDENCE_DIMENSION * 4 +
        MAX_EVIDENCE_DIMENSION +
        8192,
    );
  });

  it("builds frozen sets and enforces the image-count bound", () => {
    const { handle } = createInspectionStore();
    const set = buildEvidenceSet({
      documentId: handle.store.getDocument().documentId,
      revision: 1,
      semanticHash: "h",
      source: "live",
      images: [
        {
          view: "front",
          width: 2,
          height: 2,
          pngBytes: new Uint8Array(2 * 2 * 4),
          revision: 1,
          semanticHash: "h",
          source: "live",
        },
      ],
    });
    expect(set.totalPngBytes).toBe(16);
    expect(set.images.length).toBe(1);
    expect(Object.isFrozen(set.images)).toBe(true);
    expect(MAX_EVIDENCE_IMAGES).toBe(STANDARD_VIEWS.length);
  });
});
