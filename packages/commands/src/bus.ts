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
  type TransactionId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import type {
  ChangedVolume,
  DocumentCommitted,
  DocumentStore,
} from "@voxel-maker/document";
import type { VoxelDocument } from "@voxel-maker/model";
import {
  chunkBounds,
  chunkKey,
  type VoxelChangeSet,
  type VoxelVolume,
  type VoxelWriteCapability,
} from "@voxel-maker/voxel";
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
  | { readonly kind: "redo"; readonly entry: HistoryEntry };

/** Copy-on-write staging state for one transaction (plan 4.3). */
interface StagedOverlay {
  readonly volumes: Map<VolumeId, VoxelVolume>;
  document: MutableDocument | undefined;
}

/**
 * Mutable deep clone of the committed document for transaction staging.
 * The committed document is canonical and deeply frozen, so a JSON round
 * trip yields an independent working copy with no shared backing data.
 */
function cloneDocumentMutable(document: VoxelDocument): MutableDocument {
  return JSON.parse(JSON.stringify(document)) as MutableDocument;
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
  readonly #idempotency = new Map<TransactionId, IdempotencyRecord>();

  readonly #hooks: CommandBusHooks;

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

  /** Executes one command as a single transaction. */
  execute(command: Command, options: TransactionOptions): TransactionResult {
    return this.executeTransaction([command], options);
  }

  /** Executes a batch of commands atomically as one transaction. */
  executeTransaction(
    commands: readonly Command[],
    options: TransactionOptions,
  ): TransactionResult {
    return this.#runTransaction(commands, options, { kind: "commit" });
  }

  /** Undoes the most recent transaction, restoring exact semantic state. */
  undo(options: TransactionOptions): TransactionResult {
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

    const staged: StagedOverlay = {
      volumes: new Map<VolumeId, VoxelVolume>(),
      document: undefined,
    };
    const context = this.#makeContext(staged);
    const executions: CommandExecution[] = [];
    const inverses: (InverseCommand | readonly InverseCommand[])[] = [];
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
      executions.push(execution);
      inverses.push(execution.inverse);
    }

    const revisionBefore = this.#store.revision;
    const revisionAfter = revisionBefore + 1;
    const event = buildEvent(
      commands,
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
        { document: stagedDocument, volumes: staged.volumes },
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
      forward: commands,
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
    };

    if (mode.kind === "commit") {
      this.#pushPast(entry);
      this.#dropFuture();
    } else if (mode.kind === "undo") {
      this.#past.pop();
      this.#pushFuture({
        ...mode.entry,
        ...historyMetadata(options, revisionBefore, revisionAfter),
      });
    } else {
      this.#future.pop();
      this.#pushPast({
        ...mode.entry,
        ...historyMetadata(options, revisionBefore, revisionAfter),
      });
    }

    const result: TransactionSuccess = {
      transactionId: options.transactionId,
      revisionBefore,
      revisionAfter,
      event,
      replayed: false,
    };
    this.#idempotency.set(options.transactionId, { bytes, result });
    // Plan S5.9: semantic commit precedes durable recovery I/O. The hook
    // fires after the commit and history bookkeeping are fully done; the
    // journal writer appends asynchronously and its failures never roll
    // back or dirty the in-memory edit.
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
        commands,
      });
    } catch {
      // The commit succeeded; a journal hook failure is isolated and
      // reported through the journal's own degraded-durability events.
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

  #makeContext(staged: StagedOverlay): CommandExecutionContext {
    const store = this.#store;
    return {
      get document(): VoxelDocument {
        return staged.document ?? store.getDocument();
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

  #dropFuture(): void {
    for (const entry of this.#future) {
      this.#inverseBytes -= entry.inverseBytes;
    }
    this.#future = [];
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

function transactionBytes(commands: readonly Command[]): string {
  return canonicalJson(
    commands.map((command) => ({
      id: command.id,
      type: command.type,
      schemaVersion: command.schemaVersion,
      payload: command.payload,
    })) as JsonValue,
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
