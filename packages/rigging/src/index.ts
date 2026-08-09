/**
 * Public entry point for the rigging package (plan Stage 9, ticket #26):
 * pivot-aware transform evaluation, rig annotation semantics, and generic
 * articulation fixtures. Constraints and their evaluator arrive with
 * ticket #27.
 */
export {
  evaluateLocalTransform,
  evaluateNodeWorldTransforms,
  evaluateWorldTransform,
} from "./evaluate.js";
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
