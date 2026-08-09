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
