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
});
