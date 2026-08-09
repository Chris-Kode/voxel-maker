import type { DocumentStoreRead } from "@voxel-maker/document";
import {
  WorkspaceError,
  type JsonValue,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import { schemaErrors, type JsonSchema } from "@voxel-maker/agent";
import type { IntAabb, Vec3i } from "./geometry.js";
import { isVec3i } from "./geometry.js";
import { MAX_REGION_EXTENT } from "./schemas.js";

/**
 * Generic structural-check registry (plan S14.10, ticket #38): named,
 * deterministic predicates over a committed document used by skill
 * evaluation metadata. Checks are generic — they know nothing about
 * asset categories; each creation skill references a subset with fixed
 * options. Every occupancy scan is bounded by an explicit region in the
 * options (extent per axis and total volume capped at the engine
 * limits), so a check can never iterate an unbounded space. Options are
 * validated against each check's JSON-Schema contract at manifest
 * registration, so a manifest can never reference an unknown check or
 * carry malformed options.
 */

/** Stable error codes for unknown checks and invalid check options. */
export const UNKNOWN_STRUCTURAL_CHECK_CODE = "UNKNOWN_STRUCTURAL_CHECK";
export const INVALID_CHECK_OPTIONS_CODE = "INVALID_CHECK_OPTIONS";

/** Hard cap of one scan region axis extent (engine region bound). */
const MAX_SCAN_EXTENT = MAX_REGION_EXTENT;
/** Hard cap of one scan region volume (mirrors proposal voxel bounds). */
const MAX_SCAN_VOLUME = 1_000_000;

/** Ambient read context shared by every structural check. */
export interface CheckContext {
  /** Volume the check reads occupancy from. */
  readonly volumeId: VolumeId;
  /** Material the skill targets (material-presence checks). */
  readonly material?: MaterialId;
}

/** Result of one structural check run. */
export interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  /** Human-readable evidence string (bounded). */
  readonly evidence: string;
}

/** One registered structural check definition. */
export interface StructuralCheckDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON-Schema (draft-07 subset) contract of the check options. */
  readonly optionSchema: JsonSchema;
  /**
   * Runs the predicate; never throws (options already validated at
   * registration).
   */
  run(
    store: DocumentStoreRead,
    options: JsonValue,
    context: CheckContext,
  ): CheckResult;
}

function checkError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>>,
): never {
  throw new WorkspaceError({
    family: "validation",
    code,
    message,
    // Context values are bounded plain JSON produced by the validator.
    context: context as Readonly<Record<string, JsonValue>>,
  });
}

/** Reads a bounded non-negative integer option. */
function intOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  defaultValue: number,
): number {
  const value = options[key] ?? defaultValue;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : defaultValue;
}

/** Reads a bounded coordinate-triple option. */
function vecOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
): Vec3i | undefined {
  const value = options[key];
  return isVec3i(value) ? value : undefined;
}

/** Reads a validated region option value (never throws). */
function regionOf(
  options: Readonly<Record<string, unknown>>,
): IntAabb | undefined {
  const region = options.region as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (region === undefined) return undefined;
  const min = vecOption(region, "min");
  const max = vecOption(region, "max");
  if (min === undefined || max === undefined) return undefined;
  return { min: [...min], max: [...max] } as IntAabb;
}

/** Counts occupied voxels inside a bounded region of the volume. */
function countOccupied(
  store: DocumentStoreRead,
  volumeId: VolumeId,
  region: IntAabb,
): number {
  let count = 0;
  for (let x = region.min[0]; x < region.max[0]; x += 1) {
    for (let y = region.min[1]; y < region.max[1]; y += 1) {
      for (let z = region.min[2]; z < region.max[2]; z += 1) {
        if (store.getVoxel(volumeId, [x, y, z]) !== 0) count += 1;
      }
    }
  }
  return count;
}

/** Region schema fragment shared by every occupancy check. */
const REGION_FIELD: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    min: {
      type: "array",
      items: { type: "integer", minimum: -1_048_575, maximum: 1_048_575 },
      minItems: 3,
      maxItems: 3,
    },
    max: {
      type: "array",
      items: { type: "integer", minimum: -1_048_575, maximum: 1_048_575 },
      minItems: 3,
      maxItems: 3,
    },
  },
  required: ["min", "max"],
};

