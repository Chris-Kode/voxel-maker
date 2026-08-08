import * as THREE from "three";
import type { Vec3 } from "@voxel-maker/math";
import type { WorldBounds } from "@voxel-maker/renderer";

/**
 * Viewport camera controller (plan S6.10/S6.11, ticket #16). The camera is
 * pure runtime state (ADR-0002): nothing here is persisted, committed, or
 * authoritative. The controller orbits/zooms a target-centered rig,
 * switches between perspective and orthographic projection while
 * preserving the target and framing, applies the six standard axis-aligned
 * views in the ADR-0001 `+X right, +Y up, +Z forward` convention, and
 * frames content or selection bounds.
 *
 * The state machine is deliberately plain data so every transition is
 * deterministic and unit-testable without a DOM or GPU; `applyCameraTo`
 * is the only place that touches a concrete THREE camera.
 *
 * Gesture conventions match the OrbitControls behavior the shell shipped
 * with (ticket #15): dragging right orbits the camera left around the
 * target, dragging down orbits the camera up over the top, and panning
 * moves the content with the cursor. Speeds and clamps are configurable
 * through `CameraLimits`.
 */

export type CameraMode = "perspective" | "orthographic";

/** The six standard axis-aligned views (plan S6.11). */
export type StandardViewId =
  | "front"
  | "back"
  | "left"
  | "right"
  | "top"
  | "bottom";

/** Near/far planes for the perspective projection. */
export const PERSPECTIVE_NEAR = 0.1;
export const PERSPECTIVE_FAR = 100000;

/** Near/far planes for the orthographic projection (camera may be far out). */
export const ORTHOGRAPHIC_NEAR = -100000;
export const ORTHOGRAPHIC_FAR = 100000;

/** Default vertical field of view in radians (50 degrees). */
export const DEFAULT_FOV_Y = (50 * Math.PI) / 180;

/** Extra framing margin applied by `focusCamera`. */
export const FOCUS_MARGIN = 1.2;

/** Configurable speeds and clamps (plan S6.10 "configurable speeds"). */
export interface CameraLimits {
  /** Orbit rotation in radians per pointer pixel. */
  readonly orbitSpeed: number;
  /** Multiplier for the world-units-per-pixel pan rate. */
  readonly panScale: number;
  /** Distance/zoom multiplier per wheel notch (zoom in when above 1). */
  readonly zoomFactor: number;
  readonly minDistance: number;
  readonly maxDistance: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  /** Closest allowed angle between the view direction and world up. */
  readonly minPolarAngle: number;
}

export const DEFAULT_CAMERA_LIMITS: CameraLimits = {
  orbitSpeed: 0.005,
  panScale: 1,
  zoomFactor: 1.1,
  minDistance: 0.5,
  maxDistance: 50000,
  minZoom: 0.02,
  maxZoom: 400,
  minPolarAngle: 0.01,
};

/**
 * Pure camera state. `direction` is the unit vector from `target` toward
 * the camera; `zoom` scales the orthographic frustum (1 = the perspective
 * framing at `distance`).
 */
export interface CameraState {
  readonly mode: CameraMode;
  readonly target: Vec3;
  readonly direction: Vec3;
  readonly distance: number;
  readonly fovY: number;
  readonly zoom: number;
}

/** Default view: 50-degree perspective, camera at (24, 20, 24). */
export function createCameraState(initial?: Partial<CameraState>): CameraState {
  const DEFAULT_POSITION: Vec3 = [24, 20, 24];
  const direction = normalize(DEFAULT_POSITION);
  return {
    mode: "perspective",
    target: [0, 0, 0],
    direction: direction ?? WORLD_UP,
    distance: length(DEFAULT_POSITION),
    fovY: DEFAULT_FOV_Y,
    zoom: 1,
    ...initial,
  };
}

export const WORLD_UP: Vec3 = [0, 1, 0];

const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);

const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const scale = (v: Vec3, factor: number): Vec3 => [
  v[0] * factor,
  v[1] * factor,
  v[2] * factor,
];

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Returns the unit vector, or undefined for a zero vector. */
function normalize(v: Vec3): Vec3 | undefined {
  const magnitude = length(v);
  if (magnitude === 0) return undefined;
  return scale(v, 1 / magnitude);
}

/** Rotates `v` around the unit axis `axis` by `angle` (Rodrigues). */
function rotateAround(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const axisCross = cross(axis, v);
  return add(
    add(scale(v, cosine), scale(axisCross, sine)),
    scale(axis, dot(axis, v) * (1 - cosine)),
  );
}

/** Camera world position for a state. */
export function cameraPosition(state: CameraState): Vec3 {
  return add(state.target, scale(state.direction, state.distance));
}

/**
 * Clamps the polar angle between `direction` and world up to
 * `[minPolarAngle, pi - minPolarAngle]`, preserving the azimuth.
 */
