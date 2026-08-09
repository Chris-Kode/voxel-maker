/**
 * Injected editor context port (plan S11.14): the desktop composition root
 * supplies runtime snapshots (selection, active clip, tool state) through
 * this narrow interface. The `agent` package never imports editor
 * implementation code; snapshots are plain JSON-shaped values validated
 * against the open document on every tool call, so stale or malicious port
 * state can never reach other tools.
 */

/** A node, voxel, or region selection entry from the editor runtime. */
export type EditorSelectionSnapshot =
  | { readonly kind: "node"; readonly nodeId: string }
  | {
      readonly kind: "voxel";
      readonly volumeId: string;
      readonly voxel: readonly [number, number, number];
    }
  | {
      readonly kind: "region";
      readonly volumeId: string;
      readonly region: {
        readonly min: readonly [number, number, number];
        readonly max: readonly [number, number, number];
      };
    };

/**
 * Runtime editor context (plan S11.14). The desktop app implements this
 * port from its `EditorStore`; the agent package consumes only the
 * snapshots. When no port is installed, selection tools report
 * `available: false` instead of failing, so headless sessions stay
 * deterministic.
 */
export interface EditorContextPort {
  /** Current selection snapshot; empty when nothing is selected. */
  getSelection(): readonly EditorSelectionSnapshot[];
}

/** The neutral port type consumed by the agent package. */
export type { EditorSelectionSnapshot as EditorSelection };
