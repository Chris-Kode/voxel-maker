import { createListenerSet, type NodeId } from "@voxel-maker/shared";

/**
 * Runtime-only editor interaction state (plan S7.1, ARCHITECTURE.md
 * "Editor interaction"): selection, active tool, and notices. None of this
 * is ever persisted or authoritative; the document store and command bus
 * own semantic state. Ticket #15 injects this store into the desktop
 * composition root so tools and panels have one place to read ephemeral
 * interaction state before the full tool workflows land.
 */

export type EditorToolId = "select";

export interface EditorNotice {
  readonly id: number;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

export interface EditorStore {
  readonly activeTool: EditorToolId;
  readonly selection: readonly NodeId[];
  readonly notices: readonly EditorNotice[];
  setActiveTool(tool: EditorToolId): void;
  setSelection(selection: readonly NodeId[]): void;
  pushNotice(level: EditorNotice["level"], message: string): void;
  dismissNotice(id: number): void;
  clearNotices(): void;
  /** Subscribes to runtime state changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface EditorStoreSnapshot {
  readonly activeTool: EditorToolId;
  readonly selection: readonly NodeId[];
  readonly notices: readonly EditorNotice[];
}

/** Creates the runtime interaction store with an empty initial state. */
export function createEditorStore(): EditorStore {
  let activeTool: EditorToolId = "select";
  let selection: readonly NodeId[] = [];
  let notices: EditorNotice[] = [];
  let nextNoticeId = 1;
  const listeners = createListenerSet<undefined>();

  const notify = (): void => {
    listeners.emit(undefined);
  };

  return {
    get activeTool() {
      return activeTool;
    },
    get selection() {
      return selection;
    },
    get notices() {
      return notices;
    },
    setActiveTool(tool) {
      activeTool = tool;
      notify();
    },
    setSelection(next) {
      selection = [...next];
      notify();
    },
    pushNotice(level, message) {
      notices = [...notices, { id: nextNoticeId, level, message }];
      nextNoticeId += 1;
      notify();
    },
    dismissNotice(id) {
      notices = notices.filter((notice) => notice.id !== id);
      notify();
    },
    clearNotices() {
      notices = [];
      notify();
    },
    subscribe(listener) {
      return listeners.add(listener);
    },
  };
}

/** Freezes a snapshot for React-style external stores. */
export function snapshotEditorStore(store: EditorStore): EditorStoreSnapshot {
  return {
    activeTool: store.activeTool,
    selection: [...store.selection],
    notices: [...store.notices],
  };
}
