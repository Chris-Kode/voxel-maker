import {
  WorkspaceError,
  canonicalJson,
  commandId,
  err,
  ok,
  type AnimationId,
  type CommandId,
  type JsonValue,
  type MaterialId,
  type NodeId,
  type Result,
  type TransactionId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import type { ChangedVolume, DocumentCommitted } from "@voxel-maker/document";
import type { DocumentStore } from "@voxel-maker/document/internal";
import type { VoxelDocument } from "@voxel-maker/model";
import {
  VoxelVolume,
  chunkBounds,
  chunkKey,
  type VoxelChangeSet,
  type VoxelWriteCapability,
} from "@voxel-maker/voxel";
import { missingVolume } from "./parse-helpers.js";
import { copyNullPrototype } from "./records.js";
import {
  DEFAULT_COMMAND_LIMITS,
  type Command,
  type CommandLimits,
  type TransactionOptions,
  type TransactionResult,
  type TransactionSuccess,
} from "./types.js";
import type { CommittedTransactionRecord } from "./codec.js";
import type {
  CommandExecutionContext,
  CommandExecution,
  DeclaredAffectedResources,
  InverseCommand,
  MutableDocument,
} from "./registry.js";
import { CommandRegistry } from "./registry.js";

/** Read-only view of one history entry (plan 4.7). */
export interface HistoryEntryInfo {
  readonly transactionId: TransactionId;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly source: DocumentCommitted["source"];
  readonly correlationId?: string;
  readonly label?: string;
}

/** Read-only snapshot of the bounded undo/redo history (plan 4.7). */
export interface HistorySnapshot {
  readonly past: readonly HistoryEntryInfo[];
  readonly future: readonly HistoryEntryInfo[];
}

/** One undoable transaction in the bounded past/future history (plan 4.2). */
interface HistoryEntry {
  readonly transactionId: TransactionId;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly forward: readonly Command[];
  readonly inverse: readonly Command[];
  readonly source: DocumentCommitted["source"];
  readonly correlationId?: string;
  readonly label?: string;
  readonly inverseBytes: number;
  /**
   * Declared affected-resource union of the forward commands (plan 5.3).
   * Coalescing requires compatible resources on the latest unsealed entry
   * (ADR-0003).
   */
  readonly affected: DeclaredAffectedResources;
  /** Forward command types in order; coalescing requires an exact match. */
  readonly types: readonly string[];
}

/**
 * One open coalescing gesture (plan S4.10, ADR-0003). A gesture runs many
 * deterministic transactions while presenting exactly one history entry:
 * every compatible `update` executes a normal atomic transaction and then
 * replaces the unsealed history entry, so the drag reads as a single
 * user-meaningful action. The entry seals on `end`, on an incompatible or
 * intervening commit, on undo/redo, on lifecycle replacement (a fresh bus
 * per install), or on failure.
 */
/** Result of opening a coalescing gesture (plan S4.10). */
export type BeginGestureResult = Result<GestureHandle, WorkspaceError>;

export interface GestureHandle {
  /** The deterministic coalescing key supplied at `beginGesture`. */
  readonly key: string;
  /** False once the gesture is sealed (end, cancel, or external commit). */
  readonly active: boolean;
  /**
   * Executes one coalesced update as a normal atomic transaction and
   * replaces the pending history entry when the key matches and the new
   * commands declare compatible affected resources and identical types.
   * On failure the pending entry seals and the error is returned.
   */
  update(
    commands: readonly Command[],
    options: TransactionOptions,
  ): TransactionResult;
  /**
   * Seals the pending history entry as a normal undoable entry. No-op when
   * the gesture is already sealed or never committed an update.
   */
  end(): void;
  /**
   * Rolls the document back to the exact pre-gesture state by executing the
   * pending entry's inverse as one transaction that leaves no history entry
   * behind (plan S4.10 "pointer cancel rollback"). `options` carries the
   * fresh transaction id and the current expected revision. Returns the
   * rollback result; on failure the pending entry seals and remains
   * undoable.
   */
  cancel(options: TransactionOptions): TransactionResult;
}

/** State of the unsealed gesture; `entry` is the live entry in `#past`. */
interface PendingGesture {
  readonly key: string;
  /** Commands of the first update; redo replays them before the latest. */
  readonly firstForward: readonly Command[];
  readonly entry: HistoryEntry;
}

interface IdempotencyRecord {
  readonly bytes: string;
  readonly result: TransactionSuccess;
}

/**
 * Optional post-commit hooks (plan S5.9). `onCommitted` fires exactly once
 * per committed transaction, after history bookkeeping, with the exact
 * commands that ran and the transaction metadata the recovery journal needs.
 * Hook exceptions are isolated: a throwing journal wiring can never break a
 * commit that already succeeded.
 */
export interface CommandBusHooks {
  readonly onCommitted?: (record: CommittedTransactionRecord) => void;
}

type RunMode =
  | { readonly kind: "commit" }
  | { readonly kind: "undo"; readonly entry: HistoryEntry }
  | { readonly kind: "redo"; readonly entry: HistoryEntry }
  /**
   * Gesture cancel rollback (plan S4.10): executes the pending inverse as
   * one atomic transaction that leaves no history entry behind.
   */
  | { readonly kind: "cancel"; readonly entry: HistoryEntry };

/** Copy-on-write staging state for one transaction (plan 4.3). */
interface StagedOverlay {
  readonly volumes: Map<VolumeId, VoxelVolume>;
  /** Committed volumes marked for removal in this transaction (ticket #24). */
  readonly removedVolumes: Set<VolumeId>;
  document: MutableDocument | undefined;
}

/**
 * Mutable deep clone of the committed document for transaction staging.
 * The committed document is canonical and deeply frozen, so a JSON round
 * trip yields an independent working copy with no shared backing data.
 * The round trip also loses the null-prototype ID-keyed records, so they
 * are rebuilt (issue #103): without this, an absent caller-supplied ID
 * such as "toString" would resolve to an inherited `Object.prototype`
 * member on the staged document and be mistaken for an existing record.
 */
function cloneDocumentMutable(document: VoxelDocument): MutableDocument {
  const cloned = JSON.parse(JSON.stringify(document)) as MutableDocument;
  cloned.nodes = copyNullPrototype(cloned.nodes);
  cloned.materials = copyNullPrototype(cloned.materials);
  cloned.volumes = copyNullPrototype(cloned.volumes);
  cloned.animations = copyNullPrototype(cloned.animations);
  return cloned;
}

/**
 * Executes validated commands against a copy-on-write staging overlay and
 * commits exactly one immutable revisioned transaction per call (plan 4.1).
 * Undo replays stored inverses in reverse order; redo replays the forward
 * commands; a new commit clears the redo history.
 */
export class CommandBus {
  readonly #store: DocumentStore;
  readonly #registry: CommandRegistry;
  readonly #writeCapability: VoxelWriteCapability;
  readonly #limits: CommandLimits;
  #past: HistoryEntry[] = [];
  #future: HistoryEntry[] = [];
  #inverseBytes = 0;
  /** Key of the gesture opened by `beginGesture` until it seals. */
  #activeGestureKey: string | undefined;
  /** The unsealed coalescing gesture, when one is active (plan S4.10). */
  #pending: PendingGesture | undefined;
  readonly #idempotency = new Map<TransactionId, IdempotencyRecord>();
  /**
   * Command ids that already ran in this session's transaction stream
   * (issue #115). A committed command id is the unique identity of one
   * committed transaction: a new normal commit must never reuse one, or
   * audit/replay identity becomes ambiguous. Records are retained for the
   * open session and every retained recovery frame (like idempotency
   * records): resetHistory clears history but not this set, and recovery
   * replays recorded frames through normal commits on a fresh bus, so the
   * ids only become known as their frames replay. Undo/redo/cancel replay
   * stored commands and derived inverses and are explicitly exempt from
   * the reuse check (ADR-0003), but their executed ids are still recorded
   * so no later normal commit can claim one.
   */
  readonly #executedCommandIds = new Set<CommandId>();

  readonly #hooks: CommandBusHooks;

  /**
   * Lifecycle revocation (ticket #54): once the owning session replaces,
   * closes, or disposes the document, this bus is permanently inert. Every
   * execute/undo/redo/gesture entry point rejects with a stable
   * `BUS_REVOKED` conflict and the `onCommitted` hook can never fire, so a
   * retained bus can neither advance its store nor leak a stale record into
   * the current document's recovery journal.
   */
  #revoked = false;

  constructor(
    store: DocumentStore,
    registry: CommandRegistry,
    writeCapability: VoxelWriteCapability,
    limits: CommandLimits = DEFAULT_COMMAND_LIMITS,
    hooks: CommandBusHooks = {},
  ) {
    this.#store = store;
    this.#registry = registry;
    this.#writeCapability = writeCapability;
    this.#limits = limits;
    this.#hooks = hooks;
  }

  /**
   * Revokes this bus (ticket #54): idempotent, permanent, and safe to call
   * from lifecycle transitions. Owned by the document lifecycle
   * coordinator (`DocumentSession`); arbitrary projections must never
   * revoke a live bus. Seals any unsealed gesture so retained handles
   * report inactive, and marks every entry point to reject. After
   * revocation even a replayed (idempotent) transaction id is rejected
   * with `BUS_REVOKED` rather than returning the recorded success: the
   * bus's epoch is over, so retrying callers must re-read the current
   * session instead. Retained gesture handles report `GESTURE_SEALED`
   * (handle surface) while direct bus calls report `BUS_REVOKED`; both
   * are stable conflicts for the same dead epoch.
   */
  revoke(): void {
    if (this.#revoked) return;
    this.#revoked = true;
    this.#sealPending();
  }

  /**
   * Clears the undo/redo history while preserving idempotency records
   * and the executed command-id records (plan 5.4, ADR-0003, issue #115).
   * Recovery replay applies recorded revision transitions through normal
   * command decoding, but a recovered document starts a fresh bounded
   * user history, so replayed transactions must not be undoable.
   * Idempotency records are retained because they live for the open
   * session and every retained recovery frame: a caller retrying a
   * replayed transaction id still receives its recorded result instead of
   * re-applying the edit. Executed command ids are retained for the same
   * horizon so a later normal commit can never reuse a replayed command
   * id. Seals any unsealed gesture so retained handles report inactive.
   * Owned by recovery and lifecycle transitions; arbitrary projections
   * must never reset a live bus's history.
   */
  resetHistory(): void {
    this.#sealPending();
    this.#past = [];
    this.#future = [];
    this.#inverseBytes = 0;
  }

  /** Executes one command as a single transaction. */
  execute(command: Command, options: TransactionOptions): TransactionResult {
    return this.executeTransaction([command], options);
  }

  /**
   * Opens a coalescing gesture (plan S4.10). Returns a handle whose
   * `update` calls execute normal transactions but replace the unsealed
   * history entry, so the whole drag presents as one history entry.
   * Rejects with `GESTURE_ACTIVE` when another gesture is already open
   * on this bus.
   */
  beginGesture(key: string): BeginGestureResult {
    if (this.#revoked) return err(busRevokedError());
    if (this.#activeGestureKey !== undefined) {
      return err(
        new WorkspaceError({
          family: "conflict",
          code: "GESTURE_ACTIVE",
          message: "Another coalescing gesture is already active",
          context: { key: this.#activeGestureKey },
        }),
      );
    }
    this.#activeGestureKey = key;
    return ok(new GestureHandleImpl(this, key));
  }

  /** Executes a batch of commands atomically as one transaction. */
  executeTransaction(
    commands: readonly Command[],
    options: TransactionOptions,
  ): TransactionResult {
    if (this.#revoked) return err(busRevokedError());
    // An intervening commit seals the unsealed gesture entry (ADR-0003).
    this.#sealPending();
    return this.#runTransaction(commands, options, { kind: "commit" });
  }

  /** Undoes the most recent transaction, restoring exact semantic state. */
  undo(options: TransactionOptions): TransactionResult {
    if (this.#revoked) return err(busRevokedError());
    // Undo seals the unsealed gesture entry, then undoes it like any
    // other entry (ADR-0003).
    this.#sealPending();
    const entry = this.#past[this.#past.length - 1];
    if (entry === undefined) {
      // Revision verification precedes idempotent replay (plan 5.4).
      if (options.expectedRevision !== this.#store.revision) {
        return err(
          revisionConflict(options.expectedRevision, this.#store.revision),
        );
      }
      const recorded = this.#idempotency.get(options.transactionId);
      if (recorded !== undefined) {
        return ok({ ...recorded.result, replayed: true });
      }
      return err(
        new WorkspaceError({
          family: "conflict",
          code: "NOTHING_TO_UNDO",
          message: "There is no committed transaction to undo",
        }),
      );
    }
    return this.#runTransaction([...entry.inverse].reverse(), options, {
      kind: "undo",
      entry,
    });
  }

  /** Redoes the most recently undone transaction. */
  redo(options: TransactionOptions): TransactionResult {
    if (this.#revoked) return err(busRevokedError());
    // Redo seals the unsealed gesture entry (ADR-0003).
    this.#sealPending();
    const entry = this.#future[this.#future.length - 1];
    if (entry === undefined) {
      // Revision verification precedes idempotent replay (plan 5.4).
      if (options.expectedRevision !== this.#store.revision) {
        return err(
          revisionConflict(options.expectedRevision, this.#store.revision),
        );
      }
      const recorded = this.#idempotency.get(options.transactionId);
      if (recorded !== undefined) {
        return ok({ ...recorded.result, replayed: true });
      }
      return err(
        new WorkspaceError({
          family: "conflict",
          code: "NOTHING_TO_REDO",
          message: "There is no undone transaction to redo",
        }),
      );
    }
    return this.#runTransaction(entry.forward, options, {
      kind: "redo",
      entry,
    });
  }

  canUndo(): boolean {
    return this.#past.length > 0;
  }

  canRedo(): boolean {
    return this.#future.length > 0;
  }

  /** Read-only snapshot of the bounded undo/redo history (plan 4.7). */
  historySnapshot(): HistorySnapshot {
    return {
      past: this.#past.map(toHistoryEntryInfo),
      future: this.#future.map(toHistoryEntryInfo),
    };
  }

  #runTransaction(
    commands: readonly Command[],
    options: TransactionOptions,
    mode: RunMode,
  ): TransactionResult {
    // Plan 5.4: budgets, then revision, then frozen idempotency replay.
    // Input budgets (payload/envelope bytes, command count) protect against
    // untrusted callers, so they apply to new commits only. Undo and redo
    // replay stored inverses that were already bounded at commit time (the
    // forward payload budget and the history inverse-bytes budget); re-checking
    // them would make large batch/fill commands un-undoable even though
    // ADR-0003 requires every v1 edit command to be undoable and ADR-0009
    // allows 1,000,000 voxels per transaction.
    if (mode.kind === "commit") {
      const budgetError = this.#checkBudgets(commands);
      if (budgetError !== undefined) return err(budgetError);
    }

    if (options.expectedRevision !== this.#store.revision) {
      return err(
        revisionConflict(options.expectedRevision, this.#store.revision),
      );
    }

    const bytes = transactionBytes(commands);
    const recorded = this.#idempotency.get(options.transactionId);
    if (recorded !== undefined) {
      if (recorded.bytes === bytes) {
        return ok({ ...recorded.result, replayed: true });
      }
      return err(
        new WorkspaceError({
          family: "conflict",
          code: "DUPLICATE_TRANSACTION_ID",
          message: "Transaction id was already used with different commands",
          context: { transactionId: options.transactionId },
        }),
      );
    }

    // Issue #115: a committed command id is the unique identity of one
    // committed transaction for the open session and every retained
    // recovery frame. Normal commits reject reuse atomically (before any
    // staging); undo/redo/cancel replay stored commands and derived
    // inverses and are exempt by design. The error code is the issue's
    // mandated `DUPLICATE_COMMAND_ID`; the same code with family
    // "validation" also covers same-batch duplicates in #checkBudgets,
    // and callers can distinguish the two failure modes by family.
    if (mode.kind === "commit") {
      for (const command of commands) {
        if (this.#executedCommandIds.has(command.id)) {
          return err(
            new WorkspaceError({
              family: "conflict",
              code: "DUPLICATE_COMMAND_ID",
              message:
                "Command id was already committed by a previous transaction",
              context: { commandId: command.id },
            }),
          );
        }
      }
    }

    const staged: StagedOverlay = {
      volumes: new Map<VolumeId, VoxelVolume>(),
      removedVolumes: new Set<VolumeId>(),
      document: undefined,
    };
    const context = this.#makeContext(staged);
    const executions: CommandExecution[] = [];
    const inverses: (InverseCommand | readonly InverseCommand[])[] = [];
    /**
     * Each executed command paired with its parsed, bounded payload
     * (issue #113). The pair keeps the envelope and payload alignment
     * structural instead of index-dependent; collected for new commits
     * only, which are the only runs that build a forward snapshot.
     */
    const parsedCommands: Array<{
      readonly command: Command;
      readonly payload: unknown;
    }> = [];
    // Issue #92: ADR-0009's 1,000,000-voxel transaction budget is a
    // cumulative meter over every command and volume of the transaction.
    // Like the byte budgets, it applies to new commits only: undo, redo,
    // and gesture-cancel replay stored inverses that were already bounded
    // at commit time.
    let transactionVoxels = 0;
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      if (command === undefined) continue;
      const handler = this.#registry.get(command.type, command.schemaVersion);
      if (handler === undefined) {
        if (this.#registry.hasType(command.type)) {
          return err(
            withCommandIndex(
              new WorkspaceError({
                family: "compatibility",
                code: "UNSUPPORTED_COMMAND_VERSION",
                message: `Command ${command.type} is not supported at schema version ${String(command.schemaVersion)}`,
                context: {
                  type: command.type,
                  schemaVersion: command.schemaVersion,
                },
              }),
              index,
            ),
          );
        }
        return err(
          withCommandIndex(
            new WorkspaceError({
              family: "validation",
              code: "UNKNOWN_COMMAND_TYPE",
              message: `No command handler is registered for ${command.type}`,
              context: { type: command.type },
            }),
            index,
          ),
        );
      }
      let payload: unknown;
      try {
        payload = handler.parse(command.payload, this.#store.limits);
      } catch (error) {
        return err(withCommandIndex(toWorkspaceError(error), index));
      }
      try {
        handler.validate(payload as never, context);
      } catch (error) {
        return err(withCommandIndex(toWorkspaceError(error), index));
      }
      let execution: CommandExecution;
      try {
        execution = handler.execute(payload as never, context);
      } catch (error) {
        return err(withCommandIndex(toWorkspaceError(error), index));
      }
      if (mode.kind === "commit") {
        parsedCommands.push({ command, payload });
      }
      executions.push(execution);
      inverses.push(execution.inverse);
      if (mode.kind === "commit") {
        transactionVoxels += changedVoxelCount(execution);
        if (transactionVoxels > this.#limits.maxVoxelsPerTransaction) {
          return err(
            withCommandIndex(
              this.#transactionVoxelLimitError(transactionVoxels),
              index,
            ),
          );
        }
      }
    }

    // Issue #113: the caller retains references to the submitted commands
    // and can mutate them after commit. Store and journal an owned
    // deep-frozen canonical snapshot of each executed forward command
    // (envelope plus parsed, bounded payload) so redo, the commit event,
    // and the committed hook record can never be rewritten by later caller
    // mutation. Undo/redo/cancel replay stored commands that are already
    // owned by the bus (handler-built inverses or frozen snapshots).
    const forwardCommands =
      mode.kind === "commit"
        ? snapshotForwardCommands(parsedCommands)
        : commands;
    const revisionBefore = this.#store.revision;
    const revisionAfter = revisionBefore + 1;
    const event = buildEvent(
      forwardCommands,
      executions,
      options,
      revisionBefore,
      revisionAfter,
    );
    const stagedDocument = {
      ...(staged.document ?? this.#store.getDocument()),
      revision: revisionAfter,
    };
    try {
      this.#store.commit(
        {
          document: stagedDocument,
          volumes: staged.volumes,
          removedVolumes: [...staged.removedVolumes],
        },
        event,
        this.#writeCapability,
      );
    } catch (error) {
      return err(toWorkspaceError(error));
    }

    const inverseCommands = inverses.flatMap((inverse, index) => {
      const list: readonly InverseCommand[] = Array.isArray(inverse)
        ? inverse
        : [inverse];
      return list.map((command, inverseIndex) => ({
        id: deriveInverseId(
          commands[index]?.id ?? commandId("command:inverse:0000"),
          inverseIndex,
        ),
        ...command,
      }));
    });
    const entry: HistoryEntry = {
      transactionId: options.transactionId,
      revisionBefore,
      revisionAfter,
      forward: forwardCommands,
      inverse: inverseCommands,
      source: options.source,
      ...(options.correlationId !== undefined
        ? { correlationId: options.correlationId }
        : {}),
      ...(options.label !== undefined ? { label: options.label } : {}),
      inverseBytes: inverseCommands.reduce(
        (total, inverse) =>
          total + canonicalJson(inverse.payload as JsonValue).length,
        0,
      ),
      affected: unionAffectedResources(executions),
      types: commands.map((command) => command.type),
    };

    if (mode.kind === "commit") {
      this.#pushPast(entry);
      this.#dropFuture();
    } else if (mode.kind === "undo") {
      // Issue #112: moving an entry past<->future is a byte-neutral
      // transfer. #popPast releases the entry's inverse bytes before
      // #pushFuture re-adds them; without the release the trim
      // double-counts the moved entry and prematurely evicts history.
      this.#popPast();
      this.#pushFuture({
        ...mode.entry,
        ...historyMetadata(options, revisionBefore, revisionAfter),
      });
    } else if (mode.kind === "redo") {
      this.#popFuture();
      this.#pushPast({
        ...mode.entry,
        ...historyMetadata(options, revisionBefore, revisionAfter),
      });
    } else {
      // Gesture cancel rollback: the inverse restored the pre-gesture
      // state; no history entry is created, moved, or replaced. The
      // handle validates the pending entry before running, so a mismatch
      // here is a programming error, never a user-visible failure.
      if (this.#pending?.entry !== mode.entry) {
        throw new Error(
          "CommandBus: cancel rollback entry is not the pending gesture",
        );
      }
      this.#popPast();
      this.#sealPending();
    }

    const result: TransactionSuccess = {
      transactionId: options.transactionId,
      revisionBefore,
      revisionAfter,
      event,
      replayed: false,
    };
    this.#idempotency.set(options.transactionId, { bytes, result });
    for (const command of commands) {
      this.#executedCommandIds.add(command.id);
    }
    // Plan S5.9: semantic commit precedes durable recovery I/O. The hook
    // fires after the commit and history bookkeeping are fully done; the
    // journal writer appends asynchronously and its failures never roll
    // back or dirty the in-memory edit. The revocation re-check is
    // defense in depth: a store commit listener that re-enters the
    // lifecycle (replace/close during `store.commit`) can revoke this bus
    // before the hook would fire, and a stale record must never reach the
    // current document's journal.
    if (!this.#revoked) {
      try {
        this.#hooks.onCommitted?.({
          transactionId: options.transactionId,
          expectedRevision: options.expectedRevision,
          source: options.source,
          ...(options.correlationId === undefined
            ? {}
            : { correlationId: options.correlationId }),
          ...(options.label === undefined ? {} : { label: options.label }),
          revisionBefore,
          revisionAfter,
          commands: forwardCommands,
        });
      } catch {
        // The commit succeeded; a journal hook failure is isolated and
        // reported through the journal's own degraded-durability events.
      }
    }
    return ok(result);
  }

  #checkBudgets(commands: readonly Command[]): WorkspaceError | undefined {
    if (commands.length > this.#limits.maxCommandsPerTransaction) {
      return new WorkspaceError({
        family: "limit",
        code: "TOO_MANY_COMMANDS",
        message: `Transaction exceeds the limit of ${String(this.#limits.maxCommandsPerTransaction)} commands`,
        context: { count: commands.length },
      });
    }
    const envelope = canonicalJson(
      commands.map((command) => command.payload) as JsonValue,
    );
    if (envelope.length > this.#limits.maxTransactionEnvelopeBytes) {
      return new WorkspaceError({
        family: "limit",
        code: "TRANSACTION_TOO_LARGE",
        message: "Transaction envelope exceeds the byte limit",
        context: { bytes: envelope.length },
      });
    }
    for (const command of commands) {
      const payloadBytes = canonicalJson(command.payload as JsonValue).length;
      if (payloadBytes > this.#limits.maxCommandPayloadBytes) {
        return new WorkspaceError({
          family: "limit",
          code: "COMMAND_PAYLOAD_TOO_LARGE",
          message: "Command payload exceeds the byte limit",
          context: { commandId: command.id, bytes: payloadBytes },
        });
      }
    }
    const ids = new Set<string>();
    for (const command of commands) {
      if (ids.has(command.id)) {
        return new WorkspaceError({
          family: "validation",
          code: "DUPLICATE_COMMAND_ID",
          message: "A transaction cannot contain the same command id twice",
          context: { commandId: command.id },
        });
      }
      ids.add(command.id);
    }
    return undefined;
  }

  /** Stable limit error for the cumulative per-transaction voxel meter. */
  #transactionVoxelLimitError(requested: number): WorkspaceError {
    return new WorkspaceError({
      family: "limit",
      code: "TOO_MANY_VOXELS",
      message: "Transaction exceeds the per-transaction voxel limit",
      context: {
        requested,
        limit: this.#limits.maxVoxelsPerTransaction,
        resource: "voxelsPerTransaction",
      },
    });
  }

  #makeContext(staged: StagedOverlay): CommandExecutionContext {
    const store = this.#store;
    return {
      get document(): VoxelDocument {
        return staged.document ?? store.getDocument();
      },
      get committedDocument(): VoxelDocument {
        return store.getDocument();
      },
      limits: store.limits,
      getVoxel: (volumeId, coordinate) => {
        const stagedVolume = staged.volumes.get(volumeId);
        return stagedVolume !== undefined
          ? stagedVolume.getVoxel(coordinate)
          : store.getVoxel(volumeId, coordinate);
      },
      getVolume: (volumeId) => {
        const stagedVolume = staged.volumes.get(volumeId);
        return stagedVolume !== undefined
          ? stagedVolume
          : store.getVolume(volumeId);
      },
      stageVolume: (volumeId) => {
        const stagedVolume = staged.volumes.get(volumeId);
        if (stagedVolume !== undefined) return stagedVolume;
        const clone = store.stageVolume(volumeId);
        if (clone !== undefined) staged.volumes.set(volumeId, clone);
        return clone;
      },
      isVolumeStaged: (volumeId) => staged.volumes.has(volumeId),
      stageNewVolume: (volumeId) => {
        if (store.getDocument().volumes[volumeId] !== undefined) {
          throw new WorkspaceError({
            family: "validation",
            code: "DUPLICATE_VOLUME_ID",
            message: "Volume already exists in the document",
            context: { volumeId },
          });
        }
        const created = new VoxelVolume(
          volumeId,
          store.volumeLimits,
          this.#writeCapability,
        );
        staged.volumes.set(volumeId, created);
        return created;
      },
      stageRemoveVolume: (volumeId) => {
        if (store.getDocument().volumes[volumeId] === undefined) {
          throw missingVolume(volumeId);
        }
        staged.removedVolumes.add(volumeId);
        // A removal supersedes any earlier staged clone or creation.
        staged.volumes.delete(volumeId);
      },
      stageCancelVolume: (volumeId) => {
        // A staged-new volume never reached the committed document, so
        // cancelling it only drops it from the overlay (ticket #111); the
        // store's removal path is not involved.
        if (!staged.volumes.has(volumeId)) {
          throw missingVolume(volumeId);
        }
        staged.volumes.delete(volumeId);
      },
      stageDocument: () => {
        if (staged.document === undefined) {
          staged.document = cloneDocumentMutable(store.getDocument());
        }
        return staged.document;
      },
      writeCapability: this.#writeCapability,
    };
  }

  #pushPast(entry: HistoryEntry): void {
    this.#past.push(entry);
    this.#inverseBytes += entry.inverseBytes;
    this.#trim();
  }

  #pushFuture(entry: HistoryEntry): void {
    this.#future.push(entry);
    this.#inverseBytes += entry.inverseBytes;
    this.#trim();
  }

  /**
   * Pops the newest past entry and releases its inverse bytes. Every pop
   * must release bytes before a matching push re-adds them, or the trim
   * double-counts the moved entry (issue #112). Accounting follows the
   * entry actually popped, keeping the byte meter consistent with the
   * retained lists.
   */
  #popPast(): HistoryEntry | undefined {
    const entry = this.#past.pop();
    if (entry !== undefined) this.#inverseBytes -= entry.inverseBytes;
    return entry;
  }

  /** Pops the newest future entry and releases its inverse bytes. */
  #popFuture(): HistoryEntry | undefined {
    const entry = this.#future.pop();
    if (entry !== undefined) this.#inverseBytes -= entry.inverseBytes;
    return entry;
  }

  #dropFuture(): void {
    for (const entry of this.#future) {
      this.#inverseBytes -= entry.inverseBytes;
    }
    this.#future = [];
  }

  /** Seals the unsealed gesture entry; it becomes a normal history entry. */
  #sealPending(): void {
    this.#activeGestureKey = undefined;
    this.#pending = undefined;
  }

  /** Key of the active gesture, or undefined once it is sealed. */
  activeGestureKey(): string | undefined {
    return this.#activeGestureKey;
  }

  /** Seals the matching gesture on `end`; no-op for foreign or sealed keys. */
  sealGesture(key: string): void {
    if (this.#activeGestureKey === key) this.#sealPending();
  }

  /**
   * One coalesced gesture update (plan S4.10). Runs a normal atomic
   * transaction, then either merges the new entry into the unsealed one
   * (compatible resources and types) or seals and starts a fresh segment.
   */
  gestureUpdate(
    key: string,
    commands: readonly Command[],
    options: TransactionOptions,
  ): TransactionResult {
    if (this.#revoked) return err(busRevokedError());
    const pending = this.#pending;
    if (pending === undefined || pending.key !== key) {
      // First update of a segment (the gesture itself, or a fresh segment
      // after an intervening commit sealed the previous one).
      const result = this.#runTransaction(commands, options, {
        kind: "commit",
      });
      if (!result.ok) return result;
      const entry = this.#past[this.#past.length - 1];
      if (entry === undefined) {
        throw new Error("CommandBus: gesture update left no history entry");
      }
      // The committed entry carries the frozen forward snapshot; the caller
      // may mutate its own commands after the update without changing what
      // redo replays (issue #113).
      this.#pending = { key, firstForward: entry.forward, entry };
      return result;
    }
    const result = this.#runTransaction(commands, options, { kind: "commit" });
    if (!result.ok) {
      // A failed update seals the pending entry (ADR-0003).
      this.#sealPending();
      return result;
    }
    const newEntry = this.#past[this.#past.length - 1];
    if (newEntry === undefined) {
      throw new Error("CommandBus: gesture update left no history entry");
    }
    if (gesturesCompatible(pending.entry, newEntry)) {
      // Replace the pending entry and the just-committed entry with one
      // merged gesture entry: the forward replay is the first update
      // followed by the latest update (both absolute deterministic
      // intents), the inverse is the first update's inverse (it restores
      // the exact pre-gesture state), and the metadata keeps the gesture
      // identity from the first update.
      const merged: HistoryEntry = {
        transactionId: pending.entry.transactionId,
        revisionBefore: pending.entry.revisionBefore,
        revisionAfter: newEntry.revisionAfter,
        forward: [...pending.firstForward, ...newEntry.forward],
        inverse: pending.entry.inverse,
        source: pending.entry.source,
        ...(pending.entry.correlationId !== undefined
          ? { correlationId: pending.entry.correlationId }
          : {}),
        ...(pending.entry.label !== undefined
          ? { label: pending.entry.label }
          : {}),
        inverseBytes: pending.entry.inverseBytes,
        affected: pending.entry.affected,
        types: pending.entry.types,
      };
      const replacedBytes = pending.entry.inverseBytes + newEntry.inverseBytes;
      this.#past[this.#past.length - 2] = merged;
      this.#past.pop();
      this.#inverseBytes += merged.inverseBytes - replacedBytes;
      this.#pending = {
        key,
        firstForward: pending.firstForward,
        entry: merged,
      };
    } else {
      // Incompatible resources or types: the just-committed entry seals
      // (it stays a normal undoable entry) and becomes the first segment
      // of a fresh pending gesture. The segment replays the committed
      // snapshot, never the caller's mutable commands (issue #113).
      this.#pending = { key, firstForward: newEntry.forward, entry: newEntry };
    }
    return result;
  }

  /**
   * Gesture cancel rollback (plan S4.10): executes the pending inverse as
   * one atomic transaction that leaves no history entry behind, restoring
   * the exact pre-gesture semantic state. On failure the pending entry
   * seals and remains undoable.
   */
  cancelGesture(key: string, options: TransactionOptions): TransactionResult {
    if (this.#revoked) return err(busRevokedError());
    if (this.#activeGestureKey !== key) {
      return err(
        new WorkspaceError({
          family: "conflict",
          code: "GESTURE_SEALED",
          message: "The coalescing gesture is not active",
          context: { key },
        }),
      );
    }
    const pending = this.#pending;
    if (pending === undefined) {
      // Nothing was committed yet: the pre-gesture state already holds.
      return ok({
        transactionId: options.transactionId,
        revisionBefore: this.#store.revision,
        revisionAfter: this.#store.revision,
        event: emptyCommittedEvent(this.#store.revision, options.transactionId),
        replayed: false,
      });
    }
    const result = this.#runTransaction(
      [...pending.entry.inverse].reverse(),
      options,
      { kind: "cancel", entry: pending.entry },
    );
    if (!result.ok) this.#sealPending();
    return result;
  }

  #trim(): void {
    while (
      this.#past.length > this.#limits.maxHistoryEntries ||
      this.#inverseBytes > this.#limits.maxHistoryInverseBytes
    ) {
      const dropped = this.#past.shift();
      if (dropped === undefined) break;
      this.#inverseBytes -= dropped.inverseBytes;
    }
    while (
      this.#future.length > this.#limits.maxHistoryEntries ||
      this.#inverseBytes > this.#limits.maxHistoryInverseBytes
    ) {
      const dropped = this.#future.shift();
      if (dropped === undefined) break;
      this.#inverseBytes -= dropped.inverseBytes;
    }
  }
}

