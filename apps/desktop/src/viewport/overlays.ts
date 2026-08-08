import * as THREE from "three";
import { applyMatrix, type Vec3 } from "@voxel-maker/math";
import type { NodeId } from "@voxel-maker/shared";
import type { DocumentStoreRead } from "@voxel-maker/document";
import {
  nodeWorldMatrices,
  worldBoundsForNodes,
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
 */

export type OverlayKey = "grid" | "axes" | "bounds" | "pivots";

export type OverlayVisibility = Readonly<Record<OverlayKey, boolean>>;

/** Default visibility: every overlay on. */
export const DEFAULT_OVERLAY_VISIBILITY: OverlayVisibility = {
  grid: true,
  axes: true,
  bounds: true,
  pivots: true,
};

const GRID_SIZE = 100;
const GRID_DIVISIONS = 100;
const AXIS_LENGTH = 10;
const PIVOT_MARKER_LENGTH = 0.5;

const AXIS_COLORS: readonly [number, number, number] = [
  0xff3b30, 0x34c759, 0x007aff,
];

export interface OverlayManager {
  readonly visible: OverlayVisibility;
  setVisible(key: OverlayKey, visible: boolean): void;
  /** Toggles one overlay; returns the new visibility. */
  toggle(key: OverlayKey): boolean;
  /**
   * Rebuilds the document-dependent overlays from the current store and
   * selection. Pass `undefined` when no document is open.
   */
  update(
    store: DocumentStoreRead | undefined,
    selection: readonly NodeId[],
  ): void;
  /** Removes every overlay object from the scene and releases resources. */
  dispose(): void;
}

interface BoxProjection {
  readonly object: THREE.LineSegments;
  readonly material: THREE.LineBasicMaterial;
  readonly bounds: WorldBounds;
}

class OverlayManagerImpl implements OverlayManager {
  readonly #grid: THREE.GridHelper;
  readonly #axes: THREE.Group;
  readonly #boundsGroup: THREE.Group;
  readonly #pivotsGroup: THREE.Group;
  #contentBox: BoxProjection | undefined;
  #selectionBox: BoxProjection | undefined;
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
    selection: readonly NodeId[],
  ): void {
    this.#rebuildBounds(store, selection);
    this.#rebuildPivots(store, selection);
  }

  dispose(): void {
    this.#disposeGroup(this.#grid);
    this.#disposeGroup(this.#axes);
    this.#disposeGroup(this.#boundsGroup);
    this.#disposeGroup(this.#pivotsGroup);
  }

  applyVisibility(): void {
    this.#grid.visible = this.#visibility.grid;
    this.#axes.visible = this.#visibility.axes;
    this.#boundsGroup.visible =
      this.#visibility.bounds &&
      (this.#contentBox !== undefined || this.#selectionBox !== undefined);
    this.#pivotsGroup.visible =
      this.#visibility.pivots && this.#pivotsGroup.children.length > 0;
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
    selection: readonly NodeId[],
  ): void {
    const nextContent =
      store === undefined ? undefined : worldContentBounds(store);
    const nextSelection =
      store === undefined || selection.length === 0
        ? undefined
        : worldBoundsForNodes(store, selection);
    const contentChanged =
      this.#contentBox !== undefined &&
      (nextContent === undefined ||
        !sameBounds(this.#contentBox.bounds, nextContent));
    const selectionChanged =
      this.#selectionBox !== undefined &&
      (nextSelection === undefined ||
        !sameBounds(this.#selectionBox.bounds, nextSelection));
    if (contentChanged || this.#contentBox === undefined) {
      this.#disposeBox(this.#contentBox);
      this.#contentBox = undefined;
    }
    if (selectionChanged || this.#selectionBox === undefined) {
      this.#disposeBox(this.#selectionBox);
      this.#selectionBox = undefined;
    }
    if (this.#contentBox === undefined && nextContent !== undefined) {
      this.#contentBox = this.#createBox(nextContent, 0x4dc3ff, 0.85);
      this.#boundsGroup.add(this.#contentBox.object);
    }
    if (this.#selectionBox === undefined && nextSelection !== undefined) {
      this.#selectionBox = this.#createBox(nextSelection, 0xffd60a, 0.9);
      this.#boundsGroup.add(this.#selectionBox.object);
    }
    this.applyVisibility();
  }

  #rebuildPivots(
    store: DocumentStoreRead | undefined,
    selection: readonly NodeId[],
  ): void {
    for (const child of [...this.#pivotsGroup.children]) {
      this.#pivotsGroup.remove(child);
      child.traverse(disposeGeometry);
      child.traverse(disposeMaterials);
    }
    if (store === undefined || selection.length === 0) {
      this.applyVisibility();
      return;
    }
    const matrices = nodeWorldMatrices(store);
    const document = store.getDocument();
    for (const nodeId of selection) {
      const node = document.nodes[nodeId];
      const world = matrices.get(nodeId);
      if (node === undefined || world === undefined) continue;
      const pivot: Vec3 = applyMatrix(world, node.transform.pivot);
      this.#pivotsGroup.add(this.#createPivotMarker(pivot));
    }
    this.applyVisibility();
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
