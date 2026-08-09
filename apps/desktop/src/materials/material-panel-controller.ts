import {
  WorkspaceError,
  commandId,
  createListenerSet,
  materialId,
  transactionId,
  type CommandId,
  type MaterialId,
} from "@voxel-maker/shared";
import type { MaterialRecord } from "@voxel-maker/model";
import {
  createMaterialCommand,
  deleteMaterialCommand,
  updateMaterialCommand,
  type Command,
  type UpdateMaterialPayload,
} from "@voxel-maker/commands";
import type { DocumentSession } from "@voxel-maker/session";
import {
  countMaterialUsage,
  defaultNewMaterialPayload,
  materialUpdateChanges,
  type EditorStore,
  type MaterialFieldChanges,
} from "@voxel-maker/editor";

/**
 * Material panel controller (plan S7.13, ticket #21): the headless seam
 * between the desktop materials panel and the session command bus. Every
 * panel action — create, update, referenced delete with reassignment,
 * paint-with, undo, and redo — compiles to the registered `material.*`
 * commands and commits through the bus as one labeled, atomic, undoable
 * transaction, or returns a structured error that the shell surfaces as a
 * runtime notice. The controller never mutates semantic state itself and
 * holds no UI state: it subscribes to the session lifecycle, the
 * authoritative store, and the editor store, and exposes a frozen
 * snapshot (`state`) the React component renders.
 */

/** One material row: the committed record plus its live voxel usage. */
export interface MaterialPanelEntry {
  readonly record: MaterialRecord;
  /** Number of voxels across all volumes referencing the material. */
  readonly usage: number;
}

/** Frozen panel snapshot; recomputed on every relevant event. */
export interface MaterialPanelState {
  /** True when a document is open (the panel is inert otherwise). */
  readonly open: boolean;
  /** Materials in ascending id order with live usage counts. */
  readonly entries: readonly MaterialPanelEntry[];
  /** The runtime paint material, when one is active. */
  readonly activeMaterial: MaterialId | undefined;
  /** False at the document material limit or with no document open. */
  readonly canCreate: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface MaterialPanelController {
  readonly state: MaterialPanelState;
  /** Subscribes to state changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Creates the next free material with bounded defaults and makes it the
   * active paint material. Returns the error, or undefined on success.
   */
  createMaterial(): WorkspaceError | undefined;
  /**
   * Merges the changed fields of one material through `material.update`.
   * A changes object that differs in no field commits nothing. Returns
   * the error, or undefined on success.
   */
  updateMaterial(
    materialId: MaterialId,
    changes: MaterialFieldChanges,
  ): WorkspaceError | undefined;
  /**
   * Deletes a material; a referenced material requires an explicit valid
   * replacement so no voxel can dangle (docs/commands/materials.md).
   * Returns the error, or undefined on success.
   */
  deleteMaterial(
    materialId: MaterialId,
    replacement?: MaterialId,
  ): WorkspaceError | undefined;
  /**
   * Valid reassignment choices for a referenced delete of the material:
   * every other material id in ascending order. Computed on demand (the
   * delete flow only) so the panel snapshot stays linear in the material
   * count even at the 4,096-material document limit.
   */
  replacementCandidates(materialId: MaterialId): readonly MaterialId[];
  /** Makes a material the runtime paint material (paint/eyedropper). */
  paintWith(materialId: MaterialId): void;
  /** Undoes the most recent transaction; returns the error, if any. */
  undo(): WorkspaceError | undefined;
  /** Redoes the most recently undone transaction; returns the error, if any. */
  redo(): WorkspaceError | undefined;
  dispose(): void;
}

export interface MaterialPanelControllerOptions {
  readonly session: DocumentSession;
  readonly editor: EditorStore;
}

class MaterialPanelControllerImpl implements MaterialPanelController {
  readonly #session: DocumentSession;
  readonly #editor: EditorStore;
  #state: MaterialPanelState = emptyState();
  #commandSequence = 0;
  #transactionSequence = 0;
  /**
   * Monotonic id watermark for this session (ARCHITECTURE.md
   * "Materials"): ids are never reused while reachable history or
   * recovery records can mention them, so the panel allocates ids
   * strictly above every id seen since the document (or replacement)
   * installed. Reset on lifecycle events; reseeded from the live table.
   */
  #maxMaterialIdSeen = 0;
  #unsubscribeSession: () => void;
  #unsubscribeEditor: () => void;
  #unsubscribeStore: (() => void) | undefined;
  readonly #listeners = createListenerSet<undefined>();

