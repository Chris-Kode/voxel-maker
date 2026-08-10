import { describe, expect, it } from "vitest";
import { recoverySessionId } from "@voxel-maker/shared";
import { readVxlProject } from "@voxel-maker/formats";
import { captureRevisionSnapshot } from "./snapshot.js";
import {
  createSnapshotWriteGate,
  type SnapshotWriteGate,
} from "./snapshot-writer.js";
import { createSaveCoordinator } from "./coordinator.js";
import { createRecoveryJournal, decodeJournalFrames } from "./journal.js";
import { createVxlProjectEncoder } from "./encoder.js";
import { MemoryProjectStorage } from "./memory-storage.js";
import type {
  AtomicWriteOptions,
  AtomicWriteResult,
  ProjectStoragePort,
  RecoveryJournalPort,
} from "./port.js";
import { commitVoxel, createStore } from "./test-helpers.js";

const SESSION = recoverySessionId("session:snapshot-writer:0001");

const encoder = () => createVxlProjectEncoder();

/**
 * Port that blocks exactly the FIRST `writeProjectAtomic` call until
 * `release()`, letting every later write pass through immediately. This is
 * the deterministic gate of the issue #51 repro: an older save is held in
 * flight while a newer compaction runs and completes.
 */
class FirstWriteGatePort implements ProjectStoragePort, RecoveryJournalPort {
  readonly #inner: ProjectStoragePort & RecoveryJournalPort;
  #release: (() => void) | undefined;
  #enteredResolve: (() => void) | undefined;
  readonly #entered = new Promise<void>((resolve) => {
    this.#enteredResolve = resolve;
  });
  writeCount = 0;

  constructor(inner: ProjectStoragePort & RecoveryJournalPort) {
    this.#inner = inner;
  }

  /** Resolves once the first write has entered the adapter and is blocked. */
  entered(): Promise<void> {
    return this.#entered;
  }

  release(): void {
    this.#release?.();
    this.#release = undefined;
  }

  async writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
    options?: AtomicWriteOptions,
  ): Promise<AtomicWriteResult> {
    this.writeCount += 1;
    if (this.writeCount === 1) {
      this.#enteredResolve?.();
      this.#enteredResolve = undefined;
      await new Promise<void>((resolve) => {
        this.#release = resolve;
      });
    }
    return this.#inner.writeProjectAtomic(path, bytes, options);
  }

  readProject(path: string): Promise<Uint8Array> {
    return this.#inner.readProject(path);
  }

  exists(path: string): Promise<boolean> {
    return this.#inner.exists(path);
  }

  remove(path: string): Promise<void> {
    return this.#inner.remove(path);
  }

  readBackup(path: string): Promise<Uint8Array | undefined> {
    return this.#inner.readBackup(path);
  }

  readJournal(path: string): Promise<Uint8Array | undefined> {
    return this.#inner.readJournal(path);
  }

  appendJournal(path: string, bytes: Uint8Array): Promise<void> {
    return this.#inner.appendJournal(path, bytes);
  }

  replaceJournal(path: string, bytes: Uint8Array): Promise<void> {
    return this.#inner.replaceJournal(path, bytes);
  }

  removeJournal(path: string): Promise<void> {
    return this.#inner.removeJournal(path);
  }
}

