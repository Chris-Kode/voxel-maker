import {
  WorkspaceError,
  type CommandId,
  type NodeId,
} from "@voxel-maker/shared";
import {
  canonicalTransform,
  decomposeMatrix,
  invertMatrix,
  multiplyMatrices,
  quaternionConjugate,
  quaternionFromAxisAngle,
  quaternionMultiply,
  rotateVector,
  transformToMatrix,
  transformsEqual,
  type Mat4,
  type Transform,
  type Vec3,
} from "@voxel-maker/math";
import type { SelectionWorldBounds } from "./selection.js";
import type { SelectionEntry } from "./types.js";
import {
  worldTransformMatrix,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import { setNodeTransformCommand, type Command } from "@voxel-maker/commands";
import type { ToolActionResult } from "./types.js";

/**
 * Headless transform gizmo tool (plan S7.8, ticket #20): move/rotate/scale
 * drags over the runtime node selection that commit coalesced
 * `node.setTransform` commands through one gesture, so a whole drag
 * produces exactly one history entry and pointer cancellation restores the
 * exact pre-gesture transforms. Local/world modes, snapping, and the
 * per-axis drag semantics are explicit tool state, never inferred from UI
 * state inside handlers (ARCHITECTURE.md "Editor interaction").
 *
 * The tool is deterministic: every 3D input (camera ray, camera forward,
 * gizmo center) is injected by the host, so Node tests drive the full drag
 * math with fixed rays. Handle picking is a viewport concern (projected
 * hit testing against the rendered gizmo) and stays in the desktop layer;
 * the tool consumes the picked handle.
 *
 * Drag semantics:
 *
 * - **Translate** (world/local): the pointer ray intersects a plane through
 *   the gizmo center whose normal is perpendicular to the drag axis and the
 *   camera forward; the signed distance along the axis between the start
 *   and current intersections is applied to each target node. World mode
 *   moves every node by the world-space delta; local mode applies the delta
 *   along each node's own rotated axis.
 * - **Rotate** (world): each node's whole world placement rotates around
 *   the shared gizmo center; the resulting local transform is resolved with
 *   `resolveLocalTransform` (ADR-0001 derived-transform policy). **Rotate**
 *   (local): the node's local rotation is pre-multiplied by the delta
 *   around its own local axis.
 * - **Scale** (local): the chosen local scale component multiplies by the
 *   drag factor. **Scale** (world): the world axis is expressed in the
 *   node's local frame and each scale component multiplies by its
 *   projection, so an axis-aligned node scales on the matching axis and a
 *   rotated node scales along the world axis.
 *
 * Snapping rounds the accumulated value (translate distance, rotation
 * angle, scale factor) to explicit increments; every produced transform is
 * canonicalized (finite, strictly positive scale, normalized rotation), so
 * a drag can never install an invalid transform.
 */

/** Gizmo interaction mode (plan S7.8). */
export type TransformToolMode = "translate" | "rotate" | "scale";

/** Explicit transform space (plan S7.8 "explicit local and world modes"). */
export type TransformSpace = "local" | "world";

/** The three gizmo axes (0 = X, 1 = Y, 2 = Z). */
export type GizmoAxis = 0 | 1 | 2;

/** One pickable gizmo handle. */
export interface GizmoHandle {
  readonly mode: TransformToolMode;
  readonly axis: GizmoAxis;
}

/** A camera ray at viewport coordinates (desktop injects it). */
export interface CameraRay {
  readonly origin: Vec3;
  /** Normalized direction. */
  readonly direction: Vec3;
}

/** Services injected into the transform tool by the composition root. */
export interface NodeTransformToolHost {
  /** The authoritative read surface of the open document. */
  readonly store: DocumentStoreRead | undefined;
  /** The runtime selection; node entries are the transform targets. */
  readonly selection: readonly SelectionEntry[];
  /** Camera forward (from the camera toward the scene), normalized. */
  cameraForward(): Vec3;
  /** Camera ray at viewport-relative coordinates, or undefined. */
  ray(clientX: number, clientY: number): CameraRay | undefined;
  /** Supplies a fresh command id for the next drag command. */
  nextCommandId(): CommandId;
  /**
   * Opens one coalescing gesture on the command bus; undefined when no
   * document is open. The returned host executes labeled transactions and
   * presents the whole drag as one history entry (plan S4.10).
   */
  beginGesture(): GestureHost | undefined;
  /** Surfaces a drag failure as a runtime notice. */
  pushNotice(level: "info" | "warning" | "error", message: string): void;
}

/** Coalesced-commit surface of one drag (plan S4.10). */
export interface GestureHost {
  /**
   * Executes one atomic labeled transaction; returns the error, or
   * undefined on success. Never partially applies a drag.
   */
  update(
    commands: readonly Command[],
    label: string,
  ): WorkspaceError | undefined;
  /** Seals the drag as one history entry. */
  end(): void;
  /** Rolls the document back to the exact pre-drag transforms. */
  cancel(): WorkspaceError | undefined;
}

/** The transform targets of the current runtime node selection. */
export interface TransformTargets {
  /** Selected node ids, in selection order, pruned of deleted nodes. */
  readonly nodeIds: readonly NodeId[];
  /** World-space gizmo center: the center of the union world bounds. */
  readonly center: Vec3;
  /** Half of the union bounds diagonal; the scale-drag reference length. */
  readonly radius: number;
}

const AXES: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** Default snapping increments (plan S7.8; UI may override). */
export const DEFAULT_TRANSLATE_SNAP = 0.25;
export const DEFAULT_ROTATE_SNAP = Math.PI / 12;
export const DEFAULT_SCALE_SNAP = 0.25;

/** Smallest scale factor a scale drag may produce (keeps scale positive). */
const MIN_SCALE_FACTOR = 0.01;

const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const subtract = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

const scale = (a: Vec3, factor: number): Vec3 => [
  a[0] * factor,
  a[1] * factor,
  a[2] * factor,
];

function normalize(value: Vec3): Vec3 | undefined {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!(length > 1e-12) || !Number.isFinite(length)) return undefined;
  return [value[0] / length, value[1] / length, value[2] / length];
}

