import { invoke } from "@tauri-apps/api/core";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import type {
  AtomicWriteResult,
  ImageStoragePort,
  ProjectStoragePort,
  RecoveryJournalPort,
} from "@voxel-maker/storage";
import type { FilePicker } from "../composition.js";
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
 * Tauri storage adapter (plan S6.18 seam, tickets #15/#22): reads, atomic
 * writes, existence checks, removal, backup reads, and the adjacent
 * recovery journal through the shell's own allowlisted commands
 * (`src-tauri`). The Rust side validates paths and performs the same
 * temp-write/backup/rename order as the Node adapter; cancellation and
 * fault injection arrive with the project lifecycle ticket (#22), so
 * `signal`/`faults` are ignored here.
 */
export class TauriProjectStorage
  implements ProjectStoragePort, RecoveryJournalPort
{
  async readProject(path: string): Promise<Uint8Array> {
    const bytes = await invoke<ArrayBuffer>("read_project_bytes", { path });
    return new Uint8Array(bytes);
  }

  async writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
  ): Promise<AtomicWriteResult> {
    return await invoke<AtomicWriteResult>("write_project_bytes_atomic", {
      path,
      bytes,
    });
  }

  async exists(path: string): Promise<boolean> {
    return await invoke<boolean>("project_exists", { path });
  }

  async remove(path: string): Promise<void> {
    await invoke("remove_project", { path });
  }

  async readBackup(path: string): Promise<Uint8Array | undefined> {
    const bytes = await invoke<ArrayBuffer | null>("read_backup_bytes", {
      path,
    });
    return bytes === null ? undefined : new Uint8Array(bytes);
  }

  async readJournal(path: string): Promise<Uint8Array | undefined> {
    const bytes = await invoke<ArrayBuffer | null>("read_journal_bytes", {
      path,
    });
    return bytes === null ? undefined : new Uint8Array(bytes);
  }

  async appendJournal(path: string, bytes: Uint8Array): Promise<void> {
    await invoke("append_journal_bytes", { path, bytes });
  }

  async replaceJournal(path: string, bytes: Uint8Array): Promise<void> {
    await invoke("replace_journal_bytes", { path, bytes });
  }

  async removeJournal(path: string): Promise<void> {
    await invoke("remove_journal", { path });
  }
}

/**
 * Tauri recent-project store: a bounded JSON file in the app config
 * directory through the shell's own commands (scoped native storage). The
 * Rust side validates the JSON shape and enforces the same bound.
 */
export class TauriRecentProjects implements RecentProjectsPort {
  async list(): Promise<readonly RecentProjectEntry[]> {
    const raw = await invoke<string | null>("read_recent_projects");
    return raw === null ? [] : parseRecentJson(raw);
  }

  async record(entry: RecentProjectEntry): Promise<void> {
    const entries = await this.list();
    const rest = entries.filter((existing) => existing.path !== entry.path);
    const next = [entry, ...rest].slice(0, MAX_RECENT);
    await invoke("write_recent_projects", {
      json: JSON.stringify(next),
    });
  }

  async remove(path: string): Promise<void> {
    const entries = await this.list();
    const next = entries.filter((existing) => existing.path !== path);
    await invoke("write_recent_projects", {
      json: JSON.stringify(next),
    });
  }
}

/** Parses the stored JSON; malformed content yields an empty list. */
function parseRecentJson(raw: string): readonly RecentProjectEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseRecentRecord)
      .filter((entry): entry is RecentProjectEntry => entry !== undefined);
  } catch {
    return [];
  }
}

/**
 * Tauri preview-image storage (plan S8.5/S15.2, ticket #25): scoped
 * atomic image writes (temp + flush + rename, no backup) and existence
 * checks through the shell's own allowlisted commands (`src-tauri`).
 */
export class TauriImageStorage implements ImageStoragePort {
  async writeImageAtomic(
    path: string,
    bytes: Uint8Array,
  ): Promise<AtomicWriteResult> {
    return await invoke<AtomicWriteResult>("write_image_bytes_atomic", {
      path,
      bytes,
    });
  }

  async exists(path: string): Promise<boolean> {
    return await invoke<boolean>("image_exists", { path });
  }
}

/** Native open/save dialogs via the allowlisted dialog plugin. */
export class TauriFilePicker implements FilePicker {
  async pickOpenPath(): Promise<string | undefined> {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Voxel Maker project", extensions: ["vxl"] }],
    });
    return typeof selected === "string" ? selected : undefined;
  }

  async pickSavePath(suggestedName: string): Promise<string | undefined> {
    const selected = await saveDialog({
      defaultPath: suggestedName,
      filters: [{ name: "Voxel Maker project", extensions: ["vxl"] }],
    });
    return typeof selected === "string" ? selected : undefined;
  }

  async pickSaveImagePath(suggestedName: string): Promise<string | undefined> {
    // Preview exports use a PNG filter; the caller derives the four
    // standard-view names from the chosen base path (ticket #25).
    const selected = await saveDialog({
      defaultPath: suggestedName,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    return typeof selected === "string" ? selected : undefined;
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
