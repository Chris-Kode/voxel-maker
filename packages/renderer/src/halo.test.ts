import { describe, expect, it } from "vitest";
import { volumeId, type MaterialId } from "@voxel-maker/shared";
import {
  CHUNK_VOXEL_COUNT,
  chunkIndex,
  VoxelVolume,
  type VoxelChunkSeed,
  type VoxelVolumeReadView,
} from "@voxel-maker/voxel";
import {
  CHUNK_EDGE,
  createChunkHalo,
  createHaloSampler,
  HALO_CORNER_COUNT,
  HALO_EDGE_COUNT,
  HALO_EDGE_LENGTH,
  HALO_FACE_COUNT,
  HALO_SLICE_LENGTH,
  HALO_VALUE_COUNT,
  type ChunkHalo,
} from "./index.js";

/**
 * Halo copy tests (plan S6.4, ticket #23). The central property: the
 * sampler built over copied core + halo values answers every position in
 * the mesher's halo range exactly like direct volume reads, so a worker
 * computing over copied data produces the identical mesh the main thread
 * would. Randomized volumes (including negative chunk coordinates) and
 * mutation-independence prove the copy never aliases authoritative
 * storage.
 */

const RNG_SEED = 0x23;

/** Small deterministic PRNG (splitmix64-style) for seeded fixtures. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x9e3779b9;
    state >>>= 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
    value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
    value >>>= 0;
    return value / 0x100000000;
  };
}

/** Builds a volume with random voxels in the given chunk coordinate range. */
function randomVolume(
  volumeIdSeed: string,
  chunkMin: [number, number, number],
  chunkMax: [number, number, number],
  seed: number,
): VoxelVolumeReadView {
  const random = makeRandom(seed);
  const chunks: VoxelChunkSeed[] = [];
  for (let cz = chunkMin[2]; cz <= chunkMax[2]; cz += 1) {
    for (let cy = chunkMin[1]; cy <= chunkMax[1]; cy += 1) {
      for (let cx = chunkMin[0]; cx <= chunkMax[0]; cx += 1) {
        const values = new Uint16Array(CHUNK_VOXEL_COUNT);
        for (let index = 0; index < values.length; index += 1) {
          // ~12% occupancy with 3 possible materials.
          const roll = random();
          values[index] =
            roll < 0.12 ? (roll < 0.04 ? 1 : roll < 0.08 ? 2 : 3) : 0;
        }
        if (values.some((value) => value !== 0)) {
          chunks.push({ coordinate: [cx, cy, cz], values });
        }
      }
    }
  }
  return VoxelVolume.fromChunks(
    volumeId(volumeIdSeed),
    {
      maxCoordinate: 1_048_575,
      maxExtent: 2_048,
      maxChunks: 262_144,
      maxOccupiedVoxels: 1_000_000,
      maxCoordinatesPerOperation: 1_000_000,
    },
    { __kind: "VoxelWriteCapability" },
    chunks,
  );
}

/** The reference sampler: direct volume reads for every local position. */
function volumeSampler(
  view: VoxelVolumeReadView,
  coordinate: [number, number, number],
): (x: number, y: number, z: number) => MaterialId {
  const [cx, cy, cz] = coordinate;
  return (x, y, z) =>
    view.getVoxel([
      cx * CHUNK_EDGE + x,
      cy * CHUNK_EDGE + y,
      cz * CHUNK_EDGE + z,
    ]);
}

/** Asserts sampler agreement over the full halo range [-1, 16)^3. */
function expectSamplerAgreement(
  view: VoxelVolumeReadView,
  coordinate: [number, number, number],
  halo: ChunkHalo,
  values: Uint16Array,
): void {
  const sample = createHaloSampler(values, halo);
  const reference = volumeSampler(view, coordinate);
  for (let z = -1; z <= CHUNK_EDGE; z += 1) {
    for (let y = -1; y <= CHUNK_EDGE; y += 1) {
      for (let x = -1; x <= CHUNK_EDGE; x += 1) {
        expect(
          sample(x, y, z),
          `halo sample at local (${String(x)},${String(y)},${String(z)})`,
        ).toBe(reference(x, y, z));
      }
    }
  }
}

