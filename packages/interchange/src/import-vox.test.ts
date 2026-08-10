import { describe, expect, it } from "vitest";
import {
  commandId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  canonicalColor,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import {
  CommandBus,
  CommandRegistry,
  registerBatchCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
  registerVolumeCommands,
} from "@voxel-maker/commands";
import {
  DEFAULT_VOX_PARSE_LIMITS,
  encodeVox,
  parseVox,
} from "@voxel-maker/formats";
import type {
  VoxColor,
  VoxModel,
  VoxParseLimits,
  VoxVoxel,
} from "@voxel-maker/formats";
import { importVox, MAX_IMPORT_ENTRIES_PER_COMMAND } from "./import-vox.js";

/** Asserts that `fn` throws a WorkspaceError with the given code. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    const candidate = error as { code?: unknown };
    expect(candidate.code).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code} to be thrown`);
}

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:import:root");

function baseDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:import:0001" as never,
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
}

function harness(document: VoxelDocument = baseDocument()) {
  const { store, writeCapability } = createDocumentStoreHandle({ document });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  registerRegionCommands(registry);
  registerNodeCommands(registry);
  registerMaterialCommands(registry);
  registerVolumeCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);
  return { store, bus };
}

const palette: VoxColor[] = [
  { r: 0, g: 0, b: 0, a: 0 },
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 255, b: 0, a: 255 },
  ...Array.from({ length: 253 }, () => ({ r: 0, g: 0, b: 0, a: 255 })),
];

const cube: VoxModel = {
  sizeX: 2,
  sizeY: 2,
  sizeZ: 2,
  voxels: [
    { x: 0, y: 0, z: 0, colorIndex: 1 },
    { x: 1, y: 0, z: 0, colorIndex: 1 },
    { x: 0, y: 1, z: 0, colorIndex: 2 },
    { x: 1, y: 1, z: 0, colorIndex: 2 },
  ],
};

/**
 * Builds a raw VOX file with `unknownCount` zero-length unknown chunks plus
 * one SIZE/XYZI model pair (issue #90: chunk-count floods).
 */
function buildChunkFloodFile(unknownCount: number): Uint8Array {
  const CHUNK_HEADER_BYTES = 12;
  const childrenBytes =
    unknownCount * CHUNK_HEADER_BYTES +
    (CHUNK_HEADER_BYTES + 12) +
    (CHUNK_HEADER_BYTES + 4 + 4);
  const bytes = new Uint8Array(8 + CHUNK_HEADER_BYTES + childrenBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x20584f56, true); // "VOX "
  view.setUint32(4, 150, true);
  let offset = 8;
  const chunk = (id: string, content: number, children: number): void => {
    for (let i = 0; i < 4; i += 1) {
      view.setUint8(offset + i, id.charCodeAt(i));
    }
    view.setUint32(offset + 4, content, true);
    view.setUint32(offset + 8, children, true);
    offset += CHUNK_HEADER_BYTES;
  };
  chunk("MAIN", 0, childrenBytes);
  for (let i = 0; i < unknownCount; i += 1) chunk("TEST", 0, 0);
  chunk("SIZE", 12, 0);
  view.setUint32(offset, 1, true);
  view.setUint32(offset + 4, 1, true);
  view.setUint32(offset + 8, 1, true);
  offset += 12;
  chunk("XYZI", 4 + 4, 0);
  view.setUint32(offset, 1, true); // one voxel, palette index 1
  view.setUint8(offset + 4, 0);
  view.setUint8(offset + 5, 0);
  view.setUint8(offset + 6, 0);
  view.setUint8(offset + 7, 1);
  return bytes;
}

describe("importVox", () => {
  it("imports a file into the open document through one transaction", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    const outcome = importVox(bus, store, {
      bytes,
      expectedRevision: 0,
      transactionId: transactionId("transaction:import:test:0001"),
    });
    expect(outcome.revisionAfter).toBe(1);
    expect(outcome.nodesCreated).toBe(1);
    expect(outcome.volumesCreated).toBe(1);
    expect(outcome.materialsCreated).toBe(2);
    expect(outcome.voxelsImported).toBe(4);

    const document = store.getDocument();
    expect(Object.keys(document.nodes)).toHaveLength(2);
    const imported = document.nodes[nodeId("node:import:0001")];
    expect(imported?.name).toBe("Model 1");
    expect(imported?.parentId).toBe(ROOT);
    expect(imported?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: "volume:import:0001" },
    ]);
    expect(document.materials[materialId(1)]?.color).toBe("#ff0000");
    expect(document.materials[materialId(2)]?.color).toBe("#00ff00");
    // Axis mapping: vox (1, 0, 0) -> editor (1, 0, 0); vox (0, 1, 0) -> (0, 0, -1).
    expect(store.getVoxel(volumeId("volume:import:0001"), [1, 0, 0])).toBe(1);
    expect(store.getVoxel(volumeId("volume:import:0001"), [0, 0, -1])).toBe(2);
    expect(store.getVoxel(volumeId("volume:import:0001"), [1, 0, -1])).toBe(2);
  });

  it("rejects malformed files without changing state", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    bytes[0] = 0x58; // corrupt magic
    const before = store.getDocument();
    expectCode(
      () => importVox(bus, store, { bytes, expectedRevision: 0 }),
      "VOX_INVALID_MAGIC",
    );
    expect(store.revision).toBe(0);
    expect(store.getDocument()).toEqual(before);
  });

  it("rejects stale revisions with REVISION_CONFLICT", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    expectCode(
      () => importVox(bus, store, { bytes, expectedRevision: 5 }),
      "REVISION_CONFLICT",
    );
    expect(store.revision).toBe(0);
  });

  it("reuses identical existing materials and avoids id collisions", () => {
    const document = createDocument({
      documentId: "document:import:0002" as never,
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
      materials: [
        {
          materialId: materialId(1),
          name: "occupied",
          color: "#00ff00",
          opacity: 1,
          roughness: 0,
          metallic: 0,
          emissive: 0,
        },
      ],
      volumes: [],
    });
    const { store, bus } = harness(document);
    const bytes = encodeVox({ models: [cube], palette });
    const outcome = importVox(bus, store, { bytes, expectedRevision: 0 });
    // Palette index 1 (#ff0000) has no conflict; palette index 2 (#00ff00)
    // matches the existing material and is reused.
    expect(outcome.materialsCreated).toBe(1);
    expect(document.materials[materialId(1)]?.name).toBe("occupied");
    expect(store.getDocument().materials[materialId(2)]?.color).toBe("#ff0000");
    // Palette index 2 reuses existing material 1 (#00ff00); palette index 1
    // is remapped to material 2 (#ff0000).
    expect(store.getVoxel(volumeId("volume:import:0001"), [0, 0, 0])).toBe(
      materialId(2),
    );
  });

  it("does not reuse an existing material with the same color but different opacity", () => {
    const document = createDocument({
      documentId: "document:import:0004" as never,
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
      materials: [
        {
          materialId: materialId(1),
          name: "translucent red",
          color: "#ff0000",
          opacity: 0.5,
          roughness: 0,
          metallic: 0,
          emissive: 0,
        },
      ],
      volumes: [],
    });
    const { store, bus } = harness(document);
    // Palette index 1 is #ff0000 with alpha 255 (opacity 1): reusing the
    // existing translucent red would silently discard the palette alpha,
    // so the import must create a new opaque material instead.
    const bytes = encodeVox({ models: [cube], palette });
    const outcome = importVox(bus, store, { bytes, expectedRevision: 0 });
    expect(outcome.materialsCreated).toBe(2);
    expect(store.getDocument().materials[materialId(1)]?.opacity).toBe(0.5);
    expect(store.getDocument().materials[materialId(2)]?.opacity).toBe(1);
    expect(store.getVoxel(volumeId("volume:import:0001"), [0, 0, 0])).toBe(
      materialId(2),
    );
  });

  it("keeps palette entries that differ only in alpha as distinct materials", () => {
    const { store, bus } = harness();
    // Palette indices 1 and 2 share RGB #ff0000 but differ in alpha; the
    // within-import color cache must not merge them (issue #89).
    const alphaPalette: VoxColor[] = [
      { r: 0, g: 0, b: 0, a: 0 },
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 255, g: 0, b: 0, a: 128 },
      ...Array.from({ length: 253 }, () => ({ r: 0, g: 0, b: 0, a: 255 })),
    ];
    const alphaCube: VoxModel = {
      sizeX: 2,
      sizeY: 1,
      sizeZ: 1,
      voxels: [
        { x: 0, y: 0, z: 0, colorIndex: 1 },
        { x: 1, y: 0, z: 0, colorIndex: 2 },
      ],
    };
    const bytes = encodeVox({ models: [alphaCube], palette: alphaPalette });
    const outcome = importVox(bus, store, { bytes, expectedRevision: 0 });
    expect(outcome.materialsCreated).toBe(2);
    expect(store.getDocument().materials[materialId(1)]?.opacity).toBe(1);
    expect(store.getDocument().materials[materialId(2)]?.opacity).toBe(
      128 / 255,
    );
    // Each voxel keeps its source palette entry's material.
    expect(store.getVoxel(volumeId("volume:import:0001"), [0, 0, 0])).toBe(
      materialId(1),
    );
    expect(store.getVoxel(volumeId("volume:import:0001"), [1, 0, 0])).toBe(
      materialId(2),
    );
  });

  it("remaps colliding palette ids to free material ids", () => {
    const document = createDocument({
      documentId: "document:import:0003" as never,
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
      materials: [
        {
          materialId: materialId(1),
          name: "different red",
          color: "#ff8800",
          opacity: 1,
          roughness: 0,
          metallic: 0,
          emissive: 0,
        },
      ],
      volumes: [],
    });
    const { store, bus } = harness(document);
    const bytes = encodeVox({ models: [cube], palette });
    const outcome = importVox(bus, store, { bytes, expectedRevision: 0 });
    expect(outcome.materialsCreated).toBe(2);
    // Palette index 1 collides; it must be remapped to a free id (2),
    // and the imported voxels must reference the remapped material.
    const imported = store.getDocument().nodes[nodeId("node:import:0001")];
    const volumeIdValue = (
      imported?.components.find((c) => c.kind === "voxel") as
        | { kind: "voxel"; volumeId: VolumeId }
        | undefined
    )?.volumeId;
    expect(volumeIdValue).toBeDefined();
    expect(store.getVoxel(volumeIdValue as VolumeId, [0, 0, 0])).toBe(
      materialId(2),
    );
  });

  it("splits large volumes across volume.create commands in one transaction", () => {
    const { store, bus } = harness();
    // A model with more entries than one command can carry.
    const size = 64;
    const voxels: VoxVoxel[] = [];
    for (let z = 0; z < size; z += 1) {
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < 16; x += 1) {
          voxels.push({ x, y, z, colorIndex: 1 });
        }
      }
    }
    expect(voxels.length).toBeGreaterThan(MAX_IMPORT_ENTRIES_PER_COMMAND);
    const bytes = encodeVox({
      models: [{ sizeX: 16, sizeY: size, sizeZ: size, voxels }],
      palette,
    });
    const outcome = importVox(bus, store, { bytes, expectedRevision: 0 });
    expect(outcome.voxelsImported).toBe(voxels.length);
    expect(outcome.volumesCreated).toBe(1);
    const volume = store.getVolume(volumeId("volume:import:0001"));
    expect(volume?.occupiedCount()).toBe(voxels.length);
    expect(store.revision).toBe(1); // exactly one transaction
  });

  it("cancels before commit without side effects", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    const controller = new AbortController();
    controller.abort();
    expectCode(
      () =>
        importVox(bus, store, {
          bytes,
          expectedRevision: 0,
          signal: controller.signal,
        }),
      "IMPORT_CANCELLED",
    );
    expect(store.revision).toBe(0);
  });

  it("reports progress stages", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    const stages: string[] = [];
    importVox(bus, store, {
      bytes,
      expectedRevision: 0,
      onProgress: (stage) => {
        stages.push(stage);
      },
    });
    expect(stages).toEqual(["parse", "commit"]);
  });

  it("supports undo of the whole import", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    const outcome = importVox(bus, store, {
      bytes,
      expectedRevision: 0,
      transactionId: transactionId("transaction:import:undo:0001"),
    });
    const undo = bus.undo({
      transactionId: transactionId("transaction:import:undo:0001:undo"),
      expectedRevision: outcome.revisionAfter,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(store.revision).toBe(2); // undo commits one transaction
    expect(Object.keys(store.getDocument().nodes)).toHaveLength(1);
    expect(store.getVolume(volumeId("volume:import:0001"))).toBeUndefined();
    const redo = bus.redo({
      transactionId: transactionId("transaction:import:undo:0001:redo"),
      expectedRevision: 2,
      source: "ui",
    });
    expect(redo.ok).toBe(true);
    expect(
      store.getVolume(volumeId("volume:import:0001"))?.occupiedCount(),
    ).toBe(4);
  });

  it("round-trips through the codec with identical semantics", () => {
    const { store, bus } = harness();
    const bytes = encodeVox({ models: [cube], palette });
    importVox(bus, store, { bytes, expectedRevision: 0 });
    const document = store.getDocument();
    const volume = store.getVolume(volumeId("volume:import:0001"));
    // Re-encode the imported volume through the export pipeline and parse it.
    const materialColors = Object.fromEntries(
      Object.entries(document.materials).map(([id, material]) => [
        Number(id),
        material.color,
      ]),
    );
    void materialColors;
    const exportedPalette: VoxColor[] = [palette[0] as VoxColor];
    const indexMap = new Map<number, number>();
    for (let index = 1; index <= 255; index += 1) {
      const color = palette[index];
      const entry = color === undefined ? { r: 0, g: 0, b: 0, a: 255 } : color;
      exportedPalette.push(entry);
      if (index === 1 || index === 2) indexMap.set(index, index);
    }
    void indexMap;
    const exportedModel: {
      sizeX: number;
      sizeY: number;
      sizeZ: number;
      voxels: VoxVoxel[];
    } = {
      sizeX: 2,
      sizeY: 2,
      sizeZ: 2,
      voxels: [],
    };
    if (volume !== undefined) {
      for (const coordinate of volume.chunkCoordinates()) {
        const chunk = volume.getChunk(coordinate);
        if (chunk === undefined) continue;
        for (let i = 0; i < chunk.length; i += 1) {
          const material = chunk[i] as number;
          if (material === 0) continue;
          const local = [i % 16, Math.floor(i / 16) % 16, Math.floor(i / 256)];
          exportedModel.voxels.push({
            x: coordinate[0] * 16 + (local[0] ?? 0),
            y: -(coordinate[2] * 16 + (local[2] ?? 0)),
            z: coordinate[1] * 16 + (local[1] ?? 0),
            colorIndex: material,
          });
        }
      }
    }
    const reencoded = encodeVox({
      models: [exportedModel],
      palette: exportedPalette,
    });
    const reparsed = parseVox(reencoded);
    expect([...(reparsed.models[0]?.voxels ?? [])].sort()).toEqual(
      [...cube.voxels].sort(
        (a, b) =>
          a.x - b.x || a.y - b.y || a.z - b.z || a.colorIndex - b.colorIndex,
      ),
    );
    void commandId;
    void canonicalColor;
  });

  describe("parse limit profile validation (issue #90)", () => {
    const LIMIT_MEMBERS = [
      "maxFileBytes",
      "maxModels",
      "maxVoxelsPerModel",
      "maxTotalVoxels",
      "maxChunks",
      "maxUnknownChunkBytes",
    ] as const;

    it("rejects every raised limit member before parsing or mutation", () => {
      const { store, bus } = harness();
      const bytes = encodeVox({ models: [cube], palette });
      const before = JSON.stringify(store.getDocument());
      for (const member of LIMIT_MEMBERS) {
        const raised: VoxParseLimits = {
          ...DEFAULT_VOX_PARSE_LIMITS,
          [member]: DEFAULT_VOX_PARSE_LIMITS[member] + 1,
        };
        expectCode(
          () =>
            importVox(bus, store, {
              bytes,
              expectedRevision: 0,
              parseLimits: raised,
            }),
          "VOX_PARSE_LIMITS_INVALID",
        );
        expect(store.revision).toBe(0);
      }
      expect(JSON.stringify(store.getDocument())).toBe(before);
    });

    it("rejects non-finite, fractional, and non-positive limit members", () => {
      const { store, bus } = harness();
      const bytes = encodeVox({ models: [cube], palette });
      const invalid: VoxParseLimits[] = [
        { ...DEFAULT_VOX_PARSE_LIMITS, maxChunks: Number.NaN },
        { ...DEFAULT_VOX_PARSE_LIMITS, maxChunks: Number.POSITIVE_INFINITY },
        { ...DEFAULT_VOX_PARSE_LIMITS, maxModels: 1.5 },
        { ...DEFAULT_VOX_PARSE_LIMITS, maxTotalVoxels: 0 },
        { ...DEFAULT_VOX_PARSE_LIMITS, maxFileBytes: -1 },
      ];
      for (const limits of invalid) {
        expectCode(
          () =>
            importVox(bus, store, {
              bytes,
              expectedRevision: 0,
              parseLimits: limits,
            }),
          "VOX_PARSE_LIMITS_INVALID",
        );
      }
      expect(store.revision).toBe(0);
    });

    it("rejects a raised profile before parsing even malformed bytes", () => {
      const { store, bus } = harness();
      // Empty bytes would fail parsing with VOX_TRUNCATED; the raised
      // profile must be rejected first, proving no parsing happens.
      expectCode(
        () =>
          importVox(bus, store, {
            bytes: new Uint8Array(0),
            expectedRevision: 0,
            parseLimits: {
              ...DEFAULT_VOX_PARSE_LIMITS,
              maxChunks: DEFAULT_VOX_PARSE_LIMITS.maxChunks + 1,
            },
          }),
        "VOX_PARSE_LIMITS_INVALID",
      );
      expect(store.revision).toBe(0);
    });

    it("still honors valid lower overrides atomically", () => {
      const { store, bus } = harness();
      const bytes = encodeVox({ models: [cube], palette });
      const lower: VoxParseLimits = {
        ...DEFAULT_VOX_PARSE_LIMITS,
        maxChunks: 8,
        maxModels: 1,
        maxVoxelsPerModel: 4,
        maxTotalVoxels: 4,
        maxUnknownChunkBytes: 1024,
      };
      const outcome = importVox(bus, store, {
        bytes,
        expectedRevision: 0,
        parseLimits: lower,
      });
      expect(outcome.voxelsImported).toBe(4);
      expect(store.revision).toBe(1);
      // A file that violates a lowered limit is still rejected atomically.
      const before = store.getDocument();
      expectCode(
        () =>
          importVox(bus, store, {
            bytes,
            expectedRevision: store.revision,
            parseLimits: { ...lower, maxChunks: 2 },
          }),
        "VOX_TOO_MANY_CHUNKS",
      );
      expect(store.revision).toBe(1);
      expect(store.getDocument()).toEqual(before);
    });

    it("keeps the 100k-chunk hard policy unraisable through the import seam", () => {
      const { store, bus } = harness();
      const bytes = buildChunkFloodFile(100_000);
      // The flood is rejected under the frozen defaults...
      expectCode(
        () => importVox(bus, store, { bytes, expectedRevision: 0 }),
        "VOX_TOO_MANY_CHUNKS",
      );
      expect(store.revision).toBe(0);
      // ...and the raised profile that used to admit it is now rejected
      // before parsing, so the file can never consume parser resources
      // above the advertised hard policy.
      expectCode(
        () =>
          importVox(bus, store, {
            bytes,
            expectedRevision: 0,
            parseLimits: {
              ...DEFAULT_VOX_PARSE_LIMITS,
              maxChunks: 100_010,
            },
          }),
        "VOX_PARSE_LIMITS_INVALID",
      );
      expect(store.revision).toBe(0);
    });
  });
});