/** Live handle to one unsealed coalescing gesture (plan S4.10). */
class GestureHandleImpl implements GestureHandle {
  readonly #bus: CommandBus;
  readonly key: string;

  constructor(bus: CommandBus, key: string) {
    this.#bus = bus;
    this.key = key;
  }

  get active(): boolean {
    return this.#bus.activeGestureKey() === this.key;
  }

  update(
    commands: readonly Command[],
    options: TransactionOptions,
  ): TransactionResult {
    if (!this.active) {
      return err(
        new WorkspaceError({
          family: "conflict",
          code: "GESTURE_SEALED",
          message: "The coalescing gesture is not active",
          context: { key: this.key },
        }),
      );
    }
    return this.#bus.gestureUpdate(this.key, commands, options);
  }

  end(): void {
    if (this.active) this.#bus.sealGesture(this.key);
  }

  cancel(options: TransactionOptions): TransactionResult {
    if (!this.active) {
      return err(
        new WorkspaceError({
          family: "conflict",
          code: "GESTURE_SEALED",
          message: "The coalescing gesture is not active",
          context: { key: this.key },
        }),
      );
    }
    return this.#bus.cancelGesture(this.key, options);
  }
}

/** Union of the declared affected resources of executed commands (5.3). */
function unionAffectedResources(
  executions: readonly CommandExecution[],
): DeclaredAffectedResources {
  const nodeIds = new Set<NodeId>();
  const materialIds = new Set<MaterialId>();
  const animationIds = new Set<AnimationId>();
  const volumeIds = new Set<VolumeId>();
  for (const execution of executions) {
    for (const id of execution.declaredAffectedResources.nodeIds) {
      nodeIds.add(id);
    }
    for (const id of execution.declaredAffectedResources.materialIds) {
      materialIds.add(id);
    }
    for (const id of execution.declaredAffectedResources.animationIds) {
      animationIds.add(id);
    }
    for (const id of execution.declaredAffectedResources.volumeIds) {
      volumeIds.add(id);
    }
  }
  return {
    nodeIds: [...nodeIds],
    materialIds: [...materialIds],
    animationIds: [...animationIds],
    volumeIds: [...volumeIds],
  };
}

