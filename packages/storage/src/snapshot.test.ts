import { describe, expect, it } from "vitest";
import {
  canonicalAssetSemanticHash,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import { volumeId, type VolumeId } from "@voxel-maker/shared";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import { captureRevisionSnapshot } from "./snapshot.js";
import { commitVoxel, createStore, VOLUME } from "./test-helpers.js";

function liveHash(store: DocumentStoreRead): string {
  const volumes = new Map<VolumeId, VoxelVolumeReadView>();
  const view = store.getVolume(VOLUME);
  if (view !== undefined) volumes.set(VOLUME, view);
  return canonicalAssetSemanticHash(store.getDocument(), volumes);
}

describe("captureRevisionSnapshot", () => {
  it("captures the committed revision, hash, document, and volume views", () => {
    const { store } = createStore();
    const snapshot = captureRevisionSnapshot(store);
    expect(snapshot.revision).toBe(0);
    expect(snapshot.semanticHash).toBe(liveHash(store));
    expect(snapshot.document).toBe(store.getDocument());
    expect(snapshot.volumes.get(VOLUME)).toBe(store.getVolume(VOLUME));
  });

  it("retains an immutable snapshot while later edits proceed", () => {
    const { store, writeCapability } = createStore();
    const snapshot = captureRevisionSnapshot(store);
    const documentBefore = store.getDocument();
    const viewBefore = store.getVolume(VOLUME);
    const hashBefore = snapshot.semanticHash;

    commitVoxel(store, writeCapability, [0, 0, 0], 1);
    expect(store.revision).toBe(1);
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(1);

    // The retained objects are the committed ones and never mutate.
    expect(snapshot.revision).toBe(0);
    expect(snapshot.document).toBe(documentBefore);
    expect(snapshot.document.revision).toBe(0);
    expect(snapshot.volumes.get(VOLUME)).toBe(viewBefore);
    expect(snapshot.volumes.get(VOLUME)?.getVoxel([0, 0, 0])).toBe(0);
    expect(snapshot.semanticHash).toBe(hashBefore);
    expect(snapshot.semanticHash).not.toBe(liveHash(store));
  });

  it("covers every document volume in the canonical hash", () => {
    const { store } = createStore();
    const snapshot = captureRevisionSnapshot(store);
    expect(snapshot.volumes.size).toBe(
      Object.keys(store.getDocument().volumes).length,
    );
    for (const volumeIdText of Object.keys(store.getDocument().volumes)) {
      expect(snapshot.volumes.has(volumeId(volumeIdText))).toBe(true);
    }
  });
});
