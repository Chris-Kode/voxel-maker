import {
  canonicalSemanticBytes,
  sha256Hex,
  type VoxelDocument,
} from "@voxel-maker/model";
import { WorkspaceError, type VolumeId } from "@voxel-maker/shared";
import {
  CHUNK_VOXEL_COUNT,
  type VoxelVolumeReadView,
} from "@voxel-maker/voxel";

const encoder = new TextEncoder();

/** Unicode code unit comparison (RFC 8785 member order). */
const compareCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * ADR-0004 canonical semantic bytes for a whole asset: the document framing
 * from `@voxel-maker/model` followed by each non-empty chunk of every
 * volume, volumes sorted by Volume ID Unicode scalar sequence and chunks by
 * signed (x, y, z). Each chunk frame is: unsigned 32-bit little-endian
 * Volume ID byte length, UTF-8 Volume ID, three signed 32-bit little-endian
 * coordinates, unsigned 32-bit little-endian chunk byte length, then all
 * 4096 unsigned-16 voxel values in X-fastest little-endian order. Lengths
 * and coordinates are range-checked before encoding. Timestamps,
 * compression, previews, runtime chunk revisions, history, and recovery
 * data are excluded from identity.
 */
export function canonicalAssetSemanticBytes(
  document: VoxelDocument,
  volumes: ReadonlyMap<VolumeId, VoxelVolumeReadView>,
): Uint8Array {
  const documentBytes = canonicalSemanticBytes(document);
  const chunks: Array<{
    readonly volumeId: string;
    readonly volumeIdBytes: Uint8Array;
    readonly coordinate: readonly [number, number, number];
    readonly payload: Uint8Array;
  }> = [];
  let chunksBytes = 0;
  const volumeIds = Object.keys(document.volumes).sort(compareCodeUnit);
  for (const volumeId of volumeIds) {
    const volume = volumes.get(volumeId as VolumeId);
    if (volume === undefined) continue;
    const volumeIdBytes = encoder.encode(volumeId);
    if (volumeIdBytes.byteLength > 0xffff_ffff) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_ID",
        message: "Volume ID is too long to frame",
        context: { volumeId },
      });
    }
    for (const coordinate of volume.chunkCoordinates()) {
      for (const component of coordinate) {
        if (
          !Number.isInteger(component) ||
          component < -0x8000_0000 ||
          component > 0x7fff_ffff
        ) {
          throw new WorkspaceError({
            family: "validation",
            code: "INVALID_CHUNK_COORDINATE",
            message: "Chunk coordinate cannot be framed as signed 32-bit",
            context: { volumeId, coordinate },
          });
        }
      }
      const chunk = volume.getChunk(coordinate);
      if (chunk === undefined) continue;
      // The frozen v1 frame carries exactly 4096 unsigned-16 values
      // (8,192 bytes); a chunk of any other size cannot be hashed
      // compatibly and is rejected before allocation (issue #85).
      if (chunk.byteLength !== CHUNK_VOXEL_COUNT * 2) {
        throw new WorkspaceError({
          family: "validation",
          code: "INVALID_CHUNK_LENGTH",
          message: `Chunk payload must hold exactly ${String(CHUNK_VOXEL_COUNT)} unsigned 16-bit voxels`,
          context: { volumeId, coordinate },
        });
      }
      const payload = new Uint8Array(chunk.byteLength);
      const view = new DataView(payload.buffer);
      for (let index = 0; index < chunk.length; index += 1) {
        view.setUint16(index * 2, chunk[index] as number, true);
      }
      chunks.push({
        volumeId,
        volumeIdBytes,
        coordinate: [coordinate[0], coordinate[1], coordinate[2]],
        payload,
      });
      chunksBytes += 4 + volumeIdBytes.byteLength + 12 + 4 + payload.byteLength;
    }
  }
  const out = new Uint8Array(documentBytes.byteLength + chunksBytes);
  out.set(documentBytes, 0);
  const view = new DataView(out.buffer);
  let offset = documentBytes.byteLength;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.volumeIdBytes.byteLength, true);
    offset += 4;
    out.set(chunk.volumeIdBytes, offset);
    offset += chunk.volumeIdBytes.byteLength;
    view.setInt32(offset, chunk.coordinate[0], true);
    view.setInt32(offset + 4, chunk.coordinate[1], true);
    view.setInt32(offset + 8, chunk.coordinate[2], true);
    offset += 12;
    view.setUint32(offset, chunk.payload.byteLength, true);
    offset += 4;
    out.set(chunk.payload, offset);
    offset += chunk.payload.byteLength;
  }
  return out;
}

/** SHA-256 over `canonicalAssetSemanticBytes`; the semantic identity of a saved asset. */
export function canonicalAssetSemanticHash(
  document: VoxelDocument,
  volumes: ReadonlyMap<VolumeId, VoxelVolumeReadView>,
): string {
  return sha256Hex(canonicalAssetSemanticBytes(document, volumes));
}
