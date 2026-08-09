import { WorkspaceError, type MaterialId } from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import { removeBatchCommand, setBatchCommand } from "@voxel-maker/commands";
import { segmentCoordinates } from "@voxel-maker/voxel";
import type { EditorStore } from "./runtime.js";
import {
  missingActiveMaterial,
  noActiveMaterial,
  sessionNotOpen,
} from "./tool-errors.js";
import type {
  ToolActionResult,
  ToolDraft,
  ToolHost,
  ToolModifiers,
} from "./types.js";

/**
 * Pencil, erase, and paint tools (plan S7.3/S7.5 ticket #17, S7.6 ticket
 * #18).
 *
 * A stroke gesture is: pointer down (pick the first voxel and pin its
 * volume), pointer moves (rasterize gap-free segments into the draft),
 * pointer up (construct one registered batch command and commit it as one
 * labeled, atomic, undoable transaction). Pointer cancel or an explicit
 * reset discards the draft and commits nothing, so the semantic state
 * after a cancelled or lost pointer is exactly the pre-gesture state.
 *
 * The tool never mutates semantic state itself: it reads the immutable
 * store, keeps a transient preview in the editor store, and hands exactly
 * one command to the host on commit.
 *
 * - Pencil strokes pin the active material at gesture start and paint
 *   every voxel of the rasterized path (creating voxels).
 * - Erase strokes carry no material and remove every voxel of the path.
 * - Paint strokes pin the active material and recolor only occupied path
 *   voxels whose material differs from it; empty stretches and
 *   already-matching voxels never enter the draft. A paint stroke that
 *   changes nothing commits no transaction.
 */

export interface StrokeToolOptions {
  readonly kind: "pencil" | "erase" | "paint";
  readonly host: ToolHost;
  /** Runtime store the tool reads (active material) and previews into. */
  readonly editor: EditorStore;
}

export interface StrokeTool {
  readonly id: "pencil" | "erase" | "paint";
  /** True while a stroke gesture is in progress. */
  readonly active: boolean;
  readonly draft: ToolDraft | undefined;
  pointerDown(
    clientX: number,
    clientY: number,
    modifiers?: ToolModifiers,
  ): ToolActionResult;
  pointerMove(clientX: number, clientY: number): ToolActionResult;
  pointerUp(): ToolActionResult;
  pointerCancel(): void;
  /** Discards any in-progress stroke (lifecycle replacement, tests). */
  reset(): void;
}

const DRAW_LABEL = "Draw stroke" as const;
const ERASE_LABEL = "Erase stroke" as const;
const PAINT_LABEL = "Paint stroke" as const;

function voxelKey(voxel: Vec3i): string {
  return `${String(voxel[0])},${String(voxel[1])},${String(voxel[2])}`;
}

class StrokeToolImpl implements StrokeTool {
  readonly kind: "pencil" | "erase" | "paint";

  get id(): "pencil" | "erase" | "paint" {
    return this.kind;
  }
  readonly #host: ToolHost;
  readonly #editor: EditorStore;
  #volumeId: ToolDraft["volumeId"] | undefined;
  #voxels: Vec3i[] = [];
  /** Key set kept in lockstep with #voxels for O(1) dedupe per move. */
  #voxelKeys = new Set<string>();
  #material: MaterialId | undefined;
  #active = false;

  constructor(options: StrokeToolOptions) {
    this.kind = options.kind;
    this.#host = options.host;
    this.#editor = options.editor;
  }

  get active(): boolean {
    return this.#active;
  }

