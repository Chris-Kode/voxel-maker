import {
  createListenerSet,
  materialId,
  type MaterialId,
} from "@voxel-maker/shared";
import type { VoxelDocument } from "@voxel-maker/model";
import type {
  EditorToolId,
  RegionDraft,
  SelectionEntry,
  SelectionMode,
  ToolDraft,
} from "./types.js";

/**
 * Runtime-only editor interaction state (plan S7.1, ARCHITECTURE.md
 * "Editor interaction"): selection, selection mode, active tool, active
 * material, draft gesture preview, and notices. None of this is ever
 * persisted or authoritative; the document store and command bus own
 * semantic state. Ticket #15 ships the store, ticket #17 adds the
 * pencil/erase tool state, ticket #18 adds node/voxel/region selection,
 * the selection mode, and the region-select preview.
 */

export interface EditorNotice {
  readonly id: number;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

export interface EditorStore {
  readonly activeTool: EditorToolId;
  /** Select-tool granularity (plan S7.2/S7.4). */
  readonly selectionMode: SelectionMode;
  /** Runtime-only active paint material; undefined when none is usable. */
  readonly activeMaterial: MaterialId | undefined;
  /** Transient in-progress gesture preview; undefined outside a gesture. */
  readonly draft: ToolDraft | undefined;
  /**
   * Transient in-progress region-select preview (plan S7.2); undefined
   * outside a region drag.
   */
  readonly regionDraft: RegionDraft | undefined;
  /** Runtime-only selection; mixed node/voxel/region entries (S7.2). */
  readonly selection: readonly SelectionEntry[];
  readonly notices: readonly EditorNotice[];
  setActiveTool(tool: EditorToolId): void;
  setSelectionMode(mode: SelectionMode): void;
  setActiveMaterial(material: MaterialId | undefined): void;
  setDraft(draft: ToolDraft | undefined): void;
  setRegionDraft(draft: RegionDraft | undefined): void;
  setSelection(selection: readonly SelectionEntry[]): void;
  pushNotice(level: EditorNotice["level"], message: string): void;
  dismissNotice(id: number): void;
  clearNotices(): void;
  /** Subscribes to runtime state changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface EditorStoreSnapshot {
  readonly activeTool: EditorToolId;
  readonly selectionMode: SelectionMode;
  readonly activeMaterial: MaterialId | undefined;
  readonly draft: ToolDraft | undefined;
  readonly regionDraft: RegionDraft | undefined;
  readonly selection: readonly SelectionEntry[];
  readonly notices: readonly EditorNotice[];
}

/** Creates the runtime interaction store with an empty initial state. */
export function createEditorStore(): EditorStore {
  let activeTool: EditorToolId = "select";
  let selectionMode: SelectionMode = "node";
  let activeMaterial: MaterialId | undefined;
  let draft: ToolDraft | undefined;
  let regionDraft: RegionDraft | undefined;
  let selection: readonly SelectionEntry[] = [];
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
    get selectionMode() {
      return selectionMode;
    },
    get activeMaterial() {
      return activeMaterial;
    },
    get draft() {
      return draft;
    },
    get regionDraft() {
      return regionDraft;
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
    setSelectionMode(mode) {
      selectionMode = mode;
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
    setRegionDraft(next) {
      regionDraft = next;
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
    selectionMode: store.selectionMode,
    activeMaterial: store.activeMaterial,
    draft: store.draft,
    regionDraft: store.regionDraft,
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
