import { WorkspaceError, type MaterialId } from "@voxel-maker/shared";

/**
 * Shared tool failure factories (plan S7.3, tickets #17/#18): every
 * headless tool reports the same structured errors for the same
 * preconditions, so the desktop notices and the failure policy stay
 * identical across the stroke and shape tools.
 */

export const sessionNotOpen = (): WorkspaceError =>
  new WorkspaceError({
    family: "conflict",
    code: "SESSION_NOT_OPEN",
    message: "No document is open",
  });

export const noActiveMaterial = (): WorkspaceError =>
  new WorkspaceError({
    family: "validation",
    code: "NO_ACTIVE_MATERIAL",
    message: "Select an active material before drawing",
  });

export const missingActiveMaterial = (material: MaterialId): WorkspaceError =>
  new WorkspaceError({
    family: "validation",
    code: "MISSING_MATERIAL",
    message: "The active material no longer exists",
    context: { materialId: material },
  });

/** Region-domain failure shared with the region-command code. */
export const outOfBoundsError = (
  volumeId: string,
  region: { readonly min: readonly number[]; readonly max: readonly number[] },
  name: string,
): WorkspaceError =>
  new WorkspaceError({
    family: "limit",
    code: "REGION_OUT_OF_BOUNDS",
    message: `${name} region exceeds the volume coordinate domain`,
    context: {
      volumeId,
      region: {
        min: [
          region.min[0] as number,
          region.min[1] as number,
          region.min[2] as number,
        ],
        max: [
          region.max[0] as number,
          region.max[1] as number,
          region.max[2] as number,
        ],
      },
    },
  });

/** Per-gesture voxel budget failure (ADR-0009). */
export const tooManyVoxelsError = (
  requested: number,
  limit: number,
): WorkspaceError =>
  new WorkspaceError({
    family: "limit",
    code: "TOO_MANY_VOXELS",
    message: "Operation exceeds the per-gesture voxel budget",
    context: { requested, limit },
  });

/** Volume occupied-voxel limit failure (ADR-0009). */
export const tooManyOccupiedError = (
  requested: number,
  limit: number,
): WorkspaceError =>
  new WorkspaceError({
    family: "limit",
    code: "TOO_MANY_OCCUPIED_VOXELS",
    message: "Volume exceeds its occupied-voxel limit",
    context: { requested, limit },
  });
