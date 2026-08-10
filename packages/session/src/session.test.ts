import { describe, expect, it } from "vitest";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  WorkspaceError,
} from "@voxel-maker/shared";
import { createDocument } from "@voxel-maker/model";
import { registerVoxelCommands, setVoxelCommand } from "@voxel-maker/commands";
import { createDocumentSession, type DocumentLifecycleEvent } from "./index.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:session:root");
const CHILD = nodeId("node:session:child");
const VOLUME = volumeId("volume:session:0001");

function createFixtureDocument(serial: number, withVolume = true) {
  return createDocument({
    documentId: documentId(
      `document:session:${String(serial).padStart(4, "0")}`,
    ),
    metadata: { title: `session fixture ${String(serial)}` },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [CHILD],
        transform: identity,
        components: [],
      },
      {
        nodeId: CHILD,
        name: "Child",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: withVolume
          ? [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }]
          : [],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "accent",
        color: "#ff8800",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: withVolume
      ? [{ volumeId: VOLUME, bounds: { min: [0, 0, 0], max: [2, 2, 2] } }]
      : [],
  });
}

function createSession() {
  return createDocumentSession({
    registerCommands: [registerVoxelCommands],
  });
}

/**
 * Creates a session whose bus hooks record the current document at commit
 * time, mirroring the composition root's journal sink (ticket #54): a
 * stale bus must never produce a record attributed to a later document.
 */
function createHookedSession() {
  const records: Array<{ documentId: string; revisionAfter: number }> = [];
  const session = createDocumentSession({
    registerCommands: [registerVoxelCommands],
    busHooks: {
      onCommitted(record) {
        records.push({
          documentId: session.current?.documentId ?? "none",
          revisionAfter: record.revisionAfter,
        });
      },
    },
  });
  return { session, records };
}

/** Asserts that `action` throws a `WorkspaceError` with the given code. */
function expectSessionError(action: () => void, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WorkspaceError);
  if (thrown instanceof WorkspaceError) {
    expect(thrown.code).toBe(code);
  }
}

