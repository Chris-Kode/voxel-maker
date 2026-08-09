import {
  VOXEL_COPY_REGION_COMMAND,
  VOXEL_DELETE_REGION_COMMAND,
  VOXEL_FILL_BOX_COMMAND,
  VOXEL_FILL_CYLINDER_COMMAND,
  VOXEL_FILL_SPHERE_COMMAND,
  VOXEL_MIRROR_REGION_COMMAND,
  VOXEL_REMOVE_BATCH_COMMAND,
  VOXEL_REPLACE_MATERIAL_COMMAND,
  VOXEL_ROTATE_REGION_COMMAND,
  VOXEL_SET_BATCH_COMMAND,
  VOXEL_TRANSLATE_REGION_COMMAND,
  VOLUME_CREATE_COMMAND,
  type Command,
} from "@voxel-maker/commands";
import type { JsonValue } from "@voxel-maker/shared";
import { boxVolume, isVec3i, type IntAabb } from "./geometry.js";

/**
 * Payload-only proposed-voxel estimator used by generator cost preflight
 * (plan S14.3). The formulas deliberately mirror the agent package's
 * `estimateVoxelDelta` (the single source the preview session enforces),
 * restricted to the command types generators emit; the lifecycle tests
 * pin the two implementations together by asserting that a proposal's
 * preflight total equals the preview session's enforced cumulative
 * estimate after staging. Malformed payloads estimate 0 and are rejected
 * by command validation instead.
 */
export function estimateCommandVoxels(command: Command): number {
  const payload = command.payload as
    | Readonly<Record<string, JsonValue>>
    | undefined;
  if (payload === undefined) return 0;
  switch (command.type) {
    case VOXEL_SET_BATCH_COMMAND:
      return arrayLength(payload.entries);
    case VOXEL_REMOVE_BATCH_COMMAND:
      return arrayLength(payload.coordinates);
    case VOXEL_FILL_BOX_COMMAND:
      return regionVolume(payload.region);
    case VOXEL_FILL_SPHERE_COMMAND:
      return sphereEstimate(finiteNumber(payload.radius));
    case VOXEL_FILL_CYLINDER_COMMAND:
      return cylinderEstimate(
        finiteNumber(payload.radius),
        finiteNumber(payload.height),
      );
    case VOXEL_REPLACE_MATERIAL_COMMAND:
      // Generators never emit the store-dependent regionless form; keep
      // the payload-only bound (0) consistent with a missing volume.
      return regionVolume(payload.region);
    case VOXEL_COPY_REGION_COMMAND:
      return 2 * regionVolume(payload.source);
    case VOXEL_DELETE_REGION_COMMAND:
    case VOXEL_TRANSLATE_REGION_COMMAND:
    case VOXEL_ROTATE_REGION_COMMAND:
    case VOXEL_MIRROR_REGION_COMMAND:
      return regionVolume(payload.region);
    case VOLUME_CREATE_COMMAND:
      return arrayLength(payload.entries);
    default:
      return 0;
  }
}

/** Cumulative proposed-voxel estimate of a proposal's command list. */
export function estimateCommandsVoxels(commands: readonly Command[]): number {
  let total = 0;
  for (const command of commands) total += estimateCommandVoxels(command);
  return total;
}

function arrayLength(value: JsonValue | undefined): number {
  return Array.isArray(value) ? value.length : 0;
}

function finiteNumber(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function regionVolume(value: JsonValue | undefined): number {
  const region = parseRegion(value);
  return region === undefined ? 0 : boxVolume(region);
}

function parseRegion(value: JsonValue | undefined): IntAabb | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  const min = record.min;
  const max = record.max;
  if (!isVec3i(min) || !isVec3i(max)) return undefined;
  if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) return undefined;
  return { min, max };
}

/** Volume of the axis-aligned box that contains a sphere of `radius`. */
function sphereEstimate(radius: number): number {
  const diameter = 2 * Math.ceil(radius) + 1;
  return diameter * diameter * diameter;
}

/** Volume of the axis-aligned box that contains a cylinder. */
function cylinderEstimate(radius: number, height: number): number {
  const diameter = 2 * Math.ceil(radius) + 1;
  return diameter * diameter * Math.max(1, Math.ceil(height));
}
