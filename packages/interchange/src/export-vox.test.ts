import { describe, expect, it } from "vitest";
import {
  animationId,
  keyframeId,
  materialId,
  nodeId,
  trackId,
  volumeId,
  type VolumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { createDocumentStore } from "@voxel-maker/document";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";
import { parseVox } from "@voxel-maker/formats";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import { exportVox } from "./export-vox.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:export:root");
const VOLUME_A = volumeId("volume:export:a");

function exportDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:export:0001" as never,
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [nodeId("node:export:a")],
        transform: identity,
        components: [],
      },
      {
        nodeId: nodeId("node:export:a"),
        name: "Model A",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME_A }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "red",
        color: "#ff0000",
        opacity: 1,
        roughness: 0,
        metallic: 0,
        emissive: 0,
      },
      {
        materialId: materialId(2),
        name: "green",
        color: "#00ff00",
        opacity: 1,
        roughness: 0,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [{ volumeId: VOLUME_A }],
  });
}

function storeWithEntries(
  document: VoxelDocument,
  entries: readonly {
    coordinate: [number, number, number];
    material: number;
  }[],
) {
  const chunks = new Map<string, VoxelChunkSeed>();
  for (const entry of entries) {
    const [x, y, z] = entry.coordinate;
    const cx = Math.floor(x / 16);
    const cy = Math.floor(y / 16);
    const cz = Math.floor(z / 16);
    const key = `${String(cx)},${String(cy)},${String(cz)}`;
    const chunk = chunks.get(key) ?? {
      coordinate: [cx, cy, cz] as [number, number, number],
      values: new Uint16Array(4096),
    };
    const lx = ((x % 16) + 16) % 16;
    const ly = ((y % 16) + 16) % 16;
    const lz = ((z % 16) + 16) % 16;
    chunk.values[lx + 16 * (ly + 16 * lz)] = entry.material;
    chunks.set(key, chunk);
  }
  return createDocumentStore({
    document,
    volumes: new Map([[VOLUME_A, [...chunks.values()]]]),
  });
}

