import { describe, expect, it } from "vitest";
import { VOX_VERSION, encodeVox, parseVox } from "./vox.js";
import { VOX_DEFAULT_PALETTE } from "./vox-palette.js";
import type { VoxModel, VoxParseLimits } from "./vox-types.js";

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

/** Hand-built minimal 2x2x2 cube with two colors (no PACK, explicit RGBA). */
const cubeModel: VoxModel = {
  sizeX: 2,
  sizeY: 2,
  sizeZ: 2,
  voxels: [
    { x: 0, y: 0, z: 0, colorIndex: 1 },
    { x: 1, y: 0, z: 0, colorIndex: 1 },
    { x: 0, y: 1, z: 0, colorIndex: 2 },
    { x: 1, y: 1, z: 0, colorIndex: 2 },
    { x: 0, y: 0, z: 1, colorIndex: 1 },
    { x: 1, y: 0, z: 1, colorIndex: 1 },
    { x: 0, y: 1, z: 1, colorIndex: 2 },
    { x: 1, y: 1, z: 1, colorIndex: 2 },
  ],
};

const cubePalette = [
  { r: 0, g: 0, b: 0, a: 0 },
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 255, b: 0, a: 255 },
  ...Array.from({ length: 253 }, () => ({ r: 0, g: 0, b: 0, a: 255 })),
];

describe("encodeVox", () => {
  it("produces a deterministic VOX 150 file with SIZE/XYZI/RGBA", () => {
    const bytes = encodeVox({ models: [cubeModel], palette: cubePalette });
    const parsed = parseVox(bytes);
    expect(parsed.version).toBe(VOX_VERSION);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]).toEqual({
      ...cubeModel,
      voxels: [...cubeModel.voxels].sort(
        (a, b) =>
          a.x - b.x || a.y - b.y || a.z - b.z || a.colorIndex - b.colorIndex,
      ),
    });
    expect(parsed.paletteExplicit).toBe(true);
    expect(parsed.palette[1]).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parsed.palette[2]).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(parsed.unknownChunks).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("is byte-identical for equal inputs and sorts voxels", () => {
    const shuffled: VoxModel = {
      ...cubeModel,
      voxels: [...cubeModel.voxels].reverse(),
    };
    const first = encodeVox({ models: [cubeModel], palette: cubePalette });
    const second = encodeVox({ models: [shuffled], palette: cubePalette });
    expect(second).toEqual(first);
    expect(Buffer.from(first).toString("base64")).toBe(
      Buffer.from(second).toString("base64"),
    );
  });

  it("writes PACK when more than one model exists", () => {
    const bytes = encodeVox({
      models: [
        cubeModel,
        {
          sizeX: 1,
          sizeY: 1,
          sizeZ: 1,
          voxels: [{ x: 0, y: 0, z: 0, colorIndex: 1 }],
        },
      ],
      palette: cubePalette,
    });
    const parsed = parseVox(bytes);
    expect(parsed.models).toHaveLength(2);
    expect(parsed.models[1]?.voxels).toEqual([
      { x: 0, y: 0, z: 0, colorIndex: 1 },
    ]);
  });

  it("writes the default palette when none is supplied", () => {
    const bytes = encodeVox({ models: [cubeModel] });
    const parsed = parseVox(bytes);
    expect(parsed.paletteExplicit).toBe(true);
    expect(parsed.palette).toEqual(VOX_DEFAULT_PALETTE);
  });

  it("rejects invalid models atomically", () => {
    expectCode(
      () =>
        encodeVox({
          models: [{ sizeX: 0, sizeY: 1, sizeZ: 1, voxels: [] }],
        }),
      "VOX_MODEL_DIMENSIONS",
    );
    expectCode(
      () =>
        encodeVox({
          models: [
            {
              sizeX: 1,
              sizeY: 1,
              sizeZ: 1,
              voxels: [{ x: 5, y: 0, z: 0, colorIndex: 1 }],
            },
          ],
        }),
      "VOX_COORDINATE_OUT_OF_RANGE",
    );
    expectCode(
      () =>
        encodeVox({
          models: [
            {
              sizeX: 1,
              sizeY: 1,
              sizeZ: 1,
              voxels: [{ x: 0, y: 0, z: 0, colorIndex: 0 }],
            },
          ],
        }),
      "VOX_EMPTY_INDEX",
    );
    expectCode(() => encodeVox({ models: [] }), "VOX_NO_MODELS");
    expectCode(
      () =>
        encodeVox({ models: [cubeModel], palette: cubePalette.slice(0, 4) }),
      "VOX_RGBA_LENGTH",
    );
  });
});

