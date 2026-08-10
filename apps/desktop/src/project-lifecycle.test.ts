import { describe, expect, it, vi } from "vitest";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  recoverySessionId,
  transactionId,
  volumeId,
  WorkspaceError,
  type RecoverySessionId,
} from "@voxel-maker/shared";
import {
  canonicalColor,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { readVxlProject } from "@voxel-maker/formats";
import {
  CommandBus,
  CommandRegistry,
  createMaterialCommand,
  fillBoxCommand,
  journalTransactionToJson,
  registerArticulationCommands,
  registerBatchCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
  type CommittedTransactionRecord,
} from "@voxel-maker/commands";
import type { CommandRegistryRegistrar } from "@voxel-maker/session";
import {
  createDocumentStoreHandle,
  type DocumentStore,
} from "@voxel-maker/document/internal";
import {
  captureRevisionSnapshot,
  createRecoveryJournal,
  createSaveCoordinator,
  createVxlProjectEncoder,
  decodeJournalFrames,
  MemoryProjectStorage,
  type AtomicWriteResult,
  type ProjectStoragePort,
  type RecoveryJournalPort,
} from "@voxel-maker/storage";
import {
  createDesktopComposition,
  type DesktopComposition,
  type FilePicker,
} from "./composition.js";
import { createScriptedPrompts, requireResult } from "./test-prompts.js";
import { createMemoryRecentProjects } from "./recent-projects.js";

/**
 * Desktop project lifecycle workflows (plan S7.16, ticket #22): new,
 * open, save, save-as, recent-project, replace, close, and recovery
 * through the real composition seam — lifecycle coordinator, save
 * coordinator, recovery journal, autosave, prompts, and scoped storage
 * ports. Successful and faulted save/open/recovery workflows are covered
 * end to end: dirty-close prompts, pending-save state, stale completion,
 * degraded recovery, overwrite confirmation, cancellation, and structured
 * errors.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:lifecycle:root");
const CHILD = nodeId("node:lifecycle:child");
const VOLUME = volumeId("volume:lifecycle:0001");
const SESSION = recoverySessionId("session:lifecycle:test:0001");

const REGISTRARS: readonly CommandRegistryRegistrar[] = [
  registerVoxelCommands,
  registerBatchCommands,
  registerRegionCommands,
  registerNodeCommands,
  registerArticulationCommands,
  registerMaterialCommands,
];

function buildDocument(title: string): VoxelDocument {
  return createDocument({
    documentId: documentId(`document:lifecycle:${title}`),
    metadata: { title },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [CHILD],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: CHILD,
        name: "Box",
        parentId: ROOT,
        children: [],
        transform: IDENTITY,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "stone",
        color: "#aabbcc",
        opacity: 1,
        roughness: 0.8,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: VOLUME,
        bounds: { min: [0, 0, 0], max: [6, 6, 6] },
      },
    ],
  });
}

/**
 * A store + bus over a fresh document, with every committed transaction
 * recorded through bus hooks (used to build journals and project bytes).
 */
function createFixtureStore(): {
  store: DocumentStore;
  records: CommittedTransactionRecord[];
  bus: CommandBus;
} {
  const document = buildDocument("lifecycle-fixture");
  const { store, writeCapability } = createDocumentStoreHandle({ document });
  const registry = new CommandRegistry();
  for (const register of REGISTRARS) register(registry);
  const records: CommittedTransactionRecord[] = [];
  const bus = new CommandBus(store, registry, writeCapability, undefined, {
    onCommitted(record) {
      records.push(record);
    },
  });
  return { store, records, bus };
}

/** One deterministic voxel fill through the fixture bus (revision + 1). */
function fill(store: DocumentStore, bus: CommandBus, serial: number): void {
  const result = bus.execute(
    fillBoxCommand(commandId(`command:lifecycle:fill:${String(serial)}`), {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [2, 2, 2] },
      material: materialId(1),
    }),
    {
      transactionId: transactionId(
        `transaction:lifecycle:fill:${String(serial)}`,
      ),
      expectedRevision: store.revision,
      source: "system",
    },
  );
  if (!result.ok) throw new Error(`fixture fill failed: ${result.error.code}`);
}

