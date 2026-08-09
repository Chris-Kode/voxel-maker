#!/usr/bin/env node
/**
 * Regenerates the checked-in MagicaVoxel `.vox` fixture corpus in
 * `fixtures/vox/` (plan S8.6, ticket #24): golden known-good files plus
 * adversarial and compatibility fixtures that `parseVox` must reject with
 * stable error codes, and a machine-readable `corpus.json`.
 *
 * Requires a full build first (`pnpm build`), then:
 *   node scripts/generate-vox-fixtures.mjs
 *
 * The script self-checks every fixture against `parseVox`/`encodeVox`
 * before writing anything, so the committed corpus and `corpus.json`
 * always agree with the codec's current behavior.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeVox, parseVox } from "../packages/formats/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = join(root, "fixtures", "vox");
const knownDir = join(corpusDir, "known");
const malformedDir = join(corpusDir, "malformed");

const fixturePalette = [
  { r: 0, g: 0, b: 0, a: 0 },
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 255, b: 0, a: 255 },
  { r: 0, g: 0, b: 255, a: 255 },
  ...Array.from({ length: 252 }, (_, i) => ({
    r: (i * 37) % 256,
    g: (i * 91) % 256,
    b: (i * 13) % 256,
    a: 255,
  })),
];

const cubeModel = {
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

/** Low-level chunk writer for adversarial fixtures. */
function chunk(id, content, children = new Uint8Array(0)) {
  const out = new Uint8Array(12 + content.length + children.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, id.charCodeAt(i));
  view.setUint32(4, content.length, true);
  view.setUint32(8, children.length, true);
  out.set(content, 12);
  out.set(children, 12 + content.length);
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u32x3(a, b, c) {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint32(0, a, true);
  view.setUint32(4, b, true);
  view.setUint32(8, c, true);
  return out;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function header() {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, "VOX ".charCodeAt(i));
  view.setUint32(4, 150, true);
  return out;
}

function wrap(children) {
  return concat([header(), chunk("MAIN", new Uint8Array(0), children)]);
}

function sizeXyz(sizeX, sizeY, sizeZ) {
  return u32x3(sizeX, sizeY, sizeZ);
}

function xyzi(voxels) {
  const content = new Uint8Array(4 + voxels.length * 4);
  const view = new DataView(content.buffer);
  view.setUint32(0, voxels.length, true);
  voxels.forEach((voxel, index) => {
    const offset = 4 + index * 4;
    view.setUint8(offset, voxel.x);
    view.setUint8(offset + 1, voxel.y);
    view.setUint8(offset + 2, voxel.z);
    view.setUint8(offset + 3, voxel.colorIndex);
  });
  return content;
}

const known = {
  "cube-two-colors.vox": {
    vector: "golden 2x2x2 cube with two explicit palette colors",
    golden: true,
    bytes: encodeVox({ models: [cubeModel], palette: fixturePalette }),
  },
  "two-models.vox": {
    vector: "PACK file with two SIZE/XYZI models",
    bytes: encodeVox({
      models: [
        cubeModel,
        {
          sizeX: 1,
          sizeY: 1,
          sizeZ: 1,
          voxels: [{ x: 0, y: 0, z: 0, colorIndex: 3 }],
        },
      ],
      palette: fixturePalette,
    }),
  },
  "default-palette.vox": {
    vector: "no RGBA chunk; the version-150 default palette applies",
    bytes: (() => {
      const children = concat([
        chunk("SIZE", sizeXyz(1, 1, 1)),
        chunk("XYZI", xyzi([{ x: 0, y: 0, z: 0, colorIndex: 1 }])),
      ]);
      return wrap(children);
    })(),
  },
  "empty-model.vox": {
    vector: "SIZE with an empty XYZI (zero voxels)",
    bytes: encodeVox({
      models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [] }],
      palette: fixturePalette,
    }),
  },
  "unknown-chunk.vox": {
    vector: "unknown NOTE chunk skipped with a warning",
    bytes: (() => {
      const base = encodeVox({ models: [cubeModel], palette: fixturePalette });
      const children = concat([
        chunk("NOTE", new Uint8Array([1, 2, 3, 4])),
        base.subarray(20),
      ]);
      return wrap(children);
    })(),
  },
};