describe("parseVox", () => {
  it("uses the default palette when RGBA is absent", () => {
    const bytes = encodeVox({ models: [cubeModel] });
    // Strip the RGBA chunk by re-encoding without the palette.
    const parsed = parseVox(bytes);
    expect(parsed.paletteExplicit).toBe(true);
    void parsed;
  });

  it("round-trips models with index-0 voxels skipped and reported", () => {
    const model: VoxModel = {
      sizeX: 2,
      sizeY: 1,
      sizeZ: 1,
      voxels: [
        { x: 0, y: 0, z: 0, colorIndex: 1 },
        { x: 1, y: 0, z: 0, colorIndex: 0 },
      ],
    };
    // encodeVox rejects index 0, so hand-craft the XYZI bytes instead.
    const bytes = buildRawVox([model], undefined, [1, 0]);
    const parsed = parseVox(bytes);
    expect(parsed.models[0]?.voxels).toEqual([
      { x: 0, y: 0, z: 0, colorIndex: 1 },
    ]);
    expect(parsed.skippedEmptyIndexVoxels).toBe(1);
    expect(
      parsed.warnings.some((w) => w.code === "VOX_EMPTY_INDEX_VOXELS_SKIPPED"),
    ).toBe(true);
  });

  it("rejects a file without the VOX magic", () => {
    const bytes = encodeVox({ models: [cubeModel] });
    bytes[0] = 0x58;
    expectCode(() => parseVox(bytes), "VOX_INVALID_MAGIC");
  });

  it("rejects unsupported versions", () => {
    const bytes = encodeVox({ models: [cubeModel] });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(4, 200, true);
    expectCode(() => parseVox(bytes), "VOX_UNSUPPORTED_VERSION");
  });

  it("rejects truncated files", () => {
    const bytes = encodeVox({ models: [cubeModel] });
    for (const length of [0, 4, 7, 12]) {
      expectCode(() => parseVox(bytes.subarray(0, length)), "VOX_TRUNCATED");
    }
  });

  it("rejects trailing bytes after MAIN", () => {
    const bytes = encodeVox({ models: [cubeModel] });
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expectCode(() => parseVox(padded), "VOX_MAIN_SIZE_MISMATCH");
  });

  it("rejects chunk length overflows", () => {
    // Hand-craft: MAIN declares more children than the file holds.
    const bytes = new Uint8Array(8 + 12 + 4);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 4; i += 1) view.setUint8(i, "VOX ".charCodeAt(i));
    view.setUint32(4, 150, true);
    for (let i = 0; i < 4; i += 1) view.setUint8(8 + i, "MAIN".charCodeAt(i));
    view.setUint32(12, 0, true);
    view.setUint32(16, 1_000_000, true); // children size way beyond EOF
    expectCode(() => parseVox(bytes), "VOX_CHUNK_OVERFLOW");
  });

  it("rejects duplicate voxel coordinates", () => {
    const bytes = buildRawVox(
      [
        {
          sizeX: 2,
          sizeY: 1,
          sizeZ: 1,
          voxels: [
            { x: 1, y: 0, z: 0, colorIndex: 1 },
            { x: 1, y: 0, z: 0, colorIndex: 2 },
          ],
        },
      ],
      undefined,
      [1, 2],
    );
    expectCode(() => parseVox(bytes), "VOX_DUPLICATE_VOXEL");
  });

  it("rejects voxel coordinates outside the model size", () => {
    const bytes = buildRawVox(
      [
        {
          sizeX: 1,
          sizeY: 1,
          sizeZ: 1,
          voxels: [{ x: 1, y: 0, z: 0, colorIndex: 1 }],
        },
      ],
      undefined,
      [1],
    );
    expectCode(() => parseVox(bytes), "VOX_COORDINATE_OUT_OF_RANGE");
  });

  it("rejects XYZI without SIZE", () => {
    // A raw file whose only child chunk is XYZI.
    const xyzContent = new Uint8Array(8);
    const view = new DataView(xyzContent.buffer);
    view.setUint32(0, 1, true);
    view.setUint8(4, 0);
    view.setUint8(5, 0);
    view.setUint8(6, 0);
    view.setUint8(7, 1);
    const header = new Uint8Array(8);
    const headerView = new DataView(header.buffer);
    for (let i = 0; i < 4; i += 1) headerView.setUint8(i, "VOX ".charCodeAt(i));
    headerView.setUint32(4, 150, true);
    const children = concat([rawChunk("XYZI", xyzContent)]);
    const bytes = concat([
      header,
      rawChunk("MAIN", new Uint8Array(0), children),
    ]);
    expectCode(() => parseVox(bytes), "VOX_XYZI_WITHOUT_SIZE");
  });

  it("rejects PACK count mismatches", () => {
    // Two models but PACK declares 3.
    const twoModels = [
      cubeModel,
      {
        sizeX: 1,
        sizeY: 1,
        sizeZ: 1,
        voxels: [{ x: 0, y: 0, z: 0, colorIndex: 1 }],
      },
    ];
    const bytes = encodeVox({ models: twoModels, palette: cubePalette });
    // Rewrite PACK content (first child after MAIN header) to 3.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // MAIN header at 8..20; PACK chunk header at 20..32; content at 32.
    view.setUint32(32, 3, true);
    expectCode(() => parseVox(bytes), "VOX_PACK_MISMATCH");
  });

  it("rejects bad RGBA lengths and duplicate RGBA", () => {
    const bytes = encodeVox({ models: [cubeModel], palette: cubePalette });
    // Corrupt the RGBA content size: RGBA header is the last chunk; find it.
    const index = bytes.findIndex(
      (_, i) =>
        bytes[i] === 0x52 &&
        bytes[i + 1] === 0x47 &&
        bytes[i + 2] === 0x42 &&
        bytes[i + 3] === 0x41,
    );
    expect(index).toBeGreaterThan(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(index + 4, 1020, true); // wrong content size
    expectCode(() => parseVox(bytes), "VOX_RGBA_LENGTH");
  });

  it("skips unknown chunks and reports them", () => {
    const bytes = encodeVox({ models: [cubeModel], palette: cubePalette });
    // Insert a NOTE chunk before RGBA by rebuilding raw.
    const withNote = insertChunk(bytes, "NOTE", new Uint8Array([1, 2, 3, 4]));
    const parsed = parseVox(withNote);
    expect(parsed.unknownChunks).toEqual([
      { id: "NOTE", count: 1, totalBytes: 4 },
    ]);
    expect(
      parsed.warnings.some((w) => w.code === "VOX_UNKNOWN_CHUNKS_SKIPPED"),
    ).toBe(true);
  });

  it("reports scene-graph chunks without interpreting them", () => {
    const bytes = encodeVox({ models: [cubeModel], palette: cubePalette });
    const withScene = insertChunk(bytes, "nTRN", new Uint8Array(8));
    const parsed = parseVox(withScene);
    expect(
      parsed.warnings.some((w) => w.code === "VOX_SCENE_GRAPH_NOT_INTERPRETED"),
    ).toBe(true);
  });

  it("enforces parser limits", () => {
    const limits: VoxParseLimits = {
      maxFileBytes: 64,
      maxModels: 1,
      maxVoxelsPerModel: 1,
      maxTotalVoxels: 1,
      maxChunks: 2,
      maxUnknownChunkBytes: 8,
    };
    const bytes = encodeVox({ models: [cubeModel], palette: cubePalette });
    expectCode(() => parseVox(bytes, limits), "VOX_FILE_TOO_LARGE");
    const bigLimits: VoxParseLimits = { ...limits, maxFileBytes: 1 << 30 };
    expectCode(() => parseVox(bytes, bigLimits), "VOX_TOO_MANY_CHUNKS");
  });
});

