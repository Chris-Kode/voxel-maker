import * as THREE from "three";
import { applyMatrix, type Mat4, type Vec3 } from "@voxel-maker/math";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { SceneNode } from "@voxel-maker/model";
import {
  selectionWorldBounds,
  volumeLocalWorldBounds,
  type RegionDraft,
  type SelectionEntry,
  type TransformPreview,
} from "@voxel-maker/editor";
import {
  nodeWorldMatrices,
  worldContentBounds,
  type WorldBounds,
} from "@voxel-maker/renderer";

/**
 * Non-persistent viewport overlays (plan S6.13, ticket #16): grid, world
 * axes, content/selection bounds, and pivot markers. Overlays are pure
 * runtime projections (ADR-0002) — they never enter the document, commit
 * events, history, or saved bytes, and they are rebuilt wholesale on every
 * update. Depth/render-order and visibility policy are documented in
 * `docs/viewport/overlays-v1.md`.
 *
 * - Grid: XZ plane at world y = 0, one line per voxel unit, transparent,
 *   depth-tested but not depth-writing, rendered after opaque geometry.
 * - Axes: +X red / +Y green / +Z blue lines from the world origin, always
 *   drawn on top (depth test disabled).
 * - Bounds: content bounds (cyan) and selection bounds (yellow) wire
 *   boxes, depth-tested, never depth-writing.
 * - Pivots: orange cross markers at each selected node's world-space
 *   transform pivot, always drawn on top.
 * - Joints (plan S9.8, ticket #26): violet ring markers at the world-space
 *   pivot of each selected node carrying a joint annotation, always drawn
 *   on top. A joint annotates a node in the single transform hierarchy; it
 *   never introduces a skeleton graph.
 * - Constraints (plan S9.7, ticket #27): per-axis rotation-limit arcs at
 *   the world-space pivot of each selected node carrying constraints,
 *   drawn in the axis colors (+X red / +Y green / +Z blue). Each arc
 *   sweeps the allowed local Euler range in the node's runtime frame; an
 *   axis whose limit spans a full revolution draws a full ring. Arcs are
 *   projected through the constrained world matrices, so they follow the
 *   same runtime result the viewport renders.
 */

export type OverlayKey =
  | "grid"
  | "axes"
  | "bounds"
  | "pivots"
  | "joints"
  | "constraints";

export type OverlayVisibility = Readonly<Record<OverlayKey, boolean>>;

/** Default visibility: every overlay on. */
export const DEFAULT_OVERLAY_VISIBILITY: OverlayVisibility = {
  grid: true,
  axes: true,
  bounds: true,
  pivots: true,
  joints: true,
  constraints: true,
};

const GRID_SIZE = 100;
const GRID_DIVISIONS = 100;
const AXIS_LENGTH = 10;
const PIVOT_MARKER_LENGTH = 0.5;
const JOINT_MARKER_RADIUS = 0.35;
const CONSTRAINT_MARKER_RADIUS = 0.45;
/** Arc segments per full revolution; limited arcs scale proportionally. */
const CONSTRAINT_ARC_SEGMENTS = 48;

const AXIS_COLORS: readonly [number, number, number] = [
  0xff3b30, 0x34c759, 0x007aff,
];

export interface OverlayManager {
  readonly visible: OverlayVisibility;
  setVisible(key: OverlayKey, visible: boolean): void;
  /** Toggles one overlay; returns the new visibility. */
  toggle(key: OverlayKey): boolean;
  /**
   * Rebuilds the document-dependent overlays from the current store, the
   * mixed selection (node/voxel/region entries), the in-progress
   * region-select draft, and the transform preview (plan S7.19, ticket
   * #19: exact per-entry destination bounds of the pending operation).
   * Pass `undefined` when no document is open.
   */
  update(
    store: DocumentStoreRead | undefined,
    selection: readonly SelectionEntry[],
    regionDraft?: RegionDraft,
    transformPreview?: TransformPreview,
  ): void;
  /** Removes every overlay object from the scene and releases resources. */
  dispose(): void;
}

interface BoxProjection {
  readonly object: THREE.LineSegments;
  readonly material: THREE.LineBasicMaterial;
  readonly bounds: WorldBounds;
}

/** Distinct overlay color for the transform destination preview. */
const TRANSFORM_PREVIEW_COLOR = 0xff2d55;