/**
 * True when a gesture update may replace the pending history entry:
 * identical command types in order and equal declared affected-resource
 * sets (ADR-0003 "compatible affected resources").
 */
function gesturesCompatible(
  pending: HistoryEntry,
  candidate: HistoryEntry,
): boolean {
  if (pending.types.length !== candidate.types.length) return false;
  for (let index = 0; index < pending.types.length; index += 1) {
    if (pending.types[index] !== candidate.types[index]) return false;
  }
  return (
    idSetEqual(pending.affected.nodeIds, candidate.affected.nodeIds) &&
    idSetEqual(pending.affected.materialIds, candidate.affected.materialIds) &&
    idSetEqual(
      pending.affected.animationIds,
      candidate.affected.animationIds,
    ) &&
    idSetEqual(pending.affected.volumeIds, candidate.affected.volumeIds)
  );
}

/** Set equality of identifier arrays (duplicate-free, deterministic). */
function idSetEqual(
  a: readonly (NodeId | MaterialId | AnimationId | VolumeId)[],
  b: readonly (NodeId | MaterialId | AnimationId | VolumeId)[],
): boolean {
  if (a.length !== b.length) return false;
  const members = new Set(a);
  return b.every((id) => members.has(id));
}

/** Empty commit event for a no-op gesture cancel (no semantic change). */
function emptyCommittedEvent(
  revision: number,
  transactionId: TransactionId,
): DocumentCommitted {
  return {
    revisionBefore: revision,
    revisionAfter: revision,
    transactionId,
    source: "system",
    commandIds: [],
    commandTypes: [],
    changedNodeIds: [],
    changedMaterialIds: [],
    changedAnimationIds: [],
    changedVolumes: [],
  };
}

