import type { DocumentStoreRead } from "@voxel-maker/document";
import { evaluateAnimationRuntime } from "@voxel-maker/animation";
import type { AnimationDescriptor } from "@voxel-maker/model";
import type { NodeId } from "@voxel-maker/shared";

/**
 * Overlay-clip playback evidence (plan S13.5, ticket #36): the harness
 * plays the STAGED clip (read from the preview session before Apply)
 * through the animation runtime at two fixed sample times and reports
 * which track-target nodes actually move. Playback is a pure read over
 * the staged overlay: no commands, no revisions, no live mutation.
 */

/** The two fixed sample fractions of one playback evidence pass: 25% and
 * 75% of the clip duration. Fractions (not absolute times) keep the
 * evidence independent of a clip's loop point — sampling exactly at the
 * loop endpoint would compare an identity rotation against float residue
 * instead of actual motion. */
export const PLAYBACK_SAMPLE_FRACTIONS = [0.25, 0.75] as const;

/** One playback evidence pass over a staged clip. */
export interface PlaybackEvidence {
  readonly clipId: string;
  /** Track-target nodes whose world matrix differs between the samples. */
  readonly movedNodes: readonly NodeId[];
  readonly sampleTimes: readonly [number, number];
}

/** Plays one clip over a store's document at two times and reports motion. */
export function playbackEvidence(
  store: DocumentStoreRead,
  clip: AnimationDescriptor,
): PlaybackEvidence {
  const document = store.getDocument();
  const duration = clip.duration;
  const [fractionA, fractionB] = PLAYBACK_SAMPLE_FRACTIONS;
  const sampleA = evaluateAnimationRuntime(
    document,
    clip,
    Math.min(fractionA * duration, duration),
  );
  const sampleB = evaluateAnimationRuntime(
    document,
    clip,
    Math.min(fractionB * duration, duration),
  );
  const movedNodes: NodeId[] = [];
  const worldA = sampleA.world;
  const worldB = sampleB.world;
  for (const track of clip.tracks) {
    const target = track.targetNodeId;
    const matrixA = worldA.get(target);
    const matrixB = worldB.get(target);
    if (matrixA === undefined || matrixB === undefined) continue;
    if (!matricesEqual(matrixA, matrixB)) movedNodes.push(target);
  }
  return {
    clipId: clip.animationId,
    movedNodes,
    sampleTimes: [sampleA.time, sampleB.time],
  };
}

/** Exact 4x4 column-major equality (canonical floats are stable). */
function matricesEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
