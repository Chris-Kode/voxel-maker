import {
  WorkspaceError,
  materialId,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import {
  assertIterationDomain,
  boxCoordinates,
  cylinderCoordinates,
  intersectAabb,
  sphereCoordinates,
  type ShapeAxis,
  type ShapeIterationOptions,
} from "./shapes.js";
import {
  mirrorCoordinate,
  rotateRegionPlan,
  translateAabb,
  type QuarterTurns,
} from "./regions.js";

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
  /**
   * Maximum voxels inspected, generated, or changed by one operation
   * (ADR-0009: 1,000,000 per transaction).
   */
  readonly maxCoordinatesPerOperation: number;
}

/** ADR-0009: voxels inspected, generated, or changed by one operation. */
export const MAX_VOXELS_PER_OPERATION = 1_000_000;

/** ADR-0009 hard defaults for one voxel volume. */
export const DEFAULT_VOXEL_VOLUME_LIMITS: VoxelVolumeLimits = Object.freeze({
  maxCoordinate: 1_048_575,
  maxExtent: 2_048,
  maxChunks: 262_144,
  maxOccupiedVoxels: 1_000_000,
  maxCoordinatesPerOperation: MAX_VOXELS_PER_OPERATION,
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

/** One coordinate/material pair of a batch write (plan S3.6). */
export interface VoxelEntry {
  readonly coordinate: Vec3i;
  readonly material: MaterialId;
}

/**
 * One decoded chunk ready to install into a fresh volume (plan S5.3 /
 * ADR-0004): the signed chunk coordinate and the 4096 X-fastest unsigned
 * 16-bit values. Loaded chunks are immutable seeds; installing volumes copy
 * them so the loader's buffers are never shared with live volumes.
 */
export interface VoxelChunkSeed {
  readonly coordinate: Vec3i;
  readonly values: Uint16Array;
}

/** One target patch of a compact change-set application (plan S3.15). */
export interface VoxelPatchTarget {
  readonly index: number;
  /** Value to restore, 0..65535; 0 removes the voxel. */
  readonly oldValue: number;
}

/** Chunk-scoped target patches for `applyPatches` (plan S3.15). */
export interface VoxelPatchChunk {
  readonly coordinate: Vec3i;
  readonly patches: readonly VoxelPatchTarget[];
}

/** Immutable read surface of a voxel volume. */
export interface VoxelVolumeReadView {
  readonly volumeId: VolumeId;
  /**
   * The volume's resource limits (ADR-0009; callers may lower them).
   * Read-only: consumers can preflight bounded operations but never
   * change the limits.
   */
  readonly limits: VoxelVolumeLimits;
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

  /**
   * In-session mutation revision of the chunk at `coordinate`, or undefined
   * when the chunk is absent. Cloning preserves revisions and every
   * mutation bumps them, so a staged chunk whose revision differs from the
   * committed chunk (or that is absent there) changed during staging.
   * Revisions are runtime metadata, never semantic content.
   */
  chunkRevision(coordinate: Vec3i): number | undefined {
    return this.#chunks.get(chunkKey(coordinate))?.revision;
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
   * Validated construction of a volume from decoded chunk seeds (plan S5.3).
   * Chunks are copied, sorted canonically, and checked against every hard
   * volume limit (chunk count, occupied voxels, extent, coordinate domain)
   * before the volume is returned, so a corrupt or oversized load can never
   * install partial state. Empty, duplicate, or unordered chunks are
   * rejected; installed chunks start at in-session revision 0 because chunk
   * revisions are runtime state, never semantic content.
   */
  static fromChunks(
    volumeId: VolumeId,
    limits: VoxelVolumeLimits,
    capability: VoxelWriteCapability,
    chunks: readonly VoxelChunkSeed[],
  ): VoxelVolume {
    if (chunks.length > limits.maxChunks) {
      throw new WorkspaceError({
        family: "limit",
        code: "TOO_MANY_CHUNKS",
        message: "Volume exceeds its non-empty chunk limit",
        context: {
          volumeId,
          requested: chunks.length,
          limit: limits.maxChunks,
        },
      });
    }
    const ordered = [...chunks].sort((a, b) =>
      compareVec3i(a.coordinate, b.coordinate),
    );
    let previous: Vec3i | undefined;
    let occupied = 0;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    const installed = new Map<string, Chunk>();
    for (const seed of ordered) {
      const coordinate = parseChunkCoordinate(seed.coordinate, limits);
      if (previous !== undefined && compareVec3i(previous, coordinate) >= 0) {
        throw new WorkspaceError({
          family: "validation",
          code: "UNORDERED_CHUNK_TABLE",
          message:
            "Loaded chunk table must be strictly sorted by X, then Y, then Z",
          context: { volumeId, coordinate },
        });
      }
      previous = coordinate;
      if (seed.values.byteLength !== CHUNK_VOXEL_COUNT * 2) {
        throw new WorkspaceError({
          family: "validation",
          code: "INVALID_CHUNK_LENGTH",
          message: `Loaded chunk values must hold exactly ${String(CHUNK_VOXEL_COUNT)} unsigned 16-bit voxels`,
          context: { volumeId, coordinate },
        });
      }
      const values = new Uint16Array(seed.values);
      let chunkOccupied = 0;
      for (let index = 0; index < CHUNK_VOXEL_COUNT; index += 1) {
        const value = values[index] as number;
        if (value !== 0) {
          chunkOccupied += 1;
          const x = coordinate[0] * CHUNK_EDGE + (index % CHUNK_EDGE);
          const y =
            coordinate[1] * CHUNK_EDGE +
            (Math.floor(index / CHUNK_EDGE) % CHUNK_EDGE);
          const z =
            coordinate[2] * CHUNK_EDGE +
            Math.floor(index / (CHUNK_EDGE * CHUNK_EDGE));
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
      }
      if (chunkOccupied === 0) {
        throw new WorkspaceError({
          family: "validation",
          code: "EMPTY_CHUNK",
          message: "Loaded chunks must be non-empty",
          context: { volumeId, coordinate },
        });
      }
      occupied += chunkOccupied;
      if (occupied > limits.maxOccupiedVoxels) {
        throw new WorkspaceError({
          family: "limit",
          code: "TOO_MANY_OCCUPIED_VOXELS",
          message: "Volume exceeds its occupied-voxel limit",
          context: {
            volumeId,
            requested: occupied,
            limit: limits.maxOccupiedVoxels,
          },
        });
      }
      installed.set(chunkKey(coordinate), { values, revision: 0 });
    }
    const volume = new VoxelVolume(volumeId, limits, capability);
    volume.#chunks = installed;
    volume.#occupiedCount = occupied;
    if (occupied > 0) {
      for (let axis = 0; axis < 3; axis += 1) {
        const min = [minX, minY, minZ][axis] as number;
        const max = [maxX, maxY, maxZ][axis] as number;
        if (max - min > limits.maxExtent) {
          throw new WorkspaceError({
            family: "limit",
            code: "EXTENT_LIMIT_EXCEEDED",
            message: "Volume occupied extent exceeds its per-axis limit",
            context: {
              volumeId,
              axis,
              extent: max - min,
              maxExtent: limits.maxExtent,
            },
          });
        }
      }
      volume.#bounds = {
        min: [minX, minY, minZ],
        max: [maxX + 1, maxY + 1, maxZ + 1],
      };
    }
    return volume;
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

  /**
   * Sets many voxels atomically (plan S3.6). Duplicate coordinates resolve
   * last-write-wins in payload order, then writes are processed in canonical
   * sorted order. The whole operation is planned and preflighted before any
   * chunk is allocated or mutated, so a limit failure leaves the volume
   * byte-identical. Returns the compact change set for exact inversion.
   */
  setVoxels(
    entries: readonly VoxelEntry[],
    capability: VoxelWriteCapability,
  ): VoxelChangeSet {
    this.#assertWriteCapability(capability);
    const plan = this.#planEntries(entries, (entry) =>
      materialId(entry.material),
    );
    return this.#applyPlan(plan);
  }

  /**
   * Removes many voxels atomically (plan S3.6). Duplicate coordinates resolve
   * last-write-wins in payload order, then writes are processed in canonical
   * sorted order. Returns the compact change set for exact inversion.
   */
  removeVoxels(
    coordinates: readonly Vec3i[],
    capability: VoxelWriteCapability,
  ): VoxelChangeSet {
    this.#assertWriteCapability(capability);
    const plan = this.#planEntries(
      coordinates.map((coordinate) => ({
        coordinate,
        material: 0 as MaterialId,
      })),
      (entry) => entry.material,
    );
    return this.#applyPlan(plan);
  }

  /**
   * Applies a compact change-set patch list (plan S3.15): each patch restores
   * one voxel to `oldValue` (0 removes). Used by the command bus to replay
   * exact inverses of batch and fill commands without whole-document
   * snapshots. Atomic like every other mutating operation.
   */
  applyPatches(
    chunks: readonly VoxelPatchChunk[],
    capability: VoxelWriteCapability,
  ): VoxelChangeSet {
    this.#assertWriteCapability(capability);
    const entries: VoxelEntry[] = [];
    for (const chunk of chunks) {
      const chunkCoordinateValue = parseChunkCoordinate(
        chunk.coordinate,
        this.limits,
      );
      for (const patch of chunk.patches) {
        if (
          !Number.isInteger(patch.oldValue) ||
          patch.oldValue < 0 ||
          patch.oldValue > 65_535
        ) {
          throw new WorkspaceError({
            family: "validation",
            code: "INVALID_MATERIAL_ID",
            message: "Patch oldValue must be an integer from 0 through 65535",
            context: { value: String(patch.oldValue) },
          });
        }
        if (
          !Number.isInteger(patch.index) ||
          patch.index < 0 ||
          patch.index >= CHUNK_VOXEL_COUNT
        ) {
          throw new WorkspaceError({
            family: "validation",
            code: "INVALID_CHUNK_INDEX",
            message: `Chunk patch index must be an integer from 0 through ${String(CHUNK_VOXEL_COUNT - 1)}`,
            context: { value: String(patch.index) },
          });
        }
        const local = localFromIndex(patch.index);
        entries.push({
          coordinate: [
            chunkCoordinateValue[0] * CHUNK_EDGE + local[0],
            chunkCoordinateValue[1] * CHUNK_EDGE + local[1],
            chunkCoordinateValue[2] * CHUNK_EDGE + local[2],
          ],
          material: patch.oldValue as MaterialId,
        });
      }
    }
    const plan = this.#planEntries(entries, (entry) => entry.material);
    return this.#applyPlan(plan);
  }

  /**
   * Fills the half-open box `[min, max)` with one material (plan S3.7).
   * Coordinates outside the volume coordinate domain are clipped; the shape
   * is voxelized by the frozen rules in `shapes.ts`.
   */
  fillBox(
    region: IntAabb,
    material: number,
    capability: VoxelWriteCapability,
  ): VoxelChangeSet {
    this.#assertWriteCapability(capability);
    const value = materialId(material);
    const parsedRegion = this.#parseRegion(region);
    const coordinates = boxCoordinates(parsedRegion, this.#shapeOptions());
    return this.#applyPlan(
      this.#planEntries(
        coordinates.map((coordinate) => ({ coordinate, material: value })),
        (entry) => entry.material,
      ),
    );
  }

  /**
   * Fills the solid sphere with integer center and radius (plan S3.7).
   * Voxelization follows the frozen rule in `shapes.ts`.
   */
  fillSphere(
    center: Vec3i,
    radius: number,
    material: number,
    capability: VoxelWriteCapability,
  ): VoxelChangeSet {
    this.#assertWriteCapability(capability);
    const value = materialId(material);
    this.#assertIntegerPoint(center, "center");
    const coordinates = sphereCoordinates(center, radius, this.#shapeOptions());
    return this.#applyPlan(
      this.#planEntries(
        coordinates.map((coordinate) => ({ coordinate, material: value })),
        (entry) => entry.material,
      ),
    );
  }

  /**
   * Fills the axis-aligned solid cylinder with integer center, radius, and
   * height (plan S3.7). Voxelization follows the frozen rule in `shapes.ts`.
   */
  fillCylinder(
    center: Vec3i,
    radius: number,
    height: number,
    axis: ShapeAxis,
    material: number,
    capability: VoxelWriteCapability,
  ): VoxelChangeSet {
    this.#assertWriteCapability(capability);
    const value = materialId(material);
    this.#assertIntegerPoint(center, "center");
    const coordinates = cylinderCoordinates(
      center,
      radius,
      height,
      axis,
      this.#shapeOptions(),
    );
    return this.#applyPlan(
      this.#planEntries(
        coordinates.map((coordinate) => ({ coordinate, material: value })),
        (entry) => entry.material,
      ),
    );
  }

  /**
   * Replaces every voxel equal to `fromMaterial` with `toMaterial` inside an
   * optional half-open region (plan S3.8). Both values may be 0 (empty), so
   * the operation can paint empty voxels or erase a material. Without a
   * region the whole volume is scanned, which requires a non-empty source
   * filter; replacing empty voxels needs an explicit region because the
   * empty domain is unbounded. Returns the compact change set.
   */
  replaceMaterial(
    region: IntAabb | undefined,
    fromMaterial: number,
    toMaterial: number,
    capability: VoxelWriteCapability,
  ): VoxelChangeSet {
    this.#assertWriteCapability(capability);
    const from = this.#materialValue(fromMaterial, "fromMaterial");
    const to = this.#materialValue(toMaterial, "toMaterial");
    if (from === to) {
      return { volumeId: this.volumeId, chunks: [] };
    }
    const plan: PlannedPatch[] = [];
    if (region === undefined) {
      if (from === 0) {
        throw new WorkspaceError({
          family: "validation",
          code: "REGION_REQUIRED",
          message:
            "Replacing empty voxels requires an explicit region because the empty domain is unbounded",
        });
      }
      let inspected = 0;
      for (const [key, chunk] of this.#chunks) {
        const coordinate = parseChunkKey(key);
        for (let index = 0; index < CHUNK_VOXEL_COUNT; index += 1) {
          inspected += 1;
          if (inspected > this.limits.maxCoordinatesPerOperation) {
            throw this.#operationLimitError(inspected);
          }
          const oldValue = chunk.values[index] as MaterialId;
          if (oldValue === from) {
            plan.push({ chunk: coordinate, index, oldValue, newValue: to });
          }
        }
      }
    } else {
      const parsed = this.#parseRegion(region);
      const domain = intersectAabb(parsed, this.#coordinateDomain());
      if (domain !== undefined) {
        assertIterationDomain(domain, this.limits.maxCoordinatesPerOperation);
        let inspected = 0;
        for (let z = domain.min[2]; z < domain.max[2]; z += 1) {
          for (let y = domain.min[1]; y < domain.max[1]; y += 1) {
            for (let x = domain.min[0]; x < domain.max[0]; x += 1) {
              inspected += 1;
              if (inspected > this.limits.maxCoordinatesPerOperation) {
                throw this.#operationLimitError(inspected);
              }
              const coordinate: Vec3i = [x, y, z];
              const oldValue = this.getVoxel(coordinate);
              if (oldValue === from) {
                const parsedCoordinate = parseCoordinate(
                  coordinate,
                  this.limits,
                );
                plan.push({
                  chunk: parsedCoordinate.chunk,
                  index: chunkIndex(parsedCoordinate.local),
                  oldValue,
                  newValue: to,
                });
              }
            }
          }
        }
      }
    }
    return this.#applyPlan(plan);
  }

  /**
   * Copies the occupied voxels of the half-open source region to the
   * destination AABB whose min corner is `destination` (plan S3.9). The
   * source is snapshotted before any destination write, so an overlapping
   * source copies from the pre-operation state; destination collisions
   * overwrite explicitly. Returns the compact change set for exact
   * inversion.
   */
  copyRegion(
    source: IntAabb,
    destination: Vec3i,
    capability: VoxelWriteCapability,
  ): VoxelChangeSet {
    this.#assertWriteCapability(capability);
    const parsedSource = this.#parseRegion(source);
    this.#assertRegionInDomain(parsedSource, "source");
    const parsedDestination = this.#parsePoint(
      destination,
      "destination",
      this.limits.maxCoordinate,
    );
    const delta: Vec3i = [
      parsedDestination[0] - parsedSource.min[0],
      parsedDestination[1] - parsedSource.min[1],
      parsedDestination[2] - parsedSource.min[2],
    ];
    const destinationAabb = translateAabb(parsedSource, delta);
    this.#assertRegionInDomain(destinationAabb, "destination");
    const snapshot = this.#snapshotRegion(parsedSource);
    const entries = snapshot.map((entry) => ({
      coordinate: addVec3i(entry.coordinate, delta),
      material: entry.material,
    }));
    return this.#applyPlan(
      this.#planEntries(entries, (entry) => entry.material),
    );
  }

  /**
   * Removes every occupied voxel in the half-open region (plan S3.9).
   * Returns the compact change set for exact inversion.
   */
  deleteRegion(
    region: IntAabb,
    capability: VoxelWriteCapability,
  ): VoxelChangeSet {
    this.#assertWriteCapability(capability);
    const parsed = this.#parseRegion(region);
    this.#assertRegionInDomain(parsed, "region");
    const snapshot = this.#snapshotRegion(parsed);
    return this.#applyPlan(
      this.#planEntries(
        snapshot.map((entry) => ({
          coordinate: entry.coordinate,
          material: 0 as MaterialId,
        })),
        (entry) => entry.material,
      ),
    );
  }

  /**
   * Moves the occupied voxels of the half-open region by an integer delta
   * (plan S3.10). The source is snapshotted before the source is cleared and
   * the destination is written, so an overlapping source moves from the
   * pre-operation state; destination collisions overwrite explicitly
   * (`overwrite` is the v1 collision mode). Returns the compact change set
   * for exact inversion.
   */
  translateRegion(
    region: IntAabb,
    delta: Vec3i,
    capability: VoxelWriteCapability,
  ): VoxelChangeSet {
    this.#assertWriteCapability(capability);
    const parsed = this.#parseRegion(region);
    this.#assertRegionInDomain(parsed, "region");
    const parsedDelta = this.#parsePoint(
      delta,
      "delta",
      2 * this.limits.maxCoordinate + 1,
    );
    const destinationAabb = translateAabb(parsed, parsedDelta);
    this.#assertRegionInDomain(destinationAabb, "destination");
    const snapshot = this.#snapshotRegion(parsed);
    return this.#applyRegionMove(parsed, snapshot, (entry) =>
      addVec3i(entry.coordinate, parsedDelta),
    );
  }

  /**
   * Rotates the occupied voxels of the half-open region around the region
   * center by exact 90-degree increments (plan S3.11). The source is
   * snapshotted, cleared, and rewritten to the rotated AABB; destination
   * collisions overwrite explicitly. A region whose extents on the two
   * rotation-plane axes have different parities is rejected
   * (`INVALID_ROTATION_REGION`) because the exact lattice rotation would
   * land on half-integer positions; resampling is deferred in v1. Four
   * quarter turns are the identity.
   */
  rotateRegion(
    region: IntAabb,
    axis: ShapeAxis,
    quarterTurns: QuarterTurns,
    capability: VoxelWriteCapability,
  ): VoxelChangeSet {
    this.#assertWriteCapability(capability);
    const parsed = this.#parseRegion(region);
    this.#assertRegionInDomain(parsed, "region");
    const rotation = rotateRegionPlan(parsed, axis, quarterTurns);
    this.#assertRegionInDomain(rotation.destination, "destination");
    const snapshot = this.#snapshotRegion(parsed);
    return this.#applyRegionMove(parsed, snapshot, (entry) =>
      rotation.map(entry.coordinate),
    );
  }

  /**
   * Mirrors the occupied voxels of the half-open region across the plane
   * through the region center perpendicular to `axis` (plan S3.12). The
   * destination is the source region itself, so mirroring twice is the
   * identity. The source is snapshotted, cleared, and rewritten; destination
   * collisions overwrite explicitly.
   */
  mirrorRegion(
    region: IntAabb,
    axis: ShapeAxis,
    capability: VoxelWriteCapability,
  ): VoxelChangeSet {
    this.#assertWriteCapability(capability);
    const parsed = this.#parseRegion(region);
    this.#assertRegionInDomain(parsed, "region");
    const snapshot = this.#snapshotRegion(parsed);
    return this.#applyRegionMove(parsed, snapshot, (entry) =>
      mirrorCoordinate(parsed, axis, entry.coordinate),
    );
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

  /** Half-open coordinate domain of this volume (ADR-0009). */
  #coordinateDomain(): IntAabb {
    const max = this.limits.maxCoordinate;
    return { min: [-max, -max, -max], max: [max + 1, max + 1, max + 1] };
  }

  /** Shape iteration options derived from this volume's limits. */
  #shapeOptions(): ShapeIterationOptions {
    return {
      clip: this.#coordinateDomain(),
      maxCoordinates: this.limits.maxCoordinatesPerOperation,
    };
  }

  /** Rejects a half-open region that exceeds the volume coordinate domain. */
  #assertRegionInDomain(region: IntAabb, name: string): void {
    const domain = this.#coordinateDomain();
    for (let axis = 0; axis < 3; axis += 1) {
      if (
        (region.min[axis] as number) < (domain.min[axis] as number) ||
        (region.max[axis] as number) > (domain.max[axis] as number)
      ) {
        throw new WorkspaceError({
          family: "limit",
          code: "REGION_OUT_OF_BOUNDS",
          message: `${name} region exceeds the volume coordinate domain`,
          context: {
            volumeId: this.volumeId,
            region: {
              min: [region.min[0], region.min[1], region.min[2]],
              max: [region.max[0], region.max[1], region.max[2]],
            },
            domain: {
              min: [domain.min[0], domain.min[1], domain.min[2]],
              max: [domain.max[0], domain.max[1], domain.max[2]],
            },
          },
        });
      }
    }
  }

  /**
   * Snapshots the occupied voxels of an in-domain half-open region with
   * bounded iteration (ADR-0009): the iteration domain is guarded and the
   * inspected count is capped at the per-operation voxel limit.
   */
  #snapshotRegion(region: IntAabb): VoxelEntry[] {
    assertIterationDomain(region, this.limits.maxCoordinatesPerOperation);
    const entries: VoxelEntry[] = [];
    let inspected = 0;
    for (let z = region.min[2]; z < region.max[2]; z += 1) {
      for (let y = region.min[1]; y < region.max[1]; y += 1) {
        for (let x = region.min[0]; x < region.max[0]; x += 1) {
          inspected += 1;
          if (inspected > this.limits.maxCoordinatesPerOperation) {
            throw this.#operationLimitError(inspected);
          }
          const material = this.getVoxel([x, y, z]);
          if (material !== 0) {
            entries.push({ coordinate: [x, y, z], material });
          }
        }
      }
    }
    return entries;
  }

  /**
   * Applies a region move: clears the source region and writes the mapped
   * snapshot content, with an exact preflight estimate (plan S3.9-S3.12).
   * The clear entries precede the write entries so overlapping coordinates
   * resolve last-write-wins to the moved content.
   */
  #applyRegionMove(
    sourceRegion: IntAabb,
    snapshot: readonly VoxelEntry[],
    map: (entry: VoxelEntry) => Vec3i,
  ): VoxelChangeSet {
    const clears: VoxelEntry[] = [];
    const writes: VoxelEntry[] = [];
    for (const entry of snapshot) {
      clears.push({
        coordinate: entry.coordinate,
        material: 0 as MaterialId,
      });
      writes.push({ coordinate: map(entry), material: entry.material });
    }
    const plan = this.#planEntries(
      [...clears, ...writes],
      (entry) => entry.material,
      2 * this.limits.maxCoordinatesPerOperation,
    );
    const estimate = this.#estimateRegionResult(
      plan,
      sourceRegion,
      boundsOfEntries(writes),
    );
    return this.#applyPlan(plan, estimate);
  }

  /**
   * Exact post-operation resource estimate for a region move (plan
   * S3.9-S3.12): net occupied count, net chunk count (emptied source chunks
   * are reclaimed), and the exact post-operation occupied bounds. The bounds
   * are computed exactly only when the conservative union of the current
   * bounds and the destination content exceeds the extent limit; that scan
   * is bounded by the occupied-voxel limit.
   */
  #estimateRegionResult(
    plan: readonly PlannedPatch[],
    sourceRegion: IntAabb,
    destContentBounds: OccupiedBounds | undefined,
  ): RegionResultEstimate {
    let additions = 0;
    let removals = 0;
    const newChunks = new Set<string>();
    const removedByChunk = new Map<string, number>();
    const addedByChunk = new Map<string, number>();
    for (const patch of plan) {
      const key = chunkKey(patch.chunk);
      if (patch.oldValue === 0 && patch.newValue !== 0) {
        additions += 1;
        addedByChunk.set(key, (addedByChunk.get(key) ?? 0) + 1);
      } else if (patch.oldValue !== 0 && patch.newValue === 0) {
        removals += 1;
        removedByChunk.set(key, (removedByChunk.get(key) ?? 0) + 1);
      }
      if (!this.#chunks.has(key)) newChunks.add(key);
    }
    const occupiedAfter = this.#occupiedCount + additions - removals;
    let chunksAfter = this.#chunks.size + newChunks.size;
    if (chunksAfter > this.limits.maxChunks) {
      // A chunk is reclaimed only when every occupied voxel is removed and
      // nothing is written back into it; scan only the touched chunks.
      let emptied = 0;
      for (const [key, removedCount] of removedByChunk) {
        if ((addedByChunk.get(key) ?? 0) > 0) continue;
        const chunk = this.#chunks.get(key);
        if (chunk === undefined) continue;
        let occupied = 0;
        for (const value of chunk.values) {
          if (value !== 0) occupied += 1;
        }
        if (occupied === removedCount) emptied += 1;
      }
      chunksAfter = this.#chunks.size + newChunks.size - emptied;
    }
    const current = this.#bounds ?? this.#recomputeBounds();
    let bounds: OccupiedBounds | undefined;
    if (current === undefined) {
      bounds = destContentBounds;
    } else if (destContentBounds === undefined) {
      bounds = current;
    } else {
      const candidate = unionBounds(current, destContentBounds);
      if (this.#extentWithinLimit(candidate)) {
        bounds = candidate;
      } else {
        const remaining = this.#boundsOutsideRegion(sourceRegion);
        bounds =
          remaining === undefined
            ? destContentBounds
            : unionBounds(remaining, destContentBounds);
      }
    }
    return { occupiedAfter, chunksAfter, bounds };
  }

  /** True when every axis extent of the bounds is within the volume limit. */
  #extentWithinLimit(bounds: OccupiedBounds): boolean {
    for (let axis = 0; axis < 3; axis += 1) {
      const extent =
        (bounds.max[axis] as number) - (bounds.min[axis] as number);
      if (extent > this.limits.maxExtent) return false;
    }
    return true;
  }

  /** Throws `EXTENT_LIMIT_EXCEEDED` when any axis extent exceeds the limit. */
  #assertExtentWithinLimit(bounds: OccupiedBounds): void {
    for (let axis = 0; axis < 3; axis += 1) {
      const extent =
        (bounds.max[axis] as number) - (bounds.min[axis] as number);
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

  /**
   * Bounds of the currently occupied voxels outside a half-open region
   * (exact scan used when the conservative extent estimate fails).
   */
  #boundsOutsideRegion(region: IntAabb): OccupiedBounds | undefined {
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
        if (
          x >= region.min[0] &&
          x < region.max[0] &&
          y >= region.min[1] &&
          y < region.max[1] &&
          z >= region.min[2] &&
          z < region.max[2]
        ) {
          continue;
        }
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
    if (!Number.isFinite(minX)) return undefined;
    return {
      min: [minX, minY, minZ],
      max: [maxX + 1, maxY + 1, maxZ + 1],
    };
  }

  #operationLimitError(requested: number): WorkspaceError {
    return new WorkspaceError({
      family: "limit",
      code: "TOO_MANY_VOXELS",
      message: "Operation exceeds the per-operation voxel limit",
      context: {
        requested,
        limit: this.limits.maxCoordinatesPerOperation,
        resource: "voxelsPerOperation",
      },
    });
  }

  /** Validates a 0..65535 material value (empty allowed). */
  #materialValue(value: number, name: string): MaterialId {
    if (!Number.isInteger(value) || value < 0 || value > 65_535) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_MATERIAL_ID",
        message: `${name} must be an integer from 0 through 65535`,
        context: { value: String(value) },
      });
    }
    return value as MaterialId;
  }

  /**
   * Validates an integer point within a per-axis magnitude bound. The
   * destination anchor is bounded by the coordinate domain; a translation
   * delta may reach `2 * maxCoordinate + 1` because a region at one extreme
   * can validly move to the other (the destination AABB check then bounds
   * the result).
   */
  #parsePoint(point: Vec3i, name: string, bound: number): Vec3i {
    this.#assertIntegerPoint(point, name);
    for (let axis = 0; axis < 3; axis += 1) {
      if (Math.abs(point[axis] as number) > bound) {
        throw new WorkspaceError({
          family: "validation",
          code: "INVALID_VOXEL_COORDINATE",
          message: `${name} coordinates must be integers within +-${String(bound)}`,
          path: [name, axis],
          context: { value: String(point[axis]) },
        });
      }
    }
    return point;
  }

  /** Validates that a point has integer components (no domain bound). */
  #assertIntegerPoint(point: Vec3i, name: string): void {
    for (let axis = 0; axis < 3; axis += 1) {
      const component = point[axis];
      if (component === undefined || !Number.isInteger(component)) {
        throw new WorkspaceError({
          family: "validation",
          code: "INVALID_VOXEL_COORDINATE",
          message: `${name} coordinates must be integers`,
          path: [name, axis],
          context: { value: String(component) },
        });
      }
    }
  }

  /**
   * Validates a half-open region's shape (integer components, `min <= max`).
   * Out-of-domain regions are not rejected here: shape iterators clip them
   * to the volume coordinate domain, while the command layer rejects
   * out-of-domain regions at parse time.
   */
  #parseRegion(region: IntAabb): IntAabb {
    for (const [name, point] of [
      ["min", region.min],
      ["max", region.max],
    ] as const) {
      for (let axis = 0; axis < 3; axis += 1) {
        const component = point[axis];
        if (component === undefined || !Number.isInteger(component)) {
          throw new WorkspaceError({
            family: "validation",
            code: "INVALID_VOXEL_COORDINATE",
            message: "Region coordinates must be integers",
            path: ["region", name, axis],
            context: { value: String(component) },
          });
        }
      }
    }
    for (let axis = 0; axis < 3; axis += 1) {
      if ((region.min[axis] as number) > (region.max[axis] as number)) {
        throw new WorkspaceError({
          family: "validation",
          code: "INVALID_AABB",
          message: "Region minimum must not exceed maximum on any axis",
          path: ["region", axis],
        });
      }
    }
    return { min: region.min, max: region.max };
  }

  /**
   * Builds the write plan for a batch of entries: validates every coordinate
   * and value, resolves duplicates last-write-wins, sorts canonically, and
   * reads current values so no-op writes are dropped. No mutation happens
   * here; the plan is the modification estimate used for preflight.
   */
  #planEntries(
    entries: readonly VoxelEntry[],
    valueOf: (entry: VoxelEntry) => number,
    rawLimit: number = this.limits.maxCoordinatesPerOperation,
  ): PlannedPatch[] {
    // The raw entry count is a memory bound (the dedup map is built from
    // it); region moves pass twice the per-operation limit because each
    // moved voxel appears once as a clear and once as a write. The net
    // plan (after dedup and no-op filtering) is the semantic bound: the
    // voxels actually changed by the operation (ADR-0009).
    if (entries.length > rawLimit) {
      throw this.#operationLimitError(entries.length);
    }
    const byKey = new Map<string, PlannedPatch>();
    for (const entry of entries) {
      const parsed = parseCoordinate(entry.coordinate, this.limits);
      const value = valueOf(entry);
      const key = `${chunkKey(parsed.chunk)}:${String(chunkIndex(parsed.local))}`;
      byKey.set(key, {
        chunk: parsed.chunk,
        index: chunkIndex(parsed.local),
        oldValue: 0 as MaterialId,
        newValue: value as MaterialId,
      });
    }
    const plan = [...byKey.values()];
    for (const patch of plan) {
      const chunk = this.#chunks.get(chunkKey(patch.chunk));
      patch.oldValue =
        chunk === undefined
          ? (0 as MaterialId)
          : (chunk.values[patch.index] as MaterialId);
    }
    const net = plan.filter((patch) => patch.oldValue !== patch.newValue);
    if (net.length > this.limits.maxCoordinatesPerOperation) {
      throw this.#operationLimitError(net.length);
    }
    return net;
  }

  /**
   * Verifies every hard limit against the plan before any allocation or
   * mutation (ADR-0009): occupied-voxel count, occupied extent, and chunk
   * count. Rejection leaves the volume byte-identical. The occupied count
   * is the exact net of additions and removals, so moves that free voxels
   * are not falsely rejected near the limit. Region moves pass an exact
   * estimate (net chunks and post-operation bounds) computed by
   * `#estimateRegionResult`.
   */
  #preflightPlan(
    plan: readonly PlannedPatch[],
    estimate?: RegionResultEstimate,
  ): void {
    let additions = 0;
    let removals = 0;
    const candidateChunks = new Set<string>();
    for (const patch of plan) {
      if (patch.oldValue === 0 && patch.newValue !== 0) additions += 1;
      if (patch.oldValue !== 0 && patch.newValue === 0) removals += 1;
      if (!this.#chunks.has(chunkKey(patch.chunk))) {
        candidateChunks.add(chunkKey(patch.chunk));
      }
    }
    const occupiedAfter =
      estimate === undefined
        ? this.#occupiedCount + additions - removals
        : estimate.occupiedAfter;
    if (occupiedAfter > this.limits.maxOccupiedVoxels) {
      throw new WorkspaceError({
        family: "limit",
        code: "TOO_MANY_OCCUPIED_VOXELS",
        message: "Volume exceeds its occupied-voxel limit",
        context: {
          volumeId: this.volumeId,
          requested: occupiedAfter,
          limit: this.limits.maxOccupiedVoxels,
        },
      });
    }
    const chunksAfter =
      estimate === undefined
        ? this.#chunks.size + candidateChunks.size
        : estimate.chunksAfter;
    if (chunksAfter > this.limits.maxChunks) {
      throw new WorkspaceError({
        family: "limit",
        code: "TOO_MANY_CHUNKS",
        message: "Volume exceeds its non-empty chunk limit",
        context: {
          volumeId: this.volumeId,
          requested: chunksAfter,
          limit: this.limits.maxChunks,
        },
      });
    }
    if (estimate !== undefined) {
      if (estimate.bounds !== undefined) {
        this.#assertExtentWithinLimit(estimate.bounds);
      }
      return;
    }
    if (additions > 0) {
      const current = this.#bounds ?? this.#recomputeBounds();
      let candidate: OccupiedBounds | undefined =
        current === undefined
          ? undefined
          : {
              min: [current.min[0], current.min[1], current.min[2]],
              max: [current.max[0], current.max[1], current.max[2]],
            };
      for (const patch of plan) {
        if (patch.oldValue !== 0 || patch.newValue === 0) continue;
        const coordinate = patchCoordinate(patch);
        candidate =
          candidate === undefined
            ? pointBounds(coordinate)
            : unionBounds(candidate, pointBounds(coordinate));
      }
      if (candidate !== undefined) {
        for (let axis = 0; axis < 3; axis += 1) {
          const extent =
            (candidate.max[axis] as number) - (candidate.min[axis] as number);
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
    }
  }

  /**
   * Applies a preflighted plan. Cannot fail after `#preflightPlan`: chunk
   * allocation is bounded by the preflighted chunk count and every write is
   * a plain array store. Returns the compact per-chunk change set. Region
   * moves pass their exact preflight estimate.
   */
  #applyPlan(
    plan: readonly PlannedPatch[],
    estimate?: RegionResultEstimate,
  ): VoxelChangeSet {
    this.#preflightPlan(plan, estimate);
    // Canonical change-set order: chunk X, then Y, then Z; local index within
    // a chunk. Every caller (batch, fill, replace, patch) funnels through
    // here, so the emitted change set is always sorted.
    const ordered = [...plan].sort(comparePlannedPatch);
    const chunks = new Map<string, MutableChunkChange>();
    for (const patch of ordered) {
      const key = chunkKey(patch.chunk);
      let chunk = this.#chunks.get(key);
      if (chunk === undefined) {
        chunk = {
          values: new Uint16Array(CHUNK_VOXEL_COUNT),
          revision: 0,
        };
        this.#chunks.set(key, chunk);
      }
      chunk.values[patch.index] = patch.newValue;
      chunk.revision += 1;
      if (patch.oldValue === 0 && patch.newValue !== 0) {
        this.#occupiedCount += 1;
        const current = this.#bounds ?? this.#recomputeBounds();
        this.#bounds =
          current === undefined
            ? pointBounds(patchCoordinate(patch))
            : unionBounds(current, pointBounds(patchCoordinate(patch)));
      } else if (patch.oldValue !== 0 && patch.newValue === 0) {
        this.#occupiedCount -= 1;
        if (
          this.#bounds !== undefined &&
          isOnBoundary(this.#bounds, patchCoordinate(patch))
        ) {
          this.#bounds = undefined;
        }
      }
      const existing = chunks.get(key);
      if (existing === undefined) {
        chunks.set(key, {
          coordinate: patch.chunk,
          revision: chunk.revision,
          patches: [
            {
              index: patch.index,
              oldValue: patch.oldValue,
              newValue: patch.newValue,
            },
          ],
        });
      } else {
        existing.patches.push({
          index: patch.index,
          oldValue: patch.oldValue,
          newValue: patch.newValue,
        });
      }
    }
    for (const [key, chunk] of this.#chunks) {
      if (isEmptyChunk(chunk)) this.#chunks.delete(key);
    }
    return {
      volumeId: this.volumeId,
      chunks: [...chunks.values()].sort((a, b) =>
        compareVec3i(a.coordinate, b.coordinate),
      ),
    };
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

/** Mutable accumulator mirroring `ChunkChange` during plan application. */
interface MutableChunkChange {
  readonly coordinate: Vec3i;
  readonly revision: number;
  readonly patches: VoxelPatch[];
}

/** Exact post-operation resource estimate for region moves (plan S3.9-S3.12). */
interface RegionResultEstimate {
  readonly occupiedAfter: number;
  readonly chunksAfter: number;
  readonly bounds: OccupiedBounds | undefined;
}

/** Component-wise integer vector addition. */
const addVec3i = (a: Vec3i, b: Vec3i): Vec3i => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];

/** Half-open bounds of a list of voxel entries; undefined when empty. */
const boundsOfEntries = (
  entries: readonly VoxelEntry[],
): OccupiedBounds | undefined => {
  if (entries.length === 0) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const x = entry.coordinate[0];
    const y = entry.coordinate[1];
    const z = entry.coordinate[2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX + 1, maxY + 1, maxZ + 1],
  };
};

/** One planned write; the unit of preflight and application. */
interface PlannedPatch {
  readonly chunk: Vec3i;
  readonly index: number;
  oldValue: MaterialId;
  readonly newValue: MaterialId;
}

const comparePlannedPatch = (a: PlannedPatch, b: PlannedPatch): number =>
  compareVec3i(a.chunk, b.chunk) || a.index - b.index;

/** Full voxel coordinate of a planned patch. */
/** X-fastest local index to local coordinates (plan 5.2). */
const localFromIndex = (index: number): Vec3i => [
  index % CHUNK_EDGE,
  Math.floor(index / CHUNK_EDGE) % CHUNK_EDGE,
  Math.floor(index / (CHUNK_EDGE * CHUNK_EDGE)),
];

const patchCoordinate = (patch: PlannedPatch): Vec3i => {
  const local = localFromIndex(patch.index);
  return [
    patch.chunk[0] * CHUNK_EDGE + local[0],
    patch.chunk[1] * CHUNK_EDGE + local[1],
    patch.chunk[2] * CHUNK_EDGE + local[2],
  ];
};

/** Validates a chunk coordinate against the volume coordinate domain. */
function parseChunkCoordinate(
  coordinate: Vec3i,
  limits: VoxelVolumeLimits,
): Vec3i {
  const minChunk = -Math.ceil(limits.maxCoordinate / CHUNK_EDGE);
  const maxChunk = Math.floor(limits.maxCoordinate / CHUNK_EDGE);
  for (let axis = 0; axis < 3; axis += 1) {
    const component = coordinate[axis];
    if (
      component === undefined ||
      !Number.isInteger(component) ||
      component < minChunk ||
      component > maxChunk
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_CHUNK_COORDINATE",
        message: `Chunk coordinates must be integers within ${String(minChunk)}..${String(maxChunk)}`,
        path: ["coordinate", axis],
        context: { value: String(component) },
      });
    }
  }
  return coordinate;
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
