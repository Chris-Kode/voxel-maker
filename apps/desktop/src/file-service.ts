import {
  WorkspaceError,
  createListenerSet,
  documentId,
  nodeId,
  recoverySessionId,
  type DocumentId,
  type RecoverySessionId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  CommandRegistry,
  journalTransactionToJson,
  type CommittedTransactionRecord,
} from "@voxel-maker/commands";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type {
  CommandRegistryRegistrar,
  DocumentSession,
} from "@voxel-maker/session";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";
import { readVxlProject } from "@voxel-maker/formats";
import {
  captureRevisionSnapshot,
  createRecoveryJournal,
  createSaveCoordinator,
  createVxlProjectEncoder,
  decodeJournalFrames,
  type AtomicWritePhase,
  type ProjectStoragePort,
  type RecoveryJournal,
  type RecoveryJournalPort,
  type SaveCoordinator,
} from "@voxel-maker/storage";
import type { EditorStore } from "@voxel-maker/editor";
import { recoverProjectFromPorts, type RecoveryReport } from "./recovery.js";
import { PROMPT_MESSAGES, type PromptService } from "./prompts.js";
import { createAutosave, type AutosaveController } from "./autosave.js";
import type {
  RecentProjectEntry,
  RecentProjectsPort,
} from "./recent-projects.js";
import type { FilePicker } from "./composition.js";

/**
 * Project workflow of the desktop shell (plan S7.16, ticket #22): new,
 * open, save, save-as, recent-project, replace, close, and recovery
 * actions through the lifecycle coordinator and the scoped native storage
 * interfaces. The service never mutates semantic state directly — new/open
 * install fully validated aggregates through `DocumentSession`
 * (ADR-0002), edits flow through the session's command bus, and the
 * per-document save coordinator, recovery journal, and autosave binding
 * are disposed and rebound on every lifecycle replacement.
 *
 * Data-safety feedback (acceptance criteria of ticket #22): dirty-close
 * and overwrite decisions go through the injected `PromptService`,
 * pending-save and stale-completion states are exposed on `status`,
 * journal failures surface as degraded recovery, saves can be cancelled,
 * and every error is a structured `WorkspaceError` surfaced through the
 * result and the runtime notice store.
 */

/** Outcome of one workflow action (ok: false + error on failure). */
export interface FileServiceResult {
  readonly ok: boolean;
  readonly path?: string;
  readonly documentId?: DocumentId;
  readonly revision?: number;
  readonly error?: WorkspaceError;
}

/** Read projection of the workflow for the shell chrome. */
export interface FileServiceStatus {
  readonly path: string | undefined;
  readonly documentId: DocumentId | undefined;
  readonly revision: number | undefined;
  readonly title: string | undefined;
  readonly nodeCount: number | undefined;
  /** True when live state differs from the last confirmed save (S5.14). */
  readonly dirty: boolean;
  /** True while any project write (save or autosave) is in flight. */
  readonly saving: boolean;
  /** True while the in-flight write is an autosave. */
  readonly autosaving: boolean;
  /** True when the last completed save captured stale state. */
  readonly lastSaveStale: boolean;
  /** True when crash-recovery coverage is degraded (journal failures). */
  readonly degraded: boolean;
  /** Most recent atomic-write phase of the in-flight save (undefined when idle). */
  readonly progress: AtomicWritePhase | undefined;
}

/** The narrow workflow surface handed to the shell. */
export interface FileService {
  readonly status: FileServiceStatus;
  /** Installs a fresh blank document; prompts before discarding a dirty one. */
  newProject(): Promise<FileServiceResult | undefined>;
  /** Picks a project file and opens (or replaces) it, applying recovery. */
  openProject(): Promise<FileServiceResult | undefined>;
  /** Opens bytes already read by the caller (tests, drag-drop). */
  openLoadedProject(
    name: string,
    bytes: Uint8Array,
  ): Promise<FileServiceResult | undefined>;
  /** Saves to the current path, or behaves as Save As when none exists. */
  saveProject(): Promise<FileServiceResult | undefined>;
  /** Picks a destination (with overwrite confirmation) and saves there. */
  saveProjectAs(): Promise<FileServiceResult | undefined>;
  /** Closes the current document; prompts before discarding unsaved work. */
  closeProject(): Promise<FileServiceResult | undefined>;
  /** Interrupts the in-flight write and rejects queued writes. */
  cancelSave(): void;
  /** Most-recent-first bounded list of previously opened projects. */
  recentProjects(): Promise<readonly RecentProjectEntry[]>;
  /** Opens a recent project through the normal open/recovery flow. */
  openRecentProject(path: string): Promise<FileServiceResult | undefined>;
  /** Forgets one recent entry. */
  forgetRecentProject(path: string): Promise<void>;
  /** Subscribes to status changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Unbinds the current document wiring and stops the workflow. */
  dispose(): void;
}

