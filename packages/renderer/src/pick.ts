import type { DocumentStoreRead } from "@voxel-maker/document";
import {
  applyMatrix,
  invertMatrix,
  type IntAabb,
  type Mat4,
  type Vec3,
  type Vec3i,
} from "@voxel-maker/math";
import type { NodeId, VolumeId } from "@voxel-maker/shared";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import { evaluateConstrainedNodeWorldTransforms } from "@voxel-maker/rigging";
import { CHUNK_EDGE } from "./mesher.js";

/**
 * Deterministic viewport picking (plan S6.12, ADR-0005, ticket #16).
 *
 * A world-space ray is transformed into each volume's local space through
 * the canonical node world matrices (ADR-0001 pivot semantics), so picking
 * is exact under negative voxel coordinates, translated/pivoted nodes,
 * rotation, and non-uniform scale. Each allocated chunk is rejected with a
 * slab test, then traversed with an Amanatides–Woo voxel DDA; at every cell
 * entry event the full incident voxel set (every voxel whose closed cube
 * contains the entry point, across chunk borders) is checked, so exact
 * boundary ties are resolved deterministically.
 *
 * The approved tie-break (ADR-0005) is: smallest non-negative ray
 * distance; an exact boundary tie resolves by voxel X, then Y, then Z
 * (volume-local coordinates), followed by stable Node ID and Volume ID.
 * The returned hit face is the volume-local axis-aligned unit normal of
 * the face the ray crosses into the voxel; tangent (grazing) touches fall
 * back to the containing face whose plane is most perpendicular to the
 * ray (X, Y, Z priority on equal magnitudes).
 *
 * The module is pure: it reads only the immutable store surface, never
 * mutates semantic or renderer state, and produces identical results for
 * identical inputs.
 */

/**
 * Absolute coordinate epsilon used to detect exact boundary touches.
 * Well below one voxel unit and above double-precision noise for the
 * coordinate magnitudes this editor supports.
 */
export const PICK_BOUNDARY_EPSILON = 1e-6;

/** Distance epsilon for the ADR-0005 "exact boundary tie" predicate. */
export const PICK_DISTANCE_EPSILON = 1e-6;

/**
 * Relative epsilon for snapping local ray direction components to zero.
 * Inverse world matrices are computed in floating point, so an exactly
 * axis-aligned world ray can pick up a ~1e-16 cross-axis component after
 * transformation through a rotated node; snapping restores exact
 * axis-aligned geometry while remaining far below voxel scale.
 */
export const PICK_DIRECTION_EPSILON = 1e-12;

