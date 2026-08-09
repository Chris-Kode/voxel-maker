import { WorkspaceError, type VolumeId } from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { Command } from "@voxel-maker/commands";
import {
  copyRegionCommand,
  deleteRegionCommand,
  mirrorRegionCommand,
  rotateRegionCommand,
  translateRegionCommand,
} from "@voxel-maker/commands";
import {
  CHUNK_EDGE,
  canRotateExactly,
  mirrorCoordinate,
  rotateRegionPlan,
  translateAabb,
  type QuarterTurns,
  type ShapeAxis,
  type VoxelVolumeLimits,
  type VoxelVolumeReadView,
} from "@voxel-maker/voxel";
import type { EditorStore } from "./runtime.js";
import { selectionVolumeRegions } from "./selection.js";
import {
  outOfBoundsError,
  sessionNotOpen,
  tooManyOccupiedError,
  tooManyVoxelsError,
} from "./tool-errors.js";
import type {
  SelectionEntry,
  ToolActionResult,
  ToolHost,
  ToolModifiers,
  TransformEntryPreview,
  TransformMode,
  TransformPreview,
} from "./types.js";

/**
 * Transform tool (plan S7.19, ticket #19): copy, delete, move, rotate,
 * and mirror the selected geometry through the existing region commands.
 *
 * A transform operates on the per-volume regions of the runtime
 * selection (`selectionRegions`): node entries contribute the occupied
 * bounds of each of their voxel volumes, voxel entries their unit
 * region, and region entries themselves. Every operation previews the
 * exact affected bounds and the collision behavior (v1 `overwrite`
 * semantics, docs/commands/voxel-regions.md) before any commit:
 *
 * - **Move / copy** are drag gestures: pointer down pins the selection
 *   regions and the anchor voxel, moves update the destination preview
 *   (translated AABBs plus the exact overwritten/removed counts), and
 *   pointer up commits one labeled transaction of `translateRegion` /
 *   `copyRegion` commands. A zero delta or an empty selection commits
 *   nothing.
 * - **Rotate / mirror / delete** preview on button press and apply on
 *   confirmation: `previewRotate` cycles the exact 90-degree steps
 *   around an axis (1, 2, 3, then back to 1), `previewMirror` and
 *   `previewDelete` preview their single step, and `applyPending`
 *   commits exactly the previewed operation as one labeled transaction
 *   of `rotateRegion` / `mirrorRegion` / `deleteRegion` commands.
 *   `cancelPending` and Escape discard the preview with zero document,
 *   revision, history, autosave, or renderer side effect.
 *
 * Preflight is exact and bounded (ADR-0009): destinations must stay in
 * the volume coordinate domain (negative coordinates included), the
 * total region volume must fit the per-gesture voxel budget, exact
 * 90-degree rotations must satisfy the lattice parity constraint, and
 * the post-operation occupied count must fit the volume limit. A failed
 * preflight cancels the gesture or the pending preview atomically; the
 * commit itself is atomic and the region commands revalidate everything.
 * The tool never mutates semantic state: it reads the immutable store,
 * previews into the runtime editor store, and hands commands to the
 * host.
 */

export interface TransformToolOptions {
  readonly host: ToolHost;
  /** Runtime store that owns the selection, the mode, and the preview. */
  readonly editor: EditorStore;
}

