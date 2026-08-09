import {
  decodeVolumeEntries,
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
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { JsonValue, VolumeId } from "@voxel-maker/shared";
import { isVec3i } from "../tools/helpers.js";
import { cylinderEstimate, regionVolume, sphereEstimate } from "./parse.js";

/**
 * Conservative proposed-voxel estimate of one command (plan S11.10).
 * This is the SINGLE source of voxel estimates: mutation tools report it
 * in their responses and the preview session enforces it cumulatively, so
 * a proposal can never be budgeted more loosely than it was presented.
 * Region operations use the region volume (an upper bound; copyRegion
 * touches source and destination, hence 2x); replaceMaterial without a
 * region uses the volume's occupied count; everything else reports 0.
 * Malformed payloads estimate 0 and are rejected by command validation
 * instead.
 */
export function estimateVoxelDelta(
  command: Command,
  store: DocumentStoreRead,
): number {
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
      return regionVolumeOf(payload.region);
    case VOXEL_FILL_SPHERE_COMMAND:
      return sphereEstimate(finiteNumber(payload.radius));
    case VOXEL_FILL_CYLINDER_COMMAND:
      return cylinderEstimate(
        finiteNumber(payload.radius),
        finiteNumber(payload.height),
      );
    case VOXEL_REPLACE_MATERIAL_COMMAND: {
      const region = payload.region;
      if (region !== undefined) return regionVolumeOf(region);
      const volumeId =
        typeof payload.volumeId === "string" ? payload.volumeId : "";
      const view = store.getVolume(volumeId as VolumeId);
      return view === undefined ? 0 : view.occupiedCount();
    }
    case VOXEL_COPY_REGION_COMMAND:
      return 2 * regionVolumeOf(payload.source);
    case VOXEL_DELETE_REGION_COMMAND:
    case VOXEL_TRANSLATE_REGION_COMMAND:
    case VOXEL_ROTATE_REGION_COMMAND:
    case VOXEL_MIRROR_REGION_COMMAND:
      return regionVolumeOf(payload.region);
    case VOLUME_CREATE_COMMAND:
      return volumeEntriesCount(payload.entries);
    default:
      return 0;
  }
}

/** Length of a payload array, or 0 for malformed values. */
function arrayLength(value: JsonValue | undefined): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Volume of a payload region, or 0 for malformed values. */
function regionVolumeOf(value: JsonValue | undefined): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 0;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  const min = record.min;
  const max = record.max;
  if (!isVec3i(min) || !isVec3i(max)) {
    return 0;
  }
  const minArr = min;
  const maxArr = max;
  if (minArr[0] > maxArr[0] || minArr[1] > maxArr[1] || minArr[2] > maxArr[2]) {
    return 0;
  }
  return regionVolume({ min: minArr, max: maxArr });
}

/** Finite number or 0 for malformed values. */
function finiteNumber(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Decoded entry count of a volume.create payload, or 0. */
function volumeEntriesCount(value: JsonValue | undefined): number {
  if (value === undefined) return 0;
  try {
    return decodeVolumeEntries(value, []).length;
  } catch {
    return 0;
  }
}
