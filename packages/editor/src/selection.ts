import {
  applyMatrix,
  type IntAabb,
  type Vec3,
  type Vec3i,
} from "@voxel-maker/math";
import {
  nodesReferencingVolume,
  worldTransformMatrix,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import type { NodeId, VolumeId } from "@voxel-maker/shared";
import type { VoxelDocument } from "@voxel-maker/model";
import type { SelectionEntry, ToolModifiers } from "./types.js";

/**
 * Pure runtime selection semantics (plan S7.2, ticket #18): replace/add/
 * toggle intent, canonical entry identity, region spanning, and pruning of
 * deleted references. Selection is runtime-only EditorStore state and
 * never touches the document, history, or saved bytes; these helpers are
 * deterministic and headless-tested.
 */

/** Canonical key of a selection entry for O(1) membership tests. */
export function selectionKey(entry: SelectionEntry): string {
  switch (entry.kind) {
    case "node":
      return `node:${entry.nodeId}`;
    case "voxel":
      return `voxel:${entry.volumeId}:${voxelKey(entry.voxel)}`;
    case "region":
      return `region:${entry.volumeId}:${regionKey(entry.region)}`;
  }
}

function voxelKey(voxel: Vec3i): string {
  return `${String(voxel[0])},${String(voxel[1])},${String(voxel[2])}`;
}

function regionKey(region: IntAabb): string {
  return `${voxelKey(region.min)}..${voxelKey(region.max)}`;
}

/** True when the selection already contains an equal entry. */
export function selectionContains(
  selection: readonly SelectionEntry[],
  entry: SelectionEntry,
): boolean {
  const key = selectionKey(entry);
  return selection.some((candidate) => selectionKey(candidate) === key);
}

/** Appends the entry when it is not already selected (additive intent). */
export function addSelectionEntry(
  selection: readonly SelectionEntry[],
  entry: SelectionEntry,
): SelectionEntry[] {
  if (selectionContains(selection, entry)) return [...selection];
  return [...selection, entry];
}

/** Removes the entry when selected, appends it otherwise (toggle intent). */
export function toggleSelectionEntry(
  selection: readonly SelectionEntry[],
  entry: SelectionEntry,
): SelectionEntry[] {
  const key = selectionKey(entry);
  const next = selection.filter((candidate) => selectionKey(candidate) !== key);
  if (next.length === selection.length) return [...next, entry];
  return next;
}

/**
 * Resolves one click against the current selection (plan S7.2): with no
 * modifier the target replaces the selection; Shift adds it; Ctrl/Cmd
 * toggles it. `entry === undefined` means the pointer hit nothing: a plain
 * click clears the selection, while Shift/Ctrl clicks leave it unchanged.
 */
export function applySelectionIntent(
  selection: readonly SelectionEntry[],
  entry: SelectionEntry | undefined,
  modifiers: ToolModifiers,
): SelectionEntry[] {
  if (entry === undefined) {
    return modifiers.additive || modifiers.toggle ? [...selection] : [];
  }
  if (modifiers.toggle) return toggleSelectionEntry(selection, entry);
  if (modifiers.additive) return addSelectionEntry(selection, entry);
  return [entry];
}

/**
 * Half-open region spanning two integer voxels inclusively (plan S7.2):
 * `min = min(a, b)` per axis, `max = max(a, b) + 1`. The result is
 * canonical (min <= max) and covers both endpoints.
 */
export function spanRegion(a: Vec3i, b: Vec3i): IntAabb {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [
      Math.max(a[0], b[0]) + 1,
      Math.max(a[1], b[1]) + 1,
      Math.max(a[2], b[2]) + 1,
    ],
  };
}

/**
 * Drops every selection entry that references a node or volume missing
 * from the document (plan S7.2 "selection pruning after delete"). Node
 * entries require the node; voxel and region entries require the volume.
 * Entries for existing nodes/volumes are kept in order.
 */
export function pruneSelection(
  selection: readonly SelectionEntry[],
  document: VoxelDocument,
): SelectionEntry[] {
  const pruned: SelectionEntry[] = [];
  for (const entry of selection) {
    if (entry.kind === "node") {
      if (document.nodes[entry.nodeId] !== undefined) pruned.push(entry);
    } else if (document.volumes[entry.volumeId] !== undefined) {
      pruned.push(entry);
    }
  }
  return pruned;
}