function toHistoryEntryInfo(entry: HistoryEntry): HistoryEntryInfo {
  return {
    transactionId: entry.transactionId,
    revisionBefore: entry.revisionBefore,
    revisionAfter: entry.revisionAfter,
    source: entry.source,
    ...(entry.correlationId !== undefined
      ? { correlationId: entry.correlationId }
      : {}),
    ...(entry.label !== undefined ? { label: entry.label } : {}),
  };
}

function historyMetadata(
  options: TransactionOptions,
  revisionBefore: number,
  revisionAfter: number,
): Pick<
  HistoryEntry,
  | "transactionId"
  | "revisionBefore"
  | "revisionAfter"
  | "source"
  | "correlationId"
  | "label"
> {
  return {
    transactionId: options.transactionId,
    revisionBefore,
    revisionAfter,
    source: options.source,
    ...(options.correlationId !== undefined
      ? { correlationId: options.correlationId }
      : {}),
    ...(options.label !== undefined ? { label: options.label } : {}),
  };
}

/**
 * Owned deep-frozen canonical snapshot of one executed transaction's forward
 * commands (issue #113): the envelope with the parsed, bounded payload copied
 * so no caller-held reference can rewrite committed history, the commit
 * event, or the journaled hook record after commit. Parse results are
 * validated and bounded but may still alias caller data (for example
 * `volume.create` keeps the caller's raw entries record), so the payload is
 * deep-copied before freezing; the frozen copy is safe to replay and to
 * serialize into the recovery journal.
 */
