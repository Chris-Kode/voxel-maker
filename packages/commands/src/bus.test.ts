import { describe, expect, it } from "vitest";
import {
  commandId,
  materialId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { createDocumentStore } from "@voxel-maker/document";
import { CommandBus } from "./bus.js";
import type { TransactionOptions } from "./types.js";
import { CommandRegistry } from "./registry.js";
import {
  registerVoxelCommands,
  removeVoxelCommand,
  setVoxelCommand,
} from "./voxel-commands.js";
import { fillBoxCommand, registerBatchCommands } from "./batch-commands.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function createDemoDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:bus:0001" as never,
    metadata: { title: "bus test", tags: [] },
    rootNodeId: "node:bus:root" as never,
    nodes: [
      {
        nodeId: "node:bus:root" as never,
        name: "Root",
        parentId: null,
        children: [],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: volumeId("volume:bus:0001"),
          },
        ],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "demo",
        color: "#ff8800",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: volumeId("volume:bus:0001"),
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    ],
  });
}

const VOLUME = volumeId("volume:bus:0001");

function createBus(limits?: ConstructorParameters<typeof CommandBus>[3]): {
  bus: CommandBus;
  store: ReturnType<typeof createDocumentStore>["store"];
} {
  const { store, writeCapability } = createDocumentStore({
    document: createDemoDocument(),
  });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  return {
    bus: new CommandBus(store, registry, writeCapability, limits),
    store,
  };
}

const set = (
  id: string,
  coordinate: readonly [number, number, number],
  material = 1,
) =>
  setVoxelCommand(commandId(`command:bus:${id}`), {
    volumeId: VOLUME,
    coordinate,
    material: materialId(material),
  });
const remove = (id: string, coordinate: readonly [number, number, number]) =>
  removeVoxelCommand(commandId(`command:bus:${id}`), {
    volumeId: VOLUME,
    coordinate,
  });
const options = (id: string, expectedRevision: number): TransactionOptions => ({
  transactionId: transactionId(`transaction:bus:${id}`),
  expectedRevision,
  source: "ui",
});

