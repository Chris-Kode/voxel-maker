import type {
  AtomicWriteResult,
  ProjectStoragePort,
} from "@voxel-maker/storage";
import type { FilePicker } from "../composition.js";

/**
 * Browser-only storage adapter for plain `vite dev` without the Tauri
 * shell: files live in an in-memory map, opening uses a hidden file input,
 * and saving downloads the bytes. It exists so the UI and composition root
 * are testable in a browser without native capabilities; the Tauri adapter
 * is the product path.
 */
export class BrowserProjectStorage implements ProjectStoragePort {
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
}

/** File-input picker that ingests the selected file before returning its name. */
export class BrowserFilePicker implements FilePicker {
  readonly #storage: BrowserProjectStorage;

  constructor(storage: BrowserProjectStorage) {
    this.#storage = storage;
  }

  async pickOpenPath(): Promise<string | undefined> {
    const file = await pickFile();
    if (file === undefined) return undefined;
    this.#storage.ingest(file.name, new Uint8Array(await file.arrayBuffer()));
    return file.name;
  }

  pickSavePath(suggestedName: string): Promise<string | undefined> {
    return Promise.resolve(suggestedName);
  }
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