function snapshotForwardCommands(
  parsed: readonly { readonly command: Command; readonly payload: unknown }[],
): readonly Command[] {
  return parsed.map(({ command, payload }) =>
    Object.freeze(
      commandEnvelope(
        command.id,
        command.type,
        command.schemaVersion,
        deepFreezeClone(payload),
      ),
    ),
  );
}

/**
 * Owned deep-frozen copy of a parsed command payload (issue #113).
 * Primitives are immutable and returned as-is; arrays and records are
 * rebuilt so the copy never shares identity with caller-held objects, then
 * frozen. Only plain JSON trees can reach this walker by contract: parse
 * helpers rebuild fresh plain structures from input that already passed
 * commit-time canonicalization (the budget check), and the one caller
 * record a parse may keep by reference (`volume.create` entries) also
 * passed canonicalization. Null-prototype records are preserved so an
 * absent ID-keyed member can never resolve to an inherited
 * `Object.prototype` member in the owned snapshot (issue #103).
 */
function deepFreezeClone(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFreezeClone(item)));
  }
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> =
    Object.getPrototypeOf(value) === null
      ? (Object.create(null) as Record<string, unknown>)
      : {};
  for (const key of Object.keys(source)) {
    copy[key] = deepFreezeClone(source[key]);
  }
  return Object.freeze(copy);
}

