/**
 * Platform adapter selection (plan S6.1): the Tauri shell in packaged and
 * `tauri dev` builds, the in-memory browser adapter for plain vite dev.
 */
import {
  BrowserFilePicker,
  BrowserImageStorage,
  BrowserProjectStorage,
} from "./browser.js";
import { isTauriRuntime } from "./detect.js";
import {
  TauriCredentialStore,
  TauriFilePicker,
  TauriImageStorage,
  TauriProjectStorage,
  TauriRecentProjects,
} from "./tauri.js";
import type { FilePicker } from "../composition.js";
import type {
  ImageStoragePort,
  ProjectStoragePort,
  RecoveryJournalPort,
} from "@voxel-maker/storage";
import type { CredentialStore } from "@voxel-maker/agent";
import { MemoryCredentialStore } from "@voxel-maker/agent";
import { createBrowserRecentProjects } from "../recent-projects.js";
import type { RecentProjectsPort } from "../recent-projects.js";

export interface PlatformServices {
  /** Project + adjacent recovery journal (scoped native storage, S6.18). */
  readonly storage: ProjectStoragePort & RecoveryJournalPort;
  /** Scoped atomic preview-image writes (ticket #25). */
  readonly imageStorage: ImageStoragePort;
  readonly picker: FilePicker;
  /** Bounded recent-project list (scoped native storage). */
  readonly recent: RecentProjectsPort;
  /**
   * Provider credential store (plan S12.4, ADR-0010, ticket #34): the OS
   * keychain in the Tauri shell; a per-window memory store in the plain
   * browser dev shell (keys are never persisted there).
   */
  readonly credentials: CredentialStore;
}

export function createDefaultPlatform(): PlatformServices {
  if (isTauriRuntime()) {
    return {
      storage: new TauriProjectStorage(),
      imageStorage: new TauriImageStorage(),
      picker: new TauriFilePicker(),
      recent: new TauriRecentProjects(),
      credentials: new TauriCredentialStore(),
    };
  }
  const storage = new BrowserProjectStorage();
  return {
    storage,
    imageStorage: new BrowserImageStorage(),
    picker: new BrowserFilePicker(storage),
    recent: createBrowserRecentProjects(),
    // The browser dev shell never persists keys: re-entering the key
    // after a reload is the safe default (ADR-0010 keeps keys out of
    // localStorage and other web storage).
    credentials: new MemoryCredentialStore(),
  };
}