describe("CommandBus.execute", () => {
  it("commits one transaction with exactly one revision increment and one event", () => {
    const { bus, store } = createBus();
    const events: unknown[] = [];
    store.subscribe((event) => {
      events.push(event);
    });
    const result = bus.execute(
      set("set:0001", [0, 0, 0]),
      options("set:0001", 0),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revisionAfter).toBe(1);
    expect(store.revision).toBe(1);
    expect(events).toHaveLength(1);
    expect(Object.isFrozen(result.value.event)).toBe(true);
    expect(result.value.event.revisionBefore).toBe(0);
    expect(result.value.event.revisionAfter).toBe(1);
  });

  it("rejects a stale expectedRevision with REVISION_CONFLICT", () => {
    const { bus, store } = createBus();
    bus.execute(set("set:0002", [0, 0, 0]), options("set:0002", 0));
    const result = bus.execute(
      set("set:0003", [1, 0, 0]),
      options("set:0003", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REVISION_CONFLICT");
    expect(store.revision).toBe(1);
    expect(store.getVoxel(VOLUME, [1, 0, 0])).toBe(0);
  });

  it("rejects unknown command types and unsupported versions", () => {
    const { bus, store } = createBus();
    const unknown = bus.execute(
      {
        id: commandId("command:bus:unknown:0001"),
        type: "no.such.command",
        schemaVersion: 1,
        payload: {},
      },
      options("unknown:0001", 0),
    );
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("UNKNOWN_COMMAND_TYPE");
    const version = bus.execute(
      {
        id: commandId("command:bus:version:0001"),
        type: "voxel.set",
        schemaVersion: 99,
        payload: {},
      },
      options("version:0001", 0),
    );
    expect(version.ok).toBe(false);
    if (version.ok) return;
    expect(version.error.code).toBe("UNSUPPORTED_COMMAND_VERSION");
    expect(store.revision).toBe(0);
  });

  it("rejects duplicate command ids within one transaction", () => {
    const { bus, store } = createBus();
    const result = bus.executeTransaction(
      [set("dup:0001", [0, 0, 0]), set("dup:0001", [1, 0, 0])],
      options("dup:0001", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DUPLICATE_COMMAND_ID");
    expect(store.revision).toBe(0);
  });

  it("enforces transaction budgets", () => {
    const { bus, store } = createBus({
      maxCommandsPerTransaction: 1,
      maxCommandPayloadBytes: 1_048_576,
      maxTransactionEnvelopeBytes: 16_777_216,
      maxHistoryEntries: 512,
      maxHistoryInverseBytes: 268_435_456,
    });
    const result = bus.executeTransaction(
      [set("budget:0001", [0, 0, 0]), set("budget:0002", [1, 0, 0])],
      options("budget:0001", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TOO_MANY_COMMANDS");
    expect(store.revision).toBe(0);
  });
});

describe("CommandBus.executeTransaction", () => {
  it("applies multiple commands atomically in order", () => {
    const { bus, store } = createBus();
    const result = bus.executeTransaction(
      [
        set("multi:0001", [0, 0, 0], 1),
        set("multi:0002", [1, 0, 0], 1),
        set("multi:0003", [-1, 0, 0], 1),
      ],
      options("multi:0001", 0),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(1);
    expect(store.getVoxel(VOLUME, [1, 0, 0])).toBe(1);
    expect(store.getVoxel(VOLUME, [-1, 0, 0])).toBe(1);
    expect(result.value.event.commandIds).toEqual([
      "command:bus:multi:0001",
      "command:bus:multi:0002",
      "command:bus:multi:0003",
    ]);
    expect(result.value.event.changedVolumes).toHaveLength(1);
    expect(result.value.event.changedVolumes[0]?.chunks).toHaveLength(2);
  });

  it("declares the affected node, material, and volume in the event", () => {
    const { bus } = createBus();
    const result = bus.execute(
      set("aff:0001", [0, 0, 0], 1),
      options("aff:0001", 0),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event.changedNodeIds).toEqual(["node:bus:root"]);
    expect(result.value.event.changedMaterialIds).toEqual([1]);
    expect(result.value.event.changedAnimationIds).toEqual([]);
    expect(result.value.event.changedVolumes[0]?.volumeId).toBe(VOLUME);
  });

  it("reports no changed resources for a no-op commit", () => {
    const { bus } = createBus();
    bus.execute(set("noop:0001", [0, 0, 0], 1), options("noop:0001", 0));
    const result = bus.execute(
      set("noop:0002", [0, 0, 0], 1),
      options("noop:0002", 1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event.changedNodeIds).toEqual([]);
    expect(result.value.event.changedMaterialIds).toEqual([]);
    expect(result.value.event.changedVolumes).toEqual([]);
  });

  it("rolls back the whole transaction when any command fails", () => {
    const { bus, store } = createBus();
    const result = bus.executeTransaction(
      [
        set("atomic:0001", [0, 0, 0], 1),
        {
          id: commandId("command:bus:atomic:0002"),
          type: "voxel.set",
          schemaVersion: 1,
          payload: {
            volumeId: volumeId("volume:missing:0001"),
            coordinate: [1, 0, 0],
            material: materialId(1),
          },
        },
      ],
      options("atomic:0001", 0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_VOLUME");
    expect(result.error.context?.commandIndex).toBe(1);
    expect(store.revision).toBe(0);
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(0);
    expect(store.getVoxel(VOLUME, [1, 0, 0])).toBe(0);
  });

  it("reports the failing command index for parse and execute errors", () => {
    const { bus } = createBus();
    const parseFailure = bus.executeTransaction(
      [
        set("idx:0001", [0, 0, 0], 1),
        {
          id: commandId("command:bus:idx:0002"),
          type: "voxel.set",
          schemaVersion: 1,
          payload: {
            volumeId: volumeId("volume:missing:0001"),
            coordinate: [0.5, 0, 0],
            material: materialId(1),
          },
        },
      ],
      options("idx:0001", 0),
    );
    expect(parseFailure.ok).toBe(false);
    if (parseFailure.ok) return;
    expect(parseFailure.error.code).toBe("INVALID_VOXEL_COORDINATE");
    expect(parseFailure.error.context?.commandIndex).toBe(1);
  });

  it("lets later commands see earlier staged writes", () => {
    const { bus, store } = createBus();
    const result = bus.executeTransaction(
      [set("seq:0001", [0, 0, 0], 1), remove("seq:0002", [0, 0, 0])],
      options("seq:0001", 0),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(0);
    expect(store.getVolume(VOLUME)?.chunkCount()).toBe(0);
  });
});

describe("idempotency", () => {
  it("replays an identical committed transaction with the recorded result", () => {
    const { bus, store } = createBus();
    const first = bus.execute(
      set("idem:0001", [0, 0, 0]),
      options("idem:0001", 0),
    );
    const second = bus.execute(
      set("idem:0001", [0, 0, 0]),
      options("idem:0001", 1),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.revisionAfter).toBe(first.value.revisionAfter);
    expect(store.revision).toBe(1);
  });

  it("rejects an idempotent replay with a stale expectedRevision", () => {
    const { bus, store } = createBus();
    bus.execute(set("idem:0003", [0, 0, 0]), options("idem:0003", 0));
    const replay = bus.execute(
      set("idem:0003", [0, 0, 0]),
      options("idem:0003", 0),
    );
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.code).toBe("REVISION_CONFLICT");
    expect(store.revision).toBe(1);
  });

  it("rejects a reused transaction id with different bytes", () => {
    const { bus, store } = createBus();
    bus.execute(set("idem:0002", [0, 0, 0]), options("idem:0002", 0));
    const result = bus.execute(
      set("idem:0002", [1, 0, 0]),
      options("idem:0002", 1),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DUPLICATE_TRANSACTION_ID");
    expect(store.revision).toBe(1);
  });
});

describe("undo and redo", () => {
  it("undoes a set and redoes it, restoring exact semantic state", () => {
    const { bus, store } = createBus();
    bus.execute(set("ur:0001", [-1, 0, 1]), options("ur:0001", 0));
    expect(store.getVoxel(VOLUME, [-1, 0, 1])).toBe(1);

    const undo = bus.undo(options("ur:undo:0001", 1));
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.value.revisionAfter).toBe(2);
    expect(store.getVoxel(VOLUME, [-1, 0, 1])).toBe(0);
    expect(store.getVolume(VOLUME)?.chunkCount()).toBe(0);
    expect(bus.canUndo()).toBe(false);
    expect(bus.canRedo()).toBe(true);

    const redo = bus.redo(options("ur:redo:0001", 2));
    expect(redo.ok).toBe(true);
    if (!redo.ok) return;
    expect(redo.value.revisionAfter).toBe(3);
    expect(store.getVoxel(VOLUME, [-1, 0, 1])).toBe(1);
    expect(bus.canUndo()).toBe(true);
    expect(bus.canRedo()).toBe(false);
  });

  it("undoes a remove by restoring the removed voxel", () => {
    const { bus, store } = createBus();
    bus.execute(set("ur:0002", [0, 0, 0]), options("ur:0002", 0));
    bus.execute(remove("ur:0003", [0, 0, 0]), options("ur:0003", 1));
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(0);
    const undo = bus.undo(options("ur:undo:0002", 2));
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(1);
  });

  it("undoes a multi-command transaction in reverse order", () => {
    const { bus, store } = createBus();
    bus.executeTransaction(
      [set("ur:0004", [0, 0, 0], 1), set("ur:0005", [1, 0, 0], 1)],
      options("ur:0004", 0),
    );
    const undo = bus.undo(options("ur:undo:0003", 1));
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(0);
    expect(store.getVoxel(VOLUME, [1, 0, 0])).toBe(0);
  });

  it("clears redo history on a new commit", () => {
    const { bus } = createBus();
    bus.execute(set("ur:0006", [0, 0, 0]), options("ur:0006", 0));
    bus.undo(options("ur:undo:0004", 1));
    expect(bus.canRedo()).toBe(true);
    bus.execute(set("ur:0007", [1, 0, 0]), options("ur:0007", 2));
    expect(bus.canRedo()).toBe(false);
    const redo = bus.redo(options("ur:redo:0002", 3));
    expect(redo.ok).toBe(false);
    if (redo.ok) return;
    expect(redo.error.code).toBe("NOTHING_TO_REDO");
  });

  it("resetHistory clears undo/redo history but preserves idempotency", () => {
    const { bus, store } = createBus();
    bus.execute(set("rh:0001", [0, 0, 0]), options("rh:0001", 0));
    bus.execute(set("rh:0002", [1, 0, 0]), options("rh:0002", 1));
    expect(bus.historySnapshot().past).toHaveLength(2);
    expect(bus.canUndo()).toBe(true);

    bus.resetHistory();

    // The history is fresh: nothing to undo or redo.
    expect(bus.historySnapshot().past).toHaveLength(0);
    expect(bus.historySnapshot().future).toHaveLength(0);
    expect(bus.canUndo()).toBe(false);
    expect(bus.canRedo()).toBe(false);
    const undo = bus.undo(options("rh:undo:0001", 2));
    expect(undo.ok).toBe(false);
    if (undo.ok) return;
    expect(undo.error.code).toBe("NOTHING_TO_UNDO");

    // Idempotency records survive the reset (ADR-0003): retrying a
    // committed transaction id returns its recorded result without
    // advancing the revision.
    const retry = bus.execute(set("rh:0002", [1, 0, 0]), options("rh:0002", 2));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.replayed).toBe(true);
    expect(retry.value.revisionAfter).toBe(2);
    expect(store.revision).toBe(2);

    // A fresh commit after the reset is normally undoable.
    bus.execute(set("rh:0003", [2, 0, 0]), options("rh:0003", 2));
    expect(bus.canUndo()).toBe(true);
    expect(bus.historySnapshot().past).toHaveLength(1);
  });

  it("reports NOTHING_TO_UNDO and NOTHING_TO_REDO at the ends", () => {
    const { bus } = createBus();
    const undo = bus.undo(options("ur:undo:0005", 0));
    expect(undo.ok).toBe(false);
    if (undo.ok) return;
    expect(undo.error.code).toBe("NOTHING_TO_UNDO");
    const redo = bus.redo(options("ur:redo:0003", 0));
    expect(redo.ok).toBe(false);
    if (redo.ok) return;
    expect(redo.error.code).toBe("NOTHING_TO_REDO");
  });

  it("requires the current expectedRevision for undo and redo", () => {
    const { bus, store } = createBus();
    bus.execute(set("ur:0008", [0, 0, 0]), options("ur:0008", 0));
    const undo = bus.undo(options("ur:undo:0006", 0));
    expect(undo.ok).toBe(false);
    if (undo.ok) return;
    expect(undo.error.code).toBe("REVISION_CONFLICT");
    expect(store.revision).toBe(1);
  });

  it("replays an identical undo transaction idempotently", () => {
    const { bus, store } = createBus();
    bus.execute(set("ur:0009", [0, 0, 0]), options("ur:0009", 0));
    const first = bus.undo(options("ur:undo:0007", 1));
    const second = bus.undo(options("ur:undo:0007", 2));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(store.revision).toBe(2);
  });

  it("undoes a no-op commit as a no-op", () => {
    const { bus, store } = createBus();
    bus.execute(remove("ur:0010", [0, 0, 0]), options("ur:0010", 0));
    expect(store.revision).toBe(1);
    const undo = bus.undo(options("ur:undo:0008", 1));
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.value.revisionAfter).toBe(2);
    expect(store.getVoxel(VOLUME, [0, 0, 0])).toBe(0);
  });

  it("exposes a read-only history snapshot with entry metadata", () => {
    const { bus, store } = createBus();
    bus.execute(set("hs:0001", [0, 0, 0]), {
      ...options("hs:0001", 0),
      source: "ai",
      correlationId: "correlation:bus:hs:0001",
      label: "history snapshot commit",
    });
    let snapshot = bus.historySnapshot();
    expect(snapshot.past).toHaveLength(1);
    expect(snapshot.future).toHaveLength(0);
    expect(snapshot.past[0]).toMatchObject({
      transactionId: "transaction:bus:hs:0001",
      revisionBefore: 0,
      revisionAfter: 1,
      source: "ai",
      correlationId: "correlation:bus:hs:0001",
      label: "history snapshot commit",
    });
    bus.undo(options("hs:undo:0001", 1));
    snapshot = bus.historySnapshot();
    expect(snapshot.past).toHaveLength(0);
    expect(snapshot.future).toHaveLength(1);
    expect(snapshot.future[0]?.transactionId).toBe(
      "transaction:bus:hs:undo:0001",
    );
    expect(snapshot.future[0]?.revisionBefore).toBe(1);
    expect(snapshot.future[0]?.revisionAfter).toBe(2);
    expect(store.revision).toBe(2);
  });

  it("bounded history drops the oldest entries", () => {
    const { bus, store } = createBus({
      maxCommandsPerTransaction: 1_024,
      maxCommandPayloadBytes: 1_048_576,
      maxTransactionEnvelopeBytes: 16_777_216,
      maxHistoryEntries: 2,
      maxHistoryInverseBytes: 268_435_456,
    });
    bus.execute(set("h:0001", [0, 0, 0]), options("h:0001", 0));
    bus.execute(set("h:0002", [1, 0, 0]), options("h:0002", 1));
    bus.execute(set("h:0003", [2, 0, 0]), options("h:0003", 2));
    expect(store.revision).toBe(3);
    const undo = bus.undo(options("h:undo:0001", 3));
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(store.getVoxel(VOLUME, [2, 0, 0])).toBe(0);
    const undo2 = bus.undo(options("h:undo:0002", 4));
    expect(undo2.ok).toBe(true);
    if (!undo2.ok) return;
    expect(store.getVoxel(VOLUME, [1, 0, 0])).toBe(0);
    const undo3 = bus.undo(options("h:undo:0003", 5));
    expect(undo3.ok).toBe(false);
    if (undo3.ok) return;
    expect(undo3.error.code).toBe("NOTHING_TO_UNDO");
  });

  it("undoes a fill whose inverse exceeds the forward payload budget", () => {
    // ADR-0003: every v1 edit command is undoable. The forward fill payload
    // is tiny, but its exact inverse (one patch per voxel) is large; input
    // budgets apply to new commits only, so undo must still succeed.
    const { bus, store } = createBus({
      maxCommandsPerTransaction: 1_024,
      maxCommandPayloadBytes: 200,
      maxTransactionEnvelopeBytes: 16_777_216,
      maxHistoryEntries: 512,
      maxHistoryInverseBytes: 268_435_456,
    });
    const before = store.revision;
    const applied = bus.execute(
      fillBoxCommand(commandId("command:bus:budget-fill:0001"), {
        volumeId: VOLUME,
        region: { min: [0, 0, 0], max: [4, 4, 4] },
        material: materialId(1),
      }),
      options("budget-fill:0001", before),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(store.getVoxel(VOLUME, [3, 3, 3])).toBe(1);

    const undone = bus.undo(options("budget-fill:undo:0001", before + 1));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(store.getVoxel(VOLUME, [3, 3, 3])).toBe(0);
    expect(store.revision).toBe(before + 2);

    const redone = bus.redo(options("budget-fill:redo:0001", before + 2));
    expect(redone.ok).toBe(true);
    if (!redone.ok) return;
    expect(store.getVoxel(VOLUME, [3, 3, 3])).toBe(1);
  });
});
describe("CommandBus.revoke", () => {
  function createHookedBus(): {
    bus: CommandBus;
    store: ReturnType<typeof createDocumentStore>["store"];
    records: Array<{ revisionAfter: number; transactionId: string }>;
  } {
    const { store, writeCapability } = createDocumentStore({
      document: createDemoDocument(),
    });
    const registry = new CommandRegistry();
    registerVoxelCommands(registry);
    const records: Array<{ revisionAfter: number; transactionId: string }> = [];
    const bus = new CommandBus(store, registry, writeCapability, undefined, {
      onCommitted(record) {
        records.push({
          revisionAfter: record.revisionAfter,
          transactionId: record.transactionId,
        });
      },
    });
    return { bus, store, records };
  }

  it("rejects execute/undo/redo with BUS_REVOKED and never fires hooks", () => {
    const { bus, store, records } = createHookedBus();
    const commit = bus.execute(set("revoke:0001", [0, 0, 0]), {
      ...options("revoke:0001", 0),
    });
    expect(commit.ok).toBe(true);
    expect(records).toHaveLength(1);

    bus.revoke();
    const stale = bus.execute(set("revoke:0002", [1, 0, 0]), {
      ...options("revoke:0002", 1),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("BUS_REVOKED");
    }
    const staleUndo = bus.undo({
      ...options("revoke:undo:0001", 1),
    });
    expect(staleUndo.ok).toBe(false);
    if (!staleUndo.ok) {
      expect(staleUndo.error.code).toBe("BUS_REVOKED");
    }
    const staleRedo = bus.redo({
      ...options("revoke:redo:0001", 1),
    });
    expect(staleRedo.ok).toBe(false);
    if (!staleRedo.ok) {
      expect(staleRedo.error.code).toBe("BUS_REVOKED");
    }
    // The old store does not advance and the hook never fires again.
    expect(store.revision).toBe(1);
    expect(records).toHaveLength(1);
  });

  it("rejects beginGesture and seals any open gesture handle", () => {
    const { bus, store } = createHookedBus();
    const gesture = bus.beginGesture("gesture:revoke:0001");
    expect(gesture.ok).toBe(true);
    if (!gesture.ok) return;

    bus.revoke();
    expect(gesture.value.active).toBe(false);
    const update = gesture.value.update([set("revoke:g:0001", [1, 0, 0])], {
      ...options("revoke:g:0001", 0),
    });
    expect(update.ok).toBe(false);
    if (!update.ok) {
      expect(update.error.code).toBe("GESTURE_SEALED");
    }
    const cancel = gesture.value.cancel({
      ...options("revoke:g:cancel:0001", 0),
    });
    expect(cancel.ok).toBe(false);
    if (!cancel.ok) {
      expect(cancel.error.code).toBe("GESTURE_SEALED");
    }
    const fresh = bus.beginGesture("gesture:revoke:0002");
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) {
      expect(fresh.error.code).toBe("BUS_REVOKED");
    }
    expect(store.revision).toBe(0);
  });

  it("is idempotent and returns the same stable conflict every time", () => {
    const { bus } = createHookedBus();
    bus.revoke();
    bus.revoke();
    const first = bus.execute(set("revoke:idem:0001", [0, 0, 0]), {
      ...options("revoke:idem:0001", 0),
    });
    const second = bus.execute(set("revoke:idem:0002", [1, 0, 0]), {
      ...options("revoke:idem:0002", 0),
    });
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok && !second.ok) {
      expect(first.error.code).toBe("BUS_REVOKED");
      expect(second.error.code).toBe("BUS_REVOKED");
      expect(first.error.family).toBe("conflict");
      expect(second.error.message).toBe(first.error.message);
    }
  });
});