function collectEvents(
  session: ReturnType<typeof createSession>,
): DocumentLifecycleEvent[] {
  const events: DocumentLifecycleEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

describe("DocumentSession lifecycle coordinator", () => {
  it("opens a validated document and emits document-opened with the fresh state", () => {
    const session = createSession();
    const events = collectEvents(session);
    const state = session.open({ document: createFixtureDocument(1) });

    expect(state.documentId).toBe("document:session:0001");
    expect(state.revision).toBe(0);
    expect(state.store.getDocument().documentId).toBe("document:session:0001");
    expect(session.current?.documentId).toBe("document:session:0001");
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.kind).toBe("document-opened");
    if (event?.kind === "document-opened") {
      expect(event.documentId).toBe("document:session:0001");
      expect(event.revision).toBe(0);
      expect(event.store).toBe(state.store);
      expect(event.bus).toBe(state.bus);
      expect(event.source).toBe("system");
    }
  });

  it("rejects a second open while a document is already open", () => {
    const session = createSession();
    session.open({ document: createFixtureDocument(1) });
    expectSessionError(
      () => session.open({ document: createFixtureDocument(2) }),
      "SESSION_ALREADY_OPEN",
    );
    expect(session.current?.documentId).toBe("document:session:0001");
  });

  it("rejects open with an invalid document before installing anything", () => {
    const session = createSession();
    const broken = createFixtureDocument(1);
    const invalid = {
      ...broken,
      nodes: {},
    };
    expectSessionError(
      () => session.open({ document: invalid }),
      "MISSING_REFERENCE",
    );
    expect(session.current).toBeUndefined();
  });

  it("replaces the open document, disposing history and emitting document-replaced", () => {
    const session = createSession();
    const events = collectEvents(session);
    const first = session.open({ document: createFixtureDocument(1) });

    // Commit one command so the first bus has history.
    const result = first.bus.execute(
      setVoxelCommand(commandId("command:session:set:0001"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:session:set:0001"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);

    const second = session.replace({ document: createFixtureDocument(2) });
    expect(second.documentId).toBe("document:session:0002");
    expect(second.revision).toBe(0);
    // The fresh bus has empty history: undo of the previous session fails.
    const undo = second.bus.undo({
      transactionId: transactionId("transaction:session:undo:0001"),
      expectedRevision: 0,
      source: "ui",
    });
    expect(undo.ok).toBe(false);
    expect(session.current?.bus).toBe(second.bus);
    expect(session.current?.bus).not.toBe(first.bus);

    const replaced = events.find((event) => event.kind === "document-replaced");
    expect(replaced).toBeDefined();
    if (replaced?.kind === "document-replaced") {
      expect(replaced.previousDocumentId).toBe("document:session:0001");
      expect(replaced.documentId).toBe("document:session:0002");
      expect(replaced.store).toBe(second.store);
    }
  });

  it("rejects replace when no document is open", () => {
    const session = createSession();
    expectSessionError(
      () => session.replace({ document: createFixtureDocument(1) }),
      "SESSION_NOT_OPEN",
    );
  });

  it("closes the open document, emits document-closed, and rejects further close", () => {
    const session = createSession();
    const events = collectEvents(session);
    session.open({ document: createFixtureDocument(1) });
    session.close();
    expect(session.current).toBeUndefined();
    const closed = events.find((event) => event.kind === "document-closed");
    expect(closed).toBeDefined();
    if (closed?.kind === "document-closed") {
      expect(closed.documentId).toBe("document:session:0001");
    }
    expectSessionError(() => {
      session.close();
    }, "SESSION_NOT_OPEN");
  });

  it("applies registrars to every fresh registry", () => {
    const session = createSession();
    const state = session.open({ document: createFixtureDocument(1) });
    // The voxel registrar must be present on the installed bus.
    const result = state.bus.execute(
      setVoxelCommand(commandId("command:session:set:0002"), {
        volumeId: VOLUME,
        coordinate: [1, 1, 1],
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:session:set:0002"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);
  });

  it("applies bus hooks to every fresh bus so recovery wiring can journal", () => {
    const { session, records } = createHookedSession();
    session.open({ document: createFixtureDocument(9) });
    const result = session.current?.bus.execute(
      setVoxelCommand(commandId("command:session:hook"), {
        volumeId: VOLUME,
        coordinate: [1, 1, 1],
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:session:hook"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(result?.ok).toBe(true);
    expect(records).toEqual([
      { documentId: "document:session:0009", revisionAfter: 1 },
    ]);

    // Replaced documents get a fresh bus that still carries the hooks, so
    // the composition root can rebind journal wiring per install.
    session.replace({ document: createFixtureDocument(10) });
    const result2 = session.current?.bus.execute(
      setVoxelCommand(commandId("command:session:hook-2"), {
        volumeId: VOLUME,
        coordinate: [2, 2, 2],
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:session:hook-2"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(result2?.ok).toBe(true);
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual({
      documentId: "document:session:0010",
      revisionAfter: 1,
    });
  });

  it("carries a caller-supplied source on the event", () => {
    const session = createSession();
    const events = collectEvents(session);
    session.open({
      document: createFixtureDocument(1),
      source: "recovery",
    });
    expect(events[0]?.kind).toBe("document-opened");
    if (events[0]?.kind === "document-opened") {
      expect(events[0].source).toBe("recovery");
    }
  });

  it("installs validated chunk seeds into the store", () => {
    const session = createSession();
    const values = new Uint16Array(4096);
    values[0] = 1;
    const state = session.open({
      document: createFixtureDocument(1),
      volumes: new Map([[VOLUME, [{ coordinate: [0, 0, 0], values }]]]),
    });
    expect(state.store.getVoxel(VOLUME, [0, 0, 0])).toBe(1);
    expect(state.store.getVoxel(VOLUME, [5, 5, 5])).toBe(0);
  });

  it("rejects chunk seeds referencing undeclared materials before install (issue #86)", () => {
    const session = createSession();
    const values = new Uint16Array(4096);
    values[0] = 2;
    expect(() =>
      session.open({
        document: createFixtureDocument(1),
        volumes: new Map([[VOLUME, [{ coordinate: [0, 0, 0], values }]]]),
      }),
    ).toThrow(/Material is not defined/u);
    expect(session.current).toBeUndefined();
  });

  it("keeps a throwing listener from breaking the transition", () => {
    const session = createSession();
    session.subscribe(() => {
      throw new Error("listener failure");
    });
    expect(() =>
      session.open({ document: createFixtureDocument(1) }),
    ).not.toThrow();
    expect(session.current?.documentId).toBe("document:session:0001");
  });

  it("unsubscribes listeners and disposes the binding", () => {
    const session = createSession();
    const events: DocumentLifecycleEvent[] = [];
    const extra = (event: DocumentLifecycleEvent) => events.push(event);
    const unsubscribe = session.subscribe(extra);
    unsubscribe();
    session.open({ document: createFixtureDocument(1) });
    expect(events).toHaveLength(0);
    session.dispose();
    expect(session.current).toBeUndefined();
  });

  it("revokes the previous bus on replace so retained buses reject and never journal", () => {
    const { session, records } = createHookedSession();
    const first = session.open({ document: createFixtureDocument(1) });

    // One legitimate commit on the first bus: the journal hook fires once,
    // attributed to document A.
    const commitA = first.bus.execute(
      setVoxelCommand(commandId("command:session:revoke-a"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:session:revoke-a"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(commitA.ok).toBe(true);

    session.replace({ document: createFixtureDocument(2) });
    expect(session.current?.documentId).toBe("document:session:0002");

    // A retained stale bus must reject with a stable conflict, must not
    // advance its own store, and must never invoke the shared journal hook
    // (the composition root forwards it to the CURRENT document's journal).
    const stale = first.bus.execute(
      setVoxelCommand(commandId("command:session:revoke-stale"), {
        volumeId: VOLUME,
        coordinate: [1, 1, 1],
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:session:revoke-stale"),
        expectedRevision: 1,
        source: "ui",
      },
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error).toBeInstanceOf(WorkspaceError);
      expect(stale.error.family).toBe("conflict");
      expect(stale.error.code).toBe("BUS_REVOKED");
    }
    expect(first.store.revision).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      documentId: "document:session:0001",
      revisionAfter: 1,
    });

    // Undo/redo on the retained bus reject the same way.
    const staleUndo = first.bus.undo({
      transactionId: transactionId("transaction:session:revoke-undo"),
      expectedRevision: 1,
      source: "ui",
    });
    expect(staleUndo.ok).toBe(false);
    if (!staleUndo.ok) {
      expect(staleUndo.error.code).toBe("BUS_REVOKED");
    }
    const staleRedo = first.bus.redo({
      transactionId: transactionId("transaction:session:revoke-redo"),
      expectedRevision: 1,
      source: "ui",
    });
    expect(staleRedo.ok).toBe(false);
    if (!staleRedo.ok) {
      expect(staleRedo.error.code).toBe("BUS_REVOKED");
    }
    expect(records).toHaveLength(1);
  });

  it("revokes the current bus on close and dispose so retained buses reject", () => {
    const { session, records } = createHookedSession();
    const state = session.open({ document: createFixtureDocument(3) });
    session.close();
    const afterClose = state.bus.execute(
      setVoxelCommand(commandId("command:session:revoke-close"), {
        volumeId: VOLUME,
        coordinate: [1, 1, 1],
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:session:revoke-close"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(afterClose.ok).toBe(false);
    if (!afterClose.ok) {
      expect(afterClose.error.code).toBe("BUS_REVOKED");
    }
    expect(records).toHaveLength(0);

    const state2 = session.open({ document: createFixtureDocument(4) });
    session.dispose();
    const afterDispose = state2.bus.execute(
      setVoxelCommand(commandId("command:session:revoke-dispose"), {
        volumeId: VOLUME,
        coordinate: [1, 1, 1],
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:session:revoke-dispose"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(afterDispose.ok).toBe(false);
    if (!afterDispose.ok) {
      expect(afterDispose.error.code).toBe("BUS_REVOKED");
    }
    expect(records).toHaveLength(0);
  });

  it("keeps the previous bus usable when a replacement fails validation", () => {
    const session = createSession();
    const first = session.open({ document: createFixtureDocument(5) });
    const invalid = {
      ...createFixtureDocument(6),
      nodes: {},
    };
    expectSessionError(
      () => session.replace({ document: invalid }),
      "MISSING_REFERENCE",
    );
    // The failed replacement must not revoke the still-current bus: the old
    // document remains authoritative and editable.
    expect(session.current?.documentId).toBe("document:session:0005");
    const result = first.bus.execute(
      setVoxelCommand(commandId("command:session:revoke-kept"), {
        volumeId: VOLUME,
        coordinate: [1, 1, 1],
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:session:revoke-kept"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);
    expect(first.store.revision).toBe(1);
  });

  it("rejects retained gesture handles after replace, close, and dispose", () => {
    const session = createSession();

    // After replace: the handle reports inactive and every call rejects.
    const first = session.open({ document: createFixtureDocument(7) });
    const gesture = first.bus.beginGesture("gesture:session:stale");
    expect(gesture.ok).toBe(true);
    if (!gesture.ok) return;

    session.replace({ document: createFixtureDocument(8) });
    expect(gesture.value.active).toBe(false);
    const update = gesture.value.update(
      [
        setVoxelCommand(commandId("command:session:revoke-gesture"), {
          volumeId: VOLUME,
          coordinate: [1, 1, 1],
          material: materialId(1),
        }),
      ],
      {
        transactionId: transactionId("transaction:session:revoke-gesture"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(update.ok).toBe(false);
    if (!update.ok) {
      expect(update.error.code).toBe("GESTURE_SEALED");
    }
    const cancel = gesture.value.cancel({
      transactionId: transactionId("transaction:session:revoke-gesture-cancel"),
      expectedRevision: 0,
      source: "ui",
    });
    expect(cancel.ok).toBe(false);
    if (!cancel.ok) {
      expect(cancel.error.code).toBe("GESTURE_SEALED");
    }
    expect(first.store.revision).toBe(0);

    // After close: a gesture opened on the closing document also dies.
    session.close();
    const second = session.open({ document: createFixtureDocument(9) });
    const closingGesture = second.bus.beginGesture("gesture:session:closing");
    expect(closingGesture.ok).toBe(true);
    if (!closingGesture.ok) return;
    session.close();
    expect(closingGesture.value.active).toBe(false);
    const closingUpdate = closingGesture.value.update(
      [
        setVoxelCommand(commandId("command:session:revoke-gesture-close"), {
          volumeId: VOLUME,
          coordinate: [1, 1, 1],
          material: materialId(1),
        }),
      ],
      {
        transactionId: transactionId(
          "transaction:session:revoke-gesture-close",
        ),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(closingUpdate.ok).toBe(false);
    if (!closingUpdate.ok) {
      expect(closingUpdate.error.code).toBe("GESTURE_SEALED");
    }

    // After dispose: the last installed bus and its gestures are dead too.
    const third = session.open({ document: createFixtureDocument(10) });
    const disposedGesture = third.bus.beginGesture("gesture:session:disposed");
    expect(disposedGesture.ok).toBe(true);
    if (!disposedGesture.ok) return;
    session.dispose();
    expect(disposedGesture.value.active).toBe(false);
    const disposedUpdate = disposedGesture.value.update(
      [
        setVoxelCommand(commandId("command:session:revoke-gesture-dispose"), {
          volumeId: VOLUME,
          coordinate: [1, 1, 1],
          material: materialId(1),
        }),
      ],
      {
        transactionId: transactionId(
          "transaction:session:revoke-gesture-dispose",
        ),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(disposedUpdate.ok).toBe(false);
    if (!disposedUpdate.ok) {
      expect(disposedUpdate.error.code).toBe("GESTURE_SEALED");
    }
  });
  it("keeps the exposed revision live and reports the final revision on close (issue #55)", () => {
    const session = createSession();
    const events = collectEvents(session);
    const state = session.open({ document: createFixtureDocument(1) });

    // At install the exposed revision matches the store.
    expect(state.revision).toBe(0);
    expect(session.current?.revision).toBe(session.current?.store.revision);

    // A successful edit advances store.revision; the session surface must
    // stay live so sequential commands can use it as the next expected base.
    const commit = state.bus.execute(
      setVoxelCommand(commandId("command:session:set:0001"), {
        volumeId: VOLUME,
        coordinate: [0, 0, 0],
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:session:set:0001"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    expect(commit.ok).toBe(true);
    expect(session.current?.store.revision).toBe(1);
    expect(session.current?.revision).toBe(1);

    // Undo and redo are transactions too; the exposed value tracks them.
    const undo = state.bus.undo({
      transactionId: transactionId("transaction:session:undo:0001"),
      expectedRevision: 1,
      source: "ui",
    });
    expect(undo.ok).toBe(true);
    expect(session.current?.store.revision).toBe(2);
    expect(session.current?.revision).toBe(2);

    const redo = state.bus.redo({
      transactionId: transactionId("transaction:session:redo:0001"),
      expectedRevision: 2,
      source: "ui",
    });
    expect(redo.ok).toBe(true);
    expect(session.current?.store.revision).toBe(3);
    expect(session.current?.revision).toBe(3);

    // Close reports the store's final revision, not the install value.
    session.close();
    const closed = events.find((event) => event.kind === "document-closed");
    expect(closed).toBeDefined();
    if (closed?.kind === "document-closed") {
      expect(closed.revision).toBe(3);
    }
  });

  it("publishes frozen lifecycle events that no subscriber can rewrite (issue #56)", () => {
    const session = createSession();
    const seen: string[] = [];
    const frozenByListener: boolean[] = [];
    const mutationRejected: boolean[] = [];
    session.subscribe((event) => {
      seen.push(`first:${event.kind}`);
      frozenByListener.push(Object.isFrozen(event));
      try {
        // A buggy subscriber must not be able to rewrite the event for
        // later subscribers: on a frozen event this assignment throws.
        Object.assign(event, {
          kind: "document-closed",
          documentId: "document:tampered",
        });
        mutationRejected.push(false);
      } catch {
        mutationRejected.push(true);
      }
    });
    session.subscribe((event) => {
      seen.push(`second:${event.kind}:${event.documentId}`);
      frozenByListener.push(Object.isFrozen(event));
    });

    session.open({ document: createFixtureDocument(1) });
    session.replace({ document: createFixtureDocument(2) });
    session.close();

    expect(seen).toEqual([
      "first:document-opened",
      "second:document-opened:document:session:0001",
      "first:document-replaced",
      "second:document-replaced:document:session:0002",
      "first:document-closed",
      "second:document-closed:document:session:0002",
    ]);
    expect(frozenByListener).toEqual([true, true, true, true, true, true]);
    expect(mutationRejected).toEqual([true, true, true]);
  });

  it("exposes a frozen public session-state record (issue #56)", () => {
    const session = createSession();
    const state = session.open({ document: createFixtureDocument(1) });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(session.current)).toBe(true);
    let mutationRejected = false;
    try {
      Object.assign(state, { documentId: "document:tampered" });
    } catch {
      mutationRejected = true;
    }
    expect(mutationRejected).toBe(true);
  });
});
