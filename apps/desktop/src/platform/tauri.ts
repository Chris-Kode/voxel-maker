import { invoke } from "@tauri-apps/api/core";
import type {
  AtomicWriteResult,
  ImageStoragePort,
  ProjectStoragePort,
  RecoveryJournalPort,
} from "@voxel-maker/storage";
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
 * Tauri storage adapter (plan S6.18 seam, tickets #15/#22, issue #94):
 * reads, atomic writes, existence checks, removal, backup reads, and the
 * adjacent recovery journal through the shell's own allowlisted commands
 * (`src-tauri`).
 *
 * The `path` argument is an OPAGUE HANDLE TOKEN, never a filesystem path:
 * the native open/save dialogs run in Rust and mint one scoped handle per
 * chosen file; every command below passes the token straight to the shell
 * and the Rust side resolves it to the canonical dialog-scoped path. The
 * webview therefore cannot address any file the user never picked. The
 * Rust side performs the same temp-write/backup/rename order as the Node
 * adapter; `signal`/`faults` are ignored here (documented limitation).
 */
export class TauriProjectStorage
  implements ProjectStoragePort, RecoveryJournalPort
{
  async readProject(handle: string): Promise<Uint8Array> {
    const bytes = await invoke<ArrayBuffer>("read_project_bytes", { handle });
    return new Uint8Array(bytes);
  }

  async writeProjectAtomic(
    handle: string,
    bytes: Uint8Array,
  ): Promise<AtomicWriteResult> {
    return await invoke<AtomicWriteResult>("write_project_bytes_atomic", {
      handle,
      bytes,
    });
  }

  async exists(handle: string): Promise<boolean> {
    return await invoke<boolean>("project_exists", { handle });
  }

  async remove(handle: string): Promise<void> {
    await invoke("remove_project", { handle });
  }

  async readBackup(handle: string): Promise<Uint8Array | undefined> {
    const bytes = await invoke<ArrayBuffer | null>("read_backup_bytes", {
      handle,
    });
    return bytes === null ? undefined : new Uint8Array(bytes);
  }

  async readJournal(handle: string): Promise<Uint8Array | undefined> {
    const bytes = await invoke<ArrayBuffer | null>("read_journal_bytes", {
      handle,
    });
    return bytes === null ? undefined : new Uint8Array(bytes);
  }

  async appendJournal(handle: string, bytes: Uint8Array): Promise<void> {
    await invoke("append_journal_bytes", { handle, bytes });
  }

  async replaceJournal(handle: string, bytes: Uint8Array): Promise<void> {
    await invoke("replace_journal_bytes", { handle, bytes });
  }

  async removeJournal(handle: string): Promise<void> {
    await invoke("remove_journal", { handle });
  }
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
