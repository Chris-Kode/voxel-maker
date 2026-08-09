import type { GeneratorDefinition, GeneratorContext } from "../generator.js";
import { createCommandFactory } from "../generator.js";
import type { Command } from "@voxel-maker/commands";
import type { IntAabb, Vec3i } from "../geometry.js";
import { boxFromMinSize, unionAabb } from "../geometry.js";
import { VEC3I_SCHEMA, boundedIntSchema } from "../schemas.js";

/**
 * Roof generator (plan S14.5, ticket #37): a deterministic roof slab over
 * a rectangular footprint. Three styles, all built from generic
 * `voxel.fillBox` layers:
 * - `flat`: one slab of `thickness` voxels;
 * - `gable`: layers shrinking along the width axis, forming a ridge that
 *   runs along the depth axis;
 * - `pyramid`: layers shrinking on both horizontal axes.
 * Layer counts are bounded by the footprint dimensions.
 */

export type RoofStyle = "flat" | "gable" | "pyramid";

export type RoofParams = {
  /** Min corner of the roof footprint. */
  readonly min: Vec3i;
  /** Footprint size in voxels along x and z (each 1..2048). */
  readonly width: number;
  readonly depth: number;
  /** Roof style. */
  readonly style: RoofStyle;
  /** Slab thickness for the flat style (1..16). */
  readonly thickness: number;
};

export const MAX_ROOF_DIMENSION = 2_048;
export const MAX_ROOF_THICKNESS = 16;

export const ROOF_GENERATOR: GeneratorDefinition<RoofParams> = {
  name: "generator.roof",
  version: 1,
  description:
    "Builds a flat, gable, or pyramid roof over a rectangular footprint from voxel.fillBox layers.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      min: VEC3I_SCHEMA,
      width: boundedIntSchema(1, MAX_ROOF_DIMENSION),
      depth: boundedIntSchema(1, MAX_ROOF_DIMENSION),
      style: { type: "string", enum: ["flat", "gable", "pyramid"] },
      thickness: boundedIntSchema(1, MAX_ROOF_THICKNESS),
    },
    required: ["min", "width", "depth", "style", "thickness"],
  },
  parse(value: unknown): RoofParams {
    return value as RoofParams;
  },
  propose(params: RoofParams, context: GeneratorContext) {
    const commands = createCommandFactory(this, params, context);
    const proposed: Command[] = [];
    let bounds: IntAabb | undefined;
    if (params.style === "flat") {
      const slab = boxFromMinSize(params.min, [
        params.width,
        params.thickness,
        params.depth,
      ]);
      proposed.push(commands.fillBox(slab));
      bounds = slab;
    } else {
      const layerCount =
        params.style === "pyramid"
          ? Math.max(ceilHalf(params.width), ceilHalf(params.depth))
          : ceilHalf(params.width);
      for (let layer = 0; layer < layerCount; layer += 1) {
        const shrink = layer;
        const layerWidth = Math.max(1, params.width - 2 * shrink);
        const layerDepth =
          params.style === "pyramid"
            ? Math.max(1, params.depth - 2 * shrink)
            : params.depth;
        const step = boxFromMinSize(
          [
            params.min[0] + shrink,
            params.min[1] + layer,
            params.min[2] + shrink,
          ],
          [layerWidth, 1, layerDepth],
        );
        proposed.push(commands.fillBox(step));
        bounds = bounds === undefined ? step : unionAabb(bounds, step);
      }
    }
    return { commands: proposed, bounds: bounds as IntAabb };
  },
};

/** Ceiling of `value / 2` (number of shrinking layers for a side). */
function ceilHalf(value: number): number {
  return Math.ceil(value / 2);
}