export interface TransformTool {
  readonly id: "transform";
  /** True while a move/copy drag is in progress. */
  readonly active: boolean;
  readonly draft: undefined;
  pointerDown(
    clientX: number,
    clientY: number,
    modifiers?: ToolModifiers,
  ): ToolActionResult;
  pointerMove(clientX: number, clientY: number): ToolActionResult;
  pointerUp(): ToolActionResult;
  pointerCancel(): void;
  /** Discards any in-progress gesture and pending preview. */
  reset(): void;
  /**
   * Rotate mode: previews the next exact 90-degree step around `axis`
   * (1, 2, 3 turns, cycling back to 1; a different axis restarts at 1).
   */
  previewRotate(axis: ShapeAxis): ToolActionResult;
  /** Mirror mode: previews the mirror across the plane perpendicular to `axis`. */
  previewMirror(axis: ShapeAxis): ToolActionResult;
  /** Delete mode: previews removing the selected geometry. */
  previewDelete(): ToolActionResult;
  /** Applies the pending rotate/mirror/delete preview as one labeled transaction. */
  applyPending(): ToolActionResult;
  /** Cancels the pending preview; no document, revision, or history side effect. */
  cancelPending(): void;
}

/** One per-volume region a transform operation reads or writes. */
export interface SelectionRegion {
  readonly volumeId: VolumeId;
  /** Half-open source region. */
  readonly region: IntAabb;
}

/** Transaction labels, one per operation (plan S7.19). */
const LABELS: Readonly<Record<TransformMode, string>> = {
  move: "Move selection",
  copy: "Copy selection",
  rotate: "Rotate selection",
  mirror: "Mirror selection",
  delete: "Delete selection",
} as const;

/** Half-open coordinate domain of a volume (ADR-0009). */
const coordinateDomain = (maxCoordinate: number): IntAabb => ({
  min: [-maxCoordinate, -maxCoordinate, -maxCoordinate],
  max: [maxCoordinate + 1, maxCoordinate + 1, maxCoordinate + 1],
});

/** True when a half-open region fits the volume coordinate domain. */
function regionInDomain(region: IntAabb, limits: VoxelVolumeLimits): boolean {
  const domain = coordinateDomain(limits.maxCoordinate);
  for (let axis = 0; axis < 3; axis += 1) {
    if ((region.min[axis] as number) < (domain.min[axis] as number)) {
      return false;
    }
    if ((region.max[axis] as number) > (domain.max[axis] as number)) {
      return false;
    }
  }
  return true;
}

/** Number of voxels in a half-open region (exact integer product). */
function regionVolume(region: IntAabb): number {
  return (
    (region.max[0] - region.min[0]) *
    (region.max[1] - region.min[1]) *
    (region.max[2] - region.min[2])
  );
}

/** Stable "x,y,z" key of a voxel coordinate. */
const voxelKey = (coordinate: Vec3i): string =>
  `${String(coordinate[0])},${String(coordinate[1])},${String(coordinate[2])}`;

const parseKey = (key: string): Vec3i => {
  const [x, y, z] = key.split(",");
  return [Number(x), Number(y), Number(z)];
};

/** Adds an integer delta to a voxel coordinate. */
const addDelta = (coordinate: Vec3i, delta: Vec3i): Vec3i => [
  coordinate[0] + delta[0],
  coordinate[1] + delta[1],
  coordinate[2] + delta[2],
];

/** True when the delta is exactly zero on every axis. */
const isZeroDelta = (delta: Vec3i): boolean =>
  delta[0] === 0 && delta[1] === 0 && delta[2] === 0;

/**
 * Expands a mixed selection into per-volume regions the region commands
 * can act on (plan S7.19): node entries contribute the occupied-voxel
 * bounds of each of their voxel volumes (empty volumes are skipped),
 * voxel entries contribute their unit region, and region entries
 * contribute themselves. Equal volume/region pairs deduplicate and the
 * selection order is preserved. Undefined when no region is displayable.
 * The node identity is dropped: transforms are volume-local and never
 * touch node transforms (ticket #20).
 */
export function selectionRegions(
  store: DocumentStoreRead,
  selection: readonly SelectionEntry[],
): SelectionRegion[] | undefined {
  const regions = selectionVolumeRegions(store, selection);
  if (regions === undefined) return undefined;
  return regions.map(({ volumeId, region }) => ({ volumeId, region }));
}

