import { describe, expect, it } from "vitest";
import {
  documentId,
  materialId,
  nodeId,
  volumeId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  canonicalDocumentJson,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { VoxelVolume, type VoxelWriteCapability } from "@voxel-maker/voxel";
import {
  canonicalAssetSemanticHash,
  createDocumentStore,
} from "@voxel-maker/document";
import { DEFAULT_DOCUMENT_LIMITS } from "@voxel-maker/model";
import { DEFAULT_ZIP_ARCHIVE_LIMITS } from "./zip.js";
import {
  DOCUMENT_ENTRY,
  MANIFEST_ENTRY,
  decodeVolumeEntryName,
  encodeVolumeEntryName,
  readVxlProject,
  seedReadView,
  writeVxlProject,
} from "./container.js";
import {
  readZipArchive,
  writeZipArchive,
  type ZipEntry,
  type ZipEntryInput,
} from "./zip.js";

const capability: VoxelWriteCapability = { __kind: "VoxelWriteCapability" };
const limits = {
  maxCoordinate: 1_048_575,
  maxExtent: 2_048,
  maxChunks: 262_144,
  maxOccupiedVoxels: 1_000_000,
  maxCoordinatesPerOperation: 1_000_000,
};

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const BODY = volumeId("volume:container:body");
const ARM = volumeId("volume:container:arm");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function demoDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:container:0001"),
    metadata: { title: "container test" },
    rootNodeId: nodeId("node:container:root"),
    nodes: [
      {
        nodeId: nodeId("node:container:root"),
        name: "Root",
        parentId: null,
        children: [nodeId("node:container:child")],
        transform: identity,
        components: [],
      },
      {
        nodeId: nodeId("node:container:child"),
        name: "Child",
        parentId: nodeId("node:container:root"),
        children: [nodeId("node:container:arm")],
        transform: identity,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: BODY }],
      },
      {
        nodeId: nodeId("node:container:arm"),
        name: "Arm",
        parentId: nodeId("node:container:child"),
        children: [],
        transform: identity,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: ARM }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "stone",
        color: "#aabbcc",
        opacity: 1,
        roughness: 0.8,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [{ volumeId: BODY }, { volumeId: ARM }],
    animations: [
      {
        animationId: "animation:container:spin" as never,
        name: "Spin",
        duration: 2,
        loop: "loop",
        tracks: [
          {
            trackId: "track:container:spin" as never,
            targetNodeId: nodeId("node:container:child"),
            interpolation: "linear",
            keyframes: [
              {
                keyframeId: "keyframe:container:spin:0" as never,
                time: 0,
                property: { channel: "rotation", value: [0, 0, 0, 1] },
              },
            ],
          },
        ],
      },
    ],
  });
}

function buildVolumes(): ReadonlyMap<VolumeId, VoxelVolume> {
  const body = new VoxelVolume(BODY, limits, capability);
  body.setVoxel([0, 0, 0], 1, capability);
  body.setVoxel([-1, 0, 1], 2, capability);
  body.setVoxel([100, -50, 7], 1, capability);
  const arm = new VoxelVolume(ARM, limits, capability);
  arm.setVoxel([5, 5, 5], 1, capability);
  arm.setVoxel([-30, 2, 0], 3, capability);
  return new Map([
    [BODY, body],
    [ARM, arm],
  ]);
}

function writeDemo(): Uint8Array {
  return writeVxlProject({
    document: demoDocument(),
    volumes: buildVolumes(),
  });
}

/** Rebuilds a container from extracted entries (test helper). */
function rebuild(
  entries: readonly { name: string; data: Uint8Array }[],
): Uint8Array {
  return writeZipArchive(entries);
}

/** Asserts that `fn` throws a WorkspaceError with the exact stable code. */
function expectErrorCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`Expected WorkspaceError ${code}, but nothing was thrown`);
  }
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    (thrown as { code: unknown }).code === code
  ) {
    return;
  }
  throw new Error(
    `Expected WorkspaceError ${code}, got ${
      thrown instanceof Error ? thrown.name : typeof thrown
    }`,
  );
}

