import { useEffect, useRef } from "react";
import * as THREE from "three";
import type {
  EditorToolId,
  SelectionMode,
  ToolModifiers,
} from "@voxel-maker/editor";
import { DEFAULT_CAMERA_LIMITS } from "./camera.js";
import type { DesktopComposition } from "../composition.js";

/**
 * Three.js viewport (plan S6.1/S6.10-S6.13 ticket #16, S7.3-S7.7/S7.19
 * tickets #17/#18/#19): owns the WebGL renderer and forwards
 * pointer/keyboard input to the composition's viewport controller. All
 * camera, picking, overlay, and tool behavior lives in the controller and
 * its pure modules; this component only binds DOM events and renders.
 *
 * Gestures: with the select tool, left-drag orbits (node/voxel modes) or
 * rubber-bands a region (region mode); right/middle-drag pans; wheel
 * zooms; and a click picks the nearest voxel — a plain click replaces the
 * selection, Shift adds, Ctrl/Cmd toggles, and clicking empty space
 * clears it (region mode uses the full gesture lifecycle, so a click
 * commits the one-voxel region entry; docs/editor/selection-and-shape-
 * tools-v1.md). With the
 * pencil/erase/paint/box/sphere/cylinder tools, a primary-button gesture
 * becomes a stroke or a shape drag: down starts
 * it, moves update the transient preview, up commits one labeled history
 * entry, and a lost pointer cancels it. With the transform tool, a
 * move/copy drag previews the exact destination bounds and commits one
 * labeled transaction; rotate/mirror/delete are button-driven
 * preview-and-apply flows. The eyedropper samples the material under a
 * click. Keys: 1-6 standard views, F focus, P perspective/orthographic
 * toggle, G/X/B/K/J overlay toggles, Escape cancels a gesture or a pending
 * transform preview before clearing the selection. See
 * docs/viewport/overlays-v1.md, docs/editor/stroke-tools-v1.md,
 * docs/editor/selection-and-shape-tools-v1.md, and
 * docs/editor/transform-tools-v1.md.
 */
