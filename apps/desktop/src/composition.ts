import * as THREE from "three";
import {
  MemoryImageStorage,
  type ImageStoragePort,
  type ProjectStoragePort,
  type RecoveryJournalPort,
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
  registerAnimationCommands,
  registerArticulationCommands,
  registerBatchCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
  registerVolumeCommands,
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
import {
  createPreviewExportService,
  type PreviewExportService,
} from "./export/preview-export.js";
import {
  createTimelineController,
  type TimelineController,
} from "./timeline/timeline-controller.js";
import { createAiController, type AiController } from "./ai/ai-controller.js";
import { createRendererEvidenceCapture } from "./ai/visual-evidence.js";
import {
  KEYCHAIN_SERVICE,
  MemoryConsentStore,
  MemoryCredentialStore,
  MemoryImageConsentStore,
  OpenAIProvider,
  type EvidenceCapture,
  type ImageConsentStore,
  Secret,
  type AgentBudgets,
  type ConsentStore,
  type CredentialStore,
  type ProviderAdapter,
} from "@voxel-maker/agent";

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
  /**
   * PNG-filtered save picker for preview exports (ticket #25). Optional:
   * services fall back to `pickSavePath` when a picker predates it.
   */
  pickSaveImagePath?(suggestedName: string): Promise<string | undefined>;
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
  /** Standard preview image export (plan S8.5/S15.2, ticket #25). */
  readonly previewExport: PreviewExportService;
  /**
   * Animation timeline controller (plan S10.9-S10.13, ticket #29): the
   * headless seam between the timeline UI and the session command bus.
   */
  readonly timeline: TimelineController;
  /**
   * AI assistant controller (plan S12.10/S12.14/S12.15, ticket #34): the
   * headless seam between the AI panel, the bounded agent loop, and the
   * staged viewport projection. Unconfigured or offline, the controller
   * degrades to a clear status while every manual workflow keeps working.
   */
  readonly ai: AiController;
  dispose(): void;
}

export interface CompositionOptions {
  readonly storage: ProjectStoragePort & RecoveryJournalPort;
  /**
   * Scoped atomic preview-image writes (plan S8.5, ticket #25). Defaults
   * to the in-memory adapter (browser shells and tests); the Tauri shell
   * injects the native adapter from the platform services.
   */
  readonly imageStorage?: ImageStoragePort;
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
   * Provider credential store (plan S12.4, ADR-0010, ticket #34). The
   * platform services supply the OS keychain in the Tauri shell; tests
   * and plain compositions default to a per-window memory store.
   */
  readonly credentials?: CredentialStore;
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
  /**
   * AI service overrides (plan S12.10, ticket #34). The composition root
   * defaults to the OpenAI adapter over the platform credential store
   * with a per-window consent store; tests inject the deterministic
   * provider and scripted stores through this seam.
   */
  readonly ai?: {
    /** Provider-neutral chat adapter; defaults to the OpenAI adapter. */
    readonly provider?: ProviderAdapter;
    /** Default model; defaults to the provider's default model. */
    readonly model?: string;
    /** Credential store; defaults to the platform/OS-keychain store. */
    readonly credentials?: CredentialStore;
    /** Consent store; defaults to a per-window memory store. */
    readonly consent?: ConsentStore;
    /**
     * Image-transmission consent store (ADR-0010, ticket #40); defaults
     * to a per-window memory store.
     */
    readonly imageConsentStore?: ImageConsentStore;
    /**
     * Evidence capture seam (ticket #40); defaults to the renderer-based
     * standard-view capture so visual refinement works out of the box.
     */
    readonly capture?: EvidenceCapture;
    /** Evidence resolution for the refinement plan; defaults to 512. */
    readonly evidenceResolution?: number;
    /** Session budget overrides; every value is clamped to [0, default]. */
    readonly budgets?: Partial<AgentBudgets>;
    /** Virtual clock for the agent loop (tests). */
    readonly clock?: { now(): number };
    /** Simulated sleep for retry backoff (tests). */
    readonly sleep?: (ms: number) => Promise<void>;
  };
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
  registerVolumeCommands,
  registerAnimationCommands,
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
  const timeline = createTimelineController({ session, editor });
  const viewport = createViewportController({
    session,
    editor,
    scene,
    ...(options.gestureVoxelLimit === undefined
      ? {}
      : { gestureVoxelLimit: options.gestureVoxelLimit }),
    // Auto-key (plan S10.12): transform gestures write keys into the
    // selected clip when the timeline key mode is "auto".
    autoKey: (commands) => timeline.autoKeyCommands(commands),
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
  const previewExport = createPreviewExportService({
    session,
    imageStorage: options.imageStorage ?? new MemoryImageStorage(),
    picker: options.picker,
    prompts: options.prompts ?? createDefaultPrompts(),
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

  const credentials =
    options.ai?.credentials ??
    options.credentials ??
    new MemoryCredentialStore();
  const consent = options.ai?.consent ?? new MemoryConsentStore();
  const imageConsentStore =
    options.ai?.imageConsentStore ?? new MemoryImageConsentStore();
  const evidenceCapture =
    options.ai?.capture ?? createRendererEvidenceCapture();
  const provider: ProviderAdapter =
    options.ai?.provider ??
    new OpenAIProvider({
      getApiKey: async () => {
        const stored = await credentials.get(KEYCHAIN_SERVICE, "openai");
        return stored ?? new Secret("");
      },
    });
  const ai = createAiController({
    session,
    editor,
    adapter,
    provider,
    credentials,
    consent,
    imageConsentStore,
    capture: evidenceCapture,
    ...(options.ai?.evidenceResolution === undefined
      ? {}
      : { evidenceResolution: options.ai.evidenceResolution }),
    ...(options.ai?.model === undefined ? {} : { model: options.ai.model }),
    ...(options.ai?.budgets === undefined
      ? {}
      : { budgets: options.ai.budgets }),
    ...(options.ai?.clock === undefined ? {} : { clock: options.ai.clock }),
    ...(options.ai?.sleep === undefined ? {} : { sleep: options.ai.sleep }),
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
    previewExport,
    timeline,
    ai,
    dispose() {
      ai.dispose();
      timeline.dispose();
      materialPanel.dispose();
      viewport.dispose();
      draftOverlay.dispose();
      fileService.dispose();
      previewExport.dispose();
      adapter.dispose();
      session.dispose();
    },
  };
}