  constructor(options: MaterialPanelControllerOptions) {
    this.#session = options.session;
    this.#editor = options.editor;

    this.#unsubscribeSession = this.#session.subscribe((event) => {
      // Fresh install: the previous document's history is unreachable
      // (ADR-0003), so the allocation watermark restarts from the new
      // table and #refresh reseeds it.
      this.#maxMaterialIdSeen = 0;
      if (
        event.kind === "document-opened" ||
        event.kind === "document-replaced"
      ) {
        this.#unsubscribeStore?.();
        this.#unsubscribeStore = event.store.subscribe(() => {
          this.#refresh();
        });
      } else {
        this.#unsubscribeStore?.();
        this.#unsubscribeStore = undefined;
      }
      this.#refresh();
    });

    // Active-material changes (paintWith, eyedropper sampling, pruning)
    // refresh the panel selection highlight.
    this.#unsubscribeEditor = this.#editor.subscribe(() => {
      this.#refresh();
    });

    this.#refresh();
  }

  get state(): MaterialPanelState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    return this.#listeners.add(listener);
  }

  createMaterial(): WorkspaceError | undefined {
    const current = this.#session.current;
    if (current === undefined) return this.#fail(this.#notOpen());
    const document = current.store.getDocument();
    if (
      Object.keys(document.materials).length >=
      current.store.limits.maxMaterials
    ) {
      return this.#fail(this.#limitExceeded(current.store.limits.maxMaterials));
    }
    if (this.#maxMaterialIdSeen >= 65_535) {
      return this.#fail(this.#limitExceeded(65_535));
    }
    const id = materialId(this.#maxMaterialIdSeen + 1);
    const error = this.#execute(
      [
        createMaterialCommand(
          this.#nextCommandId(),
          defaultNewMaterialPayload(id),
        ),
      ],
      "Create material",
    );
    // The fresh material is immediately paintable (plan S7.6/S7.13), and
    // the watermark only advances on success so a rejected create never
    // burns an id.
    if (error === undefined) {
      this.#maxMaterialIdSeen = id;
      this.#editor.setActiveMaterial(id);
    }
    return error;
  }

  updateMaterial(
    materialId: MaterialId,
    changes: MaterialFieldChanges,
  ): WorkspaceError | undefined {
    const current = this.#session.current;
    if (current === undefined) return this.#fail(this.#notOpen());
    const record = current.store.getDocument().materials[materialId];
    if (record === undefined)
      return this.#fail(this.#missingMaterial(materialId));
    let payload: UpdateMaterialPayload | undefined;
    try {
      // Canonicalization (e.g. a malformed color) throws; the panel's
      // contract is a structured error, never an exception.
      payload = materialUpdateChanges(record, changes);
    } catch (error) {
      if (error instanceof WorkspaceError) return this.#fail(error);
      throw error;
    }
    if (payload === undefined) return undefined; // nothing changed: no commit
    return this.#execute(
      [updateMaterialCommand(this.#nextCommandId(), payload)],
      "Update material",
    );
  }

  deleteMaterial(
    materialId: MaterialId,
    replacement?: MaterialId,
  ): WorkspaceError | undefined {
    const current = this.#session.current;
    if (current === undefined) return this.#fail(this.#notOpen());
    const document = current.store.getDocument();
    if (document.materials[materialId] === undefined) {
      return this.#fail(this.#missingMaterial(materialId));
    }
    // Fast-path feedback for the panel flow; the bus re-validates and
    // rejects an invalid replacement atomically (REFERENCED_MATERIAL /
    // INVALID_REPLACEMENT), so a dangling reference can never commit.
    const usage = countMaterialUsage(current.store).get(materialId) ?? 0;
    if (usage > 0 && replacement === undefined) {
      return this.#fail(
        new WorkspaceError({
          family: "validation",
          code: "REFERENCED_MATERIAL",
          message: `Material ${String(materialId)} is used by ${String(usage)} voxel(s); choose a replacement material to delete it`,
        }),
      );
    }
    return this.#execute(
      [
        deleteMaterialCommand(this.#nextCommandId(), {
          materialId,
          ...(replacement === undefined ? {} : { replacement }),
        }),
      ],
      "Delete material",
    );
  }

  replacementCandidates(materialId: MaterialId): readonly MaterialId[] {
    const document = this.#session.current?.store.getDocument();
    if (document === undefined) return [];
    return Object.keys(document.materials)
      .map((key) => Number(key) as MaterialId)
      .filter((id) => id !== materialId)
      .sort((a, b) => a - b);
  }

  paintWith(materialId: MaterialId): void {
    const document = this.#session.current?.store.getDocument();
    if (
      document !== undefined &&
      document.materials[materialId] !== undefined
    ) {
      this.#editor.setActiveMaterial(materialId);
    }
  }

  undo(): WorkspaceError | undefined {
    return this.#history("undo");
  }

  redo(): WorkspaceError | undefined {
    return this.#history("redo");
  }

  dispose(): void {
    this.#unsubscribeSession();
    this.#unsubscribeEditor();
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = undefined;
  }

  /**
   * Runs one labeled transaction through the session bus. The store's
   * committed event fires during the commit — before the bus's history
   * bookkeeping — so the event-driven refresh cannot see the new
   * undo/redo availability yet; a post-commit refresh keeps `canUndo` /
   * `canRedo` exact.
   */
  #execute(
    commands: readonly Command[],
    label: string,
  ): WorkspaceError | undefined {
    const current = this.#session.current;
    if (current === undefined) return this.#fail(this.#notOpen());
    this.#transactionSequence += 1;
    const result = current.bus.executeTransaction(commands, {
      transactionId: transactionId(
        `transaction:panel:${String(this.#transactionSequence)}`,
      ),
      expectedRevision: current.store.revision,
      source: "ui",
      label,
    });
    if (result.ok) {
      this.#refresh();
      return undefined;
    }
    this.#report(result.error);
    return result.error;
  }

  #history(kind: "undo" | "redo"): WorkspaceError | undefined {
    const current = this.#session.current;
    if (current === undefined) return this.#fail(this.#notOpen());
    this.#transactionSequence += 1;
    const result = current.bus[kind]({
      transactionId: transactionId(
        `transaction:panel:${String(this.#transactionSequence)}`,
      ),
      expectedRevision: current.store.revision,
      source: "ui",
    });
    if (result.ok) {
      this.#refresh();
      return undefined;
    }
    this.#report(result.error);
    return result.error;
  }

  #refresh(): void {
    const current = this.#session.current;
    const document = current?.store.getDocument();
    const usage =
      current === undefined ? undefined : countMaterialUsage(current.store);
    const entries: MaterialPanelEntry[] = [];
    if (document !== undefined && usage !== undefined) {
      const ids = Object.keys(document.materials)
        .map((key) => Number(key) as MaterialId)
        .sort((a, b) => a - b);
      for (const id of ids) {
        const record = document.materials[id];
        if (record === undefined) continue; // keys come from the table itself
        // Reseed the watermark from the live table so ids of a loaded or
        // recovered document are never handed out again this session.
        if (id > this.#maxMaterialIdSeen) this.#maxMaterialIdSeen = id;
        entries.push({ record, usage: usage.get(id) ?? 0 });
      }
    }
    this.#state = {
      open: current !== undefined,
      entries,
      activeMaterial: this.#editor.activeMaterial,
      canCreate:
        current !== undefined &&
        document !== undefined &&
        Object.keys(document.materials).length <
          current.store.limits.maxMaterials,
      canUndo: current?.bus.canUndo() ?? false,
      canRedo: current?.bus.canRedo() ?? false,
    };
    this.#listeners.emit(undefined);
  }

  #nextCommandId(): CommandId {
    this.#commandSequence += 1;
    return commandId(`command:panel:${String(this.#commandSequence)}`);
  }

  #fail(error: WorkspaceError): WorkspaceError {
    this.#report(error);
    return error;
  }

  #report(error: WorkspaceError): void {
    this.#editor.pushNotice("error", error.message);
  }

  #notOpen(): WorkspaceError {
    return new WorkspaceError({
      family: "conflict",
      code: "SESSION_NOT_OPEN",
      message: "No document is open",
    });
  }

  #missingMaterial(materialId: MaterialId): WorkspaceError {
    return new WorkspaceError({
      family: "validation",
      code: "MISSING_MATERIAL",
      message: `Material ${String(materialId)} is not in the document`,
    });
  }

  #limitExceeded(limit: number): WorkspaceError {
    return new WorkspaceError({
      family: "limit",
      code: "LIMIT_EXCEEDED",
      message: `The document has reached its ${String(limit)}-material limit`,
    });
  }
}

function emptyState(): MaterialPanelState {
  return {
    open: false,
    entries: [],
    activeMaterial: undefined,
    canCreate: false,
    canUndo: false,
    canRedo: false,
  };
}

/** Creates the headless material panel controller for one composition. */
export function createMaterialPanelController(
  options: MaterialPanelControllerOptions,
): MaterialPanelController {
  return new MaterialPanelControllerImpl(options);
}