function clampPolar(direction: Vec3, up: Vec3, minPolarAngle: number): Vec3 {
  const maxDot = Math.cos(minPolarAngle);
  const currentDot = dot(direction, up);
  if (currentDot <= maxDot && currentDot >= -maxDot) return direction;
  const perpendicular = normalize(sub(direction, scale(up, currentDot)));
  if (perpendicular === undefined) return direction;
  const sine = Math.sin(minPolarAngle);
  if (currentDot > maxDot) {
    return normalize(
      add(scale(up, maxDot), scale(perpendicular, sine)),
    ) as Vec3;
  }
  return normalize(
    add(scale(up, -maxDot), scale(perpendicular, -sine)),
  ) as Vec3;
}

/** Orbits by pointer deltas in pixels (OrbitControls-compatible feel). */
export function orbitCamera(
  state: CameraState,
  deltaX: number,
  deltaY: number,
  limits: CameraLimits,
): CameraState {
  // Drag right orbits the camera left around the target (yaw around up).
  let direction = rotateAround(
    state.direction,
    WORLD_UP,
    -deltaX * limits.orbitSpeed,
  );
  // Drag down orbits the camera up over the top (pitch around the right).
  const viewDirection = scale(direction, -1);
  let right = normalize(cross(viewDirection, WORLD_UP));
  if (right === undefined) {
    right = normalize(cross(viewDirection, [1, 0, 0]));
  }
  if (right !== undefined) {
    direction = rotateAround(direction, right, -deltaY * limits.orbitSpeed);
  }
  direction = clampPolar(direction, WORLD_UP, limits.minPolarAngle);
  return { ...state, direction };
}

/**
 * The camera's up vector: world up except at the poles, where the view
 * direction is used so screen-up stays deterministic for top/bottom views.
 */
export function cameraUpVector(state: CameraState): Vec3 {
  const viewDirection = scale(state.direction, -1);
  if (Math.abs(dot(viewDirection, WORLD_UP)) > 1 - 1e-6) {
    // Looking straight down: screen up is -Z so the asset's front (+Z)
    // points toward the bottom of the screen; looking up mirrors it.
    return viewDirection[1] > 0 ? [0, 0, 1] : [0, 0, -1];
  }
  return WORLD_UP;
}

/**
 * Pans by pointer deltas in pixels: the content follows the cursor. The
 * world-units-per-pixel rate keeps perspective and orthographic pan speeds
 * equal at zoom 1.
 */
export function panCamera(
  state: CameraState,
  deltaX: number,
  deltaY: number,
  viewportHeight: number,
  limits: CameraLimits,
): CameraState {
  if (!(viewportHeight > 0)) return state;
  const viewDirection = scale(state.direction, -1);
  const up = cameraUpVector(state);
  const right = normalize(cross(viewDirection, up));
  if (right === undefined) return state;
  const screenUp = cross(right, viewDirection);
  const unitsPerPixel =
    ((2 * state.distance * Math.tan(state.fovY / 2)) /
      Math.max(state.zoom, 1e-9) /
      viewportHeight) *
    limits.panScale;
  const offset = add(scale(right, -deltaX), scale(screenUp, deltaY));
  return {
    ...state,
    target: add(state.target, scale(offset, unitsPerPixel)),
  };
}

/** Zooms by a factor (> 1 zooms in), clamped to the configured limits. */
export function zoomCamera(
  state: CameraState,
  factor: number,
  limits: CameraLimits,
): CameraState {
  if (state.mode === "perspective") {
    const distance = clamp(
      state.distance / factor,
      limits.minDistance,
      limits.maxDistance,
    );
    return { ...state, distance };
  }
  const zoom = clamp(state.zoom * factor, limits.minZoom, limits.maxZoom);
  return { ...state, zoom };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** Switches projection mode while preserving target, distance, and zoom. */
export function switchCameraMode(state: CameraState): CameraState {
  return {
    ...state,
    mode: state.mode === "perspective" ? "orthographic" : "perspective",
  };
}

/** Standard axis-aligned views in the +X right, +Y up, +Z forward frame. */
const STANDARD_DIRECTIONS: Readonly<Record<StandardViewId, Vec3>> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
};

/** Points the camera along a standard axis-aligned view, keeping distance. */
export function setStandardView(
  state: CameraState,
  view: StandardViewId,
): CameraState {
  return { ...state, direction: STANDARD_DIRECTIONS[view] };
}

/**
 * Frames world bounds: centers the target and sets the distance so the
 * bounds' bounding sphere fits vertically with `FOCUS_MARGIN` headroom.
 */
export function focusCamera(
  state: CameraState,
  bounds: WorldBounds,
  limits: CameraLimits,
): CameraState {
  const center: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const radius = length(sub(bounds.max, bounds.min)) / 2;
  // Orthographic half-height is distance*tan(fov/2)/zoom, so the distance
  // must scale with zoom for F to frame the same content at any zoom.
  const distance = clamp(
    ((radius * FOCUS_MARGIN) / Math.tan(state.fovY / 2)) * state.zoom,
    limits.minDistance,
    limits.maxDistance,
  );
  return { ...state, target: center, distance };
}

