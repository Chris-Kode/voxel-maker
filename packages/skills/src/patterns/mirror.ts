import type { GeneratorDefinition, GeneratorContext } from "../generator.js";
import { createCommandFactory } from "../generator.js";
import type { IntAabb, ShapeAxis, Vec3i } from "../geometry.js";
import { AXIS_SCHEMA, REGION_SCHEMA, requireValidRegion } from "../schemas.js";

/**
 * Mirror generator (plan S14.4, ticket #37): mirrors an existing region
 * across its own center plane along one axis, emitting one generic
 * `voxel.mirrorRegion` command (the deterministic region transform from
 * ticket #9). Deterministic by construction: the proposal depends only
 * on the validated params and the explicit seed.
 */

export type MirrorParams = {
  /** Half-open region to mirror in place. */
  readonly region: IntAabb;
  /** Axis perpendicular to the mirror plane. */
  readonly axis: ShapeAxis;
};

export const MIRROR_GENERATOR: GeneratorDefinition<MirrorParams> = {
  name: "generator.mirror",
  version: 1,
  description:
    "Mirrors an existing voxel region across its center plane along one axis (one voxel.mirrorRegion command).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      region: REGION_SCHEMA,
      axis: AXIS_SCHEMA,
    },
    required: ["region", "axis"],
  },
  parse(value: unknown): MirrorParams {
    const params = value as MirrorParams;
    requireValidRegion(params.region, ["region"]);
    return params;
  },
  propose(params: MirrorParams, context: GeneratorContext) {
    const commands = createCommandFactory(this, params, context);
    return {
      commands: [commands.mirrorRegion(params.region, params.axis)],
      bounds: {
        min: [...params.region.min] as Vec3i,
        max: [...params.region.max] as Vec3i,
      },
    };
  },
};
