import { randomBytes } from "node:crypto";
import {
  copyFile,
  open,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  backupPathFor,
  IO_ERROR_CODES,
  IO_ERROR_MESSAGES,
  storageIoError,
  tempPathFor,
  throwIfAborted,
  throwPhaseFault,
  type AtomicWriteFaultPlan,
  type AtomicWriteOptions,
  type AtomicWriteResult,
  type ProjectStoragePort,
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
export class NodeProjectStorage implements ProjectStoragePort {
  readonly #faults: AtomicWriteFaultPlan;
  readonly #nonce: () => string;
  readonly #writeChunkBytes: number;

  constructor(
    options: {
      readonly faults?: AtomicWriteFaultPlan;
      readonly nonce?: () => string;
      /** Bytes written per chunk so cancellation can interrupt large saves. */
      readonly writeChunkBytes?: number;
    } = {},
  ) {
    this.#faults = options.faults ?? {};
    this.#nonce = options.nonce ?? (() => randomBytes(6).toString("hex"));
    this.#writeChunkBytes = options.writeChunkBytes ?? 256 * 1024;
  }

  async readProject(path: string): Promise<Uint8Array> {
    try {
      return await readFile(path);
    } catch (cause) {
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
      return await readFile(backupPath);
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw mapFsError(cause, path);
    }
  }

  async writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
    options?: AtomicWriteOptions,
  ): Promise<AtomicWriteResult> {
    const faults = options?.faults ?? this.#faults;
    const signal = options?.signal;
    const tempPath = tempPathFor(path, this.#nonce());
    const backupPath = backupPathFor(path);
    const backupTempPath = tempPathFor(backupPath, this.#nonce());
    let handle: FileHandle | undefined;
    try {
      throwPhaseFault(faults, "create-temp", path);
      throwIfAborted(signal, path);
      // Exclusive creation: a stale temp with a colliding name must not be
      // overwritten; the nonce makes collisions practically impossible.
      handle = await open(tempPath, "wx");

      throwPhaseFault(faults, "write-temp", path);
      throwIfAborted(signal, path);
      await writeChunked(handle, bytes, this.#writeChunkBytes, signal, path);

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
        throwPhaseFault(faults, "backup", path);
        throwIfAborted(signal, path);
        await copyFile(path, backupTempPath);
        throwIfAborted(signal, path);
        await rename(backupTempPath, backupPath);
        backupCreated = true;
      }

      throwPhaseFault(faults, "replace", path);
      throwIfAborted(signal, path);
      await rename(tempPath, path);

      // Best-effort parent directory sync: a failure never fails the save.
      let directorySyncSucceeded = true;
      try {
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
