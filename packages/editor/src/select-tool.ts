import type { VolumeId } from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import type { EditorStore } from "./runtime.js";
import { applySelectionIntent, spanRegion } from "./selection.js";
import type {
  SelectionEntry,
  ToolHost,
  ToolActionResult,
  ToolModifiers,
} from "./types.js";

/**
 * Select tool (plan S7.2/S7.4, ticket #18): node, voxel, and region
 * selection over the runtime `EditorStore.selection`.
 *
 * The granularity is the runtime `editor.selectionMode`:
 *
 * - **Node mode**: a click selects the picked voxel's node; a miss clears
 *   the selection (plain click), or leaves it untouched (Shift/Ctrl click).
 * - **Voxel mode**: a click selects the picked voxel itself; a miss clears
 *   (plain click) or leaves it untouched (Shift/Ctrl click).
 * - **Region mode**: a drag from the anchor voxel to the current voxel
 *   previews the half-open region they span (`editor.regionDraft`) and,
 *   on release, selects the region.
 *
 * Modifier intent is explicit: a plain click replaces the selection,
 * Shift adds the target, Ctrl/Cmd toggles its membership, and the select
 * tool never mutates semantic state. Clicking in node/voxel modes is
 * resolved through `click` (the desktop controller calls it after a
 * pointer-up that did not move); the region drag uses the full gesture
 * lifecycle. Lifecycle replacement resets the tool exactly like the other
 * tools.
 */

export interface SelectToolOptions {
  readonly host: ToolHost;
  /** Runtime store that owns the selection and the selection mode. */
  readonly editor: EditorStore;
}

export interface SelectTool {
  readonly id: "select";
  /** True while a region-select drag is in progress. */
  readonly active: boolean;
  readonly draft: undefined;
  /**
   * Resolves one click at viewport coordinates against the selection
   * (node/voxel modes): picks, applies replace/add/toggle intent, and
   * never mutates semantic state.
   */
  click(
    clientX: number,
    clientY: number,
    modifiers?: ToolModifiers,
  ): ToolActionResult;
  pointerDown(
    clientX: number,
    clientY: number,
    modifiers?: ToolModifiers,
  ): ToolActionResult;
  pointerMove(clientX: number, clientY: number): ToolActionResult;
  pointerUp(): ToolActionResult;
  pointerCancel(): void;
  reset(): void;
}

const entryFor = (
  mode: SelectToolOptions["editor"]["selectionMode"],
  pick: NonNullable<ReturnType<ToolHost["pick"]>>,
): SelectionEntry =>
  mode === "node"
    ? { kind: "node", nodeId: pick.nodeId }
    : { kind: "voxel", volumeId: pick.volumeId, voxel: pick.voxel };

class SelectToolImpl implements SelectTool {
  readonly id = "select" as const;
  readonly #host: ToolHost;
  readonly #editor: EditorStore;
  #anchorVolumeId: VolumeId | undefined;
  #anchorVoxel: Vec3i | undefined;
  #currentVoxel: Vec3i | undefined;
  #modifiers: ToolModifiers = { additive: false, toggle: false };
  /** True when a region-mode click missed (clear-on-up parity). */
  #pendingMiss = false;
  #active = false;

  constructor(options: SelectToolOptions) {
    this.#host = options.host;
    this.#editor = options.editor;
  }

  get active(): boolean {
    return this.#active;
  }

  get draft(): undefined {
    return undefined;
  }

  click(
    clientX: number,
    clientY: number,
    modifiers: ToolModifiers = { additive: false, toggle: false },
  ): ToolActionResult {
    const store = this.#host.store;
    if (store === undefined) return { ok: true };
    const hit = this.#host.pick(clientX, clientY);
    const entry =
      hit === undefined ? undefined : entryFor(this.#editor.selectionMode, hit);
    this.#editor.setSelection(
      applySelectionIntent(this.#editor.selection, entry, modifiers),
    );
    return { ok: true };
  }

  pointerDown(
    clientX: number,
    clientY: number,
    modifiers: ToolModifiers = { additive: false, toggle: false },
  ): ToolActionResult {
    // Node/voxel modes resolve clicks through `click` (the desktop
    // controller owns the orbit gesture); only the region drag uses the
    // gesture lifecycle.
    if (this.#editor.selectionMode !== "region") return { ok: true };
    if (this.#active) return { ok: true };
    const hit = this.#host.pick(clientX, clientY);
    if (hit === undefined) {
      // A region-mode click on empty space clears the selection like the
      // node/voxel modes do (plain click), or leaves it untouched with
      // Shift/Ctrl; the pending miss resolves at pointer-up.
      this.#modifiers = modifiers;
      this.#pendingMiss = true;
      return { ok: true };
    }
    this.#anchorVolumeId = hit.volumeId;
    this.#anchorVoxel = [...hit.voxel];
    this.#currentVoxel = [...hit.voxel];
    this.#modifiers = modifiers;
    this.#active = true;
    this.#publishRegionDraft([...hit.voxel]);
    return { ok: true };
  }

  pointerUp(): ToolActionResult {
    if (this.#pendingMiss) {
      // A click on empty space: plain click clears, modified clicks leave
      // the selection untouched (same intent table as node/voxel modes).
      const modifiers = this.#modifiers;
      this.reset();
      this.#editor.setSelection(
        applySelectionIntent(this.#editor.selection, undefined, modifiers),
      );
      return { ok: true };
    }
    if (!this.#active || this.#anchorVolumeId === undefined) {
      return { ok: true };
    }
    if (this.#anchorVoxel === undefined) return { ok: true };
    const volumeId = this.#anchorVolumeId;
    const anchor = this.#anchorVoxel;
    const current = this.#currentVoxel ?? anchor;
    // Capture the gesture modifiers before reset clears them.
    const modifiers = this.#modifiers;
    this.reset();
    const entry: SelectionEntry = {
      kind: "region",
      volumeId,
      region: spanRegion(anchor, current),
    };
    this.#editor.setSelection(
      applySelectionIntent(this.#editor.selection, entry, modifiers),
    );
    return { ok: true };
  }

  pointerMove(clientX: number, clientY: number): ToolActionResult {
    if (!this.#active || this.#anchorVolumeId === undefined) {
      return { ok: true };
    }
    const hit = this.#host.pick(clientX, clientY);
    if (hit === undefined) return { ok: true };
    // A region drag stays in the volume it started on.
    if (hit.volumeId !== this.#anchorVolumeId) return { ok: true };
    this.#currentVoxel = [...hit.voxel];
    this.#publishRegionDraft([...hit.voxel]);
    return { ok: true };
  }

  pointerCancel(): void {
    this.reset();
  }

  reset(): void {
    this.#active = false;
    this.#anchorVolumeId = undefined;
    this.#anchorVoxel = undefined;
    this.#currentVoxel = undefined;
    this.#pendingMiss = false;
    this.#modifiers = { additive: false, toggle: false };
    this.#editor.setRegionDraft(undefined);
  }

  /** Publishes the half-open region spanned by anchor and current. */
  #publishRegionDraft(voxel: Vec3i): void {
    const anchor = this.#anchorVoxel;
    const volumeId = this.#anchorVolumeId;
    if (anchor === undefined || volumeId === undefined) return;
    this.#editor.setRegionDraft({
      volumeId,
      region: spanRegion(anchor, voxel),
    });
  }
}

/** Creates the select tool for one composition. */
export function createSelectTool(options: SelectToolOptions): SelectTool {
  return new SelectToolImpl(options);
}