class OverlayManagerImpl implements OverlayManager {
  readonly #grid: THREE.GridHelper;
  readonly #axes: THREE.Group;
  readonly #boundsGroup: THREE.Group;
  readonly #pivotsGroup: THREE.Group;
  readonly #jointsGroup: THREE.Group;
  readonly #constraintsGroup: THREE.Group;
  #contentBox: BoxProjection | undefined;
  #selectionBox: BoxProjection | undefined;
  #regionDraftBox: BoxProjection | undefined;
  #transformPreviewBoxes: BoxProjection[] = [];
  #transformPreviewSignature: string | undefined;
  #visibility: OverlayVisibility = { ...DEFAULT_OVERLAY_VISIBILITY };

  constructor(scene: THREE.Scene) {
    const grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS);
    const gridMaterial = grid.material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.35;
    gridMaterial.depthWrite = false;
    gridMaterial.depthTest = true;
    grid.renderOrder = 1;
    grid.position.y = 0;
    this.#grid = grid;
    scene.add(grid);

    const axes = new THREE.Group();
    for (const axis of [0, 1, 2] as const) {
      const origin = new THREE.Vector3(0, 0, 0);
      const tip = new THREE.Vector3();
      tip.setComponent(axis, AXIS_LENGTH);
      const geometry = new THREE.BufferGeometry().setFromPoints([origin, tip]);
      const material = new THREE.LineBasicMaterial({
        color: AXIS_COLORS[axis],
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      line.renderOrder = 3;
      axes.add(line);
    }
    this.#axes = axes;
    scene.add(axes);

    this.#boundsGroup = new THREE.Group();
    scene.add(this.#boundsGroup);
    this.#pivotsGroup = new THREE.Group();
    scene.add(this.#pivotsGroup);
    this.#jointsGroup = new THREE.Group();
    scene.add(this.#jointsGroup);
    this.#constraintsGroup = new THREE.Group();
    scene.add(this.#constraintsGroup);
    this.applyVisibility();
  }

  get visible(): OverlayVisibility {
    return { ...this.#visibility };
  }

  setVisible(key: OverlayKey, visible: boolean): void {
    if (this.#visibility[key] === visible) return;
    this.#visibility = { ...this.#visibility, [key]: visible };
    this.applyVisibility();
  }

  toggle(key: OverlayKey): boolean {
    this.setVisible(key, !this.#visibility[key]);
    return this.#visibility[key];
  }

  update(
    store: DocumentStoreRead | undefined,
    selection: readonly SelectionEntry[],
    regionDraft?: RegionDraft,
    transformPreview?: TransformPreview,
  ): void {
    this.#rebuildBounds(store, selection, regionDraft, transformPreview);
    this.#rebuildPivots(store, selection);
    this.#rebuildJoints(store, selection);
    this.#rebuildConstraints(store, selection);
  }

  dispose(): void {
    this.#disposeGroup(this.#grid);
    this.#disposeGroup(this.#axes);
    this.#disposeGroup(this.#boundsGroup);
    this.#disposeGroup(this.#pivotsGroup);
    this.#disposeGroup(this.#jointsGroup);
    this.#disposeGroup(this.#constraintsGroup);
  }

  applyVisibility(): void {
    this.#grid.visible = this.#visibility.grid;
    this.#axes.visible = this.#visibility.axes;
    this.#boundsGroup.visible =
      this.#visibility.bounds &&
      (this.#contentBox !== undefined ||
        this.#selectionBox !== undefined ||
        this.#regionDraftBox !== undefined ||
        this.#transformPreviewBoxes.length > 0);
    this.#pivotsGroup.visible =
      this.#visibility.pivots && this.#pivotsGroup.children.length > 0;
    this.#jointsGroup.visible =
      this.#visibility.joints && this.#jointsGroup.children.length > 0;
    this.#constraintsGroup.visible =
      this.#visibility.constraints &&
      this.#constraintsGroup.children.length > 0;
  }

  #createBox(
    bounds: WorldBounds,
    color: number,
    opacity: number,
  ): BoxProjection {
    const size = new THREE.Vector3(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    );
    const geometry = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(size.x, size.y, size.z),
    );
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: true,
      depthWrite: false,
    });
    const object = new THREE.LineSegments(geometry, material);
    object.position.set(
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    );
    object.renderOrder = 2;
    return { object, material, bounds };
  }

  #disposeBox(box: BoxProjection | undefined): void {
    if (box === undefined) return;
    box.object.removeFromParent();
    box.object.geometry.dispose();
    box.material.dispose();
  }

  #rebuildBounds(
    store: DocumentStoreRead | undefined,
    selection: readonly SelectionEntry[],
    regionDraft?: RegionDraft,
    transformPreview?: TransformPreview,
  ): void {
    const nextContent =
      store === undefined ? undefined : worldContentBounds(store);
    const nextSelection =
      store === undefined || selection.length === 0
        ? undefined
        : this.#selectionBounds(store, selection);
    const nextRegionDraft =
      store === undefined || regionDraft === undefined
        ? undefined
        : volumeLocalWorldBounds(
            store,
            regionDraft.volumeId,
            regionDraft.region,
          );
    const contentChanged =
      this.#contentBox !== undefined &&
      (nextContent === undefined ||
        !sameBounds(this.#contentBox.bounds, nextContent));
    const selectionChanged =
      this.#selectionBox !== undefined &&
      (nextSelection === undefined ||
        !sameBounds(this.#selectionBox.bounds, nextSelection));
    const draftChanged =
      this.#regionDraftBox !== undefined &&
      (nextRegionDraft === undefined ||
        !sameBounds(this.#regionDraftBox.bounds, nextRegionDraft));
    if (contentChanged || this.#contentBox === undefined) {
      this.#disposeBox(this.#contentBox);
      this.#contentBox = undefined;
    }
    if (selectionChanged || this.#selectionBox === undefined) {
      this.#disposeBox(this.#selectionBox);
      this.#selectionBox = undefined;
    }
    if (draftChanged || this.#regionDraftBox === undefined) {
      this.#disposeBox(this.#regionDraftBox);
      this.#regionDraftBox = undefined;
    }
    if (this.#contentBox === undefined && nextContent !== undefined) {
      this.#contentBox = this.#createBox(nextContent, 0x4dc3ff, 0.85);
      this.#boundsGroup.add(this.#contentBox.object);
    }
    if (this.#selectionBox === undefined && nextSelection !== undefined) {
      this.#selectionBox = this.#createBox(nextSelection, 0xffd60a, 0.9);
      this.#boundsGroup.add(this.#selectionBox.object);
    }
    if (this.#regionDraftBox === undefined && nextRegionDraft !== undefined) {
      // Transient region-select preview: a bright wireframe box that
      // exists only while the drag is in progress.
      this.#regionDraftBox = this.#createBox(nextRegionDraft, 0xff9f0a, 0.9);
      this.#boundsGroup.add(this.#regionDraftBox.object);
    }
    this.#rebuildTransformPreviewBoxes(store, transformPreview);
    this.applyVisibility();
  }

  /**
   * Projects the exact per-entry destination bounds of the transform
   * preview (plan S7.19, ticket #19) as magenta wireframe boxes. The
   * boxes are rebuilt only when the preview signature changes; like every
   * other overlay they are runtime projections and never persist.
   */
  #rebuildTransformPreviewBoxes(
    store: DocumentStoreRead | undefined,
    transformPreview: TransformPreview | undefined,
  ): void {
    const signature =
      store === undefined || transformPreview === undefined
        ? undefined
        : `${String(store.revision)}|${transformPreview.entries
            .map(
              (entry) =>
                `${String(entry.volumeId)}:${String(entry.destination.min[0])},${String(entry.destination.min[1])},${String(entry.destination.min[2])}..${String(entry.destination.max[0])},${String(entry.destination.max[1])},${String(entry.destination.max[2])}`,
            )
            .join("|")}`;
    if (signature === this.#transformPreviewSignature) return;
    this.#transformPreviewSignature = signature;
    for (const box of this.#transformPreviewBoxes) {
      this.#disposeBox(box);
    }
    this.#transformPreviewBoxes = [];
    if (transformPreview === undefined || store === undefined) {
      this.applyVisibility();
      return;
    }
    for (const entry of transformPreview.entries) {
      const world = volumeLocalWorldBounds(
        store,
        entry.volumeId,
        entry.destination,
      );
      if (world === undefined) continue;
      const box = this.#createBox(world, TRANSFORM_PREVIEW_COLOR, 0.95);
      this.#transformPreviewBoxes.push(box);
      this.#boundsGroup.add(box.object);
    }
    this.applyVisibility();
  }

  /** Union world bounds of the mixed selection entries (plan S7.2). */
  #selectionBounds(
    store: DocumentStoreRead,
    selection: readonly SelectionEntry[],
  ): WorldBounds | undefined {
    return selectionWorldBounds(store, selection);
  }

  /**
   * Shared marker-group rebuild for the pivot crosses and the joint rings
   * (plan S6.13/S9.8, ticket #26): clear the group, dispose every
   * superseded geometry and material exactly once, then project one
   * marker per selected node that passes `include` at the node's
   * world-space transform pivot.
   */
  #rebuildMarkers(
    group: THREE.Group,
    store: DocumentStoreRead | undefined,
    selection: readonly SelectionEntry[],
    include: (node: SceneNode) => boolean,
    create: (pivot: Vec3) => THREE.Object3D,
  ): void {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse(disposeGeometry);
      child.traverse(disposeMaterials);
    }
    const nodeIds = selection
      .filter((entry) => entry.kind === "node")
      .map((entry) => entry.nodeId);
    if (store === undefined || nodeIds.length === 0) {
      this.applyVisibility();
      return;
    }
    const matrices = nodeWorldMatrices(store);
    const document = store.getDocument();
    for (const nodeId of nodeIds) {
      const node = document.nodes[nodeId];
      const world = matrices.get(nodeId);
      if (node === undefined || world === undefined) continue;
      if (!include(node)) continue;
      const pivot: Vec3 = applyMatrix(world, node.transform.pivot);
      group.add(create(pivot));
    }
    this.applyVisibility();
  }

  #rebuildPivots(
    store: DocumentStoreRead | undefined,
    selection: readonly SelectionEntry[],
  ): void {
    this.#rebuildMarkers(
      this.#pivotsGroup,
      store,
      selection,
      () => true,
      (pivot) => this.#createPivotMarker(pivot),
    );
  }

  /**
   * Rebuilds the joint markers: a violet ring at the world-space pivot of
   * every selected node carrying a joint annotation (plan S9.8, ticket
   * #26). Like every overlay these are runtime projections, rebuilt
   * wholesale and disposed exactly once.
   */
  #rebuildJoints(
    store: DocumentStoreRead | undefined,
    selection: readonly SelectionEntry[],
  ): void {
    this.#rebuildMarkers(
      this.#jointsGroup,
      store,
      selection,
      (node) => node.components.some((component) => component.kind === "joint"),
      (pivot) => this.#createJointMarker(pivot),
    );
  }

  #createJointMarker(pivot: Vec3): THREE.LineLoop {
    const points: THREE.Vector3[] = [];
    const segments = 24;
    for (let index = 0; index < segments; index += 1) {
      const angle = (index / segments) * Math.PI * 2;
      points.push(
        new THREE.Vector3(
          Math.cos(angle) * JOINT_MARKER_RADIUS,
          0,
          Math.sin(angle) * JOINT_MARKER_RADIUS,
        ),
      );
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: 0xbf5af2,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    const ring = new THREE.LineLoop(geometry, material);
    ring.position.set(pivot[0], pivot[1], pivot[2]);
    ring.renderOrder = 3;
    return ring;
  }

  /**
   * Rebuilds the constraint arcs: for every selected node carrying a
   * constraint component, one arc per descriptor per axis sweeping the
   * allowed local Euler range (plan S9.7, ticket #27). Arcs are drawn in
   * the axis colors at the world-space transform pivot, projected through
   * the constrained world matrices (the same runtime result the scene
   * renders), and rebuilt/disposed wholesale like every other overlay.
   */
  #rebuildConstraints(
    store: DocumentStoreRead | undefined,
    selection: readonly SelectionEntry[],
  ): void {
    for (const child of [...this.#constraintsGroup.children]) {
      this.#constraintsGroup.remove(child);
      child.traverse(disposeGeometry);
      child.traverse(disposeMaterials);
    }
    const nodeIds = selection
      .filter((entry) => entry.kind === "node")
      .map((entry) => entry.nodeId);
    if (store === undefined || nodeIds.length === 0) {
      this.applyVisibility();
      return;
    }
    const matrices = nodeWorldMatrices(store);
    const document = store.getDocument();
    for (const nodeId of nodeIds) {
      const node = document.nodes[nodeId];
      const world = matrices.get(nodeId);
      if (node === undefined || world === undefined) continue;
      for (const component of node.components) {
        if (component.kind !== "constraint") continue;
        for (const constraint of component.constraints) {
          // Version 1 constraints are always local rotation limits
          // (ADR-0006); future kinds extend this overlay deliberately.
          for (const axis of [0, 1, 2] as const) {
            this.#constraintsGroup.add(
              this.#createConstraintArc(
                world,
                node.transform.pivot,
                axis,
                constraint.limits.min[axis],
                constraint.limits.max[axis],
              ),
            );
          }
        }
      }
    }
    this.applyVisibility();
  }

