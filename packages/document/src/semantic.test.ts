import { describe, expect, it } from "vitest";
import { documentId, nodeId, volumeId } from "@voxel-maker/shared";
import {
  canonicalDocumentJson,
  createDocument,
  sha256Hex,
  type VoxelDocument,
} from "@voxel-maker/model";
import {
  CHUNK_VOXEL_COUNT,
  VoxelVolume,
  type VoxelVolumeReadView,
  type VoxelWriteCapability,
} from "@voxel-maker/voxel";
import {
  canonicalAssetSemanticBytes,
  canonicalAssetSemanticHash,
} from "./semantic.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const capability: VoxelWriteCapability = { __kind: "VoxelWriteCapability" };

const limits = {
  maxCoordinate: 1_048_575,
  maxExtent: 2_048,
  maxChunks: 262_144,
  maxOccupiedVoxels: 1_000_000,
  maxCoordinatesPerOperation: 1_000_000,
};

function demoDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:semantic:0001"),
    rootNodeId: nodeId("node:semantic:root"),
    nodes: [
      {
        nodeId: nodeId("node:semantic:root"),
        parentId: null,
        children: [],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:semantic:0001"),
          },
        ],
      },
    ],
    volumes: [
      { volumeId: volumeId("volume:semantic:0001") },
      { volumeId: volumeId("volume:semantic:0002") },
    ],
  });
}

function volumeWithChunks(): VoxelVolume {
  const volume = new VoxelVolume(
    "volume:semantic:0001" as never,
    limits,
    capability,
  );
  volume.setVoxel([0, 0, 0], 1, capability);
  volume.setVoxel([-1, 0, 1], 2, capability);
  return volume;
}

/**
 * Independent v1 chunk frame: u32le Volume ID byte length, UTF-8 Volume ID,
 * three i32le coordinates, u32le payload byte length, then exactly
 * CHUNK_VOXEL_COUNT unsigned-16 values little-endian (8,192 payload bytes).
 */
function frame(
  encoder: TextEncoder,
  volumeIdText: string,
  coordinate: readonly [number, number, number],
  values: Uint16Array,
): Uint8Array {
  const idBytes = encoder.encode(volumeIdText);
  const payload = new Uint8Array(CHUNK_VOXEL_COUNT * 2);
  const view = new DataView(payload.buffer);
  for (let index = 0; index < values.length; index += 1) {
    view.setUint16(index * 2, values[index] as number, true);
  }
  return new Uint8Array([
    ...u32le(idBytes.byteLength),
    ...idBytes,
    ...i32le(coordinate[0]),
    ...i32le(coordinate[1]),
    ...i32le(coordinate[2]),
    ...u32le(payload.byteLength),
    ...payload,
  ]);
}

