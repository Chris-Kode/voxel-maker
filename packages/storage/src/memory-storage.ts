import {
  backupPathFor,
  IO_ERROR_CODES,
  storageIoError,
  tempPathFor,
  throwIfAborted,
  throwPhaseFault,
  type AtomicWriteFaultPlan,
  type AtomicWriteOptions,
  type AtomicWriteResult,
  type ProjectStoragePort,
} from "./port.js";

/**
 * In-memory storage port (plan S5.6: "interfaces with memory adapter; no
 * Tauri dependency"). It implements the same phase order, fault contract,
 * and error codes as the Node filesystem adapter, so the shared conformance
 * matrix runs against both. Files and backups are immutable byte copies;
 * temporary paths are tracked and removed on every failure path.
 */
export class MemoryProjectStorage implements ProjectStoragePort {
  readonly #files = new Map<string, Uint8Array>();
  readonly #temporary = new Set<string>();
  readonly #faults: AtomicWriteFaultPlan;
  #nonce = 0;

  constructor(faults: AtomicWriteFaultPlan = {}) {
    this.#faults = faults;
  }

  /** Copy of every stored path (used by conformance and diagnostics). */
  files(): ReadonlyMap<string, Uint8Array> {
    return new Map(
      [...this.#files.entries()].map(([path, bytes]) => [
        path,
        Uint8Array.from(bytes),
      ]),
    );
  }

  /** Paths currently considered temporary (used by conformance). */
  temporaryPaths(): readonly string[] {
    return [...this.#temporary];
  }

  readProject(path: string): Promise<Uint8Array> {
    const bytes = this.#files.get(path);
    if (bytes === undefined) {
      return Promise.reject(
        storageIoError(
          IO_ERROR_CODES.notFound,
          "The project file does not exist",
          { path },
        ),
      );
    }
    return Promise.resolve(Uint8Array.from(bytes));
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.#files.has(path));
  }

  remove(path: string): Promise<void> {
    this.#files.delete(path);
    return Promise.resolve();
  }

  readBackup(path: string): Promise<Uint8Array | undefined> {
    const bytes = this.#files.get(backupPathFor(path));
    return Promise.resolve(
      bytes === undefined ? undefined : Uint8Array.from(bytes),
    );
  }

  writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
    options?: AtomicWriteOptions,
  ): Promise<AtomicWriteResult> {
    const tempPath = tempPathFor(path, String(this.#nonce));
    this.#nonce += 1;
    try {
      return Promise.resolve(
        this.#performAtomicWrite(path, bytes, tempPath, options),
      );
    } catch (error) {
      this.#temporary.delete(tempPath);
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  #performAtomicWrite(
    path: string,
    bytes: Uint8Array,
    tempPath: string,
    options: AtomicWriteOptions | undefined,
  ): AtomicWriteResult {
    const faults = options?.faults ?? this.#faults;
    const signal = options?.signal;

    throwPhaseFault(faults, "create-temp", path);
    throwIfAborted(signal, path);
    this.#temporary.add(tempPath);

    throwPhaseFault(faults, "write-temp", path);
    throwIfAborted(signal, path);
    const next = Uint8Array.from(bytes);
    this.#temporary.delete(tempPath);

    throwPhaseFault(faults, "flush-temp", path);
    throwIfAborted(signal, path);

    const previous = this.#files.get(path);
    let backupCreated = false;
    if (previous !== undefined) {
      throwPhaseFault(faults, "backup", path);
      throwIfAborted(signal, path);
      this.#files.set(backupPathFor(path), Uint8Array.from(previous));
      backupCreated = true;
    }

    throwPhaseFault(faults, "replace", path);
    throwIfAborted(signal, path);
    this.#files.set(path, next);

    // Best-effort parent directory sync never fails the save.
    let directorySyncSucceeded = true;
    try {
      throwPhaseFault(faults, "sync-directory", path);
    } catch {
      directorySyncSucceeded = false;
    }

    return {
      tempPath,
      backupCreated,
      ...(backupCreated ? { backupPath: backupPathFor(path) } : {}),
      directorySyncSucceeded,
    };
  }
}
