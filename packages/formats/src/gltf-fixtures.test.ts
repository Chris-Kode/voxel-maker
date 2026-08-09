import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { nodeId, volumeId, type VolumeId } from "@voxel-maker/shared";
import { parseDocument } from "@voxel-maker/model";
import { createDocumentStore } from "@voxel-maker/document";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";
import { encodeGlb } from "./gltf.js";
import { planGltfExport, preflightGltfExport } from "./gltf-mapping.js";

/**
 * Corpus test for the checked-in static glTF/GLB fixtures (plan S16.8,
 * ticket #41): every golden file must be byte-stable — rebuilding the
 * retained document and volumes must reproduce the exact checked-in
 * bytes — and an independent GLB reader must confirm the recorded
 * structure counts.
 *
 * Regenerate the corpus with `node scripts/generate-gltf-fixtures.mjs`.
 */

const CORPUS_DIR = new URL("../../../fixtures/gltf/", import.meta.url);

interface CorpusGolden {
  readonly file: string;
  readonly vector: string;
  readonly byteLength: number;
  readonly documentJson: string;
  readonly volumesJson: string;
  readonly gltf?: string;
  readonly gltfByteLength?: number;
  readonly nodes: number;
  readonly meshes: number;
  readonly materials: number;
  readonly accessors: number;
  readonly faces: number;
  readonly voxels: number;
  readonly losses: number;
}

interface Corpus {
  readonly schemaVersion: number;
  readonly golden: readonly CorpusGolden[];
}

/** Rebuilds the session store from the retained document and volume JSON. */
async function rebuildStore(
  entry: CorpusGolden,
): Promise<ReturnType<typeof createDocumentStore>["store"]> {
  const document = parseDocument(
    await readFile(new URL(entry.documentJson, CORPUS_DIR), "utf8"),
  );
  const volumesJson = JSON.parse(
    await readFile(new URL(entry.volumesJson, CORPUS_DIR), "utf8"),
  ) as Record<string, readonly (readonly [number, number, number, number])[]>;
  const volumes = new Map<VolumeId, readonly VoxelChunkSeed[]>();
  for (const [id, entries] of Object.entries(volumesJson)) {
    const chunks = new Map<string, VoxelChunkSeed>();
    for (const [x, y, z, material] of entries) {
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
      chunk.values[lx + 16 * (ly + 16 * lz)] = material;
      chunks.set(key, chunk);
    }
    volumes.set(volumeId(id), [...chunks.values()]);
  }
  return createDocumentStore({ document, volumes }).store;
}

/** Independent GLB reader: header, chunks, and structural counts. */
function readGlbCounts(bytes: Uint8Array): {
  readonly nodes: number;
  readonly meshes: number;
  readonly materials: number;
  readonly accessors: number;
  readonly faces: number;
} {
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
  expect(jsonLength % 4).toBe(0);
  const json = JSON.parse(
    new TextDecoder("utf-8").decode(bytes.subarray(20, 20 + jsonLength)),
  ) as {
    readonly nodes: readonly unknown[];
    readonly meshes: readonly {
      readonly primitives: readonly {
        readonly indices: number;
      }[];
    }[];
    readonly materials: readonly unknown[];
    readonly accessors: readonly { readonly count: number }[];
  };
  const binStart = 20 + jsonLength;
  const binLength = view.getUint32(binStart, true);
  expect(binLength % 4).toBe(0);
  const buffer = json.accessors.map((accessor) => accessor.count);
  let faces = 0;
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      faces += (buffer[primitive.indices] as number) / 6;
    }
  }
  return {
    nodes: json.nodes.length,
    meshes: json.meshes.length,
    materials: json.materials.length,
    accessors: json.accessors.length,
    faces,
  };
}

describe("glTF fixture corpus", () => {
  it("retains byte-stable golden GLB and GLTF files", async () => {
    const corpus = JSON.parse(
      await readFile(new URL("corpus.json", CORPUS_DIR), "utf8"),
    ) as Corpus;
    expect(corpus.schemaVersion).toBe(1);
    for (const entry of corpus.golden) {
      const bytes = await readFile(new URL(entry.file, CORPUS_DIR));
      expect(bytes.byteLength, entry.file).toBe(entry.byteLength);
      // Rebuilding the retained document and volumes must reproduce the
      // exact bytes, so an accidental exporter change is a failure.
      const store = await rebuildStore(entry);
      const document = store.getDocument();
      const preflight = preflightGltfExport(document, (id) =>
        store.getVolume(id),
      );
      expect(preflight.ok, entry.file).toBe(true);
      if (!preflight.ok) continue;
      const plan = planGltfExport(
        document,
        (id) => store.getVolume(id),
        preflight,
      );
      expect(plan.losses.length, entry.file).toBe(entry.losses);
      const rebuilt = encodeGlb(plan);
      expect(Buffer.from(rebuilt).equals(Buffer.from(bytes)), entry.file).toBe(
        true,
      );
      if (entry.gltf !== undefined) {
        const gltfBytes = await readFile(new URL(entry.gltf, CORPUS_DIR));
        expect(gltfBytes.byteLength, entry.gltf).toBe(
          entry.gltfByteLength as number,
        );
      }
    }
  });

  it("matches the recorded structure through an independent reader", async () => {
    const corpus = JSON.parse(
      await readFile(new URL("corpus.json", CORPUS_DIR), "utf8"),
    ) as Corpus;
    for (const entry of corpus.golden) {
      const bytes = await readFile(new URL(entry.file, CORPUS_DIR));
      const counts = readGlbCounts(bytes);
      expect(counts.nodes, entry.file).toBe(entry.nodes);
      expect(counts.meshes, entry.file).toBe(entry.meshes);
      expect(counts.materials, entry.file).toBe(entry.materials);
      expect(counts.accessors, entry.file).toBe(entry.accessors);
      expect(counts.faces, entry.file).toBe(entry.faces);
    }
  });

  it("contains exactly the checked-in golden files", async () => {
    const onDisk = (await readdir(new URL("golden/", CORPUS_DIR))).sort();
    const corpus = JSON.parse(
      await readFile(new URL("corpus.json", CORPUS_DIR), "utf8"),
    ) as Corpus;
    const expected = new Set<string>();
    for (const entry of corpus.golden) {
      expected.add(entry.file.slice("golden/".length));
      expected.add(entry.documentJson.slice("golden/".length));
      expected.add(entry.volumesJson.slice("golden/".length));
      if (entry.gltf !== undefined) {
        expected.add(entry.gltf.slice("golden/".length));
      }
    }
    expect(onDisk).toEqual([...expected].sort());
  });
});

/** Unused import guard. */
void nodeId;
