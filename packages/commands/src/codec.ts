import {
  WorkspaceError,
  canonicalJson,
  commandId,
  transactionId,
  type JsonValue,
  type TransactionId,
} from "@voxel-maker/shared";
import type { Source } from "@voxel-maker/document";
import type { Command, CommandLimits } from "./types.js";

/**
 * Journal-safe command codec (plan S4.14, ticket #14): a canonical,
 * bounded, versioned JSON encoding of one committed transaction so the
 * recovery journal can carry it as an opaque payload and recovery can
 * replay it through normal command decoding and invariants.
 *
 * The codec defines the *command envelope* schema only; each command's
 * payload schema stays owned by its registered handler, and replay parses
 * payloads again through the registry (ADR-0003: "replays complete valid
 * frames through normal decoding and invariants"). Frames encode this
 * record with `@voxel-maker/storage`, which never sees command types.
 */

/** Schema version of the command envelope inside a journal frame (plan S5.6). */
export const JOURNAL_COMMAND_ENVELOPE_VERSION = 1;

/** Sources accepted inside a journaled transaction (mirrors `Source`). */
const JOURNAL_SOURCES: readonly Source[] = [
  "ui",
  "ai",
  "import",
  "recovery",
  "system",
];

/**
 * One committed transaction exactly as the bus executed it, captured for
 * the recovery journal (plan S5.9, ADR-0003). `commands` are the commands
 * that actually ran: forward commands for a normal commit or redo, stored
 * inverses (in reverse order, ids derived) for an undo.
 */
export interface CommittedTransactionRecord {
  readonly transactionId: TransactionId;
  /** Revision the caller observed; equals `revisionBefore` when committed. */
  readonly expectedRevision: number;
  readonly source: Source;
  readonly correlationId?: string;
  readonly label?: string;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly commands: readonly Command[];
}

/** Bounds enforced by `parseJournalTransaction`; mirrors `CommandLimits`. */
export type JournalTransactionLimits = Pick<
  CommandLimits,
  | "maxCommandsPerTransaction"
  | "maxCommandPayloadBytes"
  | "maxTransactionEnvelopeBytes"
>;

/** Parsed and bounded journaled transaction, ready for bus replay. */
export interface JournalTransactionRecord {
  readonly transactionId: TransactionId;
  readonly expectedRevision: number;
  readonly source: Source;
  readonly correlationId?: string;
  readonly label?: string;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly commands: readonly Command<string, JsonValue>[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseRevision(
  value: unknown,
  path: readonly (string | number)[],
  name: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_JOURNAL_FIELD",
      message: `Journal ${name} must be a non-negative safe integer`,
      path,
    });
  }
  return value;
}

function parseOptionalString(
  value: unknown,
  path: readonly (string | number)[],
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_JOURNAL_FIELD",
      message: `Journal ${name} must be a string of at most 4096 characters`,
      path,
    });
  }
  return value;
}

const KNOWN_TRANSACTION_FIELDS = new Set([
  "transactionId",
  "expectedRevision",
  "source",
  "correlationId",
  "label",
  "revisionBefore",
  "revisionAfter",
  "commands",
]);

/**
 * Encodes a committed transaction into its canonical journal JSON value.
 * `@voxel-maker/storage` frames this value (versions, revisions, checksum);
 * `canonicalJson` makes the encoded bytes deterministic for identical
 * transactions, so retry deduplication and byte-golden tests are stable.
 */
export function journalTransactionToJson(
  record: CommittedTransactionRecord,
): JsonValue {
  return {
    transactionId: record.transactionId,
    expectedRevision: record.expectedRevision,
    source: record.source,
    ...(record.correlationId === undefined
      ? {}
      : { correlationId: record.correlationId }),
    ...(record.label === undefined ? {} : { label: record.label }),
    revisionBefore: record.revisionBefore,
    revisionAfter: record.revisionAfter,
    commands: record.commands.map((command) => ({
      id: command.id,
      type: command.type,
      schemaVersion: command.schemaVersion,
      payload: command.payload as JsonValue,
    })),
  };
}

/**
 * Parses and bounds an untrusted journaled transaction before replay
 * (plan S4.14: "JSON schema versions, max envelope bytes, canonical
 * encoding, parse errors"). Unknown fields are rejected rather than
 * guessed at; command payloads are only shape-checked here and fully
 * re-parsed by the registered handlers during bus execution.
 */