describe("writeVxlProject", () => {
  it("writes a stable, indexed, deterministic container", () => {
    const bytes = writeDemo();
    const again = writeDemo();
    expect(Buffer.from(bytes).equals(Buffer.from(again))).toBe(true);

    const entries = readZipArchive(bytes);
    const names = entries.map((entry) => entry.name);
    expect(names).toEqual([
      MANIFEST_ENTRY,
      DOCUMENT_ENTRY,
      encodeVolumeEntryName("volume:container:arm"),
      encodeVolumeEntryName("volume:container:body"),
    ]);
    const manifest = JSON.parse(
      decoder.decode(
        (entries.find((entry) => entry.name === MANIFEST_ENTRY) as ZipEntry)
          .data,
      ),
    ) as {
      containerVersion: number;
      documentSchemaVersion: number;
      chunkEncodingVersion: number;
      semanticHash: string;
      entries: {
        name: string;
        kind: string;
        volumeId?: string;
        size: number;
        crc32: string;
      }[];
    };
    expect(manifest.containerVersion).toBe(1);
    expect(manifest.documentSchemaVersion).toBe(1);
    expect(manifest.chunkEncodingVersion).toBe(1);
    expect(manifest.entries.map((entry) => entry.name)).toEqual([
      DOCUMENT_ENTRY,
      encodeVolumeEntryName("volume:container:arm"),
      encodeVolumeEntryName("volume:container:body"),
    ]);
    expect(manifest.entries[0]).toMatchObject({ kind: "document" });
    expect(manifest.entries[1]).toMatchObject({
      kind: "voxels",
      volumeId: "volume:container:arm",
    });
    expect(manifest.semanticHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("writes empty binaries for volumes without backing data", () => {
    const loaded = readVxlProject(
      writeVxlProject({ document: demoDocument() }),
    );
    expect(loaded.volumes.get(ARM)?.chunks).toEqual([]);
    expect(loaded.volumes.get(BODY)?.chunks).toEqual([]);
  });

  it("rejects volumes that are not part of the document", () => {
    expectErrorCode(
      () =>
        writeVxlProject({
          document: demoDocument(),
          volumes: new Map([
            [
              "volume:container:ghost" as VolumeId,
              new VoxelVolume(
                "volume:container:ghost" as never,
                limits,
                capability,
              ),
            ],
          ]),
        }),
      "MISSING_VOLUME",
    );
  });

  it("rejects containers above the entry limit", () => {
    const previews = Array.from({ length: 4_096 }, (_, i) => ({
      name: `previews/p${String(i).padStart(4, "0")}.png`,
      data: new Uint8Array([1]),
    }));
    expectErrorCode(
      () => writeVxlProject({ document: demoDocument(), previews }),
      "ENTRY_LIMIT_EXCEEDED",
    );
  });

  it("rejects unsafe preview names", () => {
    expectErrorCode(
      () =>
        writeVxlProject({
          document: demoDocument(),
          previews: [{ name: "../evil.png", data: new Uint8Array([1]) }],
        }),
      "INVALID_ENTRY_NAME",
    );
  });
});

describe("readVxlProject", () => {
  it("rejects limit profiles that raise hard defaults", () => {
    const bytes = writeDemo();
    expectErrorCode(
      () =>
        readVxlProject(bytes, {
          containerLimits: { ...DEFAULT_ZIP_ARCHIVE_LIMITS, maxEntries: 9_999 },
        }),
      "LIMIT_ABOVE_DEFAULT",
    );
    expectErrorCode(
      () =>
        readVxlProject(bytes, {
          documentLimits: { ...DEFAULT_DOCUMENT_LIMITS, maxNodes: 20_000 },
        }),
      "LIMIT_ABOVE_DEFAULT",
    );
  });

  it("seedReadView answers voxel queries inside chunks", () => {
    const loaded = readVxlProject(writeDemo());
    const body = loaded.volumes.get(BODY);
    expect(body).toBeDefined();
    const view = seedReadView(BODY, body?.chunks ?? []);
    // Voxel (0,0,0) and (17,1,0) live inside chunk (0,0,0)/(1,0,0) and must
    // resolve through the floor-division lookup, not only at boundaries.
    expect(view.getVoxel([0, 0, 0])).toBe(1);
    expect(view.getVoxel([-1, 0, 1])).toBe(2);
    expect(view.getVoxel([100, -50, 7])).toBe(1);
    expect(view.getVoxel([99, -49, 6])).toBe(0);
    expect(view.chunkCount()).toBe(3);
    expect(view.occupiedCount()).toBe(3);
  });

  it("reconstructs hierarchy, materials, animation, and voxel volumes", () => {
    const sourceDocument = demoDocument();
    const sourceVolumes = buildVolumes();
    const bytes = writeVxlProject({
      document: sourceDocument,
      volumes: sourceVolumes,
      previews: [
        {
          name: "previews/front.png",
          data: new Uint8Array([137, 80, 78, 71]),
        },
      ],
    });
    const loaded = readVxlProject(bytes);

    // Document equality through the canonical JSON (parse round-trip).
    expect(canonicalDocumentJson(loaded.document)).toBe(
      canonicalDocumentJson(sourceDocument),
    );
    expect(loaded.document.nodes[nodeId("node:container:child")]?.name).toBe(
      "Child",
    );
    expect(loaded.document.materials[materialId(1)]?.color).toBe("#aabbcc");
    expect(
      loaded.document.animations["animation:container:spin" as never],
    ).toBeDefined();

    // Volume equality against the source read views.
    const body = sourceVolumes.get(BODY) as VoxelVolume;
    const loadedBody = loaded.volumes.get(BODY);
    expect(loadedBody?.chunks.length).toBe(body.chunkCount());
    for (const seed of loadedBody?.chunks ?? []) {
      expect(seed.values.join(",")).toBe(
        body.getChunk(seed.coordinate)?.join(","),
      );
    }

    // Preview bytes pass through untouched.
    expect(
      Buffer.from(
        loaded.previews.get("previews/front.png") as Uint8Array,
      ).equals(Buffer.from(new Uint8Array([137, 80, 78, 71]))),
    ).toBe(true);

    // Semantic hash equals the source asset hash and the manifest value.
    expect(loaded.semanticHash).toBe(
      canonicalAssetSemanticHash(sourceDocument, sourceVolumes),
    );
    expect(loaded.semanticHash).toBe(loaded.manifest.semanticHash);
  });

  it("installs a reloaded asset through validated lifecycle replacement", () => {
    const loaded = readVxlProject(writeDemo());
    const seeds = new Map(
      [...loaded.volumes.entries()].map(([id, volume]) => [id, volume.chunks]),
    );
    const { store } = createDocumentStore({
      document: loaded.document,
      volumes: seeds,
    });
    expect(store.getVoxel(BODY, [0, 0, 0])).toBe(1);
    expect(store.getVoxel(BODY, [-1, 0, 1])).toBe(2);
    expect(store.getVoxel(BODY, [100, -50, 7])).toBe(1);
    expect(store.getVoxel(ARM, [5, 5, 5])).toBe(1);
    expect(store.getVoxel(ARM, [-30, 2, 0])).toBe(3);
    expect(store.getVolume(BODY)?.occupiedCount()).toBe(3);
  });

  it("rejects a semantic hash that does not match the content", () => {
    const entries = readZipArchive(writeDemo()).map((entry) => {
      if (entry.name !== MANIFEST_ENTRY) return entry;
      const json = decoder.decode(entry.data);
      const patched = json.replace(/"[0-9a-f]{64}"/u, `"${"0".repeat(64)}"`);
      return { name: entry.name, data: encoder.encode(patched) };
    });
    expectErrorCode(
      () => readVxlProject(rebuild(entries)),
      "SEMANTIC_HASH_MISMATCH",
    );
  });

  it("rejects a container without a manifest entry", () => {
    const entries = readZipArchive(writeDemo()).filter(
      (entry) => entry.name !== MANIFEST_ENTRY,
    );
    expectErrorCode(() => readVxlProject(rebuild(entries)), "MISSING_MANIFEST");
  });

  it("rejects a document volume missing from the index and archive", () => {
    const entries: ZipEntryInput[] = readZipArchive(writeDemo()).filter(
      (entry) =>
        entry.name !== MANIFEST_ENTRY &&
        entry.name !== encodeVolumeEntryName("volume:container:arm"),
    );
    const manifestEntry = readZipArchive(writeDemo()).find(
      (entry) => entry.name === MANIFEST_ENTRY,
    ) as ZipEntry;
    const manifest = JSON.parse(decoder.decode(manifestEntry.data)) as {
      entries: { name: string }[];
    };
    manifest.entries = manifest.entries.filter(
      (entry) => entry.name !== encodeVolumeEntryName("volume:container:arm"),
    );
    entries.push({
      name: MANIFEST_ENTRY,
      data: encoder.encode(JSON.stringify(manifest)),
    });
    expectErrorCode(
      () => readVxlProject(rebuild(entries)),
      "MISSING_VOLUME_ENTRY",
    );
  });

  it("rejects an unsupported future container version", () => {
    const entries = readZipArchive(writeDemo()).map((entry) => {
      if (entry.name !== MANIFEST_ENTRY) return entry;
      const json = decoder.decode(entry.data);
      return {
        name: entry.name,
        data: encoder.encode(
          json.replace('"containerVersion":1', '"containerVersion":2'),
        ),
      };
    });
    expectErrorCode(
      () => readVxlProject(rebuild(entries)),
      "UNSUPPORTED_CONTAINER_VERSION",
    );
  });
});

describe("volume entry names", () => {
  it("percent-encodes volume IDs deterministically", () => {
    expect(encodeVolumeEntryName("volume:demo:0001")).toBe(
      "voxels/volume%3Ademo%3A0001.bin",
    );
    expect(encodeVolumeEntryName("a/b..c")).toBe("voxels/a%2Fb%2E%2Ec.bin");
    expect(decodeVolumeEntryName("voxels/volume%3Ademo%3A0001.bin")).toBe(
      "volume:demo:0001",
    );
    expect(decodeVolumeEntryName("voxels/a%2Fb%2E%2Ec.bin")).toBe("a/b..c");
  });

  it("round-trips non-ASCII volume IDs through UTF-8 percent-encoding", () => {
    const exotic = "v\u00f6lume:\u{1faa8}";
    expect(encodeVolumeEntryName(exotic)).toBe(
      "voxels/v%C3%B6lume%3A%F0%9F%AA%A8.bin",
    );
    expect(decodeVolumeEntryName(encodeVolumeEntryName(exotic))).toBe(exotic);
  });

  it("rejects malformed escapes", () => {
    expectErrorCode(
      () => decodeVolumeEntryName("voxels/a%2g.bin"),
      "INVALID_ENTRY_NAME",
    );
    expect(decodeVolumeEntryName("voxels/notavolume2.bin")).toBe("notavolume2");
  });
});
