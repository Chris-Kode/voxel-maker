import * as THREE from "three";
import {
  commandId,
  transactionId,
  WorkspaceError,
  type CommandId,
} from "@voxel-maker/shared";
import type { Command } from "@voxel-maker/commands";
import type { DocumentStoreRead } from "@voxel-maker/document";
import {
  createStrokeTool,
  type EditorStore,
  type StrokeTool,
  type StrokeToolHost,
  type ToolActionResult,
} from "@voxel-maker/editor";
import type { DocumentSession } from "@voxel-maker/session";
import { MAX_VOXELS_PER_OPERATION } from "@voxel-maker/voxel";
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
 * Viewport controller (plan S6.10-S6.13 ticket #16, S7.3/S7.5 ticket #17):
 * the desktop seam between the DOM viewport and the pure camera/picking/
 * overlay modules plus the pencil/erase stroke tools. The controller owns
 * the camera rig, the overlay manager, and the stroke tools; it follows
 * the document lifecycle and editor selection and converts pointer/NDC
 * input into deterministic picks over the authoritative store. It never
 * mutates semantic state: clicks update runtime `EditorStore` selection,
 * and completed strokes commit exactly one labeled transaction through
 * the session's command bus.
 */

export interface ViewportControllerOptions {
  readonly session: DocumentSession;
  readonly editor: EditorStore;
  readonly scene: THREE.Scene;
  /**
   * Per-stroke voxel budget (ADR-0009, default
   * `MAX_VOXELS_PER_OPERATION`); callers may lower it.
   */
  readonly strokeVoxelLimit?: number;
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
  /** True while a pencil/erase stroke gesture is in progress. */
  readonly strokeActive: boolean;
  /** Routes a primary-button down to the active stroke tool. */
  strokePointerDown(clientX: number, clientY: number): ToolActionResult;
  /** Routes a move to the active stroke tool while a stroke is captured. */
  strokePointerMove(clientX: number, clientY: number): ToolActionResult;
  /** Commits the active stroke as one labeled transaction. */
  strokePointerUp(): ToolActionResult;
  /** Cancels the active stroke; semantic state is untouched. */
  strokePointerCancel(): void;
  /** Pushes the camera state onto the active camera (idempotent). */
  applyCamera(): void;
  dispose(): void;
}

class ViewportControllerImpl implements ViewportController {
  readonly #session: DocumentSession;
  readonly #editor: EditorStore;
  readonly #rig: CameraRig;
  readonly #overlays: OverlayManager;
  readonly #pencil: StrokeTool;
  readonly #erase: StrokeTool;
  #unsubscribeSession: () => void;
  #unsubscribeEditor: () => void;
  #unsubscribeStore: (() => void) | undefined;
  #strokeCommandSequence = 0;
  #strokeTransactionSequence = 0;
  /** The tool that started the in-progress gesture (pinned until it ends). */
  #strokeTool: StrokeTool | undefined;

  constructor(options: ViewportControllerOptions) {
    this.#session = options.session;
    this.#editor = options.editor;
    this.#rig = createCameraRig();
    this.#overlays = createOverlayManager(options.scene);
    this.#pencil = createStrokeTool({
      kind: "pencil",
      host: this.#makeStrokeHost(options.strokeVoxelLimit),
      editor: this.#editor,
    });
    this.#erase = createStrokeTool({
      kind: "erase",
      host: this.#makeStrokeHost(options.strokeVoxelLimit),
      editor: this.#editor,
    });

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
      // Lifecycle replacement ends any in-progress gesture; a stroke must
      // never straddle two documents (cancel = exact pre-gesture state).
      this.#pencil.reset();
      this.#erase.reset();
      this.#strokeTool = undefined;
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

  get strokeActive(): boolean {
    return this.#strokeTool?.active ?? false;
  }

  strokePointerDown(clientX: number, clientY: number): ToolActionResult {
    const tool = this.#activeStrokeTool();
    if (tool === undefined) return { ok: true };
    const result = tool.pointerDown(clientX, clientY);
    // Pin the starting tool for the whole gesture: a tool switch mid-
    // stroke must not leak the draft or let a later up commit a stale
    // stroke through a different tool.
    if (result.ok && tool.active) this.#strokeTool = tool;
    if (result.ok && !tool.active && this.#documentHasNoVoxels()) {
      // A stroke can only start on a picked voxel; on a voxel-less
      // document the gesture is a silent no-op, so say so once per click.
      this.#editor.pushNotice(
        "info",
        "The document has no voxels yet: open a sample or add a shape before drawing",
      );
    }
    return this.#report(result);
  }

  strokePointerMove(clientX: number, clientY: number): ToolActionResult {
    // Route the whole gesture to the tool that started it, never to the
    // current tool (which may have changed since pointer down).
    const tool = this.#strokeTool ?? this.#activeStrokeTool();
    if (tool === undefined) return { ok: true };
    return this.#report(tool.pointerMove(clientX, clientY));
  }

  strokePointerUp(): ToolActionResult {
    const tool = this.#strokeTool ?? this.#activeStrokeTool();
    this.#strokeTool = undefined;
    if (tool === undefined) return { ok: true };
    return this.#report(tool.pointerUp());
  }

  strokePointerCancel(): void {
    const tool = this.#strokeTool ?? this.#activeStrokeTool();
    this.#strokeTool = undefined;
    if (tool !== undefined) tool.pointerCancel();
  }

  applyCamera(): void {
    this.#rig.apply();
  }

  dispose(): void {
    this.#unsubscribeSession();
    this.#unsubscribeEditor();
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = undefined;
    this.#pencil.reset();
    this.#erase.reset();
    this.#strokeTool = undefined;
    this.#overlays.dispose();
    this.#rig.dispose();
  }

  /** True when every volume of the open document is empty. */
  #documentHasNoVoxels(): boolean {
    const store = this.#session.current?.store;
    if (store === undefined) return true;
    const document = store.getDocument();
    for (const descriptor of Object.values(document.volumes)) {
      const view = store.getVolume(descriptor.volumeId);
      if (view !== undefined && view.occupiedCount() > 0) return false;
    }
    return true;
  }

  /** Surfaces a failed tool action as a runtime notice. */
  #report(result: ToolActionResult): ToolActionResult {
    if (!result.ok) {
      this.#editor.pushNotice("error", result.error.message);
    }
    return result;
  }

  #activeStrokeTool(): StrokeTool | undefined {
    const tool = this.#editor.activeTool;
    if (tool === "pencil") return this.#pencil;
    if (tool === "erase") return this.#erase;
    return undefined;
  }

  /** Host services that keep the stroke tools headless and deterministic. */
  #makeStrokeHost(strokeVoxelLimit?: number): StrokeToolHost {
    // The session object is stable for the composition's lifetime; only
    // `session.current` changes, so the getter stays live without
    // aliasing `this`.
    const session = this.#session;
    return {
      get store() {
        return session.current?.store;
      },
      maxStrokeVoxels: strokeVoxelLimit ?? MAX_VOXELS_PER_OPERATION,
      pick: (clientX, clientY) => {
        const hit = this.pick(clientX, clientY);
        if (hit === undefined) return undefined;
        return { volumeId: hit.volumeId, voxel: hit.voxel };
      },
      nextCommandId: (): CommandId => {
        this.#strokeCommandSequence += 1;
        return commandId(
          `command:stroke:${String(this.#strokeCommandSequence)}`,
        );
      },
      commit: (commands: readonly Command[], label: string) => {
        const current = this.#session.current;
        if (current === undefined) {
          return new WorkspaceError({
            family: "conflict",
            code: "SESSION_NOT_OPEN",
            message: "No document is open",
          });
        }
        this.#strokeTransactionSequence += 1;
        const result = current.bus.executeTransaction(commands, {
          transactionId: transactionId(
            `transaction:stroke:${String(this.#strokeTransactionSequence)}`,
          ),
          expectedRevision: current.store.revision,
          source: "ui",
          label,
        });
        return result.ok ? undefined : result.error;
      },
    };
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
