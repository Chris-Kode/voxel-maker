import { useEffect, useRef, useState } from "react";
import {
  snapshotEditorStore,
  type EditorStore,
  type EditorStoreSnapshot,
  type TransformToolMode,
} from "@voxel-maker/editor";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createDesktopComposition } from "./composition.js";
import { createDefaultPlatform } from "./platform/index.js";
import { isTauriRuntime } from "./platform/detect.js";
import { Viewport } from "./viewport/Viewport.js";
import { HierarchyPanel } from "./panels/HierarchyPanel.js";
import { InspectorPanel } from "./panels/InspectorPanel.js";
import { createPanelIds } from "./panels/panel-utils.js";
import { MaterialPanel, usePanelState } from "./materials/MaterialPanel.js";
import { TimelinePanel } from "./timeline/TimelinePanel.js";
import { AnimationInspector } from "./timeline/AnimationInspector.js";
import { AiPanel } from "./ai/AiPanel.js";
import { DEFAULT_PREVIEW_SIZE } from "@voxel-maker/renderer";
import { handleCloseRequest } from "./close-request.js";
import type { FileServiceResult, FileServiceStatus } from "./file-service.js";
import type {
  PreviewExportResult,
  PreviewExportStatus,
} from "./export/preview-export.js";
import type { RecentProjectEntry } from "./recent-projects.js";

/**
 * Desktop shell chrome (plan S6.1/S6.2 ticket #15, S7.3-S7.7/S7.19
 * tickets #18/#19, S7.13 ticket #21, S7.16 ticket #22): a minimal header
 * with project lifecycle actions (new/open/save/save-as/recent/close),
 * undo/redo, the edit tool buttons
 * (select/pencil/erase/paint/eyedropper/box/sphere/cylinder/transform),
 * the select-tool granularity picker (node/voxel/region), the
 * transform-tool operation modes (move/copy/rotate/mirror/delete) with
 * their axis buttons and the pending-preview apply/cancel actions, the
 * materials panel, and the viewport. The status bar makes pending-save,
 * dirty, stale-completion, degraded recovery, and error states visible
 * and actionable. All behavior lives behind the composition root; this
 * component only renders state and forwards gestures.

 */

/** The runtime tool choices rendered in the shell toolbar. */
const TOOLS = [
  { id: "select", label: "Select" },
  { id: "pencil", label: "Pencil" },
  { id: "erase", label: "Erase" },
  { id: "paint", label: "Paint" },
  { id: "eyedropper", label: "Eyedropper" },
  { id: "box", label: "Box" },
  { id: "sphere", label: "Sphere" },
  { id: "cylinder", label: "Cylinder" },
  { id: "transform", label: "Transform" },
] as const satisfies readonly {
  id:
    | "select"
    | "pencil"
    | "erase"
    | "paint"
    | "eyedropper"
    | "box"
    | "sphere"
    | "cylinder"
    | "transform";
  label: string;
}[];

/** Friendly labels for the atomic-write phases (plan S7.16 progress). */
const SAVE_PHASE_LABELS: Readonly<Record<string, string>> = {
  "create-temp": "creating temporary file",
  "write-temp": "writing project data",
  "flush-temp": "flushing to disk",
  backup: "preserving backup",
  replace: "installing project file",
  "sync-directory": "syncing directory",
};

/** Select-tool granularity choices (plan S7.2/S7.4). */
const SELECTION_MODES = [
  { id: "node", label: "Node" },
  { id: "voxel", label: "Voxel" },
  { id: "region", label: "Region" },
] as const satisfies readonly {
  id: "node" | "voxel" | "region";
  label: string;
}[];

/** Transform gizmo modes (plan S7.8). */
const GIZMO_MODES = [
  { id: "translate", label: "Move" },
  { id: "rotate", label: "Rotate" },
  { id: "scale", label: "Scale" },
] as const satisfies readonly { id: TransformToolMode; label: string }[];

/** The current snap increment in UI units (degrees for rotation). */
function snapIncrementFor(
  mode: TransformToolMode,
  tool: ReturnType<
    typeof createDesktopComposition
  >["viewport"]["transformTool"],
): number {
  if (mode === "rotate") return (tool.rotateSnap * 180) / Math.PI;
  if (mode === "translate") return tool.translateSnap;
  return tool.scaleSnap;
}

