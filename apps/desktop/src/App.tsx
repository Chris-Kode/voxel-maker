import { useEffect, useRef, useState } from "react";
import {
  snapshotEditorStore,
  type EditorStore,
  type EditorStoreSnapshot,
} from "@voxel-maker/editor";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createDesktopComposition } from "./composition.js";
import { createDefaultPlatform } from "./platform/index.js";
import { isTauriRuntime } from "./platform/detect.js";
import { Viewport } from "./viewport/Viewport.js";
import { handleCloseRequest } from "./close-request.js";
import type { FileServiceResult, FileServiceStatus } from "./file-service.js";
import type { RecentProjectEntry } from "./recent-projects.js";

/**
 * Desktop shell chrome (plan S6.1/S6.2 ticket #15, S7.3-S7.7/S7.19 ticket
 * #18, S7.16 ticket #22): a minimal header with project lifecycle actions
 * (new/open/save/save-as/recent/close), the edit tool buttons
 * (select/pencil/erase/paint/eyedropper/box/sphere/cylinder), the
 * select-tool granularity picker (node/voxel/region), the viewport, and a
 * status bar that makes pending-save, dirty, stale-completion, degraded
 * recovery, and error states visible and actionable. All behavior lives
 * behind the composition root; this component only renders state and
 * forwards gestures.
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
] as const satisfies readonly {
  id:
    | "select"
    | "pencil"
    | "erase"
    | "paint"
    | "eyedropper"
    | "box"
    | "sphere"
    | "cylinder";
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
    createDesktopComposition(createDefaultPlatform()),
  );
  const editorState = useEditorStore(composition.editor);
  const [status, setStatus] = useState<FileServiceStatus>(() =>
    snapshotStatus(composition.fileService.status),
  );
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<FileServiceResult | undefined>();
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
      </header>
      <main className="stage">
        <Viewport
          composition={composition}
          activeTool={editorState.activeTool}
          selectionMode={editorState.selectionMode}
        />
      </main>
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
