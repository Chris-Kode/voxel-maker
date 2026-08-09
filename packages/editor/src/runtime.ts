import {
  createListenerSet,
  materialId,
  type MaterialId,
  type NodeId,
} from "@voxel-maker/shared";
import type { VoxelDocument } from "@voxel-maker/model";
import type { EditorToolId, StrokeDraft } from "./types.js";

/**
 * Runtime-only editor interaction state (plan S7.1, ARCHITECTURE.md
 * "Editor interaction"): selection, active tool, active material, draft
 * gesture preview, and notices. None of this is ever persisted or
 * authoritative; the document store and command bus own semantic state.
 * Ticket #15 ships the store, ticket #17 adds the pencil/erase tool state.
 */

export interface EditorNotice {
  readonly id: number;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

export interface EditorStore {
  readonly activeTool: EditorToolId;
  /** Runtime-only active paint material; undefined when none is usable. */
  readonly activeMaterial: MaterialId | undefined;
  /** Transient in-progress stroke preview; undefined outside a gesture. */
  readonly draft: StrokeDraft | undefined;
  readonly selection: readonly NodeId[];
  readonly notices: readonly EditorNotice[];
  setActiveTool(tool: EditorToolId): void;
  setActiveMaterial(material: MaterialId | undefined): void;
  setDraft(draft: StrokeDraft | undefined): void;
  setSelection(selection: readonly NodeId[]): void;
  pushNotice(level: EditorNotice["level"], message: string): void;
  dismissNotice(id: number): void;
  clearNotices(): void;
  /** Subscribes to runtime state changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface EditorStoreSnapshot {
  readonly activeTool: EditorToolId;
  readonly activeMaterial: MaterialId | undefined;
  readonly draft: StrokeDraft | undefined;
  readonly selection: readonly NodeId[];
  readonly notices: readonly EditorNotice[];
}

/** Creates the runtime interaction store with an empty initial state. */
export function createEditorStore(): EditorStore {
  let activeTool: EditorToolId = "select";
  let activeMaterial: MaterialId | undefined;
  let draft: StrokeDraft | undefined;
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
    get activeMaterial() {
      return activeMaterial;
    },
    get draft() {
      return draft;
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
    setActiveMaterial(material) {
      activeMaterial = material;
      notify();
    },
    setDraft(next) {
      draft = next;
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
    activeMaterial: store.activeMaterial,
    draft: store.draft,
    selection: [...store.selection],
    notices: [...store.notices],
  };
}

/**
 * Deterministic default paint material: the lowest material id in the
 * document (record keys are canonical numeric ids), or undefined when the
 * document has no materials. Used by the composition root when a document
 * opens and no active material is set.
 */
export function firstMaterialId(
  document: VoxelDocument,
): MaterialId | undefined {
  const keys = Object.keys(document.materials);
  if (keys.length === 0) return undefined;
  const first = Number(keys[0]);
  return Number.isInteger(first) ? materialId(first) : undefined;
}
