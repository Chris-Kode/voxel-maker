import * as THREE from "three";
import type {
  GizmoAxis,
  GizmoHandle,
  TransformTargets,
  TransformToolMode,
} from "@voxel-maker/editor";

/**
 * Three.js gizmo overlay (plan S7.8, ticket #20): renders the move/rotate/
 * scale handles for the transform tool and performs deterministic screen-
 * space hit testing. The overlay is a pure projection: it reads transform
 * targets, mode, and space from the tool, positions disposable meshes, and
 * reports which handle a pointer hits. All drag math and commit/cancel
 * behavior lives in the headless transform tool; this module never touches
 * semantic state.
 *
 * Hit testing projects handle geometry (axis segments for translate/scale,
 * sampled ring points for rotate) to NDC and picks the nearest handle
 * within a pixel threshold — the same deterministic seam as voxel picking.
 */

export const GIZMO_PICK_THRESHOLD_PX = 14;
export const GIZMO_MESH_NAME = "transform-gizmo-handle";

const AXIS_COLORS = [0xff4444, 0x44ff44, 0x4488ff] as const;

/** Overlay geometry lengths, in units of the targets radius. */
const HANDLE_LENGTH = 1.25;
const ARROW_HEAD = 0.22;
const RING_SAMPLES = 24;

export interface GizmoOverlay {
  /** The scene group; added to the scene at creation. */
  readonly group: THREE.Group;
  /** The currently rendered mode (for picking). */
  readonly mode: TransformToolMode;
  /** Re-reads targets/mode/space and repositions the handles. */
  update(
    targets: TransformTargets | undefined,
    mode: TransformToolMode,
    space: "local" | "world",
    localRotation: readonly [number, number, number, number] | undefined,
  ): void;
  /** The handle under a viewport point, or undefined. */
  pick(
    clientX: number,
    clientY: number,
    camera: THREE.Camera,
    viewportWidth: number,
    viewportHeight: number,
  ): GizmoHandle | undefined;
  dispose(): void;
}