/** Ray/plane intersection; undefined when parallel or behind the origin. */
function intersectPlane(
  ray: CameraRay,
  point: Vec3,
  normal: Vec3,
): Vec3 | undefined {
  const denominator = dot(ray.direction, normal);
  if (Math.abs(denominator) < 1e-9) return undefined;
  const distance = dot(subtract(point, ray.origin), normal) / denominator;
  if (distance < 0) return undefined;
  return add(ray.origin, scale(ray.direction, distance));
}

const snapValue = (value: number, increment: number): number =>
  Math.round(value / increment) * increment;

/**
 * Union world bounds of the node entries of a selection (plan S7.2); the
 * gizmo center and scale reference derive from it.
 */
function nodeSelectionBounds(
  store: DocumentStoreRead,
  selection: readonly SelectionEntry[],
): SelectionWorldBounds | undefined {
  const document = store.getDocument();
  let bounds: SelectionWorldBounds | undefined;
  for (const entry of selection) {
    if (entry.kind !== "node") continue;
    const node = document.nodes[entry.nodeId];
    if (node === undefined) continue;
    const matrix = worldTransformMatrix(document, entry.nodeId);
    let local: SelectionWorldBounds | undefined;
    for (const component of node.components) {
      if (component.kind !== "voxel") continue;
      const occupied = store.getVolume(component.volumeId)?.occupiedBounds();
      if (occupied === undefined) continue;
      local = transformLocalBounds(matrix, occupied, local);
    }
    // A node without voxels still participates: use its world origin.
    const resolved: SelectionWorldBounds =
      local ??
      (() => {
        const origin = applyMatrixPoint(matrix, [0, 0, 0]);
        return { min: origin, max: origin };
      })();
    bounds = bounds === undefined ? resolved : unionBounds(bounds, resolved);
  }
  return bounds;
}

function applyMatrixPoint(matrix: Mat4, point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] +
      matrix[1] * point[1] +
      matrix[2] * point[2] +
      matrix[3],
    matrix[4] * point[0] +
      matrix[5] * point[1] +
      matrix[6] * point[2] +
      matrix[7],
    matrix[8] * point[0] +
      matrix[9] * point[1] +
      matrix[10] * point[2] +
      matrix[11],
  ];
}

