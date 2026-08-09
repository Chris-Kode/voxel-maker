import type { DesktopComposition } from "../composition.js";
import type { ShortcutId } from "./shortcuts.js";

/**
 * Shortcut dispatcher (plan S7.15, ticket #43): routes matched shortcut
 * commands to the composition root, mirroring exactly what the toolbar
 * and panel buttons do. Commands that cannot run (no open document, a
 * save already in flight, nothing to undo) are silent no-ops, matching
 * the disabled state of their toolbar buttons, so a shortcut never
 * surprises the user with a partial action. Focus commands route through
 * the injected `focusPanel` so the App shell owns the DOM ids.
 */

export type FocusPanelId =
  | "hierarchy"
  | "materials"
  | "inspector"
  | "timeline"
  | "ai";

export interface ShortcutActionContext {
  readonly composition: DesktopComposition;
  /** Moves keyboard focus to a panel's root element. */
  focusPanel(panel: FocusPanelId): void;
}

const TOOL_BY_ID: Readonly<
  Partial<Record<ShortcutId, import("@voxel-maker/editor").EditorToolId>>
> = {
  "select-tool": "select",
  "pencil-tool": "pencil",
  "erase-tool": "erase",
  "paint-tool": "paint",
  "eyedropper-tool": "eyedropper",
  "box-tool": "box",
  "sphere-tool": "sphere",
  "cylinder-tool": "cylinder",
  "transform-tool": "transform",
};

const FOCUS_PANEL_BY_ID: Readonly<Partial<Record<ShortcutId, FocusPanelId>>> = {
  "focus-hierarchy": "hierarchy",
  "focus-materials": "materials",
  "focus-inspector": "inspector",
  "focus-timeline": "timeline",
  "focus-ai": "ai",
};

/** Creates the shortcut → composition dispatcher for one app shell. */
export function createShortcutDispatcher(
  context: ShortcutActionContext,
): (id: ShortcutId) => void {
  const { composition } = context;
  return (id) => {
    const status = composition.fileService.status;
    // Lifecycle actions need a document (except new/open) and must not
    // stack on an in-flight save (the toolbar disables while busy).
    const documentOpen = status.documentId !== undefined;
    const notSaving = !status.saving;
    switch (id) {
      case "new-project":
        if (notSaving) void composition.fileService.newProject();
        return;
      case "open-project":
        if (notSaving) void composition.fileService.openProject();
        return;
      case "save-project":
        if (documentOpen && notSaving)
          void composition.fileService.saveProject();
        return;
      case "save-project-as":
        if (documentOpen && notSaving)
          void composition.fileService.saveProjectAs();
        return;
      case "close-project":
        if (documentOpen && notSaving)
          void composition.fileService.closeProject();
        return;
      case "export-previews":
        if (documentOpen && notSaving) {
          void composition.previewExport.exportPreviews();
        }
        return;
      case "undo": {
        if (composition.materialPanel.state.canUndo) {
          composition.materialPanel.undo();
        }
        return;
      }
      case "redo": {
        if (composition.materialPanel.state.canRedo) {
          composition.materialPanel.redo();
        }
        return;
      }
      case "toggle-playback":
        // Mirrors the timeline's Play/Pause button, which is disabled
        // without a selected clip (needsDocument semantics).
        if (composition.timeline.state.selectedClip === undefined) return;
        if (composition.timeline.state.playing) {
          composition.timeline.pause();
        } else {
          composition.timeline.play();
        }
        return;
      default:
        break;
    }
    const tool = TOOL_BY_ID[id];
    if (tool !== undefined) {
      composition.editor.setActiveTool(tool);
      // A pending transform preview never outlives its tool (App.tsx).
      if (tool !== "transform") {
        composition.editor.setTransformPreview(undefined);
      }
      return;
    }
    const panel = FOCUS_PANEL_BY_ID[id];
    if (panel !== undefined) {
      context.focusPanel(panel);
    }
  };
}
