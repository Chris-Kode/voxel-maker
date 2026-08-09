import type { GeneratorDefinition, GeneratorContext } from "../generator.js";
import { createCommandFactory } from "../generator.js";
import type { Command } from "@voxel-maker/commands";
import type { IntAabb, ShapeAxis, Vec3i } from "../geometry.js";
import { unionAabb } from "../geometry.js";
import { AXIS_SCHEMA, VEC3I_SCHEMA, boundedIntSchema } from "../schemas.js";
import { WorkspaceError } from "@voxel-maker/shared";

/**
 * Wheel generator (plan S14.5, ticket #37): a deterministic wheel built
 * from one generic `voxel.fillCylinder` tire, an optional hub cylinder,
 * and four cardinal box spokes (`voxel.fillBox`). The wheel is aligned to
 * one axis and centered on an integer point; every dimension is bounded
 * by the schema maxima, and cost preflight covers all three parts.
 */

export type WheelParams = {
  /** Center point of the wheel. */
  readonly center: Vec3i;
  /** Axis the wheel rotates around. */
  readonly axis: ShapeAxis;
  /** Tire radius in voxels (1..256). */
  readonly radius: number;
  /** Wheel thickness in voxels along the axis (1..64). */
  readonly thickness: number;
  /** Hub radius in voxels; 0 omits the hub cylinder. */
  readonly hubRadius: number;
  /** Spoke count: 0 (solid tire) or 4 cardinal box spokes. */
  readonly spokeCount: number;
  /** Half-width of each cardinal spoke in voxels (1..8). */
  readonly spokeWidth: number;
};

export const MAX_WHEEL_RADIUS = 256;
export const MAX_WHEEL_THICKNESS = 64;
export const MAX_SPOKE_WIDTH = 8;

/** Axis component of the wheel's extent along the rotation axis. */
function axisExtent(
  center: Vec3i,
  axis: ShapeAxis,
  thickness: number,
): [number, number] {
  const coordinate = center[axisIndex(axis)] as number;
  return [coordinate, coordinate + thickness];
}

function axisIndex(axis: ShapeAxis): number {
  if (axis === "x") return 0;
  if (axis === "y") return 1;
  return 2;
}

/** Half-open box for one cardinal spoke along `along` with sign. */
function spokeBox(
  center: Vec3i,
  axis: ShapeAxis,
  along: ShapeAxis,
  sign: 1 | -1,
  hubRadius: number,
  radius: number,
  spokeWidth: number,
  thickness: number,
): IntAabb {
  const min = [...center];
  const max = [...center];
  const alongIndex = axisIndex(along);
  const [axisMin, axisMax] = axisExtent(center, axis, thickness);
  min[axisIndex(axis)] = axisMin;
  max[axisIndex(axis)] = axisMax;
  const cross = perpendicularAxis(axis, along);
  min[axisIndex(cross)] = (center[axisIndex(cross)] as number) - spokeWidth;
  max[axisIndex(cross)] = (center[axisIndex(cross)] as number) + spokeWidth + 1;
  if (sign === 1) {
    min[alongIndex] = (center[alongIndex] as number) + hubRadius;
    max[alongIndex] = (center[alongIndex] as number) + radius + 1;
  } else {
    min[alongIndex] = (center[alongIndex] as number) - radius;
    max[alongIndex] = (center[alongIndex] as number) - hubRadius + 1;
  }
  return {
    min: [min[0] as number, min[1] as number, min[2] as number],
    max: [max[0] as number, max[1] as number, max[2] as number],
  };
}

/** The horizontal axis perpendicular to both the wheel axis and `along`. */
function perpendicularAxis(axis: ShapeAxis, along: ShapeAxis): ShapeAxis {
  if (axis === "x") return along === "y" ? "z" : "y";
  if (axis === "y") return along === "x" ? "z" : "x";
  return along === "x" ? "y" : "x";
}

/** The two horizontal axes of a wheel aligned to `axis`. */
function horizontalAxes(axis: ShapeAxis): readonly [ShapeAxis, ShapeAxis] {
  if (axis === "x") return ["y", "z"];
  if (axis === "y") return ["x", "z"];
  return ["x", "y"];
}

export const WHEEL_GENERATOR: GeneratorDefinition<WheelParams> = {
  name: "generator.wheel",
  version: 1,
  description:
    "Builds a deterministic wheel from a tire cylinder, optional hub cylinder, and four cardinal box spokes (voxel.fillCylinder and voxel.fillBox).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      center: VEC3I_SCHEMA,
      axis: AXIS_SCHEMA,
      radius: boundedIntSchema(1, MAX_WHEEL_RADIUS),
      thickness: boundedIntSchema(1, MAX_WHEEL_THICKNESS),
      hubRadius: boundedIntSchema(0, 1_024),
      spokeCount: { type: "integer", enum: [0, 4] },
      spokeWidth: boundedIntSchema(1, MAX_SPOKE_WIDTH),
    },
    required: [
      "center",
      "axis",
      "radius",
      "thickness",
      "hubRadius",
      "spokeCount",
      "spokeWidth",
    ],
  },
  parse(value: unknown): WheelParams {
    const params = value as WheelParams;
    if (params.hubRadius > params.radius) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_GENERATOR_PARAMS",
        message: "hubRadius must not exceed radius",
        path: ["hubRadius"],
      });
    }
    return params;
  },
  propose(params: WheelParams, context: GeneratorContext) {
    const commands = createCommandFactory(this, params, context);
    const proposed: Command[] = [];
    const [alongA, alongB] = horizontalAxes(params.axis);
    const tire = cylinderAabb(
      params.center,
      params.axis,
      params.radius,
      params.thickness,
    );
    proposed.push(
      commands.fillCylinder(
        params.center,
        params.radius,
        params.thickness,
        params.axis,
      ),
    );
    if (params.hubRadius > 0) {
      proposed.push(
        commands.fillCylinder(
          params.center,
          params.hubRadius,
          params.thickness,
          params.axis,
        ),
      );
    }
    let bounds = tire;
    if (params.spokeCount === 4) {
      for (const along of [alongA, alongB]) {
        for (const sign of [1, -1] as const) {
          const spoke = spokeBox(
            params.center,
            params.axis,
            along,
            sign,
            params.hubRadius,
            params.radius,
            params.spokeWidth,
            params.thickness,
          );
          proposed.push(commands.fillBox(spoke));
          bounds = unionAabb(bounds, spoke);
        }
      }
    }
    return { commands: proposed, bounds };
  },
};

/** Bounding box of a cylinder (mirrors the engine voxelization AABB). */
function cylinderAabb(
  center: Vec3i,
  axis: ShapeAxis,
  radius: number,
  thickness: number,
): IntAabb {
  const min = [...center];
  const max = [...center];
  const [axisMin, axisMax] = axisExtent(center, axis, thickness);
  min[axisIndex(axis)] = axisMin;
  max[axisIndex(axis)] = axisMax;
  for (const horizontal of horizontalAxes(axis)) {
    min[axisIndex(horizontal)] =
      (center[axisIndex(horizontal)] as number) - radius;
    max[axisIndex(horizontal)] =
      (center[axisIndex(horizontal)] as number) + radius + 1;
  }
  return {
    min: [min[0] as number, min[1] as number, min[2] as number],
    max: [max[0] as number, max[1] as number, max[2] as number],
  };
}