export function createGizmoOverlay(scene: THREE.Scene): GizmoOverlay {
  const group = new THREE.Group();
  group.name = "transform-gizmo";
  group.visible = false;
  group.renderOrder = 999;
  scene.add(group);

  const axisVectors = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ] as const;

  const translateHandles: THREE.Object3D[] = [];
  const rotateHandles: THREE.Object3D[] = [];
  const scaleHandles: THREE.Object3D[] = [];

  /** Axis line plus an arrowhead (translate handle). */
  const makeArrow = (axis: GizmoAxis): THREE.Object3D => {
    const root = new THREE.Object3D();
    const material = new THREE.MeshBasicMaterial({
      color: AXIS_COLORS[axis],
      depthTest: false,
    });
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 1, 8),
      material,
    );
    shaft.name = GIZMO_MESH_NAME;
    shaft.position.y = 0.5;
    const head = new THREE.Mesh(
      new THREE.ConeGeometry(0.07, ARROW_HEAD, 12),
      material,
    );
    head.name = GIZMO_MESH_NAME;
    head.position.y = 1 + ARROW_HEAD / 2;
    root.add(shaft, head);
    root.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      axisVectors[axis],
    );
    return root;
  };

  /** Ring in the plane perpendicular to the axis (rotate handle). */
  const makeRing = (axis: GizmoAxis): THREE.Object3D => {
    const root = new THREE.Object3D();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.022, 8, 64),
      new THREE.MeshBasicMaterial({
        color: AXIS_COLORS[axis],
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      }),
    );
    ring.name = GIZMO_MESH_NAME;
    if (axis === 0) ring.rotation.z = Math.PI / 2;
    else if (axis === 1) ring.rotation.x = Math.PI / 2;
    root.add(ring);
    return root;
  };

  /** Box at the handle length (scale handle). */
  const makeBox = (axis: GizmoAxis): THREE.Object3D => {
    const root = new THREE.Object3D();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.16, 0.16),
      new THREE.MeshBasicMaterial({
        color: AXIS_COLORS[axis],
        depthTest: false,
      }),
    );
    box.name = GIZMO_MESH_NAME;
    box.position.y = 1;
    root.add(box);
    root.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      axisVectors[axis],
    );
    return root;
  };

  for (const axis of [0, 1, 2] as const) {
    const arrow = makeArrow(axis);
    const ring = makeRing(axis);
    const box = makeBox(axis);
    group.add(arrow, ring, box);
    translateHandles.push(arrow);
    rotateHandles.push(ring);
    scaleHandles.push(box);
  }

  /** Small pivot cube at the gizmo center. */
  const pivot = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.09, 0.09),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }),
  );
  pivot.name = GIZMO_MESH_NAME;
  group.add(pivot);

  let currentMode: TransformToolMode = "translate";

  const overlay: GizmoOverlay = {
    group,
    get mode() {
      return currentMode;
    },
    update(targets, mode, space, localRotation) {
      currentMode = mode;
      if (targets === undefined) {
        group.visible = false;
        return;
      }
      group.visible = true;
      group.position.set(
        targets.center[0],
        targets.center[1],
        targets.center[2],
      );
      group.scale.setScalar(Math.max(targets.radius, 0.001) * 1.1);
      if (space === "local" && localRotation !== undefined) {
        group.quaternion.set(
          localRotation[0],
          localRotation[1],
          localRotation[2],
          localRotation[3],
        );
      } else {
        group.quaternion.identity();
      }
      for (const handle of translateHandles) {
        handle.visible = mode === "translate";
      }
      for (const handle of rotateHandles) {
        handle.visible = mode === "rotate";
      }
      for (const handle of scaleHandles) {
        handle.visible = mode === "scale";
      }
      pivot.visible = mode !== "rotate";
    },
    pick(clientX, clientY, camera, viewportWidth, viewportHeight) {
      if (!group.visible || viewportWidth <= 0 || viewportHeight <= 0) {
        return undefined;
      }
      group.updateMatrixWorld();
      const pointer = new THREE.Vector2(
        (clientX / viewportWidth) * 2 - 1,
        1 - (clientY / viewportHeight) * 2,
      );
      // Pixel threshold in viewport pixels; handle distances are also
      // computed in viewport pixels.
      const threshold = GIZMO_PICK_THRESHOLD_PX;
      let best: { handle: GizmoHandle; distance: number } | undefined;
      for (const axis of [0, 1, 2] as const) {
        const handle: GizmoHandle = { mode: currentMode, axis };
        const distance = handlePixelDistance(
          handle,
          axisVectors[axis],
          pointer,
          group.matrixWorld,
          camera,
          viewportWidth,
          viewportHeight,
          threshold,
        );
        if (
          distance !== undefined &&
          (best === undefined || distance < best.distance)
        ) {
          best = { handle, distance };
        }
      }
      return best?.handle;
    },
    dispose() {
      scene.remove(group);
      const meshes: THREE.Mesh[] = [];
      group.traverse((object) => {
        // `instanceof` narrows to the generic constructor type
        // (Mesh<any, any, any>); cast to the concrete mesh shape.
        if (object instanceof THREE.Mesh) {
          meshes.push(object as THREE.Mesh);
        }
      });
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        const material = mesh.material;
        const materials = Array.isArray(material) ? material : [material];
        for (const entry of materials) entry.dispose();
      }
    },
  };
  return overlay;
}

/** Pointer distance to the nearest handle geometry, in NDC units. */
function handlePixelDistance(
  handle: GizmoHandle,
  axis: THREE.Vector3,
  pointer: THREE.Vector2,
  matrixWorld: THREE.Matrix4,
  camera: THREE.Camera,
  viewportWidth: number,
  viewportHeight: number,
  threshold: number,
): number | undefined {
  const points: THREE.Vector3[] = [];
  if (handle.mode === "rotate") {
    // Sample points on the unit ring in the plane perpendicular to axis.
    const second = new THREE.Vector3(0, 1, 0).cross(axis);
    if (second.lengthSq() < 1e-6) second.set(1, 0, 0);
    second.normalize();
    const third = new THREE.Vector3().crossVectors(axis, second).normalize();
    for (let index = 0; index < RING_SAMPLES; index += 1) {
      const angle = (index / RING_SAMPLES) * Math.PI * 2;
      points.push(
        new THREE.Vector3()
          .copy(second)
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(third, Math.sin(angle)),
      );
    }
  } else {
    points.push(new THREE.Vector3(0, 0, 0));
    points.push(axis.clone().multiplyScalar(HANDLE_LENGTH));
    points.push(axis.clone().multiplyScalar(HANDLE_LENGTH + ARROW_HEAD));
  }
  let best: number | undefined;
  for (const local of points) {
    const ndc = local.clone().applyMatrix4(matrixWorld).project(camera);
    if (ndc.z > 1 || ndc.z < -1) continue;
    const dx = (ndc.x - pointer.x) * (viewportWidth / 2);
    const dy = (ndc.y - pointer.y) * (viewportHeight / 2);
    const distance = Math.hypot(dx, dy);
    if (distance <= threshold && (best === undefined || distance < best)) {
      best = distance;
    }
  }
  return best;
}
