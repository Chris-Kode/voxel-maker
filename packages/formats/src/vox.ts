import { WorkspaceError } from "@voxel-maker/shared";
import {
  DEFAULT_VOX_PARSE_LIMITS,
  type VoxColor,
  type VoxModel,
  type VoxParseLimits,
  type VoxParseResult,
  type VoxUnknownChunk,
  type VoxVoxel,
  type VoxWarning,
} from "./vox-types.js";
import type { VoxEncodeInput } from "./vox-types.js";
import { VOX_DEFAULT_PALETTE } from "./vox-palette.js";

/**
 * MagicaVoxel VOX version-150 codec (ADR-0011, plan S8.1/S8.2/S8.4,
 * ticket #24). The parser is defensive and bounded: every declared length
 * is checked against the remaining bytes before any allocation, chunk
 * counts and voxel counts are capped, and any malformed structure rejects
 * the whole file atomically. The encoder is deterministic: models keep
 * input order, voxels are sorted, and the palette is written verbatim.
 *
 * File layout (little-endian):
 *   offset  size  field
 *   0       4     magic "VOX "
 *   4       4     version (150)
 *   8       ...   chunks: id(4) + contentSize(4) + childrenSize(4) + content + children
 *
 * Supported chunks: MAIN (root), optional PACK, paired SIZE/XYZI, optional
 * RGBA. Palette index 0 is empty; RGBA content maps bytes [0..1020) to
 * indices 1..255 and bytes [1020..1024) to index 0. Unknown chunks are
 * skipped only when their declared lengths are structurally valid.
 */

export const VOX_MAGIC = "VOX ";
export const VOX_VERSION = 150;
export const VOX_PALETTE_ENTRIES = 256;
export const VOX_RGBA_CHUNK_BYTES = VOX_PALETTE_ENTRIES * 4;
export const VOX_MAX_AXIS_SIZE = 256;
export const VOX_MAX_COLOR_INDEX = 255;

const CHUNK_HEADER_BYTES = 12;
const SIZE_CHUNK_BYTES = 12;
const XYZI_HEADER_BYTES = 4;
const PACK_CHUNK_BYTES = 4;

/** Extension chunk families reported but not interpreted (ADR-0011). */
const SCENE_GRAPH_CHUNK_PREFIXES = new Set([
  "nTRN",
  "nGRP",
  "nSHP",
  "LAYR",
  "MATL",
  "MATT",
  "rOBJ",
  "rCAM",
  "NOTE",
  "IMAP",
]);

const sceneGraphChunk = (id: string): boolean =>
  SCENE_GRAPH_CHUNK_PREFIXES.has(id);

function voxError(
  family: "validation" | "compatibility" | "limit" | "internal",
  code: string,
  message: string,
  context?: Readonly<Record<string, import("@voxel-maker/shared").JsonValue>>,
): WorkspaceError {
  return new WorkspaceError({
    family,
    code,
    message,
    ...(context === undefined ? {} : { context }),
  });
}

interface ChunkHeader {
  readonly id: string;
  readonly contentSize: number;
  readonly childrenSize: number;
}

