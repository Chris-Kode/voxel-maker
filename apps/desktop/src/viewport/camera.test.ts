import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  DEFAULT_CAMERA_LIMITS,
  applyCameraTo,
  cameraPosition,
  cameraUpVector,
  createCameraRig,
  createCameraState,
  focusCamera,
  orbitCamera,
  panCamera,
  setStandardView,
  switchCameraMode,
  zoomCamera,
  type CameraLimits,
  type CameraState,
} from "./camera.js";

/**
 * Camera controller tests (plan S6.10/S6.11, ticket #16). All assertions
 * use fixed states and exact arithmetic; no DOM or GPU input is involved.
 * Gesture directions mirror the OrbitControls behavior the shell shipped
 * with: drag right orbits the camera left, drag down orbits it up, and
 * panning moves the content with the cursor.
 */

const limits: CameraLimits = DEFAULT_CAMERA_LIMITS;

const frontView = (): CameraState =>
  setStandardView(createCameraState(), "front");

describe("camera state machine", () => {
  it("defaults to a perspective camera at (24,20,24) looking at the origin", () => {
    const state = createCameraState();
    expect(state.mode).toBe("perspective");
    expect(state.target).toEqual([0, 0, 0]);
    expect(state.distance).toBeCloseTo(Math.hypot(24, 20, 24), 9);
    const position = cameraPosition(state);
    expect(position[0]).toBeCloseTo(24, 9);
    expect(position[1]).toBeCloseTo(20, 9);
    expect(position[2]).toBeCloseTo(24, 9);
  });

  it("orbits the camera left when dragging right (yaw around up)", () => {
    const initial = frontView();
    const state = orbitCamera(initial, 10, 0, limits);
    expect(state.direction[0]).toBeLessThan(0);
    expect(state.direction[2]).toBeGreaterThan(0);
    expect(state.target).toEqual([0, 0, 0]);
    expect(state.distance).toBeCloseTo(initial.distance, 9);
  });

  it("orbits the camera up when dragging down (pitch)", () => {
    const state = orbitCamera(frontView(), 0, 10, limits);
    expect(state.direction[1]).toBeGreaterThan(0);
    expect(state.direction[2]).toBeGreaterThan(0);
  });

  it("clamps the polar angle so the camera never crosses the poles", () => {
    const state = orbitCamera(frontView(), 0, 1e6, limits);
    const polar = Math.acos(Math.min(1, Math.max(-1, -state.direction[1])));
    expect(polar).toBeGreaterThanOrEqual(limits.minPolarAngle - 1e-9);
    expect(polar).toBeLessThanOrEqual(Math.PI - limits.minPolarAngle + 1e-9);
  });

  it("orbits off the pole from the top view without degenerating", () => {
    const top = setStandardView(createCameraState(), "top");
    const state = orbitCamera(top, 0, -5, limits);
    expect(Math.abs(state.direction[1])).toBeLessThan(1);
    expect(cameraPosition(state)).toBeDefined();
  });

  it("pans the content with the cursor, scaled by distance and height", () => {
    const initial = frontView();
    const state = panCamera(initial, 10, 0, 600, limits);
    // Drag right moves the target left; the world rate is
    // 2*distance*tan(fov/2)/height per pixel.
    const unitsPerPixel =
      (2 * initial.distance * Math.tan(initial.fovY / 2)) / 600;
    expect(state.target[0]).toBeCloseTo(-10 * unitsPerPixel, 9);
    expect(state.target[1]).toBe(0);
    const down = panCamera(initial, 0, 10, 600, limits);
    expect(down.target[1]).toBeCloseTo(10 * unitsPerPixel, 9);
  });

  it("zooms by shrinking the distance in perspective mode", () => {
    const initial = frontView();
    const state = zoomCamera(initial, 1.1, limits);
    expect(state.distance).toBeCloseTo(initial.distance / 1.1, 9);
    const clamped = zoomCamera(initial, 1e9, limits);
    expect(clamped.distance).toBe(limits.minDistance);
  });

  it("zooms by scaling the zoom factor in orthographic mode", () => {
    const ortho = switchCameraMode(frontView());
    const state = zoomCamera(ortho, 2, limits);
    expect(state.zoom).toBe(2);
    const clamped = zoomCamera(ortho, 1e9, limits);
    expect(clamped.zoom).toBe(limits.maxZoom);
  });

  it("switches projection mode while preserving target, distance, and zoom", () => {
    const perspective = {
      ...frontView(),
      distance: 42,
    };
    const ortho = switchCameraMode(perspective);
    expect(ortho.mode).toBe("orthographic");
    expect(ortho.target).toEqual(perspective.target);
    expect(ortho.distance).toBe(42);
    expect(ortho.zoom).toBe(1);
    expect(switchCameraMode(ortho).mode).toBe("perspective");
  });

  it("points each standard view along its axis with the +Z convention", () => {
    const cases: Record<string, [number, number, number]> = {
      front: [0, 0, 1],
      back: [0, 0, -1],
      left: [-1, 0, 0],
      right: [1, 0, 0],
      top: [0, 1, 0],
      bottom: [0, -1, 0],
    };
    const entries = Object.entries(cases) as [
      "front" | "back" | "left" | "right" | "top" | "bottom",
      [number, number, number],
    ][];
    for (const [view, expected] of entries) {
      const state = setStandardView(createCameraState(), view);
      expect(state.direction).toEqual(expected);
    }
  });

  it("uses a deterministic up vector for top and bottom views", () => {
    const top = setStandardView(createCameraState(), "top");
    expect(cameraUpVector(top)).toEqual([0, 0, -1]);
    const bottom = setStandardView(createCameraState(), "bottom");
    expect(cameraUpVector(bottom)).toEqual([0, 0, 1]);
    expect(cameraUpVector(frontView())).toEqual([0, 1, 0]);
  });

  it("frames bounds with the target at the center and margin", () => {
    const state = focusCamera(
      frontView(),
      { min: [0, 0, 0], max: [2, 2, 2] },
      limits,
    );
    expect(state.target).toEqual([1, 1, 1]);
    const radius = Math.hypot(2, 2, 2) / 2;
    expect(state.distance).toBeCloseTo(
      (radius / Math.tan(state.fovY / 2)) * 1.2,
      9,
    );
  });

  it("frames the same content at any orthographic zoom", () => {
    const ortho = switchCameraMode(frontView());
    const zoomed = { ...ortho, zoom: 2 };
    const bounds = {
      min: [0, 0, 0] as [number, number, number],
      max: [2, 2, 2] as [number, number, number],
    };
    const state = focusCamera(zoomed, bounds, limits);
    const radius = Math.hypot(2, 2, 2) / 2;
    // The ortho half-height (distance*tan(fov/2)/zoom) must equal the
    // framed radius regardless of zoom.
    expect(
      (state.distance * Math.tan(state.fovY / 2)) / state.zoom,
    ).toBeCloseTo(radius * 1.2, 9);
  });
});

