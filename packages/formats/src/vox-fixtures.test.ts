import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { encodeVox, parseVox } from "./vox.js";

/**
 * Corpus test for the checked-in VOX fixtures (plan S8.6, ticket #24):
 * golden known-good files must parse and round-trip byte-identically, and
 * every malformed fixture must be rejected atomically with exactly the
 * `family`/`code` recorded in `corpus.json`.
 *
 * Regenerate the corpus with `node scripts/generate-vox-fixtures.mjs`.
 */

const CORPUS_DIR = new URL("../../../fixtures/vox/", import.meta.url);
const corpusUrl = new URL("corpus.json", CORPUS_DIR);

interface CorpusEntry {
  readonly file: string;
  readonly vector: string;
  readonly byteLength: number;
  readonly models?: number;
  readonly voxels?: number;
  readonly paletteExplicit?: boolean;
  readonly family?: string;
  readonly code?: string;
}

interface Corpus {
  readonly schemaVersion: number;
  readonly known: readonly CorpusEntry[];
  readonly rejected: readonly CorpusEntry[];
}

describe("VOX fixture corpus", () => {
  it("round-trips every known fixture and keeps the golden byte-stable", async () => {
    const corpus = JSON.parse(await readFile(corpusUrl, "utf8")) as Corpus;
    expect(corpus.schemaVersion).toBe(1);
    for (const entry of corpus.known) {
      const bytes = await readFile(new URL(entry.file, CORPUS_DIR));
      expect(bytes.byteLength).toBe(entry.byteLength);
      const parsed = parseVox(bytes);
      expect(parsed.models.length).toBe(entry.models);
      const voxelCount = parsed.models.reduce(
        (sum, model) => sum + model.voxels.length,
        0,
      );
      expect(voxelCount).toBe(entry.voxels);
      expect(parsed.paletteExplicit).toBe(entry.paletteExplicit);
      // Re-encoding must reproduce the exact bytes for the golden file.
      if (entry.file === "known/cube-two-colors.vox") {
        const reencoded = encodeVox({
          models: parsed.models,
          palette: parsed.palette,
        });
        expect(Buffer.from(reencoded).equals(Buffer.from(bytes))).toBe(true);
      }
    }
  });

  it("rejects every malformed fixture with the recorded family and code", async () => {
    const corpus = JSON.parse(await readFile(corpusUrl, "utf8")) as Corpus;
    for (const entry of corpus.rejected) {
      const bytes = await readFile(new URL(entry.file, CORPUS_DIR));
      expect(bytes.byteLength).toBe(entry.byteLength);
      let caught: { family?: string; code?: string } | undefined;
      try {
        parseVox(bytes);
      } catch (error) {
        caught = error as { family?: string; code?: string };
      }
      expect(
        caught,
        `${entry.file} (${entry.vector}) must be rejected`,
      ).toBeDefined();
      expect(caught?.family, entry.file).toBe(entry.family);
      expect(caught?.code, entry.file).toBe(entry.code);
    }
  });

  it("contains exactly the checked-in known and malformed files", async () => {
    const knownFiles = (await readdir(new URL("known/", CORPUS_DIR))).sort();
    const malformedFiles = (
      await readdir(new URL("malformed/", CORPUS_DIR))
    ).sort();
    const corpus = JSON.parse(await readFile(corpusUrl, "utf8")) as Corpus;
    expect(knownFiles).toEqual(
      corpus.known.map((entry) => entry.file.slice("known/".length)).sort(),
    );
    expect(malformedFiles).toEqual(
      corpus.rejected
        .map((entry) => entry.file.slice("malformed/".length))
        .sort(),
    );
  });

  it("covers axis, color, and palette semantics on the golden cube", async () => {
    const bytes = await readFile(
      new URL("known/cube-two-colors.vox", CORPUS_DIR),
    );
    const parsed = parseVox(bytes);
    const model = parsed.models[0];
    expect(model).toBeDefined();
    if (model === undefined) return;
    // All eight corners of the 2x2x2 cube, exactly once each.
    expect(model.voxels).toHaveLength(8);
    const keys = new Set(
      model.voxels.map((v) => `${String(v.x)},${String(v.y)},${String(v.z)}`),
    );
    expect(keys.size).toBe(8);
    expect(parsed.palette[1]).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parsed.palette[2]).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(parsed.palette[0]).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});