/** Frozen operation parameters of one transform preview. */
export type TransformParams =
  | { readonly operation: "move"; readonly delta: Vec3i }
  | { readonly operation: "copy"; readonly delta: Vec3i }
  | {
      readonly operation: "rotate";
      readonly axis: ShapeAxis;
      readonly quarterTurns: QuarterTurns;
    }
  | { readonly operation: "mirror"; readonly axis: ShapeAxis }
  | { readonly operation: "delete" };

/** Per-volume occupied key sets of one preview. */
interface VolumeKeys {
  readonly srcKeys: Set<string>;
  readonly destKeys: Set<string>;
  readonly mappedKeys: Set<string>;
}

/** Computed preview plus the exact per-volume net occupied change. */
interface ComputedTransform {
  readonly preview: TransformPreview;
  /** Exact net occupied change per volume (additions minus removals). */
  readonly netByVolume: ReadonlyMap<VolumeId, number>;
}

/**
 * Computes the exact preview of one transform operation (plan S7.19):
 * per-entry affected bounds and the union overwritten/removed/moved
 * counts, plus the exact per-volume net occupied change for the
 * ADR-0009 limit preflight. Every count is read through the
 * authoritative store. Collision behavior is the v1 overwrite mode:
 * an occupied destination voxel is "overwritten" exactly when it
 * receives mapped content and is not part of the operation's own source
 * content.
 */
function computePreview(
  store: DocumentStoreRead,
  regions: readonly SelectionRegion[],
  params: TransformParams,
  maxGestureVoxels: number,
): ComputedTransform {
  const entries: TransformEntryPreview[] = [];
  const byVolume = new Map<VolumeId, VolumeKeys>();
  for (const { volumeId, region } of regions) {
    const view = store.getVolume(volumeId);
    if (view === undefined) continue;
    const destination = destinationFor(region, params);
    if (!regionInDomain(destination, view.limits)) {
      throw outOfBoundsError(volumeId, destination, "destination");
    }
    const volume = volumeOf(byVolume, volumeId);
    collectOccupied(volume.srcKeys, view, region, maxGestureVoxels);
    collectOccupied(volume.destKeys, view, destination, maxGestureVoxels);
    entries.push({ volumeId, source: region, destination });
  }
  // The union preview is executable only when the same-volume commands
  // can be ordered without interference; reject cycles atomically so the
  // commit can never diverge from the preview. The preview carries the
  // ordered entries so the commit replays exactly what was previewed.
  const ordered = validatedEntries(entries, params.operation);
  for (const { volumeId, region } of regions) {
    const volume = byVolume.get(volumeId);
    if (volume === undefined) continue;
    for (const key of volume.srcKeys) {
      const mapped = mapKey(key, region, params);
      if (mapped !== undefined) volume.mappedKeys.add(mapped);
    }
  }
  let movedVoxels = 0;
  let overwrittenVoxels = 0;
  let removedVoxels = 0;
  const netByVolume = new Map<VolumeId, number>();
  for (const [volumeId, volume] of byVolume) {
    movedVoxels += volume.srcKeys.size;
    const additions = countDifference(volume.mappedKeys, volume.destKeys);
    const removals =
      params.operation === "copy"
        ? 0
        : params.operation === "delete"
          ? volume.srcKeys.size
          : countDifference(volume.srcKeys, volume.mappedKeys);
    netByVolume.set(volumeId, additions - removals);
    overwrittenVoxels += countOverwritten(
      volume.destKeys,
      volume.srcKeys,
      volume.mappedKeys,
    );
    removedVoxels += removals;
  }
  return {
    preview: buildPreview(params, ordered, {
      movedVoxels,
      overwrittenVoxels,
      removedVoxels,
    }),
    netByVolume,
  };
}