describe("applyCameraTo", () => {
  it("applies a perspective state to a THREE camera", () => {
    const state = { ...frontView(), distance: 1 };
    const camera = new THREE.PerspectiveCamera();
    applyCameraTo(camera, state, 2);
    expect(camera.position.z).toBeCloseTo(1, 9);
    expect(camera.up.y).toBe(1);
    expect(camera.fov).toBeCloseTo(50, 9);
    expect(camera.aspect).toBe(2);
  });

  it("applies an orthographic state with framing matching the perspective", () => {
    const state = {
      ...frontView(),
      mode: "orthographic" as const,
      distance: 10,
    };
    const camera = new THREE.OrthographicCamera();
    applyCameraTo(camera, state, 2);
    const halfHeight = 10 * Math.tan(state.fovY / 2);
    expect(camera.top).toBeCloseTo(halfHeight, 9);
    expect(camera.bottom).toBeCloseTo(-halfHeight, 9);
    expect(camera.right).toBeCloseTo(halfHeight * 2, 9);
    expect(camera.left).toBeCloseTo(-halfHeight * 2, 9);
    expect(camera.position.z).toBeCloseTo(10, 9);
  });
});

describe("camera rig", () => {
  it("swaps the camera instance on mode toggle", () => {
    const rig = createCameraRig();
    expect(rig.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    rig.toggleMode();
    expect(rig.camera).toBeInstanceOf(THREE.OrthographicCamera);
    rig.toggleMode();
    expect(rig.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    rig.dispose();
  });

  it("applies state immediately so picking sees the current projection", () => {
    const rig = createCameraRig();
    rig.setStandardView("front");
    rig.setViewportSize(800, 600);
    rig.focus({ min: [0, 0, 0], max: [4, 4, 4] });
    const camera = rig.camera as THREE.PerspectiveCamera;
    expect(camera.position.z).toBeCloseTo(
      rig.state.distance + rig.state.target[2],
      6,
    );
    rig.orbit(5, 0);
    expect(rig.camera.position.x).not.toBe(0);
    rig.dispose();
  });
});
