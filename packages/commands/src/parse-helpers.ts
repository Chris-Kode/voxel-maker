import {
  WorkspaceError,
  materialId,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import type { DocumentLimits } from "@voxel-maker/model";

/**
 * Shared parse/validation helpers for command handlers (plan 4.1). Every
 * handler bounds untrusted input in `parse` before any allocation; these
 * helpers keep the rules identical across command families.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseVolumeId(
  value: unknown,
  path: readonly (string | number)[],
): VolumeId {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_ID",
      message:
        "Identifiers must be non-empty strings of at most 128 characters",
      path,
    });
  }
  return value as VolumeId;
}

export function parseCoordinate(
  value: unknown,
  limits: DocumentLimits,
  path: readonly (string | number)[],
): Vec3i {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_VECTOR",
      message: "Expected a 3-component integer vector",
      path,
    });
  }
  const raw = value as unknown[];
  const components: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const component = raw[axis];
    if (
      typeof component !== "number" ||
      !Number.isInteger(component) ||
      Math.abs(component) > limits.maxVoxelCoordinate
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_VOXEL_COORDINATE",
        message: `Voxel coordinates must be integers within +-${String(limits.maxVoxelCoordinate)}`,
        path: [...path, axis],
        context: { value: String(component) },
      });
    }
    components.push(component);
  }
  return [
    components[0] as number,
    components[1] as number,
    components[2] as number,
  ];
}

export function parseMaterial(
  value: unknown,
  path: readonly (string | number)[],
): MaterialId {
  if (typeof value !== "number") {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_MATERIAL_ID",
      message: "Material must be an integer from 1 through 65535",
      path,
      context: { value: String(value) },
    });
  }
  return materialId(value);
}

export function missingVolume(volumeId: VolumeId): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: "MISSING_VOLUME",
    message: "Volume is not part of the document",
    context: { volumeId },
  });
}

export function missingMaterial(material: MaterialId): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: "MISSING_MATERIAL",
    message: "Material is not defined in the document",
    context: { material: String(material) },
  });
}