  /**
   * One per-axis rotation-limit arc: a polyline in the node's local frame
   * around its pivot (X rotation sweeps the YZ plane, Y sweeps ZX, Z
   * sweeps XY), transformed into world space by the constrained world
   * matrix. A limit spanning a full revolution draws a complete ring.
   */
  #createConstraintArc(
    world: Mat4,
    pivot: Vec3,
    axis: 0 | 1 | 2,
    minAngle: number,
    maxAngle: number,
  ): THREE.Line {
    const span = maxAngle - minAngle;
    const fullCircle = span >= 2 * Math.PI;
    const segments = fullCircle
      ? CONSTRAINT_ARC_SEGMENTS
      : Math.max(
          4,
          Math.ceil((span / (2 * Math.PI)) * CONSTRAINT_ARC_SEGMENTS),
        );
    const points: THREE.Vector3[] = [];
    for (let index = 0; index <= segments; index += 1) {
      const angle = fullCircle
        ? (index / segments) * 2 * Math.PI
        : minAngle + (index / segments) * span;
      const local = constraintArcPoint(pivot, axis, angle);
      const point = applyMatrix(world, local);
      points.push(new THREE.Vector3(point[0], point[1], point[2]));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: AXIS_COLORS[axis],
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    const arc = new THREE.Line(geometry, material);
    arc.renderOrder = 3;
    return arc;
  }

  #createPivotMarker(pivot: Vec3): THREE.Group {
    const group = new THREE.Group();
    group.position.set(pivot[0], pivot[1], pivot[2]);
    const half = PIVOT_MARKER_LENGTH / 2;
    for (const axis of [0, 1, 2] as const) {
      const from = new THREE.Vector3();
      const to = new THREE.Vector3();
      from.setComponent(axis, -half);
      to.setComponent(axis, half);
      const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
      const material = new THREE.LineBasicMaterial({
        color: 0xff9f0a,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      line.renderOrder = 3;
      group.add(line);
    }
    return group;
  }

  #disposeGroup(group: THREE.Object3D): void {
    group.removeFromParent();
    group.traverse(disposeGeometry);
    group.traverse(disposeMaterials);
  }
}