export interface FileServiceOptions {
  readonly session: DocumentSession;
  /** Project + adjacent journal port (scoped native storage, S6.18). */
  readonly storage: ProjectStoragePort & RecoveryJournalPort;
  readonly picker: FilePicker;
  /** Runtime notice store: workflow feedback is visible and actionable. */
  readonly editor: EditorStore;
  /** User confirmations (dirty-close, overwrite, recovery choice). */
  readonly prompts: PromptService;
  /** Bounded recent-project list (scoped native storage). */
  readonly recent: RecentProjectsPort;
  /**
   * Composition-owned journal sink: the session's fresh bus per install
   * carries `busHooks.onCommitted`, which delegates here; the workflow
   * points it at the current document's journal (or clears it).
   */
  readonly journalSink: {
    current: ((record: CommittedTransactionRecord) => void) | undefined;
  };
  /** Feature registrars used to replay journal frames during recovery. */
  readonly registerCommands: readonly CommandRegistryRegistrar[];
  /** Autosave debounce; defaults to 2000 ms. Tests may lower it. */
  readonly autosaveDelayMs?: number;
  /** Wall clock for recent-project ordering; tests inject a fixed clock. */
  readonly now?: () => number;
}

/** Per-document wiring, disposed and rebound on lifecycle replacement. */
interface Binding {
  readonly store: DocumentStoreRead;
  readonly sessionId: RecoverySessionId;
  readonly coordinator: SaveCoordinator;
  /** Undefined until the project has a path (journal materializes on save). */
  journal: RecoveryJournal | undefined;
  readonly autosave: AutosaveController;
  readonly unsubscribeStore: () => void;
  readonly unsubscribeCoordinator: () => void;
  unsubscribeJournal: (() => void) | undefined;
}

/** The recovery-journal scan result (see `recoveryProspect`). */
interface RecoveryProspect {
  readonly replayable: boolean;
  readonly frames: number;
  readonly recovered: number;
  readonly total: number;
  readonly corruptTail?: {
    readonly frameIndex: number;
    readonly reason: string;
  };
  readonly reason?: string;
}

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