/** Pushes a camera state onto a concrete THREE camera. */
export function applyCameraTo(
  camera: THREE.Camera,
  state: CameraState,
  aspect: number,
): void {
  const position = cameraPosition(state);
  camera.position.set(position[0], position[1], position[2]);
  const up = cameraUpVector(state);
  camera.up.set(up[0], up[1], up[2]);
  camera.lookAt(state.target[0], state.target[1], state.target[2]);
  if (state.mode === "perspective") {
    const perspective = camera as THREE.PerspectiveCamera;
    perspective.fov = (state.fovY * 180) / Math.PI;
    perspective.aspect = aspect;
    perspective.near = PERSPECTIVE_NEAR;
    perspective.far = PERSPECTIVE_FAR;
    perspective.updateProjectionMatrix();
  } else {
    const orthographic = camera as THREE.OrthographicCamera;
    const halfHeight =
      (state.distance * Math.tan(state.fovY / 2)) / Math.max(state.zoom, 1e-9);
    const halfWidth = halfHeight * aspect;
    orthographic.left = -halfWidth;
    orthographic.right = halfWidth;
    orthographic.top = halfHeight;
    orthographic.bottom = -halfHeight;
    orthographic.near = ORTHOGRAPHIC_NEAR;
    orthographic.far = ORTHOGRAPHIC_FAR;
    orthographic.updateProjectionMatrix();
  }
  camera.updateMatrixWorld(true);
}

/**
 * Owns the active THREE camera and the pure camera state. Mode switches
 * swap the camera instance; every mutation applies immediately so picking
 * always sees the current projection.
 */
export interface CameraRig {
  readonly state: CameraState;
  /** The active camera instance (perspective or orthographic). */
  readonly camera: THREE.Camera;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  setViewportSize(width: number, height: number): void;
  orbit(deltaX: number, deltaY: number): void;
  pan(deltaX: number, deltaY: number): void;
  zoomBy(factor: number): void;
  toggleMode(): void;
  setStandardView(view: StandardViewId): void;
  focus(bounds: WorldBounds): void;
  /** Pushes the current state onto the active camera (idempotent). */
  apply(): void;
  dispose(): void;
}

export interface CameraRigOptions {
  readonly initial?: Partial<CameraState>;
  readonly limits?: CameraLimits;
}

export function createCameraRig(options?: CameraRigOptions): CameraRig {
  const limits = options?.limits ?? DEFAULT_CAMERA_LIMITS;
  let state = createCameraState(options?.initial);
  let viewportWidth = 1;
  let viewportHeight = 1;
  let camera: THREE.Camera = new THREE.PerspectiveCamera(
    (state.fovY * 180) / Math.PI,
    viewportWidth / viewportHeight,
    PERSPECTIVE_NEAR,
    PERSPECTIVE_FAR,
  );

  const apply = (): void => {
    applyCameraTo(camera, state, viewportWidth / viewportHeight);
  };

  const setViewportSize = (width: number, height: number): void => {
    viewportWidth = width;
    viewportHeight = Math.max(height, 1);
    apply();
  };

  const ensureMode = (): void => {
    const wantsOrtho = state.mode === "orthographic";
    if (wantsOrtho === camera instanceof THREE.OrthographicCamera) return;
    if (wantsOrtho) {
      camera = new THREE.OrthographicCamera(
        -1,
        1,
        1,
        -1,
        ORTHOGRAPHIC_NEAR,
        ORTHOGRAPHIC_FAR,
      );
    } else {
      camera = new THREE.PerspectiveCamera(
        (state.fovY * 180) / Math.PI,
        viewportWidth / viewportHeight,
        PERSPECTIVE_NEAR,
        PERSPECTIVE_FAR,
      );
    }
    apply();
  };

  return {
    get state() {
      return state;
    },
    get camera() {
      return camera;
    },
    get viewportWidth() {
      return viewportWidth;
    },
    get viewportHeight() {
      return viewportHeight;
    },
    setViewportSize,
    orbit(deltaX, deltaY) {
      state = orbitCamera(state, deltaX, deltaY, limits);
      apply();
    },
    pan(deltaX, deltaY) {
      state = panCamera(state, deltaX, deltaY, viewportHeight, limits);
      apply();
    },
    zoomBy(factor) {
      state = zoomCamera(state, factor, limits);
      apply();
    },
    toggleMode() {
      state = switchCameraMode(state);
      ensureMode();
    },
    setStandardView(view) {
      state = setStandardView(state, view);
      apply();
    },
    focus(bounds) {
      state = focusCamera(state, bounds, limits);
      apply();
    },
    apply,
    dispose() {
      // Cameras hold no GPU resources; dropping the reference is enough.
    },
  };
}