function transformLocalBounds(
  matrix: Mat4,
  bounds: { readonly min: Vec3; readonly max: Vec3 },
  into: SelectionWorldBounds | undefined,
): SelectionWorldBounds {
  const first = applyMatrixPoint(matrix, [
    bounds.min[0],
    bounds.min[1],
    bounds.min[2],
  ]);
  let result: SelectionWorldBounds = into ?? { min: first, max: first };
  for (let x = 0; x < 2; x += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let z = 0; z < 2; z += 1) {
        if (x === 0 && y === 0 && z === 0) continue;
        const corner: Vec3 = applyMatrixPoint(matrix, [
          x === 0 ? bounds.min[0] : bounds.max[0],
          y === 0 ? bounds.min[1] : bounds.max[1],
          z === 0 ? bounds.min[2] : bounds.max[2],
        ]);
        result = {
          min: [
            Math.min(result.min[0], corner[0]),
            Math.min(result.min[1], corner[1]),
            Math.min(result.min[2], corner[2]),
          ],
          max: [
            Math.max(result.max[0], corner[0]),
            Math.max(result.max[1], corner[1]),
            Math.max(result.max[2], corner[2]),
          ],
        };
      }
    }
  }
  return result;
}

const unionBounds = (
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

/**
 * Resolves the transform targets of the current node selection: pruned
 * node ids, the union world-bounds center, and half its diagonal.
 * Undefined when the selection contains no live node entries.
 */
export function transformTargets(
  store: DocumentStoreRead,
  selection: readonly SelectionEntry[],
): TransformTargets | undefined {
  const bounds = nodeSelectionBounds(store, selection);
  if (bounds === undefined) return undefined;
  const center: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const diagonal = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  return {
    nodeIds: selection
      .filter(
        (entry): entry is Extract<SelectionEntry, { readonly kind: "node" }> =>
          entry.kind === "node" &&
          store.getDocument().nodes[entry.nodeId] !== undefined,
      )
      .map((entry) => entry.nodeId),
    center,
    radius: Math.max(diagonal / 2, 1),
  };
}

/** One in-progress drag. */
interface DragState {
  readonly handle: GizmoHandle;
  readonly targets: TransformTargets;
  /** Local transforms captured at pointer-down (the rollback baseline). */
  readonly baseline: ReadonlyMap<NodeId, Transform>;
  /** World matrix of each target's parent at pointer-down. */
  readonly parentWorld: ReadonlyMap<NodeId, Mat4>;
  readonly startPoint: Vec3;
  readonly planeNormal: Vec3;
  /** The world-space drag axis (first node's axis in local mode). */
  readonly axis: Vec3;
  /** Space and snapping pinned at pointer-down (plan S7.8). */
  readonly space: TransformSpace;
  readonly snapping: boolean;
  readonly gesture: GestureHost;
  /** True after a failed update; further moves are no-ops. */
  failed: boolean;
}

/** Headless transform gizmo tool (plan S7.8). */
export interface NodeTransformTool {
  readonly id: "transform";
  readonly mode: TransformToolMode;
  readonly space: TransformSpace;
  /** Snapping toggles and increments (explicit tool state). */
  readonly snapping: boolean;
  readonly translateSnap: number;
  readonly rotateSnap: number;
  readonly scaleSnap: number;
  /** True while a gizmo drag is in progress. */
  readonly active: boolean;
  /** The handle being dragged, when active. */
  readonly handle: GizmoHandle | undefined;
  setMode(mode: TransformToolMode): void;
  setSpace(space: TransformSpace): void;
  setSnapping(enabled: boolean): void;
  setTranslateSnap(increment: number): void;
  setRotateSnap(increment: number): void;
  setScaleSnap(increment: number): void;
  pointerDown(
    handle: GizmoHandle,
    clientX: number,
    clientY: number,
  ): ToolActionResult;
  pointerMove(clientX: number, clientY: number): ToolActionResult;
  pointerUp(): ToolActionResult;
  pointerCancel(): void;
  /** Discards any in-progress drag (lifecycle replacement, tests). */
  reset(): void;
}

const MISSING_RAY: WorkspaceError = new WorkspaceError({
  family: "validation",
  code: "NO_POINTER_RAY",
  message: "The pointer is outside the viewport",
});

class TransformToolImpl implements NodeTransformTool {
  readonly id = "transform" as const;
  readonly #host: NodeTransformToolHost;
  #mode: TransformToolMode = "translate";
  #space: TransformSpace = "world";
  #snapping = true;
  #translateSnap = DEFAULT_TRANSLATE_SNAP;
  #rotateSnap = DEFAULT_ROTATE_SNAP;
  #scaleSnap = DEFAULT_SCALE_SNAP;
  #drag: DragState | undefined;

  constructor(host: NodeTransformToolHost) {
    this.#host = host;
  }

  get mode(): TransformToolMode {
    return this.#mode;
  }

  get space(): TransformSpace {
    return this.#space;
  }

  get snapping(): boolean {
    return this.#snapping;
  }

  get translateSnap(): number {
    return this.#translateSnap;
  }

  get rotateSnap(): number {
    return this.#rotateSnap;
  }

  get scaleSnap(): number {
    return this.#scaleSnap;
  }

  get active(): boolean {
    return this.#drag !== undefined;
  }

  get handle(): GizmoHandle | undefined {
    return this.#drag?.handle;
  }

  setMode(mode: TransformToolMode): void {
    this.#mode = mode;
  }

  setSpace(space: TransformSpace): void {
    this.#space = space;
  }

  setSnapping(enabled: boolean): void {
    this.#snapping = enabled;
  }

  setTranslateSnap(increment: number): void {
    if (Number.isFinite(increment) && increment > 0) {
      this.#translateSnap = increment;
    }
  }

  setRotateSnap(increment: number): void {
    if (Number.isFinite(increment) && increment > 0) {
      this.#rotateSnap = increment;
    }
  }

  setScaleSnap(increment: number): void {
    if (Number.isFinite(increment) && increment > 0) {
      this.#scaleSnap = increment;
    }
  }

  pointerDown(
    handle: GizmoHandle,
    clientX: number,
    clientY: number,
  ): ToolActionResult {
    if (this.#drag !== undefined) return { ok: true };
    const store = this.#host.store;
    if (store === undefined) return { ok: true };
    const targets = transformTargets(store, this.#host.selection);
    if (targets === undefined) return { ok: true };
    const ray = this.#host.ray(clientX, clientY);
    if (ray === undefined) return { ok: false, error: MISSING_RAY };
    const axis = this.#dragAxis(store, targets, handle.axis);
    // Translate/scale drag on the plane that contains the axis and faces
    // the camera; rotate drags move on the plane perpendicular to the
    // axis (the angle is measured around the axis).
    let planeNormal =
      handle.mode === "rotate" ? axis : this.#dragPlaneNormal(axis);
    let startPoint = intersectPlane(ray, targets.center, planeNormal);
    if (startPoint === undefined) {
      // Degenerate: the pointer ray is parallel to the drag plane (for
      // example the front view at the gizmo's height). Fall back to the
      // plane facing the camera through the gizmo center.
      planeNormal = this.#host.cameraForward();
      startPoint = intersectPlane(ray, targets.center, planeNormal);
    }
    if (startPoint === undefined) return { ok: true };
    const gesture = this.#host.beginGesture();
    if (gesture === undefined) return { ok: true };
    this.#drag = {
      handle,
      targets,
      baseline: this.#baselineTransforms(store, targets.nodeIds),
      parentWorld: this.#parentWorlds(store, targets.nodeIds),
      startPoint,
      planeNormal,
      axis,
      space: this.#space,
      snapping: this.#snapping,
      gesture,
      failed: false,
    };
    return { ok: true };
  }

  pointerMove(clientX: number, clientY: number): ToolActionResult {
    const drag = this.#drag;
    if (drag === undefined || drag.failed) return { ok: true };
    const store = this.#host.store;
    if (store === undefined) return { ok: true };
    const ray = this.#host.ray(clientX, clientY);
    if (ray === undefined) return { ok: false, error: MISSING_RAY };
    const point = intersectPlane(ray, drag.targets.center, drag.planeNormal);
    if (point === undefined) return { ok: true };

    const commands = this.#buildCommands(store, drag, point);
    if (commands.length === 0) return { ok: true };
    const error = drag.gesture.update(commands, this.#label(drag.handle.mode));
    if (error !== undefined) {
      drag.failed = true;
      this.#host.pushNotice("error", error.message);
      return { ok: false, error };
    }
    return { ok: true };
  }

  pointerUp(): ToolActionResult {
    const drag = this.#drag;
    if (drag === undefined) return { ok: true };
    this.#drag = undefined;
    drag.gesture.end();
    return { ok: true };
  }

  pointerCancel(): void {
    const drag = this.#drag;
    if (drag === undefined) return;
    this.#drag = undefined;
    const error = drag.gesture.cancel();
    if (error !== undefined) {
      this.#host.pushNotice("error", error.message);
    }
  }

  reset(): void {
    this.#drag = undefined;
  }

  #label(mode: TransformToolMode): string {
    switch (mode) {
      case "translate":
        return "Move";
      case "rotate":
        return "Rotate";
      case "scale":
        return "Scale";
    }
  }

  /** World-space unit drag axis for the given gizmo axis and space. */
  #dragAxis(
    store: DocumentStoreRead,
    targets: TransformTargets,
    axis: GizmoAxis,
  ): Vec3 {
    const worldAxis = AXES[axis] as Vec3;
    if (this.#space === "world" || targets.nodeIds.length === 0) {
      return worldAxis;
    }
    const node = store.getDocument().nodes[targets.nodeIds[0] as NodeId];
    if (node === undefined) return worldAxis;
    return rotateVector(node.transform.rotation, worldAxis);
  }

  /** Drag plane normal: perpendicular to the axis, facing the camera. */
  #dragPlaneNormal(axis: Vec3): Vec3 {
    const forward = this.#host.cameraForward();
    const fallback = normalize(cross(axis, [0, 1, 0])) ??
      normalize(cross(axis, [1, 0, 0])) ?? [1, 0, 0];
    return normalize(cross(forward, axis)) ?? fallback;
  }

  #baselineTransforms(
    store: DocumentStoreRead,
    nodeIds: readonly NodeId[],
  ): ReadonlyMap<NodeId, Transform> {
    const document = store.getDocument();
    return new Map(
      nodeIds
        .map((id) => document.nodes[id])
        .filter((node) => node !== undefined)
        .map((node) => [node.nodeId, node.transform] as const),
    );
  }

  #parentWorlds(
    store: DocumentStoreRead,
    nodeIds: readonly NodeId[],
  ): ReadonlyMap<NodeId, Mat4> {
    const document = store.getDocument();
    const map = new Map<NodeId, Mat4>();
    for (const id of nodeIds) {
      const node = document.nodes[id];
      if (node === undefined || node.parentId === null) continue;
      map.set(id, worldTransformMatrix(document, node.parentId));
    }
    return map;
  }

  /** Builds the absolute setTransform commands for one drag update. */
  #buildCommands(
    store: DocumentStoreRead,
    drag: DragState,
    point: Vec3,
  ): readonly Command[] {
    const commands: Command[] = [];
    const document = store.getDocument();
    for (const nodeId of drag.targets.nodeIds) {
      const node = document.nodes[nodeId];
      const baseline = drag.baseline.get(nodeId);
      if (node === undefined || baseline === undefined) continue;
      const next = this.#nextTransform(
        store,
        drag,
        nodeId,
        node.transform,
        baseline,
        point,
      );
      if (next === undefined) continue;
      // Skip no-op updates so tiny drags never create empty transactions.
      const transform = canonicalTransform(next);
      if (transformsEqual(transform, node.transform)) continue;
      commands.push(
        setNodeTransformCommand(this.#host.nextCommandId(), {
          nodeId,
          transform,
        }),
      );
    }
    return commands;
  }

  /** Computes the next canonicalizable local transform of one node. */
  #nextTransform(
    store: DocumentStoreRead,
    drag: DragState,
    nodeId: NodeId,
    current: Transform,
    baseline: Transform,
    point: Vec3,
  ): Transform | undefined {
    switch (drag.handle.mode) {
      case "translate": {
        const delta = dot(subtract(point, drag.startPoint), drag.axis);
        const amount = drag.snapping
          ? snapValue(delta, this.#translateSnap)
          : delta;
        if (amount === 0) return current;
        const direction =
          drag.space === "world"
            ? drag.axis
            : rotateVector(baseline.rotation, AXES[drag.handle.axis] as Vec3);
        return {
          translation: [
            baseline.translation[0] + direction[0] * amount,
            baseline.translation[1] + direction[1] * amount,
            baseline.translation[2] + direction[2] * amount,
          ],
          pivot: baseline.pivot,
          rotation: baseline.rotation,
          scale: baseline.scale,
        };
      }
      case "rotate": {
        const d0 = normalize(subtract(drag.startPoint, drag.targets.center));
        const d1 = normalize(subtract(point, drag.targets.center));
        if (d0 === undefined || d1 === undefined) return undefined;
        const angle = Math.atan2(dot(cross(d0, d1), drag.axis), dot(d0, d1));
        const amount = drag.snapping
          ? snapValue(angle, this.#rotateSnap)
          : angle;
        if (Math.abs(amount) < 1e-12) return current;
        if (drag.space === "world") {
          // W' = T(center) R T(-center) W(baseline), then resolve the
          // local transform under the baseline parent world (ADR-0001).
          const world = transformToMatrix(baseline);
          const parentWorld = drag.parentWorld.get(nodeId) ?? identityMatrix();
          const rotatedWorld = rotateWorldMatrix(
            world,
            drag.targets.center,
            drag.axis,
            amount,
          );
          const local = decomposeMatrix(
            multiplyMatrices(invertMatrix(parentWorld), rotatedWorld),
            baseline.pivot,
          );
          return {
            translation: local.translation,
            pivot: baseline.pivot,
            rotation: local.rotation,
            scale: local.scale,
          };
        }
        const delta = quaternionFromAxisAngle(
          AXES[drag.handle.axis] as Vec3,
          amount,
        );
        return {
          translation: baseline.translation,
          pivot: baseline.pivot,
          rotation: quaternionMultiply(delta, baseline.rotation),
          scale: baseline.scale,
        };
      }
      case "scale": {
        const delta = dot(subtract(point, drag.startPoint), drag.axis);
        const raw = 1 + delta / drag.targets.radius;
        const snapped = drag.snapping
          ? 1 + snapValue(raw - 1, this.#scaleSnap)
          : raw;
        const factor = Math.max(snapped, MIN_SCALE_FACTOR);
        if (Math.abs(factor - 1) < 1e-12) return current;
        if (drag.space === "local") {
          const next: [number, number, number] = [...baseline.scale];
          next[drag.handle.axis] = next[drag.handle.axis] * factor;
          return {
            translation: baseline.translation,
            pivot: baseline.pivot,
            rotation: baseline.rotation,
            scale: next,
          };
        }
        // World mode: scale along the world axis expressed in the node's
        // local frame (scale drags never change the rotation, so the
        // baseline rotation is the current one).
        const localAxis = rotateVector(
          quaternionConjugate(baseline.rotation),
          drag.axis,
        );
        return {
          translation: baseline.translation,
          pivot: baseline.pivot,
          rotation: baseline.rotation,
          scale: [
            baseline.scale[0] * (1 + (factor - 1) * Math.abs(localAxis[0])),
            baseline.scale[1] * (1 + (factor - 1) * Math.abs(localAxis[1])),
            baseline.scale[2] * (1 + (factor - 1) * Math.abs(localAxis[2])),
          ],
        };
      }
    }
  }
}

function identityMatrix(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** World matrix rotated around `center` by `angle` about `axis`. */
function rotateWorldMatrix(
  world: Mat4,
  center: Vec3,
  axis: Vec3,
  angle: number,
): Mat4 {
  // T(center) * R(axis, angle) * T(-center) * world. The right factor is
  // the pure back-translation, NOT the inverse of the rotation matrix
  // (that would cancel the rotation).
  const rotationMatrix = transformToMatrix({
    translation: center,
    pivot: [0, 0, 0],
    rotation: quaternionFromAxisAngle(axis, angle),
    scale: [1, 1, 1],
  });
  const translateBack = transformToMatrix({
    translation: scale(center, -1),
    pivot: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  });
  return multiplyMatrices(
    multiplyMatrices(rotationMatrix, translateBack),
    world,
  );
}

/** Creates the transform gizmo tool for one composition. */
export function createNodeTransformTool(
  host: NodeTransformToolHost,
): NodeTransformTool {
  return new TransformToolImpl(host);
}
