import { WorkspaceError } from "@voxel-maker/shared";

/**
 * Rejects a caller-supplied limit profile that raises a hard default or
 * carries a non-finite value (ADR-0009, plan S5.4, issue #98): hard
 * defaults are immutable, so callers may only lower them with finite
 * numbers. A NaN limit would silently disable every comparison that uses
 * it, so it is rejected up front rather than accepted. Shared by every
 * formats seam that consumes a limit profile (`readZipArchive`,
 * `readVxlProject`) so the rule is enforced identically at each seam.
 */
export function assertNotAboveDefault<T extends object>(
  provided: T,
  defaults: T,
  name: string,
): T {
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const limit = provided[key];
    const hard = defaults[key];
    if (typeof limit === "number" && typeof hard === "number") {
      if (!Number.isFinite(limit) || limit > hard) {
        throw new WorkspaceError({
          family: "limit",
          code: "LIMIT_ABOVE_DEFAULT",
          message: `Callers may only lower the ${name} hard limits with finite values`,
          context: { limit: String(key), requested: limit, hard },
        });
      }
    }
  }
  return provided;
}
