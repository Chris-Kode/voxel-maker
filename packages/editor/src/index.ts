/**
 * Public entry point for the editor package: runtime-only editor workflows
 * that construct commands. Ticket #15 ships the runtime interaction store;
 * tools land with the desktop editing tickets.
 */
export {
  createEditorStore,
  snapshotEditorStore,
  type EditorNotice,
  type EditorStore,
  type EditorStoreSnapshot,
  type EditorToolId,
} from "./runtime.js";
