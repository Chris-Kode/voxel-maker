import { invoke } from "@tauri-apps/api/core";
import {
  IO_ERROR_CODES,
  storageIoError,
  throwIfAborted,
  type AtomicWriteFaultPlan,
  type AtomicWriteOptions,
  type AtomicWritePhase,
  type AtomicWriteResult,
  type ImageStoragePort,
  type ProjectStoragePort,
  type RecoveryJournalPort,
} from "@voxel-maker/storage";
import { INPUT_FILE_LIMIT_EXCEEDED, WorkspaceError } from "@voxel-maker/shared";
import type { FilePicker, PickedPath } from "../composition.js";
import {
  KEYCHAIN_SERVICE,
  Secret,
  type CredentialReference,
  type CredentialStore,
} from "@voxel-maker/agent";
import {
  parseRecentRecord,
  type RecentProjectEntry,
  type RecentProjectsPort,
} from "../recent-projects.js";

/** Bounded recent list size the Rust side enforces as well. */
const MAX_RECENT = 10;

/**
 * Tauri storage adapter (plan S6.18 seam, tickets #15/#22, issues #94 and
 * #120): reads, atomic writes, existence checks, removal, backup reads, and
 * the adjacent recovery journal through the shell's own allowlisted
 * commands (`src-tauri`).
 *
 * The `path` argument is an OPAGUE HANDLE TOKEN, never a filesystem path:
 * the native open/save dialogs run in Rust and mint one scoped handle per
 * chosen file; every command below passes the token straight to the shell
 * and the Rust side resolves it to the canonical dialog-scoped path. The
 * webview therefore cannot address any file the user never picked. The
 * Rust side implements the frozen atomic-save phases of
 * `docs/storage/atomic-save-v1.md` (exclusive nonce temp, chunked
 * cancellable write, fsync, atomic backup refresh, replace, cleanup), so
 * `signal` is honored through a Rust-side cancellation token and `faults`
 * forwards the canonical `true` per-phase faults for native conformance.
 * Native `CODE: message` errors are mapped back to the shared io-family
 * contract; custom `WorkspaceError` faults cannot cross IPC (they are a
 * memory/Node-only seam).
 */
