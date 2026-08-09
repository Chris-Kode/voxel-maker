import { WorkspaceError, type JsonValue } from "@voxel-maker/shared";
import { STANDARD_VIEWS, type StandardViewId } from "./evidence.js";

/**
 * Critique schema (plan S15.4, ticket #40): the provider-neutral result
 * schema of one visual review round. A critique names the view, an issue
 * category, affected ids/region, the observed evidence, a suggested
 * GENERIC correction (never an authoritative edit), and a confidence.
 * Provider output is untrusted: `parseVisualCritique` parses and bounds
 * every field before the loop may act on it.
 */

/** Fixed critique issue categories (S15.4). */
export const CRITIQUE_CATEGORIES = [
  "geometry-gap",
  "intersection",
  "floating-voxels",
  "silhouette",
  "proportion",
  "asymmetry",
  "color-contrast",
  "material",
  "other",
] as const;

export type CritiqueCategory = (typeof CRITIQUE_CATEGORIES)[number];

/** Maximum affected node ids in one critique. */
export const MAX_CRITIQUE_NODE_IDS = 64;

/** Maximum evidence/suggestion characters in one critique. */
export const MAX_CRITIQUE_TEXT = 2_000;

/** Maximum absolute coordinate value in a critique region. */
export const MAX_CRITIQUE_COORDINATE = 1_048_575;

/** One bounded, validated visual critique. */
export interface VisualCritique {
  /** The view the issue was observed in; "any" when view-agnostic. */
  readonly view: StandardViewId | "any";
  readonly issueCategory: CritiqueCategory;
  /** Affected stable node ids (bounded; may be empty). */
  readonly affectedNodeIds: readonly string[];
  /** Optional affected region in volume-local coordinates. */
  readonly region?: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  /** What the image evidence shows (bounded text). */
  readonly evidence: string;
  /** Suggested generic correction (bounded text; never an edit itself). */
  readonly suggestedCorrection?: string;
  /** Model confidence in [0, 1]. */
  readonly confidence: number;
}

function critiqueError(message: string): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: "INVALID_VISUAL_CRITIQUE",
    message,
  });
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function boundedIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) continue;
    if (item.length > 128) return undefined;
    ids.push(item);
    if (ids.length >= MAX_CRITIQUE_NODE_IDS) break;
  }
  return Object.freeze(ids);
}

function boundedRegion(value: unknown): VisualCritique["region"] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const min = record.min;
  const max = record.max;
  if (!Array.isArray(min) || !Array.isArray(max)) return undefined;
  if (min.length !== 3 || max.length !== 3) return undefined;
  const minVec: number[] = [];
  const maxVec: number[] = [];
  const minItems = min as readonly unknown[];
  const maxItems = max as readonly unknown[];
  for (let i = 0; i < 3; i += 1) {
    const a = minItems[i];
    const b = maxItems[i];
    if (typeof a !== "number" || !Number.isInteger(a)) return undefined;
    if (typeof b !== "number" || !Number.isInteger(b)) return undefined;
    if (
      Math.abs(a) > MAX_CRITIQUE_COORDINATE ||
      Math.abs(b) > MAX_CRITIQUE_COORDINATE
    ) {
      return undefined;
    }
    if (b < a) return undefined;
    minVec.push(a);
    maxVec.push(b);
  }
  return Object.freeze({
    min: Object.freeze(minVec) as readonly [number, number, number],
    max: Object.freeze(maxVec) as readonly [number, number, number],
  });
}

/**
 * Parses and bounds one provider critique. Returns a structured error
 * when the value is not a well-formed critique; the loop then treats the
 * round as critique-less (corrections may still arrive as tool calls).
 */
export function parseVisualCritique(
  value: JsonValue,
):
  | { readonly ok: true; readonly value: VisualCritique }
  | { readonly ok: false; readonly error: WorkspaceError } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: critiqueError("Critique must be a JSON object"),
    };
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  const view = record.view;
  if (view !== "any" && !STANDARD_VIEWS.includes(view as StandardViewId)) {
    return {
      ok: false,
      error: critiqueError(
        `Unknown critique view: ${
          typeof view === "string" ? view : JSON.stringify(view)
        }`,
      ),
    };
  }
  const category = record.issueCategory;
  if (!CRITIQUE_CATEGORIES.includes(category as CritiqueCategory)) {
    return {
      ok: false,
      error: critiqueError(
        `Unknown critique category: ${
          typeof category === "string" ? category : JSON.stringify(category)
        }`,
      ),
    };
  }
  const evidence = boundedString(record.evidence, MAX_CRITIQUE_TEXT);
  const suggestion = boundedString(
    record.suggestedCorrection,
    MAX_CRITIQUE_TEXT,
  );
  if (evidence === undefined) {
    return { ok: false, error: critiqueError("Critique evidence is required") };
  }
  const confidence = record.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return {
      ok: false,
      error: critiqueError("Critique confidence must be in [0, 1]"),
    };
  }
  const ids = boundedIds(record.affectedNodeIds);
  if (ids === undefined) {
    return {
      ok: false,
      error: critiqueError("Critique affected node ids must be string ids"),
    };
  }
  const region = boundedRegion(record.region);
  if (region === undefined && record.region !== undefined) {
    return { ok: false, error: critiqueError("Critique region is malformed") };
  }
  return {
    ok: true,
    value: Object.freeze({
      view: view as StandardViewId | "any",
      issueCategory: category as CritiqueCategory,
      affectedNodeIds: ids,
      ...(region === undefined ? {} : { region }),
      evidence,
      ...(suggestion === undefined ? {} : { suggestedCorrection: suggestion }),
      confidence,
    }),
  };
}

/**
 * Extracts the first bounded critique object from provider text. The
 * search is bounded: only the first 64 KiB of text is scanned and only
 * the first JSON object that parses as a critique is returned, so a
 * verbose or hostile response cannot allocate unbounded state.
 */
export function critiqueFromText(text: string): VisualCritique | undefined {
  const scanned = text.length <= 65_536 ? text : text.slice(0, 65_536);
  let start = scanned.indexOf("{");
  let guard = 0;
  while (start !== -1 && guard < 32) {
    guard += 1;
    const end = findJsonObjectEnd(scanned, start);
    if (end !== -1) {
      try {
        const parsed: unknown = JSON.parse(scanned.slice(start, end + 1));
        const result = parseVisualCritique(parsed as JsonValue);
        if (result.ok) return result.value;
      } catch {
        // fall through to the next object
      }
    }
    start = scanned.indexOf("{", start + 1);
  }
  return undefined;
}

/** Finds the matching closing brace of the object starting at `start`. */
function findJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