/** A world-space ray; `direction` need not be normalized. */
export interface PickRay {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

/** One deterministic pick hit (plan S6.12). */
export interface VoxelPickHit {
  readonly nodeId: NodeId;
  readonly volumeId: VolumeId;
  /** Volume-local integer voxel coordinate (may be negative). */
  readonly voxel: Vec3i;
  /** Volume-local axis-aligned unit face normal of the entered face. */
  readonly face: Vec3i;
  /** World-space ray distance, always non-negative. */
  readonly distance: number;
  /** World-space hit point on the entered face. */
  readonly point: Vec3;
}

/** Optional picking bounds (plan S6.12 resource limits). */
export interface PickOptions {
  /** Reject hits farther than this world-space distance. */
  readonly maxDistance?: number;
}

/** Half-open world-space bounds of projected content. */
export interface WorldBounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** A candidate hit before node/volume identity is attached. */
interface LocalPickHit {
  readonly voxel: Vec3i;
  readonly face: Vec3i;
  readonly distance: number;
  readonly point: Vec3;
}

/** Rounds to the nearest integer plane, canonicalizing -0 to 0 (ADR-0001). */
const roundedPlane = (value: number): number => {
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** Unit vector along one axis, negated when `negative` is set. */
const axisUnit = (axis: number, negative: boolean): Vec3i => {
  const face: [number, number, number] = [0, 0, 0];
  face[axis] = negative ? -1 : 1;
  return face;
};

/** True when `value` lies on the integer plane at `plane` within epsilon. */
const isOnPlane = (value: number, plane: number): boolean =>
  Math.abs(value - plane) <= PICK_BOUNDARY_EPSILON;

const scale = (vector: Vec3, factor: number): Vec3 => [
  vector[0] * factor,
  vector[1] * factor,
  vector[2] * factor,
];

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Applies the linear (3x3) part of a matrix to a vector. */
const applyLinear = (matrix: Mat4, vector: Vec3): Vec3 => [
  matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
  matrix[4] * vector[0] + matrix[5] * vector[1] + matrix[6] * vector[2],
  matrix[8] * vector[0] + matrix[9] * vector[1] + matrix[10] * vector[2],
];

/**
 * World matrices of every node, computed depth-first from the document
 * root in explicit child order (deterministic per document).
 */
export function nodeWorldMatrices(
  store: DocumentStoreRead,
): ReadonlyMap<NodeId, Mat4> {
  // Runtime projection: rotation constraints (plan S9.5, ticket #27)
  // clamp local rotations before hierarchy composition, so rendering,
  // overlays, bounds, and picking all agree on the constrained world.
  return evaluateConstrainedNodeWorldTransforms(store.getDocument());
}

/** Transforms an integer AABB into its world-space AABB. */
function transformAabb(matrix: Mat4, bounds: IntAabb): WorldBounds {
  const corners: Vec3[] = [];
  for (let x = 0; x < 2; x += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let z = 0; z < 2; z += 1) {
        corners.push(
          applyMatrix(matrix, [
            x === 0 ? bounds.min[0] : bounds.max[0],
            y === 0 ? bounds.min[1] : bounds.max[1],
            z === 0 ? bounds.min[2] : bounds.max[2],
          ]),
        );
      }
    }
  }
  let min: Vec3 = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  let max: Vec3 = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const corner of corners) {
    min = [
      Math.min(min[0], corner[0]),
      Math.min(min[1], corner[1]),
      Math.min(min[2], corner[2]),
    ];
    max = [
      Math.max(max[0], corner[0]),
      Math.max(max[1], corner[1]),
      Math.max(max[2], corner[2]),
    ];
  }
  return { min, max };
}