/** Transform-tool operation modes (plan S7.19, ticket #19). */
const TRANSFORM_MODES = [
  { id: "move", label: "Move" },
  { id: "copy", label: "Copy" },
  { id: "rotate", label: "Rotate" },
  { id: "mirror", label: "Mirror" },
  { id: "delete", label: "Delete" },
] as const satisfies readonly {
  id: "move" | "copy" | "rotate" | "mirror" | "delete";
  label: string;
}[];

/** Axis choices for the rotate and mirror modes (plan S7.19). */
const TRANSFORM_AXES = [
  { id: "x", label: "X" },
  { id: "y", label: "Y" },
  { id: "z", label: "Z" },
] as const satisfies readonly { id: "x" | "y" | "z"; label: string }[];

/** Subscribes to the runtime editor store for the shell chrome. */
function useEditorStore(editor: EditorStore): EditorStoreSnapshot {
  const [snapshot, setSnapshot] = useState(() => snapshotEditorStore(editor));
  useEffect(
    () =>
      editor.subscribe(() => {
        setSnapshot(snapshotEditorStore(editor));
      }),
    [editor],
  );
  return snapshot;
}

export function App(): React.JSX.Element {
  const [composition] = useState(() =>
    createDesktopComposition({
      ...createDefaultPlatform(),
      useMeshingWorker: true,
    }),
  );
  const [panelIds] = useState(() => createPanelIds("panel"));
  const panel = composition.materialPanel;
  const panelState = usePanelState(panel);
  const editorState = useEditorStore(composition.editor);
  const [status, setStatus] = useState<FileServiceStatus>(() =>
    snapshotStatus(composition.fileService.status),
  );
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<FileServiceResult | undefined>();
  const [exportStatus, setExportStatus] = useState<PreviewExportStatus>(() =>
    snapshotExportStatus(composition.previewExport.status),
  );
  const [exportSize, setExportSize] = useState(DEFAULT_PREVIEW_SIZE);
  const [lastExport, setLastExport] = useState<
    PreviewExportResult | undefined
  >();
  const [recent, setRecent] = useState<readonly RecentProjectEntry[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);
  const recentRef = useRef<HTMLDivElement | null>(null);

  useEffect(
    () =>
      composition.fileService.subscribe(() => {
        setStatus(snapshotStatus(composition.fileService.status));
      }),
    [composition],
  );

  useEffect(
    () =>
      composition.previewExport.subscribe(() => {
        setExportStatus(snapshotExportStatus(composition.previewExport.status));
      }),
    [composition],
  );

  // Refresh the recent list when the menu opens and after every status
  // change (a successful open/save records a recent entry).
  useEffect(() => {
    void composition.fileService.recentProjects().then(setRecent);
  }, [composition, status, recentOpen]);

  // OS window close (Tauri): a dirty document prompts through the same
  // discard flow as the in-app Close button before the window disappears.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (disposed) return;
        event.preventDefault();
        // handleCloseRequest destroys the window when the close is
        // confirmed; on cancel the window stays open.
        await handleCloseRequest(composition.fileService, () =>
          getCurrentWindow().destroy(),
        );
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [composition]);

  // Close the recent menu on outside clicks and Escape.
  useEffect(() => {
    if (!recentOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (
        recentRef.current !== null &&
        !recentRef.current.contains(event.target as Node)
      ) {
        setRecentOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setRecentOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [recentOpen]);

  const run = async (
    action: () => Promise<FileServiceResult | undefined> | FileServiceResult,
  ): Promise<void> => {
    setBusy(true);
    try {
      const result = await action();
      if (result !== undefined) setLastResult(result);
    } finally {
      setBusy(false);
    }
  };

  const exportPreviews = async (): Promise<void> => {
    const result = await composition.previewExport.exportPreviews({
      size: exportSize,
    });
    if (result !== undefined) setLastExport(result);
  };

  const openRecent = async (path: string): Promise<void> => {
    setRecentOpen(false);
    await run(() => composition.fileService.openRecentProject(path));
  };

  const forgetRecent = async (path: string): Promise<void> => {
    await composition.fileService.forgetRecentProject(path);
    setRecent(await composition.fileService.recentProjects());
  };

  const saving = status.saving;
  const dirty = status.dirty;
  const exporting = exportStatus.state === "exporting";
  const pendingTransform = editorState.transformPreview;
  // Single pending-apply predicate: the controller owns the definition
  // (a rotate/mirror/delete preview awaits apply; move/copy drags are
  // live previews that commit on pointer-up).
  const transformPendingApply = composition.viewport.transformApplyPending;
  const transformSummary = ((): string => {
    if (pendingTransform === undefined) return "";
    const counts = `${String(pendingTransform.movedVoxels)} voxel${pendingTransform.movedVoxels === 1 ? "" : "s"}`;
    const collisions =
      pendingTransform.overwrittenVoxels === 0
        ? "no collisions"
        : `${String(pendingTransform.overwrittenVoxels)} overwritten`;
    if (
      pendingTransform.operation === "move" ||
      pendingTransform.operation === "copy"
    ) {
      const removed =
        pendingTransform.operation === "move" &&
        pendingTransform.removedVoxels > 0
          ? `, ${String(pendingTransform.removedVoxels)} removed`
          : "";
      return `${counts}${removed} · ${collisions}`;
    }
    if (pendingTransform.operation === "delete") {
      return `${counts} removed`;
    }
    if (pendingTransform.operation === "rotate") {
      return `${counts} · ${String(pendingTransform.quarterTurns * 90)}° around ${pendingTransform.axis.toUpperCase()} · ${collisions}`;
    }
    return `${counts} · across ${pendingTransform.axis.toUpperCase()} · ${collisions}`;
  })();

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">Voxel Maker</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => composition.fileService.newProject())}
        >
          New
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => composition.fileService.openProject())}
        >
          Open
        </button>
        {saving ? (
          <button
            type="button"
            className="cancel-save"
            onClick={() => {
              composition.fileService.cancelSave();
            }}
          >
            Cancel save
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || status.documentId === undefined}
            onClick={() =>
              void run(() => composition.fileService.saveProject())
            }
          >
            Save
          </button>
        )}
        <button
          type="button"
          disabled={busy || status.documentId === undefined}
          onClick={() =>
            void run(() => composition.fileService.saveProjectAs())
          }
        >
          Save As
        </button>
        <label className="export-size" aria-label="Preview image size">
          <select
            value={exportSize}
            disabled={busy || exporting}
            onChange={(event) => {
              setExportSize(Number(event.target.value));
            }}
          >
            <option value={512}>512px</option>
            <option value={1024}>1024px</option>
            <option value={2048}>2048px</option>
          </select>
        </label>
        {exporting ? (
          <button
            type="button"
            className="cancel-save"
            onClick={() => {
              composition.previewExport.cancel();
            }}
          >
            Cancel export
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || status.documentId === undefined}
            title="Export perspective, front, side, and top preview images"
            onClick={() => void exportPreviews()}
          >
            Export previews
          </button>
        )}
        <div className="recent" ref={recentRef}>
          <button
            type="button"
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={recentOpen}
            onClick={() => {
              setRecentOpen((open) => !open);
            }}
          >
            Recent
          </button>
          {recentOpen ? (
            <ul
              className="recent-menu"
              role="menu"
              aria-label="Recent projects"
            >
              {recent.length === 0 ? (
                <li
                  className="recent-empty"
                  role="menuitem"
                  aria-disabled="true"
                >
                  No recent projects
                </li>
              ) : (
                recent.map((entry) => (
                  <li key={entry.path} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void openRecent(entry.path)}
                    >
                      <span className="recent-title">
                        {entry.title.length > 0 ? entry.title : entry.path}
                      </span>
                      <span className="recent-path">{entry.path}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="recent-remove"
                      aria-label={`Forget ${entry.path}`}
                      onClick={() => void forgetRecent(entry.path)}
                    >
                      ×
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          disabled={busy || status.documentId === undefined}
          onClick={() => void run(() => composition.fileService.closeProject())}
        >
          Close
        </button>
        <span className="toolbar-separator" aria-hidden="true" />
        <button
          type="button"
          disabled={!panelState.canUndo}
          title="Undo the last edit"
          onClick={() => {
            panel.undo();
          }}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!panelState.canRedo}
          title="Redo the last undone edit"
          onClick={() => {
            panel.redo();
          }}
        >
          Redo
        </button>
        <span className="tools" role="group" aria-label="Edit tools">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className={
                editorState.activeTool === tool.id ? "active" : undefined
              }
              aria-pressed={editorState.activeTool === tool.id}
              onClick={() => {
                composition.editor.setActiveTool(tool.id);
                // A pending transform preview never outlives its tool.
                if (tool.id !== "transform") {
                  composition.editor.setTransformPreview(undefined);
                }
              }}
            >
              {tool.label}
            </button>
          ))}
        </span>
        {editorState.activeTool === "select" ? (
          <span
            className="selection-modes"
            role="group"
            aria-label="Selection granularity"
          >
            {SELECTION_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={
                  editorState.selectionMode === mode.id ? "active" : undefined
                }
                aria-pressed={editorState.selectionMode === mode.id}
                onClick={() => {
                  composition.editor.setSelectionMode(mode.id);
                }}
              >
                {mode.label}
              </button>
            ))}
          </span>
        ) : null}
        {editorState.activeTool === "select" ? (
          <span
            className="gizmo-controls"
            role="group"
            aria-label="Transform gizmo"
          >
            {GIZMO_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={
                  composition.viewport.transformTool.mode === mode.id
                    ? "active"
                    : undefined
                }
                aria-pressed={
                  composition.viewport.transformTool.mode === mode.id
                }
                onClick={() => {
                  composition.viewport.transformTool.setMode(mode.id);
                  composition.viewport.refreshGizmo();
                }}
              >
                {mode.label}
              </button>
            ))}
            <span className="toolbar-separator" aria-hidden="true" />
            <button
              type="button"
              className={
                composition.viewport.transformTool.space === "world"
                  ? "active"
                  : undefined
              }
              aria-pressed={
                composition.viewport.transformTool.space === "world"
              }
              onClick={() => {
                composition.viewport.transformTool.setSpace("world");
                composition.viewport.refreshGizmo();
              }}
            >
              World
            </button>
            <button
              type="button"
              className={
                composition.viewport.transformTool.space === "local"
                  ? "active"
                  : undefined
              }
              aria-pressed={
                composition.viewport.transformTool.space === "local"
              }
              onClick={() => {
                composition.viewport.transformTool.setSpace("local");
                composition.viewport.refreshGizmo();
              }}
            >
              Local
            </button>
            <label className="gizmo-snap">
              <input
                type="checkbox"
                checked={composition.viewport.transformTool.snapping}
                onChange={(event) => {
                  composition.viewport.transformTool.setSnapping(
                    event.target.checked,
                  );
                }}
              />
              Snap
            </label>
            <label className="gizmo-snap-increment">
              <input
                type="number"
                min={0.01}
                step={0.01}
                value={snapIncrementFor(
                  composition.viewport.transformTool.mode,
                  composition.viewport.transformTool,
                )}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value) || value <= 0) return;
                  const tool = composition.viewport.transformTool;
                  const mode = tool.mode;
                  if (mode === "translate") tool.setTranslateSnap(value);
                  if (mode === "rotate")
                    tool.setRotateSnap((value * Math.PI) / 180);
                  if (mode === "scale") tool.setScaleSnap(value);
                }}
                aria-label="Snap increment"
              />
              <span>
                {composition.viewport.transformTool.mode === "rotate"
                  ? "°"
                  : ""}
              </span>
            </label>
          </span>
        ) : null}
        {editorState.activeTool === "transform" ? (
          <span
            className="transform-modes"
            role="group"
            aria-label="Transform operation"
          >
            {TRANSFORM_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={
                  editorState.transformMode === mode.id ? "active" : undefined
                }
                aria-pressed={editorState.transformMode === mode.id}
                onClick={() => {
                  composition.editor.setTransformMode(mode.id);
                  composition.editor.setTransformPreview(undefined);
                }}
              >
                {mode.label}
              </button>
            ))}
            {editorState.transformMode === "rotate" ||
            editorState.transformMode === "mirror" ? (
              <span
                className="transform-axes"
                role="group"
                aria-label={`Transform ${editorState.transformMode} axis`}
              >
                {TRANSFORM_AXES.map((axis) => (
                  <button
                    key={axis.id}
                    type="button"
                    onClick={() => {
                      if (editorState.transformMode === "rotate") {
                        composition.viewport.transformPreviewRotate(axis.id);
                      } else {
                        composition.viewport.transformPreviewMirror(axis.id);
                      }
                    }}
                  >
                    {axis.label}
                  </button>
                ))}
              </span>
            ) : null}
            {editorState.transformMode === "delete" ? (
              <button
                type="button"
                onClick={() => {
                  composition.viewport.transformPreviewDelete();
                }}
              >
                Delete selection
              </button>
            ) : null}
            {transformPendingApply ? (
              <span
                className="transform-pending"
                role="group"
                aria-label="Pending transform preview"
              >
                <span className="transform-summary">{transformSummary}</span>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    composition.viewport.transformApply();
                  }}
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={() => {
                    composition.viewport.transformCancel();
                  }}
                >
                  Cancel
                </button>
              </span>
            ) : null}
          </span>
        ) : null}
      </header>
      <main className="stage">
        <aside className="side-panel left">
          <HierarchyPanel
            session={composition.session}
            editor={composition.editor}
            ids={panelIds}
          />
        </aside>
        <aside className="sidebar" aria-label="Document panels">
          <MaterialPanel controller={panel} />
        </aside>
        <div className="viewport-host">
          <Viewport
            composition={composition}
            activeTool={editorState.activeTool}
            selectionMode={editorState.selectionMode}
          />
        </div>
        <aside className="side-panel right">
          <InspectorPanel
            session={composition.session}
            editor={composition.editor}
            ids={panelIds}
            transformAugment={(commands) =>
              composition.timeline.autoKeyCommands(commands)
            }
          />
          <AnimationInspector
            controller={composition.timeline}
            editor={composition.editor}
          />
          <AiPanel controller={composition.ai} />
        </aside>
      </main>
      <TimelinePanel
        controller={composition.timeline}
        editor={composition.editor}
      />
      <footer className="statusbar" aria-live="polite">
        <span>
          {status.documentId === undefined
            ? "No document open"
            : `Document ${status.documentId}`}
        </span>
        <span>
          {status.revision === undefined
            ? ""
            : `Revision ${String(status.revision)}`}
        </span>
        <span>
          {status.nodeCount === undefined
            ? ""
            : `${String(status.nodeCount)} nodes`}
        </span>
        <span className="path">{status.path ?? ""}</span>
        {status.documentId !== undefined ? (
          <span className={dirty ? "dirty" : undefined}>
            {dirty ? "Unsaved changes" : "Saved"}
          </span>
        ) : null}
        {saving ? (
          <span className="saving">
            {status.autosaving
              ? "Autosaving…"
              : `Saving…${
                  status.progress === undefined
                    ? ""
                    : ` (${SAVE_PHASE_LABELS[status.progress] ?? status.progress})`
                }`}
          </span>
        ) : null}
        {status.lastSaveStale ? (
          <span className="stale">Save is behind your latest changes</span>
        ) : null}
        {exporting ? (
          <span className="saving">
            Exporting previews… (
            {exportStatus.views.filter((view) => view.state === "done").length}/
            {exportStatus.views.length}{" "}
            {exportStatus.views.find(
              (view) =>
                view.state === "rendering" ||
                view.state === "encoding" ||
                view.state === "writing",
            )?.view ?? ""}
            )
          </span>
        ) : null}
        {lastExport !== undefined ? (
          <span
            className={
              lastExport.ok && !lastExport.cancelled ? "saved" : "error"
            }
          >
            {lastExport.ok && !lastExport.cancelled
              ? `Exported ${String(lastExport.paths.length)} preview images`
              : lastExport.cancelled
                ? `Preview export cancelled (${String(lastExport.paths.length)} written)`
                : (lastExport.error?.message ?? "Preview export failed")}
          </span>
        ) : null}
        {status.degraded ? (
          <span className="degraded">Crash recovery degraded</span>
        ) : null}
        {lastResult !== undefined &&
        !lastResult.ok &&
        lastResult.error !== undefined ? (
          <span className="error">{lastResult.error.message}</span>
        ) : null}
      </footer>
      <section className="notices" aria-label="Notices">
        {editorState.notices.map((notice) => (
          <div
            key={notice.id}
            className={`notice notice-${notice.level}`}
            role={notice.level === "error" ? "alert" : "status"}
          >
            <span>{notice.message}</span>
            <button
              type="button"
              aria-label="Dismiss notice"
              onClick={() => {
                composition.editor.dismissNotice(notice.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}

/** Copies the live export status into a stable snapshot for React. */
function snapshotExportStatus(
  status: PreviewExportStatus,
): PreviewExportStatus {
  return {
    state: status.state,
    views: status.views,
    basePath: status.basePath,
    error: status.error,
  };
}

/** Copies the live getter-based status into a stable snapshot for React. */
function snapshotStatus(status: FileServiceStatus): FileServiceStatus {
  return {
    path: status.path,
    documentId: status.documentId,
    revision: status.revision,
    title: status.title,
    nodeCount: status.nodeCount,
    dirty: status.dirty,
    saving: status.saving,
    autosaving: status.autosaving,
    lastSaveStale: status.lastSaveStale,
    degraded: status.degraded,
    progress: status.progress,
  };
}
