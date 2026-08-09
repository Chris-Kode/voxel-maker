import * as THREE from "three";
import type {
  ProjectStoragePort,
  RecoveryJournalPort,
} from "@voxel-maker/storage";
import {
  createDocumentSession,
  type DocumentSession,
} from "@voxel-maker/session";
import type { CommittedTransactionRecord } from "@voxel-maker/commands";
import {
  createEditorStore,
  firstMaterialId,
  type EditorStore,
} from "@voxel-maker/editor";
import { createDraftOverlay, type DraftOverlay } from "./viewport/draft.js";
import {
  registerArticulationCommands,
  registerBatchCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
} from "@voxel-maker/commands";
import {
  createSceneAdapter,
  type MeshingWorkerLike,
  type RendererDiagnostics,
  type SceneAdapter,
} from "@voxel-maker/renderer";
import { createFileService, type FileService } from "./file-service.js";
import { createDefaultPrompts, type PromptService } from "./prompts.js";
import {
  createMemoryRecentProjects,
  type RecentProjectsPort,
} from "./recent-projects.js";
import {
  createViewportController,
  type ViewportController,
} from "./viewport/controller.js";
import {
  createMaterialPanelController,
  type MaterialPanelController,
} from "./materials/material-panel-controller.js";

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
  /**
   * Per-frame meshing step (plan S6.8, ticket #23): dispatches and
   * installs chunk meshes within the frame budgets, visible chunks
   * first. The render loop calls this once per frame with the camera.
   */
  flush(camera: THREE.Camera): void;
  /** Live renderer diagnostics for the dev overlay (plan S6.14). */
  diagnostics(): RendererDiagnostics;
}

export interface DesktopComposition {
  readonly session: DocumentSession;
  readonly editor: EditorStore;
  readonly renderer: RendererService;
  /** Camera, picking, and overlay controller for the viewport (tickets #16/#17). */
  readonly viewport: ViewportController;
  /** Transient pencil/erase stroke preview projection (ticket #17). */
  readonly draftOverlay: DraftOverlay;
  /** Materials panel controller (plan S7.13, ticket #21). */
  readonly materialPanel: MaterialPanelController;
  readonly fileService: FileService;
  dispose(): void;
}

export interface CompositionOptions {
  readonly storage: ProjectStoragePort & RecoveryJournalPort;
  readonly picker: FilePicker;
  /**
   * User confirmations for dirty-close, overwrite, and recovery choices.
   * Defaults to native `window.confirm` prompts; tests inject scripted
   * responders.
   */
  readonly prompts?: PromptService;
  /**
   * Bounded recent-project list. Defaults to a per-window in-memory list
   * (browser shells override with their scoped native storage).
   */
  readonly recent?: RecentProjectsPort;
  /**
   * Autosave debounce; defaults to 2000 ms. Tests may lower it.
   */
  readonly autosaveDelayMs?: number;
  /**
   * Per-gesture voxel budget shared by the stroke and shape tools.
   * Defaults to ADR-0009 `MAX_VOXELS_PER_OPERATION`; callers may lower
   * (never raise) the limit, matching the ADR-0009 escalation policy.
   * Tests use small budgets to exercise the limit seam through the real
   * composition.
   */
  readonly gestureVoxelLimit?: number;
  /**
   * Meshes chunks in a real Web Worker (plan S6.6, ticket #23). The
   * desktop app enables it; headless and test compositions keep the
   * in-process executor so no browser worker is required.
   */
  readonly useMeshingWorker?: boolean;
}

/**
 * Builds the desktop meshing worker (plan S6.6, ticket #23) adapted to
 * the renderer package's narrow worker surface: the real worker's
 * `MessageEvent` is reduced to `{ data }` before it reaches the meshing
 * executor, keeping three/worker types out of the renderer package.
 */
function createMeshingWorker(): MeshingWorkerLike {
  const worker = new Worker(new URL("./meshing-worker.ts", import.meta.url), {
    type: "module",
  });
  const adapted: MeshingWorkerLike = {
    postMessage(message, transfer) {
      if (transfer === undefined) {
        worker.postMessage(message);
      } else {
        worker.postMessage(message, [...transfer]);
      }
    },
    onmessage: null,
    terminate() {
      worker.terminate();
    },
  };
  worker.onmessage = (event: MessageEvent) => {
    adapted.onmessage?.({ data: event.data });
  };
  return adapted;
}

const REGISTER_COMMANDS = [
  registerVoxelCommands,
  registerBatchCommands,
  registerRegionCommands,
  registerNodeCommands,
  registerArticulationCommands,
  registerMaterialCommands,
] as const;

export function createDesktopComposition(
  options: CompositionOptions,
): DesktopComposition {
  const scene = new THREE.Scene();
  const adapter = createSceneAdapter({
    scene,
    // Meshing runs in a real Web Worker in the desktop app (plan S6.6);
    // tests and headless runs omit this and use the in-process executor.
    ...(options.useMeshingWorker === true
      ? { createWorker: createMeshingWorker }
      : {}),
  });
  // The composition-owned journal sink: every fresh bus the session
  // installs carries `busHooks.onCommitted`, which delegates to the file
  // service's current-document journal (ticket #22 recovery wiring).
  const journalSink: {
    current: ((record: CommittedTransactionRecord) => void) | undefined;
  } = { current: undefined };
  const session = createDocumentSession({
    registerCommands: [...REGISTER_COMMANDS],
    busHooks: {
      onCommitted(record) {
        journalSink.current?.(record);
      },
    },
  });
  const editor = createEditorStore();
  const viewport = createViewportController({
    session,
    editor,
    scene,
    ...(options.gestureVoxelLimit === undefined
      ? {}
      : { gestureVoxelLimit: options.gestureVoxelLimit }),
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
    editor,
    prompts: options.prompts ?? createDefaultPrompts(),
    recent: options.recent ?? createMemoryRecentProjects(),
    journalSink,
    registerCommands: [...REGISTER_COMMANDS],
    ...(options.autosaveDelayMs === undefined
      ? {}
      : { autosaveDelayMs: options.autosaveDelayMs }),
  });
  const materialPanel = createMaterialPanelController({ session, editor });

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
    editor.setTransformPreview(undefined);
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
    renderer: {
      scene,
      adapter,
      flush(camera: THREE.Camera) {
        adapter.flush(camera);
      },
      diagnostics() {
        return adapter.diagnostics();
      },
    },
    viewport,
    draftOverlay,
    materialPanel,
    fileService,
    dispose() {
      materialPanel.dispose();
      viewport.dispose();
      draftOverlay.dispose();
      fileService.dispose();
      adapter.dispose();
      session.dispose();
    },
  };
}
