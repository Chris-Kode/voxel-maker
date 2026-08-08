/**
 * Platform adapter selection (plan S6.1): the Tauri shell in packaged and
 * `tauri dev` builds, the in-memory browser adapter for plain vite dev.
 */
import { BrowserFilePicker, BrowserProjectStorage } from "./browser.js";
import { isTauriRuntime } from "./detect.js";
import { TauriFilePicker, TauriProjectStorage } from "./tauri.js";
import type { FilePicker } from "../composition.js";
import type { ProjectStoragePort } from "@voxel-maker/storage";

export interface PlatformServices {
  readonly storage: ProjectStoragePort;
  readonly picker: FilePicker;
}

export function createDefaultPlatform(): PlatformServices {
  if (isTauriRuntime()) {
    return {
      storage: new TauriProjectStorage(),
      picker: new TauriFilePicker(),
    };
  }
  const storage = new BrowserProjectStorage();
  return { storage, picker: new BrowserFilePicker(storage) };
}