const malformed = {
  "bad-magic.vox": {
    vector: "header magic is not VOX ",
    family: "compatibility",
    code: "VOX_INVALID_MAGIC",
    bytes: (() => {
      const bytes = encodeVox({ models: [cubeModel], palette: fixturePalette });
      bytes[0] = 0x58;
      return bytes;
    })(),
  },
  "bad-version.vox": {
    vector: "unsupported version 200",
    family: "compatibility",
    code: "VOX_UNSUPPORTED_VERSION",
    bytes: (() => {
      const bytes = encodeVox({ models: [cubeModel], palette: fixturePalette });
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
        4,
        200,
        true,
      );
      return bytes;
    })(),
  },
  "truncated-header.vox": {
    vector: "file ends inside the 8-byte header",
    family: "validation",
    code: "VOX_TRUNCATED",
    bytes: new Uint8Array([0x56, 0x4f, 0x58]),
  },
  "chunk-overflow.vox": {
    vector: "MAIN declares more children than the file holds",
    family: "validation",
    code: "VOX_CHUNK_OVERFLOW",
    bytes: (() => {
      const out = new Uint8Array(24);
      out.set(header(), 0);
      const view = new DataView(out.buffer);
      for (let i = 0; i < 4; i += 1) view.setUint8(8 + i, "MAIN".charCodeAt(i));
      view.setUint32(12, 0, true);
      view.setUint32(16, 1_000_000, true);
      return out;
    })(),
  },
  "xyz-without-size.vox": {
    vector: "XYZI chunk appears without a preceding SIZE",
    family: "validation",
    code: "VOX_XYZI_WITHOUT_SIZE",
    bytes: wrap(chunk("XYZI", xyzi([{ x: 0, y: 0, z: 0, colorIndex: 1 }]))),
  },
  "duplicate-voxels.vox": {
    vector: "two XYZI entries share one coordinate",
    family: "validation",
    code: "VOX_DUPLICATE_VOXEL",
    bytes: (() => {
      const children = concat([
        chunk("SIZE", sizeXyz(2, 1, 1)),
        chunk(
          "XYZI",
          xyzi([
            { x: 1, y: 0, z: 0, colorIndex: 1 },
            { x: 1, y: 0, z: 0, colorIndex: 2 },
          ]),
        ),
      ]);
      return wrap(children);
    })(),
  },
  "coordinate-out-of-range.vox": {
    vector: "voxel coordinate exceeds the declared model size",
    family: "validation",
    code: "VOX_COORDINATE_OUT_OF_RANGE",
    bytes: (() => {
      const children = concat([
        chunk("SIZE", sizeXyz(1, 1, 1)),
        chunk("XYZI", xyzi([{ x: 5, y: 0, z: 0, colorIndex: 1 }])),
      ]);
      return wrap(children);
    })(),
  },
  "pack-mismatch.vox": {
    vector: "PACK declares 3 models but only 2 SIZE/XYZI pairs exist",
    family: "validation",
    code: "VOX_PACK_MISMATCH",
    bytes: (() => {
      const children = concat([
        chunk("PACK", u32(3)),
        chunk("SIZE", sizeXyz(1, 1, 1)),
        chunk("XYZI", xyzi([{ x: 0, y: 0, z: 0, colorIndex: 1 }])),
        chunk("SIZE", sizeXyz(1, 1, 1)),
        chunk("XYZI", xyzi([{ x: 0, y: 0, z: 0, colorIndex: 2 }])),
      ]);
      return wrap(children);
    })(),
  },
  "bad-rgba-length.vox": {
    vector: "RGBA chunk carries 1020 content bytes instead of 1024",
    family: "validation",
    code: "VOX_RGBA_LENGTH",
    bytes: (() => {
      const children = concat([
        chunk("SIZE", sizeXyz(1, 1, 1)),
        chunk("XYZI", xyzi([{ x: 0, y: 0, z: 0, colorIndex: 1 }])),
        chunk("RGBA", new Uint8Array(1020)),
      ]);
      return wrap(children);
    })(),
  },
  "trailing-bytes.vox": {
    vector: "garbage after the MAIN chunk",
    family: "validation",
    code: "VOX_MAIN_SIZE_MISMATCH",
    bytes: (() => {
      const good = encodeVox({ models: [cubeModel], palette: fixturePalette });
      const out = new Uint8Array(good.length + 4);
      out.set(good, 0);
      out.set([1, 2, 3, 4], good.length);
      return out;
    })(),
  },
  "empty-file.vox": {
    vector: "zero-length file",
    family: "validation",
    code: "VOX_TRUNCATED",
    bytes: new Uint8Array(0),
  },
  "huge-dimensions.vox": {
    vector: "model size 300 exceeds the 256 subset limit",
    family: "validation",
    code: "VOX_MODEL_DIMENSIONS",
    bytes: (() => {
      const children = concat([
        chunk("SIZE", sizeXyz(300, 1, 1)),
        chunk("XYZI", xyzi([{ x: 0, y: 0, z: 0, colorIndex: 1 }])),
      ]);
      return wrap(children);
    })(),
  },
};

