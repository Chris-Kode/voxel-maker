import { invoke } from "@tauri-apps/api/core";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import type {
  AtomicWriteResult,
  ProjectStoragePort,
} from "@voxel-maker/storage";
import type { FilePicker } from "../composition.js";

/**
 * Tauri storage adapter (plan S6.18 seam, minimal for ticket #15): reads,
 * atomic writes, existence checks, removal, and backup reads through the
 * shell's own allowlisted commands (`src-tauri`). The Rust side validates
 * paths and performs the same temp-write/backup/rename order as the Node
 * adapter; cancellation and fault injection arrive with the project
 * lifecycle ticket (#22), so `signal`/`faults` are ignored here.
 */
export class TauriProjectStorage implements ProjectStoragePort {
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
}