const unionBounds = (a: WorldBounds, b: WorldBounds): WorldBounds => ({
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

/** World-space AABB of every occupied voxel in the document, if any. */
export function worldContentBounds(
  store: DocumentStoreRead,
): WorldBounds | undefined {
  return boundsForNodes(store, [...nodeWorldMatrices(store).keys()]);
}

/** World-space AABB of the given nodes' occupied voxels, if any. */
export function worldBoundsForNodes(
  store: DocumentStoreRead,
  nodeIds: readonly NodeId[],
): WorldBounds | undefined {
  return boundsForNodes(store, nodeIds);
}

/** Union of the world AABBs of the given nodes' occupied voxels. */
function boundsForNodes(
  store: DocumentStoreRead,
  nodeIds: readonly NodeId[],
): WorldBounds | undefined {
  const matrices = nodeWorldMatrices(store);
  const document = store.getDocument();
  let bounds: WorldBounds | undefined;
  for (const nodeId of nodeIds) {
    const node = document.nodes[nodeId];
    const matrix = matrices.get(nodeId);
    if (node === undefined || matrix === undefined) continue;
    for (const component of node.components) {
      if (component.kind !== "voxel") continue;
      const local = store.getVolume(component.volumeId)?.occupiedBounds();
      if (local === undefined) continue;
      const world = transformAabb(matrix, local);
      bounds = bounds === undefined ? world : unionBounds(bounds, world);
    }
  }
  return bounds;
}

/** ADR-0005 comparison: distance, then X/Y/Z voxel, then node/volume id. */
function compareCandidates(
  a: { readonly distance: number; readonly voxel: Vec3i },
  b: { readonly distance: number; readonly voxel: Vec3i },
): number {
  const delta = a.distance - b.distance;
  if (Math.abs(delta) > PICK_DISTANCE_EPSILON) return delta < 0 ? -1 : 1;
  for (const axis of [0, 1, 2] as const) {
    if (a.voxel[axis] !== b.voxel[axis]) {
      return a.voxel[axis] < b.voxel[axis] ? -1 : 1;
    }
  }
  return 0;
}

function isBetter(candidate: VoxelPickHit, best: VoxelPickHit): boolean {
  const order = compareCandidates(candidate, best);
  if (order !== 0) return order < 0;
  if (candidate.nodeId !== best.nodeId) {
    return candidate.nodeId < best.nodeId;
  }
  return candidate.volumeId < best.volumeId;
}

function isBetterLocal(candidate: LocalPickHit, best: LocalPickHit): boolean {
  return compareCandidates(candidate, best) < 0;
}

/** Ray vs axis-aligned slab intersection; undefined when the ray misses. */
function slabIntersect(
  origin: Vec3,
  direction: Vec3,
  min: Vec3i,
  max: Vec3i,
): { readonly tNear: number; readonly tFar: number } | undefined {
  let tNear = Number.NEGATIVE_INFINITY;
  let tFar = Number.POSITIVE_INFINITY;
  for (const axis of [0, 1, 2] as const) {
    const component = direction[axis];
    if (component === 0) {
      // Origins within the boundary epsilon count as inside so inverse
      // matrix roundoff cannot reject an exactly grazing ray.
      if (
        origin[axis] < min[axis] - PICK_BOUNDARY_EPSILON ||
        origin[axis] > max[axis] + PICK_BOUNDARY_EPSILON
      ) {
        return undefined;
      }
      continue;
    }
    const near = (min[axis] - origin[axis]) / component;
    const far = (max[axis] - origin[axis]) / component;
    const t1 = Math.min(near, far);
    const t2 = Math.max(near, far);
    tNear = Math.max(tNear, t1);
    tFar = Math.min(tFar, t2);
    if (tNear > tFar) return undefined;
  }
  return { tNear, tFar };
}

/** The DDA starting cell for an entry point on the chunk boundary. */
function startCell(
  point: Vec3,
  direction: Vec3,
  min: Vec3i,
  max: Vec3i,
): [number, number, number] {
  const cell: [number, number, number] = [0, 0, 0];
  for (const axis of [0, 1, 2] as const) {
    const p = point[axis];
    const plane = roundedPlane(p);
    if (isOnPlane(p, plane)) {
      cell[axis] = direction[axis] >= 0 ? plane : plane - 1;
    } else {
      cell[axis] = Math.floor(p);
    }
    if (cell[axis] < min[axis]) cell[axis] = min[axis];
    if (cell[axis] >= max[axis]) cell[axis] = max[axis] - 1;
  }
  return cell;
}

/** Volume-local axis-aligned face the ray crosses into `voxel` at `point`. */
function hitFace(voxel: Vec3i, point: Vec3, direction: Vec3): Vec3i {
  // Crossed plane: the ray enters through the min face when moving along
  // the axis, through the max face when moving against it.
  for (const axis of [0, 1, 2] as const) {
    if (direction[axis] > 0 && isOnPlane(point[axis], voxel[axis])) {
      return axisUnit(axis, true);
    }
    if (direction[axis] < 0 && isOnPlane(point[axis], voxel[axis] + 1)) {
      return axisUnit(axis, false);
    }
  }
  // Tangent or origin-inside touch: prefer a containing face whose plane
  // is most perpendicular to the ray (axis priority on equal magnitudes).
  let bestAxis: 0 | 1 | 2 = 0;
  let bestMagnitude = -1;
  let bestMin = false;
  for (const axis of [0, 1, 2] as const) {
    const onMin = isOnPlane(point[axis], voxel[axis]);
    const onMax = isOnPlane(point[axis], voxel[axis] + 1);
    if (!onMin && !onMax) continue;
    const magnitude = Math.abs(direction[axis]);
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      bestAxis = axis;
      bestMin = onMin;
    }
  }
  if (bestMagnitude < 0) {
    // Origin strictly inside the voxel: the first face the ray exits
    // (dominant axis, X/Y/Z priority on equal magnitudes).
    let dominantAxis: 0 | 1 | 2 = 0;
    let dominantMagnitude = -1;
    for (const axis of [0, 1, 2] as const) {
      const magnitude = Math.abs(direction[axis]);
      if (magnitude > dominantMagnitude) {
        dominantMagnitude = magnitude;
        dominantAxis = axis;
      }
    }
    return axisUnit(dominantAxis, direction[dominantAxis] < 0);
  }
  return axisUnit(bestAxis, bestMin);
}

/**
 * Checks every voxel whose closed cube contains `point` (crossing chunk
 * borders); returns the best occupied one under the ADR-0005 tie-break.
 */
function incidentHit(
  readView: VoxelVolumeReadView,
  point: Vec3,
  direction: Vec3,
  t: number,
  ray: PickRay,
): LocalPickHit | undefined {
  const base: [number, number, number] = [0, 0, 0];
  const planes: [number, number][] = [];
  for (const axis of [0, 1, 2] as const) {
    const p = point[axis];
    const plane = roundedPlane(p);
    if (isOnPlane(p, plane)) {
      planes.push([axis, plane]);
      base[axis] = plane;
    } else {
      base[axis] = Math.floor(p);
    }
  }
  let best: LocalPickHit | undefined;
  for (let mask = 0; mask < 1 << planes.length; mask += 1) {
    const voxel: [number, number, number] = [...base];
    for (let index = 0; index < planes.length; index += 1) {
      const entry = planes[index];
      if (entry === undefined) continue;
      const [axis, plane] = entry;
      if (((mask >> index) & 1) === 1) voxel[axis] = plane - 1;
    }
    if (readView.getVoxel(voxel) === 0) continue;
    const candidate: LocalPickHit = {
      voxel,
      face: hitFace(voxel, point, direction),
      distance: t * lengthOf(ray.direction),
      point: add(ray.origin, scale(ray.direction, t)),
    };
    if (best === undefined || isBetterLocal(candidate, best)) best = candidate;
  }
  return best;
}

function lengthOf(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

/** Picks one chunk with a deterministic voxel DDA (plan S6.12). */
function pickChunk(
  readView: VoxelVolumeReadView,
  chunk: Vec3i,
  localOrigin: Vec3,
  localDirection: Vec3,
  ray: PickRay,
): LocalPickHit | undefined {
  const min: [number, number, number] = [
    chunk[0] * CHUNK_EDGE,
    chunk[1] * CHUNK_EDGE,
    chunk[2] * CHUNK_EDGE,
  ];
  const max: [number, number, number] = [
    min[0] + CHUNK_EDGE,
    min[1] + CHUNK_EDGE,
    min[2] + CHUNK_EDGE,
  ];
  const slab = slabIntersect(localOrigin, localDirection, min, max);
  if (slab === undefined || slab.tFar < 0) return undefined;

  const entryT = Math.max(slab.tNear, 0);
  const entryPoint = add(localOrigin, scale(localDirection, entryT));
  const cell = startCell(entryPoint, localDirection, min, max);

  const step: [number, number, number] = [
    Math.sign(localDirection[0]),
    Math.sign(localDirection[1]),
    Math.sign(localDirection[2]),
  ];
  const tDelta: [number, number, number] = [0, 0, 0];
  const tMax: [number, number, number] = [0, 0, 0];
  for (const axis of [0, 1, 2] as const) {
    const component = localDirection[axis];
    if (component === 0) {
      tDelta[axis] = Number.POSITIVE_INFINITY;
      tMax[axis] = Number.POSITIVE_INFINITY;
    } else {
      tDelta[axis] = Math.abs(1 / component);
      const boundary = step[axis] > 0 ? cell[axis] + 1 : cell[axis];
      tMax[axis] = (boundary - localOrigin[axis]) / component;
    }
  }

  // A 16^3 chunk crosses at most 48 cells; the cap is defensive only.
  const iterationLimit = 256;
  let t = entryT;
  for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
    const point = add(localOrigin, scale(localDirection, t));
    const hit = incidentHit(readView, point, localDirection, t, ray);
    if (hit !== undefined) return hit;
    const axis =
      tMax[0] <= tMax[1] && tMax[0] <= tMax[2] ? 0 : tMax[1] <= tMax[2] ? 1 : 2;
    const nextT = tMax[axis];
    if (nextT > slab.tFar + PICK_BOUNDARY_EPSILON) return undefined;
    cell[axis] += step[axis];
    if (cell[axis] < min[axis] || cell[axis] >= max[axis]) return undefined;
    tMax[axis] = nextT + tDelta[axis];
    t = nextT;
  }
  return undefined;
}

/** Zeroes direction components negligible relative to the ray's scale. */
function snapDirection(direction: Vec3): Vec3 {
  const length = lengthOf(direction);
  if (length === 0) return direction;
  const threshold = length * PICK_DIRECTION_EPSILON;
  return [
    Math.abs(direction[0]) < threshold ? 0 : direction[0],
    Math.abs(direction[1]) < threshold ? 0 : direction[1],
    Math.abs(direction[2]) < threshold ? 0 : direction[2],
  ];
}

/** Picks one volume (all chunks, stable X/Y/Z order). */
function pickVolume(
  readView: VoxelVolumeReadView,
  world: Mat4,
  ray: PickRay,
): LocalPickHit | undefined {
  const inverse = invertMatrix(world);
  const localOrigin = applyMatrix(inverse, ray.origin);
  const localDirection = snapDirection(applyLinear(inverse, ray.direction));
  if (lengthOf(localDirection) === 0) return undefined;
  let best: LocalPickHit | undefined;
  for (const chunk of readView.chunkCoordinates()) {
    const hit = pickChunk(readView, chunk, localOrigin, localDirection, ray);
    if (hit === undefined) continue;
    if (best === undefined || isBetterLocal(hit, best)) best = hit;
  }
  return best;
}

/**
 * Deterministically picks the nearest occupied voxel along a world-space
 * ray (plan S6.12, ADR-0005). Returns undefined on a miss. `direction`
 * needs no normalization; reported distances and points are world-space
 * and invariant to its length.
 */
export function pickScene(
  store: DocumentStoreRead,
  ray: PickRay,
  options?: PickOptions,
): VoxelPickHit | undefined {
  if (lengthOf(ray.direction) === 0) return undefined;
  const matrices = nodeWorldMatrices(store);
  const document = store.getDocument();
  let best: VoxelPickHit | undefined;
  for (const [nodeId, world] of matrices) {
    const node = document.nodes[nodeId];
    if (node === undefined) continue;
    for (const component of node.components) {
      if (component.kind !== "voxel") continue;
      const readView = store.getVolume(component.volumeId);
      if (readView === undefined || readView.occupiedCount() === 0) continue;
      const hit = pickVolume(readView, world, ray);
      if (hit === undefined) continue;
      if (
        options?.maxDistance !== undefined &&
        hit.distance > options.maxDistance
      ) {
        continue;
      }
      const candidate: VoxelPickHit = {
        nodeId,
        volumeId: component.volumeId,
        ...hit,
      };
      if (best === undefined || isBetter(candidate, best)) best = candidate;
    }
  }
  return best;
}