/** World-space AABB (same shape as the renderer's `WorldBounds`). */
export interface SelectionWorldBounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * One per-volume region of a selection entry (plan S7.19, ticket #19).
 * Node entries carry their node id so callers can use the node's own
 * world matrix; voxel and region entries leave it undefined (their
 * owning volume resolves the matrix).
 */
export interface SelectionVolumeRegion {
  /** The selected node, for node entries; undefined otherwise. */
  readonly nodeId: NodeId | undefined;
  readonly volumeId: VolumeId;
  /** Half-open volume-local region. */
  readonly region: IntAabb;
}

/**
 * Expands a mixed selection into per-volume regions (plan S7.2/S7.19):
 * node entries contribute the occupied-voxel bounds of each of their
 * voxel volumes (empty volumes are skipped), voxel entries contribute
 * their unit region, and region entries contribute themselves. Equal
 * volume/region pairs deduplicate and the selection order is preserved.
 * Undefined when no region is displayable.
 */
export function selectionVolumeRegions(
  store: DocumentStoreRead,
  selection: readonly SelectionEntry[],
): SelectionVolumeRegion[] | undefined {
  const document = store.getDocument();
  const seen = new Set<string>();
  const regions: SelectionVolumeRegion[] = [];
  const push = (
    nodeId: NodeId | undefined,
    volumeId: VolumeId,
    region: IntAabb,
  ): void => {
    const key = `${String(volumeId)}:${String(region.min[0])},${String(region.min[1])},${String(region.min[2])}..${String(region.max[0])},${String(region.max[1])},${String(region.max[2])}`;
    if (seen.has(key)) return;
    seen.add(key);
    regions.push({ nodeId, volumeId, region });
  };
  for (const entry of selection) {
    if (entry.kind === "node") {
      const node = document.nodes[entry.nodeId];
      if (node === undefined) continue;
      for (const component of node.components) {
        if (component.kind !== "voxel") continue;
        const bounds = store.getVolume(component.volumeId)?.occupiedBounds();
        if (bounds === undefined) continue;
        push(entry.nodeId, component.volumeId, bounds);
      }
      continue;
    }
    if (entry.kind === "voxel") {
      push(undefined, entry.volumeId, {
        min: [entry.voxel[0], entry.voxel[1], entry.voxel[2]],
        max: [entry.voxel[0] + 1, entry.voxel[1] + 1, entry.voxel[2] + 1],
      });
      continue;
    }
    push(undefined, entry.volumeId, entry.region);
  }
  return regions.length === 0 ? undefined : regions;
}

/**
 * Union world bounds of a mixed selection (plan S7.2 "region bounds
 * display"): node entries contribute the occupied voxel bounds of their
 * voxel volumes, voxel and region entries contribute their volume-local
 * bounds transformed through the owning node's world matrix. Undefined
 * when nothing is displayable. Runtime-only projection; never persisted.
 */
export function selectionWorldBounds(
  store: DocumentStoreRead,
  selection: readonly SelectionEntry[],
): SelectionWorldBounds | undefined {
  const document = store.getDocument();
  const regions = selectionVolumeRegions(store, selection);
  if (regions === undefined) return undefined;
  let bounds: SelectionWorldBounds | undefined;
  for (const { nodeId, volumeId, region } of regions) {
    const world =
      nodeId === undefined
        ? volumeLocalWorldBounds(store, volumeId, region)
        : transformAabb(worldTransformMatrix(document, nodeId), region);
    if (world === undefined) continue;
    bounds = bounds === undefined ? world : unionWorldBounds(bounds, world);
  }
  return bounds;
}

/**
 * World AABB of a volume-local AABB through the volume's first owning
 * node (plan S7.2 "region bounds display"). Undefined when the volume has
 * no owner.
 */
export function volumeLocalWorldBounds(
  store: DocumentStoreRead,
  volumeId: string,
  local: IntAabb,
): SelectionWorldBounds | undefined {
  const document = store.getDocument();
  const owner = nodesReferencingVolume(document, volumeId as never)[0];
  if (owner === undefined) return undefined;
  return transformAabb(worldTransformMatrix(document, owner), local);
}

/** World AABB of an integer AABB under a 4x4 matrix (corner sweep). */
function transformAabb(
  matrix: ReturnType<typeof worldTransformMatrix>,
  bounds: IntAabb,
): SelectionWorldBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let x = 0; x < 2; x += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let z = 0; z < 2; z += 1) {
        const corner: Vec3 = applyMatrix(matrix, [
          x === 0 ? bounds.min[0] : bounds.max[0],
          y === 0 ? bounds.min[1] : bounds.max[1],
          z === 0 ? bounds.min[2] : bounds.max[2],
        ]);
        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis] as number, corner[axis] as number);
          max[axis] = Math.max(max[axis] as number, corner[axis] as number);
        }
      }
    }
  }
  return { min, max };
}

const unionWorldBounds = (
  a: SelectionWorldBounds,
  b: SelectionWorldBounds,
): SelectionWorldBounds => ({
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
