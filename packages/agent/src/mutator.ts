import { CommandRegistry, type Command } from "@voxel-maker/commands";
import { WorkspaceError, type JsonValue } from "@voxel-maker/shared";
import type { DocumentStoreRead } from "@voxel-maker/document";
import { ResponseBudget, jsonUnits } from "./budget.js";
import {
  COORDINATE_CONVENTIONS,
  MUTATION_CONTRACT_VERSION,
  toToolError as toToolErrorShared,
  type ToolCapability,
  type ToolContract,
  type ToolError,
} from "./contract.js";
import { resolveMutationLimits, type MutationLimits } from "./limits.js";
import {
  authorizeTools,
  contractByName,
  MUTATION_CAPABILITY,
  MUTATION_TOOL_CONTRACTS,
  TOOL_NOT_AUTHORIZED_CODE,
  UNKNOWN_TOOL_CODE,
} from "./registry.js";
import { MUTATION_TOOL_DEFINITIONS } from "./mutation/definitions.js";
import { schemaErrorDetails } from "./schema.js";
import { invalidArgument } from "./contract.js";
import { deepFreeze } from "./freeze.js";
import type { PreviewSession } from "./preview.js";

/**
 * The deterministic mutation facade (plan S11.5/S11.6/S11.9, ticket #32):
 * one entry point that validates arguments against the versioned JSON-
 * Schema contract, verifies the constructed command is registered, and
 * wraps the proposal in the shared response envelope with the mandatory
 * base revision. Tools construct commands only; nothing is executed here.
 */

export interface MutatorOptions {
  /**
   * Read surface used for reference checks: the preview session's staged
   * view when bound, otherwise the live store.
   */
  readonly store: DocumentStoreRead;
  /** Registry the constructed commands must be registered in. */
  readonly registry: CommandRegistry;
  /** Optional preview session the proposals are anchored to. */
  readonly session?: PreviewSession;
  /** Optional lowerings of the hard mutation budgets. */
  readonly limits?: Partial<MutationLimits>;
  /** Enabled capabilities; defaults to ["mutate"]. */
  readonly capabilities?: readonly ToolCapability[];
}

export type MutationResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: ToolError };

export interface Mutator {
  /** Authorized mutation tool contracts (capability-filtered). */
  readonly contracts: readonly ToolContract[];
  /** Constructs one registered command; never throws. */
  construct(name: string, args: JsonValue): MutationResult;
}

function toToolError(error: unknown): ToolError {
  if (error instanceof WorkspaceError) return toToolErrorShared(error);
  return {
    family: "internal",
    code: "INTERNAL_MUTATION_ERROR",
    message:
      error instanceof Error ? error.message : "Unexpected mutation failure",
  };
}

export function createMutator(options: MutatorOptions): Mutator {
  const limits = resolveMutationLimits(options.limits);
  const capabilities = options.capabilities ?? [MUTATION_CAPABILITY];
  const contracts = authorizeTools(MUTATION_TOOL_CONTRACTS, capabilities);
  const session = options.session;
  const baseRevision = session?.baseRevision ?? options.store.revision;
  let commandSequence = 0;

  function construct(name: string, args: JsonValue): MutationResult {
    try {
      const contract = contractByName(MUTATION_TOOL_CONTRACTS, name);
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
      const definition = MUTATION_TOOL_DEFINITIONS.find(
        (entry) => entry.contract.name === name,
      );
      if (definition === undefined) {
        throw new WorkspaceError({
          family: "internal",
          code: "UNIMPLEMENTED_TOOL",
          message: `No handler registered for ${name}`,
        });
      }
      const payload = definition.handler(
        {
          store: options.store,
          limits,
          registry: options.registry,
          baseRevision,
          toolName: name,
          commandSequence,
        },
        args,
      );
      commandSequence += 1;
      if (
        options.registry.get(
          payload.command.type,
          payload.command.schemaVersion,
        ) === undefined
      ) {
        throw new WorkspaceError({
          family: "internal",
          code: "UNREGISTERED_COMMAND",
          message: `Constructed command ${payload.command.type} is not registered`,
          context: { type: payload.command.type },
        });
      }
      const budget = new ResponseBudget(limits.maxResponseBytes);
      const envelopeReservation = jsonUnits({
        tool: name,
        contractVersion: MUTATION_CONTRACT_VERSION,
        documentId: options.store.getDocument().documentId,
        revision: options.store.revision,
        conventions: COORDINATE_CONVENTIONS,
        truncated: false,
      });
      budget.reserve(envelopeReservation);
      const commandValue = {
        id: payload.command.id,
        type: payload.command.type,
        schemaVersion: payload.command.schemaVersion,
        payload: payload.command.payload as JsonValue,
      };
      if (!budget.tryReserve(commandValue)) {
        throw new WorkspaceError({
          family: "limit",
          code: "RESPONSE_TOO_LARGE",
          message: "Constructed command exceeds the mutation response budget",
          context: {
            commandId: payload.command.id,
            bytes: jsonUnits(commandValue),
            max: limits.maxResponseBytes,
          },
        });
      }
      const value = {
        tool: name,
        contractVersion: MUTATION_CONTRACT_VERSION,
        documentId: options.store.getDocument().documentId,
        revision: options.store.revision,
        conventions: COORDINATE_CONVENTIONS,
        baseRevision,
        voxelEstimate: payload.voxelEstimate,
        command: commandValue,
        truncated: false,
      };
      return { ok: true, value: deepFreeze(value) };
    } catch (error) {
      return { ok: false, error: toToolError(error) };
    }
  }

  return { contracts, construct };
}

/** Type helper: a constructed command proposal as returned by the mutator. */
export type ConstructedCommand = Command;
