import { WorkspaceError, type JsonValue } from "@voxel-maker/shared";
import type { DocumentStoreRead } from "@voxel-maker/document";
import { ResponseBudget, jsonUnits } from "./budget.js";
import {
  COORDINATE_CONVENTIONS,
  INSPECTION_CONTRACT_VERSION,
  invalidArgument,
  type ToolCapability,
  type ToolContract,
  type ToolError,
} from "./contract.js";
import { resolveInspectionLimits, type InspectionLimits } from "./limits.js";
import type { EditorContextPort } from "./port.js";
import { schemaErrorDetails } from "./schema.js";
import {
  authorizeTools,
  contractByName,
  INSPECTION_CAPABILITY,
  INSPECTION_TOOL_CONTRACTS,
  TOOL_NOT_AUTHORIZED_CODE,
  UNKNOWN_TOOL_CODE,
} from "./registry.js";
import type { ToolContext } from "./tools/context.js";
import { getSelection } from "./tools/selection.js";
import { inspectSummary } from "./tools/summary.js";
import { inspectHierarchy, inspectNode } from "./tools/hierarchy.js";
import { inspectMaterials } from "./tools/materials.js";
import { inspectBounds, queryVoxels } from "./tools/voxels.js";
import { raycast } from "./tools/raycast.js";
import { inspectRigging } from "./tools/rigging.js";
import {
  inspectClips,
  inspectKeyframes,
  inspectTracks,
} from "./tools/animation.js";
import { searchNodes } from "./tools/search.js";
import { measureDistance } from "./tools/distance.js";

/**
 * The deterministic inspection facade (plan S11.2/S11.3): one entry point
 * that validates arguments against the versioned JSON-Schema contract,
 * runs the authorized tool over the read surface, and wraps the payload in
 * the shared response envelope (stable ids, revision, coordinate
 * conventions, truncation flags). Every response is deep-frozen plain
 * JSON; failures serialize to stable, user-safe error data.
 */

export interface InspectorOptions {
  /** Authoritative read surface; inspection never receives write access. */
  readonly store: DocumentStoreRead;
  /** Optional lowerings of the hard inspection budgets (ADR-0009). */
  readonly limits?: Partial<InspectionLimits>;
  /** Optional injected editor context (selection snapshots). */
  readonly port?: EditorContextPort;
  /** Enabled capabilities; defaults to ["inspect"]. */
  readonly capabilities?: readonly ToolCapability[];
}

export type InspectionResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: ToolError };

export interface Inspector {
  /** Authorized tool contracts (capability-filtered). */
  readonly contracts: readonly ToolContract[];
  /** Runs one tool call; never throws. */
  inspect(name: string, args: JsonValue): InspectionResult;
}

type ToolHandler = (
  ctx: ToolContext,
  args: JsonValue,
) => Readonly<Record<string, JsonValue>>;

function handlerOf(contract: ToolContract): ToolHandler | undefined {
  switch (contract.name) {
    case "inspectSummary":
      return inspectSummary;
    case "getSelection":
      return getSelection;
    case "inspectHierarchy":
      return inspectHierarchy;
    case "inspectNode":
      return inspectNode;
    case "inspectMaterials":
      return inspectMaterials;
    case "inspectBounds":
      return inspectBounds;
    case "queryVoxels":
      return queryVoxels;
    case "raycast":
      return raycast;
    case "inspectRigging":
      return inspectRigging;
    case "inspectClips":
      return inspectClips;
    case "inspectTracks":
      return inspectTracks;
    case "inspectKeyframes":
      return inspectKeyframes;
    case "searchNodes":
      return searchNodes;
    case "measureDistance":
      return measureDistance;
    default:
      return undefined;
  }
}

/** Recursively freezes a plain JSON tree so no mutable backing data escapes. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function toToolError(error: unknown): ToolError {
  if (error instanceof WorkspaceError) {
    const data = error.toJSON();
    return {
      family: data.family,
      code: data.code,
      message: data.message,
      ...(data.path === undefined ? {} : { path: [...data.path] }),
      ...(data.context === undefined ? {} : { context: data.context }),
    };
  }
  return {
    family: "internal",
    code: "INTERNAL_INSPECTION_ERROR",
    message:
      error instanceof Error ? error.message : "Unexpected inspection failure",
  };
}

export function createInspector(options: InspectorOptions): Inspector {
  const limits = resolveInspectionLimits(options.limits);
  const capabilities = options.capabilities ?? [INSPECTION_CAPABILITY];
  const contracts = authorizeTools(INSPECTION_TOOL_CONTRACTS, capabilities);

  function inspect(name: string, args: JsonValue): InspectionResult {
    try {
      const contract = contractByName(INSPECTION_TOOL_CONTRACTS, name);
      if (contract === undefined) {
        throw new WorkspaceError({
          family: "validation",
          code: UNKNOWN_TOOL_CODE,
          message: `Unknown tool: ${name}`,
          context: { tool: name },
        });
      }
      if (!contracts.includes(contract)) {
        throw new WorkspaceError({
          family: "conflict",
          code: TOOL_NOT_AUTHORIZED_CODE,
          message: `Tool ${name} is not authorized for the enabled capabilities`,
          context: { tool: name },
        });
      }
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        invalidArgument("tool arguments must be an object");
      }
      const details = schemaErrorDetails(contract.inputSchema, args);
      if (details.length > 0) {
        throw new WorkspaceError({
          family: "validation",
          code: "INVALID_ARGUMENT",
          message: `Invalid arguments for ${name}: ${details
            .map((detail) => detail.message)
            .join("; ")}`,
          ...(details[0] === undefined ? {} : { path: details[0].path }),
          context: {
            tool: name,
            errors: details.map((detail) => detail.message),
          },
        });
      }
      const budget = new ResponseBudget(limits.maxResponseBytes);
      const envelopeReservation = jsonUnits({
        tool: name,
        contractVersion: INSPECTION_CONTRACT_VERSION,
        documentId: options.store.getDocument().documentId,
        revision: options.store.revision,
        conventions: COORDINATE_CONVENTIONS,
        truncated: false,
        truncatedReason: "byte-budget",
      });
      budget.reserve(envelopeReservation);
      const handler = handlerOf(contract);
      if (handler === undefined) {
        throw new WorkspaceError({
          family: "internal",
          code: "UNIMPLEMENTED_TOOL",
          message: `No handler registered for ${name}`,
        });
      }
      const payload = handler(
        { store: options.store, limits, port: options.port, budget },
        args,
      );
      const value = {
        tool: name,
        contractVersion: INSPECTION_CONTRACT_VERSION,
        documentId: options.store.getDocument().documentId,
        revision: options.store.revision,
        conventions: COORDINATE_CONVENTIONS,
        ...payload,
        truncated: budget.truncated,
        ...(budget.truncated ? { truncatedReason: "byte-budget" } : {}),
      };
      return { ok: true, value: deepFreeze(value) };
    } catch (error) {
      return { ok: false, error: toToolError(error) };
    }
  }

  return { contracts, inspect };
}
