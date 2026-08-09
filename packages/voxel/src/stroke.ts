import { WorkspaceError } from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";

/**
 * Deterministic 3D stroke rasterization (plan S7.5, ticket #17).
 *
 * A stroke is a chain of volume-local voxel coordinates produced from
 * consecutive pointer picks. Between two picks the tool rasterizes the
 * straight segment `segmentCoordinates(from, to, ...)` so fast pointer
 * movement never leaves gaps: every consecutive pair of returned voxels
 * differs by at most one per axis (26-connected), and both endpoints are
 * always included exactly, including under negative coordinates.
 *
 * The algorithm steps the dominant axis (the axis with the largest
 * absolute delta) one voxel at a time and rounds the other two axes with
 * exact integer round-half-up arithmetic. All intermediate values are
 * products of bounded integers well below 2^53, so results are identical
 * on every platform. Segment size is bounded by the caller-supplied
 * `maxCoordinates` budget (ADR-0009, `MAX_VOXELS_PER_OPERATION`).
 */

/**
 * Rasterizes the straight voxel segment between `from` and `to`,
 * inclusive, ordered from `from` to `to`.
 *
 * @throws `WorkspaceError` (family `limit`, code `TOO_MANY_VOXELS`) when
 *   the segment has more than `maxCoordinates` voxels.
 */
export function segmentCoordinates(
  from: Vec3i,
  to: Vec3i,
  maxCoordinates: number,
): readonly Vec3i[] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const count = steps + 1;
  if (count > maxCoordinates) {
    throw new WorkspaceError({
      family: "limit",
      code: "TOO_MANY_VOXELS",
      message: "Stroke segment exceeds the per-operation voxel limit",
      context: { requested: count, limit: maxCoordinates },
    });
  }
  const points: Vec3i[] = new Array<Vec3i>(count);
  for (let index = 0; index < count; index += 1) {
    points[index] = [
      from[0] + roundDivide(index * dx, steps),
      from[1] + roundDivide(index * dy, steps),
      from[2] + roundDivide(index * dz, steps),
    ];
  }
  return points;
}

/**
 * Exact integer round-half-up of `numerator / divisor`; returns 0 when the
 * divisor is 0. `Math.round` is avoided so negative halves round up (away
 * from negative infinity) identically on every platform: the result is
 * `floor((2n + d) / 2d)`, computed from integers only.
 */
function roundDivide(numerator: number, divisor: number): number {
  if (divisor === 0) return 0;
  return Math.floor((2 * numerator + divisor) / (2 * divisor));
}