/** Builds the fully typed preview for the operation parameters. */
function buildPreview(
  params: TransformParams,
  entries: readonly TransformEntryPreview[],
  counts: {
    readonly movedVoxels: number;
    readonly overwrittenVoxels: number;
    readonly removedVoxels: number;
  },
): TransformPreview {
  switch (params.operation) {
    case "move":
      return {
        operation: "move",
        entries,
        delta: params.delta,
        ...counts,
      };
    case "copy":
      return {
        operation: "copy",
        entries,
        delta: params.delta,
        ...counts,
      };
    case "rotate":
      return {
        operation: "rotate",
        entries,
        axis: params.axis,
        quarterTurns: params.quarterTurns,
        ...counts,
      };
    case "mirror":
      return {
        operation: "mirror",
        entries,
        axis: params.axis,
        ...counts,
      };
    case "delete":
      return {
        operation: "delete",
        entries,
        ...counts,
      };
  }
}

/** Exact destination AABB of one region under the operation. */
function destinationFor(region: IntAabb, params: TransformParams): IntAabb {
  switch (params.operation) {
    case "move":
    case "copy":
      return translateAabb(region, params.delta);
    case "rotate":
      // Throws INVALID_ROTATION_REGION for parity-mismatched regions.
      return rotateRegionPlan(region, params.axis, params.quarterTurns)
        .destination;
    case "mirror":
      return region;
    case "delete":
      return region;
  }
}

/** Maps one source voxel key to its destination key under the operation. */
function mapKey(
  key: string,
  region: IntAabb,
  params: TransformParams,
): string | undefined {
  const coordinate = parseKey(key);
  switch (params.operation) {
    case "move":
    case "copy":
      return voxelKey(addDelta(coordinate, params.delta));
    case "rotate": {
      const plan = rotateRegionPlan(region, params.axis, params.quarterTurns);
      return voxelKey(plan.map(coordinate));
    }
    case "mirror":
      return voxelKey(mirrorCoordinate(region, params.axis, coordinate));
    case "delete":
      return undefined;
  }
}

function volumeOf(
  byVolume: Map<VolumeId, VolumeKeys>,
  volumeId: VolumeId,
): VolumeKeys {
  let volume = byVolume.get(volumeId);
  if (volume === undefined) {
    volume = {
      srcKeys: new Set(),
      destKeys: new Set(),
      mappedKeys: new Set(),
    };
    byVolume.set(volumeId, volume);
  }
  return volume;
}

/**
 * Collects the occupied voxel keys of a half-open region through the
 * immutable read view, scanning chunk-wise so empty regions and chunks
 * are cheap (the per-gesture budget, enforced by the caller over the
 * region volumes, bounds every scan).
 */
function collectOccupied(
  keys: Set<string>,
  view: VoxelVolumeReadView,
  region: IntAabb,
  maxGestureVoxels: number,
): void {
  if (regionVolume(region) > maxGestureVoxels) {
    throw tooManyVoxelsError(regionVolume(region), maxGestureVoxels);
  }
  const minChunk = [
    Math.floor(region.min[0] / CHUNK_EDGE),
    Math.floor(region.min[1] / CHUNK_EDGE),
    Math.floor(region.min[2] / CHUNK_EDGE),
  ];
  const maxChunk = [
    Math.ceil(region.max[0] / CHUNK_EDGE) - 1,
    Math.ceil(region.max[1] / CHUNK_EDGE) - 1,
    Math.ceil(region.max[2] / CHUNK_EDGE) - 1,
  ];
  for (let cz = minChunk[2] as number; cz <= (maxChunk[2] as number); cz += 1) {
    for (
      let cy = minChunk[1] as number;
      cy <= (maxChunk[1] as number);
      cy += 1
    ) {
      for (
        let cx = minChunk[0] as number;
        cx <= (maxChunk[0] as number);
        cx += 1
      ) {
        const chunk = view.getChunk([cx, cy, cz]);
        if (chunk === undefined) continue;
        const localMin = [
          Math.max(region.min[0] - cx * CHUNK_EDGE, 0),
          Math.max(region.min[1] - cy * CHUNK_EDGE, 0),
          Math.max(region.min[2] - cz * CHUNK_EDGE, 0),
        ];
        const localMax = [
          Math.min(region.max[0] - cx * CHUNK_EDGE, CHUNK_EDGE),
          Math.min(region.max[1] - cy * CHUNK_EDGE, CHUNK_EDGE),
          Math.min(region.max[2] - cz * CHUNK_EDGE, CHUNK_EDGE),
        ];
        for (
          let z = localMin[2] as number;
          z < (localMax[2] as number);
          z += 1
        ) {
          for (
            let y = localMin[1] as number;
            y < (localMax[1] as number);
            y += 1
          ) {
            const base = CHUNK_EDGE * (y + CHUNK_EDGE * z);
            for (
              let x = localMin[0] as number;
              x < (localMax[0] as number);
              x += 1
            ) {
              const value = chunk[base + x];
              if (value === undefined || value === 0) continue;
              keys.add(
                `${String(cx * CHUNK_EDGE + x)},${String(cy * CHUNK_EDGE + y)},${String(cz * CHUNK_EDGE + z)}`,
              );
            }
          }
        }
      }
    }
  }
}

