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
}

export function createDefaultPlatform(): PlatformServices {
  if (isTauriRuntime()) {
    return {
      storage: new TauriProjectStorage(),
      imageStorage: new TauriImageStorage(),
      picker: new TauriFilePicker(),
      recent: new TauriRecentProjects(),
    };
  }
  const storage = new BrowserProjectStorage();
  return {
    storage,
    imageStorage: new BrowserImageStorage(),
    picker: new BrowserFilePicker(storage),
    recent: createBrowserRecentProjects(),
  };
}
