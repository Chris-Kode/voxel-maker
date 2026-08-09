import type { GeneratorDefinition, GeneratorContext } from "../generator.js";
import { createCommandFactory } from "../generator.js";
import type { Command } from "@voxel-maker/commands";
import type { IntAabb, Vec3i } from "../geometry.js";
import { unionAabb } from "../geometry.js";
import {
  REGION_SCHEMA,
  VEC3I_SCHEMA,
  boundedIntSchema,
  requireValidRegion,
} from "../schemas.js";

/**
 * Linear repeat generator (plan S14.4, ticket #37): places `count` copies
 * of a source region along an integer translation delta, emitting one
 * generic `voxel.copyRegion` command per copy. Deterministic by
 * construction; the copy count is bounded by the schema maximum.
 */

export type LinearRepeatParams = {
  /** Half-open source region copied on every step. */
  readonly source: IntAabb;
  /** Number of copies (the original position is not re-copied). */
  readonly count: number;
  /** Integer translation applied per copy. */
  readonly delta: Vec3i;
};

export const MAX_LINEAR_REPEAT_COUNT = 256;

export const LINEAR_REPEAT_GENERATOR: GeneratorDefinition<LinearRepeatParams> =
  {
    name: "generator.linearRepeat",
    version: 1,
    description:
      "Places count copies of a source region along an integer delta (one voxel.copyRegion command per copy).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: REGION_SCHEMA,
        count: boundedIntSchema(1, MAX_LINEAR_REPEAT_COUNT),
        delta: VEC3I_SCHEMA,
      },
      required: ["source", "count", "delta"],
    },
    parse(value: unknown): LinearRepeatParams {
      const params = value as LinearRepeatParams;
      requireValidRegion(params.source, ["source"]);
      return params;
    },
    propose(params: LinearRepeatParams, context: GeneratorContext) {
      const commands = createCommandFactory(this, params, context);
      const size: Vec3i = [
        params.source.max[0] - params.source.min[0],
        params.source.max[1] - params.source.min[1],
        params.source.max[2] - params.source.min[2],
      ];
      const proposed: Command[] = [];
      let bounds: IntAabb = {
        min: [...params.source.min],
        max: [...params.source.max],
      };
      // Copies start one delta away: the source's own position is not
      // re-copied, so `count` means `count` new placements.
      for (let index = 1; index <= params.count; index += 1) {
        const delta: Vec3i = [
          params.delta[0] * index,
          params.delta[1] * index,
          params.delta[2] * index,
        ];
        const destination: Vec3i = [
          params.source.min[0] + delta[0],
          params.source.min[1] + delta[1],
          params.source.min[2] + delta[2],
        ];
        const copy: IntAabb = {
          min: destination,
          max: [
            destination[0] + size[0],
            destination[1] + size[1],
            destination[2] + size[2],
          ],
        };
        proposed.push(commands.copyRegion(params.source, destination));
        bounds = unionAabb(bounds, copy);
      }
      return { commands: proposed, bounds };
    },
  };
