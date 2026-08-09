/**
 * Public entry point for the rigging package (plan Stage 9): pivot-aware
 * transform evaluation, rig annotation semantics, rotation constraint
 * evaluation (ticket #27), and generic articulation fixtures.
 */
export {
  evaluateLocalTransform,
  evaluateNodeWorldTransforms,
  evaluateWorldTransform,
} from "./evaluate.js";
export {
  applyRotationConstraints,
  applyRotationLimits,
  clampWrappedAngle,
  evaluateConstrainedLocalTransform,
  evaluateConstrainedNodeWorldTransforms,
  rotationConstraintsOf,
} from "./constraints.js";
export {
  hasJointAnnotation,
  hasPivotAnnotation,
  pivotAnnotation,
  validateRigAnnotations,
  type RigAnnotationIssue,
} from "./validate.js";
export {
  RIG_FIXTURES,
  createAbstractSculptureFixture,
  createChestLidFixture,
  createLinkedArmFixture,
  createWheelFixture,
  createWingsFixture,
} from "./fixtures.js";
