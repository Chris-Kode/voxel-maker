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
 * Desktop shell chrome (plan S6.1/S6.2 ticket #15, S7.3-S7.7/S7.19
 * tickets #18/#19, S7.13 ticket #21): a minimal header with project
 * lifecycle actions, undo/redo, the edit tool buttons
 * (select/pencil/erase/paint/eyedropper/box/sphere/cylinder/transform),
 * the select-tool granularity picker (node/voxel/region), the
 * transform-tool operation modes (move/copy/rotate/mirror/delete) with
 * their axis buttons and the pending-preview apply/cancel actions, the
 * materials panel, and the viewport. All behavior lives behind the
 * composition root; this component only renders state and forwards
 * gestures. (feat: transform selected voxel regions (#19))
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

/** Select-tool granularity choices (plan S7.2/S7.4). */
const SELECTION_MODES = [
  { id: "node", label: "Node" },
  { id: "voxel", label: "Voxel" },
  { id: "region", label: "Region" },
] as const satisfies readonly {
  id: "node" | "voxel" | "region";
  label: string;
}[];

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