/** |a \\ b| for key sets. */
function countDifference(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const key of a) {
    if (!b.has(key)) count += 1;
  }
  return count;
}

/**
 * Occupied destination voxels the operation overwrites: mapped positions
 * that are occupied before the operation and are not part of the
 * operation's own source content.
 */
function countOverwritten(
  destKeys: Set<string>,
  srcKeys: Set<string>,
  mappedKeys: Set<string>,
): number {
  let count = 0;
  for (const key of mappedKeys) {
    if (destKeys.has(key) && !srcKeys.has(key)) count += 1;
  }
  return count;
}

/** True when two half-open regions intersect. */
function regionsIntersect(a: IntAabb, b: IntAabb): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (
      (a.max[axis] as number) <= (b.min[axis] as number) ||
      (b.max[axis] as number) <= (a.min[axis] as number)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Same-volume command interference: `before` must run before `after`
 * exactly when `before`'s footprint (source plus destination, or just
 * the destination for copies, which never clear) intersects `after`'s
 * source. Sequential region commands snapshot their source at execution
 * time, so an earlier command must never touch a later command's source;
 * otherwise the commit would diverge from the union preview (the
 * reviewer-verified invariant of ticket #19).
 */
function footprintOf(
  entry: TransformEntryPreview,
  operation: TransformMode,
): IntAabb {
  if (operation === "copy") return entry.destination;
  return unionAabb(entry.source, entry.destination);
}

function unionAabb(a: IntAabb, b: IntAabb): IntAabb {
  return {
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
  };
}

/** Stable error for selection regions that cannot be transformed exactly. */
const conflictingRegionsError = (): WorkspaceError =>
  new WorkspaceError({
    family: "validation",
    code: "CONFLICTING_SELECTION_REGIONS",
    message:
      "Selected regions overlap in a way that cannot be transformed exactly; use one region selection instead",
  });

/**
 * Orders same-volume entries so that no earlier command's footprint
 * touches a later command's source (Kahn's algorithm over the pairwise
 * interference graph). The preview computes the union semantics, so the
 * commit must execute the commands in an order that realizes it exactly;
 * a cycle (mutually interfering entries) cannot be ordered and is
 * rejected atomically with `CONFLICTING_SELECTION_REGIONS`. Delete never
 * interferes (clears are idempotent unions) and stays in selection order.
 */
function orderedEntries(
  entries: readonly TransformEntryPreview[],
  operation: TransformMode,
): readonly TransformEntryPreview[] {
  if (operation === "delete" || entries.length < 2) return entries;
  const byVolume = new Map<VolumeId, TransformEntryPreview[]>();
  for (const entry of entries) {
    const group = byVolume.get(entry.volumeId);
    if (group === undefined) {
      byVolume.set(entry.volumeId, [entry]);
    } else {
      group.push(entry);
    }
  }
  let ordered: TransformEntryPreview[] = [];
  for (const group of byVolume.values()) {
    if (group.length < 2) {
      ordered = ordered.concat(group);
      continue;
    }
    const successors = new Map<
      TransformEntryPreview,
      TransformEntryPreview[]
    >();
    const indegree = new Map<TransformEntryPreview, number>();
    for (const candidate of group) {
      successors.set(candidate, []);
      indegree.set(candidate, 0);
    }
    for (const before of group) {
      const footprint = footprintOf(before, operation);
      for (const after of group) {
        if (before === after) continue;
        if (regionsIntersect(footprint, after.source)) {
          // `before` would corrupt `after`'s source, so `after` must run
          // first: edge after -> before.
          successors.get(after)?.push(before);
          indegree.set(before, (indegree.get(before) ?? 0) + 1);
        }
      }
    }
    const ready = group.filter((entry) => (indegree.get(entry) ?? 0) === 0);
    const queue = [...ready];
    const result: TransformEntryPreview[] = [];
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      result.push(next);
      for (const successor of successors.get(next) ?? []) {
        const remaining = (indegree.get(successor) ?? 0) - 1;
        indegree.set(successor, remaining);
        if (remaining === 0) queue.push(successor);
      }
    }
    if (result.length !== group.length) throw conflictingRegionsError();
    ordered = ordered.concat(result);
  }
  return ordered;
}

