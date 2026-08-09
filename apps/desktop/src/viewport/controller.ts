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
  createEyedropperTool,
  createSelectTool,
  createShapeTool,
  createStrokeTool,
  pruneSelection,
  selectionWorldBounds,
  type EditorStore,
  type StrokeTool,
  type Tool,
  type ToolActionResult,
  type ToolHost,
  type ToolModifiers,
} from "@voxel-maker/editor";
import type { DocumentSession } from "@voxel-maker/session";
import { MAX_VOXELS_PER_OPERATION } from "@voxel-maker/voxel";
import {
  pickScene,
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
 * Viewport controller (plan S6.10-S6.13 ticket #16, S7.3-S7.7/S7.19
 * tickets #17/#18): the desktop seam between the DOM viewport and the
 * pure camera/picking/overlay modules plus the headless editor tools
 * (select, pencil, erase, paint, eyedropper, box, sphere, cylinder).
 * The controller owns the camera rig, the overlay manager, and one tool
 * instance per tool id; it follows the document lifecycle and editor
 * selection and converts pointer/NDC input into deterministic picks over
 * the authoritative store. It never mutates semantic state: clicks update
 * runtime `EditorStore` selection, gestures commit exactly one labeled
 * transaction through the session's command bus, and selection
 * references to deleted nodes/volumes are pruned on every committed
 * document event.
 */

export interface ViewportControllerOptions {
  readonly session: DocumentSession;
  readonly editor: EditorStore;
  readonly scene: THREE.Scene;
  /**
   * Per-gesture voxel budget shared by the stroke and shape tools
   * (ADR-0009, default `MAX_VOXELS_PER_OPERATION`); callers may lower it.
   */
  readonly gestureVoxelLimit?: number;
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
  /**
   * Picks and updates the runtime selection (plan S7.2/S7.4): the select
   * tool resolves the click against `EditorStore.selectionMode` and the
   * modifier intent (plain replaces, Shift adds, Ctrl/Cmd toggles; a miss
   * clears on a plain click).
   */
  selectAt(clientX: number, clientY: number, modifiers?: ToolModifiers): void;
  /** Clears the runtime selection (Escape). */
  clearSelection(): void;
  /** True while a tool gesture is in progress. */
  readonly toolActive: boolean;
  /** Routes a primary-button down to the active tool. */
  toolPointerDown(
    clientX: number,
    clientY: number,
    modifiers?: ToolModifiers,
  ): ToolActionResult;
  /** Routes a move to the active tool while a gesture is captured. */
  toolPointerMove(clientX: number, clientY: number): ToolActionResult;
  /** Commits the active gesture as one labeled transaction. */
  toolPointerUp(): ToolActionResult;
  /** Cancels the active gesture; semantic state is untouched. */
  toolPointerCancel(): void;
  /** Pushes the camera state onto the active camera (idempotent). */
  applyCamera(): void;
  dispose(): void;
}

class ViewportControllerImpl implements ViewportController {
  readonly #session: DocumentSession;
  readonly #editor: EditorStore;
  readonly #rig: CameraRig;
  readonly #overlays: OverlayManager;
  readonly #select: ReturnType<typeof createSelectTool>;
  readonly #pencil: StrokeTool;
  readonly #erase: StrokeTool;
  readonly #paint: StrokeTool;
  readonly #eyedropper: ReturnType<typeof createEyedropperTool>;
  readonly #box: ReturnType<typeof createShapeTool>;
  readonly #sphere: ReturnType<typeof createShapeTool>;
  readonly #cylinder: ReturnType<typeof createShapeTool>;
  #unsubscribeSession: () => void;
  #unsubscribeEditor: () => void;
  #unsubscribeStore: (() => void) | undefined;
  #toolCommandSequence = 0;
  #toolTransactionSequence = 0;
  /** The tool that started the in-progress gesture (pinned until it ends). */
  #gestureTool: Tool | undefined;

  constructor(options: ViewportControllerOptions) {
    this.#session = options.session;
    this.#editor = options.editor;
    this.#rig = createCameraRig();
    this.#overlays = createOverlayManager(options.scene);
    const host = this.#makeToolHost(options.gestureVoxelLimit);
    this.#select = createSelectTool({ host, editor: this.#editor });
    this.#pencil = createStrokeTool({
      kind: "pencil",
      host,
      editor: this.#editor,
    });
    this.#erase = createStrokeTool({
      kind: "erase",
      host,
      editor: this.#editor,
    });
    this.#paint = createStrokeTool({
      kind: "paint",
      host,
      editor: this.#editor,
    });
    this.#eyedropper = createEyedropperTool({
      host,
      editor: this.#editor,
    });
    this.#box = createShapeTool({ kind: "box", host, editor: this.#editor });
    this.#sphere = createShapeTool({
      kind: "sphere",
      host,
      editor: this.#editor,
    });
    this.#cylinder = createShapeTool({
      kind: "cylinder",
      host,
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
      // Lifecycle replacement ends any in-progress gesture; a gesture
      // must never straddle two documents (cancel = exact pre-gesture
      // state).
      this.#select.reset();
      this.#pencil.reset();
      this.#erase.reset();
      this.#paint.reset();
      this.#eyedropper.reset();
      this.#box.reset();
      this.#sphere.reset();
      this.#cylinder.reset();
      this.#gestureTool = undefined;
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
    const bounds = this.#selectionBounds() ?? worldContentBounds(store);
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

  selectAt(
    clientX: number,
    clientY: number,
    modifiers: ToolModifiers = { additive: false, toggle: false },
  ): void {
    this.#select.click(clientX, clientY, modifiers);
  }

  clearSelection(): void {
    this.#editor.setSelection([]);
  }

  get toolActive(): boolean {
    return this.#gestureTool?.active ?? false;
  }

  toolPointerDown(
    clientX: number,
    clientY: number,
    modifiers?: ToolModifiers,
  ): ToolActionResult {
    const tool = this.#activeTool();
    if (tool === undefined) return { ok: true };
    const result = tool.pointerDown(clientX, clientY, modifiers);
    // Pin the starting tool for the whole gesture: a tool switch mid-
    // gesture must not leak the draft or let a later up commit a stale
    // gesture through a different tool.
    if (result.ok && tool.active) this.#gestureTool = tool;
    if (
      result.ok &&
      !tool.active &&
      tool.id !== "select" &&
      tool.id !== "eyedropper" &&
      this.#documentHasNoVoxels()
    ) {
      // A stroke/shape can only start on a picked voxel; on a voxel-less
      // document the gesture is a silent no-op, so say so once per click.
      this.#editor.pushNotice(
        "info",
        "The document has no voxels yet: open a sample or add a shape before drawing",
      );
    }
    return this.#report(result);
  }

  toolPointerMove(clientX: number, clientY: number): ToolActionResult {
    // Route the whole gesture to the tool that started it, never to the
    // current tool (which may have changed since pointer down).
    const tool = this.#gestureTool ?? this.#activeTool();
    if (tool === undefined) return { ok: true };
    return this.#report(tool.pointerMove(clientX, clientY));
  }

  toolPointerUp(): ToolActionResult {
    const tool = this.#gestureTool ?? this.#activeTool();
    this.#gestureTool = undefined;
    if (tool === undefined) return { ok: true };
    return this.#report(tool.pointerUp());
  }

  toolPointerCancel(): void {
    const tool = this.#gestureTool ?? this.#activeTool();
    this.#gestureTool = undefined;
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
    this.#select.reset();
    this.#pencil.reset();
    this.#erase.reset();
    this.#paint.reset();
    this.#eyedropper.reset();
    this.#box.reset();
    this.#sphere.reset();
    this.#cylinder.reset();
    this.#gestureTool = undefined;
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

  #activeTool(): Tool | undefined {
    const tool = this.#editor.activeTool;
    switch (tool) {
      case "select":
        return this.#select;
      case "pencil":
        return this.#pencil;
      case "erase":
        return this.#erase;
      case "paint":
        return this.#paint;
      case "eyedropper":
        return this.#eyedropper;
      case "box":
        return this.#box;
      case "sphere":
        return this.#sphere;
      case "cylinder":
        return this.#cylinder;
    }
  }

  /** Host services that keep the tools headless and deterministic. */
  #makeToolHost(gestureVoxelLimit?: number): ToolHost {
    // The session object is stable for the composition's lifetime; only
    // `session.current` changes, so the getter stays live without
    // aliasing `this`.
    const session = this.#session;
    return {
      get store() {
        return session.current?.store;
      },
      maxGestureVoxels: gestureVoxelLimit ?? MAX_VOXELS_PER_OPERATION,
      pick: (clientX, clientY) => {
        const hit = this.pick(clientX, clientY);
        if (hit === undefined) return undefined;
        return {
          nodeId: hit.nodeId,
          volumeId: hit.volumeId,
          voxel: hit.voxel,
        };
      },
      nextCommandId: (): CommandId => {
        this.#toolCommandSequence += 1;
        return commandId(`command:tool:${String(this.#toolCommandSequence)}`);
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
        this.#toolTransactionSequence += 1;
        const result = current.bus.executeTransaction(commands, {
          transactionId: transactionId(
            `transaction:tool:${String(this.#toolTransactionSequence)}`,
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
      // Selection pruning after delete (plan S7.2): every committed
      // document event drops selection entries that reference a deleted
      // node or volume, then the overlays redraw from the pruned state.
      const pruned = pruneSelection(
        this.#editor.selection,
        store.getDocument(),
      );
      if (pruned.length !== this.#editor.selection.length) {
        this.#editor.setSelection(pruned);
      }
      this.#refreshOverlays();
    });
  }

  #refreshOverlays(): void {
    this.#overlays.update(
      this.#session.current?.store,
      this.#editor.selection,
      this.#editor.regionDraft,
    );
  }

  /**
   * Union world bounds of the mixed selection (plan S7.2): node entries
   * use the occupied voxel bounds of their volumes, voxel and region
   * entries transform their volume-local bounds through the owning node's
   * world matrix. Undefined when nothing is selected or nothing is
   * displayable.
   */
  /**
   * Union world bounds of the mixed selection (plan S7.2): node entries
   * use the occupied voxel bounds of their volumes, voxel and region
   * entries transform their volume-local bounds through the owning node's
   * world matrix. Undefined when nothing is selected or nothing is
   * displayable. Shared with the overlay manager (single definition in
   * `@voxel-maker/editor`).
   */
  #selectionBounds():
    | import("@voxel-maker/editor").SelectionWorldBounds
    | undefined {
    const store = this.#session.current?.store;
    if (store === undefined) return undefined;
    return selectionWorldBounds(store, this.#editor.selection);
  }
}

/** Creates the viewport controller for one composition. */
export function createViewportController(
  options: ViewportControllerOptions,
): ViewportController {
  return new ViewportControllerImpl(options);
}