/**
 * One point of a constraint arc in the node's local frame around its
 * pivot: rotation about X sweeps the YZ plane `(0, cos, sin)`, Y sweeps
 * the ZX plane `(sin, 0, cos)`, and Z sweeps the XY plane `(cos, sin, 0)`
 * (right-handed +X right, +Y up, +Z forward).
 */
function constraintArcPoint(pivot: Vec3, axis: 0 | 1 | 2, angle: number): Vec3 {
  const cos = Math.cos(angle) * CONSTRAINT_MARKER_RADIUS;
  const sin = Math.sin(angle) * CONSTRAINT_MARKER_RADIUS;
  switch (axis) {
    case 0:
      return [pivot[0], pivot[1] + cos, pivot[2] + sin];
    case 1:
      return [pivot[0] + sin, pivot[1], pivot[2] + cos];
    case 2:
      return [pivot[0] + cos, pivot[1] + sin, pivot[2]];
  }
}

/** Disposes an object's geometry when it has one (typed via the interface). */
const disposeGeometry = (object: THREE.Object3D): void => {
  if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
    (object as { geometry: THREE.BufferGeometry }).geometry.dispose();
  }
};

/**
 * Disposes every material attached to an object. Overlays are rebuilt
 * wholesale on each update, so every superseded resource must be released
 * exactly once (ARCHITECTURE.md renderer rule, overlays-v1.md policy 4).
 */
const disposeMaterials = (object: THREE.Object3D): void => {
  const material = (object as { material?: THREE.Material | THREE.Material[] })
    .material;
  if (material === undefined) return;
  for (const entry of Array.isArray(material) ? material : [material]) {
    entry.dispose();
  }
};

const sameBounds = (a: WorldBounds, b: WorldBounds): boolean =>
  a.min[0] === b.min[0] &&
  a.min[1] === b.min[1] &&
  a.min[2] === b.min[2] &&
  a.max[0] === b.max[0] &&
  a.max[1] === b.max[1] &&
  a.max[2] === b.max[2];

/** Creates the overlay manager for one scene. */
export function createOverlayManager(scene: THREE.Scene): OverlayManager {
  return new OverlayManagerImpl(scene);
}
