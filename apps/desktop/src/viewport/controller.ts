import * as THREE from "three";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { EditorStore } from "@voxel-maker/editor";
import type { DocumentSession } from "@voxel-maker/session";
import {
  pickScene,
  worldBoundsForNodes,
  worldContentBounds,
  type VoxelPickHit,
} from "@voxel-maker/renderer";
import {
  createCameraRig,
  type CameraRig,
  type CameraState,
  type StandardViewId,
} from "./camera.js";
import {
  createOverlayManager,
  type OverlayKey,
  type OverlayManager,
} from "./overlays.js";

/**
 * Viewport controller (plan S6.10-S6.13, ticket #16): the desktop seam
 * between the DOM viewport and the pure camera/picking/overlay modules.
 * The controller owns the camera rig and the overlay manager, follows the
 * document lifecycle and editor selection, and converts pointer/NDC input
 * into deterministic picks over the authoritative store. It never mutates
 * semantic state: clicking only updates runtime `EditorStore` selection.
 */

export interface ViewportControllerOptions {
  readonly session: DocumentSession;
  readonly editor: EditorStore;
  readonly scene: THREE.Scene;
}

export interface ViewportController {
  /** The active camera (perspective or orthographic). */
  readonly camera: THREE.Camera;
  readonly cameraState: CameraState;
  readonly overlays: OverlayManager;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  setViewportSize(width: number, height: number): void;
  orbit(deltaX: number, deltaY: number): void;
  pan(deltaX: number, deltaY: number): void;
  zoomBy(factor: number): void;
  toggleMode(): void;
  setStandardView(view: StandardViewId): void;
  /** Frames the selection, or the whole content when nothing is selected. */
  focus(): void;
  setOverlay(key: OverlayKey, visible: boolean): void;
  toggleOverlay(key: OverlayKey): boolean;
  /**
   * Deterministically picks the nearest voxel under a viewport point
   * (plan S6.12, ADR-0005); `clientX/clientY` are relative to the
   * viewport's top-left corner.
   */
  pick(clientX: number, clientY: number): VoxelPickHit | undefined;
  /** Picks and updates the runtime node selection (empty on a miss). */
  selectAt(clientX: number, clientY: number): void;
  /** Pushes the camera state onto the active camera (idempotent). */
  applyCamera(): void;
  dispose(): void;
}

class ViewportControllerImpl implements ViewportController {
  readonly #session: DocumentSession;
  readonly #editor: EditorStore;
  readonly #rig: CameraRig;
  readonly #overlays: OverlayManager;
  #unsubscribeSession: () => void;
  #unsubscribeEditor: () => void;
  #unsubscribeStore: (() => void) | undefined;

  constructor(options: ViewportControllerOptions) {
    this.#session = options.session;
    this.#editor = options.editor;
    this.#rig = createCameraRig();
    this.#overlays = createOverlayManager(options.scene);

    this.#unsubscribeEditor = this.#editor.subscribe(() => {
      this.#refreshOverlays();
    });

    this.#unsubscribeSession = this.#session.subscribe((event) => {
      if (
        event.kind === "document-opened" ||
        event.kind === "document-replaced"
      ) {
        this.#subscribeStore(event.store);
        this.#refreshOverlays();
        // Frame the newly opened content so the user sees what they opened.
        this.focus();
      } else {
        this.#unsubscribeStore?.();
        this.#unsubscribeStore = undefined;
        this.#refreshOverlays();
      }
    });
  }

  get camera(): THREE.Camera {
    return this.#rig.camera;
  }

  get cameraState(): CameraState {
    return this.#rig.state;
  }

  get overlays(): OverlayManager {
    return this.#overlays;
  }

  get viewportWidth(): number {
    return this.#rig.viewportWidth;
  }

  get viewportHeight(): number {
    return this.#rig.viewportHeight;
  }

  setViewportSize(width: number, height: number): void {
    this.#rig.setViewportSize(width, height);
  }

  orbit(deltaX: number, deltaY: number): void {
    this.#rig.orbit(deltaX, deltaY);
  }

  pan(deltaX: number, deltaY: number): void {
    this.#rig.pan(deltaX, deltaY);
  }

  zoomBy(factor: number): void {
    this.#rig.zoomBy(factor);
  }

  toggleMode(): void {
    this.#rig.toggleMode();
  }

  setStandardView(view: StandardViewId): void {
    this.#rig.setStandardView(view);
  }

  focus(): void {
    const store = this.#session.current?.store;
    if (store === undefined) return;
    const bounds =
      worldBoundsForNodes(store, this.#editor.selection) ??
      worldContentBounds(store);
    if (bounds !== undefined) this.#rig.focus(bounds);
  }

  setOverlay(key: OverlayKey, visible: boolean): void {
    this.#overlays.setVisible(key, visible);
  }

  toggleOverlay(key: OverlayKey): boolean {
    return this.#overlays.toggle(key);
  }

  pick(clientX: number, clientY: number): VoxelPickHit | undefined {
    const store = this.#session.current?.store;
    if (
      store === undefined ||
      this.viewportWidth <= 0 ||
      this.viewportHeight <= 0
    ) {
      return undefined;
    }
    const ndcX = (clientX / this.viewportWidth) * 2 - 1;
    const ndcY = 1 - (clientY / this.viewportHeight) * 2;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.#rig.camera);
    return pickScene(store, {
      origin: [
        raycaster.ray.origin.x,
        raycaster.ray.origin.y,
        raycaster.ray.origin.z,
      ],
      direction: [
        raycaster.ray.direction.x,
        raycaster.ray.direction.y,
        raycaster.ray.direction.z,
      ],
    });
  }

  selectAt(clientX: number, clientY: number): void {
    const hit = this.pick(clientX, clientY);
    this.#editor.setSelection(hit === undefined ? [] : [hit.nodeId]);
  }

  applyCamera(): void {
    this.#rig.apply();
  }

  dispose(): void {
    this.#unsubscribeSession();
    this.#unsubscribeEditor();
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = undefined;
    this.#overlays.dispose();
    this.#rig.dispose();
  }

  #subscribeStore(store: DocumentStoreRead): void {
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = store.subscribe(() => {
      this.#refreshOverlays();
    });
  }

  #refreshOverlays(): void {
    this.#overlays.update(this.#session.current?.store, this.#editor.selection);
  }
}

/** Creates the viewport controller for one composition. */
export function createViewportController(
  options: ViewportControllerOptions,
): ViewportController {
  return new ViewportControllerImpl(options);
}