/** Returns fixture project bytes (saved through the real coordinator). */
async function seedBytes(): Promise<Uint8Array> {
  const memory = new MemoryProjectStorage();
  await seedProject(memory, "fixture.vxl");
  return memory.readProject("fixture.vxl");
}

/** Saves a fixture project through the real coordinator onto `storage`. */
async function seedProject(
  storage: ProjectStoragePort & RecoveryJournalPort,
  path: string,
  filled = true,
): Promise<void> {
  const fixture = createFixtureStore();
  if (filled) fill(fixture.store, fixture.bus, 0);
  const coordinator = createSaveCoordinator({
    store: fixture.store,
    port: storage,
    encoder: createVxlProjectEncoder(),
  });
  await coordinator.save(path);
  coordinator.dispose();
}

/**
 * Builds a project file plus a recovery journal with two committed
 * transactions (durable snapshot at revision 0, then frames 0->1 and
 * 1->2), exactly like a crashed session would leave behind.
 */
async function buildJournaledProject(
  storage: MemoryProjectStorage,
  path: string,
): Promise<{ sessionId: RecoverySessionId }> {
  const fixture = createFixtureStore();
  const coordinator = createSaveCoordinator({
    store: fixture.store,
    port: storage,
    encoder: createVxlProjectEncoder(),
  });
  await coordinator.save(path);
  const snapshot = captureRevisionSnapshot(fixture.store);
  const journal = createRecoveryJournal({
    projectPath: path,
    port: storage,
    sessionId: SESSION,
    baseRevision: snapshot.revision,
    baseSemanticHash: snapshot.semanticHash,
    encoder: createVxlProjectEncoder(),
    capture: () => captureRevisionSnapshot(fixture.store),
  });
  fill(fixture.store, fixture.bus, 1);
  const record1 = fixture.records[0];
  if (record1 === undefined) throw new Error("missing record 1");
  await journal.journal({
    revisionBefore: record1.revisionBefore,
    revisionAfter: record1.revisionAfter,
    transaction: journalTransactionToJson(record1),
  });
  fill(fixture.store, fixture.bus, 2);
  const record2 = fixture.records[1];
  if (record2 === undefined) throw new Error("missing record 2");
  await journal.journal({
    revisionBefore: record2.revisionBefore,
    revisionAfter: record2.revisionAfter,
    transaction: journalTransactionToJson(record2),
  });
  journal.dispose();
  coordinator.dispose();
  return { sessionId: SESSION };
}

function makePicker(
  opts: {
    openPath?: string;
    savePath?: string | ((suggested: string) => string | undefined);
  } = {},
): FilePicker {
  return {
    pickOpenPath: () =>
      Promise.resolve(
        opts.openPath === undefined
          ? undefined
          : { token: opts.openPath, path: opts.openPath },
      ),
    pickSavePath: (suggested) =>
      Promise.resolve(
        (typeof opts.savePath === "function"
          ? opts.savePath(suggested)
          : (opts.savePath ?? suggested)) === undefined
          ? undefined
          : {
              token:
                typeof opts.savePath === "function"
                  ? (opts.savePath(suggested) ?? suggested)
                  : (opts.savePath ?? suggested),
              path:
                typeof opts.savePath === "function"
                  ? (opts.savePath(suggested) ?? suggested)
                  : (opts.savePath ?? suggested),
            },
      ),
  };
}

/** Port that can delay and fail one atomic write (faulted-save tests). */
class GatedPort implements ProjectStoragePort, RecoveryJournalPort {
  readonly #inner: MemoryProjectStorage;
  #gate: Promise<void> | undefined;
  #release: (() => void) | undefined;
  failWrite = false;
  failAppend = false;
  writeCount = 0;

  constructor(inner: MemoryProjectStorage) {
    this.#inner = inner;
  }

  gate(): void {
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release?.();
    this.#release = undefined;
    this.#gate = undefined;
  }

