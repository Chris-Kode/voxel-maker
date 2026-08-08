import { WorkspaceError } from "@voxel-maker/shared";

/** Canonical lowercase `#rrggbb` color (ADR-0001). */
export type Color = string & { readonly __kind: "Color" };

const COLOR_PATTERN = /^#[0-9a-f]{6}$/u;

/** True when the value is a canonical lowercase `#rrggbb` color. */
export function isCanonicalColor(value: unknown): value is Color {
  return typeof value === "string" && COLOR_PATTERN.test(value);
}

/**
 * Validates and lowercases a caller-supplied `#rrggbb` color. The v1 policy
 * uses six-digit colors only; opacity is a separate material property.
 */
export function canonicalColor(
  value: string,
  path?: readonly (string | number)[],
): Color {
  if (typeof value !== "string" || !COLOR_PATTERN.test(value.toLowerCase())) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_COLOR",
      message: "Color must be a lowercase #rrggbb value",
      ...(path === undefined ? {} : { path }),
      context: { value },
    });
  }
  return value.toLowerCase() as Color;
}
