import type { JsonValue, VolumeId } from "@voxel-maker/shared";
import type { Vec3, Vec3i } from "@voxel-maker/math";
import {
  invalidArgument,
  outputSchema,
  type ToolContract,
} from "../contract.js";
import { requireVolume, requireVolumeView } from "./helpers.js";
import type { ToolContext } from "./context.js";

/**
 * Ray casting (plan S11.4): deterministic voxel traversal (Amanatides and
 * Woo grid stepping) against one volume or every volume of the document.
 * The first non-empty voxel along the ray wins; ties resolve to the
 * earliest volume in document record order. Traversal is bounded by
 * `maxSteps` (default 4096, input may lower it) so hostile rays can never
 * loop or scan unboundedly.
 */

/** `raycast` contract. */
export const RAYCAST_CONTRACT: ToolContract = {
  name: "raycast",
  version: 1,
  capability: "inspect",
  description:
    "Casts a ray from a world-space origin along a nonzero direction and returns the first occupied voxel hit (volume, coordinate, material, distance). Without volumeId every volume is searched; traversal is capped by maxSteps.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      origin: {
        type: "array",
        items: { type: "number" },
        minItems: 3,
        maxItems: 3,
        description: "World-space ray origin [x, y, z]",
      },
      direction: {
        type: "array",
        items: { type: "number" },
        minItems: 3,
        maxItems: 3,
        description:
          "Nonzero ray direction [x, y, z]; distance is measured along it",
      },
      volumeId: {
        type: "string",
        description: "Restrict to one volume (default: every volume)",
      },
      maxSteps: {
        type: "integer",
        minimum: 1,
        description: "Traversal step cap (default 4096)",
      },
      maxDistance: {
        type: "number",
        minimum: 0,
        description: "Optional distance cap in world units",
      },
    },
    required: ["origin", "direction"],
  },
  outputSchema: outputSchema(
    "raycast",
    {
      hit: { type: "boolean" },
      volumeId: { type: "string" },
      coordinate: {
        type: "array",
        items: { type: "integer" },
        minItems: 3,
        maxItems: 3,
      },
      material: { type: "integer", minimum: 0 },
      distance: { type: "number", minimum: 0 },
      steps: { type: "integer", minimum: 0 },
      stepLimit: { type: "boolean" },
      searchedVolumes: { type: "array", items: { type: "string" } },
    },
    ["hit", "steps", "stepLimit", "searchedVolumes"],
  ),
};

interface RayHit {
  readonly volumeId: VolumeId;
  readonly coordinate: Vec3i;
  readonly material: number;
  readonly distance: number;
}