describe("canonicalAssetSemanticBytes", () => {
  it("frames the document and sorted chunk streams exactly as ADR-0004", () => {
    const document = demoDocument();
    const volume = volumeWithChunks();
    const volumes = new Map([
      [volumeId("volume:semantic:0001"), volume],
      // Empty volume contributes no chunk frames.
      [
        volumeId("volume:semantic:0002"),
        new VoxelVolume("volume:semantic:0002" as never, limits, capability),
      ],
    ]);
    const bytes = canonicalAssetSemanticBytes(document, volumes);

    // Prefix: "vxl-semantic-v1\n" + u64le document byte length + document.
    const documentJson = canonicalDocumentJson(document);
    const encoder = new TextEncoder();
    const prefix = new Uint8Array([
      ...encoder.encode("vxl-semantic-v1\n"),
      ...u64le(BigInt(encoder.encode(documentJson).byteLength)),
      ...encoder.encode(documentJson),
    ]);

    // Chunk frames sorted by volume ID, then signed (x, y, z):
    //   volume:semantic:0001 < volume:semantic:0002 (code units)
    //   chunk (-1,0,0) < chunk (0,0,0)
    const chunkA = volume.getChunk([-1, 0, 0]);
    const chunkB = volume.getChunk([0, 0, 0]);
    expect(chunkA).toBeDefined();
    expect(chunkB).toBeDefined();
    const expected = new Uint8Array([
      ...prefix,
      ...frame(
        encoder,
        "volume:semantic:0001",
        [-1, 0, 0],
        chunkA as Uint16Array,
      ),
      ...frame(
        encoder,
        "volume:semantic:0001",
        [0, 0, 0],
        chunkB as Uint16Array,
      ),
    ]);
    expect(Buffer.from(bytes).equals(Buffer.from(expected))).toBe(true);
    expect(canonicalAssetSemanticHash(document, volumes)).toBe(
      sha256Hex(expected),
    );
  });

  it("frames every chunk payload at exactly 8192 bytes with no trailing zeros (issue #85)", () => {
    const document = demoDocument();
    const volume = volumeWithChunks();
    const volumes = new Map([[volumeId("volume:semantic:0001"), volume]]);
    const bytes = canonicalAssetSemanticBytes(document, volumes);

    // Prefix: "vxl-semantic-v1\n" + u64le document byte length + document.
    const encoder = new TextEncoder();
    const prefix = new Uint8Array([
      ...encoder.encode("vxl-semantic-v1\n"),
      ...u64le(
        BigInt(encoder.encode(canonicalDocumentJson(document)).byteLength),
      ),
      ...encoder.encode(canonicalDocumentJson(document)),
    ]);
    // Parse the first chunk frame from the produced bytes and assert the
    // frozen v1 payload length: 4096 unsigned-16 values = 8192 bytes. The
    // buggy implementation framed 16384 bytes (chunk.byteLength * 2) and
    // hashed 8192 spurious zero bytes.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = prefix.byteLength;
    const expectedFrameBytes: number[] = [];
    for (const coordinate of volume.chunkCoordinates()) {
      const volumeIdByteLength = view.getUint32(offset, true);
      offset += 4 + volumeIdByteLength;
      const coordinateBytes = [
        view.getInt32(offset, true),
        view.getInt32(offset + 4, true),
        view.getInt32(offset + 8, true),
      ];
      offset += 12;
      const payloadByteLength = view.getUint32(offset, true);
      offset += 4;
      expect(payloadByteLength).toBe(CHUNK_VOXEL_COUNT * 2);
      // The frozen v1 contract fixes the payload at 8,192 bytes
      // (vxl-v1.md); the literal anchors the golden to that number even
      // if the shared constant ever changes.
      expect(payloadByteLength).toBe(8192);
      // The payload region holds the chunk's non-empty voxel values at
      // their X-fastest little-endian positions; everything after the
      // advertised payload must not exist.
      const payload = bytes.subarray(offset, offset + payloadByteLength);
      expect(payload.byteLength).toBe(CHUNK_VOXEL_COUNT * 2);
      const chunkValues = volume.getChunk(coordinate) as Uint16Array;
      const payloadView = new DataView(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength,
      );
      for (let index = 0; index < chunkValues.length; index += 1) {
        const value = chunkValues[index] as number;
        if (value !== 0) {
          expect(payloadView.getUint16(index * 2, true)).toBe(value);
        }
      }
      expectedFrameBytes.push(
        4 + volumeIdByteLength + 12 + 4 + payloadByteLength,
      );
      offset += payloadByteLength;
      expect(coordinateBytes).toEqual([...coordinate]);
    }
    expect(offset).toBe(bytes.byteLength);
    expect(bytes.byteLength).toBe(
      prefix.byteLength + expectedFrameBytes.reduce((a, b) => a + b, 0),
    );

    // The hash matches an independently constructed v1 golden (each chunk
    // framed at exactly 8,192 payload bytes).
    const chunkA = volume.getChunk([-1, 0, 0]);
    const chunkB = volume.getChunk([0, 0, 0]);
    expect(chunkA).toBeDefined();
    expect(chunkB).toBeDefined();
    const expected = new Uint8Array([
      ...prefix,
      ...frame(
        encoder,
        "volume:semantic:0001",
        [-1, 0, 0],
        chunkA as Uint16Array,
      ),
      ...frame(
        encoder,
        "volume:semantic:0001",
        [0, 0, 0],
        chunkB as Uint16Array,
      ),
    ]);
    expect(Buffer.from(bytes).equals(Buffer.from(expected))).toBe(true);
    expect(canonicalAssetSemanticHash(document, volumes)).toBe(
      sha256Hex(expected),
    );
  });

  it("orders non-BMP volume IDs by Unicode scalar sequence, not UTF-16 code units", () => {
    // Two volumes whose IDs share a prefix and diverge at the final scalar:
    // "volume:u:\uE000" (BMP scalar U+E000) and "volume:u:\u{10000}"
    // (non-BMP scalar U+10000). UTF-16 code-unit order would put U+10000
    // first (its high surrogate 0xD800 sorts below 0xE000); the frozen
    // ADR-0004/vxl-v1 rule sorts volume IDs by Unicode scalar sequence,
    // which puts U+E000 first (issue #87).
    const lowId = "volume:u:\uE000";
    const highId = "volume:u:\u{10000}";
    const document = createDocument({
      documentId: documentId("document:semantic:0002"),
      rootNodeId: nodeId("node:semantic:root"),
      nodes: [
        {
          nodeId: nodeId("node:semantic:root"),
          parentId: null,
          children: [nodeId("node:semantic:low"), nodeId("node:semantic:high")],
          transform: identity,
          components: [],
        },
        {
          nodeId: nodeId("node:semantic:low"),
          parentId: nodeId("node:semantic:root"),
          children: [],
          transform: identity,
          components: [
            { kind: "voxel", schemaVersion: 1, volumeId: volumeId(lowId) },
          ],
        },
        {
          nodeId: nodeId("node:semantic:high"),
          parentId: nodeId("node:semantic:root"),
          children: [],
          transform: identity,
          components: [
            { kind: "voxel", schemaVersion: 1, volumeId: volumeId(highId) },
          ],
        },
      ],
      volumes: [{ volumeId: volumeId(lowId) }, { volumeId: volumeId(highId) }],
    });
    const makeVolume = (id: string): VoxelVolume => {
      const volume = new VoxelVolume(id as never, limits, capability);
      volume.setVoxel([0, 0, 0], 1, capability);
      return volume;
    };
    const volumes = new Map([
      [volumeId(lowId), makeVolume(lowId)],
      [volumeId(highId), makeVolume(highId)],
    ]);
    const bytes = canonicalAssetSemanticBytes(document, volumes);

    const encoder = new TextEncoder();
    const documentJson = canonicalDocumentJson(document);
    const prefix = new Uint8Array([
      ...encoder.encode("vxl-semantic-v1\n"),
      ...u64le(BigInt(encoder.encode(documentJson).byteLength)),
      ...encoder.encode(documentJson),
    ]);
    const lowChunk = volumes.get(volumeId(lowId))?.getChunk([0, 0, 0]);
    const highChunk = volumes.get(volumeId(highId))?.getChunk([0, 0, 0]);
    expect(lowChunk).toBeDefined();
    expect(highChunk).toBeDefined();
    // Independent scalar-order golden: U+E000 frame first, U+10000 second.
    const expected = new Uint8Array([
      ...prefix,
      ...frame(encoder, lowId, [0, 0, 0], lowChunk as Uint16Array),
      ...frame(encoder, highId, [0, 0, 0], highChunk as Uint16Array),
    ]);
    expect(Buffer.from(bytes).equals(Buffer.from(expected))).toBe(true);
    expect(canonicalAssetSemanticHash(document, volumes)).toBe(
      sha256Hex(expected),
    );
  });

  it("rejects chunk read views that are not exactly 4096 unsigned-16 values (issue #85)", () => {
    const document = demoDocument();
    const malformed: VoxelVolumeReadView = {
      volumeId: "volume:semantic:0001" as never,
      limits,
      getVoxel: () => 0 as never,
      getChunk: () => new Uint16Array(3),
      chunkCount: () => 1,
      chunkCoordinates: () => [[0, 0, 0]],
      occupiedCount: () => 1,
      occupiedBounds: () => undefined,
    };
    expect(() =>
      canonicalAssetSemanticBytes(
        document,
        new Map([["volume:semantic:0001" as never, malformed]]),
      ),
    ).toThrowError(/exactly/);
  });

  it("is stable across identical content and ignores runtime chunk revisions", () => {
    const document = demoDocument();
    const first = volumeWithChunks();
    const second = volumeWithChunks();
    // Mutating session state (a set that restores the same value is a no-op,
    // so touch a different voxel and remove it again) must not change the
    // semantic hash because only committed content is hashed.
    first.setVoxel([5, 5, 5], 3, capability);
    first.removeVoxel([5, 5, 5], capability);
    const a = canonicalAssetSemanticBytes(
      document,
      new Map([["volume:semantic:0001" as never, first]]),
    );
    const b = canonicalAssetSemanticBytes(
      document,
      new Map([["volume:semantic:0001" as never, second]]),
    );
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

function u64le(value: bigint): number[] {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return [...out];
}

function u32le(value: number): number[] {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return [...out];
}

function i32le(value: number): number[] {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return [...out];
}
