import { WorkspaceError, type VolumeId } from "@voxel-maker/shared";
import {
  CHUNK_EDGE,
  CHUNK_VOXEL_COUNT,
  type VoxelChunkSeed,
  type VoxelVolumeLimits,
  type VoxelVolumeReadView,
} from "@voxel-maker/voxel";
import { crc32 } from "./crc32.js";

/**
 * Version 1 sparse voxel volume binary (plan S5.3, ADR-0004): a fixed
 * header, a coordinate-sorted chunk table, and little-endian unsigned-16
 * payloads. One file per volume lives at `voxels/<volume-id>.bin` inside the
 * container. The payload bytes are exactly the ADR-0004 chunk stream bytes,
 * so the semantic hash can reuse them without re-encoding.
 *
 * Layout (all integers little-endian):
 *   offset  size  field
 *   0       4     magic "VXLV" (0x564C5856)
 *   4       4     chunk encoding version (1)
 *   8       4     chunk edge (16)
 *   12      4     material width in bytes (2)
 *   16      4     codec (1 = raw u16 X-fastest)
 *   20      4     chunk count
 *   24      4     reserved (0)
 *   28      28*N  chunk records, sorted by (x, y, z):
 *                   0..12   x, y, z as signed 32-bit
 *                   12..20  payload offset as unsigned 64-bit
 *                   20..24  payload byte length (8192)
 *                   24..28  CRC-32 of the payload
 *   28+28*N 8192*N payloads: 4096 unsigned-16 values, X-fastest order
 */

export const VXL_VOLUME_MAGIC = 0x564c_5856;
export const VXL_VOLUME_HEADER_BYTES = 28;
export const VXL_VOLUME_CHUNK_RECORD_BYTES = 28;
export const VXL_VOLUME_CHUNK_PAYLOAD_BYTES = CHUNK_VOXEL_COUNT * 2;

const CODEC_RAW_U16 = 1;

const compareVec3i = (a: readonly number[], b: readonly number[]): number =>
  (a[0] as number) - (b[0] as number) ||
  (a[1] as number) - (b[1] as number) ||
  (a[2] as number) - (b[2] as number);

/** Encodes one volume into the v1 binary; chunks are emitted sorted. */
export function encodeVoxelVolume(volume: VoxelVolumeReadView): Uint8Array {
  const coordinates = volume.chunkCoordinates();
  const chunkCount = coordinates.length;
  const tableBytes = VXL_VOLUME_CHUNK_RECORD_BYTES * chunkCount;
  const payloadBytes = VXL_VOLUME_CHUNK_PAYLOAD_BYTES * chunkCount;
  const out = new Uint8Array(
    VXL_VOLUME_HEADER_BYTES + tableBytes + payloadBytes,
  );
  const view = new DataView(out.buffer);
  view.setUint32(0, VXL_VOLUME_MAGIC, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, CHUNK_EDGE, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, CODEC_RAW_U16, true);
  view.setUint32(20, chunkCount, true);
  view.setUint32(24, 0, true);
  let cursor = VXL_VOLUME_HEADER_BYTES;
  coordinates.forEach((coordinate, index) => {
    const chunk = volume.getChunk(coordinate);
    if (chunk === undefined) {
      throw new WorkspaceError({
        family: "internal",
        code: "MISSING_CHUNK",
        message: "Volume chunk disappeared while encoding",
        context: { coordinate },
      });
    }
    const offset =
      VXL_VOLUME_HEADER_BYTES +
      tableBytes +
      index * VXL_VOLUME_CHUNK_PAYLOAD_BYTES;
    view.setInt32(cursor, coordinate[0], true);
    view.setInt32(cursor + 4, coordinate[1], true);
    view.setInt32(cursor + 8, coordinate[2], true);
    view.setBigUint64(cursor + 12, BigInt(offset), true);
    view.setUint32(cursor + 20, VXL_VOLUME_CHUNK_PAYLOAD_BYTES, true);
    const payloadStart = offset;
    const payloadEnd = payloadStart + VXL_VOLUME_CHUNK_PAYLOAD_BYTES;
    for (let i = 0; i < chunk.length; i += 1) {
      view.setUint16(payloadStart + i * 2, chunk[i] as number, true);
    }
    view.setUint32(
      cursor + 24,
      crc32(out.subarray(payloadStart, payloadEnd)),
      true,
    );
    cursor += VXL_VOLUME_CHUNK_RECORD_BYTES;
  });
  return out;
}

/**
 * Decodes and preflights a v1 volume binary (plan S5.4). Validates magic,
 * encoding version, geometry constants, codec, exact size, sorted non-empty
 * chunk table, in-domain coordinates, sequential offsets, and per-chunk
 * CRC-32 before returning copied chunk seeds. `volumeId` is supplied by the
 * caller (from the manifest index) and is not part of the binary.
 */