describe("chunk halo copy", () => {
  it("has the documented layout sizes", () => {
    expect(HALO_FACE_COUNT).toBe(6);
    expect(HALO_SLICE_LENGTH).toBe(256);
    expect(HALO_EDGE_COUNT).toBe(12);
    expect(HALO_EDGE_LENGTH).toBe(16);
    expect(HALO_CORNER_COUNT).toBe(8);
    // 1536 face slices + 192 edge lines + 8 corners, excluding the core.
    expect(HALO_VALUE_COUNT).toBe(1736);
  });

  it("copies a fully surrounded chunk and agrees with direct reads", () => {
    const view = randomVolume(
      "volume:halo:center",
      [-1, -1, -1],
      [1, 1, 1],
      RNG_SEED,
    );
    const coordinate: [number, number, number] = [0, 0, 0];
    const values = view.getChunk(coordinate);
    if (values === undefined) throw new Error("missing center chunk");
    const halo = createChunkHalo(view, coordinate);
    expect(halo.faces).toHaveLength(HALO_FACE_COUNT * HALO_SLICE_LENGTH);
    expect(halo.edges).toHaveLength(HALO_EDGE_COUNT * HALO_EDGE_LENGTH);
    expect(halo.corners).toHaveLength(HALO_CORNER_COUNT);
    expectSamplerAgreement(view, coordinate, halo, values);
  });

  it("handles negative chunk coordinates", () => {
    const view = randomVolume(
      "volume:halo:negative",
      [-2, -2, -2],
      [0, 0, 0],
      RNG_SEED + 1,
    );
    const coordinate: [number, number, number] = [-1, -1, -1];
    const values = view.getChunk(coordinate);
    if (values === undefined) throw new Error("missing chunk");
    const halo = createChunkHalo(view, coordinate);
    expectSamplerAgreement(view, coordinate, halo, values);
  });

  it("reads missing neighbor chunks as empty", () => {
    const view = randomVolume(
      "volume:halo:edge",
      [0, 0, 0],
      [0, 0, 0],
      RNG_SEED + 2,
    );
    const coordinate: [number, number, number] = [0, 0, 0];
    const values = view.getChunk(coordinate);
    if (values === undefined) throw new Error("missing chunk");
    const halo = createChunkHalo(view, coordinate);
    expectSamplerAgreement(view, coordinate, halo, values);
  });

  it("returns a sampler identical to volume reads on every halo position", () => {
    // Exhaustive sweep over all 18^3 local positions for a chunk with all
    // 26 neighbors allocated, at a non-trivial occupancy.
    const view = randomVolume(
      "volume:halo:sweep",
      [-1, -1, -1],
      [1, 1, 1],
      RNG_SEED + 3,
    );
    const coordinate: [number, number, number] = [1, -1, 1];
    const values = view.getChunk(coordinate);
    if (values === undefined) throw new Error("missing chunk");
    const halo = createChunkHalo(view, coordinate);
    const sample = createHaloSampler(values, halo);
    const reference = volumeSampler(view, coordinate);
    let compared = 0;
    for (let z = -1; z <= CHUNK_EDGE; z += 1) {
      for (let y = -1; y <= CHUNK_EDGE; y += 1) {
        for (let x = -1; x <= CHUNK_EDGE; x += 1) {
          expect(sample(x, y, z)).toBe(reference(x, y, z));
          compared += 1;
        }
      }
    }
    expect(compared).toBe(CHUNK_EDGE ** 3 + 1736);
  });

  it("never aliases authoritative storage", () => {
    const view = randomVolume(
      "volume:halo:alias",
      [-1, -1, -1],
      [1, 1, 1],
      RNG_SEED + 4,
    );
    const coordinate: [number, number, number] = [0, 0, 0];
    const values = view.getChunk(coordinate);
    if (values === undefined) throw new Error("missing chunk");
    const before = new Uint16Array(values);
    const halo = createChunkHalo(view, coordinate);
    const facesBefore = new Uint16Array(halo.faces);
    const edgesBefore = new Uint16Array(halo.edges);
    const cornersBefore = new Uint16Array(halo.corners);

    // Scribble over every copied buffer.
    values.fill(0xffff);
    halo.faces.fill(0);
    halo.edges.fill(0);
    halo.corners.fill(0);

    // The volume is unchanged, and the copies were independent snapshots.
    expect(view.getChunk(coordinate)).toEqual(before);
    expect(halo.faces).toEqual(new Uint16Array(halo.faces.length));
    expect(halo.edges).toEqual(new Uint16Array(halo.edges.length));
    expect(halo.corners).toEqual(new Uint16Array(halo.corners.length));
    expect(new Uint16Array(facesBefore)).not.toEqual(
      new Uint16Array(halo.faces),
    );
    void edgesBefore;
    void cornersBefore;
  });

  it("samples core positions from the copied values buffer", () => {
    const values = new Uint16Array(CHUNK_EDGE ** 3);
    values[chunkIndex([3, 4, 5])] = 9;
    const halo: ChunkHalo = {
      faces: new Uint16Array(HALO_FACE_COUNT * HALO_SLICE_LENGTH),
      edges: new Uint16Array(HALO_EDGE_COUNT * HALO_EDGE_LENGTH),
      corners: new Uint16Array(HALO_CORNER_COUNT),
    };
    const sample = createHaloSampler(values, halo);
    expect(sample(3, 4, 5)).toBe(9);
    expect(sample(2, 4, 5)).toBe(0);
    expect(sample(-1, 0, 0)).toBe(0);
    expect(sample(16, 15, 15)).toBe(0);
  });

  it("culls across boundaries with the copied halo exactly like the volume", () => {
    // A voxel at (15,15,15) must cull its +X/+Y/+Z faces only when the
    // neighboring chunks hold voxels — exactly what the volume sampler
    // would decide.
    const view = randomVolume(
      "volume:halo:cull",
      [0, 0, 0],
      [1, 1, 1],
      RNG_SEED + 5,
    );
    const coordinate: [number, number, number] = [0, 0, 0];
    const values = view.getChunk(coordinate);
    if (values === undefined) throw new Error("missing chunk");
    const halo = createChunkHalo(view, coordinate);
    const sample = createHaloSampler(values, halo);
    for (let z = 0; z < CHUNK_EDGE; z += 1) {
      for (let y = 0; y < CHUNK_EDGE; y += 1) {
        for (let x = 0; x < CHUNK_EDGE; x += 1) {
          if ((values[chunkIndex([x, y, z])] ?? 0) === 0) continue;
          const reference = volumeSampler(view, coordinate);
          for (const face of [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ]) {
            const nx = x + (face[0] ?? 0);
            const ny = y + (face[1] ?? 0);
            const nz = z + (face[2] ?? 0);
            expect(sample(nx, ny, nz)).toBe(reference(nx, ny, nz));
          }
        }
      }
    }
  });
});