/** One command envelope; shared by the snapshot and byte-budget paths. */
function commandEnvelope(
  id: CommandId,
  type: string,
  schemaVersion: number,
  payload: unknown,
): { id: CommandId; type: string; schemaVersion: number; payload: unknown } {
  return { id, type, schemaVersion, payload };
}

function transactionBytes(commands: readonly Command[]): string {
  return canonicalJson(
    commands.map((command) =>
      commandEnvelope(
        command.id,
        command.type,
        command.schemaVersion,
        command.payload,
      ),
    ) as JsonValue,
  );
}

function buildEvent(
  commands: readonly Command[],
  executions: readonly CommandExecution[],
  options: TransactionOptions,
  revisionBefore: number,
  revisionAfter: number,
): DocumentCommitted {
  // Declared resources count as changed only when the command actually
  // changed something (a record mutation or a non-empty voxel change set);
  // no-op commits report no changed resources.
  const nodeIds = new Set<NodeId>();
  const materialIds = new Set<MaterialId>();
  const animationIds = new Set<AnimationId>();
  for (const execution of executions) {
    const changeSets = changeSetsOf(execution);
    const changed =
      execution.changedRecords === true ||
      changeSets.some((changeSet) => changeSet.chunks.length > 0);
    if (!changed) continue;
    for (const nodeId of execution.declaredAffectedResources.nodeIds) {
      nodeIds.add(nodeId);
    }
    for (const materialId of execution.declaredAffectedResources.materialIds) {
      materialIds.add(materialId);
    }
    for (const animationId of execution.declaredAffectedResources
      .animationIds) {
      animationIds.add(animationId);
    }
  }
  return {
    revisionBefore,
    revisionAfter,
    transactionId: options.transactionId,
    source: options.source,
    ...(options.correlationId !== undefined
      ? { correlationId: options.correlationId }
      : {}),
    commandIds: commands.map((command) => command.id),
    commandTypes: commands.map((command) => command.type),
    changedNodeIds: [...nodeIds],
    changedMaterialIds: [...materialIds],
    changedAnimationIds: [...animationIds],
    changedVolumes: mergeChangeSets(executions.flatMap(changeSetsOf)),
    ...(options.label !== undefined ? { label: options.label } : {}),
  };
}

