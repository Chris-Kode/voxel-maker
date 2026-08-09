import type { GeneratorDefinition, GeneratorContext } from "../generator.js";
import { createCommandFactory } from "../generator.js";
import type { Command } from "@voxel-maker/commands";
import type { IntAabb, ShapeAxis, Vec3i } from "../geometry.js";
import {
  deterministicCos,
  deterministicSin,
  roundToInt,
  unionAabb,
} from "../geometry.js";
import {
  AXIS_SCHEMA,
  REGION_SCHEMA,
  VEC3I_SCHEMA,
  boundedIntSchema,
  requireValidRegion,
} from "../schemas.js";

/**
 * Radial repeat generator (plan S14.4, ticket #37): places `count` copies
 * of a source region around a center point in the plane perpendicular to
 * one axis, at evenly spaced angles. Copies stay axis-aligned (only
 * integer positions are used), so each copy is one generic
 * `voxel.copyRegion` command. Positions use IEEE `cos`/`sin` and
 * `Math.round`, which are deterministic on every platform; the same
 * params and seed therefore always propose the identical commands.
 */

export type RadialRepeatParams = {
  /** Half-open source region copied around the center. */
  readonly source: IntAabb;
  /** Center point of the radial arrangement. */
  readonly center: Vec3i;
  /** Axis perpendicular to the arrangement plane. */
  readonly axis: ShapeAxis;
  /** Number of copies evenly spaced around the center. */
  readonly count: number;
  /** Circle radius in voxels. */
  readonly radius: number;
};

export const MAX_RADIAL_REPEAT_COUNT = 64;

/** Full offset vector from plane coordinates (a along u, b along v). */
function planeOffset(axis: ShapeAxis, a: number, b: number): Vec3i {
  if (axis === "x") return [0, a, b];
  if (axis === "y") return [a, 0, b];
  return [a, b, 0];
}

export const RADIAL_REPEAT_GENERATOR: GeneratorDefinition<RadialRepeatParams> =
  {
    name: "generator.radialRepeat",
    version: 1,
    description:
      "Places count copies of a source region around a center on evenly spaced angles (one voxel.copyRegion per copy).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: REGION_SCHEMA,
        center: VEC3I_SCHEMA,
        axis: AXIS_SCHEMA,
        count: boundedIntSchema(2, MAX_RADIAL_REPEAT_COUNT),
        radius: boundedIntSchema(1, 1_024),
      },
      required: ["source", "center", "axis", "count", "radius"],
    },
    parse(value: unknown): RadialRepeatParams {
      const params = value as RadialRepeatParams;
      requireValidRegion(params.source, ["source"]);
      return params;
    },
    propose(params: RadialRepeatParams, context: GeneratorContext) {
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
      for (let index = 0; index < params.count; index += 1) {
        const angle = (2 * Math.PI * index) / params.count;
        const du = roundToInt(params.radius * deterministicCos(angle));
        const dv = roundToInt(params.radius * deterministicSin(angle));
        const offset = planeOffset(params.axis, du, dv);
        const destination: Vec3i = [
          params.center[0] + offset[0],
          params.center[1] + offset[1],
          params.center[2] + offset[2],
        ];
        // The arrangement-axis coordinate of every copy equals the center's,
        // so all copies lie in the plane through the center perpendicular to
        // the axis.
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