describe("SnapshotWriteGate", () => {
  it("serializes writes per path and never overlaps two writes", async () => {
    const memory = new MemoryProjectStorage();
    const port = new FirstWriteGatePort(memory);
    const gate = createSnapshotWriteGate(port);

    const first = gate.write({
      path: "project.vxl",
      bytes: new TextEncoder().encode("rev-0"),
      revision: 0,
    });
    await port.entered();
    const second = gate.write({
      path: "project.vxl",
      bytes: new TextEncoder().encode("rev-1"),
      revision: 1,
    });
    // The second write must queue behind the first: no second port write
    // may start while the first is still in flight.
    await Promise.resolve();
    expect(port.writeCount).toBe(1);

    port.release();
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "installed",
      "installed",
    ]);
    expect(outcomes[1].result?.tempPath).toBeDefined();
    const stored = new TextDecoder().decode(
      await memory.readProject("project.vxl"),
    );
    expect(stored).toBe("rev-1");
  });

  it("fences a stale write whose revision is older than the installed snapshot", async () => {
    const memory = new MemoryProjectStorage();
    const gate = createSnapshotWriteGate(memory);
    const newer = await gate.write({
      path: "project.vxl",
      bytes: new TextEncoder().encode("rev-1"),
      revision: 1,
    });
    expect(newer.status).toBe("installed");
    const stale = await gate.write({
      path: "project.vxl",
      bytes: new TextEncoder().encode("rev-0"),
      revision: 0,
    });
    // The stale write is skipped without touching the port: installing it
    // would regress the durable snapshot behind the newer revision.
    expect(stale.status).toBe("superseded");
    expect(stale.result).toBeUndefined();
    const stored = new TextDecoder().decode(
      await memory.readProject("project.vxl"),
    );
    expect(stored).toBe("rev-1");
  });

  it("does not fence an equal-revision rewrite", async () => {
    const memory = new MemoryProjectStorage();
    const gate = createSnapshotWriteGate(memory);
    await gate.write({
      path: "project.vxl",
      bytes: new TextEncoder().encode("rev-1"),
      revision: 1,
    });
    const equal = await gate.write({
      path: "project.vxl",
      bytes: new TextEncoder().encode("rev-1-again"),
      revision: 1,
    });
    expect(equal.status).toBe("installed");
    const stored = new TextDecoder().decode(
      await memory.readProject("project.vxl"),
    );
    expect(stored).toBe("rev-1-again");
  });

  it("keeps per-path queues independent", async () => {
    const memory = new MemoryProjectStorage();
    const port = new FirstWriteGatePort(memory);
    const gate = createSnapshotWriteGate(port);
    const first = gate.write({
      path: "a.vxl",
      bytes: new TextEncoder().encode("a0"),
      revision: 0,
    });
    await port.entered();
    // A write to a different path must not wait behind the blocked write.
    const other = await gate.write({
      path: "b.vxl",
      bytes: new TextEncoder().encode("b0"),
      revision: 0,
    });
    expect(other.status).toBe("installed");
    port.release();
    await first;
  });

  it("rejects queued writes on dispose and lets the in-flight write finish", async () => {
    const memory = new MemoryProjectStorage();
    const port = new FirstWriteGatePort(memory);
    const gate = createSnapshotWriteGate(port);
    const inflight = gate.write({
      path: "project.vxl",
      bytes: new TextEncoder().encode("rev-0"),
      revision: 0,
    });
    await port.entered();
    const queued = gate.write({
      path: "project.vxl",
      bytes: new TextEncoder().encode("rev-1"),
      revision: 1,
    });
    gate.dispose();
    await expect(queued).rejects.toMatchObject({
      code: "IO_WRITE_INTERRUPTED",
    });
    // The in-flight write was not interrupted by dispose.
    port.release();
    const outcome = await inflight;
    expect(outcome.status).toBe("installed");
    await expect(
      gate.write({
        path: "project.vxl",
        bytes: new TextEncoder().encode("rev-2"),
        revision: 2,
      }),
    ).rejects.toMatchObject({ code: "IO_WRITE_FAILED" });
  });
});

