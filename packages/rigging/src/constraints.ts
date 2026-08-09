import {
  eulerXYZToQuaternion,
  quaternionToEulerXYZ,
  transformToMatrix,
  type Mat4,
  type Quat,
  type Transform,
  type Vec3,
} from "@voxel-maker/math";
import type { NodeId } from "@voxel-maker/shared";
import type {
  ConstraintDescriptor,
  RotationLimits,
  SceneNode,
  VoxelDocument,
} from "@voxel-maker/model";
import { walkNodeWorldTransforms } from "./evaluate.js";

/**
 * Rotation constraint evaluation (plan S9.5, ticket #27). Constraints
 * apply local Euler XYZ rotation limits in radians after the authored (or,
 * later, animated) local transform and before hierarchy composition
 * (ADR-0006). Evaluation is pure runtime behavior: it reads the immutable
 * document, clamps local rotations, and never writes back.
 *
 * Deterministic wrap semantics: each axis' principal-branch Euler angle
 * (x in [-pi,pi], z in [-pi,pi], y in [-pi/2,pi/2]) is mapped to the
 * equivalent 2-pi-period representation nearest the allowed interval
 * [min, max] and clamped to that interval. A limit whose span is at
 * least a full revolution never restricts the axis. When the angle sits
 * exactly between two equivalent intervals (a half-turn away from the
 * interval midpoint on both sides), the tie resolves to the lower
 * period boundary via round-half-up (`Math.round`). Gimbal-locked
 * configurations use the fixed principal extraction (z folds into x),
 * so a locked axis cannot be recovered by a limit on z — a documented
 * MVP limitation of Euler XYZ limits (plan 3.1).
 */

const TWO_PI = 2 * Math.PI;

/**
 * Clamps one principal-branch angle into the periodic interval
 * `[min, max]` (radians): the equivalent angle `angle + 2*pi*k` nearest
 * the interval wins, then the angle clamps to the interval. A span of at
 * least a full revolution means the axis is unrestricted.
 */
export function clampWrappedAngle(
  angle: number,
  min: number,
  max: number,
): number {
  if (max - min >= TWO_PI) return angle;
  const midpoint = (min + max) / 2;
  const period = Math.round((angle - midpoint) / TWO_PI);
  const lo = min + period * TWO_PI;
  const hi = max + period * TWO_PI;
  return Math.min(hi, Math.max(lo, angle));
}

/**
 * Applies one rotation-limits constraint to a canonical unit quaternion:
 * extract intrinsic Euler XYZ, clamp each axis with wrap semantics, and
 * recompose. The result is a new canonical quaternion; the input is
 * never mutated.
 */
export function applyRotationLimits(
  rotation: Quat,
  limits: RotationLimits,
): Quat {
  const euler = quaternionToEulerXYZ(rotation);
  const clamped: Vec3 = [
    clampWrappedAngle(euler[0], limits.min[0], limits.max[0]),
    clampWrappedAngle(euler[1], limits.min[1], limits.max[1]),
    clampWrappedAngle(euler[2], limits.min[2], limits.max[2]),
  ];
  return eulerXYZToQuaternion(clamped);
}

/**
 * Applies every rotation constraint of a node in deterministic persisted
 * order (ADR-0006: "deterministically ordered by their stable persisted
 * order"). Each constraint clamps the rotation produced by the previous
 * one; a later constraint may therefore move the rotation outside an
 * earlier constraint's interval, which is why order is a persisted,
 * user-visible property.
 */
export function applyRotationConstraints(
  rotation: Quat,
  constraints: readonly ConstraintDescriptor[],
): Quat {
  // Version 1 constraints are always local rotation limits (ADR-0006);
  // future descriptor kinds extend this function deliberately.
  let current = rotation;
  for (const constraint of constraints) {
    current = applyRotationLimits(current, constraint.limits);
  }
  return current;
}

/** The ordered rotation-limits descriptors of a node, if any. */
export function rotationConstraintsOf(
  node: SceneNode,
): readonly ConstraintDescriptor[] {
  for (const component of node.components) {
    if (component.kind === "constraint") return component.constraints;
  }
  return [];
}

/**
 * Evaluates one node's local transform under its rotation constraints:
 * the canonical transform with the rotation replaced by the constrained
 * rotation. Translation, pivot, and scale are never touched (constraints
 * apply to local rotation only, ADR-0006). Pure: returns a new transform
 * and never mutates the input.
 */
export function evaluateConstrainedLocalTransform(
  transform: Transform,
  constraints: readonly ConstraintDescriptor[],
): Transform {
  const rotation = applyRotationConstraints(transform.rotation, constraints);
  if (
    rotation[0] === transform.rotation[0] &&
    rotation[1] === transform.rotation[1] &&
    rotation[2] === transform.rotation[2] &&
    rotation[3] === transform.rotation[3]
  ) {
    return transform;
  }
  return { ...transform, rotation };
}

/**
 * World 4x4 matrices of every node reachable from the document root in
 * one deterministic pre-order pass with rotation constraints applied:
 * each node's local rotation is clamped (in persisted constraint order)
 * BEFORE composing with the parent world matrix, so positive non-uniform
 * ancestor scale is supported and resulting shear is never decomposed
 * (ADR-0006). The traversal is the shared rig walker; only the local
 * matrix mapper differs from the base evaluation. The base document
 * remains untouched; this is a pure runtime projection.
 */
export function evaluateConstrainedNodeWorldTransforms(
  document: VoxelDocument,
): ReadonlyMap<NodeId, Mat4> {
  return walkNodeWorldTransforms(document, (node) =>
    transformToMatrix(
      evaluateConstrainedLocalTransform(
        node.transform,
        rotationConstraintsOf(node),
      ),
    ),
  );
}
