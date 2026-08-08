import { WorkspaceError } from "@voxel-maker/shared";

/**
 * Phases of one atomic project write (plan S5.7, ADR-0004):
 * same-directory temporary output -> flush/fsync where supported -> backup ->
 * atomic replace -> best-effort parent directory sync. Adapters expose the
 * same phases so memory and filesystem implementations share one fault and
 * error contract (plan S5.6/S5.7, ticket #13).
 */
export type AtomicWritePhase =
  | "create-temp"
  | "write-temp"
  | "flush-temp"
  | "backup"
  | "replace"
  | "sync-directory";

/**
 * Fault injection for storage adapters (acceptance criterion of ticket #13:
 * disk-full, permissions, rename, interruption, and stale-completion
 * failures). A fault plan is honored by both the memory and the Node
 * filesystem adapter, so one conformance matrix exercises both. `true`
 * selects the adapter's canonical error for that phase.
 */
export interface AtomicWriteFaultPlan {
  readonly failAt?: Partial<Record<AtomicWritePhase, WorkspaceError | true>>;
}

/** Options for one atomic write call. */
export interface AtomicWriteOptions {
  /**
   * Cooperative cancellation: adapters check the signal between phases and
   * during the byte write loop. An abort observed before the atomic replace
   * rejects with `IO_WRITE_INTERRUPTED` and leaves destination and backup
   * untouched; an abort that races the replace after it committed does not
   * undo the committed write.
   */
  readonly signal?: AbortSignal;
  /** Per-call fault plan; overrides the adapter default when present. */
  readonly faults?: AtomicWriteFaultPlan;
}

/** Result of one successful atomic write. */
export interface AtomicWriteResult {
  /** Same-directory temporary path that became the destination. */
  readonly tempPath: string;
  /** True when a previous destination existed and was preserved as backup. */
  readonly backupCreated: boolean;
  /** Backup path, present exactly when `backupCreated` is true. */
  readonly backupPath?: string;
  /**
   * False when the best-effort parent directory sync failed. The save still
   * succeeded; only crash durability of the rename is weaker.
   */
  readonly directorySyncSucceeded: boolean;
}

/**
 * Storage port for one project file (plan S5.6 `RecoveryStoragePort` /
 * file service). The port owns external effects only: reading, atomic
 * replacement, backup retention, and deletion. It never parses or validates
 * container bytes; semantic decoding belongs to `@voxel-maker/formats`.
 * Implementations are supplied at the composition root (memory adapter in
 * `@voxel-maker/storage`, Node filesystem adapter in the headless app, a
 * Tauri adapter in the desktop app; plan S6.18).
 */
export interface ProjectStoragePort {
  /** Reads the complete project file; rejects `IO_NOT_FOUND` when absent. */
  readProject(path: string): Promise<Uint8Array>;
  /**
   * Atomically replaces `path` with `bytes`: write and flush a same-directory
   * temporary file, preserve the previous destination as a last-known-good
   * backup, then rename over the destination and best-effort sync the parent
   * directory. A failure at any phase before `replace` leaves destination
   * and backup untouched and removes the temporary file; a failure at
   * `replace` leaves the previous destination in place.
   */
  writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
    options?: AtomicWriteOptions,
  ): Promise<AtomicWriteResult>;
  exists(path: string): Promise<boolean>;
  /** Removes the project file; missing files are not an error. */
  remove(path: string): Promise<void>;
  /** Reads the last-known-good backup, or undefined when none exists. */
  readBackup(path: string): Promise<Uint8Array | undefined>;
}

/** Stable io error codes shared by every storage adapter. */
export const IO_ERROR_CODES = {
  notFound: "IO_NOT_FOUND",
  diskFull: "IO_DISK_FULL",
  permissionDenied: "IO_PERMISSION_DENIED",
  renameFailed: "IO_RENAME_FAILED",
  writeInterrupted: "IO_WRITE_INTERRUPTED",
  writeFailed: "IO_WRITE_FAILED",
  syncFailed: "IO_SYNC_FAILED",
} as const;

/** Stable user-safe messages shared by every storage adapter. */
export const IO_ERROR_MESSAGES = {
  interrupted: "The project write was interrupted",
  writeFailed: "The project write failed",
  notFound: "The project file does not exist",
} as const;

/**
 * The canonical error code for each atomic write phase. One mapping is
 * shared by `defaultPhaseError` (adapter errors) and the conformance matrix
 * (fault assertions), so a contract change cannot drift between them.
 */
export const PHASE_ERROR_CODES: Readonly<Record<AtomicWritePhase, string>> = {
  "create-temp": IO_ERROR_CODES.permissionDenied,
  "write-temp": IO_ERROR_CODES.diskFull,
  "flush-temp": IO_ERROR_CODES.diskFull,
  backup: IO_ERROR_CODES.permissionDenied,
  replace: IO_ERROR_CODES.renameFailed,
  "sync-directory": IO_ERROR_CODES.syncFailed,
};

/** Builds a stable io-family WorkspaceError with redacted cause. */
export function storageIoError(
  code: string,
  message: string,
  context: Readonly<Record<string, string | number | boolean>>,
  cause?: unknown,
): WorkspaceError {
  return new WorkspaceError({
    family: "io",
    code,
    message,
    context,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * The canonical adapter error for a phase, used when a fault plan maps a
 * phase to `true` and when a real filesystem error maps to that phase.
 */
const PHASE_ERROR_MESSAGES: Readonly<Record<AtomicWritePhase, string>> = {
  "create-temp":
    "Cannot create the temporary project file in the project directory",
  "write-temp": "Cannot write the temporary project file",
  "flush-temp": "Cannot flush the temporary project file to disk",
  backup: "Cannot preserve the last-known-good backup",
  replace: "Cannot atomically replace the project file",
  "sync-directory": "Cannot sync the project directory",
};

/** The canonical adapter error for a phase (fault plan `true` and real fs errors). */
export function defaultPhaseError(
  phase: AtomicWritePhase,
  path: string,
  cause?: unknown,
): WorkspaceError {
  return storageIoError(
    PHASE_ERROR_CODES[phase],
    PHASE_ERROR_MESSAGES[phase],
    { path, phase },
    cause,
  );
}

/** Throws the configured phase fault, or `true` resolves to the canonical error. */
export function throwPhaseFault(
  faults: AtomicWriteFaultPlan | undefined,
  phase: AtomicWritePhase,
  path: string,
): void {
  const fault = faults?.failAt?.[phase];
  if (fault === undefined) return;
  if (fault === true) throw defaultPhaseError(phase, path);
  throw fault;
}

/** Cooperative abort check between atomic write phases. */
export function throwIfAborted(
  signal: AbortSignal | undefined,
  path: string,
): void {
  if (signal?.aborted === true) {
    throw storageIoError(
      IO_ERROR_CODES.writeInterrupted,
      IO_ERROR_MESSAGES.interrupted,
      { path },
    );
  }
}

/**
 * Adjacent last-known-good backup path (ADR-0004, ADR-0011): the previous
 * destination is copied here before the atomic replace.
 */
export function backupPathFor(path: string): string {
  return `${path}.bak`;
}

/**
 * Same-directory temporary path for an atomic write: a hidden dotfile next
 * to the destination so a rename never crosses a filesystem boundary. The
 * nonce is adapter-supplied (random hex for the Node adapter, a counter for
 * the memory adapter).
 */
export function tempPathFor(path: string, nonce: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const directory = separator >= 0 ? path.slice(0, separator + 1) : "";
  const basename = separator >= 0 ? path.slice(separator + 1) : path;
  return `${directory}.${basename}.${nonce}.tmp`;
}