describe("shared snapshot-write gate (ticket #51)", () => {
  it("never lets an older gated save overwrite a newer compacted snapshot", async () => {
    const memory = new MemoryProjectStorage();
    const port = new FirstWriteGatePort(memory);
    const gate: SnapshotWriteGate = createSnapshotWriteGate(port);
    const { store, writeCapability } = createStore();
    const coordinator = createSaveCoordinator({
      store,
      port,
      encoder: encoder(),
      snapshotWriteGate: gate,
    });
    const base = captureRevisionSnapshot(store);
    const journal = createRecoveryJournal({
      projectPath: "project.vxl",
      port,
      sessionId: SESSION,
      baseRevision: base.revision,
      baseSemanticHash: base.semanticHash,
      encoder: encoder(),
      capture: () => captureRevisionSnapshot(store),
      snapshotWriteGate: gate,
    });

    // Revision-0 save is in flight and delayed at the port.
    const savePromise = coordinator.save("project.vxl");
    await port.entered();

    // Revision 1 commits and compaction is requested concurrently.
    commitVoxel(store, writeCapability, [0, 0, 0], 1);
    const compactPromise = journal.compact();

    // The compaction snapshot write must queue behind the older save in the
    // shared gate instead of racing it: no second port write may start
    // while the first is still gated.
    await Promise.resolve();
    expect(port.writeCount).toBe(1);

    // Releasing the older save lets it finish first, then the compaction
    // installs the newer snapshot and resets the journal anchor.
    port.release();
    const saveOutcome = await savePromise;
    expect(saveOutcome.revision).toBe(0);
    await compactPromise;

    // Acceptance criterion (issue #51): a matching revision-1 snapshot and
    // header, never snapshot 0 / header 1.
    const snapshot = readVxlProject(await memory.readProject("project.vxl"));
    expect(snapshot.document.revision).toBe(1);
    const journalBytes = await memory.readJournal("project.vxl");
    expect(journalBytes).toBeDefined();
    const decoded = decodeJournalFrames(journalBytes as Uint8Array);
    expect(decoded.header?.baseRevision).toBe(1);
    expect(decoded.header?.baseSemanticHash).toBe(snapshot.semanticHash);
  });

  it("forwards save cancellation through the shared gate", async () => {
    const memory = new MemoryProjectStorage();
    const port = new FirstWriteGatePort(memory);
    const gate = createSnapshotWriteGate(port);
    const { store } = createStore();
    const coordinator = createSaveCoordinator({
      store,
      port,
      encoder: encoder(),
      snapshotWriteGate: gate,
    });
    const savePromise = coordinator.save("project.vxl");
    await port.entered();
    coordinator.cancel();
    port.release();
    await expect(savePromise).rejects.toMatchObject({
      code: "IO_WRITE_INTERRUPTED",
    });
    expect(await memory.exists("project.vxl")).toBe(false);
  });

  it("lets a save proceed after a compaction write queued first", async () => {
    const memory = new MemoryProjectStorage();
    const port = new FirstWriteGatePort(memory);
    const gate = createSnapshotWriteGate(port);
    const { store, writeCapability } = createStore();
    const coordinator = createSaveCoordinator({
      store,
      port,
      encoder: encoder(),
      snapshotWriteGate: gate,
    });
    const base = captureRevisionSnapshot(store);
    const journal = createRecoveryJournal({
      projectPath: "project.vxl",
      port,
      sessionId: SESSION,
      baseRevision: base.revision,
      baseSemanticHash: base.semanticHash,
      encoder: encoder(),
      capture: () => captureRevisionSnapshot(store),
      snapshotWriteGate: gate,
    });

    // Compaction of revision 1 is requested first and its snapshot write
    // is held at the port; a save of the same revision is queued behind it.
    commitVoxel(store, writeCapability, [0, 0, 0], 1);
    const compactPromise = journal.compact();
    await port.entered();
    const savePromise = coordinator.save("project.vxl");
    port.release();
    await compactPromise;
    const saveOutcome = await savePromise;
    expect(saveOutcome.revision).toBe(1);
    expect(saveOutcome.status).toBe("saved");
    const snapshot = readVxlProject(await memory.readProject("project.vxl"));
    expect(snapshot.document.revision).toBe(1);
  });
});