export function parseJournalTransaction(
  value: unknown,
  limits: JournalTransactionLimits,
): JournalTransactionRecord {
  if (!isRecord(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_JOURNAL_TRANSACTION",
      message: "Journal transaction must be a JSON object",
    });
  }
  for (const field of Object.keys(value)) {
    if (!KNOWN_TRANSACTION_FIELDS.has(field)) {
      throw new WorkspaceError({
        family: "validation",
        code: "UNKNOWN_JOURNAL_FIELD",
        message:
          "Journal transaction contains a field this version does not support; refusing to guess at unknown data",
        context: { field },
      });
    }
  }
  const transactionIdValue = value.transactionId;
  if (typeof transactionIdValue !== "string") {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_JOURNAL_FIELD",
      message: "Journal transaction id must be a string",
      path: ["transactionId"],
    });
  }
  const source = value.source;
  if (
    typeof source !== "string" ||
    !(JOURNAL_SOURCES as readonly string[]).includes(source)
  ) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_JOURNAL_FIELD",
      message: "Journal transaction source is not supported",
      path: ["source"],
      context: { source: String(source) },
    });
  }
  const expectedRevision = parseRevision(
    value.expectedRevision,
    ["expectedRevision"],
    "expected revision",
  );
  const revisionBefore = parseRevision(
    value.revisionBefore,
    ["revisionBefore"],
    "revision before",
  );
  const revisionAfter = parseRevision(
    value.revisionAfter,
    ["revisionAfter"],
    "revision after",
  );
  if (revisionAfter !== revisionBefore + 1) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_JOURNAL_FIELD",
      message: "Journal transaction must advance the revision by exactly one",
      context: { revisionBefore, revisionAfter },
    });
  }
  if (expectedRevision !== revisionBefore) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_JOURNAL_FIELD",
      message:
        "Journal transaction expected revision must equal the revision before",
      context: { expectedRevision, revisionBefore },
    });
  }
  const correlationId = parseOptionalString(
    value.correlationId,
    ["correlationId"],
    "correlation id",
  );
  const label = parseOptionalString(value.label, ["label"], "label");
  const rawCommandsValue = value.commands;
  if (!Array.isArray(rawCommandsValue)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_JOURNAL_FIELD",
      message: "Journal transaction commands must be an array",
      path: ["commands"],
    });
  }
  const rawCommands = rawCommandsValue as unknown[];
  if (rawCommands.length > limits.maxCommandsPerTransaction) {
    throw new WorkspaceError({
      family: "limit",
      code: "TOO_MANY_COMMANDS",
      message: `Journal transaction exceeds the limit of ${String(limits.maxCommandsPerTransaction)} commands`,
      context: { count: rawCommands.length },
    });
  }
  let envelopeBytes = 0;
  const commands: Command<string, JsonValue>[] = [];
  for (let index = 0; index < rawCommands.length; index += 1) {
    const envelope = rawCommands[index];
    if (!isRecord(envelope)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_JOURNAL_FIELD",
        message: "Journal command must be an object",
        path: ["commands", index],
      });
    }
    for (const field of Object.keys(envelope)) {
      if (
        field !== "id" &&
        field !== "type" &&
        field !== "schemaVersion" &&
        field !== "payload"
      ) {
        throw new WorkspaceError({
          family: "validation",
          code: "UNKNOWN_JOURNAL_FIELD",
          message:
            "Journal command contains a field this version does not support; refusing to guess at unknown data",
          context: { field, index },
        });
      }
    }
    const id = envelope.id;
    if (typeof id !== "string") {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_JOURNAL_FIELD",
        message: "Journal command id must be a string",
        path: ["commands", index, "id"],
      });
    }
    const type = envelope.type;
    if (typeof type !== "string" || type.length === 0 || type.length > 128) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_JOURNAL_FIELD",
        message:
          "Journal command type must be a string of at most 128 characters",
        path: ["commands", index, "type"],
      });
    }
    const schemaVersion = envelope.schemaVersion;
    if (
      typeof schemaVersion !== "number" ||
      !Number.isInteger(schemaVersion) ||
      schemaVersion < 1 ||
      schemaVersion > 0x7fff_ffff
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_JOURNAL_FIELD",
        message: "Journal command schema version must be a positive integer",
        path: ["commands", index, "schemaVersion"],
      });
    }
    const payload = envelope.payload as JsonValue;
    if (typeof payload !== "object" || payload === null) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_JOURNAL_FIELD",
        message: "Journal command payload must be a JSON object",
        path: ["commands", index, "payload"],
      });
    }
    const payloadBytes = canonicalJson(payload).length;
    if (payloadBytes > limits.maxCommandPayloadBytes) {
      throw new WorkspaceError({
        family: "limit",
        code: "COMMAND_PAYLOAD_TOO_LARGE",
        message: "Journal command payload exceeds the byte limit",
        path: ["commands", index],
        context: { bytes: payloadBytes },
      });
    }
    envelopeBytes += payloadBytes;
    commands.push({
      id: commandId(id),
      type,
      schemaVersion,
      payload,
    });
  }
  if (envelopeBytes > limits.maxTransactionEnvelopeBytes) {
    throw new WorkspaceError({
      family: "limit",
      code: "TRANSACTION_TOO_LARGE",
      message: "Journal transaction envelope exceeds the byte limit",
      context: { bytes: envelopeBytes },
    });
  }
  return {
    transactionId: transactionId(transactionIdValue),
    expectedRevision,
    source: source as Source,
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(label === undefined ? {} : { label }),
    revisionBefore,
    revisionAfter,
    commands,
  };
}
