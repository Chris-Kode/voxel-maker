/**
 * Public entry point for the animation package: clip/track/keyframe
 * semantic validation (plan S10.2), track sampling (S10.3), clip time and
 * loop evaluation (S10.4), the layered runtime transform evaluator (S10.5),
 * and the injectable playback controller (S10.7) for ticket #28. The
 * package owns pure semantics and runtime projection only: it never
 * imports commands, never writes documents, and playback never emits
 * commands or revisions per frame (ADR-0006).
 */
export {
  validateAnimationSemantics,
  hasValidAnimationSemantics,
  trackTargetNode,
  trackChannel,
  type AnimationIssue,
} from "./validate.js";
export { sampleTrack } from "./sample.js";
export {
  resolveClipTime,
  sampleClip,
  type ClipSample,
  type NodeOverrides,
} from "./evaluate.js";
export {
  evaluateAnimationRuntime,
  evaluateLocalTransforms,
  evaluateWorldTransforms,
  type AnimationRuntimeState,
} from "./runtime.js";
export {
  createPlaybackController,
  type PlaybackClock,
  type PlaybackController,
  type PlaybackState,
} from "./playback.js";
export {
  ANIMATED_DEMOS,
  createAbstractAnimationDocument,
  createAbstractSculptureClip,
  createAnimatedWheelDocument,
  createCharacterWaveDocument,
  createCharacterWaveClip,
  createChestLidClip,
  createConstrainedChestLidDocument,
  createContinuousWheelClip,
  createContinuousWheelDocument,
  createLinkedArmDocument,
  createLinkedArmReachClip,
  createWheelSpinClip,
  createWingFlapClip,
  createWingFlapDocument,
  type AnimatedDemo,
} from "./fixtures.js";
