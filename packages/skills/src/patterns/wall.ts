import type { GeneratorDefinition, GeneratorContext } from "../generator.js";
import { createCommandFactory } from "../generator.js";
import type { Command } from "@voxel-maker/commands";
import type { IntAabb, Vec3i } from "../geometry.js";
import { boxFromMinSize } from "../geometry.js";
import {
  REGION_SCHEMA,
  VEC3I_SCHEMA,
  VEC3_SIZE_SCHEMA,
  invalidGeneratorParams,
  regionInside,
  requireValidRegion,
} from "../schemas.js";

/**
 * Wall generator (plan S14.5, ticket #37): a solid rectangular wall as
 * one generic `voxel.fillBox` command, optionally with a rectangular
 * opening (door/window) cut by one `voxel.deleteRegion` command. The
 * opening must lie strictly inside the wall, so the proposal is always
 * valid; cost preflight counts the wall plus the cut opening.
 */

export type WallParams = {
  /** Min corner of the wall. */
  readonly min: Vec3i;
  /** Wall size in voxels (width, height, depth), each 1..2048. */
  readonly size: Vec3i;
  /** Optional half-open opening strictly inside the wall. */
  readonly opening?: IntAabb | null;
};

export const WALL_GENERATOR: GeneratorDefinition<WallParams> = {
  name: "generator.wall",
  version: 1,
  description:
    "Builds a solid rectangular wall, optionally with one rectangular opening (voxel.fillBox plus voxel.deleteRegion).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      min: VEC3I_SCHEMA,
      size: VEC3_SIZE_SCHEMA,
      opening: {
        anyOf: [REGION_SCHEMA, { type: "null" }],
      },
    },
    required: ["min", "size"],
  },
  parse(value: unknown): WallParams {
    const params = value as WallParams;
    const wall = boxFromMinSize(params.min, params.size);
    requireValidRegion(wall, ["min"]);
    if (params.opening !== undefined && params.opening !== null) {
      requireValidRegion(params.opening, ["opening"]);
      if (!regionInside(params.opening, wall)) {
        invalidGeneratorParams("opening must lie strictly inside the wall", [
          "opening",
        ]);
      }
    }
    return params;
  },
  propose(params: WallParams, context: GeneratorContext) {
    const commands = createCommandFactory(this, params, context);
    const wall = boxFromMinSize(params.min, params.size);
    const proposed: Command[] = [commands.fillBox(wall)];
    if (params.opening !== undefined && params.opening !== null) {
      proposed.push(commands.deleteRegion(params.opening));
    }
    return { commands: proposed, bounds: wall };
  },
};
