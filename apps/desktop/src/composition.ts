import * as THREE from "three";
import type { ProjectStoragePort } from "@voxel-maker/storage";
import {
  createDocumentSession,
  type DocumentSession,
} from "@voxel-maker/session";
import {
  createEditorStore,
  firstMaterialId,
  type EditorStore,
} from "@voxel-maker/editor";
import { createDraftOverlay, type DraftOverlay } from "./viewport/draft.js";
import {
  registerBatchCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
} from "@voxel-maker/commands";
import { createSceneAdapter, type SceneAdapter } from "@voxel-maker/renderer";
import { createFileService, type FileService } from "./file-service.js";
import {
  createViewportController,
  type ViewportController,
} from "./viewport/controller.js";

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
  /** Camera, picking, and overlay controller for the viewport (tickets #16/#17). */
  readonly viewport: ViewportController;
  /** Transient pencil/erase stroke preview projection (ticket #17). */
  readonly draftOverlay: DraftOverlay;
  readonly fileService: FileService;
  dispose(): void;
}

export interface CompositionOptions {
  readonly storage: ProjectStoragePort;
  readonly picker: FilePicker;
  /**
   * Per-stroke voxel budget for the pencil/erase tools. Defaults to
   * ADR-0009 `MAX_VOXELS_PER_OPERATION`; callers may lower (never raise)
   * the limit, matching the ADR-0009 escalation policy. Tests use small
   * budgets to exercise the limit seam through the real composition.
   */
  readonly strokeVoxelLimit?: number;
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
  const viewport = createViewportController({
    session,
    editor,
    scene,
    ...(options.strokeVoxelLimit === undefined
      ? {}
      : { strokeVoxelLimit: options.strokeVoxelLimit }),
  });
  const draftOverlay = createDraftOverlay({
    scene,
    editor,
    getStore: () => session.current?.store,
    objectForNode: (nodeId) => adapter.objectForNode(nodeId),
  });
  const fileService = createFileService({
    session,
    storage: options.storage,
    picker: options.picker,
  });

  // Lifecycle rebinding: opening, replacing, and closing a document fully
  // dispose and rebind scene resources through lifecycle events (plan S6.3).
  // Lifecycle rebinding (plan S6.3/S5.15): opening, replacing, and closing
  // a document fully dispose and rebind scene resources and reset runtime
  // editor state (selection/notices/active material/draft) through
  // lifecycle events. The active paint material defaults to the lowest
  // material id of the freshly opened document so the pencil works without
  // a materials panel (ticket #21).
  let unsubscribeStore: (() => void) | undefined;
  session.subscribe((event) => {
    editor.setSelection([]);
    editor.clearNotices();
    editor.setDraft(undefined);
    unsubscribeStore?.();
    unsubscribeStore = undefined;
    if (
      event.kind === "document-opened" ||
      event.kind === "document-replaced"
    ) {
      adapter.rebind(event.store);
      if (editor.activeMaterial === undefined) {
        editor.setActiveMaterial(firstMaterialId(event.store.getDocument()));
      }
      unsubscribeStore = event.store.subscribe(() => {
        const active = editor.activeMaterial;
        if (
          active !== undefined &&
          event.store.getDocument().materials[active] === undefined
        ) {
          // Prune a deleted active material (S7.5 failure policy): the
          // pencil then refuses strokes until a valid material is active.
          editor.setActiveMaterial(undefined);
          editor.pushNotice("warning", "The active material was deleted");
        }
      });
    } else {
      // The lifecycle union has exactly three kinds; the remaining kind is
      // document-closed.
      adapter.clear();
      editor.setActiveMaterial(undefined);
    }
  });

  return {
    session,
    editor,
    renderer: { scene, adapter },
    viewport,
    draftOverlay,
    fileService,
    dispose() {
      viewport.dispose();
      draftOverlay.dispose();
      adapter.dispose();
      session.dispose();
    },
  };
}