  async entered(): Promise<void> {
    while (this.writeCount === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  async readProject(path: string): Promise<Uint8Array> {
    return this.#inner.readProject(path);
  }

  async writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
    options?: {
      readonly signal?: AbortSignal;
      readonly onPhase?: (phase: string) => void;
    },
  ): Promise<AtomicWriteResult> {
    this.writeCount += 1;
    if (this.failWrite) {
      this.failWrite = false;
      throw new WorkspaceError({
        family: "io",
        code: "IO_DISK_FULL",
        message: "simulated disk full",
        context: { path },
      });
    }
    // Report the first phase while the gate holds so tests can observe
    // pending-save progress mid-write.
    options?.onPhase?.("create-temp");
    if (this.#gate !== undefined) await this.#gate;
    // Forward the signal so cancellation interrupts the inner write.
    return this.#inner.writeProjectAtomic(path, bytes, options);
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

  async appendJournal(path: string, bytes: Uint8Array): Promise<void> {
    if (this.failAppend) {
      this.failAppend = false;
      throw new WorkspaceError({
        family: "io",
        code: "IO_DISK_FULL",
        message: "simulated disk full during journal append",
        context: { path },
      });
    }
    return this.#inner.appendJournal(path, bytes);
  }

  replaceJournal(path: string, bytes: Uint8Array): Promise<void> {
    return this.#inner.replaceJournal(path, bytes);
  }

  removeJournal(path: string): Promise<void> {
    return this.#inner.removeJournal(path);
  }
}

/** Loads a project's frozen revision for byte-level assertions. */
function readVxl(bytes: Uint8Array): { revision: number } {
  return readVxlProject(bytes).document;
}

let editSerial = 0;

function editThroughSession(composition: DesktopComposition): void {
  const state = composition.session.current;
  if (state === undefined) throw new Error("no open session");
  editSerial += 1;
  const result = state.bus.execute(
    fillBoxCommand(commandId(`command:lifecycle:edit:${String(editSerial)}`), {
      volumeId: VOLUME,
      // Outside the seeded fill so the semantic content really changes.
      region: { min: [3, 3, 3], max: [4, 4, 4] },
      material: materialId(1),
    }),
    {
      transactionId: transactionId(
        `transaction:lifecycle:edit:${String(editSerial)}`,
      ),
      expectedRevision: composition.session.current?.store.revision ?? 0,
      source: "ui",
    },
  );
  if (!result.ok) throw new Error(`edit failed: ${result.error.code}`);
}

describe("desktop project lifecycle workflows", () => {
  it("new creates a blank project and the first save materializes file and journal", async () => {
    const storage = new MemoryProjectStorage();
    const composition = createDesktopComposition({
      storage,
      picker: makePicker(),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    const created = requireResult(await composition.fileService.newProject());
    expect(created.ok).toBe(true);
    expect(composition.fileService.status.dirty).toBe(false);
    expect(composition.fileService.status.path).toBeUndefined();
    expect(composition.session.current?.revision).toBe(0);

    // A fresh project has no path: Save behaves as Save As.
    const saved = requireResult(await composition.fileService.saveProject());
    expect(saved.ok).toBe(true);
    expect(saved.path).toMatch(/Untitled\.vxl$/u);
    expect(composition.fileService.status.path).toBe(saved.path);
    expect(await storage.exists(saved.path ?? "")).toBe(true);
    // The recovery area is bound; the journal file itself materializes on
    // the first append (a blank project has no edits to journal yet).
    expect(composition.fileService.status.degraded).toBe(false);

    const closed = requireResult(await composition.fileService.closeProject());
    expect(closed.ok).toBe(true);
    expect(composition.session.current).toBeUndefined();
    expect(composition.fileService.status.dirty).toBe(false);
    composition.dispose();
  });

  it("keeps a dirty document when the discard prompt is declined", async () => {
    const storage = new MemoryProjectStorage();
    await seedProject(storage, "dirty.vxl");
    const composition = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "dirty.vxl" }),
      prompts: createScriptedPrompts([false, false]),
      recent: createMemoryRecentProjects(),
    });
    await composition.fileService.openProject();
    editThroughSession(composition);
    const before = composition.session.current?.documentId;

    const closed = await composition.fileService.closeProject();
    expect(closed).toBeUndefined();
    expect(composition.fileService.status.dirty).toBe(true);
    expect(composition.session.current?.documentId).toBe(before);

    const replaced = await composition.fileService.newProject();
    expect(replaced).toBeUndefined();
    expect(composition.session.current?.documentId).toBe(before);
    composition.dispose();
  });

  it("closes a dirty document when the discard prompt is accepted", async () => {
    const storage = new MemoryProjectStorage();
    await seedProject(storage, "dirty2.vxl");
    const composition = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "dirty2.vxl" }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    await composition.fileService.openProject();
    editThroughSession(composition);
    const closed = requireResult(await composition.fileService.closeProject());
    expect(closed.ok).toBe(true);
    expect(composition.session.current).toBeUndefined();
    composition.dispose();
  });

  it("records recent projects most-recent-first and forgets them", async () => {
    const storage = new MemoryProjectStorage();
    const recent = createMemoryRecentProjects();
    const composition = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "a.vxl" }),
      prompts: createScriptedPrompts(true),
      recent,
    });
    await seedProject(storage, "a.vxl");
    await seedProject(storage, "c.vxl");
    const opened = requireResult(await composition.fileService.openProject());
    expect(opened.ok).toBe(true);
    const second = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "c.vxl" }),
      prompts: createScriptedPrompts(true),
      recent,
    });
    await second.fileService.openProject();
    const entries = await recent.list();
    expect(entries.map((entry) => entry.path)).toEqual(["c.vxl", "a.vxl"]);

    await composition.fileService.forgetRecentProject("a.vxl");
    expect((await recent.list()).map((entry) => entry.path)).toEqual(["c.vxl"]);

    // Opening a recent entry re-records it at the front.
    const third = createDesktopComposition({
      storage,
      picker: makePicker(),
      prompts: createScriptedPrompts(true),
      recent,
    });
    const reopened = requireResult(
      await third.fileService.openRecentProject({
        token: "c.vxl",
        path: "c.vxl",
        title: "",
        openedAt: 0,
      }),
    );
    expect(reopened.ok).toBe(true);
    expect((await recent.list()).map((entry) => entry.path)).toEqual(["c.vxl"]);
    third.dispose();
    second.dispose();
    composition.dispose();
  });

  it("confirms overwrites on Save As and leaves the file untouched on decline", async () => {
    const storage = new MemoryProjectStorage();
    await seedProject(storage, "existing.vxl");
    const original = await storage.readProject("existing.vxl");
    await seedProject(storage, "current.vxl");
    const composition = createDesktopComposition({
      storage,
      picker: makePicker({
        openPath: "current.vxl",
        savePath: "existing.vxl",
      }),
      prompts: createScriptedPrompts(false),
      recent: createMemoryRecentProjects(),
    });
    await composition.fileService.openProject();
    editThroughSession(composition);

    const declined = await composition.fileService.saveProjectAs();
    expect(declined).toBeUndefined();
    expect(await storage.readProject("existing.vxl")).toEqual(original);

    // Accepting the prompt overwrites atomically.
    const accepting = createDesktopComposition({
      storage,
      picker: makePicker({
        openPath: "current.vxl",
        savePath: "existing.vxl",
      }),
      prompts: createScriptedPrompts([true, true]),
      recent: createMemoryRecentProjects(),
    });
    await accepting.fileService.openProject();
    editThroughSession(accepting);
    const saved = requireResult(await accepting.fileService.saveProjectAs());
    expect(saved.ok).toBe(true);
    const bytes = await storage.readProject("existing.vxl");
    expect(bytes).not.toEqual(original);
    accepting.dispose();
    composition.dispose();
  });

  it("surfaces save failures as structured errors and keeps the project dirty", async () => {
    const storage = new MemoryProjectStorage();
    const gated = new GatedPort(storage);
    await seedProject(gated, "fail.vxl");
    const composition = createDesktopComposition({
      storage: gated,
      picker: makePicker({
        openPath: "fail.vxl",
        savePath: "fail.vxl",
      }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    await composition.fileService.openProject();
    editThroughSession(composition);
    gated.failWrite = true;
    const before = await storage.readProject("fail.vxl");
    const failed = requireResult(await composition.fileService.saveProject());
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("IO_DISK_FULL");
    expect(composition.fileService.status.dirty).toBe(true);
    expect(composition.fileService.status.saving).toBe(false);
    // The destination keeps its seeded bytes (nothing was written).
    expect(await storage.readProject("fail.vxl")).toEqual(before);
    expect(
      composition.editor.notices.some((notice) =>
        notice.message.includes("disk full"),
      ),
    ).toBe(true);
    composition.dispose();
  });

  it("reports a stale completion when edits land during the save", async () => {
    const storage = new MemoryProjectStorage();
    const gated = new GatedPort(storage);
    await seedProject(gated, "stale.vxl");
    const composition = createDesktopComposition({
      storage: gated,
      picker: makePicker({
        openPath: "stale.vxl",
        savePath: "stale.vxl",
      }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    await composition.fileService.openProject();
    editThroughSession(composition);
    gated.gate();
    const saving = composition.fileService.saveProject();
    await gated.entered();
    expect(composition.fileService.status.saving).toBe(true);
    // A second edit lands while the write is in flight.
    editThroughSession(composition);
    gated.release();
    const result = requireResult(await saving);
    expect(result.ok).toBe(true);
    expect(composition.fileService.status.lastSaveStale).toBe(true);
    // A stale completion can never clear dirty state (plan S5.14).
    expect(composition.fileService.status.dirty).toBe(true);
    expect(
      composition.editor.notices.some((notice) =>
        notice.message.includes("changed while saving"),
      ),
    ).toBe(true);

    // The next clean save clears the stale flag.
    const second = requireResult(await composition.fileService.saveProject());
    expect(second.ok).toBe(true);
    expect(composition.fileService.status.lastSaveStale).toBe(false);
    expect(composition.fileService.status.dirty).toBe(false);
    composition.dispose();
  });

  it("cancels an in-flight save without touching the destination", async () => {
    const storage = new MemoryProjectStorage();
    const gated = new GatedPort(storage);
    await seedProject(gated, "cancel.vxl");
    const composition = createDesktopComposition({
      storage: gated,
      picker: makePicker({
        openPath: "cancel.vxl",
        savePath: "cancel.vxl",
      }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    await composition.fileService.openProject();
    editThroughSession(composition);
    gated.gate();
    const saving = composition.fileService.saveProject();
    await gated.entered();
    expect(composition.fileService.status.saving).toBe(true);
    composition.fileService.cancelSave();
    gated.release();
    const before = await storage.readProject("cancel.vxl");
    const result = requireResult(await saving);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("IO_WRITE_INTERRUPTED");
    expect(composition.fileService.status.saving).toBe(false);
    // The interrupted write never touched the destination.
    expect(await storage.readProject("cancel.vxl")).toEqual(before);
    expect(composition.fileService.status.dirty).toBe(true);
    composition.dispose();
  });

  it("autosaves debounced edits to the current path", async () => {
    const storage = new MemoryProjectStorage();
    await seedProject(storage, "auto.vxl");
    const composition = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "auto.vxl" }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
      autosaveDelayMs: 10,
    });
    await composition.fileService.openProject();
    editThroughSession(composition);
    expect(composition.fileService.status.dirty).toBe(true);
    await vi.waitFor(() => {
      expect(composition.fileService.status.dirty).toBe(false);
    });
    expect(await storage.exists("auto.vxl")).toBe(true);
    // The autosave rewrote the project file with the new revision.
    const reopened = readVxl(await storage.readProject("auto.vxl"));
    expect(reopened.revision).toBe(2);
    // The autosave cycled the pending-save state.
    expect(composition.fileService.status.saving).toBe(false);
    composition.dispose();
  });

  it("resets the autosave binding on lifecycle replacement", async () => {
    const storage = new MemoryProjectStorage();
    await seedProject(storage, "a.vxl");
    const composition = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "a.vxl" }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
      autosaveDelayMs: 10,
    });
    const opened = requireResult(await composition.fileService.openProject());
    expect(opened.ok).toBe(true);
    const before = await storage.readProject("a.vxl");
    editThroughSession(composition);
    // Replace before the autosave debounce elapses.
    await composition.fileService.openLoadedProject("b.vxl", await seedBytes());
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The old document's autosave binding was disposed on replacement:
    // the debounced write never landed, so a.vxl keeps its seeded bytes.
    expect(await storage.readProject("a.vxl")).toEqual(before);
    // The new document is clean (its snapshot is durable).
    expect(composition.fileService.status.dirty).toBe(false);
    composition.dispose();
  });

  it("journals committed edits and compacts the journal on confirmed save", async () => {
    const storage = new MemoryProjectStorage();
    await seedProject(storage, "j.vxl");
    const composition = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "j.vxl" }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    const opened = requireResult(await composition.fileService.openProject());
    expect(opened.ok).toBe(true);
    editThroughSession(composition);
    // Journaling is asynchronous after commit; wait for the append.
    await vi.waitFor(async () => {
      expect(await storage.readJournal("j.vxl")).toBeDefined();
    });
    const decoded = decodeJournalFrames(
      (await storage.readJournal("j.vxl")) ?? new Uint8Array(),
    );
    expect(decoded.header).toBeDefined();
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.frames[0]?.frame.revisionAfter).toBe(
      composition.session.current?.store.revision,
    );

    // A confirmed save compacts the journal: header only, new anchor.
    const saved = requireResult(await composition.fileService.saveProject());
    expect(saved.ok).toBe(true);
    const after = decodeJournalFrames(
      (await storage.readJournal("j.vxl")) ?? new Uint8Array(),
    );
    expect(after.frames).toHaveLength(0);
    expect(after.header?.baseRevision).toBe(
      composition.session.current?.store.revision,
    );
    composition.dispose();
  });

  it("exposes pending-save progress while a write is in flight", async () => {
    const storage = new MemoryProjectStorage();
    const gated = new GatedPort(storage);
    await seedProject(gated, "progress.vxl");
    const composition = createDesktopComposition({
      storage: gated,
      picker: makePicker({ openPath: "progress.vxl" }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    await composition.fileService.openProject();
    editThroughSession(composition);
    gated.gate();
    const saving = composition.fileService.saveProject();
    await gated.entered();
    expect(composition.fileService.status.saving).toBe(true);
    expect(composition.fileService.status.progress).toBe("create-temp");
    gated.release();
    const result = requireResult(await saving);
    expect(result.ok).toBe(true);
    expect(composition.fileService.status.saving).toBe(false);
    expect(composition.fileService.status.progress).toBeUndefined();
    composition.dispose();
  });

  it("anchors a first-save journal at the saved outcome, not the live state", async () => {
    const storage = new MemoryProjectStorage();
    const gated = new GatedPort(storage);
    const composition = createDesktopComposition({
      storage: gated,
      picker: makePicker({ savePath: "first.vxl" }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    await composition.fileService.newProject();
    // A blank project can still become dirty through material commands.
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const created = state.bus.execute(
      createMaterialCommand(commandId("command:lifecycle:material"), {
        materialId: materialId(7),
        name: "accent",
        color: canonicalColor("#00ff88"),
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      }),
      {
        transactionId: transactionId("transaction:lifecycle:material"),
        expectedRevision: 0,
        source: "ui",
      },
    );
    if (!created.ok) throw new Error(`material failed: ${created.error.code}`);
    expect(composition.fileService.status.dirty).toBe(true);

    // The first save establishes the path; an edit lands mid-write.
    gated.gate();
    const saving = composition.fileService.saveProject();
    await gated.entered();
    const second = composition.session.current;
    if (second === undefined) throw new Error("no open session");
    const edited = second.bus.execute(
      createMaterialCommand(commandId("command:lifecycle:material-2"), {
        materialId: materialId(8),
        name: "accent-2",
        color: canonicalColor("#00ff88"),
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      }),
      {
        transactionId: transactionId("transaction:lifecycle:material-2"),
        expectedRevision: second.store.revision,
        source: "ui",
      },
    );
    if (!edited.ok) throw new Error(`material-2 failed: ${edited.error.code}`);
    gated.release();
    const saved = requireResult(await saving);
    expect(saved.ok).toBe(true);
    expect(composition.fileService.status.lastSaveStale).toBe(true);
    expect(composition.fileService.status.dirty).toBe(true);

    // The journal anchors at the SAVED snapshot (revision 1), so the
    // newer edit stays recoverable instead of being claimed durable.
    await vi.waitFor(async () => {
      expect(await storage.readJournal("first.vxl")).toBeDefined();
    });
    const decoded = decodeJournalFrames(
      (await storage.readJournal("first.vxl")) ?? new Uint8Array(),
    );
    expect(decoded.header?.baseRevision).toBe(1);
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.frames[0]?.frame.revisionAfter).toBe(2);
    composition.dispose();
  });

  it("resets per-document flags on lifecycle replacement", async () => {
    const storage = new MemoryProjectStorage();
    const gated = new GatedPort(storage);
    await seedProject(gated, "flags.vxl");
    const composition = createDesktopComposition({
      storage: gated,
      picker: makePicker({ openPath: "flags.vxl" }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    await composition.fileService.openProject();
    editThroughSession(composition);
    gated.gate();
    const saving = composition.fileService.saveProject();
    await gated.entered();
    editThroughSession(composition);
    gated.release();
    await saving;
    expect(composition.fileService.status.lastSaveStale).toBe(true);
    expect(composition.fileService.status.dirty).toBe(true);

    // Replacing the document must clear stale/pending/progress state.
    await composition.fileService.openLoadedProject(
      "next.vxl",
      await seedBytes(),
    );
    expect(composition.fileService.status.lastSaveStale).toBe(false);
    expect(composition.fileService.status.saving).toBe(false);
    expect(composition.fileService.status.autosaving).toBe(false);
    expect(composition.fileService.status.progress).toBeUndefined();
    expect(composition.fileService.status.dirty).toBe(false);
    composition.dispose();
  });

  it("reopening a compacted project rebinds the journal without session mismatches", async () => {
    const storage = new MemoryProjectStorage();
    await seedProject(storage, "reopen.vxl");
    const first = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "reopen.vxl" }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    await first.fileService.openProject();
    editThroughSession(first);
    // A confirmed save compacts the journal to a header-only anchor.
    const saved = requireResult(await first.fileService.saveProject());
    expect(saved.ok).toBe(true);
    const closed = requireResult(await first.fileService.closeProject());
    expect(closed.ok).toBe(true);
    first.dispose();

    // Reopen: nothing is replayable, so the covered journal is dropped and
    // a fresh writer binds at the loaded anchor.
    const second = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "reopen.vxl" }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    const opened = requireResult(await second.fileService.openProject());
    expect(opened.ok).toBe(true);
    expect(second.fileService.status.dirty).toBe(false);
    editThroughSession(second);
    // The append landed on the fresh journal: no session mismatch, and
    // recovery stays healthy.
    await vi.waitFor(async () => {
      const decoded = decodeJournalFrames(
        (await storage.readJournal("reopen.vxl")) ?? new Uint8Array(),
      );
      expect(decoded.frames).toHaveLength(1);
    });
    expect(second.fileService.status.degraded).toBe(false);
    second.dispose();
  });

  it("applies journaled recovery through the lifecycle with a fresh history", async () => {
    const storage = new MemoryProjectStorage();
    const { sessionId } = await buildJournaledProject(storage, "crash.vxl");
    const composition = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "crash.vxl" }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    const result = requireResult(await composition.fileService.openProject());
    expect(result.ok).toBe(true);
    expect(composition.session.current?.source).toBe("recovery");
    expect(composition.session.current?.revision).toBe(2);
    // Recovery starts a fresh bounded user history (ADR-0003).
    expect(
      composition.session.current?.bus.historySnapshot().past,
    ).toHaveLength(0);
    expect(
      composition.editor.notices.some((notice) =>
        notice.message.includes("Applied 2 recovered changes"),
      ),
    ).toBe(true);
    // The recovered document is dirty: the journaled edits are not on disk.
    expect(composition.fileService.status.dirty).toBe(true);
    // The journal still exists and keeps its session identity.
    const journalBytes = await storage.readJournal("crash.vxl");
    const decoded = decodeJournalFrames(journalBytes ?? new Uint8Array());
    expect(decoded.header?.recoverySessionId).toBe(sessionId);
    expect(decoded.frames).toHaveLength(2);
    composition.dispose();
  });

  it("declining recovery installs the snapshot and discards the journal", async () => {
    const storage = new MemoryProjectStorage();
    await buildJournaledProject(storage, "skip.vxl");
    const composition = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "skip.vxl" }),
      prompts: createScriptedPrompts(false),
      recent: createMemoryRecentProjects(),
    });
    const result = requireResult(await composition.fileService.openProject());
    expect(result.ok).toBe(true);
    expect(composition.session.current?.source).toBe("import");
    expect(composition.session.current?.revision).toBe(0);
    // The declined journal was removed; the fresh writer materializes the
    // file only on the next append, so nothing replayable remains.
    expect(await storage.readJournal("skip.vxl")).toBeUndefined();
    expect(
      composition.editor.notices.some((notice) =>
        notice.message.includes("not applied"),
      ),
    ).toBe(true);
    composition.dispose();
  });

  it("reports a corrupt tail honestly and recovers the valid prefix", async () => {
    const storage = new MemoryProjectStorage();
    await buildJournaledProject(storage, "tail.vxl");
    // Append garbage: a partial frame the decoder must not guess past.
    await storage.appendJournal("tail.vxl", new Uint8Array([1, 2, 3, 4, 5]));
    const composition = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "tail.vxl" }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    const result = requireResult(await composition.fileService.openProject());
    expect(result.ok).toBe(true);
    expect(composition.session.current?.source).toBe("recovery");
    // Both complete frames replay; the damaged tail is reported, not guessed.
    expect(composition.session.current?.revision).toBe(2);
    expect(
      composition.editor.notices.some((notice) =>
        notice.message.includes("damaged change"),
      ),
    ).toBe(true);
    expect(
      composition.editor.notices.some((notice) =>
        notice.message.includes("Applied 2 recovered changes"),
      ),
    ).toBe(true);
    composition.dispose();
  });

  it("surfaces degraded recovery when journal appends fail and recovers on retry", async () => {
    const storage = new MemoryProjectStorage();
    const gated = new GatedPort(storage);
    await seedProject(gated, "deg.vxl");
    const composition = createDesktopComposition({
      storage: gated,
      picker: makePicker({ openPath: "deg.vxl" }),
      prompts: createScriptedPrompts(true),
      recent: createMemoryRecentProjects(),
    });
    const opened = requireResult(await composition.fileService.openProject());
    expect(opened.ok).toBe(true);
    expect(composition.fileService.status.degraded).toBe(false);

    gated.failAppend = true;
    editThroughSession(composition);
    await vi.waitFor(() => {
      expect(composition.fileService.status.degraded).toBe(true);
    });
    expect(
      composition.editor.notices.some((notice) =>
        notice.message.includes("recovery is degraded"),
      ),
    ).toBe(true);
    // The in-memory edit stays valid and dirty (never claimed durable).
    expect(composition.fileService.status.dirty).toBe(true);
    expect(composition.session.current?.store.revision).toBe(2);

    // The next commit retries the append and clears the degraded state.
    editThroughSession(composition);
    await vi.waitFor(() => {
      expect(composition.fileService.status.degraded).toBe(false);
    });
    const journalBytes = await storage.readJournal("deg.vxl");
    const decoded = decodeJournalFrames(journalBytes ?? new Uint8Array());
    expect(decoded.frames).toHaveLength(2);
    composition.dispose();
  });

  it("opens through the picker and replaces a dirty document only after the prompt", async () => {
    const storage = new MemoryProjectStorage();
    await seedProject(storage, "current.vxl");
    await seedProject(storage, "r.vxl");
    const composition = createDesktopComposition({
      storage,
      picker: makePicker({ openPath: "r.vxl" }),
      prompts: createScriptedPrompts([false, true]),
      recent: createMemoryRecentProjects(),
    });
    await composition.fileService.openProject();
    editThroughSession(composition);
    // First attempt: discard declined -> stays on the dirty document.
    const declined = await composition.fileService.openProject();
    expect(declined).toBeUndefined();
    expect(composition.session.current?.documentId).toBe(
      "document:lifecycle:lifecycle-fixture",
    );
    // Second attempt: discard accepted -> replaced.
    const opened = requireResult(await composition.fileService.openProject());
    expect(opened.ok).toBe(true);
    expect(composition.session.current?.documentId).toBe(
      "document:lifecycle:lifecycle-fixture",
    );
    composition.dispose();
  });
});
