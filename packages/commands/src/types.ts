import type {
  CommandId,
  Result,
  TransactionId,
  WorkspaceError,
} from "@voxel-maker/shared";
import type { DocumentCommitted, Source } from "@voxel-maker/document";

/** A validated, immutable command ready for execution (plan 4.1). */
export interface Command<TType extends string = string, TPayload = unknown> {
  readonly id: CommandId;
  readonly type: TType;
  readonly schemaVersion: number;
  readonly payload: TPayload;
}

/** Transaction and history budgets (plan 4.2 / ADR-0009). */
export interface CommandLimits {
  readonly maxCommandsPerTransaction: number;
  readonly maxCommandPayloadBytes: number;
  readonly maxTransactionEnvelopeBytes: number;
  /**
   * ADR-0009: voxels changed by one Transaction (net after dedup and
   * no-op filtering, mirroring the volume-level semantic bound). Enforced
   * cumulatively across every command and volume of the transaction
   * (issue #92), not per volume or per command. Per-operation inspection
   * remains bounded by the volume's per-operation limit.
   */
  readonly maxVoxelsPerTransaction: number;
  readonly maxHistoryEntries: number;
  readonly maxHistoryInverseBytes: number;
}

/** ADR-0009 hard defaults for command transactions. */
export const DEFAULT_COMMAND_LIMITS: CommandLimits = Object.freeze({
  maxCommandsPerTransaction: 1_024,
  maxCommandPayloadBytes: 1_048_576,
  maxTransactionEnvelopeBytes: 16_777_216,
  maxVoxelsPerTransaction: 1_000_000,
  maxHistoryEntries: 512,
  maxHistoryInverseBytes: 268_435_456,
});

/** Options every transaction requires (plan 4.1). */
export interface TransactionOptions {
  readonly transactionId: TransactionId;
  /** Revision the caller observed; mismatches fail with REVISION_CONFLICT. */
  readonly expectedRevision: number;
  readonly source: Source;
  readonly correlationId?: string;
  readonly label?: string;
}

/** Successful outcome of a committed transaction. */
export interface TransactionSuccess {
  readonly transactionId: TransactionId;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly event: DocumentCommitted;
  /** True when an identical transaction was already committed and replayed. */
  readonly replayed: boolean;
}

export type TransactionResult = Result<TransactionSuccess, WorkspaceError>;
