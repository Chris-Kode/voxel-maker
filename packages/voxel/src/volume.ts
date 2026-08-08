import {
  WorkspaceError,
  materialId,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";

/** Frozen v1 chunk edge length (plan 3.1 / ADR-0004): 16 voxels per axis. */
export const CHUNK_EDGE = 16;

/** Voxels per chunk: `16^3`. */
export const CHUNK_VOXEL_COUNT = CHUNK_EDGE * CHUNK_EDGE * CHUNK_EDGE;

/** Per-volume resource limits (ADR-0009 defaults; callers may lower). */
export interface VoxelVolumeLimits {
  /** Inclusive per-axis bound for voxel coordinates. */
  readonly maxCoordinate: number;
  /** Maximum occupied extent (`max - min`) on any axis. */
  readonly maxExtent: number;
  /** Maximum number of non-empty chunks in one volume. */
  readonly maxChunks: number;
  /** Maximum number of occupied voxels in one volume. */
  readonly maxOccupiedVoxels: number;
}

/** ADR-0009 hard defaults for one voxel volume. */
export const DEFAULT_VOXEL_VOLUME_LIMITS: VoxelVolumeLimits = Object.freeze({
  maxCoordinate: 1_048_575,
  maxExtent: 2_048,
  maxChunks: 262_144,
  maxOccupiedVoxels: 1_000_000,
});

/**
 * Opaque token that gates every mutating volume operation. The owning
 * `DocumentStore` mints exactly one token per store and hands it only to the
 * command bus; public consumer interfaces never receive it.
 */
export interface VoxelWriteCapability {
  readonly __kind: "VoxelWriteCapability";
}

/** One changed voxel inside a chunk, expressed as an X-fastest local index. */
export interface VoxelPatch {
  readonly index: number;
  readonly oldValue: MaterialId;
  readonly newValue: MaterialId;
}

/** Compact change information for one touched chunk (plan 5.2). */
export interface ChunkChange {
  readonly coordinate: Vec3i;
  /** In-session chunk revision after the mutation; excluded from semantic state. */
  readonly revision: number;
  readonly patches: readonly VoxelPatch[];
}

/** Compact, invertible change set for one volume (plan S3.15). */
export interface VoxelChangeSet {
  readonly volumeId: VolumeId;
  readonly chunks: readonly ChunkChange[];
}

/** Immutable read surface of a voxel volume. */
export interface VoxelVolumeReadView {
  readonly volumeId: VolumeId;
  /** Material at a voxel coordinate; 0 when empty or the volume has no chunk. */
  getVoxel(coordinate: Vec3i): MaterialId;
  /**
   * Copy of a chunk's 4096 X-fastest values, or undefined when the chunk is
   * not allocated. Mutating the copy never affects the volume.
   */
  getChunk(coordinate: Vec3i): Uint16Array | undefined;
  /** Number of currently allocated non-empty chunks. */
  chunkCount(): number;
  /** Allocated chunk coordinates in stable X, then Y, then Z order. */
  chunkCoordinates(): readonly Vec3i[];
  /** Number of occupied (non-zero) voxels. */
  occupiedCount(): number;
  /** Half-open bounds of occupied voxels, or undefined when empty. */
  occupiedBounds(): IntAabb | undefined;
}

interface Chunk {
  readonly values: Uint16Array;
  revision: number;
}

/** Half-open occupied bounds of a volume, tracked incrementally. */
interface OccupiedBounds {
  readonly min: Vec3i;
  readonly max: Vec3i;
}

/** Bounds of a single voxel point (half-open unit cube). */
const pointBounds = (point: Vec3i): OccupiedBounds => ({
  min: [point[0], point[1], point[2]],
  max: [point[0] + 1, point[1] + 1, point[2] + 1],
});

/** Union of two half-open bounds; never mutates its inputs. */
const unionBounds = (a: OccupiedBounds, b: OccupiedBounds): OccupiedBounds => ({
  min: [
    Math.min(a.min[0], b.min[0]),
    Math.min(a.min[1], b.min[1]),
    Math.min(a.min[2], b.min[2]),
  ],
  max: [
    Math.max(a.max[0], b.max[0]),
    Math.max(a.max[1], b.max[1]),
    Math.max(a.max[2], b.max[2]),
  ],
});

/** True when the point lies on any face of the half-open bounds. */
const isOnBoundary = (bounds: OccupiedBounds, point: Vec3i): boolean =>
  point[0] === bounds.min[0] ||
  point[0] === bounds.max[0] - 1 ||
  point[1] === bounds.min[1] ||
  point[1] === bounds.max[1] - 1 ||
  point[2] === bounds.min[2] ||
  point[2] === bounds.max[2] - 1;

const floorDiv = (value: number): number => Math.floor(value / CHUNK_EDGE);
const modulo = (value: number): number =>
  ((value % CHUNK_EDGE) + CHUNK_EDGE) % CHUNK_EDGE;

/** Chunk coordinate of a voxel coordinate (mathematical floor division). */
export function chunkCoordinate(coordinate: Vec3i): Vec3i {
  return [
    floorDiv(coordinate[0]),
    floorDiv(coordinate[1]),
    floorDiv(coordinate[2]),
  ];
}

/** Local coordinate of a voxel coordinate inside its chunk (positive modulo). */
export function localCoordinate(coordinate: Vec3i): Vec3i {
  return [modulo(coordinate[0]), modulo(coordinate[1]), modulo(coordinate[2])];
}

/** X-fastest local index: `x + edge * (y + edge * z)`. */
export function chunkIndex(local: Vec3i): number {
  return local[0] + CHUNK_EDGE * (local[1] + CHUNK_EDGE * local[2]);
}

/** Stable map key for a chunk coordinate: `"x,y,z"`. */
export function chunkKey(coordinate: Vec3i): string {
  return `${String(coordinate[0])},${String(coordinate[1])},${String(coordinate[2])}`;
}

/** Half-open voxel-space bounds of one chunk (plan 5.2 event bounds). */
export function chunkBounds(coordinate: Vec3i): IntAabb {
  return {
    min: [
      coordinate[0] * CHUNK_EDGE,
      coordinate[1] * CHUNK_EDGE,
      coordinate[2] * CHUNK_EDGE,
    ],
    max: [
      (coordinate[0] + 1) * CHUNK_EDGE,
      (coordinate[1] + 1) * CHUNK_EDGE,
      (coordinate[2] + 1) * CHUNK_EDGE,
    ],
  };
}

const parseChunkKey = (key: string): Vec3i => {
  const [x, y, z] = key.split(",");
  return [Number(x), Number(y), Number(z)];
};

const compareVec3i = (a: Vec3i, b: Vec3i): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const isEmptyChunk = (chunk: Chunk): boolean => {
  for (const value of chunk.values) {
    if (value !== 0) return false;
  }
  return true;
};

/**
 * Sparse 16-cubed unsigned-16-bit volume (plan 5.2). Chunks are allocated
 * lazily, empty chunks are reclaimed canonically after mutation, and every
 * mutating operation requires the store's `VoxelWriteCapability`.
 */
export class VoxelVolume implements VoxelVolumeReadView {
  readonly volumeId: VolumeId;
  readonly limits: VoxelVolumeLimits;
  readonly #capability: VoxelWriteCapability;
  #chunks: Map<string, Chunk>;
  #occupiedCount = 0;
  /** Incremental occupied bounds; undefined when empty or stale. */
  #bounds: OccupiedBounds | undefined;

  constructor(
    volumeId: VolumeId,
    limits: VoxelVolumeLimits,
    capability: VoxelWriteCapability,
  ) {
    this.volumeId = volumeId;
    this.limits = limits;
    this.#capability = capability;
    this.#chunks = new Map();
    this.#bounds = undefined;
  }

  getVoxel(coordinate: Vec3i): MaterialId {
    const parsed = parseCoordinate(coordinate, this.limits);
    const chunk = this.#chunks.get(chunkKey(parsed.chunk));
    if (chunk === undefined) return 0 as MaterialId;
    return chunk.values[chunkIndex(parsed.local)] as MaterialId;
  }

  getChunk(coordinate: Vec3i): Uint16Array | undefined {
    const chunk = this.#chunks.get(chunkKey(coordinate));
    return chunk === undefined ? undefined : chunk.values.slice();
  }

  chunkCount(): number {
    return this.#chunks.size;
  }

  chunkCoordinates(): readonly Vec3i[] {
    return [...this.#chunks.keys()].map(parseChunkKey).sort(compareVec3i);
  }

  occupiedCount(): number {
    return this.#occupiedCount;
  }

  occupiedBounds(): IntAabb | undefined {
    return this.#bounds ?? this.#recomputeBounds();
  }

  /** Scans all chunks and caches the occupied bounds; undefined when empty. */
  #recomputeBounds(): OccupiedBounds | undefined {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const [key, chunk] of this.#chunks) {
      const [cx, cy, cz] = parseChunkKey(key);
      for (let index = 0; index < CHUNK_VOXEL_COUNT; index += 1) {
        if (chunk.values[index] === 0) continue;
        const x = cx * CHUNK_EDGE + (index % CHUNK_EDGE);
        const y =
          cy * CHUNK_EDGE + (Math.floor(index / CHUNK_EDGE) % CHUNK_EDGE);
        const z =
          cz * CHUNK_EDGE + Math.floor(index / (CHUNK_EDGE * CHUNK_EDGE));
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
    if (!Number.isFinite(minX)) return undefined;
    const bounds: OccupiedBounds = {
      min: [minX, minY, minZ],
      max: [maxX + 1, maxY + 1, maxZ + 1],
    };
    this.#bounds = bounds;
    return bounds;
  }

  /**
   * Sets one voxel to a material value. Returns the chunk change, or
   * undefined when the voxel already holds the same material (a no-op).
   */
  setVoxel(
    coordinate: Vec3i,
    material: number,
    capability: VoxelWriteCapability,
  ): ChunkChange | undefined {
    this.#assertWriteCapability(capability);
    const parsed = parseCoordinate(coordinate, this.limits);
    const value = materialId(material);
    const key = chunkKey(parsed.chunk);
    let chunk = this.#chunks.get(key);
    const index = chunkIndex(parsed.local);
    const oldValue =
      chunk === undefined
        ? (0 as MaterialId)
        : (chunk.values[index] as MaterialId);
    if (oldValue === value) return undefined;
    // Limit checks run before any allocation or mutation (ADR-0009).
    if (oldValue === 0) {
      if (this.#occupiedCount >= this.limits.maxOccupiedVoxels) {
        throw new WorkspaceError({
          family: "limit",
          code: "TOO_MANY_OCCUPIED_VOXELS",
          message: "Volume exceeds its occupied-voxel limit",
          context: { volumeId: this.volumeId },
        });
      }
      const current = this.#bounds ?? this.#recomputeBounds();
      const candidate =
        current === undefined
          ? pointBounds(coordinate)
          : unionBounds(current, pointBounds(coordinate));
      for (let axis = 0; axis < 3; axis += 1) {
        const maxComponent = candidate.max[axis] as number;
        const minComponent = candidate.min[axis] as number;
        const extent = maxComponent - minComponent;
        if (extent > this.limits.maxExtent) {
          throw new WorkspaceError({
            family: "limit",
            code: "EXTENT_LIMIT_EXCEEDED",
            message: "Volume occupied extent exceeds its per-axis limit",
            context: {
              volumeId: this.volumeId,
              axis,
              extent,
              maxExtent: this.limits.maxExtent,
            },
          });
        }
      }
    }
    if (chunk === undefined) {
      if (this.#chunks.size >= this.limits.maxChunks) {
        throw new WorkspaceError({
          family: "limit",
          code: "TOO_MANY_CHUNKS",
          message: "Volume exceeds its non-empty chunk limit",
          context: { volumeId: this.volumeId },
        });
      }
      const fresh: Chunk = {
        values: new Uint16Array(CHUNK_VOXEL_COUNT),
        revision: 0,
      };
      this.#chunks.set(key, fresh);
      chunk = fresh;
    }
    chunk.values[index] = value;
    chunk.revision += 1;
    if (oldValue === 0) {
      this.#occupiedCount += 1;
      const current = this.#bounds ?? this.#recomputeBounds();
      this.#bounds =
        current === undefined
          ? pointBounds(coordinate)
          : unionBounds(current, pointBounds(coordinate));
    }
    return {
      coordinate: parsed.chunk,
      revision: chunk.revision,
      patches: [{ index, oldValue, newValue: value }],
    };
  }

  /**
   * Removes one voxel (sets it to empty). Returns the chunk change, or
   * undefined when the voxel was already empty (a no-op). Empty chunks are
   * reclaimed canonically.
   */
  removeVoxel(
    coordinate: Vec3i,
    capability: VoxelWriteCapability,
  ): ChunkChange | undefined {
    this.#assertWriteCapability(capability);
    const parsed = parseCoordinate(coordinate, this.limits);
    const key = chunkKey(parsed.chunk);
    const chunk = this.#chunks.get(key);
    if (chunk === undefined) return undefined;
    const index = chunkIndex(parsed.local);
    const oldValue = chunk.values[index] as MaterialId;
    if (oldValue === 0) return undefined;
    chunk.values[index] = 0;
    chunk.revision += 1;
    this.#occupiedCount -= 1;
    if (isEmptyChunk(chunk)) this.#chunks.delete(key);
    // A boundary removal may shrink the occupied extent; recompute lazily.
    if (this.#bounds !== undefined && isOnBoundary(this.#bounds, coordinate)) {
      this.#bounds = undefined;
    }
    return {
      coordinate: parsed.chunk,
      revision: chunk.revision,
      patches: [{ index, oldValue, newValue: 0 as MaterialId }],
    };
  }

  /** Deep copy for copy-on-write transaction staging; shares the write token. */
  clone(): VoxelVolume {
    const clone = new VoxelVolume(this.volumeId, this.limits, this.#capability);
    for (const [key, chunk] of this.#chunks) {
      clone.#chunks.set(key, {
        values: chunk.values.slice(),
        revision: chunk.revision,
      });
    }
    clone.#occupiedCount = this.#occupiedCount;
    // Bounds objects are never mutated after creation, so sharing is safe.
    clone.#bounds = this.#bounds;
    return clone;
  }

  #assertWriteCapability(capability: VoxelWriteCapability): void {
    if (capability !== this.#capability) {
      throw new WorkspaceError({
        family: "internal",
        code: "WRITE_CAPABILITY_REQUIRED",
        message:
          "Voxel mutation requires the store write capability held by the command bus",
      });
    }
  }
}

interface ParsedCoordinate {
  readonly chunk: Vec3i;
  readonly local: Vec3i;
}

function parseCoordinate(
  coordinate: Vec3i,
  limits: VoxelVolumeLimits,
): ParsedCoordinate {
  for (let axis = 0; axis < 3; axis += 1) {
    const component = coordinate[axis];
    if (
      component === undefined ||
      !Number.isInteger(component) ||
      Math.abs(component) > limits.maxCoordinate
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_VOXEL_COORDINATE",
        message: `Voxel coordinates must be integers within +-${String(limits.maxCoordinate)}`,
        path: ["coordinate", axis],
        context: { value: String(component) },
      });
    }
  }
  return {
    chunk: chunkCoordinate(coordinate),
    local: localCoordinate(coordinate),
  };
}