  get draft(): ToolDraft | undefined {
    if (!this.#active || this.#volumeId === undefined) return undefined;
    // The voxel array is a live view owned by the tool for the duration of
    // the gesture; consumers must read it between notifications and never
    // retain or mutate it (the draft object is replaced on every update).
    return {
      volumeId: this.#volumeId,
      voxels: this.#voxels,
      material: this.#material,
    };
  }

  pointerDown(clientX: number, clientY: number): ToolActionResult {
    // A second down while a stroke is captured is a no-op (safety).
    if (this.#active) return { ok: true };
    const store = this.#host.store;
    if (store === undefined) return { ok: false, error: sessionNotOpen() };
    if (this.kind === "pencil" || this.kind === "paint") {
      const material = this.#editor.activeMaterial;
      if (material === undefined) {
        return { ok: false, error: noActiveMaterial() };
      }
      if (store.getDocument().materials[material] === undefined) {
        return { ok: false, error: missingActiveMaterial(material) };
      }
      this.#material = material;
    }
    const hit = this.#host.pick(clientX, clientY);
    if (hit === undefined) return { ok: true };
    this.#volumeId = hit.volumeId;
    this.#active = true;
    if (
      this.kind !== "paint" ||
      this.#paintChangesVoxel(
        this.#host,
        this.#volumeId,
        hit.voxel,
        this.#material,
      )
    ) {
      this.#voxels = [hit.voxel];
      this.#voxelKeys = new Set([voxelKey(hit.voxel)]);
    } else {
      this.#voxels = [];
      this.#voxelKeys = new Set();
    }
    this.#editor.setDraft(this.draft);
    return { ok: true };
  }

  pointerMove(clientX: number, clientY: number): ToolActionResult {
    if (!this.#active || this.#volumeId === undefined) return { ok: true };
    const hit = this.#host.pick(clientX, clientY);
    if (hit === undefined) return { ok: true };
    // A stroke paints only the volume it started on: picks over other
    // volumes are ignored (deterministic, no accidental cross-node paint).
    if (hit.volumeId !== this.#volumeId) return { ok: true };
    const last = this.#voxels[this.#voxels.length - 1];
    if (last === undefined) return { ok: true };
    if (voxelKey(last) === voxelKey(hit.voxel)) return { ok: true };
    const remaining = this.#host.maxGestureVoxels - this.#voxels.length;
    let segment: readonly Vec3i[];
    try {
      segment = segmentCoordinates(last, hit.voxel, remaining);
    } catch (error) {
      if (error instanceof WorkspaceError) {
        // The stroke cannot fit the budget: cancel it atomically so no
        // partial preview or commit survives.
        this.reset();
        return { ok: false, error };
      }
      throw error;
    }
    for (const voxel of segment) {
      const key = voxelKey(voxel);
      if (this.#voxelKeys.has(key)) continue;
      if (
        this.kind === "paint" &&
        !this.#paintChangesVoxel(
          this.#host,
          this.#volumeId,
          voxel,
          this.#material,
        )
      ) {
        // Paint recolors only occupied path voxels whose material differs
        // from the pinned material; everything else never enters the draft
        // (the preview shows exactly the change that will commit).
        this.#voxelKeys.add(key);
        continue;
      }
      this.#voxelKeys.add(key);
      this.#voxels.push(voxel);
    }
    this.#editor.setDraft(this.draft);
    return { ok: true };
  }

  pointerUp(): ToolActionResult {
    if (!this.#active || this.#volumeId === undefined) return { ok: true };
    const volumeId = this.#volumeId;
    const voxels = this.#voxels;
    const material = this.#material;
    // End the gesture before committing so a rejected commit leaves no
    // preview behind and the semantic state stays untouched (atomicity).
    this.reset();
    if (this.kind === "pencil" && material !== undefined) {
      const command = setBatchCommand(this.#host.nextCommandId(), {
        volumeId,
        entries: voxels.map((coordinate) => ({ coordinate, material })),
      });
      const error = this.#host.commit([command], DRAW_LABEL);
      if (error !== undefined) return { ok: false, error };
      return { ok: true };
    }
    if (this.kind === "paint" && material !== undefined) {
      // Re-check every draft voxel against the live store: the document
      // may have changed mid-gesture (a stroke never commits a stale
      // paint). A paint stroke that changes nothing commits nothing.
      const store = this.#host.store;
      const entries: { coordinate: Vec3i; material: MaterialId }[] = [];
      for (const coordinate of voxels) {
        if (
          store !== undefined &&
          this.#paintChangesVoxel(this.#host, volumeId, coordinate, material)
        ) {
          entries.push({ coordinate, material });
        }
      }
      if (entries.length === 0) return { ok: true };
      const command = setBatchCommand(this.#host.nextCommandId(), {
        volumeId,
        entries,
      });
      const error = this.#host.commit([command], PAINT_LABEL);
      if (error !== undefined) return { ok: false, error };
      return { ok: true };
    }
    const command = removeBatchCommand(this.#host.nextCommandId(), {
      volumeId,
      coordinates: voxels,
    });
    const error = this.#host.commit([command], ERASE_LABEL);
    if (error !== undefined) return { ok: false, error };
    return { ok: true };
  }

  pointerCancel(): void {
    this.reset();
  }

  /**
   * True when a paint stroke would change the voxel: it must be occupied
   * and carry a material different from the pinned one. Reads the live
   * store, so the draft and the commit agree even when the document
   * changes mid-gesture.
   */
  #paintChangesVoxel(
    host: ToolHost,
    volumeId: ToolDraft["volumeId"],
    voxel: Vec3i,
    material: MaterialId | undefined,
  ): boolean {
    const store = host.store;
    if (store === undefined || material === undefined) return false;
    const current = store.getVoxel(volumeId, voxel);
    return current !== 0 && current !== material;
  }

  reset(): void {
    this.#active = false;
    this.#volumeId = undefined;
    this.#voxels = [];
    this.#voxelKeys.clear();
    this.#material = undefined;
    this.#editor.setDraft(undefined);
  }
}

/** Creates a pencil or erase stroke tool for one composition. */
export function createStrokeTool(options: StrokeToolOptions): StrokeTool {
  return new StrokeToolImpl(options);
}