/**
 * Net voxels changed by one execution (issue #92): the sum of every patch in
 * every change set the execution produced. This mirrors the volume-level
 * semantic bound (the net plan after dedup and no-op filtering is "the voxels
 * actually changed by the operation", ADR-0009) accumulated across commands
 * and volumes of one transaction.
 */
function changedVoxelCount(execution: CommandExecution): number {
  let total = 0;
  for (const changeSet of changeSetsOf(execution)) {
    for (const chunk of changeSet.chunks) {
      total += chunk.patches.length;
    }
  }
  return total;
}

/** All voxel change sets produced by one command execution. */
function changeSetsOf(execution: CommandExecution): readonly VoxelChangeSet[] {
  return [
    ...(execution.changeSet === undefined ? [] : [execution.changeSet]),
    ...(execution.additionalChangeSets ?? []),
  ];
}

function mergeChangeSets(
  changeSets: readonly VoxelChangeSet[],
): readonly ChangedVolume[] {
  const byVolume = new Map<
    VolumeId,
    {
      chunkByKey: Map<string, { coordinate: Vec3i; revision: number }>;
      bounds: IntAabb | undefined;
    }
  >();
  for (const changeSet of changeSets) {
    if (changeSet.chunks.length === 0) continue;
    let entry = byVolume.get(changeSet.volumeId);
    if (entry === undefined) {
      entry = { chunkByKey: new Map(), bounds: undefined };
      byVolume.set(changeSet.volumeId, entry);
    }
    for (const chunk of changeSet.chunks) {
      const key = chunkKey(chunk.coordinate);
      const existing = entry.chunkByKey.get(key);
      if (existing !== undefined) {
        existing.revision = chunk.revision;
      } else {
        entry.chunkByKey.set(key, {
          coordinate: chunk.coordinate,
          revision: chunk.revision,
        });
      }
      const aabb = chunkBounds(chunk.coordinate);
      entry.bounds =
        entry.bounds === undefined ? aabb : unionAabb(entry.bounds, aabb);
    }
  }
  return [...byVolume.entries()].map(([volumeId, entry]) => ({
    volumeId,
    chunks: [...entry.chunkByKey.values()],
    ...(entry.bounds !== undefined ? { bounds: entry.bounds } : {}),
  }));
}