export function createFileService(options: FileServiceOptions): FileService {
  const {
    session,
    storage,
    picker,
    editor,
    prompts,
    recent,
    journalSink,
    registerCommands,
  } = options;
  const autosaveDelayMs = options.autosaveDelayMs ?? 2000;
  const now = options.now ?? (() => Date.now());
  let path: string | undefined;
  let newCounter = 1;
  let sessionSerial = 0;
  let binding: Binding | undefined;
  /**
   * The journal the composition's bus hook currently forwards to. The sink
   * itself is installed once and stays connected across lifecycle
   * replacements, so a commit can never slip through between installs.
   */
  let currentJournal: RecoveryJournal | undefined;
  /**
   * Bounded buffer of committed records since the last binding. Used to
   * backfill the journal when an unsaved project's FIRST save completes
   * stale: edits that landed during the write are recoverable instead of
   * silently lost (plan S5.14).
   */
  let pendingRecords: CommittedTransactionRecord[] = [];
  let saving = false;
  let autosaving = false;
  let lastSaveStale = false;
  let journalingPaused = false;
  /** Most recent atomic-write phase of the in-flight save (plan S7.16). */
  let progress: AtomicWritePhase | undefined;
  const listeners = createListenerSet<undefined>();

  const notify = (): void => {
    listeners.emit(undefined);
  };

  const pushNotice = (
    level: "info" | "warning" | "error",
    message: string,
  ): void => {
    editor.pushNotice(level, message);
  };

  /** Session events keep the workflow honest when close happens elsewhere. */
  const unsubscribeSession = session.subscribe((event) => {
    if (event.kind === "document-closed") {
      unbind();
      path = undefined;
      notify();
    }
  });

  /**
   * The composition-owned bus hook stays connected for the workflow's
   * lifetime: every committed record is buffered (bounded) and forwarded
   * to the current journal when one exists. Semantic commit always
   * precedes journaling; failures surface through journal events and
   * status.degraded, never through the bus.
   */
  journalSink.current = (record: CommittedTransactionRecord): void => {
    pendingRecords.push(record);
    if (pendingRecords.length > PENDING_RECORD_LIMIT) {
      pendingRecords.shift();
    }
    const journal = currentJournal;
    if (journal === undefined) return;
    void journal
      .journal({
        revisionBefore: record.revisionBefore,
        revisionAfter: record.revisionAfter,
        transaction: journalTransactionToJson(record),
      })
      .catch(() => {
        // Reported through the journal's append-failed event.
      });
  };

  const status: FileServiceStatus = {
    get path() {
      return path;
    },
    get documentId() {
      return session.current?.documentId;
    },
    get revision() {
      return session.current?.revision;
    },
    get title() {
      // Metadata is bounded JSON (ARCHITECTURE.md): only a string title is
      // surfaced; other JSON kinds are ignored rather than asserted.
      const title = session.current?.store.getDocument().metadata.title;
      return typeof title === "string" ? title : undefined;
    },
    get nodeCount() {
      return session.current === undefined
        ? undefined
        : Object.keys(session.current.store.getDocument().nodes).length;
    },
    get dirty() {
      return binding?.coordinator.isDirty() ?? false;
    },
    get saving() {
      return saving;
    },
    get autosaving() {
      return autosaving;
    },
    get lastSaveStale() {
      return lastSaveStale;
    },
    get degraded() {
      return journalingPaused || (binding?.journal?.isDegraded() ?? false);
    },
    get progress() {
      return progress;
    },
  };

  function unbind(): void {
    if (binding === undefined) return;
    binding.unsubscribeStore();
    binding.unsubscribeCoordinator();
    binding.unsubscribeJournal?.();
    binding.autosave.dispose();
    binding.journal?.dispose();
    binding.coordinator.dispose();
    currentJournal = undefined;
    pendingRecords = [];
    // Lifecycle replacement resets every per-document runtime projection
    // (plan S5.15): pending-save, stale-completion, and degraded flags
    // never leak onto a freshly installed document.
    saving = false;
    autosaving = false;
    lastSaveStale = false;
    journalingPaused = false;
    progress = undefined;
    binding = undefined;
  }

  /** Wires the journal event handling shared by bind and attachJournal. */
  function subscribeJournal(journal: RecoveryJournal): () => void {
    return journal.subscribe((event) => {
      switch (event.kind) {
        case "append-failed":
          pushNotice(
            "warning",
            `Crash recovery is degraded: ${event.error.message}`,
          );
          notify();
          break;
        case "degraded-changed":
          notify();
          break;
        case "journal-repaired":
          pushNotice(
            "info",
            "Crash recovery has been repaired and is recording again",
          );
          notify();
          break;
        case "base-reset":
        case "compacted":
        case "reassociated":
          notify();
          break;
        case "appended":
          break;
      }
    });
  }

  /** The limit of the pending-record buffer (backfill safety bound). */
  const PENDING_RECORD_LIMIT = 512;

  /**
   * Backfills the fresh journal of an unsaved project's first save with
   * every buffered record committed AFTER the saved anchor (the stale
   * edits that landed while the write was in flight). Records at or below
   * the anchor are covered by the snapshot and skipped.
   */
  function backfillJournal(
    journal: RecoveryJournal,
    anchor: { readonly revision: number },
  ): void {
    for (const record of pendingRecords) {
      if (record.revisionAfter > anchor.revision) {
        void journal
          .journal({
            revisionBefore: record.revisionBefore,
            revisionAfter: record.revisionAfter,
            transaction: journalTransactionToJson(record),
          })
          .catch(() => {});
      }
    }
  }

  /**
   * Binds the per-document save coordinator, recovery journal, and
   * autosave to a freshly installed aggregate (plan S5.15: lifecycle
   * replacement resets history, selection, runtime projections, workers,
   * previews, and autosave bindings; the workflow mirrors that by
   * disposing the previous wiring).
   */
  function bind(
    state: { readonly store: DocumentStoreRead },
    bindOptions: {
      readonly path: string | undefined;
      /** Durable anchor on disk: the loaded snapshot (revision R, hash H_R). */
      readonly durable: {
        readonly revision: number;
        readonly semanticHash: string;
      };
      /** Journal anchor: the snapshot the journal extends (defaults to durable). */
      readonly journalBase?: {
        readonly revision: number;
        readonly semanticHash: string;
      };
      readonly sessionId: RecoverySessionId;
      /** False when the caller manages the journal itself (declined recovery). */
      readonly createJournal?: boolean;
    },
  ): void {
    unbind();
    const coordinator = createSaveCoordinator({
      store: state.store,
      port: storage,
      encoder: createVxlProjectEncoder(),
    });
    coordinator.markDurable(
      bindOptions.durable.revision,
      bindOptions.durable.semanticHash,
      bindOptions.path ?? "",
    );

    const journal =
      bindOptions.path === undefined || bindOptions.createJournal === false
        ? undefined
        : createRecoveryJournal({
            projectPath: bindOptions.path,
            port: storage,
            sessionId: bindOptions.sessionId,
            baseRevision:
              bindOptions.journalBase?.revision ?? bindOptions.durable.revision,
            baseSemanticHash:
              bindOptions.journalBase?.semanticHash ??
              bindOptions.durable.semanticHash,
            encoder: createVxlProjectEncoder(),
            capture: () => captureRevisionSnapshot(state.store),
          });

    const unsubscribeCoordinator = coordinator.subscribe((event) => {
      switch (event.kind) {
        case "save-started":
          saving = true;
          progress = undefined;
          notify();
          break;
        case "save-progress":
          progress = event.phase;
          notify();
          break;
        case "save-completed":
          saving = false;
          progress = undefined;
          if (event.stale) {
            lastSaveStale = true;
            pushNotice(
              "warning",
              `The project changed while saving; the saved copy is at revision ${String(event.revision)} and your newer changes are still unsaved`,
            );
          } else {
            lastSaveStale = false;
          }
          notify();
          break;
        case "save-failed":
          saving = false;
          progress = undefined;
          // Manual saves surface their structured error through the result
          // AND a dismissible notice; autosave failures get their own
          // notice from the autosave binding (avoid double-reporting).
          if (!autosaving) {
            pushNotice("error", `Save failed: ${event.error.message}`);
          }
          notify();
          break;
        case "dirty-changed":
          notify();
          break;
      }
    });

    const autosave = createAutosave({
      coordinator,
      path: () => path,
      delayMs: autosaveDelayMs,
      onStart: () => {
        autosaving = true;
        notify();
      },
      onSettled: () => {
        autosaving = false;
        notify();
      },
      onFailure: (error) => {
        pushNotice(
          "warning",
          `Autosave failed: ${error.message} — your changes are still unsaved`,
        );
      },
    });

    const next: Binding = {
      store: state.store,
      sessionId: bindOptions.sessionId,
      coordinator,
      journal,
      autosave,
      unsubscribeStore: state.store.subscribe(() => {
        // The coordinator invalidates its own live-hash cache on commits;
        // this hook keeps the workflow's status fresh on the same event.
        notify();
      }),
      unsubscribeCoordinator,
      unsubscribeJournal: undefined,
    };
    if (journal !== undefined) {
      next.unsubscribeJournal = subscribeJournal(journal);
      currentJournal = journal;
    }
    binding = next;
    notify();
  }

  /**
   * Creates the recovery journal for a first save of an unsaved project.
   * The anchor is the SAVED outcome (revision R, hash H_R), never the live
   * store: if an edit lands during that first save (stale completion), the
   * file on disk still matches the anchor, and the newer edit stays dirty
   * and journalable instead of being claimed durable (plan S5.14).
   */
  function attachJournal(
    current: Binding,
    targetPath: string,
    anchor: { readonly revision: number; readonly semanticHash: string },
  ): void {
    const journal = createRecoveryJournal({
      projectPath: targetPath,
      port: storage,
      sessionId: current.sessionId,
      baseRevision: anchor.revision,
      baseSemanticHash: anchor.semanticHash,
      encoder: createVxlProjectEncoder(),
      capture: () => captureRevisionSnapshot(current.store),
    });
    current.unsubscribeJournal = subscribeJournal(journal);
    current.journal = journal;
    currentJournal = journal;
    // Any edit that landed during the (first) save is still recoverable.
    backfillJournal(journal, anchor);
    notify();
  }

  /** A fully validated load ready for lifecycle install. */
  interface LoadedProject {
    readonly document: VoxelDocument;
    readonly volumes: ReadonlyMap<VolumeId, readonly VoxelChunkSeed[]>;
  }

  /** Decodes project bytes into a validated load (chunk seeds copied). */
  function toLoaded(bytes: Uint8Array): LoadedProject {
    const loaded = readVxlProject(bytes);
    const seeds = new Map<VolumeId, readonly VoxelChunkSeed[]>();
    for (const volume of loaded.volumes.values()) {
      seeds.set(volume.volumeId, volume.chunks);
    }
    return { document: loaded.document, volumes: seeds };
  }

  /** Installs a fully validated load through the lifecycle coordinator. */
  function install(
    name: string,
    loaded: LoadedProject,
    installOptions: {
      readonly source: "import" | "recovery";
      readonly durable: {
        readonly revision: number;
        readonly semanticHash: string;
      };
      readonly journalBase?: {
        readonly revision: number;
        readonly semanticHash: string;
      };
      readonly sessionId: RecoverySessionId;
      readonly recordRecent: boolean;
      /** False when the caller drops/recreates the journal itself. */
      readonly createJournal?: boolean;
    },
  ): FileServiceResult {
    try {
      const state =
        session.current === undefined
          ? session.open({
              document: loaded.document,
              volumes: loaded.volumes,
              source: installOptions.source,
            })
          : session.replace({
              document: loaded.document,
              volumes: loaded.volumes,
              source: installOptions.source,
            });
      path = name;
      bind(state, {
        path: name,
        durable: installOptions.durable,
        ...(installOptions.journalBase === undefined
          ? {}
          : { journalBase: installOptions.journalBase }),
        sessionId: installOptions.sessionId,
        ...(installOptions.createJournal === undefined
          ? {}
          : { createJournal: installOptions.createJournal }),
      });
      if (installOptions.recordRecent) {
        recordRecent(name);
      }
      notify();
      return {
        ok: true,
        path: name,
        documentId: state.documentId,
        revision: state.revision,
      };
    } catch (error) {
      return { ok: false, path: name, error: toWorkspaceError(error) };
    }
  }

  /** Records a recent entry; a failing store degrades the list only. */
  function recordRecent(projectPath: string): void {
    void recent
      .record({
        path: projectPath,
        title: status.title ?? "",
        openedAt: now(),
      })
      .catch(() => {
        pushNotice("info", "The recent-projects list could not be updated");
      });
  }

  /** Fresh recovery identity for a newly opened document (stable per install). */
  function nextSessionId(documentIdText: DocumentId): RecoverySessionId {
    sessionSerial += 1;
    return recoverySessionId(
      `session:${documentIdText}:${String(sessionSerial)}`,
    );
  }

  /** Plain open: installs the snapshot at the loaded anchor. */
  function plainInstall(picked: string, bytes: Uint8Array): FileServiceResult {
    const loaded = readVxlProject(bytes);
    return install(picked, toLoaded(bytes), {
      source: "import",
      durable: {
        revision: loaded.document.revision,
        semanticHash: loaded.semanticHash,
      },
      sessionId: nextSessionId(loaded.document.documentId),
      recordRecent: true,
    });
  }

  /**
   * Open after declining (or when unable to replay) a journal: installs
   * the snapshot, removes the declined journal file, and binds a fresh
   * journal writer at the loaded anchor so the next crash cannot re-apply
   * declined frames or corrupt the stream.
   */
  async function resetJournalInstall(
    picked: string,
    bytes: Uint8Array,
  ): Promise<FileServiceResult> {
    const loaded = readVxlProject(bytes);
    const result = install(picked, toLoaded(bytes), {
      source: "import",
      durable: {
        revision: loaded.document.revision,
        semanticHash: loaded.semanticHash,
      },
      sessionId: nextSessionId(loaded.document.documentId),
      recordRecent: true,
      createJournal: false,
    });
    if (result.ok) {
      try {
        await storage.removeJournal(picked);
      } catch (error) {
        journalingPaused = true;
        pushNotice(
          "error",
          `The declined recovery journal could not be removed; new changes are not being journaled (${toWorkspaceError(error).message})`,
        );
        notify();
      }
      if (binding !== undefined && !journalingPaused) {
        attachJournal(binding, picked, {
          revision: loaded.document.revision,
          semanticHash: loaded.semanticHash,
        });
      }
    }
    return result;
  }

  /** Applies the journal through the recovery orchestrator (ticket #14). */
  async function applyRecovery(picked: string): Promise<FileServiceResult> {
    const registry = new CommandRegistry();
    for (const register of registerCommands) register(registry);
    const recovered = await recoverProjectFromPorts({
      port: storage,
      projectPath: picked,
      registry,
    });
    const report = recovered.report;
    const result = install(
      picked,
      { document: recovered.document, volumes: recovered.volumes },
      {
        source: "recovery",
        durable: {
          revision: report.snapshotRevision,
          semanticHash: report.snapshotHash,
        },
        journalBase: {
          revision: report.journalBaseRevision ?? report.snapshotRevision,
          semanticHash: report.journalBaseSemanticHash ?? report.snapshotHash,
        },
        sessionId:
          report.sessionId ?? nextSessionId(recovered.document.documentId),
        recordRecent: true,
      },
    );
    if (result.ok) {
      surfaceRecoveryReport(report);
    }
    return result;
  }

  /** Surfaces the honest recovery outcome as notices (degraded = visible). */
  function surfaceRecoveryReport(report: RecoveryReport): void {
    if (report.incompatible !== undefined) {
      pushNotice(
        "warning",
        `Recovery was not applied: ${report.incompatible.reason}`,
      );
      return;
    }
    if (report.replayedFrames > 0) {
      pushNotice(
        "info",
        `Applied ${String(report.replayedFrames)} recovered change${
          report.replayedFrames === 1 ? "" : "s"
        }`,
      );
    }
    if (report.corruptTail !== undefined) {
      pushNotice(
        "warning",
        `Recovery stopped before ${String(
          report.corruptTail.frameIndex + 1,
        )} damaged change${report.corruptTail.frameIndex + 1 === 1 ? "" : "s"}; the damaged tail was not guessed at`,
      );
    }
  }

  /** Lightweight journal scan: is there anything to replay, and is it sane? */
  async function recoveryProspect(
    picked: string,
  ): Promise<RecoveryProspect | undefined> {
    const journalBytes = await storage.readJournal(picked);
    if (journalBytes === undefined || journalBytes.byteLength === 0) {
      return undefined;
    }
    let decoded: ReturnType<typeof decodeJournalFrames>;
    try {
      decoded = decodeJournalFrames(journalBytes);
    } catch (error) {
      return {
        replayable: false,
        frames: 0,
        recovered: 0,
        total: 0,
        reason: toWorkspaceError(error).message,
      };
    }
    const header = decoded.header;
    if (header === undefined) {
      return {
        replayable: false,
        frames: decoded.frames.length,
        recovered: 0,
        total: decoded.frames.length,
        reason: decoded.corruptTail?.reason ?? "missing journal header",
      };
    }
    const tail = decoded.corruptTail;
    const recovered = tail?.frameIndex ?? decoded.frames.length;
    const total = decoded.frames.length + (tail === undefined ? 0 : 1);
    if (total === 0) return undefined;
    return {
      replayable: true,
      frames: decoded.frames.length,
      recovered,
      total,
      ...(tail === undefined ? {} : { corruptTail: tail }),
    };
  }

  /**
   * Reads bytes (unless supplied), checks recovery, and installs through
   * the normal open flow.
   */
  async function openAt(
    picked: string,
    bytes?: Uint8Array,
  ): Promise<FileServiceResult | undefined> {
    if (
      session.current !== undefined &&
      status.dirty &&
      !(await prompts.confirm(PROMPT_MESSAGES.discardChanges))
    ) {
      return undefined;
    }
    try {
      const projectBytes = bytes ?? (await storage.readProject(picked));
      const prospect = await recoveryProspect(picked);
      if (prospect === undefined) {
        return plainInstall(picked, projectBytes);
      }
      if (prospect.replayable && prospect.total === 0) {
        // A journal exists but holds no replayable frames (a confirmed
        // save already compacted it): the snapshot covers everything.
        // Drop the covered journal and bind a fresh writer at the loaded
        // anchor so appends never collide with the old session header.
        return await resetJournalInstall(picked, projectBytes);
      }
      if (prospect.replayable) {
        const message =
          prospect.corruptTail === undefined
            ? PROMPT_MESSAGES.applyRecovery(prospect.frames)
            : PROMPT_MESSAGES.applyDegradedRecovery(
                prospect.recovered,
                prospect.total,
              );
        if (await prompts.confirm(message)) {
          return await applyRecovery(picked);
        }
        const declined = await resetJournalInstall(picked, projectBytes);
        // Pushed after the install: lifecycle replacement clears notices,
        // and the decline feedback must survive it.
        if (declined.ok) {
          pushNotice(
            "info",
            "Recovered changes were not applied; the recovery journal is discarded",
          );
        }
        return declined;
      }
      const reset = await resetJournalInstall(picked, projectBytes);
      if (reset.ok) {
        pushNotice(
          "warning",
          `The recovery journal for this project is damaged or incompatible and was reset (${String(prospect.reason)})`,
        );
      }
      return reset;
    } catch (error) {
      return { ok: false, path: picked, error: toWorkspaceError(error) };
    }
  }

  async function saveTo(
    current: { readonly documentId: DocumentId },
    targetPath: string,
  ): Promise<FileServiceResult> {
    if (binding === undefined) {
      return {
        ok: false,
        error: new WorkspaceError({
          family: "conflict",
          code: "SESSION_NOT_OPEN",
          message: "No document is open to save",
        }),
      };
    }
    const moved = targetPath !== path;
    try {
      if (moved && binding.journal !== undefined) {
        // Preserve the recovery identity across save-as (plan S5.15
        // "recovery-session Save As reassociation"). Reassociate BEFORE
        // the write: the journal's reassociation snapshots the current
        // project file to the new path (at every crash point at least one
        // path keeps a recoverable combination), and the write that
        // follows installs the true current state over it.
        try {
          await binding.journal.reassociate(targetPath);
        } catch (error) {
          pushNotice(
            "warning",
            `The recovery journal could not be moved to the new location (${toWorkspaceError(error).message})`,
          );
        }
      }
      const outcome = await binding.coordinator.save(targetPath);
      if (moved || outcome.status === "saved") {
        path = targetPath;
        if (binding.journal === undefined) {
          attachJournal(binding, targetPath, {
            revision: outcome.revision,
            semanticHash: outcome.semanticHash,
          });
        } else {
          // Confirmed-save cleanup (plan 5.6): the snapshot now covers the
          // journal frames up to the saved revision; reset the anchor and
          // drop covered frames. A failure leaves the journal intact and
          // recovery stays correct (covered frames are skipped on replay).
          try {
            await binding.journal.resetBase(
              outcome.revision,
              outcome.semanticHash,
            );
          } catch (error) {
            pushNotice(
              "warning",
              `The project was saved, but the recovery journal could not be compacted (${toWorkspaceError(error).message})`,
            );
          }
        }
        recordRecent(targetPath);
        notify();
      }
      return {
        ok: true,
        path: targetPath,
        documentId: current.documentId,
        revision: outcome.revision,
      };
    } catch (error) {
      return { ok: false, path: targetPath, error: toWorkspaceError(error) };
    }
  }

  return {
    get status() {
      return status;
    },
    async newProject() {
      if (
        session.current !== undefined &&
        status.dirty &&
        !(await prompts.confirm(PROMPT_MESSAGES.discardChanges))
      ) {
        return undefined;
      }
      const document = createDocument({
        documentId: documentId(
          `document:new:${String(newCounter).padStart(4, "0")}`,
        ),
        metadata: { title: "Untitled" },
        rootNodeId: nodeId("node:root"),
        nodes: [
          {
            nodeId: nodeId("node:root"),
            name: "Root",
            parentId: null,
            children: [],
            transform: IDENTITY,
            components: [],
          },
        ],
        materials: [],
        volumes: [],
      });
      newCounter += 1;
      const state =
        session.current === undefined
          ? session.open({ document })
          : session.replace({ document });
      const snapshot = captureRevisionSnapshot(state.store);
      path = undefined;
      bind(state, {
        path: undefined,
        durable: {
          revision: snapshot.revision,
          semanticHash: snapshot.semanticHash,
        },
        sessionId: nextSessionId(document.documentId),
      });
      notify();
      return {
        ok: true,
        documentId: state.documentId,
        revision: state.revision,
      };
    },
    async openProject() {
      const picked = await picker.pickOpenPath();
      if (picked === undefined) return undefined;
      return openAt(picked);
    },
    openLoadedProject(name, bytes) {
      return openAt(name, bytes);
    },
    async saveProject() {
      const current = session.current;
      if (current === undefined) {
        return {
          ok: false,
          error: new WorkspaceError({
            family: "conflict",
            code: "SESSION_NOT_OPEN",
            message: "No document is open to save",
          }),
        };
      }
      if (path === undefined) return this.saveProjectAs();
      return saveTo(current, path);
    },
    async saveProjectAs() {
      const current = session.current;
      if (current === undefined) {
        return {
          ok: false,
          error: new WorkspaceError({
            family: "conflict",
            code: "SESSION_NOT_OPEN",
            message: "No document is open to save",
          }),
        };
      }
      const suggested = suggestedProjectName(current.store.getDocument());
      const picked = await picker.pickSavePath(suggested);
      if (picked === undefined) return undefined;
      if (
        picked !== path &&
        (await storage.exists(picked)) &&
        !(await prompts.confirm(PROMPT_MESSAGES.overwriteProject))
      ) {
        return undefined;
      }
      return saveTo(current, picked);
    },
    async closeProject() {
      if (session.current === undefined) {
        return {
          ok: false,
          error: new WorkspaceError({
            family: "conflict",
            code: "SESSION_NOT_OPEN",
            message: "No document is open to close",
          }),
        };
      }
      if (
        status.dirty &&
        !(await prompts.confirm(PROMPT_MESSAGES.discardChanges))
      ) {
        return undefined;
      }
      session.close();
      return { ok: true };
    },
    cancelSave() {
      binding?.coordinator.cancel();
    },
    async recentProjects() {
      return recent.list();
    },
    async openRecentProject(pathToOpen) {
      return openAt(pathToOpen);
    },
    async forgetRecentProject(pathToForget) {
      await recent.remove(pathToForget);
    },
    subscribe(listener) {
      return listeners.add(listener);
    },
    dispose() {
      unsubscribeSession();
      unbind();
      journalSink.current = undefined;
      listeners.clear();
    },
  };
}

function suggestedProjectName(document: VoxelDocument): string {
  const title = document.metadata.title;
  const base =
    typeof title === "string" && title.length > 0
      ? title.replace(/[^A-Za-z0-9._-]+/gu, "-")
      : "untitled";
  return `${base}.vxl`;
}

function toWorkspaceError(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  return new WorkspaceError({
    family: "io",
    code: "FILE_OPERATION_FAILED",
    message: error instanceof Error ? error.message : "File operation failed",
  });
}