const COUNT_OPTIONS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    region: REGION_FIELD,
    min: { type: "integer", minimum: 0, maximum: MAX_SCAN_VOLUME },
    max: { type: "integer", minimum: 0, maximum: MAX_SCAN_VOLUME },
  },
  required: ["region", "min", "max"],
};

const INSIDE_OPTIONS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    region: REGION_FIELD,
    scanRegion: REGION_FIELD,
  },
  required: ["region", "scanRegion"],
};

const NONEMPTY_OPTIONS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    region: REGION_FIELD,
  },
  required: ["region"],
};

const SYMMETRY_OPTIONS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    axis: { type: "string", enum: ["x", "y", "z"] },
    plane: { type: "integer", minimum: -1_048_575, maximum: 1_048_575 },
    region: REGION_FIELD,
  },
  required: ["axis", "plane", "region"],
};

const NODE_COUNT_OPTIONS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    min: { type: "integer", minimum: 0, maximum: 100_000 },
    max: { type: "integer", minimum: 0, maximum: 100_000 },
  },
  required: ["min", "max"],
};

const NO_OPTIONS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
};

/** Bounded volume of a half-open region (local; no geometry export). */
function regionVolume(min: Vec3i, max: Vec3i): number {
  return (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
}

/** Region option helper for skill authors (JSON-safe plain value). */
export function regionOption(min: Vec3i, max: Vec3i): JsonValue {
  return { region: { min: [...min], max: [...max] } };
}

/**
 * Validates a bounded region option: coordinates within engine bounds,
 * positive extent per axis capped at MAX_SCAN_EXTENT, and total volume
 * capped at MAX_SCAN_VOLUME. Throws on violation.
 */
function validateBoundedRegion(region: unknown, field: string): void {
  if (
    region === null ||
    typeof region !== "object" ||
    Array.isArray(region) ||
    !("min" in region) ||
    !("max" in region)
  ) {
    checkError(INVALID_CHECK_OPTIONS_CODE, `Invalid ${field} region`, {
      field,
      region,
    });
  }
  const min = (region as Record<string, unknown>).min;
  const max = (region as Record<string, unknown>).max;
  if (!isVec3i(min) || !isVec3i(max)) {
    checkError(INVALID_CHECK_OPTIONS_CODE, `Invalid ${field} region bounds`, {
      field,
      region,
    });
  }
  const mn = min;
  const mx = max;
  const [mn0, mn1, mn2] = mn;
  const [mx0, mx1, mx2] = mx;
  const extents = [mx0 - mn0, mx1 - mn1, mx2 - mn2];
  for (const [axis, extent] of extents.entries()) {
    if (extent < 1 || extent > MAX_SCAN_EXTENT) {
      checkError(
        INVALID_CHECK_OPTIONS_CODE,
        `${field} region extent out of range`,
        { field, axis, extent },
      );
    }
  }
  if (regionVolume(mn, mx) > MAX_SCAN_VOLUME) {
    checkError(
      INVALID_CHECK_OPTIONS_CODE,
      `${field} region volume out of range`,
      {
        field,
        volume: regionVolume(mn, mx),
      },
    );
  }
}

/** The structural checks a skill can reference, in stable order. */
export const STRUCTURAL_CHECKS: readonly StructuralCheckDefinition[] =
  Object.freeze([
    {
      name: "occupied-voxel-count-in-range",
      description:
        "Occupied voxels inside the declared scan region stay within the inclusive count range.",
      optionSchema: COUNT_OPTIONS_SCHEMA,
      run(store, options, context) {
        const record = options as Readonly<Record<string, unknown>>;
        const region = regionOf(record);
        const min = intOption(record, "min", 0);
        const max = intOption(record, "max", 0);
        const count =
          region === undefined
            ? 0
            : countOccupied(store, context.volumeId, region);
        const passed = region !== undefined && count >= min && count <= max;
        return {
          name: "occupied-voxel-count-in-range",
          passed,
          evidence: `occupied=${String(count)} expected [${String(min)},${String(max)}]`,
        };
      },
    },
    {
      name: "occupancy-inside-region",
      description:
        "No occupied voxel of the scan region lies outside the inner region.",
      optionSchema: INSIDE_OPTIONS_SCHEMA,
      run(store, options, context) {
        const record = options as Readonly<Record<string, unknown>>;
        const region = regionOf(record);
        const scanRegion = regionOf({ region: record.scanRegion });
        const outside =
          region === undefined || scanRegion === undefined
            ? undefined
            : findOutsideVoxel(store, context.volumeId, region, scanRegion);
        return {
          name: "occupancy-inside-region",
          passed: outside === undefined,
          evidence:
            outside === undefined
              ? "no occupied voxel outside inner region"
              : `outside voxel ${String(outside)}`,
        };
      },
    },
    {
      name: "region-nonempty",
      description: "The declared region contains at least one occupied voxel.",
      optionSchema: NONEMPTY_OPTIONS_SCHEMA,
      run(store, options, context) {
        const region = regionOf(options as Readonly<Record<string, unknown>>);
        const count =
          region === undefined
            ? 0
            : countOccupied(store, context.volumeId, region);
        return {
          name: "region-nonempty",
          passed: count > 0,
          evidence: `occupied in region=${String(count)}`,
        };
      },
    },
    {
      name: "material-present",
      description: "The document contains the skill target material.",
      optionSchema: NO_OPTIONS_SCHEMA,
      run(store, _options, context) {
        if (context.material === undefined) {
          return {
            name: "material-present",
            passed: false,
            evidence: "no target material in context",
          };
        }
        const document = store.getDocument();
        const present = document.materials[context.material] !== undefined;
        return {
          name: "material-present",
          passed: present,
          evidence: present ? "material present" : "material missing",
        };
      },
    },
    {
      name: "node-count-in-range",
      description:
        "Document node count stays within the declared inclusive range.",
      optionSchema: NODE_COUNT_OPTIONS_SCHEMA,
      run(store, options, context) {
        void context;
        const record = options as Readonly<Record<string, unknown>>;
        const min = intOption(record, "min", 0);
        const max = intOption(record, "max", 0);
        const count = Object.keys(store.getDocument().nodes).length;
        const passed = count >= min && count <= max;
        return {
          name: "node-count-in-range",
          passed,
          evidence: `nodes=${String(count)} expected [${String(min)},${String(max)}]`,
        };
      },
    },
    {
      name: "symmetric-along-axis",
      description:
        "Occupancy in the scan region is mirror-symmetric across the declared plane (same-material twins).",
      optionSchema: SYMMETRY_OPTIONS_SCHEMA,
      run(store, options, context) {
        const record = options as Readonly<Record<string, unknown>>;
        const axis = record.axis as string;
        const plane = intOption(record, "plane", 0);
        const region = regionOf(record);
        const mismatches =
          region === undefined
            ? -1
            : countSymmetryMismatches(
                store,
                context.volumeId,
                axis,
                plane,
                region,
              );
        return {
          name: "symmetric-along-axis",
          passed: mismatches === 0,
          evidence:
            mismatches === 0
              ? "symmetric"
              : `asymmetric voxels=${String(mismatches)}`,
        };
      },
    },
  ]);

/** Looks up one structural check definition by name. */
export function structuralCheckByName(
  name: string,
): StructuralCheckDefinition | undefined {
  return STRUCTURAL_CHECKS.find((check) => check.name === name);
}

/**
 * Validates a check reference at manifest registration: the name must
 * resolve, the options must satisfy the check's JSON-Schema contract,
 * and every region option must be bounded. Throws the stable validation
 * errors; never returns a partial check.
 */
export function validateStructuralCheck(name: string, options: unknown): void {
  const check = structuralCheckByName(name);
  if (check === undefined) {
    checkError(
      UNKNOWN_STRUCTURAL_CHECK_CODE,
      `Unknown structural check: ${name}`,
      {
        check: name,
      },
    );
  }
  const errors = schemaErrors(check.optionSchema, options);
  if (errors.length > 0) {
    checkError(
      INVALID_CHECK_OPTIONS_CODE,
      `Invalid options for check ${name}`,
      {
        check: name,
        errors: [...errors],
      },
    );
  }
  const record = options as Readonly<Record<string, unknown>>;
  for (const field of ["region", "scanRegion"] as const) {
    if (record[field] !== undefined)
      validateBoundedRegion(record[field], field);
  }
}

/**
 * Runs every structural check of a skill's evaluation metadata against a
 * committed store. Checks run in manifest order; results are frozen and
 * bounded. Never throws: unknown checks were rejected at registration.
 */
export function runStructuralChecks(
  checks: readonly { readonly name: string; readonly options: JsonValue }[],
  store: DocumentStoreRead,
  context: CheckContext,
): readonly CheckResult[] {
  return Object.freeze(
    checks.map((entry) => {
      const check = structuralCheckByName(entry.name);
      if (check === undefined) {
        return Object.freeze({
          name: entry.name,
          passed: false,
          evidence: "unknown check",
        });
      }
      return Object.freeze(check.run(store, entry.options, context));
    }),
  );
}

/** Finds one occupied voxel in scanRegion outside region, or undefined. */
function findOutsideVoxel(
  store: DocumentStoreRead,
  volumeId: VolumeId,
  region: IntAabb,
  scanRegion: IntAabb,
): Vec3i | undefined {
  for (let x = scanRegion.min[0]; x < scanRegion.max[0]; x += 1) {
    for (let y = scanRegion.min[1]; y < scanRegion.max[1]; y += 1) {
      for (let z = scanRegion.min[2]; z < scanRegion.max[2]; z += 1) {
        if (store.getVoxel(volumeId, [x, y, z]) === 0) continue;
        if (
          x < region.min[0] ||
          x >= region.max[0] ||
          y < region.min[1] ||
          y >= region.max[1] ||
          z < region.min[2] ||
          z >= region.max[2]
        ) {
          return [x, y, z];
        }
      }
    }
  }
  return undefined;
}

/** Counts voxels whose mirror twin across the plane is empty or differs. */
function countSymmetryMismatches(
  store: DocumentStoreRead,
  volumeId: VolumeId,
  axis: string,
  plane: number,
  region: IntAabb,
): number {
  const seen = new Set<string>();
  let mismatches = 0;
  const visit = (x: number, y: number, z: number): void => {
    const key = [x, y, z].join(",");
    if (seen.has(key)) return;
    seen.add(key);
    const twin = mirrorTwin([x, y, z], axis, plane);
    const twinKey = [twin[0], twin[1], twin[2]].join(",");
    if (seen.has(twinKey)) return;
    seen.add(twinKey);
    const a = store.getVoxel(volumeId, [x, y, z]);
    // The verdict is bounded by the declared region: a twin outside the
    // region is a mismatch even when the outside world happens to carry
    // the same material (the region itself is asymmetric).
    if (!insideRegion(twin, region)) {
      mismatches += 1;
      return;
    }
    const b = store.getVoxel(volumeId, twin);
    if (a !== b) mismatches += 1;
  };
  for (let x = region.min[0]; x < region.max[0]; x += 1) {
    for (let y = region.min[1]; y < region.max[1]; y += 1) {
      for (let z = region.min[2]; z < region.max[2]; z += 1) {
        if (store.getVoxel(volumeId, [x, y, z]) !== 0) visit(x, y, z);
      }
    }
  }
  return mismatches;
}

/** True when the point lies inside the half-open scan region. */
function insideRegion(point: Vec3i, region: IntAabb): boolean {
  return (
    point[0] >= region.min[0] &&
    point[0] < region.max[0] &&
    point[1] >= region.min[1] &&
    point[1] < region.max[1] &&
    point[2] >= region.min[2] &&
    point[2] < region.max[2]
  );
}

function mirrorTwin(point: Vec3i, axis: string, plane: number): Vec3i {
  const twin: [number, number, number] = [...point] as [number, number, number];
  if (axis === "x") twin[0] = 2 * plane - point[0];
  else if (axis === "y") twin[1] = 2 * plane - point[1];
  else twin[2] = 2 * plane - point[2];
  return twin;
}