function unionAabb(a: IntAabb, b: IntAabb): IntAabb {
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ],
  };
}

const INVERSE_SUFFIX = ":inv";
const MAX_ID_LENGTH = 128;

/**
 * Deterministic inverse command id derived from the forward command id.
 * Commands with several inverse commands get distinct suffixes.
 */
function deriveInverseId(id: CommandId, inverseIndex: number): CommandId {
  const suffix =
    inverseIndex === 0
      ? INVERSE_SUFFIX
      : `${INVERSE_SUFFIX}:${String(inverseIndex + 1)}`;
  const base =
    id.length + suffix.length <= MAX_ID_LENGTH
      ? id
      : id.slice(0, MAX_ID_LENGTH - suffix.length);
  return commandId(`${base}${suffix}`);
}

function toWorkspaceError(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  return new WorkspaceError({
    family: "internal",
    code: "INTERNAL_COMMAND_ERROR",
    message: "Command execution failed with an unexpected error",
    cause: {
      type: error instanceof Error ? error.constructor.name : typeof error,
    },
  });
}

/** Stable conflict for a bus revoked by a lifecycle transition (#54). */
function busRevokedError(): WorkspaceError {
  return new WorkspaceError({
    family: "conflict",
    code: "BUS_REVOKED",
    message: "This command bus was revoked by a document lifecycle transition",
  });
}

function revisionConflict(expected: number, actual: number): WorkspaceError {
  return new WorkspaceError({
    family: "conflict",
    code: "REVISION_CONFLICT",
    message: "Expected revision does not match the current document revision",
    context: { expected, actual },
  });
}

/** Attaches the failing command's index to a per-command error (plan 5.4). */
function withCommandIndex(
  error: WorkspaceError,
  commandIndex: number,
): WorkspaceError {
  return new WorkspaceError({
    family: error.family,
    code: error.code,
    message: error.message,
    ...(error.path !== undefined ? { path: error.path } : {}),
    ...(error.context !== undefined
      ? { context: { ...error.context, commandIndex } }
      : { context: { commandIndex } }),
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
  });
}