export function Viewport({
  composition,
  activeTool,
  selectionMode,
}: {
  readonly composition: DesktopComposition;
  /** Current tool selection; routes primary-button gestures to tools. */
  readonly activeTool: EditorToolId;
  /** Select-tool granularity; region mode routes drags to the select tool. */
  readonly selectionMode: SelectionMode;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const diagnosticsRef = useRef<HTMLDivElement | null>(null);
  const controller = composition.viewport;
  // Read the tool and selection mode at event time so switching mid-
  // session never requires rebinding the listeners; the refs are synced
  // in an effect (never during render) per React's latest-value idiom.
  const activeToolRef = useRef(activeTool);
  const selectionModeRef = useRef(selectionMode);
  useEffect(() => {
    activeToolRef.current = activeTool;
    selectionModeRef.current = selectionMode;
  }, [activeTool, selectionMode]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);
    controller.setViewportSize(
      host.clientWidth,
      Math.max(host.clientHeight, 1),
    );

    const resizeObserver = new ResizeObserver(() => {
      const width = host.clientWidth;
      const height = Math.max(host.clientHeight, 1);
      controller.setViewportSize(width, height);
      renderer.setSize(width, height);
    });
    resizeObserver.observe(host);

    // Pointer gesture state: a click is a primary-button press that moves
    // less than a few pixels before release; a tool gesture routes every
    // captured primary-button event to the active tool (stroke, shape
    // drag, or region select); a gizmo gesture routes to the transform
    // gizmo (plan S7.8); everything else orbits or pans.
    type GestureMode = "orbit" | "tool" | "region" | "gizmo";
    /** Tool and region gestures share the tool lifecycle (ticket #48). */
    const isToolGesture = (mode: GestureMode): boolean =>
      mode === "tool" || mode === "region";
    let gesture:
      | {
          readonly mode: GestureMode;
          readonly button: number;
          readonly startX: number;
          readonly startY: number;
          lastX: number;
          lastY: number;
          moved: boolean;
        }
      | undefined;
    const viewportPoint = (event: PointerEvent): [number, number] => {
      const rect = host.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    };

    /** Shift/Ctrl/Cmd intent for selection clicks and region drags. */
    const modifiers = (event: PointerEvent): ToolModifiers => ({
      additive: event.shiftKey,
      toggle: event.ctrlKey || event.metaKey,
    });

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button === 1) event.preventDefault();
      const [x, y] = viewportPoint(event);
      const tool = activeToolRef.current;
      const regionSelect =
        tool === "select" && selectionModeRef.current === "region";
      if (event.button === 0 && tool === "select" && !regionSelect) {
        // The select tool first offers the pointer to the transform
        // gizmo (plan S7.8); when a handle is hit, the drag becomes a
        // coalesced transform gesture.
        if (controller.gizmoPointerDown(x, y)) {
          gesture = {
            mode: "gizmo",
            button: event.button,
            startX: event.clientX,
            startY: event.clientY,
            lastX: event.clientX,
            lastY: event.clientY,
            moved: false,
          };
          host.setPointerCapture(event.pointerId);
          return;
        }
      }
      if (event.button === 0 && (tool !== "select" || regionSelect)) {
        const mode: GestureMode = regionSelect ? "region" : "tool";
        controller.toolPointerDown(x, y, modifiers(event));
        gesture = {
          mode,
          button: event.button,
          startX: event.clientX,
          startY: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          moved: false,
        };
      } else {
        gesture = {
          mode: "orbit",
          button: event.button,
          startX: event.clientX,
          startY: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          moved: false,
        };
      }
      host.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (gesture === undefined) return;
      if (gesture.mode === "gizmo") {
        const [x, y] = viewportPoint(event);
        controller.gizmoPointerMove(x, y);
        return;
      }
      // Tool and region gestures both route through the active tool's
      // lifecycle: the region drag previews and commits through the
      // select tool (ticket #48), exactly like stroke/shape gestures.
      if (isToolGesture(gesture.mode)) {
        const [x, y] = viewportPoint(event);
        controller.toolPointerMove(x, y);
        return;
      }
      const deltaX = event.clientX - gesture.lastX;
      const deltaY = event.clientY - gesture.lastY;
      if (
        Math.abs(event.clientX - gesture.startX) +
          Math.abs(event.clientY - gesture.startY) >
        4
      ) {
        gesture.moved = true;
      }
      if (gesture.button === 0) {
        controller.orbit(deltaX, deltaY);
      } else {
        controller.pan(deltaX, deltaY);
      }
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (gesture === undefined) return;
      if (gesture.mode === "gizmo") {
        controller.gizmoPointerUp();
      } else if (isToolGesture(gesture.mode)) {
        // A region release commits the region entry through the select
        // tool (a plain click selects the one-voxel region), instead of
        // falling through to the click-style voxel select (ticket #48).
        controller.toolPointerUp();
      } else if (gesture.button === 0 && !gesture.moved) {
        const [x, y] = viewportPoint(event);
        controller.selectAt(x, y, modifiers(event));
      }
      gesture = undefined;
      if (host.hasPointerCapture(event.pointerId)) {
        host.releasePointerCapture(event.pointerId);
      }
    };

    const onPointerCancel = (): void => {
      if (gesture === undefined) return;
      if (gesture.mode === "gizmo") {
        controller.gizmoPointerCancel();
      } else if (isToolGesture(gesture.mode)) {
        // A lost pointer cancels the region drag exactly like any other
        // tool gesture: no draft survives and no selection changes
        // (ticket #48).
        controller.toolPointerCancel();
      }
      gesture = undefined;
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      controller.zoomBy(
        Math.pow(DEFAULT_CAMERA_LIMITS.zoomFactor, -event.deltaY / 100),
      );
    };

    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };

    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointercancel", onPointerCancel);
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("contextmenu", onContextMenu);

    const isEditableTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return;
      let handled = true;
      switch (event.key) {
        case "1":
          controller.setStandardView("front");
          break;
        case "2":
          controller.setStandardView("back");
          break;
        case "3":
          controller.setStandardView("left");
          break;
        case "4":
          controller.setStandardView("right");
          break;
        case "5":
          controller.setStandardView("top");
          break;
        case "6":
          controller.setStandardView("bottom");
          break;
        case "f":
        case "F":
          controller.focus();
          break;
        case "p":
        case "P":
          controller.toggleMode();
          break;
        case "g":
        case "G":
          controller.toggleOverlay("grid");
          break;
        case "x":
        case "X":
          controller.toggleOverlay("axes");
          break;
        case "b":
        case "B":
          controller.toggleOverlay("bounds");
          break;
        case "k":
        case "K":
          controller.toggleOverlay("pivots");
          break;
        case "j":
        case "J":
          controller.toggleOverlay("joints");
          break;
        case "Escape":
          // Cancel any in-progress gesture (gizmo drag, region drag,
          // stroke, shape, transform drag) first, so a late pointer-up
          // cannot commit it; then cancel a pending transform preview
          // (rotate/mirror/delete) without touching the selection; only
          // a bare Escape clears the selection.
          if (controller.transformTool.active) controller.gizmoPointerCancel();
          if (controller.toolActive) controller.toolPointerCancel();
          else if (controller.transformApplyPending)
            controller.transformCancel();
          else controller.clearSelection();
          break;
        default:
          handled = false;
      }
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);

    // Dev-mode diagnostics overlay (plan S6.14, ticket #23): FPS, draw
    // calls, triangles, meshing queues/times, and memory estimates are
    // written straight into the overlay DOM each frame (never through
    // React state, which would re-render every frame).
    let frame = 0;
    let lastFrameTime = performance.now();
    let frameSamples = 0;
    let frameMsTotal = 0;
    const updateDiagnostics = (now: number): void => {
      const overlay = diagnosticsRef.current;
      if (overlay === null) return;
      frameSamples += 1;
      frameMsTotal += now - lastFrameTime;
      lastFrameTime = now;
      let fps = 0;
      if (frameSamples >= 30) {
        fps = Math.round(1000 / (frameMsTotal / frameSamples));
        frameSamples = 0;
        frameMsTotal = 0;
      }
      const diagnostics = composition.renderer.diagnostics();
      overlay.textContent =
        `${fps > 0 ? `${String(fps)} fps` : "fps"} · ` +
        `${String(renderer.info.render.calls)} draws · ` +
        `${String(renderer.info.render.triangles)} tris · ` +
        `queue ${String(diagnostics.pendingChunks)} ` +
        `(in-flight ${String(diagnostics.inFlightMeshes)}) · ` +
        `mesh ${diagnostics.lastMeshMs.toFixed(1)} ms · ` +
        `${(diagnostics.meshBytes / (1024 * 1024)).toFixed(1)} MiB meshes`;
    };
    const animate = (): void => {
      frame = requestAnimationFrame(animate);
      controller.applyCamera();
      // Per-frame meshing step: dispatch and install within the frame
      // budgets, visible chunks first (plan S6.8, ticket #23).
      composition.renderer.flush(controller.camera);
      renderer.render(composition.renderer.scene, controller.camera);
      if (import.meta.env.DEV) updateDiagnostics(performance.now());
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerCancel);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("contextmenu", onContextMenu);
      resizeObserver.disconnect();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, [composition, controller]);

  return (
    <div
      ref={hostRef}
      className="viewport"
      role="img"
      aria-label="3D viewport showing the open voxel document"
    >
      {import.meta.env.DEV ? (
        <div
          ref={diagnosticsRef}
          className="viewport-diagnostics"
          aria-hidden="true"
        />
      ) : null}
      <div className="viewport-hint" aria-hidden="true">
        Select: left-drag orbit · right-drag pan · wheel zoom · click select
        (Shift add · Ctrl toggle · Esc clear) · Pencil/Erase/Paint: drag to
        stroke · Box/Sphere/Cylinder: drag a shape · Transform: drag to move/
        copy, preview rotate/mirror/delete · Eyedropper: sample · 1-6 views · F
        focus · P mode · G/X/B/K/J overlays
      </div>
    </div>
  );
}
