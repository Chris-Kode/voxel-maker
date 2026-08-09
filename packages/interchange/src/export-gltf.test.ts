import { describe, expect, it } from "vitest";
import {
  materialId,
  nodeId,
  volumeId,
  type VolumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { createDocumentStore } from "@voxel-maker/document";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import { exportGltf, exportFormatForPath } from "./export-gltf.js";

/**
 * Static glTF/GLB export service (plan S16.3, ticket #41): preflight ->
 * deterministic encode -> scoped atomic write through the storage port,
 * with loss reports, cancellation, progress phases, and no document
 * mutation.
 */

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

/** Minimal independent GLB check: magic, version, JSON chunk parses. */
function parseGlbJson(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(
    bytes[0] as number,
    bytes[1] as number,
    bytes[2] as number,
    bytes[3] as number,
  );
  expect(magic).toBe("glTF");
  expect(view.getUint32(4, true)).toBe(2);
  expect(view.getUint32(8, true)).toBe(bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const text = new TextDecoder("utf-8").decode(
    bytes.subarray(20, 20 + jsonLength),
  );
  return JSON.parse(text) as unknown;
}

describe("exportGltf", () => {
  it("writes a deterministic GLB through the storage port", async () => {
    const document = exportDocument();
    const { store } = storeWithEntries(document, [
      { coordinate: [1, 2, -3], material: 1 },
      { coordinate: [4, 5, -6], material: 1 },
    ]);
    const storage = new MemoryProjectStorage();
    const first = await exportGltf({
      document,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "model.glb",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.format).toBe("glb");
    expect(first.metadata.generator).toBe("voxel-maker");
    const second = await exportGltf({
      document,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "model.glb",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Determinism: identical bytes across calls.
    expect(second.bytes).toEqual(first.bytes);
    const json = parseGlbJson(storage.files().get("model.glb") as Uint8Array);
    expect(json).toMatchObject({
      asset: { version: "2.0", generator: "voxel-maker" },
    });
  });

  it("writes a .gltf JSON file with an embedded buffer", async () => {
    const document = exportDocument();
    const { store } = storeWithEntries(document, [
      { coordinate: [0, 0, 0], material: 1 },
    ]);
    const storage = new MemoryProjectStorage();
    const outcome = await exportGltf({
      document,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "model.gltf",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.format).toBe("gltf");
    const file = storage.files().get("model.gltf") as Uint8Array;
    const json = JSON.parse(new TextDecoder("utf-8").decode(file)) as {
      buffers: readonly { uri: string; byteLength: number }[];
    };
    const uri = json.buffers[0]?.uri ?? "";
    expect(uri.startsWith("data:application/octet-stream;base64,")).toBe(true);
    const payload = uri.split(",")[1] ?? "";
    expect(new Uint8Array(Buffer.from(payload, "base64")).byteLength).toBe(
      json.buffers[0]?.byteLength,
    );
  });

  it("blocks export with a loss report and writes nothing", async () => {
    const empty = createDocument({
      documentId: "document:export:0002" as never,
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [],
          transform: identity,
          components: [],
        },
      ],
      materials: [],
      volumes: [],
    });
    const storage = new MemoryProjectStorage();
    const outcome = await exportGltf({
      document: empty,
      getVolume: () => undefined,
      storagePort: storage,
      path: "blocked.glb",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.blocked[0]?.code).toBe("GLTF_LOSS_NO_VOLUMES");
    expect(storage.files().size).toBe(0);
  });

  it("rejects a destination without a .gltf/.glb extension", async () => {
    const document = exportDocument();
    const { store } = storeWithEntries(document, [
      { coordinate: [0, 0, 0], material: 1 },
    ]);
    const storage = new MemoryProjectStorage();
    await expect(
      exportGltf({
        document,
        getVolume: (id) => store.getVolume(id),
        storagePort: storage,
        path: "model.bin",
      }),
    ).rejects.toMatchObject({ code: "GLTF_UNSUPPORTED_EXTENSION" });
    expect(storage.files().size).toBe(0);
  });

  it("reports atomic-write phases through onPhase", async () => {
    const document = exportDocument();
    const { store } = storeWithEntries(document, [
      { coordinate: [1, 2, -3], material: 1 },
    ]);
    const storage = new MemoryProjectStorage();
    const phases: string[] = [];
    const outcome = await exportGltf({
      document,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "phases.glb",
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
      exportGltf({
        document,
        getVolume: (id) => store.getVolume(id),
        storagePort: storage,
        path: "cancel.glb",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "IO_WRITE_INTERRUPTED" });
    expect(storage.files().size).toBe(0);
  });

  it("does not mutate the document", async () => {
    const document = exportDocument();
    const { store } = storeWithEntries(document, [
      { coordinate: [1, 2, -3], material: 1 },
    ]);
    const before = store.getDocument();
    const storage = new MemoryProjectStorage();
    const outcome = await exportGltf({
      document,
      getVolume: (id) => store.getVolume(id),
      storagePort: storage,
      path: "pure.glb",
    });
    expect(outcome.ok).toBe(true);
    expect(store.getDocument()).toEqual(before);
    expect(store.revision).toBe(0);
  });
});

describe("exportFormatForPath", () => {
  it("resolves .glb and .gltf extensions", () => {
    expect(exportFormatForPath("out/model.glb")).toBe("glb");
    expect(exportFormatForPath("out/model.gltf")).toBe("gltf");
    expectGltfError(
      () => exportFormatForPath("out/model.bin"),
      "validation",
      "GLTF_UNSUPPORTED_EXTENSION",
    );
  });
});

/** Asserts that `fn` throws a WorkspaceError with the exact family/code. */
function expectGltfError(
  fn: () => unknown,
  family: string,
  code: string,
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`Expected ${family}/${code}, but nothing was thrown`);
  }
  const actual =
    typeof thrown === "object" && thrown !== null
      ? (thrown as { family?: unknown; code?: unknown })
      : {};
  if (actual.family === family && actual.code === code) return;
  throw new Error(
    `Expected ${family}/${code}, got ${String(actual.family)}/${String(
      actual.code,
    )}`,
  );
}

/** Unused import guard. */
void (null as unknown as VolumeId);
