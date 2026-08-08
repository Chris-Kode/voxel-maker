import { useEffect, useRef } from "react";
import * as THREE from "three";
import { DEFAULT_CAMERA_LIMITS } from "./camera.js";
import type { DesktopComposition } from "../composition.js";

/**
 * Three.js viewport (plan S6.1/S6.10-S6.13, ticket #16): owns the WebGL
 * renderer and forwards pointer/keyboard input to the composition's
 * viewport controller. All camera, picking, and overlay behavior lives in
 * the controller and its pure modules; this component only binds DOM
 * events and renders.
 *
 * Gestures: left-drag orbits, right/middle-drag pans, wheel zooms, and a
 * click picks the nearest voxel (selecting its node). Keys: 1-6 standard
 * views, F focus, P perspective/orthographic toggle, G/X/B/K overlay
 * toggles. See docs/viewport/overlays-v1.md.
 */
export function Viewport({
  composition,
}: {
  readonly composition: DesktopComposition;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controller = composition.viewport;

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
    // less than a few pixels before release.
    let gesture:
      | {
          readonly button: number;
          readonly startX: number;
          readonly startY: number;
          lastX: number;
          lastY: number;
          moved: boolean;
        }
      | undefined;

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button === 1) event.preventDefault();
      gesture = {
        button: event.button,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
      };
      host.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (gesture === undefined) return;
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
      if (gesture.button === 0 && !gesture.moved) {
        const rect = host.getBoundingClientRect();
        controller.selectAt(
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
      }
      gesture = undefined;
      if (host.hasPointerCapture(event.pointerId)) {
        host.releasePointerCapture(event.pointerId);
      }
    };

    const onPointerCancel = (): void => {
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
        default:
          handled = false;
      }
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);

    let frame = 0;
    const animate = (): void => {
      frame = requestAnimationFrame(animate);
      controller.applyCamera();
      renderer.render(composition.renderer.scene, controller.camera);
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
      <div className="viewport-hint" aria-hidden="true">
        Left-drag orbit · right-drag pan · wheel zoom · click select · 1-6 views
        · F focus · P mode · G/X/B/K overlays
      </div>
    </div>
  );
}