/** Steps one volume and returns the first hit, or undefined. */
function firstHitInVolume(
  ctx: ToolContext,
  volumeId: VolumeId,
  origin: Vec3,
  direction: Vec3,
  maxSteps: number,
  maxDistance: number | undefined,
): {
  readonly hit: RayHit | undefined;
  readonly steps: number;
  readonly stepLimit: boolean;
} {
  const { store } = ctx;
  const view = requireVolumeView(store, volumeId);
  let voxel: Vec3i = [
    Math.floor(origin[0]),
    Math.floor(origin[1]),
    Math.floor(origin[2]),
  ];
  const step: Vec3i = [
    direction[0] > 0 ? 1 : direction[0] < 0 ? -1 : 0,
    direction[1] > 0 ? 1 : direction[1] < 0 ? -1 : 0,
    direction[2] > 0 ? 1 : direction[2] < 0 ? -1 : 0,
  ];
  const tDelta: Vec3 = [
    direction[0] === 0 ? Infinity : Math.abs(1 / direction[0]),
    direction[1] === 0 ? Infinity : Math.abs(1 / direction[1]),
    direction[2] === 0 ? Infinity : Math.abs(1 / direction[2]),
  ];
  let tMax: Vec3 = [
    direction[0] === 0
      ? Infinity
      : (step[0] > 0 ? voxel[0] + 1 - origin[0] : origin[0] - voxel[0]) /
        Math.abs(direction[0]),
    direction[1] === 0
      ? Infinity
      : (step[1] > 0 ? voxel[1] + 1 - origin[1] : origin[1] - voxel[1]) /
        Math.abs(direction[1]),
    direction[2] === 0
      ? Infinity
      : (step[2] > 0 ? voxel[2] + 1 - origin[2] : origin[2] - voxel[2]) /
        Math.abs(direction[2]),
  ];
  let t = 0;
  for (let count = 0; count < maxSteps; count += 1) {
    const material = view.getVoxel(voxel);
    if (material !== 0 && (maxDistance === undefined || t <= maxDistance)) {
      return {
        hit: { volumeId, coordinate: [...voxel], material, distance: t },
        steps: count + 1,
        stepLimit: false,
      };
    }
    if (tMax[0] <= tMax[1] && tMax[0] <= tMax[2]) {
      if (tMax[0] === Infinity) break;
      voxel = [voxel[0] + step[0], voxel[1], voxel[2]];
      t = tMax[0];
      tMax = [tMax[0] + tDelta[0], tMax[1], tMax[2]];
    } else if (tMax[1] <= tMax[2]) {
      voxel = [voxel[0], voxel[1] + step[1], voxel[2]];
      t = tMax[1];
      tMax = [tMax[0], tMax[1] + tDelta[1], tMax[2]];
    } else {
      voxel = [voxel[0], voxel[1], voxel[2] + step[2]];
      t = tMax[2];
      tMax = [tMax[0], tMax[1], tMax[2] + tDelta[2]];
    }
    if (maxDistance !== undefined && t > maxDistance) break;
  }
  return { hit: undefined, steps: maxSteps, stepLimit: true };
}

export function raycast(
  ctx: ToolContext,
  args: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const { store } = ctx;
  const document = store.getDocument();
  const record = args as Readonly<Record<string, JsonValue>>;
  const origin = record.origin as Vec3;
  const direction = record.direction as Vec3;
  const squaredLength =
    direction[0] * direction[0] +
    direction[1] * direction[1] +
    direction[2] * direction[2];
  if (!(squaredLength > 0) || !Number.isFinite(squaredLength)) {
    invalidArgument("direction must be a nonzero finite vector", ["direction"]);
  }
  const maxStepsInput = record.maxSteps;
  const maxSteps =
    maxStepsInput === undefined
      ? ctx.limits.maxRaySteps
      : (maxStepsInput as number);
  if (maxSteps > ctx.limits.maxRaySteps) {
    invalidArgument(`maxSteps must be <= ${String(ctx.limits.maxRaySteps)}`, [
      "maxSteps",
    ]);
  }
  const maxDistance =
    record.maxDistance === undefined
      ? undefined
      : (record.maxDistance as number);

  const volumeIds =
    record.volumeId === undefined
      ? (Object.keys(document.volumes) as VolumeId[])
      : [record.volumeId as string as VolumeId];
  for (const volumeId of volumeIds) requireVolume(document, volumeId);

  let best: RayHit | undefined;
  let totalSteps = 0;
  let stepLimit = false;
  for (const volumeId of volumeIds) {
    const result = firstHitInVolume(
      ctx,
      volumeId,
      origin,
      direction,
      maxSteps,
      maxDistance,
    );
    totalSteps += result.steps;
    if (result.stepLimit) stepLimit = true;
    if (result.hit !== undefined) {
      if (best === undefined || result.hit.distance < best.distance) {
        best = result.hit;
      }
    }
  }
  if (best === undefined) {
    return {
      hit: false,
      steps: totalSteps,
      stepLimit,
      searchedVolumes: volumeIds,
    };
  }
  return {
    hit: true,
    volumeId: best.volumeId,
    coordinate: [...best.coordinate],
    material: best.material,
    distance: best.distance,
    steps: totalSteps,
    stepLimit,
    searchedVolumes: volumeIds,
  };
}
