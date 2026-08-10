import {
  canonicalJson,
  commandId,
  transactionId,
  type CommandId,
  type JsonValue,
} from "@voxel-maker/shared";
import { canonicalDocumentHash, type VoxelDocument } from "@voxel-maker/model";
import {
  type DocumentCommitted,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import type { describe, expect, it } from "vitest";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import {
  DEFAULT_COMMAND_LIMITS,
  type Command,
  type CommandLimits,
  type TransactionOptions,
} from "./types.js";

/** Minimal vitest surface the harness needs; injected by the test file. */
export interface ConformanceTestApi {
  readonly describe: typeof describe;
  readonly it: typeof it;
  readonly expect: typeof expect;
}

/** Stable `type@schemaVersion` key for a registered command (plan 4.17). */
export function commandKey(type: string, schemaVersion: number): string {
  return `${type}@${String(schemaVersion)}`;
}

/**
 * Description of one registered command for the shared conformance suite
 * (plan 4.16). Every registered persistent command must declare a spec and
 * run through `runCommandConformanceSuite` (plan 4.17).
 */
export interface CommandConformanceSpec {
  /** Suite name, conventionally `type@schemaVersion`. */
  readonly name: string;
  readonly type: string;
  readonly schemaVersion: number;
  /**
   * Inverse policy of the command (plan 4.17). Version 1 persistent edit
   * commands restore the exact pre-command semantic state on undo.
   */
  readonly inversePolicy: "exact-restore";
  /** Fresh document fixture; called once per test. */
  createDocument(): VoxelDocument;
  /** Registers the command handlers under test. */
  register(registry: CommandRegistry): void;
  /**
   * Optional deterministic preparation (for example, populating a voxel a
   * `voxel.remove` will delete). Runs through the bus before each test.
   */
  seed?(bus: CommandBus, store: DocumentStoreRead): void;
  /** Builds a valid command with a fresh id. */
  buildValid(id: CommandId): Command;
  /** Builds a command that fails parse or validation with a fresh id. */
  buildInvalid(id: CommandId): Command;
  /**
   * Optional command that passes parse/validate but fails at execution.
   * Omitted when a command cannot fail after validation.
   */
  buildExecuteInvalid?(id: CommandId): Command;
  /** Asserts the semantic state after one valid execution. */
  assertApplied(store: DocumentStoreRead, command?: Command): void;
  /**
   * Asserts the exact semantic state before the valid command (and therefore
   * after its undo): the state right after `seed`.
   */
  assertUndone(store: DocumentStoreRead, command?: Command): void;
  /** Asserts the state after redo; defaults to `assertApplied`. */
  assertRedone?(store: DocumentStoreRead, command?: Command): void;
  /** Optional second valid command touching different state. */
  buildSecondValid?(id: CommandId): Command;
  /** Asserts the state after both valid commands; defaults to `assertApplied`. */
  assertSecondApplied?(store: DocumentStoreRead, command?: Command): void;
}

interface HarnessOptions {
  readonly limits?: CommandLimits;
  readonly seed?: boolean;
}

interface Harness {
  readonly bus: CommandBus;
  readonly store: DocumentStoreRead;
}

function createHarness(
  spec: CommandConformanceSpec,
  options: HarnessOptions = {},
): Harness {
  const document = spec.createDocument();
  const { store, writeCapability } = createDocumentStoreHandle({ document });
  const registry = new CommandRegistry();
  spec.register(registry);
  const bus = new CommandBus(store, registry, writeCapability, options.limits);
  if (options.seed !== false) spec.seed?.(bus, store);
  return { bus, store };
}

function txOptions(
  spec: CommandConformanceSpec,
  id: string,
  expectedRevision: number,
  extra: Partial<
    Pick<TransactionOptions, "source" | "correlationId" | "label">
  > = {},
): TransactionOptions {
  return {
    transactionId: transactionId(`transaction:conformance:${spec.name}:${id}`),
    expectedRevision,
    source: "ui",
    ...extra,
  };
}

function commandIdFor(spec: CommandConformanceSpec, id: string): CommandId {
  return commandId(`command:conformance:${spec.name}:${id}`);
}

function envelope(command: Command): JsonValue {
  return {
    id: command.id,
    type: command.type,
    schemaVersion: command.schemaVersion,
    payload: command.payload as JsonValue,
  };
}

/** Captures the observable state a failed transaction must not change. */
function captureState(
  bus: CommandBus,
  store: DocumentStoreRead,
): {
  readonly hash: string;
  readonly history: ReturnType<CommandBus["historySnapshot"]>;
} {
  return {
    hash: canonicalDocumentHash(store.getDocument()),
    history: bus.historySnapshot(),
  };
}

function expectStateUnchanged(
  before: ReturnType<typeof captureState>,
  bus: CommandBus,
  store: DocumentStoreRead,
  expect: ConformanceTestApi["expect"],
): void {
  expect(canonicalDocumentHash(store.getDocument())).toBe(before.hash);
  expect(bus.historySnapshot()).toEqual(before.history);
}

/**
 * Runs the shared command conformance battery (plan 4.16): codec, validity,
 * inverse/undo/redo, determinism, conflict, limits, rollback, idempotency,
 * history, and audit metadata. Each test gets a fresh store.
 */
export function runCommandConformanceSuite(
  spec: CommandConformanceSpec,
  api: ConformanceTestApi,
): void {
  const { describe, it, expect } = api;

  describe(`command conformance: ${spec.name}`, () => {
    describe("codec", () => {
      it("serializes the command envelope canonically and deterministically", () => {
        const id = commandIdFor(spec, "codec:0001");
        const first = spec.buildValid(id);
        const second = spec.buildValid(id);
        const bytes = canonicalJson(envelope(first));
        expect(canonicalJson(envelope(second))).toBe(bytes);
        expect(canonicalJson(JSON.parse(bytes) as JsonValue)).toBe(bytes);
      });
    });

    describe("validity", () => {
      it("commits a valid command with one revision increment and one frozen event", () => {
        const { bus, store } = createHarness(spec);
        const events: DocumentCommitted[] = [];
        store.subscribe((event) => {
          events.push(event);
        });
        const before = store.revision;
        const result = bus.execute(
          spec.buildValid(commandIdFor(spec, "valid:0001")),
          txOptions(spec, "valid:0001", before),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.revisionBefore).toBe(before);
        expect(result.value.revisionAfter).toBe(before + 1);
        expect(store.revision).toBe(before + 1);
        expect(events).toHaveLength(1);
        expect(Object.isFrozen(result.value.event)).toBe(true);
        expect(result.value.event.commandTypes).toEqual([spec.type]);
        spec.assertApplied(store);
      });

      it("rejects an invalid command without changing state or emitting events", () => {
        const { bus, store } = createHarness(spec);
        const events: DocumentCommitted[] = [];
        store.subscribe((event) => {
          events.push(event);
        });
        const before = captureState(bus, store);
        const result = bus.execute(
          spec.buildInvalid(commandIdFor(spec, "invalid:0001")),
          txOptions(spec, "invalid:0001", store.revision),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.family).toBe("validation");
        expect(events).toHaveLength(0);
        expectStateUnchanged(before, bus, store, expect);
        spec.assertUndone(store);
      });

      it("isolates subscriber failures during commit", () => {
        const { bus, store } = createHarness(spec);
        const received: DocumentCommitted[] = [];
        store.subscribe(() => {
          throw new Error("subscriber boom");
        });
        store.subscribe((event) => {
          received.push(event);
        });
        const before = store.revision;
        const result = bus.execute(
          spec.buildValid(commandIdFor(spec, "subscriber:0001")),
          txOptions(spec, "subscriber:0001", before),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(store.revision).toBe(before + 1);
        expect(received).toHaveLength(1);
        spec.assertApplied(store);
      });
    });

    describe("inverse, undo, and redo", () => {
      it("declares the exact-restore inverse policy", () => {
        expect(spec.inversePolicy).toBe("exact-restore");
      });

      it("undo restores the exact pre-command state and redo reapplies it", () => {
        const { bus, store } = createHarness(spec);
        const before = store.revision;
        const applied = bus.execute(
          spec.buildValid(commandIdFor(spec, "ur:0001")),
          txOptions(spec, "ur:0001", before),
        );
        expect(applied.ok).toBe(true);
        if (!applied.ok) return;
        spec.assertApplied(store);

        const undone = bus.undo(txOptions(spec, "ur:undo:0001", before + 1));
        expect(undone.ok).toBe(true);
        if (!undone.ok) return;
        expect(undone.value.revisionAfter).toBe(before + 2);
        spec.assertUndone(store);

        const redone = bus.redo(txOptions(spec, "ur:redo:0001", before + 2));
        expect(redone.ok).toBe(true);
        if (!redone.ok) return;
        expect(redone.value.revisionAfter).toBe(before + 3);
        (spec.assertRedone ?? spec.assertApplied)(store);
      });

      it("undoes a multi-command transaction and redoes it as one unit", () => {
        const { bus, store } = createHarness(spec);
        if (spec.buildSecondValid === undefined) return;
        const before = store.revision;
        const applied = bus.executeTransaction(
          [
            spec.buildValid(commandIdFor(spec, "multi:0001")),
            spec.buildSecondValid(commandIdFor(spec, "multi:0002")),
          ],
          txOptions(spec, "multi:0001", before),
        );
        expect(applied.ok).toBe(true);
        if (!applied.ok) return;
        (spec.assertSecondApplied ?? spec.assertApplied)(store);

        const undone = bus.undo(txOptions(spec, "multi:undo:0001", before + 1));
        expect(undone.ok).toBe(true);
        if (!undone.ok) return;
        spec.assertUndone(store);

        const redone = bus.redo(txOptions(spec, "multi:redo:0001", before + 2));
        expect(redone.ok).toBe(true);
        if (!redone.ok) return;
        (spec.assertSecondApplied ?? spec.assertApplied)(store);
      });

      it("clears the redo history on a new commit", () => {
        const { bus, store } = createHarness(spec);
        const before = store.revision;
        bus.execute(
          spec.buildValid(commandIdFor(spec, "redo:0001")),
          txOptions(spec, "redo:0001", before),
        );
        bus.undo(txOptions(spec, "redo:undo:0001", before + 1));
        expect(bus.canRedo()).toBe(true);
        bus.execute(
          spec.buildValid(commandIdFor(spec, "redo:0002")),
          txOptions(spec, "redo:0002", before + 2),
        );
        expect(bus.canRedo()).toBe(false);
        const redo = bus.redo(txOptions(spec, "redo:redo:0001", before + 3));
        expect(redo.ok).toBe(false);
        if (redo.ok) return;
        expect(redo.error.code).toBe("NOTHING_TO_REDO");
      });

      it("reports NOTHING_TO_UNDO and NOTHING_TO_REDO at the ends", () => {
        const { bus, store } = createHarness(spec, { seed: false });
        const before = store.revision;
        const undo = bus.undo(txOptions(spec, "ends:undo:0001", before));
        expect(undo.ok).toBe(false);
        if (undo.ok) return;
        expect(undo.error.code).toBe("NOTHING_TO_UNDO");
        const redo = bus.redo(txOptions(spec, "ends:redo:0001", before));
        expect(redo.ok).toBe(false);
        if (redo.ok) return;
        expect(redo.error.code).toBe("NOTHING_TO_REDO");
      });
    });

    describe("determinism", () => {
      it("produces identical document hashes and event bytes on fresh stores", () => {
        const first = createHarness(spec);
        const second = createHarness(spec);
        const before = first.store.revision;
        const firstResult = first.bus.execute(
          spec.buildValid(commandIdFor(spec, "det:0001")),
          txOptions(spec, "det:0001", before),
        );
        const secondResult = second.bus.execute(
          spec.buildValid(commandIdFor(spec, "det:0001")),
          txOptions(spec, "det:0001", before),
        );
        expect(firstResult.ok).toBe(true);
        expect(secondResult.ok).toBe(true);
        if (!firstResult.ok || !secondResult.ok) return;
        expect(canonicalDocumentHash(first.store.getDocument())).toBe(
          canonicalDocumentHash(second.store.getDocument()),
        );
        expect(
          canonicalJson(firstResult.value.event as unknown as JsonValue),
        ).toBe(canonicalJson(secondResult.value.event as unknown as JsonValue));
        spec.assertApplied(first.store);
        spec.assertApplied(second.store);
      });
    });

    describe("conflict", () => {
      it("rejects a stale expectedRevision with REVISION_CONFLICT", () => {
        const { bus, store } = createHarness(spec);
        const before = captureState(bus, store);
        const result = bus.execute(
          spec.buildValid(commandIdFor(spec, "conflict:0001")),
          txOptions(spec, "conflict:0001", store.revision + 1),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("REVISION_CONFLICT");
        expectStateUnchanged(before, bus, store, expect);
        spec.assertUndone(store);
      });

      it("rejects undo and redo with a stale expectedRevision", () => {
        const { bus, store } = createHarness(spec);
        const before = store.revision;
        bus.execute(
          spec.buildValid(commandIdFor(spec, "conflict:0002")),
          txOptions(spec, "conflict:0002", before),
        );
        const undo = bus.undo(txOptions(spec, "conflict:undo:0001", before));
        expect(undo.ok).toBe(false);
        if (undo.ok) return;
        expect(undo.error.code).toBe("REVISION_CONFLICT");
        expect(store.revision).toBe(before + 1);
        spec.assertApplied(store);

        bus.undo(txOptions(spec, "conflict:undo:0002", before + 1));
        const redo = bus.redo(
          txOptions(spec, "conflict:redo:0001", before + 1),
        );
        expect(redo.ok).toBe(false);
        if (redo.ok) return;
        expect(redo.error.code).toBe("REVISION_CONFLICT");
        expect(store.revision).toBe(before + 2);
        spec.assertUndone(store);
      });
    });

    describe("limits", () => {
      it("rejects transactions exceeding maxCommandsPerTransaction", () => {
        const { bus, store } = createHarness(spec, {
          limits: { ...DEFAULT_COMMAND_LIMITS, maxCommandsPerTransaction: 1 },
          seed: false,
        });
        if (spec.buildSecondValid === undefined) return;
        const before = captureState(bus, store);
        const result = bus.executeTransaction(
          [
            spec.buildValid(commandIdFor(spec, "limits:0001")),
            spec.buildSecondValid(commandIdFor(spec, "limits:0002")),
          ],
          txOptions(spec, "limits:0001", store.revision),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("TOO_MANY_COMMANDS");
        expectStateUnchanged(before, bus, store, expect);
      });

      it("rejects commands exceeding maxCommandPayloadBytes", () => {
        const { bus, store } = createHarness(spec, {
          limits: { ...DEFAULT_COMMAND_LIMITS, maxCommandPayloadBytes: 1 },
          seed: false,
        });
        const before = captureState(bus, store);
        const result = bus.execute(
          spec.buildValid(commandIdFor(spec, "limits:0003")),
          txOptions(spec, "limits:0003", store.revision),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("COMMAND_PAYLOAD_TOO_LARGE");
        expectStateUnchanged(before, bus, store, expect);
      });

      it("rejects envelopes exceeding maxTransactionEnvelopeBytes", () => {
        const { bus, store } = createHarness(spec, {
          limits: { ...DEFAULT_COMMAND_LIMITS, maxTransactionEnvelopeBytes: 1 },
          seed: false,
        });
        const before = captureState(bus, store);
        const result = bus.execute(
          spec.buildValid(commandIdFor(spec, "limits:0004")),
          txOptions(spec, "limits:0004", store.revision),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("TRANSACTION_TOO_LARGE");
        expectStateUnchanged(before, bus, store, expect);
      });
    });

    describe("rollback", () => {
      it("rolls back the whole batch when a later command fails validation", () => {
        const { bus, store } = createHarness(spec);
        const events: DocumentCommitted[] = [];
        store.subscribe((event) => {
          events.push(event);
        });
        const before = captureState(bus, store);
        const result = bus.executeTransaction(
          [
            spec.buildValid(commandIdFor(spec, "rollback:0001")),
            spec.buildInvalid(commandIdFor(spec, "rollback:0002")),
          ],
          txOptions(spec, "rollback:0001", store.revision),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.family).toBe("validation");
        expect(result.error.context?.commandIndex).toBe(1);
        expect(events).toHaveLength(0);
        expectStateUnchanged(before, bus, store, expect);
        spec.assertUndone(store);
      });

      it("rolls back the whole batch when a command fails at execution", () => {
        const { bus, store } = createHarness(spec);
        if (spec.buildExecuteInvalid === undefined) return;
        const before = captureState(bus, store);
        const result = bus.executeTransaction(
          [
            spec.buildValid(commandIdFor(spec, "rollback:0003")),
            spec.buildExecuteInvalid(commandIdFor(spec, "rollback:0004")),
          ],
          txOptions(spec, "rollback:0003", store.revision),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.context?.commandIndex).toBe(1);
        expectStateUnchanged(before, bus, store, expect);
        spec.assertUndone(store);
      });
    });

    describe("idempotency", () => {
      it("replays an identical committed transaction with the recorded result", () => {
        const { bus, store } = createHarness(spec);
        const before = store.revision;
        const first = bus.execute(
          spec.buildValid(commandIdFor(spec, "idem:0001")),
          txOptions(spec, "idem:0001", before),
        );
        const second = bus.execute(
          spec.buildValid(commandIdFor(spec, "idem:0001")),
          txOptions(spec, "idem:0001", before + 1),
        );
        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(second.value.replayed).toBe(true);
        expect(second.value.revisionAfter).toBe(first.value.revisionAfter);
        expect(store.revision).toBe(before + 1);
      });

      it("rejects a reused transaction id with different canonical bytes", () => {
        const { bus, store } = createHarness(spec);
        if (spec.buildSecondValid === undefined) return;
        const before = store.revision;
        bus.execute(
          spec.buildValid(commandIdFor(spec, "idem:0002")),
          txOptions(spec, "idem:0002", before),
        );
        const result = bus.execute(
          spec.buildSecondValid(commandIdFor(spec, "idem:0003")),
          txOptions(spec, "idem:0002", before + 1),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("DUPLICATE_TRANSACTION_ID");
        expect(store.revision).toBe(before + 1);
      });

      it("checks the revision before replaying", () => {
        const { bus, store } = createHarness(spec);
        const before = store.revision;
        bus.execute(
          spec.buildValid(commandIdFor(spec, "idem:0004")),
          txOptions(spec, "idem:0004", before),
        );
        const replay = bus.execute(
          spec.buildValid(commandIdFor(spec, "idem:0004")),
          txOptions(spec, "idem:0004", before),
        );
        expect(replay.ok).toBe(false);
        if (replay.ok) return;
        expect(replay.error.code).toBe("REVISION_CONFLICT");
        expect(store.revision).toBe(before + 1);
      });
    });

    describe("history", () => {
      it("creates exactly one history entry per commit", () => {
        const { bus, store } = createHarness(spec);
        const before = store.revision;
        const seeded = bus.historySnapshot().past.length;
        bus.execute(
          spec.buildValid(commandIdFor(spec, "history:0001")),
          txOptions(spec, "history:0001", before),
        );
        expect(bus.historySnapshot().past).toHaveLength(seeded + 1);
        bus.execute(
          spec.buildValid(commandIdFor(spec, "history:0002")),
          txOptions(spec, "history:0002", before + 1),
        );
        expect(bus.historySnapshot().past).toHaveLength(seeded + 2);
        expect(bus.historySnapshot().future).toHaveLength(0);

        // One undo moves exactly one entry from past to future.
        bus.undo(txOptions(spec, "history:undo:0001", before + 2));
        expect(bus.historySnapshot().past).toHaveLength(seeded + 1);
        expect(bus.historySnapshot().future).toHaveLength(1);
        spec.assertApplied(store);

        bus.undo(txOptions(spec, "history:undo:0002", before + 3));
        expect(bus.historySnapshot().past).toHaveLength(seeded);
        expect(bus.historySnapshot().future).toHaveLength(2);
        spec.assertUndone(store);

        // Every commit created exactly one entry: undoing past the seeded
        // history eventually reports NOTHING_TO_UNDO.
        let revision = before + 4;
        let undo = bus.undo(txOptions(spec, "history:undo:0003", revision));
        revision += 1;
        while (undo.ok) {
          undo = bus.undo(
            txOptions(spec, `history:undo:${String(revision)}`, revision),
          );
          revision += 1;
        }
        expect(undo.ok).toBe(false);
        expect(undo.error.code).toBe("NOTHING_TO_UNDO");
      });

      it("bounds history by maxHistoryEntries, dropping the oldest first", () => {
        const { bus, store } = createHarness(spec, {
          limits: { ...DEFAULT_COMMAND_LIMITS, maxHistoryEntries: 2 },
        });
        const before = store.revision;
        bus.execute(
          spec.buildValid(commandIdFor(spec, "bounded:0001")),
          txOptions(spec, "bounded:0001", before),
        );
        bus.execute(
          spec.buildValid(commandIdFor(spec, "bounded:0002")),
          txOptions(spec, "bounded:0002", before + 1),
        );
        bus.execute(
          spec.buildValid(commandIdFor(spec, "bounded:0003")),
          txOptions(spec, "bounded:0003", before + 2),
        );
        expect(bus.historySnapshot().past).toHaveLength(2);
        const firstUndo = bus.undo(
          txOptions(spec, "bounded:undo:0001", before + 3),
        );
        expect(firstUndo.ok).toBe(true);
        if (!firstUndo.ok) return;
        const secondUndo = bus.undo(
          txOptions(spec, "bounded:undo:0002", before + 4),
        );
        expect(secondUndo.ok).toBe(true);
        if (!secondUndo.ok) return;
        const thirdUndo = bus.undo(
          txOptions(spec, "bounded:undo:0003", before + 5),
        );
        expect(thirdUndo.ok).toBe(false);
        if (thirdUndo.ok) return;
        expect(thirdUndo.error.code).toBe("NOTHING_TO_UNDO");
      });
    });

    describe("audit metadata", () => {
      it("carries source, correlationId, and label on events and history entries", () => {
        const { bus, store } = createHarness(spec);
        const before = store.revision;
        const applied = bus.execute(
          spec.buildValid(commandIdFor(spec, "audit:0001")),
          txOptions(spec, "audit:0001", before, {
            source: "ai",
            correlationId: "correlation:conformance:0001",
            label: "conformance audit commit",
          }),
        );
        expect(applied.ok).toBe(true);
        if (!applied.ok) return;
        expect(applied.value.event.source).toBe("ai");
        expect(applied.value.event.correlationId).toBe(
          "correlation:conformance:0001",
        );
        expect(applied.value.event.label).toBe("conformance audit commit");
        const past = bus.historySnapshot().past;
        expect(past[past.length - 1]).toMatchObject({
          source: "ai",
          correlationId: "correlation:conformance:0001",
          label: "conformance audit commit",
        });

        const undone = bus.undo(
          txOptions(spec, "audit:undo:0001", before + 1, {
            source: "ui",
            correlationId: "correlation:conformance:0002",
            label: "conformance audit undo",
          }),
        );
        expect(undone.ok).toBe(true);
        if (!undone.ok) return;
        expect(undone.value.event.source).toBe("ui");
        expect(undone.value.event.correlationId).toBe(
          "correlation:conformance:0002",
        );
        expect(undone.value.event.label).toBe("conformance audit undo");
        expect(bus.historySnapshot().future[0]).toMatchObject({
          source: "ui",
          correlationId: "correlation:conformance:0002",
          label: "conformance audit undo",
        });
      });
    });
  });
}
