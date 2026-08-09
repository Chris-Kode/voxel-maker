import type { GeneratorDefinition, GeneratorContext } from "../generator.js";
import { createCommandFactory } from "../generator.js";
import type { Command } from "@voxel-maker/commands";
import type { IntAabb, ShapeAxis, Vec3i } from "../geometry.js";
import { boxFromMinSize, unionAabb, type Vec3Size } from "../geometry.js";
import { createSeededRandom } from "../prng.js";
import { AXIS_SCHEMA, VEC3I_SCHEMA, boundedIntSchema } from "../schemas.js";

/**
 * Linkage generator (plan S14.5, ticket #37): a deterministic chain of
 * `count` identical segment boxes (links), each one generic
 * `voxel.fillBox`. `straight` lays links end to end along one axis;
 * `zigzag` alternates a perpendicular offset; `seeded` picks each
 * segment's perpendicular offset from the explicit seed, so the same
 * seed always yields the identical chain while different seeds vary it.
 */

export type LinkagePattern = "straight" | "zigzag" | "seeded";

export type LinkageParams = {
  /** Min corner of the first link. */
  readonly start: Vec3i;
  /** Axis the chain runs along. */
  readonly axis: ShapeAxis;
  /** Number of links (1..64). */
  readonly count: number;
  /** Link length along the run axis in voxels. */
  readonly segmentLength: number;
  /** Link cross-section in voxels. */
  readonly thickness: number;
  /** Bend pattern. */
  readonly pattern: LinkagePattern;
};

export const MAX_LINKAGE_COUNT = 64;
export const MAX_LINKAGE_LENGTH = 128;
export const MAX_LINKAGE_THICKNESS = 16;

/** Run-axis index of a ShapeAxis. */
function axisIndex(axis: ShapeAxis): number {
  if (axis === "x") return 0;
  if (axis === "y") return 1;
  return 2;
}

/** The primary perpendicular axis used for zigzag/seeded bends. */
function bendAxis(axis: ShapeAxis): ShapeAxis {
  if (axis === "x") return "y";
  if (axis === "y") return "x";
  return "x";
}

/** Size triple of one link oriented along `axis`. */
function linkSize(
  axis: ShapeAxis,
  length: number,
  thickness: number,
): Vec3Size {
  if (axis === "x") return [length, thickness, thickness];
  if (axis === "y") return [thickness, length, thickness];
  return [thickness, thickness, length];
}

export const LINKAGE_GENERATOR: GeneratorDefinition<LinkageParams> = {
  name: "generator.linkage",
  version: 1,
  description:
    "Builds a deterministic chain of segment boxes (links) along one axis with straight, zigzag, or seeded bends (voxel.fillBox per link).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      start: VEC3I_SCHEMA,
      axis: AXIS_SCHEMA,
      count: boundedIntSchema(1, MAX_LINKAGE_COUNT),
      segmentLength: boundedIntSchema(1, MAX_LINKAGE_LENGTH),
      thickness: boundedIntSchema(1, MAX_LINKAGE_THICKNESS),
      pattern: {
        type: "string",
        enum: ["straight", "zigzag", "seeded"],
      },
    },
    required: [
      "start",
      "axis",
      "count",
      "segmentLength",
      "pattern",
      "thickness",
    ],
  },
  parse(value: unknown): LinkageParams {
    return value as LinkageParams;
  },
  propose(params: LinkageParams, context: GeneratorContext) {
    const commands = createCommandFactory(this, params, context);
    const random =
      params.pattern === "seeded"
        ? createSeededRandom(`${this.name}:${context.seed}`)
        : undefined;
    const bend = bendAxis(params.axis);
    const bendIndex = axisIndex(bend);
    const runIndex = axisIndex(params.axis);
    const proposed: Command[] = [];
    let bounds: IntAabb | undefined;
    for (let index = 0; index < params.count; index += 1) {
      const min: [number, number, number] = [
        params.start[0],
        params.start[1],
        params.start[2],
      ];
      min[runIndex] =
        (params.start[runIndex] as number) + index * params.segmentLength;
      if (params.pattern === "zigzag") {
        min[bendIndex] =
          (params.start[bendIndex] as number) + (index % 2) * params.thickness;
      } else if (params.pattern === "seeded" && random !== undefined) {
        min[bendIndex] =
          (params.start[bendIndex] as number) +
          (random() < 0.5 ? 0 : params.thickness);
      }
      const link = boxFromMinSize(
        min,
        linkSize(params.axis, params.segmentLength, params.thickness),
      );
      proposed.push(commands.fillBox(link));
      bounds = bounds === undefined ? link : unionAabb(bounds, link);
    }
    return { commands: proposed, bounds: bounds as IntAabb };
  },
};