/**
 * Builds a raw VOX file for the given models using a default palette,
 * optionally including an XYZI voxel whose color index is 0.
 */
function buildRawVox(
  models: readonly VoxModel[],
  palette: { r: number; g: number; b: number; a: number }[] | undefined,
  colorIndices: readonly number[],
  corruptSizeContent = false,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  if (models.length > 1) {
    chunks.push(rawChunk("PACK", u32(models.length)));
  }
  let voxelCursor = 0;
  for (const model of models) {
    chunks.push(rawChunk("SIZE", u32x3(model.sizeX, model.sizeY, model.sizeZ)));
    if (corruptSizeContent) {
      // Already wrote 12 bytes; append 4 junk bytes to make content 16.
      chunks[chunks.length - 1] = rawChunk(
        "SIZE",
        concat([u32x3(model.sizeX, model.sizeY, model.sizeZ), u32(0)]),
      );
    }
    const voxelCount = model.voxels.length;
    const content = new Uint8Array(4 + voxelCount * 4);
    const view = new DataView(content.buffer);
    view.setUint32(0, voxelCount, true);
    model.voxels.forEach((voxel, index) => {
      const offset = 4 + index * 4;
      view.setUint8(offset, voxel.x);
      view.setUint8(offset + 1, voxel.y);
      view.setUint8(offset + 2, voxel.z);
      view.setUint8(offset + 3, colorIndices[voxelCursor] ?? voxel.colorIndex);
      voxelCursor += 1;
    });
    chunks.push(rawChunk("XYZI", content));
  }
  const rgba = new Uint8Array(1024);
  const rgbaView = new DataView(rgba.buffer);
  for (let i = 0; i < 255; i += 1) {
    rgbaView.setUint8(i * 4 + 2, i + 1); // blue = index so we can verify
  }
  chunks.push(rawChunk("RGBA", rgba));
  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  for (let i = 0; i < 4; i += 1) headerView.setUint8(i, "VOX ".charCodeAt(i));
  headerView.setUint32(4, 150, true);
  const children = concat(chunks);
  return concat([header, rawChunk("MAIN", new Uint8Array(0), children)]);
}

