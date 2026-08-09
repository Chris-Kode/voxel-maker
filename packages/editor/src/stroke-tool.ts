import { WorkspaceError, type MaterialId } from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import { removeBatchCommand, setBatchCommand } from "@voxel-maker/commands";
import { segmentCoordinates } from "@voxel-maker/voxel";
import type { EditorStore } from "./runtime.js";
import type { StrokeDraft, StrokeToolHost, ToolActionResult } from "./types.js";

/**
 * Pencil and erase tools (plan S7.3/S7.5, ticket #17).
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
 * one command to the host on commit. Pencil strokes pin the active
 * material at gesture start; erase strokes carry no material.
 */

export interface StrokeToolOptions {
  readonly kind: "pencil" | "erase";
  readonly host: StrokeToolHost;
  /** Runtime store the tool reads (active material) and previews into. */
  readonly editor: EditorStore;
}

export interface StrokeTool {
  readonly kind: "pencil" | "erase";
  /** True while a stroke gesture is in progress. */
  readonly active: boolean;
  readonly draft: StrokeDraft | undefined;
  pointerDown(clientX: number, clientY: number): ToolActionResult;
  pointerMove(clientX: number, clientY: number): ToolActionResult;
  pointerUp(): ToolActionResult;
  pointerCancel(): void;
  /** Discards any in-progress stroke (lifecycle replacement, tests). */
  reset(): void;
}

const DRAW_LABEL = "Draw stroke" as const;
const ERASE_LABEL = "Erase stroke" as const;

const sessionNotOpen = (): WorkspaceError =>
  new WorkspaceError({
    family: "conflict",
    code: "SESSION_NOT_OPEN",
    message: "No document is open",
  });

const noActiveMaterial = (): WorkspaceError =>
  new WorkspaceError({
    family: "validation",
    code: "NO_ACTIVE_MATERIAL",
    message: "Select an active material before drawing",
  });

const missingActiveMaterial = (material: MaterialId): WorkspaceError =>
  new WorkspaceError({
    family: "validation",
    code: "MISSING_MATERIAL",
    message: "The active material no longer exists",
    context: { materialId: material },
  });

function voxelKey(voxel: Vec3i): string {
  return `${String(voxel[0])},${String(voxel[1])},${String(voxel[2])}`;
}

class StrokeToolImpl implements StrokeTool {
  readonly kind: "pencil" | "erase";
  readonly #host: StrokeToolHost;
  readonly #editor: EditorStore;
  #volumeId: StrokeDraft["volumeId"] | undefined;
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

  get draft(): StrokeDraft | undefined {
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
    if (this.kind === "pencil") {
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
    this.#voxels = [hit.voxel];
    this.#voxelKeys = new Set([voxelKey(hit.voxel)]);
    this.#active = true;
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
    const remaining = this.#host.maxStrokeVoxels - this.#voxels.length;
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
    // The pencil pins its material at pointer down, so the narrowed
    // `material !== undefined` branch is exactly the pencil branch.
    const command =
      this.kind === "pencil" && material !== undefined
        ? setBatchCommand(this.#host.nextCommandId(), {
            volumeId,
            entries: voxels.map((coordinate) => ({
              coordinate,
              material,
            })),
          })
        : removeBatchCommand(this.#host.nextCommandId(), {
            volumeId,
            coordinates: voxels,
          });
    const error = this.#host.commit(
      [command],
      this.kind === "pencil" ? DRAW_LABEL : ERASE_LABEL,
    );
    if (error !== undefined) return { ok: false, error };
    return { ok: true };
  }

  pointerCancel(): void {
    this.reset();
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
