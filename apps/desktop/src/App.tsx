import { useEffect, useState } from "react";
import {
  snapshotEditorStore,
  type EditorStore,
  type EditorStoreSnapshot,
} from "@voxel-maker/editor";
import { createDesktopComposition } from "./composition.js";
import { createDefaultPlatform } from "./platform/index.js";
import { Viewport } from "./viewport/Viewport.js";
import { MaterialPanel, usePanelState } from "./materials/MaterialPanel.js";
import type { FileServiceResult } from "./file-service.js";

/**
 * Desktop shell chrome (plan S6.1/S6.2 ticket #15, S7.3-S7.7/S7.19 ticket
 * #18, S7.13 ticket #21): a minimal header with project lifecycle
 * actions, undo/redo, the edit tool buttons
 * (select/pencil/erase/paint/eyedropper/box/sphere/cylinder), the
 * select-tool granularity picker (node/voxel/region), the materials
 * panel, and the viewport. All behavior lives behind the composition
 * root; this component only renders state and forwards gestures.
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
  const panel = composition.materialPanel;
  const panelState = usePanelState(panel);
  const editorState = useEditorStore(composition.editor);
  const [status, setStatus] = useState(() => composition.fileService.status);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<FileServiceResult | undefined>();

  useEffect(
    () =>
      composition.fileService.subscribe(() => {
        setStatus(composition.fileService.status);
      }),
    [composition],
  );

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
        <button
          type="button"
          disabled={busy || status.documentId === undefined}
          onClick={() => void run(() => composition.fileService.saveProject())}
        >
          Save
        </button>
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
        <span>{status.path ?? ""}</span>
        {lastResult !== undefined &&
        !lastResult.ok &&
        lastResult.error !== undefined ? (
          <span className="error">{lastResult.error.message}</span>
        ) : null}
      </footer>
    </div>
  );
}
