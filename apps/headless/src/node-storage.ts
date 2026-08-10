import { randomBytes } from "node:crypto";
import {
  copyFile,
  open,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { INPUT_FILE_MAX_BYTES, WorkspaceError } from "@voxel-maker/shared";
import {
  backupPathFor,
  inputFileLimitError,
  IO_ERROR_CODES,
  IO_ERROR_MESSAGES,
  journalPathFor,
  storageIoError,
  tempPathFor,
  throwIfAborted,
  throwPhaseFault,
  type AtomicWriteFaultPlan,
  type AtomicWriteOptions,
  type AtomicWriteResult,
  type ProjectStoragePort,
  type RecoveryJournalPort,
} from "@voxel-maker/storage";

/**
 * Node filesystem storage port (plan S5.7, ticket #13): same-directory
 * temporary output, flush/fsync where supported, atomic replace over the
 * destination, best-effort parent directory sync, and a last-known-good
 * backup of the previous destination. Fault injection (disk-full,
 * permissions, rename, interruption) shares the phase and error contract of
 * the memory adapter, so the conformance matrix runs against both. This is
 * the M1 test adapter; the desktop app later supplies a Tauri adapter at the
 * same seam (plan S6.18).
 */
export class NodeProjectStorage
  implements ProjectStoragePort, RecoveryJournalPort
{
  readonly #faults: AtomicWriteFaultPlan;
  readonly #nonce: () => string;
  readonly #writeChunkBytes: number;
  readonly #readMaxBytes: number;

  constructor(
    options: {
      readonly faults?: AtomicWriteFaultPlan;
      readonly nonce?: () => string;
      /** Bytes written per chunk so cancellation can interrupt large saves. */
      readonly writeChunkBytes?: number;
      /**
       * Hard read cap enforced before a project/backup/journal body is read
       * (issue #96; ADR-0009 default `INPUT_FILE_MAX_BYTES`). A test seam so
       * boundary tests avoid multi-hundred-MiB fixtures; production callers
       * keep the hard default.
       */
      readonly readMaxBytes?: number;
    } = {},
  ) {
    this.#faults = options.faults ?? {};
    this.#nonce = options.nonce ?? (() => randomBytes(6).toString("hex"));
    this.#writeChunkBytes = options.writeChunkBytes ?? 256 * 1024;
    this.#readMaxBytes = options.readMaxBytes ?? INPUT_FILE_MAX_BYTES;
  }

  async readProject(path: string): Promise<Uint8Array> {
    try {
      return await readBoundedFile(path, this.#readMaxBytes);
    } catch (cause) {
      if (cause instanceof WorkspaceError) throw cause;
      throw mapFsError(cause, path);
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async readBackup(path: string): Promise<Uint8Array | undefined> {
    const backupPath = backupPathFor(path);
    try {
      return await readBoundedFile(backupPath, this.#readMaxBytes);
    } catch (cause) {
      if (cause instanceof WorkspaceError) throw cause;
      if (isNotFound(cause)) return undefined;
      throw mapFsError(cause, path);
    }
  }

  async readJournal(path: string): Promise<Uint8Array | undefined> {
    const journalPath = journalPathFor(path);
    try {
      return await readBoundedFile(journalPath, this.#readMaxBytes);
    } catch (cause) {
      if (cause instanceof WorkspaceError) throw cause;
      if (isNotFound(cause)) return undefined;
      throw mapFsError(cause, journalPath);
    }
  }

  async appendJournal(path: string, bytes: Uint8Array): Promise<void> {
    const journalPath = journalPathFor(path);
    let handle: FileHandle | undefined;
    try {
      handle = await open(journalPath, "a");
      await writeChunked(
        handle,
        bytes,
        this.#writeChunkBytes,
        undefined,
        journalPath,
      );
      // Flush policy: the append resolves only after the bytes are flushed
      // to the device, so a confirmed append is durable (plan S5.9).
      await handle.sync();
    } catch (cause) {
      throw mapFsError(cause, journalPath, undefined, true);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async replaceJournal(path: string, bytes: Uint8Array): Promise<void> {
    const journalPath = journalPathFor(path);
    const tempPath = tempPathFor(journalPath, this.#nonce());
    let handle: FileHandle | undefined;
    try {
      handle = await open(tempPath, "wx");
      await writeChunked(
        handle,
        bytes,
        this.#writeChunkBytes,
        undefined,
        journalPath,
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, journalPath);
    } catch (cause) {
      if (handle !== undefined) await handle.close().catch(() => {});
      await rm(tempPath, { force: true }).catch(() => {});
      if (cause instanceof WorkspaceError) throw cause;
      throw mapFsError(cause, journalPath, tempPath, true);
    }
  }

  async removeJournal(path: string): Promise<void> {
    await rm(journalPathFor(path), { force: true });
  }

  async writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
    options?: AtomicWriteOptions,
  ): Promise<AtomicWriteResult> {
    const faults = options?.faults ?? this.#faults;
    const signal = options?.signal;
    const onPhase = options?.onPhase;
    const tempPath = tempPathFor(path, this.#nonce());
    const backupPath = backupPathFor(path);
    const backupTempPath = tempPathFor(backupPath, this.#nonce());
    let handle: FileHandle | undefined;
    try {
      onPhase?.("create-temp");
      throwPhaseFault(faults, "create-temp", path);
      throwIfAborted(signal, path);
      // Exclusive creation: a stale temp with a colliding name must not be
      // overwritten; the nonce makes collisions practically impossible.
      handle = await open(tempPath, "wx");

      onPhase?.("write-temp");
      throwPhaseFault(faults, "write-temp", path);
      throwIfAborted(signal, path);
      await writeChunked(handle, bytes, this.#writeChunkBytes, signal, path);

      onPhase?.("flush-temp");
      throwPhaseFault(faults, "flush-temp", path);
      throwIfAborted(signal, path);
      await handle.sync();
      await handle.close();
      handle = undefined;

      // Preserve the previous destination as the last-known-good backup
      // before the replace, so every point in time keeps a good project.
      // The backup itself is refreshed atomically (copy to a temporary
      // backup, then rename over the previous backup), so a mid-copy
      // failure can never leave a truncated backup: the previous
      // last-known-good backup stays intact.
      let backupCreated = false;
      if (await this.exists(path)) {
        onPhase?.("backup");
        throwPhaseFault(faults, "backup", path);
        throwIfAborted(signal, path);
        await copyFile(path, backupTempPath);
        throwIfAborted(signal, path);
        await rename(backupTempPath, backupPath);
        backupCreated = true;
      }

      onPhase?.("replace");
      throwPhaseFault(faults, "replace", path);
      throwIfAborted(signal, path);
      await rename(tempPath, path);

      // Best-effort parent directory sync: a failure never fails the save.
      let directorySyncSucceeded = true;
      try {
        onPhase?.("sync-directory");
        throwPhaseFault(faults, "sync-directory", path);
        await syncDirectory(dirname(path));
      } catch {
        directorySyncSucceeded = false;
      }

      return {
        tempPath,
        backupCreated,
        ...(backupCreated ? { backupPath } : {}),
        directorySyncSucceeded,
      };
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => {});
      }
      await rm(tempPath, { force: true }).catch(() => {});
      await rm(backupTempPath, { force: true }).catch(() => {});
      if (error instanceof WorkspaceError) {
        // Keep the stable code/message and add the temp path for diagnostics.
        throw new WorkspaceError({
          family: error.family,
          code: error.code,
          message: error.message,
          context: { ...error.context, tempPath },
        });
      }
      throw mapFsError(error, path, tempPath, true);
    }
  }
}

/**
 * Reads one file with a stat preflight and a bounded stream (issue #96):
 * the path is statted and non-regular or oversized inputs are rejected
 * BEFORE the path is opened, the buffer is allocated only after the opened
 * handle is re-verified (so it is at most `maxBytes`), and a file that
 * changes size mid-read is rejected instead of returning a truncated or
 * over-cap body. Preflight failures throw the stable `WorkspaceError`;
 * filesystem failures throw the raw cause for `mapFsError` to translate at
 * the call site.
 */
async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  // Path-level preflight: directories, FIFOs, and devices never reach the
  // open, so a hostile special file can neither block the reader nor be
  // treated as project data.
  const preflight = await stat(path);
  if (!preflight.isFile()) {
    throw storageIoError(
      IO_ERROR_CODES.notRegular,
      "The input path is not a regular file",
      { path },
    );
  }
  if (preflight.size > maxBytes) {
    throw inputFileLimitError(path, preflight.size, maxBytes);
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    // Re-verify the opened handle: the path could have been swapped after
    // the preflight, so the bound is checked against what will be read.
    const info = await handle.stat();
    if (!info.isFile()) {
      throw storageIoError(
        IO_ERROR_CODES.notRegular,
        "The input path is not a regular file",
        { path },
      );
    }
    if (info.size > maxBytes) {
      throw inputFileLimitError(path, info.size, maxBytes);
    }
    const bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset < bytes.byteLength) {
      // The file shrank between the preflight and the read: reject rather
      // than return a silently truncated body.
      throw storageIoError(
        IO_ERROR_CODES.readFailed,
        "The input file changed while it was being read",
        { path },
      );
    }
    // A file that grew during the read was only read up to the preflighted
    // size. Classify the change by its current size: a small concurrent
    // growth is a read failure, and only a growth past the cap is a limit
    // violation.
    const after = await handle.stat();
    if (after.size > info.size) {
      if (after.size > maxBytes) {
        throw inputFileLimitError(path, after.size, maxBytes);
      }
      throw storageIoError(
        IO_ERROR_CODES.readFailed,
        "The input file changed while it was being read",
        { path },
      );
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeChunked(
  handle: FileHandle,
  bytes: Uint8Array,
  chunkBytes: number,
  signal: AbortSignal | undefined,
  path: string,
): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    throwIfAborted(signal, path);
    const end = Math.min(offset + chunkBytes, bytes.byteLength);
    await handle.write(bytes.subarray(offset, end));
  }
  throwIfAborted(signal, path);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code: unknown }).code === "ENOENT"
  );
}

/** Maps a native filesystem error to the stable storage error contract. */
export function mapFsError(
  cause: unknown,
  path: string,
  tempPath?: string,
  writing = false,
): WorkspaceError {
  const code = (cause as { code?: unknown }).code;
  const context = {
    path,
    ...(tempPath === undefined ? {} : { tempPath }),
  };
  switch (code) {
    case "ENOENT":
      // Reads of missing files are IO_NOT_FOUND; a missing directory while
      // writing is a write failure, never a claim that the project exists.
      return writing
        ? storageIoError(
            IO_ERROR_CODES.writeFailed,
            "The project directory does not exist",
            context,
            cause,
          )
        : storageIoError(
            IO_ERROR_CODES.notFound,
            "The project file does not exist",
            context,
            cause,
          );
    case "ENOSPC":
    case "EDQUOT":
      return storageIoError(
        IO_ERROR_CODES.diskFull,
        "The storage device is full",
        context,
        cause,
      );
    case "EACCES":
    case "EPERM":
      return storageIoError(
        IO_ERROR_CODES.permissionDenied,
        "Permission denied while writing the project file",
        context,
        cause,
      );
    case "EEXIST":
      return storageIoError(
        IO_ERROR_CODES.permissionDenied,
        "A temporary project file with the same name already exists",
        context,
        cause,
      );
    case "ENOTDIR":
    case "EISDIR":
      return storageIoError(
        IO_ERROR_CODES.writeFailed,
        "The project path is not a regular file path",
        context,
        cause,
      );
    default:
      return storageIoError(
        IO_ERROR_CODES.writeFailed,
        IO_ERROR_MESSAGES.writeFailed,
        context,
        cause,
      );
  }
}
