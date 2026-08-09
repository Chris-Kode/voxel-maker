import type { EditorStore } from "./runtime.js";
import type { ToolHost, ToolActionResult } from "./types.js";

/**
 * Eyedropper tool (plan S7.6, ticket #18): a read-only material sample.
 *
 * A primary-button click picks the nearest voxel and copies its material
 * into `EditorStore.activeMaterial` — the paint material used by the
 * pencil, paint, and shape tools. Sampling never constructs a command,
 * never commits a transaction, and never touches semantic state: it only
 * reads the authoritative store and updates runtime state. Sampling an
 * empty voxel is a no-op (there is no material to copy), and because the
 * sampled material is referenced by an existing voxel it can never be a
 * deleted material id. Pointer moves, cancels, and releases are no-ops;
 * the tool has no gesture, no draft, and no history entry.
 */

export interface EyedropperToolOptions {
  readonly host: ToolHost;
  /** Runtime store the tool writes the sampled material into. */
  readonly editor: EditorStore;
}

export interface EyedropperTool {
  readonly id: "eyedropper";
  /** Always false: the eyedropper never captures a gesture. */
  readonly active: boolean;
  readonly draft: undefined;
  pointerDown(clientX: number, clientY: number): ToolActionResult;
  pointerMove(clientX: number, clientY: number): ToolActionResult;
  pointerUp(): ToolActionResult;
  pointerCancel(): void;
  reset(): void;
}

class EyedropperToolImpl implements EyedropperTool {
  readonly id = "eyedropper" as const;
  readonly #host: ToolHost;
  readonly #editor: EditorStore;

  constructor(options: EyedropperToolOptions) {
    this.#host = options.host;
    this.#editor = options.editor;
  }

  get active(): boolean {
    return false;
  }

  get draft(): undefined {
    return undefined;
  }

  pointerDown(clientX: number, clientY: number): ToolActionResult {
    const store = this.#host.store;
    if (store === undefined) return { ok: true };
    const hit = this.#host.pick(clientX, clientY);
    if (hit === undefined) return { ok: true };
    const material = store.getVoxel(hit.volumeId, hit.voxel);
    if (material !== 0) this.#editor.setActiveMaterial(material);
    return { ok: true };
  }

  pointerMove(): ToolActionResult {
    return { ok: true };
  }

  pointerUp(): ToolActionResult {
    return { ok: true };
  }

  pointerCancel(): void {
    // The eyedropper never captures a gesture; nothing to cancel.
  }

  reset(): void {
    // The eyedropper holds no gesture state.
  }
}

/** Creates the read-only eyedropper tool for one composition. */
export function createEyedropperTool(
  options: EyedropperToolOptions,
): EyedropperTool {
  return new EyedropperToolImpl(options);
}
