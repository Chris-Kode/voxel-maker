import { WorkspaceError } from "@voxel-maker/shared";
import { CURRENT_DOCUMENT_SCHEMA_VERSION } from "./migration.js";
import { DEFAULT_DOCUMENT_LIMITS, type DocumentLimits } from "./limits.js";
import type { VoxelDocument } from "./types.js";
import { deepFreeze } from "./freeze.js";
import {
  validateDocumentStructure,
  validateReferences,
  type DocumentIssue,
} from "./validate.js";

function toWorkspaceError(issue: DocumentIssue): WorkspaceError {
  return new WorkspaceError({
    family: issue.family,
    code: issue.code,
    message: issue.message,
    path: [...issue.path],
  });
}

/**
 * Copies a validated ID-keyed record into a null-prototype object, preserving
 * key order and values. `JSON.parse` produces ordinary prototype-bearing
 * objects, so without this an absent caller-supplied ID such as "toString"
 * would resolve to an inherited `Object.prototype` member and look present
 * (issue #103). `createDocument` builds these records the same way so fresh
 * and reloaded documents behave identically.
 */
function toNullPrototypeRecord<T>(
  record: Readonly<Record<string, T>>,
): Record<string, T> {
  const copy: Record<string, T> = Object.create(null) as Record<string, T>;
  for (const key of Object.keys(record)) {
    copy[key] = record[key] as T;
  }
  return copy;
}

/**
 * Parses and validates a canonical document JSON string. Unknown future
 * schema versions fail with a compatibility error; every other structural or
 * referential failure throws a stable `WorkspaceError` carrying the first
 * issue's code and path. The returned document is deeply frozen.
 */
export function parseDocument(
  json: string,
  limits: DocumentLimits = DEFAULT_DOCUMENT_LIMITS,
): VoxelDocument {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_JSON",
      message: "Document is not valid JSON",
      cause,
    });
  }
  const version =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).documentSchemaVersion
      : undefined;
  if (
    typeof version === "number" &&
    version > CURRENT_DOCUMENT_SCHEMA_VERSION
  ) {
    throw new WorkspaceError({
      family: "compatibility",
      code: "UNSUPPORTED_DOCUMENT_VERSION",
      message: `Document format version is newer than the supported version ${String(CURRENT_DOCUMENT_SCHEMA_VERSION)}; refusing to guess at unknown data`,
      path: ["documentSchemaVersion"],
      context: { version },
    });
  }
  const structural = validateDocumentStructure(value, limits);
  const firstStructural = structural[0];
  if (firstStructural !== undefined) {
    throw toWorkspaceError(firstStructural);
  }
  const document = value as VoxelDocument;
  const referential = validateReferences(document);
  const firstReferential = referential[0];
  if (firstReferential !== undefined) {
    throw toWorkspaceError(firstReferential);
  }
  // Rebuild the ID-keyed records as null-prototype maps (matching
  // createDocument) before deep-freezing, so absent caller-supplied IDs such
  // as "toString" or "__proto__" never resolve to inherited Object.prototype
  // members after a reload (issue #103).
  return deepFreeze({
    ...document,
    nodes: toNullPrototypeRecord(document.nodes),
    materials: toNullPrototypeRecord(document.materials),
    volumes: toNullPrototypeRecord(document.volumes),
    animations: toNullPrototypeRecord(document.animations),
  });
}
