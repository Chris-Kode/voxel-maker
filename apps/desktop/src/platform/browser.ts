import {
  MemoryImageStorage,
  type AtomicWriteResult,
  type ImageStoragePort,
  type ProjectStoragePort,
  type RecoveryJournalPort,
} from "@voxel-maker/storage";
import { journalPathFor } from "@voxel-maker/storage";
import type { FilePicker, PickedPath } from "../composition.js";

/**
 * Browser-only storage adapter for plain `vite dev` without the Tauri
 * shell: files live in an in-memory map, opening uses a hidden file input,
 * and saving downloads the bytes. It exists so the UI and composition root
 * are testable in a browser without native capabilities; the Tauri adapter
 * is the product path.
 */
export class BrowserProjectStorage
  implements ProjectStoragePort, RecoveryJournalPort
{
  readonly #files = new Map<string, Uint8Array>();

  ingest(name: string, bytes: Uint8Array): void {
    this.#files.set(name, Uint8Array.from(bytes));
  }

  readProject(path: string): Promise<Uint8Array> {
    const bytes = this.#files.get(path);
    if (bytes === undefined) {
      return Promise.reject(
        new Error(`Project file "${path}" was not ingested`),
      );
    }
    return Promise.resolve(Uint8Array.from(bytes));
  }

  writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
  ): Promise<AtomicWriteResult> {
    this.#files.set(path, Uint8Array.from(bytes));
    downloadBytes(path, bytes);
    return Promise.resolve({
      tempPath: path,
      backupCreated: false,
      directorySyncSucceeded: true,
    });
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.#files.has(path));
  }

  remove(path: string): Promise<void> {
    this.#files.delete(path);
    return Promise.resolve();
  }

  readBackup(path: string): Promise<Uint8Array | undefined> {
    const bytes = this.#files.get(`${path}.bak`);
    return Promise.resolve(
      bytes === undefined ? undefined : Uint8Array.from(bytes),
    );
  }

  readJournal(path: string): Promise<Uint8Array | undefined> {
    const bytes = this.#files.get(journalPathFor(path));
    return Promise.resolve(
      bytes === undefined ? undefined : Uint8Array.from(bytes),
    );
  }

  appendJournal(path: string, bytes: Uint8Array): Promise<void> {
    const journalPath = journalPathFor(path);
    const previous = this.#files.get(journalPath);
    const next = new Uint8Array((previous?.byteLength ?? 0) + bytes.byteLength);
    if (previous !== undefined) next.set(previous, 0);
    next.set(bytes, previous?.byteLength ?? 0);
    this.#files.set(journalPath, next);
    return Promise.resolve();
  }

  replaceJournal(path: string, bytes: Uint8Array): Promise<void> {
    this.#files.set(journalPathFor(path), Uint8Array.from(bytes));
    return Promise.resolve();
  }

  removeJournal(path: string): Promise<void> {
    this.#files.delete(journalPathFor(path));
    return Promise.resolve();
  }
}

/**
 * Browser preview-image storage: the shared in-memory adapter plus a
 * download fallback (the plain-browser dev build has no native surface).
 */
export class BrowserImageStorage implements ImageStoragePort {
  readonly #inner = new MemoryImageStorage();

  writeImageAtomic(
    path: string,
    bytes: Uint8Array,
  ): Promise<AtomicWriteResult> {
    downloadBytes(path, bytes);
    return this.#inner.writeImageAtomic(path, bytes);
  }

  exists(path: string): Promise<boolean> {
    return this.#inner.exists(path);
  }

  /** Copies of every stored path (tests and diagnostics). */
  files(): ReadonlyMap<string, Uint8Array> {
    return this.#inner.files();
  }
}

/** File-input picker that ingests the selected file before returning its name. */
export class BrowserFilePicker implements FilePicker {
  readonly #storage: BrowserProjectStorage;

  constructor(storage: BrowserProjectStorage) {
    this.#storage = storage;
  }

  async pickOpenPath(): Promise<PickedPath | undefined> {
    const file = await pickFile();
    if (file === undefined) return undefined;
    this.#storage.ingest(file.name, new Uint8Array(await file.arrayBuffer()));
    // Plain-browser shell: the token IS the plain path (there is no
    // native handle layer).
    return { token: file.name, path: file.name };
  }

  pickSavePath(suggestedName: string): Promise<PickedPath | undefined> {
    return Promise.resolve({ token: suggestedName, path: suggestedName });
  }
  // No `pickSaveImagePaths`: the plain-browser shell has no native handle
  // layer, so the preview-export service falls back to one save pick and
  // derives the four standard-view names itself (preview-export.ts).
}

function pickFile(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".vxl";
    input.style.display = "none";
    input.addEventListener(
      "change",
      () => {
        resolve(input.files?.[0]);
        input.remove();
      },
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

function downloadBytes(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as BlobPart], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
