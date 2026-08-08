import { WorkspaceError } from "@voxel-maker/shared";
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
  if (typeof version === "number" && version > 1) {
    throw new WorkspaceError({
      family: "compatibility",
      code: "UNSUPPORTED_DOCUMENT_VERSION",
      message:
        "Document format version is newer than the supported version 1; refusing to guess at unknown data",
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
  return deepFreeze(document);
}
