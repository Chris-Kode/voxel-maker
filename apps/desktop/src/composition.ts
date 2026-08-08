import * as THREE from "three";
import type { ProjectStoragePort } from "@voxel-maker/storage";
import {
  createDocumentSession,
  type DocumentSession,
} from "@voxel-maker/session";
import { createEditorStore, type EditorStore } from "@voxel-maker/editor";
import {
  registerBatchCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
} from "@voxel-maker/commands";
import { createSceneAdapter, type SceneAdapter } from "@voxel-maker/renderer";
import { createFileService, type FileService } from "./file-service.js";

/**
 * Desktop application composition root (plan S6.2, ticket #15): the single
 * place that constructs concrete adapters and injects document, lifecycle,
 * storage, editor, renderer, and future agent services. There is no global
 * mutable engine singleton — the composition object is created per window
 * and `dispose()` releases everything.
 *
 * The renderer projection is rebound through lifecycle events: the adapter
 * subscribes to the session and fully disposes/rebinds on open, replace,
 * and close. Storage and file picking are injected so tests and the plain
 * browser dev build use different adapters without touching this root.
 */

/** Pickers return undefined when the user cancels. */
export interface FilePicker {
  pickOpenPath(): Promise<string | undefined>;
  pickSavePath(suggestedName: string): Promise<string | undefined>;
}

export interface RendererService {
  readonly scene: THREE.Scene;
  readonly adapter: SceneAdapter;
}

export interface DesktopComposition {
  readonly session: DocumentSession;
  readonly editor: EditorStore;
  readonly renderer: RendererService;
  readonly fileService: FileService;
  dispose(): void;
}

export interface CompositionOptions {
  readonly storage: ProjectStoragePort;
  readonly picker: FilePicker;
}

export function createDesktopComposition(
  options: CompositionOptions,
): DesktopComposition {
  const scene = new THREE.Scene();
  const adapter = createSceneAdapter({ scene });
  const session = createDocumentSession({
    registerCommands: [
      registerVoxelCommands,
      registerBatchCommands,
      registerRegionCommands,
      registerNodeCommands,
      registerMaterialCommands,
    ],
  });
  const editor = createEditorStore();
  const fileService = createFileService({
    session,
    storage: options.storage,
    picker: options.picker,
  });

  // Lifecycle rebinding: opening, replacing, and closing a document fully
  // dispose and rebind scene resources through lifecycle events (plan S6.3).
  // Lifecycle rebinding (plan S6.3/S5.15): opening, replacing, and closing
  // a document fully dispose and rebind scene resources and reset runtime
  // editor state (selection/notices) through lifecycle events.
  session.subscribe((event) => {
    editor.setSelection([]);
    editor.clearNotices();
    if (
      event.kind === "document-opened" ||
      event.kind === "document-replaced"
    ) {
      adapter.rebind(event.store);
    } else {
      // The lifecycle union has exactly three kinds; the remaining kind is
      // document-closed.
      adapter.clear();
    }
  });

  return {
    session,
    editor,
    renderer: { scene, adapter },
    fileService,
    dispose() {
      adapter.dispose();
      session.dispose();
    },
  };
}