describe("exportVox", () => {
  it("writes a deterministic VOX file through the storage port", async () => {
    const document = exportDocument();
    const { store } = storeWithEntries(document, [
      { coordinate: [1, 2, -3], material: 1 },
      { coordinate: [4, 5, -6], material: 2 },
    ]);
    const storage = new MemoryProjectStorage();
    const first = await exportVox({
      document,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "model.vox",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.losses.some((loss) => loss.code === "VOX_LOSS_METADATA")).toBe(
      true,
    );
    const second = await exportVox({
      document,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "model.vox",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Determinism: identical bytes across calls.
    expect(second.bytes).toEqual(first.bytes);
    // The written file parses with the expected content.
    const parsed = parseVox(storage.files().get("model.vox") as Uint8Array);
    expect(parsed.models[0]?.voxels).toEqual([
      { x: 1, y: 3, z: 2, colorIndex: 1 },
      { x: 4, y: 6, z: 5, colorIndex: 2 },
    ]);
  });

  it("blocks export with a loss report and writes nothing", async () => {
    const document = exportDocument();
    const moved: VoxelDocument = {
      ...document,
      nodes: {
        ...document.nodes,
        [nodeId("node:export:a")]: {
          ...document.nodes[nodeId("node:export:a")],
          transform: {
            translation: [1, 0, 0],
            pivot: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      },
    };
    const { store } = storeWithEntries(moved, [
      { coordinate: [1, 2, -3], material: 1 },
    ]);
    const storage = new MemoryProjectStorage();
    const outcome = await exportVox({
      document: moved,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "blocked.vox",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(
      outcome.blocked.some((loss) => loss.code === "VOX_LOSS_TRANSFORM"),
    ).toBe(true);
    expect(storage.files().size).toBe(0);
  });

  it("blocks export when the document has Clips and writes nothing", async () => {
    const animated: VoxelDocument = {
      ...exportDocument(),
      animations: {
        [animationId("animation:export:slide")]: {
          animationId: animationId("animation:export:slide"),
          name: "Slide",
          duration: 2,
          loop: "once",
          tracks: [
            {
              trackId: trackId("track:export:slide"),
              targetNodeId: nodeId("node:export:a"),
              interpolation: "linear",
              keyframes: [
                {
                  keyframeId: keyframeId("key:export:slide:0"),
                  time: 0,
                  property: { channel: "translation", value: [0, 0, 0] },
                },
                {
                  keyframeId: keyframeId("key:export:slide:1"),
                  time: 2,
                  property: { channel: "translation", value: [1, 0, 0] },
                },
              ],
            },
          ],
        },
      } as VoxelDocument["animations"],
    };
    const { store } = storeWithEntries(animated, [
      { coordinate: [1, 2, -3], material: 1 },
    ]);
    const storage = new MemoryProjectStorage();
    const outcome = await exportVox({
      document: animated,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "animated.vox",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.blocked.some((loss) => loss.code === "VOX_LOSS_CLIPS")).toBe(
      true,
    );
    // Nothing is written while the Clip loss is pending.
    expect(storage.files().size).toBe(0);
    // The Clip-free equivalent exports without the Clip loss.
    const { store: plainStore } = storeWithEntries(exportDocument(), [
      { coordinate: [1, 2, -3], material: 1 },
    ]);
    const plain = await exportVox({
      document: exportDocument(),
      getVolume: (id) => plainStore.getVolume(id),
      storagePort: storage,
      path: "plain.vox",
    });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.losses.some((loss) => loss.code === "VOX_LOSS_CLIPS")).toBe(
      false,
    );
  });

  it("reports material-semantics losses on a successful export", async () => {
    const document = exportDocument();
    const shiny: VoxelDocument = {
      ...document,
      materials: {
        ...document.materials,
        [materialId(1)]: {
          materialId: materialId(1),
          name: "red",
          color: "#ff0000",
          opacity: 1,
          roughness: 0.5,
          metallic: 0,
          emissive: 0,
        },
      },
    };
    const { store } = storeWithEntries(shiny, [
      { coordinate: [1, 2, -3], material: 1 },
    ]);
    const storage = new MemoryProjectStorage();
    const outcome = await exportVox({
      document: shiny,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "lossy.vox",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      outcome.losses.some(
        (loss) => loss.code === "VOX_LOSS_MATERIAL_SEMANTICS",
      ),
    ).toBe(true);
  });

  it("rebases negative origins when chosen", async () => {
    const document = exportDocument();
    const { store } = storeWithEntries(document, [
      { coordinate: [-3, 2, -5], material: 1 },
    ]);
    const storage = new MemoryProjectStorage();
    const blocked = await exportVox({
      document,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "neg.vox",
    });
    expect(blocked.ok).toBe(false);
    const outcome = await exportVox({
      document,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "neg.vox",
      choices: { rebaseOrigins: true },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const parsed = parseVox(storage.files().get("neg.vox") as Uint8Array);
    expect(parsed.models[0]?.voxels).toEqual([
      { x: 0, y: 0, z: 0, colorIndex: 1 },
    ]);
    expect(outcome.losses.some((loss) => loss.code === "VOX_LOSS_ORIGIN")).toBe(
      true,
    );
  });

  it("reports atomic-write phases through onPhase", async () => {
    const document = exportDocument();
    const { store } = storeWithEntries(document, [
      { coordinate: [1, 2, -3], material: 1 },
    ]);
    const storage = new MemoryProjectStorage();
    const phases: string[] = [];
    const outcome = await exportVox({
      document,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "phases.vox",
      onPhase: (phase) => {
        phases.push(phase);
      },
    });
    expect(outcome.ok).toBe(true);
    expect(phases).toContain("create-temp");
    expect(phases).toContain("write-temp");
    expect(phases).toContain("replace");
  });

  it("cancels the atomic write before it lands", async () => {
    const document = exportDocument();
    const { store } = storeWithEntries(document, [
      { coordinate: [1, 2, -3], material: 1 },
    ]);
    const storage = new MemoryProjectStorage();
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportVox({
        document,
        getVolume: (id) => store.getVolume(id),
        storagePort: storage,
        path: "cancel.vox",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "IO_WRITE_INTERRUPTED",
    });
    expect(storage.files().size).toBe(0);
  });

  it("does not mutate the document", async () => {
    const document = exportDocument();
    const { store } = storeWithEntries(document, [
      { coordinate: [1, 2, -3], material: 1 },
    ]);
    const before = store.getDocument();
    const storage = new MemoryProjectStorage();
    const outcome = await exportVox({
      document,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "pure.vox",
    });
    expect(outcome.ok).toBe(true);
    expect(store.getDocument()).toEqual(before);
    expect(store.revision).toBe(0);
  });
});

/** Unused import guard. */
void (null as unknown as VolumeId);
