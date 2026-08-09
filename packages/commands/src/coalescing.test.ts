import { describe, expect, it } from "vitest";
import {
  commandId,
  nodeId,
  transactionId,
  type NodeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { createDocumentStore } from "@voxel-maker/document";
import { CommandBus } from "./bus.js";
import type { Command, TransactionOptions } from "./types.js";
import { CommandRegistry } from "./registry.js";
import {
  NODE_SET_TRANSFORM_COMMAND,
  registerNodeCommands,
  setNodeTransformCommand,
  type SetNodeTransformPayload,
} from "./node-commands.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:coalesce:root");
const A = nodeId("node:coalesce:a");
const B = nodeId("node:coalesce:b");

function createDemoDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:coalesce:0001" as never,
    metadata: { title: "coalescing test" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [A, B],
        transform: identity,
        components: [],
      },
      {
        nodeId: A,
        name: "A",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: [],
      },
      {
        nodeId: B,
        name: "B",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: [],
      },
    ],
    materials: [],
    volumes: [],
  });
}

function createBus(): {
  bus: CommandBus;
  store: ReturnType<typeof createDocumentStore>["store"];
} {
  const { store, writeCapability } = createDocumentStore({
    document: createDemoDocument(),
  });
  const registry = new CommandRegistry();
  registerNodeCommands(registry);
  return {
    bus: new CommandBus(store, registry, writeCapability),
    store,
  };
}

let sequence = 0;

const move = (
  node: NodeId,
  translation: readonly [number, number, number],
): Command<typeof NODE_SET_TRANSFORM_COMMAND, SetNodeTransformPayload> => {
  sequence += 1;
  return setNodeTransformCommand(
    commandId(`command:coalesce:${String(sequence)}`),
    {
      nodeId: node,
      transform: { ...identity, translation },
    },
  );
};

const tx = (expectedRevision: number): TransactionOptions => {
  sequence += 1;
  return {
    transactionId: transactionId(`transaction:coalesce:${String(sequence)}`),
    expectedRevision,
    source: "ui",
    label: "Move",
  };
};

const translationOf = (
  store: ReturnType<typeof createDocumentStore>["store"],
  node: NodeId,
): readonly [number, number, number] => {
  const record = store.getDocument().nodes[node];
  if (record === undefined) throw new Error(`missing node ${node}`);
  return record.transform.translation;
};

