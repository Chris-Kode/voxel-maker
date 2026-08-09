import type { AtomicWriteResult } from "./port.js";

/**
 * Scoped image write port (plan S8.5/S15.2, ticket #25): the seam behind
 * preview-image exports. Like `ProjectStoragePort` it is the adapter
 * boundary — packages never touch filesystem APIs — but it is deliberately
 * narrower and regeneration-friendly: atomic temp-write + rename with NO
 * `.bak` backup (unlike project saves), because a preview image is always
 * reproducible from the document and must never create sibling clutter.
 * The desktop shell implements it over Tauri commands; the browser build
 * and tests use the in-memory adapter below.
 */

export interface ImageStoragePort {
  /**
   * Atomically replaces the image at `path` (same-directory temporary
   * file, flush, rename). A failure leaves any previous destination
   * untouched. Backups are intentionally NOT created.
   */
  writeImageAtomic(path: string, bytes: Uint8Array): Promise<AtomicWriteResult>;
  /** True when a file already exists at `path` (overwrite confirmation). */
  exists(path: string): Promise<boolean>;
}

/** In-memory image storage for tests and the plain browser build. */
export class MemoryImageStorage implements ImageStoragePort {
  readonly #files = new Map<string, Uint8Array>();

  /** Copies of every stored path (tests and diagnostics). */
  files(): ReadonlyMap<string, Uint8Array> {
    return new Map(
      [...this.#files.entries()].map(([path, bytes]) => [
        path,
        Uint8Array.from(bytes),
      ]),
    );
  }

  writeImageAtomic(
    path: string,
    bytes: Uint8Array,
  ): Promise<AtomicWriteResult> {
    this.#files.set(path, Uint8Array.from(bytes));
    return Promise.resolve({
      tempPath: path,
      backupCreated: false,
      directorySyncSucceeded: true,
    });
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.#files.has(path));
  }
}
