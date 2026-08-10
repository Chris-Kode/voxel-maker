import { describe, expect, it } from "vitest";
import { volumeId } from "@voxel-maker/shared";
import {
  CHUNK_VOXEL_COUNT,
  VoxelVolume,
  type VoxelWriteCapability,
} from "@voxel-maker/voxel";
import { seedReadView } from "./container.js";
import {
  decodeVoxelVolume,
  encodeVoxelVolume,
  VXL_VOLUME_CHUNK_PAYLOAD_BYTES,
  VXL_VOLUME_CHUNK_RECORD_BYTES,
  VXL_VOLUME_HEADER_BYTES,
  VXL_VOLUME_MAGIC,
} from "./volume-binary.js";

const capability: VoxelWriteCapability = { __kind: "VoxelWriteCapability" };
const VID = volumeId("volume:test:0001");
const limits = {
  maxCoordinate: 1_048_575,
  maxExtent: 2_048,
  maxChunks: 262_144,
  maxOccupiedVoxels: 1_000_000,
  maxCoordinatesPerOperation: 1_000_000,
};

function volume(): VoxelVolume {
  const volume = new VoxelVolume(
    "volume:test:0001" as never,
    limits,
    capability,
  );
  volume.setVoxel([0, 0, 0], 1, capability);
  volume.setVoxel([-1, 0, 1], 2, capability);
  volume.setVoxel([100, -50, 7], 3, capability);
  return volume;
}