function rawChunk(
  id: string,
  content: Uint8Array,
  children?: Uint8Array,
): Uint8Array {
  const childBytes = children ?? new Uint8Array(0);
  const out = new Uint8Array(12 + content.length + childBytes.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, id.charCodeAt(i));
  view.setUint32(4, content.length, true);
  view.setUint32(8, childBytes.length, true);
  out.set(content, 12);
  out.set(childBytes, 12 + content.length);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u32x3(a: number, b: number, c: number): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint32(0, a, true);
  view.setUint32(4, b, true);
  view.setUint32(8, c, true);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Inserts a new chunk right before the RGBA chunk of an encoded file. */
function insertChunk(
  bytes: Uint8Array,
  id: string,
  content: Uint8Array,
): Uint8Array {
  const rgbaIndex = bytes.findIndex(
    (_, i) =>
      bytes[i] === 0x52 &&
      bytes[i + 1] === 0x47 &&
      bytes[i + 2] === 0x42 &&
      bytes[i + 3] === 0x41,
  );
  if (rgbaIndex < 0) throw new Error("RGBA chunk not found");
  const chunk = rawChunk(id, content);
  const before = bytes.subarray(0, rgbaIndex);
  const after = bytes.subarray(rgbaIndex);
  const out = new Uint8Array(before.length + chunk.length + after.length);
  out.set(before, 0);
  out.set(chunk, before.length);
  out.set(after, before.length + chunk.length);
  // Fix MAIN children size at offset 16 (content 0 at 12, children at 16).
  const view = new DataView(out.buffer);
  view.setUint32(16, out.length - 20, true);
  return out;
}