// --- Self-check every fixture before writing anything. ---
const knownRecords = [];
for (const [file, fixture] of Object.entries(known)) {
  const parsed = parseVox(fixture.bytes);
  if (parsed.models.length === 0) {
    throw new Error(`fixture ${file} parsed with no models`);
  }
  if (fixture.golden) {
    // The golden must be byte-stable: re-encoding the parsed content must
    // reproduce the exact bytes (writer drift is a test failure).
    const reencoded = encodeVox({
      models: parsed.models,
      palette: parsed.palette,
    });
    if (!Buffer.from(reencoded).equals(Buffer.from(fixture.bytes))) {
      throw new Error(`fixture ${file} is not byte-stable under re-encode`);
    }
  }
  knownRecords.push({
    file: `known/${file}`,
    vector: fixture.vector,
    byteLength: fixture.bytes.length,
    models: parsed.models.length,
    voxels: parsed.models.reduce((sum, model) => sum + model.voxels.length, 0),
    paletteExplicit: parsed.paletteExplicit,
  });
}

const rejectedRecords = [];
for (const [file, fixture] of Object.entries(malformed)) {
  let error;
  try {
    parseVox(fixture.bytes);
  } catch (caught) {
    error = caught;
  }
  if (error === undefined) {
    throw new Error(`malformed fixture ${file} unexpectedly parsed`);
  }
  if (error.code !== fixture.code || error.family !== fixture.family) {
    throw new Error(
      `malformed fixture ${file} rejected with ${error.family}/${error.code}, expected ${fixture.family}/${fixture.code}`,
    );
  }
  rejectedRecords.push({
    file: `malformed/${file}`,
    vector: fixture.vector,
    family: fixture.family,
    code: fixture.code,
    byteLength: fixture.bytes.length,
  });
}

await mkdir(knownDir, { recursive: true });
await mkdir(malformedDir, { recursive: true });
for (const [file, fixture] of Object.entries(known)) {
  await writeFile(join(knownDir, file), fixture.bytes);
}
for (const [file, fixture] of Object.entries(malformed)) {
  await writeFile(join(malformedDir, file), fixture.bytes);
}

const corpus = {
  schemaVersion: 1,
  generator: "scripts/generate-vox-fixtures.mjs",
  format: "VOX version 150",
  known: knownRecords,
  rejected: rejectedRecords,
};
await writeFile(
  join(corpusDir, "corpus.json"),
  `${JSON.stringify(corpus, null, 2)}\n`,
);

await writeFile(
  join(corpusDir, "README.md"),
  `# MagicaVoxel \`.vox\` fixture corpus (ticket #24, plan S8.6)

Checked-in golden and adversarial VOX version-150 files used by
\`packages/formats/src/vox-fixtures.test.ts\` to prove the subset contract
(ADR-0011, \`docs/format/vox-v1.md\`): axes, palette, dimensions, chunk
bounds, duplicate rejection, unknown-chunk skipping, and stable error
codes.

- \`known/\`: valid files. \`cube-two-colors.vox\` is the byte-stable golden:
  parsing and re-encoding must reproduce the exact bytes. The others cover
  \`PACK\` multi-model files, the default palette (no \`RGBA\`), empty
  models, and skipped unknown chunks.
- \`malformed/\`: every file must be rejected atomically with exactly the
  \`family\`/\`code\` listed in \`corpus.json\`.
- \`corpus.json\`: machine-readable index of both groups.

Every fixture is generated by \`scripts/generate-vox-fixtures.mjs\`, which
self-checks each file against \`parseVox\`/\`encodeVox\` before writing, so
the corpus can never drift from the codec. Regenerate after a build with:

\`\`\`sh
pnpm build
node scripts/generate-vox-fixtures.mjs
\`\`\`
`,
);

console.log(
  `wrote ${knownRecords.length} known and ${rejectedRecords.length} rejected VOX fixtures`,
);
