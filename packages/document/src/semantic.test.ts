import { describe, expect, it } from "vitest";
import { documentId, nodeId, volumeId } from "@voxel-maker/shared";
import {
  canonicalDocumentJson,
  createDocument,
  sha256Hex,
  type VoxelDocument,
} from "@voxel-maker/model";
import { VoxelVolume, type VoxelWriteCapability } from "@voxel-maker/voxel";
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
    const frame = (
      volumeIdText: string,
      coordinate: readonly [number, number, number],
      values: Uint16Array,
    ): Uint8Array => {
      const idBytes = encoder.encode(volumeIdText);
      const payload = new Uint8Array(values.byteLength * 2);
      const view = new DataView(payload.buffer);
      for (let i = 0; i < values.length; i += 1) {
        view.setUint16(i * 2, values[i] as number, true);
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
    };
    const expected = new Uint8Array([
      ...prefix,
      ...frame("volume:semantic:0001", [-1, 0, 0], chunkA as Uint16Array),
      ...frame("volume:semantic:0001", [0, 0, 0], chunkB as Uint16Array),
    ]);
    expect(Buffer.from(bytes).equals(Buffer.from(expected))).toBe(true);
    expect(canonicalAssetSemanticHash(document, volumes)).toBe(
      sha256Hex(expected),
    );
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
