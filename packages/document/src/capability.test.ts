import { describe, expect, it } from "vitest";
import { documentId, materialId, nodeId, volumeId } from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { createDocumentStore, type DocumentStoreRead } from "./index.js";

/**
 * Issue #91 regression: the public package entrypoint must never expose the
 * write capability or the mutable store. A consumer can persist a staged
 * edit only through `CommandBus.execute`; the bypass (factory returning
 * `writeCapability` plus a store exposing `stageVolume`/`commit`) is
 * impossible through package exports.
 */

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function fixture(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:capability:0001"),
    metadata: { title: "capability regression", tags: [] },
    rootNodeId: nodeId("node:capability:root"),
    nodes: [
      {
        nodeId: nodeId("node:capability:root"),
        name: "Root",
        parentId: null,
        children: [],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:capability:0001"),
          },
        ],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "demo",
        color: "#ff8800",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: volumeId("volume:capability:0001"),
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    ],
  });
}

describe("public store factory capability surface (issue #91)", () => {
  it("returns the read surface, not a mutable store or capability handle", () => {
    const store = createDocumentStore({ document: fixture() });
    expect(store.revision).toBe(0);
    expect(store.getDocument().documentId).toBe("document:capability:0001");
    // The issue's bypass: stageVolume(...).setVoxel(...) then commit(...)
    // must be unreachable through the public factory result.
    expect(store).not.toHaveProperty("stageVolume");
    expect(store).not.toHaveProperty("commit");
    expect(store).not.toHaveProperty("writeCapability");
  });

  it("does not export the mutation factory or capability from the entrypoint", async () => {
    const api = (await import("./index.js")) as Record<string, unknown>;
    expect(api.createDocumentStoreHandle).toBeUndefined();
    expect(api.writeCapability).toBeUndefined();
  });

  it("types the factory result as the immutable read surface", () => {
    const store: DocumentStoreRead = createDocumentStore({
      document: fixture(),
    });
    // Compile-time regression guards: if the public type ever regrows
    // mutation members, these @ts-expect-error annotations become unused
    // and the package typecheck fails.
    // @ts-expect-error the public read surface has no stageVolume
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    store.stageVolume;
    // @ts-expect-error the public read surface has no commit
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    store.commit;
    expect(store.revision).toBe(0);
  });

  it("leaves revision untouched when the bypass is attempted", () => {
    const store = createDocumentStore({ document: fixture() });
    const attempted = store as unknown as {
      stageVolume?: (volumeId: unknown) => unknown;
      commit?: (...args: unknown[]) => unknown;
    };
    expect(attempted.stageVolume).toBeUndefined();
    expect(attempted.commit).toBeUndefined();
    expect(store.revision).toBe(0);
    expect(store.getVoxel(volumeId("volume:capability:0001"), [0, 0, 0])).toBe(
      0,
    );
  });
});
