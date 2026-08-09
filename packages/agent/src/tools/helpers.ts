import type { DocumentStoreRead } from "@voxel-maker/document";
import { worldTransformMatrix } from "@voxel-maker/document";
import { applyMatrix } from "@voxel-maker/math";
import type { IntAabb, Vec3, Vec3i } from "@voxel-maker/math";
import type {
  AnimationDescriptor,
  SceneNode,
  VoxelDocument,
} from "@voxel-maker/model";
import type {
  AnimationId,
  JsonValue,
  NodeId,
  TrackId,
  VolumeId,
} from "@voxel-maker/shared";
import { ResponseBudget, boundedEmit, clampString } from "../budget.js";
import {
  inspectionLimit,
  invalidArgument,
  missingReference,
} from "../contract.js";
import type { InspectionLimits } from "../limits.js";

/** Stable error codes for missing references. */
export const UNKNOWN_NODE_CODE = "UNKNOWN_NODE";
export const UNKNOWN_VOLUME_CODE = "UNKNOWN_VOLUME";
export const UNKNOWN_ANIMATION_CODE = "UNKNOWN_ANIMATION";
export const UNKNOWN_TRACK_CODE = "UNKNOWN_TRACK";

/** Looks up a node or throws the stable missing-reference error. */
export function requireNode(
  document: VoxelDocument,
  nodeId: NodeId,
): SceneNode {
  const node = document.nodes[nodeId];
  if (node === undefined) {
    missingReference("node", nodeId, UNKNOWN_NODE_CODE);
  }
  return node;
}

/** Looks up a volume descriptor or throws the stable missing-reference error. */
export function requireVolume(
  document: VoxelDocument,
  volumeId: VolumeId,
): NonNullable<VoxelDocument["volumes"][VolumeId]> {
  const volume = document.volumes[volumeId];
  if (volume === undefined) {
    missingReference("volume", volumeId, UNKNOWN_VOLUME_CODE);
  }
  return volume;
}

/** Looks up an animation descriptor or throws the stable error. */
export function requireAnimation(
  document: VoxelDocument,
  animationId: AnimationId,
): AnimationDescriptor {
  const animation = document.animations[animationId];
  if (animation === undefined) {
    missingReference("animation", animationId, UNKNOWN_ANIMATION_CODE);
  }
  return animation;
}

/** Looks up a track across every animation or throws the stable error. */
export function requireTrack(
  document: VoxelDocument,
  trackId: TrackId,
): {
  readonly animationId: AnimationId;
  readonly track: AnimationDescriptor["tracks"][number];
} {
  for (const animation of Object.values(document.animations)) {
    for (const track of animation.tracks) {
      if (track.trackId === trackId) {
        return { animationId: animation.animationId, track };
      }
    }
  }
  missingReference("track", trackId, UNKNOWN_TRACK_CODE);
}

/** One 1-based page slice of a deterministic total. */
export interface PageSlice {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasMore: boolean;
}

/** Computes the page bounds and `hasMore` for one page of `total` items. */
export function pageSlice(
  total: number,
  page: number,
  pageSize: number,
): PageSlice & { readonly start: number; readonly end: number } {
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  return { page, pageSize, total, start, end, hasMore: end < total };
}

/** Clamps a display name to the configured length. */
export function clampName(name: string, limits: InspectionLimits): string {
  return clampString(name, limits.maxNameLength).value;
}

/** True when `value` is an integer array of exactly three numbers. */
export function isVec3i(
  value: JsonValue,
): value is readonly [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number" && Number.isInteger(item))
  );
}

/** True when `value` is a finite number array of exactly three numbers. */
export function isVec3(value: JsonValue): value is Vec3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

/** Validates and normalizes a half-open region argument. */
export function requireRegion(value: JsonValue, path: string): IntAabb {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidArgument(`${path} must be an object with min and max`, [path]);
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  const min = record.min;
  const max = record.max;
  if (
    min === undefined ||
    max === undefined ||
    !isVec3i(min) ||
    !isVec3i(max)
  ) {
    invalidArgument(`${path} must use integer [x, y, z] min/max arrays`, [
      path,
    ]);
  }
  for (const axis of [0, 1, 2] as const) {
    if ((min as Vec3i)[axis] > (max as Vec3i)[axis]) {
      invalidArgument(`${path} must satisfy min <= max on every axis`, [
        path,
        axis,
      ]);
    }
  }
  return { min: min as Vec3i, max: max as Vec3i };
}

/** Volume read view lookup shared by voxel/bounds/ray tools. */
export function requireVolumeView(
  store: DocumentStoreRead,
  volumeId: VolumeId,
) {
  const view = store.getVolume(volumeId);
  if (view === undefined) {
    missingReference("volume", volumeId, UNKNOWN_VOLUME_CODE);
  }
  return view;
}

/** Vector type re-export for tool payloads. */
export type { Vec3, Vec3i };

/** Resolves the 1-based page argument. */
export function resolvePage(
  record: Readonly<Record<string, JsonValue>>,
): number {
  const page = record.page;
  if (page === undefined) return 1;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
    invalidArgument("page must be a positive integer", ["page"]);
  }
  return page;
}

/** Resolves pageSize against the configured limits. */
export function resolvePageSize(
  record: Readonly<Record<string, JsonValue>>,
  limits: { readonly defaultPageSize: number; readonly maxPageSize: number },
): number {
  const pageSize = record.pageSize;
  if (pageSize === undefined) return limits.defaultPageSize;
  if (
    typeof pageSize !== "number" ||
    !Number.isInteger(pageSize) ||
    pageSize < 1
  ) {
    invalidArgument("pageSize must be a positive integer", ["pageSize"]);
  }
  if (pageSize > limits.maxPageSize) {
    inspectionLimit("pageSize", pageSize, limits.maxPageSize, ["pageSize"]);
  }
  return pageSize;
}

/**
 * Emits one page of `items` through the response budget and returns the
 * shared pagination payload fields (`total`, `page`, `pageSize`,
 * `hasMore`, plus the page under `listKey`). Every paginated tool uses
 * this one shape so paging is predictable and truncation is uniform.
 */
export function paginated<T>(
  budget: ResponseBudget,
  items: readonly T[],
  page: number,
  pageSize: number,
  emit: (item: T) => JsonValue | undefined,
  listKey: string,
): Readonly<Record<string, JsonValue>> {
  const slice = pageSlice(items.length, page, pageSize);
  const emitted = boundedEmit(
    budget,
    items.slice(slice.start, slice.end),
    (item) => emit(item),
  );
  return {
    total: slice.total,
    page: slice.page,
    pageSize: slice.pageSize,
    hasMore: slice.hasMore && !emitted.truncated,
    [listKey]: emitted.list,
  };
}

/**
 * World-space position of a node: its local origin mapped through the
 * pivot-aware world transform (ADR-0001), i.e. the image of `[0, 0, 0]`
 * under `M(root) x ... x M(node)`.
 */
export function nodeWorldPosition(
  store: DocumentStoreRead,
  nodeId: NodeId,
): readonly [number, number, number] {
  const matrix = worldTransformMatrix(store.getDocument(), nodeId);
  return applyMatrix(matrix, [0, 0, 0]);
}