function expectSameSeeds(
  actual: readonly {
    coordinate: readonly [number, number, number];
    values: Uint16Array;
  }[],
  expected: VoxelVolume,
): void {
  expect(actual.length).toBe(expected.chunkCount());
  for (const seed of actual) {
    const chunk = expected.getChunk(seed.coordinate);
    expect(chunk).toBeDefined();
    expect(seed.values.join(",")).toBe(chunk?.join(","));
  }
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

/**
 * Encodes a hand-crafted chunk list into a v1 binary (the live encoder
 * never holds an empty chunk, so limit-rejection fixtures must be built
 * from raw seeds). Occupancy and bounds come from `seedReadView`, the
 * same read surface the container reader uses after decoding.
 */
function binaryWithChunks(
  chunks: readonly {
    coordinate: readonly [number, number, number];
    values: Readonly<Record<number, number>>;
  }[],
): Uint8Array {
  const seeds = chunks.map((chunk) => {
    const values = new Uint16Array(CHUNK_VOXEL_COUNT);
    for (const [index, value] of Object.entries(chunk.values)) {
      values[Number(index)] = value;
    }
    return { coordinate: chunk.coordinate, values };
  });
  return encodeVoxelVolume(seedReadView(VID, seeds));
}

describe("voxel volume binary codec", () => {
  it("round-trips sorted chunks with little-endian payloads", () => {
    const source = volume();
    const bytes = encodeVoxelVolume(source);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(VXL_VOLUME_MAGIC);
    expect(view.getUint32(4, true)).toBe(1);
    expect(view.getUint32(8, true)).toBe(16);
    expect(view.getUint32(12, true)).toBe(2);
    expect(view.getUint32(16, true)).toBe(1);
    expect(view.getUint32(20, true)).toBe(3);
    const seeds = decodeVoxelVolume(bytes, VID, limits);
    expect(seeds.map((seed) => seed.coordinate)).toEqual([
      [-1, 0, 0],
      [0, 0, 0],
      [6, -4, 0],
    ]);
    expectSameSeeds(seeds, source);
    // Byte-level spot check: chunk (0,0,0) is the second table entry, and
    // its first payload value (voxel 0,0,0) is material 1 little-endian.
    const chunkOffset =
      VXL_VOLUME_HEADER_BYTES +
      VXL_VOLUME_CHUNK_RECORD_BYTES * 3 +
      VXL_VOLUME_CHUNK_PAYLOAD_BYTES;
    expect(view.getUint16(chunkOffset, true)).toBe(1);
    expect(view.getUint8(chunkOffset)).toBe(1);
    expect(view.getUint8(chunkOffset + 1)).toBe(0);
  });

  it("encodes an empty volume with zero chunks", () => {
    const empty = new VoxelVolume(
      "volume:test:0001" as never,
      limits,
      capability,
    );
    const bytes = encodeVoxelVolume(empty);
    expect(bytes.byteLength).toBe(28);
    expect(decodeVoxelVolume(bytes, VID, limits)).toEqual([]);
  });

  it("is byte-deterministic for identical content", () => {
    const a = encodeVoxelVolume(volume());
    const b = encodeVoxelVolume(volume());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("rejects bad magic, versions, and lengths", () => {
    const bytes = encodeVoxelVolume(volume());
    const badMagic = bytes.slice();
    new DataView(badMagic.buffer).setUint32(0, 0x1234_5678, true);
    expectErrorCode(
      () => decodeVoxelVolume(badMagic, VID, limits),
      "INVALID_VOLUME_MAGIC",
    );
    const badVersion = bytes.slice();
    new DataView(badVersion.buffer).setUint32(4, 2, true);
    expectErrorCode(
      () => decodeVoxelVolume(badVersion, VID, limits),
      "UNSUPPORTED_CHUNK_ENCODING_VERSION",
    );
    expectErrorCode(
      () => decodeVoxelVolume(bytes.subarray(0, 10), VID, limits),
      "TRUNCATED_VOLUME",
    );
    expectErrorCode(
      () =>
        decodeVoxelVolume(bytes.slice(0, bytes.byteLength - 1), VID, limits),
      "TRUNCATED_VOLUME",
    );
  });

  it("rejects chunk CRC mismatches", () => {
    const bytes = encodeVoxelVolume(volume());
    const corrupt = bytes.slice();
    const crcByte =
      VXL_VOLUME_HEADER_BYTES + VXL_VOLUME_CHUNK_RECORD_BYTES * 3 - 1;
    corrupt[crcByte] = (corrupt[crcByte] as number) ^ 0xff;
    expectErrorCode(
      () => decodeVoxelVolume(corrupt, VID, limits),
      "CRC_MISMATCH",
    );
  });

  it("rejects unordered tables and out-of-domain coordinates", () => {
    const bytes = encodeVoxelVolume(volume());
    const unordered = bytes.slice();
    // Swap the first two chunk records' X coordinates: record 0 becomes (1)
    // and record 1 becomes (-1), so the table order is no longer strict.
    const dv = new DataView(unordered.buffer);
    dv.setInt32(28, 1, true);
    dv.setInt32(28 + VXL_VOLUME_CHUNK_RECORD_BYTES, -1, true);
    expectErrorCode(
      () => decodeVoxelVolume(unordered, VID, limits),
      "UNORDERED_CHUNK_TABLE",
    );
    const outOfDomain = bytes.slice();
    new DataView(outOfDomain.buffer).setInt32(28, 2_000_000, true);
    expectErrorCode(
      () => decodeVoxelVolume(outOfDomain, VID, limits),
      "INVALID_CHUNK_COORDINATE",
    );
  });

  it("rejects payloads of the wrong byte length", () => {
    const bytes = encodeVoxelVolume(volume());
    const badLength = bytes.slice();
    // Claim 10 bytes for the first chunk payload; the layout check then
    // fails before allocation.
    new DataView(badLength.buffer).setUint32(28 + 20, 10, true);
    expectErrorCode(
      () => decodeVoxelVolume(badLength, VID, limits),
      "INVALID_CHUNK_OFFSET",
    );
  });

  it("rejects chunk offsets beyond the safe integer domain", () => {
    // One chunk record whose u64 payload offset claims 2^64-1: the reader
    // must reject the lossy u64->Number conversion before any comparison.
    const bytes = new Uint8Array(
      VXL_VOLUME_HEADER_BYTES +
        VXL_VOLUME_CHUNK_RECORD_BYTES +
        VXL_VOLUME_CHUNK_PAYLOAD_BYTES,
    );
    const view = new DataView(bytes.buffer);
    view.setUint32(0, VXL_VOLUME_MAGIC, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, 16, true);
    view.setUint32(12, 2, true);
    view.setUint32(16, 1, true);
    view.setUint32(20, 1, true);
    view.setUint32(24, 0, true);
    view.setBigUint64(
      VXL_VOLUME_HEADER_BYTES + 12,
      0xffff_ffff_ffff_ffffn,
      true,
    );
    view.setUint32(
      VXL_VOLUME_HEADER_BYTES + 20,
      VXL_VOLUME_CHUNK_PAYLOAD_BYTES,
      true,
    );
    expectErrorCode(
      () => decodeVoxelVolume(bytes, VID, limits),
      "INVALID_CHUNK_OFFSET",
    );
  });

  it("enforces the chunk count limit before returning data", () => {
    const bytes = encodeVoxelVolume(volume());
    expectErrorCode(
      () => decodeVoxelVolume(bytes, VID, { ...limits, maxChunks: 2 }),
      "TOO_MANY_CHUNKS",
    );
  });

  it("rejects empty chunk records (issue #100)", () => {
    // The v1 format omits empty chunks (plan S5.3 / ADR-0004), so a
    // record whose payload is entirely zero is a hostile or corrupt
    // table: the reader must reject it with the canonical code instead of
    // handing an empty seed to the installer.
    const bytes = binaryWithChunks([{ coordinate: [0, 0, 0], values: {} }]);
    expectErrorCode(() => decodeVoxelVolume(bytes, VID, limits), "EMPTY_CHUNK");
  });

  it("enforces the occupied-voxel limit before returning seeds (issue #100)", () => {
    const bytes = binaryWithChunks([
      { coordinate: [0, 0, 0], values: { 0: 1 } },
      { coordinate: [1, 0, 0], values: { 0: 1 } },
    ]);
    expectErrorCode(
      () => decodeVoxelVolume(bytes, VID, { ...limits, maxOccupiedVoxels: 1 }),
      "TOO_MANY_OCCUPIED_VOXELS",
    );
    // At the limit exactly the volume still loads.
    const seeds = decodeVoxelVolume(bytes, VID, {
      ...limits,
      maxOccupiedVoxels: 2,
    });
    expect(seeds.length).toBe(2);
  });

  it("enforces the occupied extent limit before returning seeds (issue #100)", () => {
    // Voxels at x=0 and x=16 span an occupied extent of 16 (max - min),
    // mirroring the VoxelVolume.fromChunks extent semantics.
    const bytes = binaryWithChunks([
      { coordinate: [0, 0, 0], values: { 0: 1 } },
      { coordinate: [1, 0, 0], values: { 0: 1 } },
    ]);
    expectErrorCode(
      () => decodeVoxelVolume(bytes, VID, { ...limits, maxExtent: 10 }),
      "EXTENT_LIMIT_EXCEEDED",
    );
    // Extent exactly at the limit is accepted, matching the installer.
    const seeds = decodeVoxelVolume(bytes, VID, {
      ...limits,
      maxExtent: 16,
    });
    expect(seeds.length).toBe(2);
  });

  it("rejects an empty chunk before later occupancy could pass (issue #100)", () => {
    const bytes = binaryWithChunks([
      { coordinate: [0, 0, 0], values: { 0: 1 } },
      { coordinate: [1, 0, 0], values: {} },
    ]);
    expectErrorCode(() => decodeVoxelVolume(bytes, VID, limits), "EMPTY_CHUNK");
  });
});