export function decodeVoxelVolume(
  bytes: Uint8Array,
  volumeId: VolumeId,
  limits: VoxelVolumeLimits,
): readonly VoxelChunkSeed[] {
  if (bytes.byteLength < VXL_VOLUME_HEADER_BYTES) {
    throw volumeError(
      "TRUNCATED_VOLUME",
      "Volume binary is shorter than its header",
      { volumeId },
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== VXL_VOLUME_MAGIC) {
    throw volumeError(
      "INVALID_VOLUME_MAGIC",
      "Volume binary magic is missing",
      { volumeId },
    );
  }
  const version = view.getUint32(4, true);
  if (version !== 1) {
    throw new WorkspaceError({
      family: "compatibility",
      code: "UNSUPPORTED_CHUNK_ENCODING_VERSION",
      message:
        "Chunk encoding version is newer than the supported version 1; refusing to guess at unknown data",
      context: { volumeId, version },
    });
  }
  const chunkEdge = view.getUint32(8, true);
  const materialWidth = view.getUint32(12, true);
  const codec = view.getUint32(16, true);
  const reserved = view.getUint32(24, true);
  if (
    chunkEdge !== CHUNK_EDGE ||
    materialWidth !== 2 ||
    codec !== CODEC_RAW_U16 ||
    reserved !== 0
  ) {
    throw new WorkspaceError({
      family: "compatibility",
      code: "UNSUPPORTED_CHUNK_ENCODING_VERSION",
      message: "Volume binary uses unsupported v1 geometry or codec fields",
      context: { volumeId, chunkEdge, materialWidth, codec, reserved },
    });
  }
  const chunkCount = view.getUint32(20, true);
  if (chunkCount > limits.maxChunks) {
    throw new WorkspaceError({
      family: "limit",
      code: "TOO_MANY_CHUNKS",
      message: "Volume exceeds its non-empty chunk limit",
      context: { volumeId, requested: chunkCount, limit: limits.maxChunks },
    });
  }
  const expectedLength =
    VXL_VOLUME_HEADER_BYTES +
    VXL_VOLUME_CHUNK_RECORD_BYTES * chunkCount +
    VXL_VOLUME_CHUNK_PAYLOAD_BYTES * chunkCount;
  if (bytes.byteLength !== expectedLength) {
    throw volumeError(
      "TRUNCATED_VOLUME",
      "Volume binary length does not match its chunk table",
      {
        volumeId,
        actual: bytes.byteLength,
        expected: expectedLength,
      },
    );
  }
  const minChunk = -Math.ceil(limits.maxCoordinate / CHUNK_EDGE);
  const maxChunk = Math.floor(limits.maxCoordinate / CHUNK_EDGE);
  const seeds: VoxelChunkSeed[] = [];
  let previous: readonly [number, number, number] | undefined;
  for (let index = 0; index < chunkCount; index += 1) {
    const recordOffset =
      VXL_VOLUME_HEADER_BYTES + index * VXL_VOLUME_CHUNK_RECORD_BYTES;
    const coordinate: [number, number, number] = [
      view.getInt32(recordOffset, true),
      view.getInt32(recordOffset + 4, true),
      view.getInt32(recordOffset + 8, true),
    ];
    for (const component of coordinate) {
      if (component < minChunk || component > maxChunk) {
        throw new WorkspaceError({
          family: "validation",
          code: "INVALID_CHUNK_COORDINATE",
          message: "Volume chunk coordinate is outside the coordinate domain",
          context: { volumeId, coordinate },
        });
      }
    }
    if (previous !== undefined && compareVec3i(previous, coordinate) >= 0) {
      throw volumeError(
        "UNORDERED_CHUNK_TABLE",
        "Volume chunk table must be strictly sorted by X, then Y, then Z",
        {
          volumeId,
          coordinate,
        },
      );
    }
    previous = coordinate;
    const expectedOffset =
      VXL_VOLUME_HEADER_BYTES +
      VXL_VOLUME_CHUNK_RECORD_BYTES * chunkCount +
      index * VXL_VOLUME_CHUNK_PAYLOAD_BYTES;
    const offset = Number(view.getBigUint64(recordOffset + 12, true));
    const byteLength = view.getUint32(recordOffset + 20, true);
    const checksum = view.getUint32(recordOffset + 24, true);
    if (
      // Reject the lossy u64 -> Number conversion before any comparison:
      // a hostile offset above 2^53 must not be silently rounded.
      !Number.isSafeInteger(offset) ||
      offset !== expectedOffset ||
      byteLength !== VXL_VOLUME_CHUNK_PAYLOAD_BYTES
    ) {
      throw volumeError(
        "INVALID_CHUNK_OFFSET",
        "Volume chunk offset or length is inconsistent with the v1 layout",
        {
          volumeId,
          coordinate,
          offset,
          byteLength,
        },
      );
    }
    const payload = bytes.subarray(
      offset,
      offset + VXL_VOLUME_CHUNK_PAYLOAD_BYTES,
    );
    if (crc32(payload) !== checksum) {
      throw volumeError(
        "CRC_MISMATCH",
        "Volume chunk checksum does not match its content",
        {
          volumeId,
          coordinate,
        },
      );
    }
    const values = new Uint16Array(CHUNK_VOXEL_COUNT);
    for (let i = 0; i < CHUNK_VOXEL_COUNT; i += 1) {
      values[i] = view.getUint16(offset + i * 2, true);
    }
    seeds.push({ coordinate, values });
  }
  return seeds;
}

const volumeError = (
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>>,
): WorkspaceError =>
  new WorkspaceError({
    family: "io",
    code,
    message,
    context: context as never,
  });
