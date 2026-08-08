import { describe, expect, it } from "vitest";
import { readVxlProject } from "@voxel-maker/formats";
import { createVxlProjectEncoder } from "./encoder.js";
import { captureRevisionSnapshot } from "./snapshot.js";
import { createStore, VOLUME } from "./test-helpers.js";

describe("createVxlProjectEncoder", () => {
  it("encodes a snapshot into a container the native reader accepts with the captured hash", () => {
    const { store } = createStore();
    const encoder = createVxlProjectEncoder();
    const snapshot = captureRevisionSnapshot(store);
    const bytes = encoder.encodeProject(snapshot) as Uint8Array;
    const loaded = readVxlProject(bytes);
    expect(loaded.semanticHash).toBe(snapshot.semanticHash);
    expect(loaded.document.documentId).toBe("document:storage:0001");
    expect(loaded.document.revision).toBe(0);
    expect(loaded.volumes.get(VOLUME)?.chunks).toHaveLength(0);
  });

  it("produces byte-stable output for the same snapshot", () => {
    const { store } = createStore();
    const encoder = createVxlProjectEncoder();
    const snapshot = captureRevisionSnapshot(store);
    const first = encoder.encodeProject(snapshot) as Uint8Array;
    const second = encoder.encodeProject(snapshot) as Uint8Array;
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });
});