describe("CommandBus gesture coalescing (plan S4.10)", () => {
  it("presents a whole drag as one history entry with the gesture label", () => {
    const { bus, store } = createBus();
    const gesture = bus.beginGesture("drag:translate:a");
    expect(gesture.update([move(A, [1, 0, 0])], tx(0)).ok).toBe(true);
    expect(gesture.update([move(A, [2, 0, 0])], tx(1)).ok).toBe(true);
    expect(gesture.update([move(A, [2, 3, 0])], tx(2)).ok).toBe(true);
    gesture.end();

    const history = bus.historySnapshot();
    expect(history.past).toHaveLength(1);
    expect(history.past[0]?.revisionBefore).toBe(0);
    expect(history.past[0]?.revisionAfter).toBe(3);
    expect(history.past[0]?.label).toBe("Move");
    expect(translationOf(store, A)).toEqual([2, 3, 0]);
  });

  it("undoes the whole drag to the pre-gesture state and redoes it", () => {
    const { bus, store } = createBus();
    const gesture = bus.beginGesture("drag:translate:a");
    expect(gesture.update([move(A, [1, 0, 0])], tx(0)).ok).toBe(true);
    expect(gesture.update([move(A, [2, 5, 0])], tx(1)).ok).toBe(true);
    gesture.end();

    const undo = bus.undo(tx(2));
    expect(undo.ok).toBe(true);
    expect(translationOf(store, A)).toEqual([0, 0, 0]);
    expect(bus.historySnapshot().past).toHaveLength(0);
    expect(bus.historySnapshot().future).toHaveLength(1);

    const redo = bus.redo(tx(3));
    expect(redo.ok).toBe(true);
    expect(translationOf(store, A)).toEqual([2, 5, 0]);
  });

  it("cancel restores the exact pre-gesture state and leaves no history entry", () => {
    const { bus, store } = createBus();
    const gesture = bus.beginGesture("drag:translate:a");
    expect(gesture.update([move(A, [1, 0, 0])], tx(0)).ok).toBe(true);
    expect(gesture.update([move(A, [2, 3, 4])], tx(1)).ok).toBe(true);
    const cancel = gesture.cancel(tx(2));
    expect(cancel.ok).toBe(true);
    expect(translationOf(store, A)).toEqual([0, 0, 0]);
    expect(gesture.active).toBe(false);
    expect(bus.historySnapshot().past).toHaveLength(0);
    expect(bus.canUndo()).toBe(false);
    // The rollback itself is an atomic transaction: revision advanced.
    expect(store.revision).toBe(3);
  });

  it("cancel with no updates is a no-op", () => {
    const { bus, store } = createBus();
    const gesture = bus.beginGesture("drag:translate:a");
    const cancel = gesture.cancel(tx(0));
    expect(cancel.ok).toBe(true);
    expect(store.revision).toBe(0);
    expect(bus.historySnapshot().past).toHaveLength(0);
  });

  it("an intervening commit seals the pending entry", () => {
    const { bus, store } = createBus();
    const gesture = bus.beginGesture("drag:translate:a");
    expect(gesture.update([move(A, [1, 0, 0])], tx(0)).ok).toBe(true);
    // A non-gesture commit between updates seals the first segment.
    const commit = bus.executeTransaction([move(B, [0, 2, 0])], tx(1));
    expect(commit.ok).toBe(true);
    expect(gesture.active).toBe(false);
    // The next gesture update starts a fresh segment.
    const next = bus.beginGesture("drag:translate:a");
    expect(next.update([move(A, [4, 0, 0])], tx(2)).ok).toBe(true);
    next.end();

    const history = bus.historySnapshot();
    expect(history.past).toHaveLength(3);
    expect(translationOf(store, A)).toEqual([4, 0, 0]);
    expect(translationOf(store, B)).toEqual([0, 2, 0]);
  });

  it("undo mid-gesture seals the pending entry before undoing it", () => {
    const { bus, store } = createBus();
    const gesture = bus.beginGesture("drag:translate:a");
    expect(gesture.update([move(A, [1, 0, 0])], tx(0)).ok).toBe(true);
    expect(gesture.update([move(A, [3, 0, 0])], tx(1)).ok).toBe(true);
    const undo = bus.undo(tx(2));
    expect(undo.ok).toBe(true);
    expect(translationOf(store, A)).toEqual([0, 0, 0]);
    expect(gesture.active).toBe(false);
    // The sealed gesture entry moved to the future.
    expect(bus.historySnapshot().future).toHaveLength(1);
  });

  it("an update touching a different resource seals and starts a new segment", () => {
    const { bus, store } = createBus();
    const gesture = bus.beginGesture("drag:translate:a");
    expect(gesture.update([move(A, [1, 0, 0])], tx(0)).ok).toBe(true);
    // Same command type but a different affected node: incompatible.
    expect(gesture.update([move(B, [0, 1, 0])], tx(1)).ok).toBe(true);
    // Back to node A: another new segment.
    expect(gesture.update([move(A, [2, 0, 0])], tx(2)).ok).toBe(true);
    gesture.end();

    const history = bus.historySnapshot();
    expect(history.past).toHaveLength(3);
    expect(translationOf(store, A)).toEqual([2, 0, 0]);
    expect(translationOf(store, B)).toEqual([0, 1, 0]);
  });

  it("a failed update seals the pending entry and keeps the error", () => {
    const { bus, store } = createBus();
    const gesture = bus.beginGesture("drag:translate:a");
    expect(gesture.update([move(A, [1, 0, 0])], tx(0)).ok).toBe(true);
    const bad: Command<
      typeof NODE_SET_TRANSFORM_COMMAND,
      SetNodeTransformPayload
    > = {
      id: commandId("command:coalesce:bad"),
      type: NODE_SET_TRANSFORM_COMMAND,
      schemaVersion: 1,
      payload: {
        nodeId: A,
        transform: { ...identity, scale: [0, 1, 1] },
      },
    };
    const failed = gesture.update([bad], tx(1));
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("INVALID_SCALE");
    expect(gesture.active).toBe(false);
    // The first segment remains a sealed, undoable history entry.
    expect(bus.historySnapshot().past).toHaveLength(1);
    const undo = bus.undo(tx(1));
    expect(undo.ok).toBe(true);
    expect(translationOf(store, A)).toEqual([0, 0, 0]);
  });

  it("rejects a second active gesture on the same bus", () => {
    const { bus } = createBus();
    bus.beginGesture("drag:a");
    expect(() => bus.beginGesture("drag:b")).toThrow(/gesture/u);
  });

  it("rejects updates and cancels after the gesture ended", () => {
    const { bus, store } = createBus();
    const gesture = bus.beginGesture("drag:translate:a");
    gesture.update([move(A, [1, 0, 0])], tx(0));
    gesture.end();
    const update = gesture.update([move(A, [2, 0, 0])], tx(1));
    expect(update.ok).toBe(false);
    if (!update.ok) expect(update.error.code).toBe("GESTURE_SEALED");
    const cancel = gesture.cancel(tx(2));
    expect(cancel.ok).toBe(false);
    if (!cancel.ok) expect(cancel.error.code).toBe("GESTURE_SEALED");
    expect(translationOf(store, A)).toEqual([1, 0, 0]);
  });

  it("coalesces multi-command updates and cancel restores every node", () => {
    const { bus, store } = createBus();
    const gesture = bus.beginGesture("drag:translate:ab");
    expect(
      gesture.update([move(A, [1, 0, 0]), move(B, [0, 1, 0])], tx(0)).ok,
    ).toBe(true);
    expect(
      gesture.update([move(A, [2, 0, 0]), move(B, [0, 2, 0])], tx(1)).ok,
    ).toBe(true);
    gesture.end();

    expect(bus.historySnapshot().past).toHaveLength(1);
    const undo = bus.undo(tx(2));
    expect(undo.ok).toBe(true);
    expect(translationOf(store, A)).toEqual([0, 0, 0]);
    expect(translationOf(store, B)).toEqual([0, 0, 0]);
    const redo = bus.redo(tx(3));
    expect(redo.ok).toBe(true);
    expect(translationOf(store, A)).toEqual([2, 0, 0]);
    expect(translationOf(store, B)).toEqual([0, 2, 0]);

    // A cancelled drag rolls both nodes back and leaves no entry.
    const drag = bus.beginGesture("drag:translate:ab");
    expect(
      drag.update([move(A, [5, 0, 0]), move(B, [0, 5, 0])], tx(4)).ok,
    ).toBe(true);
    const cancel = drag.cancel(tx(5));
    expect(cancel.ok).toBe(true);
    expect(translationOf(store, A)).toEqual([2, 0, 0]);
    expect(translationOf(store, B)).toEqual([0, 2, 0]);
    expect(bus.historySnapshot().past).toHaveLength(1);
  });
});
