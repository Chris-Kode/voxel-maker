import {
  WorkspaceError,
  materialId,
  type ComponentId,
  type MaterialId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import type { DocumentLimits } from "@voxel-maker/model";
import type { ShapeAxis } from "@voxel-maker/voxel";

/**
 * Shared parse/validation helpers for command handlers (plan 4.1). Every
 * handler bounds untrusted input in `parse` before any allocation; these
 * helpers keep the rules identical across command families.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseIdString(
  value: unknown,
  path: readonly (string | number)[],
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_ID",
      message:
        "Identifiers must be non-empty strings of at most 128 characters",
      path,
    });
  }
  return value;
}

export function parseVolumeId(
  value: unknown,
  path: readonly (string | number)[],
): VolumeId {
  return parseIdString(value, path) as VolumeId;
}

export function parseNodeId(
  value: unknown,
  path: readonly (string | number)[],
): NodeId {
  return parseIdString(value, path) as NodeId;
}

export function parseComponentId(
  value: unknown,
  path: readonly (string | number)[],
): ComponentId {
  return parseIdString(value, path) as ComponentId;
}

/**
 * Parses a bounded name. Names are optional on nodes (absent removes the
 * name) but required on materials; callers guard for the optional case.
 */
export function parseName(
  value: unknown,
  limits: DocumentLimits,
  path: readonly (string | number)[],
): string {
  if (typeof value !== "string") {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_NAME",
      message: "Name must be a string",
      path,
    });
  }
  if (new TextEncoder().encode(value).byteLength > limits.maxNameBytes) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_NAME",
      message: `Name exceeds the ${String(limits.maxNameBytes)}-byte limit`,
      path,
    });
  }
  return value;
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

/**
 * Parses a half-open region payload (plan S4.4). Regions are half-open, so
 * the exclusive `max` bound may reach `maxVoxelCoordinate + 1` to include
 * the boundary voxel; the volume clips anything beyond its domain.
 */
export function parseRegion(
  value: unknown,
  limits: DocumentLimits,
  path: readonly (string | number)[],
): IntAabb {
  if (!isRecord(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a region object with min and max",
      path,
    });
  }
  const bound = limits.maxVoxelCoordinate + 1;
  const parsePoint = (
    point: unknown,
    pointPath: readonly (string | number)[],
  ): Vec3i => {
    if (!Array.isArray(point) || point.length !== 3) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_VECTOR",
        message: "Expected a 3-component integer vector",
        path: pointPath,
      });
    }
    const raw = point as unknown[];
    const components: number[] = [];
    for (let axis = 0; axis < 3; axis += 1) {
      const component = raw[axis];
      if (
        typeof component !== "number" ||
        !Number.isInteger(component) ||
        Math.abs(component) > bound
      ) {
        throw new WorkspaceError({
          family: "validation",
          code: "INVALID_VOXEL_COORDINATE",
          message: `Region coordinates must be integers within +-${String(bound)}`,
          path: [...pointPath, axis],
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
  };
  const min = parsePoint(value.min, [...path, "min"]);
  const max = parsePoint(value.max, [...path, "max"]);
  for (let axis = 0; axis < 3; axis += 1) {
    if ((min[axis] as number) > (max[axis] as number)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_AABB",
        message: "Region minimum must not exceed maximum on any axis",
        path: [...path, axis],
      });
    }
  }
  return { min, max };
}

/**
 * Parses a translation delta. A delta may reach `2 * maxVoxelCoordinate + 1`
 * because a region at one extreme of the domain can validly move to the
 * other; the volume's destination check then bounds the result.
 */
export function parseDelta(
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
  const bound = 2 * limits.maxVoxelCoordinate + 1;
  const components: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const component = raw[axis];
    if (
      typeof component !== "number" ||
      !Number.isInteger(component) ||
      Math.abs(component) > bound
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_VOXEL_COORDINATE",
        message: `Delta coordinates must be integers within +-${String(bound)}`,
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

/** Parses an axis name: "x", "y", or "z". */
export function parseAxis(
  value: unknown,
  path: readonly (string | number)[] = [],
): ShapeAxis {
  if (value !== "x" && value !== "y" && value !== "z") {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_AXIS",
      message: 'Axis must be one of "x", "y", or "z"',
      path,
      context: { value: String(value) },
    });
  }
  return value;
}
