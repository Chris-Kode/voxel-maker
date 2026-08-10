import type { GeneratorDefinition, GeneratorContext } from "../generator.js";
import { createCommandFactory } from "../generator.js";
import type { Command } from "@voxel-maker/commands";
import type { IntAabb, Vec3i } from "../geometry.js";
import { boxFromMinSize, unionAabb, type Vec3Size } from "../geometry.js";
import { AXIS_SCHEMA, VEC3I_SCHEMA, boundedIntSchema } from "../schemas.js";

/**
 * Stairs generator (plan S14.5, ticket #37): a deterministic staircase of
 * `count` identical steps advancing along one horizontal axis, rising
 * `stepHeight` voxels per step. Each step is one generic `voxel.fillBox`
 * command; the count, width, depth, and step height are bounded by the
 * schema maxima.
 */

export type StairsParams = {
  /** Min corner of the first (lowest) step. */
  readonly start: Vec3i;
  /** Number of steps. */
  readonly count: number;
  /** Step width along the axis perpendicular to the run. */
  readonly width: number;
  /** Step depth along the run axis. */
  readonly depth: number;
  /** Step height in voxels. */
  readonly stepHeight: number;
  /** Horizontal axis the staircase runs along ("x" or "z"). */
  readonly axis: "x" | "z";
};

export const MAX_STAIRS_COUNT = 256;
export const MAX_STAIRS_DIMENSION = 256;
export const MAX_STEP_HEIGHT = 16;

export const STAIRS_GENERATOR: GeneratorDefinition<StairsParams> = {
  name: "generator.stairs",
  version: 1,
  description:
    "Builds a deterministic staircase of count steps rising stepHeight voxels per step (one voxel.fillBox per step).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      start: VEC3I_SCHEMA,
      count: boundedIntSchema(1, MAX_STAIRS_COUNT),
      width: boundedIntSchema(1, MAX_STAIRS_DIMENSION),
      depth: boundedIntSchema(1, MAX_STAIRS_DIMENSION),
      stepHeight: boundedIntSchema(1, MAX_STEP_HEIGHT),
      axis: { ...AXIS_SCHEMA, enum: ["x", "z"] },
    },
    required: ["start", "count", "width", "depth", "stepHeight", "axis"],
  },
  parse(value: unknown): StairsParams {
    return value as StairsParams;
  },
  propose(params: StairsParams, context: GeneratorContext) {
    const commands = createCommandFactory(this, params, context);
    const proposed: Command[] = [];
    let bounds: IntAabb | undefined;
    // One layout per run axis: `advance` is the unit run direction (each
    // step advances `depth` voxels along it) and `size` is the step
    // extent with `depth` along the run axis and `width` across it.
    // Keeping both in one table makes a swapped-axis mismatch between
    // the min and the size structurally impossible (issue #109).
    const layout: Record<"x" | "z", { advance: Vec3i; size: Vec3Size }> = {
      x: {
        advance: [1, 0, 0],
        size: [params.depth, params.stepHeight, params.width],
      },
      z: {
        advance: [0, 0, 1],
        size: [params.width, params.stepHeight, params.depth],
      },
    };
    const run = layout[params.axis];
    for (let index = 0; index < params.count; index += 1) {
      const min: Vec3i = [
        params.start[0] + index * params.depth * run.advance[0],
        params.start[1] + index * params.stepHeight,
        params.start[2] + index * params.depth * run.advance[2],
      ];
      const step = boxFromMinSize(min, run.size);
      proposed.push(commands.fillBox(step));
      bounds = bounds === undefined ? step : unionAabb(bounds, step);
    }
    return { commands: proposed, bounds: bounds as IntAabb };
  },
};