/** Bounded reader over the input bytes. */
class VoxReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset: number;
  #chunkCount = 0;
  readonly #limits: VoxParseLimits;

  constructor(bytes: Uint8Array, limits: VoxParseLimits) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#offset = 0;
    this.#limits = limits;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  readUint32(): number {
    if (this.remaining < 4) {
      throw voxError(
        "validation",
        "VOX_TRUNCATED",
        "VOX file ended inside a 32-bit field",
        { offset: this.#offset },
      );
    }
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  readId(): string {
    if (this.remaining < 4) {
      throw voxError(
        "validation",
        "VOX_TRUNCATED",
        "VOX file ended inside a chunk id",
        { offset: this.#offset },
      );
    }
    let id = "";
    for (let i = 0; i < 4; i += 1) {
      const byte = this.#bytes[this.#offset + i];
      if (byte === undefined || byte < 0x20 || byte > 0x7e) {
        throw voxError(
          "validation",
          "VOX_INVALID_CHUNK_ID",
          "Chunk id must be four printable ASCII characters",
          { offset: this.#offset },
        );
      }
      id += String.fromCharCode(byte);
    }
    this.#offset += 4;
    return id;
  }

  readHeader(): ChunkHeader {
    this.#chunkCount += 1;
    if (this.#chunkCount > this.#limits.maxChunks) {
      throw voxError(
        "limit",
        "VOX_TOO_MANY_CHUNKS",
        "VOX file exceeds the chunk count limit",
        { limit: this.#limits.maxChunks },
      );
    }
    const id = this.readId();
    const contentSize = this.readUint32();
    const childrenSize = this.readUint32();
    if (contentSize + childrenSize > this.remaining) {
      throw voxError(
        "validation",
        "VOX_CHUNK_OVERFLOW",
        "Chunk declares more bytes than remain in the file",
        {
          id,
          contentSize,
          childrenSize,
          remaining: this.remaining,
        },
      );
    }
    return { id, contentSize, childrenSize };
  }

  /** Returns a sub-view over the next `size` bytes without copying. */
  window(size: number): Uint8Array {
    const start = this.#offset;
    this.#offset += size;
    return this.#bytes.subarray(start, start + size);
  }

  skip(size: number): void {
    this.#offset += size;
  }
}

const textDecoder = new TextDecoder("ascii");

/** Parses a VOX version-150 file; rejects malformed or unbounded input. */
export function parseVox(
  bytes: Uint8Array,
  limits: VoxParseLimits = DEFAULT_VOX_PARSE_LIMITS,
): VoxParseResult {
  if (bytes.byteLength > limits.maxFileBytes) {
    throw voxError(
      "limit",
      "VOX_FILE_TOO_LARGE",
      "VOX file exceeds the byte limit",
      { bytes: bytes.byteLength, limit: limits.maxFileBytes },
    );
  }
  if (bytes.byteLength < 8) {
    throw voxError(
      "validation",
      "VOX_TRUNCATED",
      "VOX file is shorter than the 8-byte header",
      { bytes: bytes.byteLength },
    );
  }
  const magic = textDecoder.decode(bytes.subarray(0, 4));
  if (magic !== VOX_MAGIC) {
    throw voxError(
      "compatibility",
      "VOX_INVALID_MAGIC",
      "File does not start with the VOX magic",
      { magic },
    );
  }
  const version = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(4, true);
  if (version !== VOX_VERSION) {
    throw voxError(
      "compatibility",
      "VOX_UNSUPPORTED_VERSION",
      "Only VOX version 150 is supported",
      { version },
    );
  }
  const reader = new VoxReader(bytes, limits);
  reader.skip(8);

  const root = reader.readHeader();
  if (root.id !== "MAIN") {
    throw voxError(
      "validation",
      "VOX_MISSING_MAIN",
      "The root chunk must be MAIN",
      { id: root.id },
    );
  }
  if (root.contentSize !== 0) {
    throw voxError(
      "validation",
      "VOX_MAIN_CONTENT",
      "MAIN must not carry content bytes",
      { contentSize: root.contentSize },
    );
  }
  if (
    root.contentSize + root.childrenSize !==
    bytes.byteLength - 8 - CHUNK_HEADER_BYTES
  ) {
    throw voxError(
      "validation",
      "VOX_MAIN_SIZE_MISMATCH",
      "MAIN chunk must span the whole file after the header",
      {
        declared: root.contentSize + root.childrenSize,
        actual: bytes.byteLength - 8 - CHUNK_HEADER_BYTES,
      },
    );
  }

  const models: VoxModel[] = [];
  const unknownChunks: VoxUnknownChunk[] = [];
  const warnings: VoxWarning[] = [];
  let palette: readonly VoxColor[] = VOX_DEFAULT_PALETTE;
  const paletteState = { explicit: false };
  let packModels: number | undefined;
  let skippedEmptyIndexVoxels = 0;
  let totalVoxels = 0;
  let unknownBytes = 0;
  let pendingModel:
    | {
        readonly sizeX: number;
        readonly sizeY: number;
        readonly sizeZ: number;
        voxels: VoxVoxel[];
      }
    | undefined;
  const unknownSeen = new Map<
    string,
    { readonly id: string; count: number; totalBytes: number }
  >();

  const walkChildren = (regionEnd: number): void => {
    while (reader.offset < regionEnd) {
      if (reader.offset + CHUNK_HEADER_BYTES > regionEnd) {
        throw voxError(
          "validation",
          "VOX_CHUNK_OVERFLOW",
          "Chunk header crosses its parent region boundary",
          { offset: reader.offset, regionEnd },
        );
      }
      const header = reader.readHeader();
      const declared = header.contentSize + header.childrenSize;
      if (declared > regionEnd - reader.offset) {
        throw voxError(
          "validation",
          "VOX_CHUNK_OVERFLOW",
          "Chunk declares more bytes than its parent region holds",
          {
            id: header.id,
            contentSize: header.contentSize,
            childrenSize: header.childrenSize,
            remaining: regionEnd - reader.offset,
          },
        );
      }
      switch (header.id) {
        case "PACK": {
          if (header.contentSize !== PACK_CHUNK_BYTES) {
            throw voxError(
              "validation",
              "VOX_PACK_LENGTH",
              "PACK chunk must carry exactly 4 content bytes",
              { contentSize: header.contentSize },
            );
          }
          if (header.childrenSize !== 0) {
            throw voxError(
              "validation",
              "VOX_PACK_CHILDREN",
              "PACK chunk must not carry children",
              { childrenSize: header.childrenSize },
            );
          }
          const value = reader.readUint32();
          if (packModels !== undefined && packModels !== value) {
            throw voxError(
              "validation",
              "VOX_DUPLICATE_PACK",
              "Multiple conflicting PACK chunks",
              { first: packModels, second: value },
            );
          }
          packModels = value;
          break;
        }
        case "SIZE": {
          if (header.contentSize !== SIZE_CHUNK_BYTES) {
            throw voxError(
              "validation",
              "VOX_SIZE_LENGTH",
              "SIZE chunk must carry exactly 12 content bytes",
              { contentSize: header.contentSize },
            );
          }
          if (header.childrenSize !== 0) {
            throw voxError(
              "validation",
              "VOX_SIZE_CHILDREN",
              "SIZE chunk must not carry children",
              { childrenSize: header.childrenSize },
            );
          }
          if (pendingModel !== undefined) {
            // The previous SIZE had no XYZI; it becomes an empty model.
            models.push(pendingModel);
            pendingModel = undefined;
          }
          const sizeX = reader.readUint32();
          const sizeY = reader.readUint32();
          const sizeZ = reader.readUint32();
          for (const axis of [sizeX, sizeY, sizeZ]) {
            if (axis === 0 || axis > VOX_MAX_AXIS_SIZE) {
              throw voxError(
                "validation",
                "VOX_MODEL_DIMENSIONS",
                "Model dimensions must be within 1..256 per axis",
                { sizeX, sizeY, sizeZ },
              );
            }
          }
          pendingModel = { sizeX, sizeY, sizeZ, voxels: [] as VoxVoxel[] };
          break;
        }
        case "XYZI": {
          if (pendingModel === undefined) {
            throw voxError(
              "validation",
              "VOX_XYZI_WITHOUT_SIZE",
              "XYZI chunk must follow a SIZE chunk",
            );
          }
          if (header.contentSize < XYZI_HEADER_BYTES) {
            throw voxError(
              "validation",
              "VOX_XYZI_LENGTH",
              "XYZI chunk is too short for its voxel count",
              { contentSize: header.contentSize },
            );
          }
          if (header.childrenSize !== 0) {
            throw voxError(
              "validation",
              "VOX_XYZI_CHILDREN",
              "XYZI chunk must not carry children",
              { childrenSize: header.childrenSize },
            );
          }
          const count = reader.readUint32();
          if (count * 4 !== header.contentSize - XYZI_HEADER_BYTES) {
            throw voxError(
              "validation",
              "VOX_XYZI_LENGTH",
              "XYZI voxel count does not match the chunk content length",
              { count, contentSize: header.contentSize },
            );
          }
          if (count > limits.maxVoxelsPerModel) {
            throw voxError(
              "limit",
              "VOX_TOO_MANY_VOXELS",
              "Model exceeds the per-model voxel limit",
              { count, limit: limits.maxVoxelsPerModel },
            );
          }
          const model = pendingModel;
          const seen = new Set<string>();
          const voxels: VoxVoxel[] = [];
          for (let i = 0; i < count; i += 1) {
            const entry = reader.readUint32();
            const x = entry & 0xff;
            const y = (entry >>> 8) & 0xff;
            const z = (entry >>> 16) & 0xff;
            const colorIndex = (entry >>> 24) & 0xff;
            if (x >= model.sizeX || y >= model.sizeY || z >= model.sizeZ) {
              throw voxError(
                "validation",
                "VOX_COORDINATE_OUT_OF_RANGE",
                "Voxel coordinate exceeds the model size",
                {
                  x,
                  y,
                  z,
                  sizeX: model.sizeX,
                  sizeY: model.sizeY,
                  sizeZ: model.sizeZ,
                },
              );
            }
            if (colorIndex === 0) {
              // Palette index zero is empty (ADR-0011): the voxel is dropped
              // and reported, never imported.
              skippedEmptyIndexVoxels += 1;
              continue;
            }
            const key = `${String(x)},${String(y)},${String(z)}`;
            if (seen.has(key)) {
              throw voxError(
                "validation",
                "VOX_DUPLICATE_VOXEL",
                "Duplicate voxel coordinates are rejected",
                { x, y, z },
              );
            }
            seen.add(key);
            voxels.push({ x, y, z, colorIndex });
          }
          totalVoxels += voxels.length;
          if (totalVoxels > limits.maxTotalVoxels) {
            throw voxError(
              "limit",
              "VOX_TOO_MANY_VOXELS",
              "File exceeds the total voxel limit",
              { total: totalVoxels, limit: limits.maxTotalVoxels },
            );
          }
          model.voxels = voxels;
          models.push(model);
          pendingModel = undefined;
          break;
        }
        case "RGBA": {
          if (header.contentSize !== VOX_RGBA_CHUNK_BYTES) {
            throw voxError(
              "validation",
              "VOX_RGBA_LENGTH",
              "RGBA chunk must carry exactly 1024 content bytes",
              { contentSize: header.contentSize },
            );
          }
          if (header.childrenSize !== 0) {
            throw voxError(
              "validation",
              "VOX_RGBA_CHILDREN",
              "RGBA chunk must not carry children",
              { childrenSize: header.childrenSize },
            );
          }
          if (paletteState.explicit) {
            throw voxError(
              "validation",
              "VOX_DUPLICATE_RGBA",
              "Multiple RGBA chunks are not supported",
            );
          }
          const raw = reader.window(VOX_RGBA_CHUNK_BYTES);
          const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          const entries: VoxColor[] = Array.from(
            { length: VOX_PALETTE_ENTRIES },
            () => ({ r: 0, g: 0, b: 0, a: 0 }),
          );
          for (let index = 1; index <= 255; index += 1) {
            const offset = (index - 1) * 4;
            entries[index] = {
              r: view.getUint8(offset),
              g: view.getUint8(offset + 1),
              b: view.getUint8(offset + 2),
              a: view.getUint8(offset + 3),
            };
          }
          // Official layout: the last quadruple is palette index 0 (empty).
          entries[0] = {
            r: view.getUint8(1020),
            g: view.getUint8(1021),
            b: view.getUint8(1022),
            a: view.getUint8(1023),
          };
          palette = Object.freeze(entries);
          paletteState.explicit = true;
          break;
        }
        default: {
          // Unknown chunk: skip only when the declared lengths are valid
          // (already checked against the region), and report it.
          const id = header.id;
          unknownBytes += declared;
          if (unknownBytes > limits.maxUnknownChunkBytes) {
            throw voxError(
              "limit",
              "VOX_UNKNOWN_CHUNK_LIMIT",
              "Unknown chunks exceed the skipped-byte limit",
              { bytes: unknownBytes, limit: limits.maxUnknownChunkBytes },
            );
          }
          reader.skip(declared);
          const seen = unknownSeen.get(id);
          if (seen !== undefined) {
            seen.count += 1;
            seen.totalBytes += declared;
          } else {
            const record: VoxUnknownChunk = {
              id,
              count: 1,
              totalBytes: declared,
            };
            unknownSeen.set(id, record);
            unknownChunks.push(record);
          }
          if (sceneGraphChunk(id)) {
            warnings.push({
              code: "VOX_SCENE_GRAPH_NOT_INTERPRETED",
              message: `Scene-graph chunk ${id} is reported but not interpreted`,
              context: { id },
            });
          }
          break;
        }
      }
    }
  };

  walkChildren(bytes.byteLength);
  if (pendingModel !== undefined) models.push(pendingModel);
  if (reader.offset !== bytes.byteLength) {
    throw voxError(
      "validation",
      "VOX_TRAILING_BYTES",
      "Trailing bytes after the MAIN chunk",
      { trailing: bytes.byteLength - reader.offset },
    );
  }
  if (packModels !== undefined && packModels !== models.length) {
    throw voxError(
      "validation",
      "VOX_PACK_MISMATCH",
      "PACK model count does not match the SIZE/XYZI pairs",
      { declared: packModels, actual: models.length },
    );
  }
  if (models.length > limits.maxModels) {
    throw voxError(
      "limit",
      "VOX_TOO_MANY_MODELS",
      "File exceeds the model limit",
      { models: models.length, limit: limits.maxModels },
    );
  }
  if (!paletteState.explicit) {
    warnings.push({
      code: "VOX_DEFAULT_PALETTE_USED",
      message: "No RGBA chunk present; the version-150 default palette is used",
    });
  }
  if (skippedEmptyIndexVoxels > 0) {
    warnings.push({
      code: "VOX_EMPTY_INDEX_VOXELS_SKIPPED",
      message: "Voxels referencing palette index 0 (empty) were skipped",
      context: { skipped: skippedEmptyIndexVoxels },
    });
  }
  if (unknownChunks.length > 0) {
    warnings.push({
      code: "VOX_UNKNOWN_CHUNKS_SKIPPED",
      message: "Unknown chunks were skipped",
      context: { ids: unknownChunks.map((chunk) => chunk.id).join(",") },
    });
  }
  return {
    version: VOX_VERSION,
    models: Object.freeze(models.map((model) => Object.freeze(model))),
    palette,
    paletteExplicit: paletteState.explicit,
    warnings: Object.freeze(warnings),
    unknownChunks: Object.freeze(unknownChunks),
    skippedEmptyIndexVoxels,
  };
}

const compareVoxel = (a: VoxVoxel, b: VoxVoxel): number =>
  a.x - b.x || a.y - b.y || a.z - b.z || a.colorIndex - b.colorIndex;

/**
 * Encodes a deterministic VOX version-150 file. Models keep input order;
 * each model's voxels are sorted by (x, y, z, colorIndex); `PACK` is
 * written only when more than one model exists; `RGBA` is always written.
 */
export function encodeVox(input: VoxEncodeInput): Uint8Array {
  const models = input.models;
  if (models.length === 0) {
    throw voxError(
      "validation",
      "VOX_NO_MODELS",
      "Cannot encode a VOX file without models",
    );
  }
  const palette = input.palette ?? VOX_DEFAULT_PALETTE;
  if (palette.length !== VOX_PALETTE_ENTRIES) {
    throw voxError(
      "validation",
      "VOX_RGBA_LENGTH",
      "Palette must contain exactly 256 entries",
      { entries: palette.length },
    );
  }
  for (const entry of palette) {
    for (const channel of ["r", "g", "b", "a"] as const) {
      const value = entry[channel];
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw voxError(
          "validation",
          "VOX_INVALID_PALETTE",
          "Palette channels must be integers from 0 through 255",
          { channel, value: String(value) },
        );
      }
    }
  }
  for (const model of models) {
    for (const axis of [model.sizeX, model.sizeY, model.sizeZ]) {
      if (axis === 0 || axis > VOX_MAX_AXIS_SIZE) {
        throw voxError(
          "validation",
          "VOX_MODEL_DIMENSIONS",
          "Model dimensions must be within 1..256 per axis",
          { sizeX: model.sizeX, sizeY: model.sizeY, sizeZ: model.sizeZ },
        );
      }
    }
    for (const voxel of model.voxels) {
      if (
        voxel.x >= model.sizeX ||
        voxel.y >= model.sizeY ||
        voxel.z >= model.sizeZ
      ) {
        throw voxError(
          "validation",
          "VOX_COORDINATE_OUT_OF_RANGE",
          "Voxel coordinate exceeds the model size",
          {
            x: voxel.x,
            y: voxel.y,
            z: voxel.z,
            sizeX: model.sizeX,
            sizeY: model.sizeY,
            sizeZ: model.sizeZ,
          },
        );
      }
      if (voxel.colorIndex === 0) {
        throw voxError(
          "validation",
          "VOX_EMPTY_INDEX",
          "Voxels cannot reference palette index 0 (empty); filter them first",
          { x: voxel.x, y: voxel.y, z: voxel.z },
        );
      }
    }
  }

  // Build the byte stream: header + MAIN with children.
  const packChunk =
    models.length > 1
      ? [chunkBytes("PACK", uint32Bytes(models.length), new Uint8Array(0))]
      : [];
  const children: Uint8Array[] = [];
  for (const model of models) {
    const sorted = [...model.voxels].sort(compareVoxel);
    const sizeContent = uint32Bytes3(model.sizeX, model.sizeY, model.sizeZ);
    const xyzContent = new Uint8Array(XYZI_HEADER_BYTES + sorted.length * 4);
    const view = new DataView(xyzContent.buffer);
    view.setUint32(0, sorted.length, true);
    sorted.forEach((voxel, index) => {
      const offset = XYZI_HEADER_BYTES + index * 4;
      view.setUint8(offset, voxel.x);
      view.setUint8(offset + 1, voxel.y);
      view.setUint8(offset + 2, voxel.z);
      view.setUint8(offset + 3, voxel.colorIndex);
    });
    children.push(chunkBytes("SIZE", sizeContent, new Uint8Array(0)));
    children.push(chunkBytes("XYZI", xyzContent, new Uint8Array(0)));
  }
  // RGBA content: entries 1..255 first, index 0 last (official layout).
  const rgbaContent = new Uint8Array(VOX_RGBA_CHUNK_BYTES);
  const rgbaView = new DataView(rgbaContent.buffer);
  for (let index = 1; index <= 255; index += 1) {
    const entry = palette[index];
    if (entry === undefined) {
      throw voxError(
        "internal",
        "VOX_PALETTE_MISSING",
        "Palette entry missing",
      );
    }
    const offset = (index - 1) * 4;
    rgbaView.setUint8(offset, entry.r);
    rgbaView.setUint8(offset + 1, entry.g);
    rgbaView.setUint8(offset + 2, entry.b);
    rgbaView.setUint8(offset + 3, entry.a);
  }
  const zero = palette[0];
  if (zero === undefined) {
    throw voxError("internal", "VOX_PALETTE_MISSING", "Palette entry missing");
  }
  rgbaView.setUint8(1020, zero.r);
  rgbaView.setUint8(1021, zero.g);
  rgbaView.setUint8(1022, zero.b);
  rgbaView.setUint8(1023, zero.a);
  children.push(chunkBytes("RGBA", rgbaContent, new Uint8Array(0)));

  const mainChildren = concatBytes(packChunk.concat(children));
  const main = chunkBytes("MAIN", new Uint8Array(0), mainChildren);
  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  for (let i = 0; i < 4; i += 1) {
    headerView.setUint8(i, VOX_MAGIC.charCodeAt(i));
  }
  headerView.setUint32(4, VOX_VERSION, true);
  return concatBytes([header, main]);
}

function uint32Bytes(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function uint32Bytes3(a: number, b: number, c: number): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint32(0, a, true);
  view.setUint32(4, b, true);
  view.setUint32(8, c, true);
  return out;
}

function chunkBytes(
  id: string,
  content: Uint8Array,
  children: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(
    CHUNK_HEADER_BYTES + content.length + children.length,
  );
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) {
    view.setUint8(i, id.charCodeAt(i));
  }
  view.setUint32(4, content.length, true);
  view.setUint32(8, children.length, true);
  out.set(content, CHUNK_HEADER_BYTES);
  out.set(children, CHUNK_HEADER_BYTES + content.length);
  return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