/** Orders the preview entries and validates that the operation is executable. */
function validatedEntries(
  entries: readonly TransformEntryPreview[],
  operation: TransformMode,
): readonly TransformEntryPreview[] {
  return orderedEntries(entries, operation);
}

class TransformToolImpl implements TransformTool {
  readonly id = "transform" as const;
  readonly #host: ToolHost;
  readonly #editor: EditorStore;
  #active = false;
  /** Operation pinned at pointer down (move or copy). */
  #operation: "move" | "copy" | undefined;
  #anchor: Vec3i | undefined;
  #current: Vec3i | undefined;
  #regions: readonly SelectionRegion[] | undefined;

  constructor(options: TransformToolOptions) {
    this.#host = options.host;
    this.#editor = options.editor;
  }

  get active(): boolean {
    return this.#active;
  }

  get draft(): undefined {
    return undefined;
  }

  pointerDown(clientX: number, clientY: number): ToolActionResult {
    // A second down while a gesture is captured is a no-op (safety).
    if (this.#active) return { ok: true };
    const mode = this.#editor.transformMode;
    // Rotate/mirror/delete are button-driven previews, not gestures.
    if (mode !== "move" && mode !== "copy") return { ok: true };
    const store = this.#host.store;
    if (store === undefined) return { ok: false, error: sessionNotOpen() };
    const regions = selectionRegions(store, this.#editor.selection);
    if (regions === undefined) return { ok: true };
    const hit = this.#host.pick(clientX, clientY);
    if (hit === undefined) return { ok: true };
    this.#operation = mode;
    this.#anchor = [...hit.voxel];
    this.#current = [...hit.voxel];
    this.#regions = regions;
    this.#active = true;
    return this.#publishDragPreview();
  }

  pointerMove(clientX: number, clientY: number): ToolActionResult {
    if (!this.#active || this.#anchor === undefined) return { ok: true };
    const hit = this.#host.pick(clientX, clientY);
    if (hit === undefined) return { ok: true };
    this.#current = [...hit.voxel];
    return this.#publishDragPreview();
  }

  pointerUp(): ToolActionResult {
    if (!this.#active || this.#operation === undefined) return { ok: true };
    const operation = this.#operation;
    const regions = this.#regions;
    const anchor = this.#anchor;
    const current = this.#current;
    this.reset();
    if (
      regions === undefined ||
      anchor === undefined ||
      current === undefined
    ) {
      return { ok: true };
    }
    const delta: Vec3i = [
      current[0] - anchor[0],
      current[1] - anchor[1],
      current[2] - anchor[2],
    ];
    // A zero delta changes nothing: commit nothing rather than a no-op
    // history entry.
    if (isZeroDelta(delta)) return { ok: true };
    try {
      // Recompute the exact preview for the pinned regions and commit
      // exactly its entries (ordered so the sequential commands realize
      // the union semantics the preview promised).
      const store = this.#host.store;
      if (store === undefined) return { ok: true };
      const computed = this.#compute(store, regions, { operation, delta });
      const commands = computed.preview.entries.map(({ volumeId, source }) =>
        operation === "move"
          ? translateRegionCommand(this.#host.nextCommandId(), {
              volumeId,
              region: source,
              delta,
            })
          : copyRegionCommand(this.#host.nextCommandId(), {
              volumeId,
              source,
              destination: addDelta(source.min, delta),
            }),
      );
      return this.#commit(commands, LABELS[operation]);
    } catch (error) {
      if (error instanceof WorkspaceError) {
        return { ok: false, error };
      }
      throw error;
    }
  }

  pointerCancel(): void {
    this.reset();
  }

  reset(): void {
    this.#active = false;
    this.#operation = undefined;
    this.#anchor = undefined;
    this.#current = undefined;
    this.#regions = undefined;
    this.#editor.setTransformPreview(undefined);
  }

  previewRotate(axis: ShapeAxis): ToolActionResult {
    if (this.#active) return { ok: true };
    const pending = this.#editor.transformPreview;
    let quarterTurns: QuarterTurns =
      pending !== undefined &&
      pending.operation === "rotate" &&
      pending.axis === axis
        ? cycleQuarterTurns(pending.quarterTurns)
        : 1;
    // A region whose rotation-plane extents have different parities can
    // only rotate exactly by 180 degrees (resampling is deferred in v1);
    // fall back to the always-exact step so the operation stays usable.
    const store = this.#host.store;
    if (quarterTurns !== 2 && store !== undefined) {
      const regions = selectionRegions(store, this.#editor.selection);
      const impossible = regions?.some(
        ({ region }) => !canRotateExactly(region, axis, quarterTurns),
      );
      if (impossible === true) quarterTurns = 2;
    }
    return this.#publishPending({ operation: "rotate", axis, quarterTurns });
  }

  previewMirror(axis: ShapeAxis): ToolActionResult {
    if (this.#active) return { ok: true };
    return this.#publishPending({ operation: "mirror", axis });
  }

  previewDelete(): ToolActionResult {
    if (this.#active) return { ok: true };
    return this.#publishPending({ operation: "delete" });
  }

  applyPending(): ToolActionResult {
    const pending = this.#editor.transformPreview;
    if (
      pending === undefined ||
      pending.operation === "move" ||
      pending.operation === "copy" ||
      pending.entries.length === 0
    ) {
      return { ok: true };
    }
    try {
      const entries = validatedEntries(pending.entries, pending.operation);
      const commands = entries.map(({ volumeId, source }) => {
        switch (pending.operation) {
          case "rotate":
            return rotateRegionCommand(this.#host.nextCommandId(), {
              volumeId,
              region: source,
              axis: pending.axis,
              quarterTurns: pending.quarterTurns,
            });
          case "mirror":
            return mirrorRegionCommand(this.#host.nextCommandId(), {
              volumeId,
              region: source,
              axis: pending.axis,
            });
          case "delete":
            return deleteRegionCommand(this.#host.nextCommandId(), {
              volumeId,
              region: source,
            });
        }
      });
      this.reset();
      return this.#commit(commands, LABELS[pending.operation]);
    } catch (error) {
      if (error instanceof WorkspaceError) {
        this.reset();
        return { ok: false, error };
      }
      throw error;
    }
  }

  cancelPending(): void {
    this.#editor.setTransformPreview(undefined);
  }

  /** Publishes the live move/copy drag preview; failures cancel the gesture. */
  #publishDragPreview(): ToolActionResult {
    const regions = this.#regions;
    const anchor = this.#anchor;
    const current = this.#current;
    const operation = this.#operation;
    if (
      regions === undefined ||
      anchor === undefined ||
      current === undefined ||
      operation === undefined
    ) {
      return { ok: true };
    }
    const store = this.#host.store;
    if (store === undefined) return { ok: true };
    const delta: Vec3i = [
      current[0] - anchor[0],
      current[1] - anchor[1],
      current[2] - anchor[2],
    ];
    try {
      const computed = this.#compute(store, regions, { operation, delta });
      this.#preflightOccupied(store, computed);
      this.#editor.setTransformPreview(computed.preview);
      return { ok: true };
    } catch (error) {
      if (error instanceof WorkspaceError) {
        this.reset();
        return { ok: false, error };
      }
      throw error;
    }
  }

  /** Publishes a pending rotate/mirror/delete preview; failures clear it. */
  #publishPending(params: TransformParams): ToolActionResult {
    const store = this.#host.store;
    if (store === undefined) return { ok: false, error: sessionNotOpen() };
    const regions = selectionRegions(store, this.#editor.selection);
    if (regions === undefined) {
      this.#editor.setTransformPreview(undefined);
      return { ok: true };
    }
    try {
      const computed = this.#compute(store, regions, params);
      // An operation that affects no voxels has nothing to apply.
      if (computed.preview.movedVoxels === 0) {
        this.#editor.setTransformPreview(undefined);
        return { ok: true };
      }
      this.#preflightOccupied(store, computed);
      this.#editor.setTransformPreview(computed.preview);
      return { ok: true };
    } catch (error) {
      if (error instanceof WorkspaceError) {
        this.#editor.setTransformPreview(undefined);
        return { ok: false, error };
      }
      throw error;
    }
  }

  /** Budgeted exact preview computation shared by both publish paths. */
  #compute(
    store: DocumentStoreRead,
    regions: readonly SelectionRegion[],
    params: TransformParams,
  ): ComputedTransform {
    this.#preflightBudget(regions);
    return computePreview(store, regions, params, this.#host.maxGestureVoxels);
  }

  /** Enforces the per-gesture voxel budget over the source regions. */
  #preflightBudget(regions: readonly SelectionRegion[]): void {
    let volume = 0;
    for (const { region } of regions) {
      volume += regionVolume(region);
    }
    if (volume > this.#host.maxGestureVoxels) {
      throw tooManyVoxelsError(volume, this.#host.maxGestureVoxels);
    }
  }

  /**
   * Enforces the ADR-0009 occupied-voxel limit exactly: the per-volume
   * net occupied change (additions minus removals) is derived from the
   * preview's key sets, so a move that frees voxels near the limit is
   * not falsely rejected.
   */
  #preflightOccupied(
    store: DocumentStoreRead,
    computed: ComputedTransform,
  ): void {
    for (const [volumeId, net] of computed.netByVolume) {
      const view = store.getVolume(volumeId);
      if (view === undefined) continue;
      const requested = view.occupiedCount() + net;
      if (requested > view.limits.maxOccupiedVoxels) {
        throw tooManyOccupiedError(requested, view.limits.maxOccupiedVoxels);
      }
    }
  }

  #commit(commands: readonly Command[], label: string): ToolActionResult {
    if (commands.length === 0) return { ok: true };
    const error = this.#host.commit(commands, label);
    return error === undefined ? { ok: true } : { ok: false, error };
  }
}

/** Next 90-degree step in the 1 -> 2 -> 3 -> 1 cycle. */
function cycleQuarterTurns(turns: QuarterTurns): QuarterTurns {
  return ((turns % 3) + 1) as QuarterTurns;
}

/** Creates the transform tool for one composition. */
export function createTransformTool(
  options: TransformToolOptions,
): TransformTool {
  return new TransformToolImpl(options);
}
