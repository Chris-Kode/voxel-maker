/**
 * Public entry point for the editor package: runtime-only editor workflows
 * that construct commands. Ticket #15 ships the runtime interaction store;
 * ticket #17 adds the tool contract and the pencil/erase stroke tools.
 */
export {
  createEditorStore,
  firstMaterialId,
  snapshotEditorStore,
  type EditorNotice,
  type EditorStore,
  type EditorStoreSnapshot,
} from "./runtime.js";
export {
  createStrokeTool,
  type StrokeTool,
  type StrokeToolOptions,
} from "./stroke-tool.js";
export {
  type EditorToolId,
  type StrokeDraft,
  type StrokeToolHost,
  type ToolActionResult,
  type ToolPick,
} from "./types.js";