export class TauriProjectStorage
  implements ProjectStoragePort, RecoveryJournalPort
{
  async readProject(handle: string): Promise<Uint8Array> {
    try {
      const bytes = await invoke<ArrayBuffer>("read_project_bytes", {
        handle,
      });
      return new Uint8Array(bytes);
    } catch (error) {
      throw mapTauriStorageError(error, handle);
    }
  }

  async writeProjectAtomic(
    handle: string,
    bytes: Uint8Array,
    options?: AtomicWriteOptions,
  ): Promise<AtomicWriteResult> {
    const signal = options?.signal;
    // The native write loop observes the signal between chunks and before
    // each phase through a Rust-side cancellation flag (issue #120); an
    // abort already observed here rejects before the IPC call.
    throwIfAborted(signal, handle);
    const cancelToken = signal === undefined ? undefined : nextCancelToken();
    const onAbort = () => {
      if (cancelToken !== undefined) {
        // Best-effort delivery: the write may already have finished (or
        // replaced the destination), which is a normal completion.
        void Promise.resolve(
          invoke("cancel_project_write", { token: cancelToken }),
        ).catch(() => undefined);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const faultPhases = canonicalFaultPhases(options?.faults);
    try {
      return await invoke<AtomicWriteResult>("write_project_bytes_atomic", {
        handle,
        bytes,
        ...(cancelToken === undefined ? {} : { cancelToken }),
        ...(faultPhases === undefined
          ? {}
          : { faults: { failAt: faultPhases } }),
      });
    } catch (error) {
      throw mapTauriStorageError(error, handle);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async exists(handle: string): Promise<boolean> {
    try {
      return await invoke<boolean>("project_exists", { handle });
    } catch (error) {
      throw mapTauriStorageError(error, handle);
    }
  }

  async remove(handle: string): Promise<void> {
    try {
      await invoke("remove_project", { handle });
    } catch (error) {
      throw mapTauriStorageError(error, handle);
    }
  }

  async readBackup(handle: string): Promise<Uint8Array | undefined> {
    try {
      const bytes = await invoke<ArrayBuffer | null>("read_backup_bytes", {
        handle,
      });
      return bytes === null ? undefined : new Uint8Array(bytes);
    } catch (error) {
      throw mapTauriStorageError(error, handle);
    }
  }

  async readJournal(handle: string): Promise<Uint8Array | undefined> {
    try {
      const bytes = await invoke<ArrayBuffer | null>("read_journal_bytes", {
        handle,
      });
      return bytes === null ? undefined : new Uint8Array(bytes);
    } catch (error) {
      throw mapTauriStorageError(error, handle);
    }
  }

  async appendJournal(handle: string, bytes: Uint8Array): Promise<void> {
    try {
      await invoke("append_journal_bytes", { handle, bytes });
    } catch (error) {
      throw mapTauriStorageError(error, handle);
    }
  }

  async replaceJournal(handle: string, bytes: Uint8Array): Promise<void> {
    try {
      await invoke("replace_journal_bytes", { handle, bytes });
    } catch (error) {
      throw mapTauriStorageError(error, handle);
    }
  }

  async removeJournal(handle: string): Promise<void> {
    try {
      await invoke("remove_journal", { handle });
    } catch (error) {
      throw mapTauriStorageError(error, handle);
    }
  }
}

/** Monotonic suffix keeps write tokens unique within one webview session. */
let cancelTokenSequence = 0;

/** Builds an opaque cancellation token for one native write (issue #120). */
function nextCancelToken(): string {
  cancelTokenSequence += 1;
  return `write-${Date.now().toString(36)}-${cancelTokenSequence.toString(36)}`;
}

/** The atomic write phases in contract order (mirror of the Rust enum). */
const ATOMIC_WRITE_PHASES: readonly AtomicWritePhase[] = [
  "create-temp",
  "write-temp",
  "flush-temp",
  "backup",
  "replace",
  "sync-directory",
];

/**
 * The canonical per-phase faults a Tauri write can carry over IPC: only
 * `true` (adapter-canonical error) faults are representable; custom
 * `WorkspaceError` faults stay a memory/Node-only seam.
 */
function canonicalFaultPhases(
  faults: AtomicWriteFaultPlan | undefined,
): readonly AtomicWritePhase[] | undefined {
  if (faults === undefined) return undefined;
  const phases = ATOMIC_WRITE_PHASES.filter(
    (phase) => faults.failAt?.[phase] === true,
  );
  return phases.length === 0 ? undefined : phases;
}

const IO_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  Object.values(IO_ERROR_CODES),
);

/**
 * Maps the native `CODE: message` error strings back to the shared storage
 * error contract (issue #120). Unknown strings pass through unchanged
 * (scope rejections such as "unrecognized handle token" are not io-family
 * errors).
 */
function mapTauriStorageError(error: unknown, path: string): unknown {
  if (typeof error !== "string") return error;
  const separator = error.indexOf(":");
  if (separator < 0) return error;
  const code = error.slice(0, separator);
  const message = error.slice(separator + 1).trim();
  if (code === INPUT_FILE_LIMIT_EXCEEDED) {
    return new WorkspaceError({ family: "limit", code, message });
  }
  if (IO_ERROR_CODE_SET.has(code)) {
    return storageIoError(code, message, { path });
  }
  return error;
}

/**
 * Tauri recent-project store: a bounded JSON file in the app config
 * directory through the shell's own commands (issue #94). The store is
 * Rust-owned: `record` sends ONLY the opaque handle token (plus display
 * metadata) and the Rust side resolves the token to the canonical path,
 * so a compromised webview can never persist a path of its choosing;
 * `read_recent_projects` returns the display path back for the shell
 * chrome. The Rust side validates the JSON shape and enforces the bound.
 */
export class TauriRecentProjects implements RecentProjectsPort {
  async list(): Promise<readonly RecentProjectEntry[]> {
    const entries = await invoke<readonly RecentProjectEntry[] | null>(
      "read_recent_projects",
    );
    return entries === null ? [] : parseRecentJson(entries);
  }

  async record(entry: RecentProjectEntry): Promise<void> {
    await invoke("record_recent_project", {
      handle: entry.token,
      title: entry.title,
      openedAt: entry.openedAt,
    });
  }

  async remove(token: string): Promise<void> {
    await invoke("remove_recent_project", { token });
  }
}

/** Validates the native list; malformed entries are dropped, never trusted. */
function parseRecentJson(
  entries: readonly RecentProjectEntry[],
): readonly RecentProjectEntry[] {
  return entries
    .map(parseRecentRecord)
    .filter((entry): entry is RecentProjectEntry => entry !== undefined)
    .slice(0, MAX_RECENT);
}

/**
 * Tauri preview-image storage (plan S8.5/S15.2, ticket #25, issue #94):
 * scoped atomic image writes (temp + flush + rename, no backup) and
 * existence checks through the shell's own allowlisted commands. The
 * `path` argument is an opaque image-scope handle token; the Rust side
 * resolves it to the canonical dialog-scoped PNG path.
 */
export class TauriImageStorage implements ImageStoragePort {
  async writeImageAtomic(
    handle: string,
    bytes: Uint8Array,
  ): Promise<AtomicWriteResult> {
    return await invoke<AtomicWriteResult>("write_image_bytes_atomic", {
      handle,
      bytes,
    });
  }

  async exists(handle: string): Promise<boolean> {
    return await invoke<boolean>("image_exists", { handle });
  }
}

/**
 * Native open/save dialogs (issue #94). The DIALOGS RUN IN RUST: each
 * pick mints opaque scoped handles and returns `{ token, path }` where
 * `path` is display-only — no native command ever accepts a raw path, so
 * the webview can only ever address files the user chose in a dialog.
 */
export class TauriFilePicker implements FilePicker {
  async pickOpenPath(): Promise<PickedPath | undefined> {
    return (await invoke<PickedPath | null>("pick_open_project")) ?? undefined;
  }

  async pickSavePath(suggestedName: string): Promise<PickedPath | undefined> {
    return (
      (await invoke<PickedPath | null>("pick_save_project", {
        suggestedName,
      })) ?? undefined
    );
  }

  async pickSaveImagePaths(
    suggestedName: string,
  ): Promise<readonly PickedPath[] | undefined> {
    return (
      (await invoke<readonly PickedPath[] | null>("pick_preview_image_paths", {
        suggestedName,
      })) ?? undefined
    );
  }
}

/**
 * OS-keychain credential store (plan S12.4, ADR-0010, ticket #34, issue
 * #95): maps the agent package's credential seam to the shell's
 * allowlisted keychain commands. Secrets travel only between the webview's
 * memory and the operating-system credential store; they are never written
 * to project files, journals, localStorage, logs, or diagnostics. The Rust
 * side pins the keychain service to `voxel-maker:provider` and allowlists
 * provider accounts, so the wire carries only the account (and value) —
 * the service argument of the `CredentialStore` seam is deliberately not
 * forwarded, because IPC must never address a keychain entry outside
 * Voxel Maker's service/provider scope.
 */
export class TauriCredentialStore implements CredentialStore {
  async save(service: string, account: string, value: Secret): Promise<void> {
    this.#assertScoped(service);
    await invoke("credential_save", {
      account,
      value: value.reveal(),
    });
  }

  async get(service: string, account: string): Promise<Secret | undefined> {
    this.#assertScoped(service);
    const raw = await invoke<string | null>("credential_get", { account });
    return raw === null ? undefined : new Secret(raw);
  }

  async delete(service: string, account: string): Promise<boolean> {
    this.#assertScoped(service);
    await invoke("credential_delete", { account });
    return true;
  }

  /**
   * The shell pins the keychain service, so a caller that names any other
   * service is a composition bug: fail loudly instead of silently writing
   * under the pinned service. The native allowlist is the real trust
   * boundary; this guard keeps the seam's two implementations honest.
   */
  #assertScoped(service: string): void {
    if (service !== KEYCHAIN_SERVICE) {
      throw new Error(
        `credential service is pinned to ${KEYCHAIN_SERVICE}; refusing ${service}`,
      );
    }
  }

  async list(): Promise<readonly CredentialReference[]> {
    // The v1 shell addresses credentials by fixed service + provider
    // account, so the list is derived from the one known account.
    return [
      {
        service: KEYCHAIN_SERVICE,
        account: "openai",
        present: (await this.get(KEYCHAIN_SERVICE, "openai")) !== undefined,
      },
    ];
  }
}
