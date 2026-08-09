import type { Command } from "@voxel-maker/commands";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import type { QuarterTurns, ShapeAxis } from "@voxel-maker/voxel";
import type {
  CommandId,
  MaterialId,
  NodeId,
  VolumeId,
  WorkspaceError,
} from "@voxel-maker/shared";

/**
 * Shared editor tool and selection contracts (plan S7.1-S7.4/S7.6/S7.7/
 * S7.19, tickets #17/#18).
 *
 * A tool receives pointer input, reads immutable semantic state, maintains
 * a transient runtime preview, and constructs registered commands on
 * commit (ARCHITECTURE.md "Editor interaction"). The host — the desktop
 * viewport controller — injects picking, commit, and id services so the
 * tool stays headless and deterministic in Node tests. Selection is
 * runtime-only `EditorStore` state (S7.1/S7.2): it never enters the
 * document, history, journal, or saved bytes, and every reference to a
 * deleted node or volume is pruned.
 */

/** Runtime tool selection (plan S7.3/S7.4/S7.6/S7.7/S7.19). */
export type EditorToolId =
  | "select"
  | "pencil"
  | "erase"
  | "paint"
  | "eyedropper"
  | "box"
  | "sphere"
  | "cylinder"
  | "transform";

/** Select-tool granularity (plan S7.2/S7.4): node, voxel, or region. */
export type SelectionMode = "node" | "voxel" | "region";

/**
 * One runtime selection entry (plan S7.2). Entries are immutable, mixed
 * kinds are allowed (multi-selection), and identical entries deduplicate.
 * Node entries name the node; voxel entries name a volume-local voxel;
 * region entries name a half-open volume-local region. Every entry is
 * pruned when its node or volume disappears from the document.
 */
export type SelectionEntry =
  | { readonly kind: "node"; readonly nodeId: NodeId }
  | {
      readonly kind: "voxel";
      readonly volumeId: VolumeId;
      readonly voxel: Vec3i;
    }
  | {
      readonly kind: "region";
      readonly volumeId: VolumeId;
      readonly region: IntAabb;
    };

/**
 * Transient region-select preview (plan S7.2): the half-open volume-local
 * region spanned by the in-progress region drag. Runtime-only, never
 * persisted, discarded on commit, cancel, or lifecycle replacement.
 */
export interface RegionDraft {
  readonly volumeId: VolumeId;
  readonly region: IntAabb;
}

/** Pointer modifiers that alter click/gesture intent (plan S7.2/S7.4). */
export interface ToolModifiers {
  /** Shift held: add the target to the current selection. */
  readonly additive: boolean;
  /** Ctrl/Cmd held: toggle the target's membership in the selection. */
  readonly toggle: boolean;
}

/** The part of a deterministic pick a tool consumes (S6.12). */
export interface ToolPick {
  /** The node that owns the picked volume (S7.4 node selection). */
  readonly nodeId: NodeId;
  readonly volumeId: VolumeId;
  /** Volume-local integer voxel coordinate (may be negative). */
  readonly voxel: Vec3i;
}

/**
 * Services injected into tools by the composition root. `store` is the
 * authoritative read surface of the open document (undefined when none is
 * open) and may change between calls as documents open and close.
 */
export interface ToolHost {
  /** The authoritative read surface of the open document. */
  readonly store: DocumentStoreRead | undefined;
  /**
   * Hard cap on voxels per gesture (ADR-0009: the same budget the batch
   * commands enforce) shared by the stroke and shape tools; a gesture
   * that would exceed it is rejected atomically.
   */
  readonly maxGestureVoxels: number;
  /** Deterministic pick at viewport-relative pointer coordinates. */
  pick(clientX: number, clientY: number): ToolPick | undefined;
  /** Supplies a fresh command id for the next gesture command. */
  nextCommandId(): CommandId;
  /**
   * Atomically executes one labeled transaction and returns the error, or
   * undefined on success. Never partially applies a gesture.
   */
  commit(
    commands: readonly Command[],
    label: string,
  ): WorkspaceError | undefined;
}

/**
 * Transient, non-authoritative tool preview (ARCHITECTURE.md "Editor
 * interaction"): the runtime-only voxel set of the in-progress gesture.
 * It is never persisted, never enters the command bus, and is discarded on
 * commit, cancel, or lifecycle replacement.
 */
export interface ToolDraft {
  readonly volumeId: VolumeId;
  /**
   * Deduplicated volume-local voxels in rasterized order. Live runtime
   * view owned by the tool: read it between editor notifications, never
   * retain or mutate it (the draft object is replaced on every update).
   */
  readonly voxels: readonly Vec3i[];
  /** Pencil/paint: the material the gesture applies; erase: undefined. */
  readonly material: MaterialId | undefined;
}

/**
 * Unified headless tool lifecycle (plan S7.3): pointer input, transient
 * preview state, and one command transaction on commit. Tools never mutate
 * semantic state; cancel or a lost pointer restores the exact pre-gesture
 * state.
 */
export interface Tool {
  readonly id: EditorToolId;
  /** True while a pointer gesture is in progress. */
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
  /** Discards any in-progress gesture (lifecycle replacement, tests). */
  reset(): void;
}

/** Result of one tool input; failures never mutate semantic state. */
export type ToolActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: WorkspaceError };

/**
 * Transform-tool operation modes (plan S7.19, ticket #19): move and copy
 * are drag gestures, rotate/mirror/delete preview on button press and
 * apply on confirmation. The mode is runtime-only `EditorStore` state.
 */
export type TransformMode = "move" | "copy" | "rotate" | "mirror" | "delete";

/**
 * Exact per-entry affected bounds of one transform operation (plan S7.19,
 * ticket #19): the half-open source region the operation reads and the
 * half-open destination region it writes (identical for mirror and
 * delete; the rotated AABB for rotate; the translated AABB for move and
 * copy).
 */
export interface TransformEntryPreview {
  readonly volumeId: VolumeId;
  /** Half-open source region the operation reads. */
  readonly source: IntAabb;
  /** Exact half-open affected bounds after the operation. */
  readonly destination: IntAabb;
}

/**
 * Exact preview of one transform operation (plan S7.19, ticket #19),
 * computed against the authoritative store with the v1 region semantics
 * (docs/commands/voxel-regions.md): destinations are exact AABBs, and
 * collision behavior is the explicit overwrite mode. Runtime-only, never
 * persisted; cleared on commit, cancel, tool switch, or lifecycle
 * replacement.
 *
 * Counts are per-gesture unions (exact even when several entries share a
 * volume): `movedVoxels` is the occupied source content the operation
 * affects, `overwrittenVoxels` is the occupied destination content
 * outside the operation's own source that the operation replaces, and
 * `removedVoxels` is the occupied source content that is cleared and not
 * re-occupied.
 */
export type TransformPreview =
  | (TransformPreviewBase & {
      readonly operation: "move";
      /** Integer translation delta of the drag. */
      readonly delta: Vec3i;
    })
  | (TransformPreviewBase & {
      readonly operation: "copy";
      /** Integer translation delta of the drag. */
      readonly delta: Vec3i;
    })
  | (TransformPreviewBase & {
      readonly operation: "rotate";
      readonly axis: ShapeAxis;
      /** Exact 90-degree increments: 1, 2, or 3. */
      readonly quarterTurns: QuarterTurns;
    })
  | (TransformPreviewBase & {
      readonly operation: "mirror";
      /** Axis perpendicular to the mirror plane. */
      readonly axis: ShapeAxis;
    })
  | (TransformPreviewBase & { readonly operation: "delete" });

interface TransformPreviewBase {
  readonly entries: readonly TransformEntryPreview[];
  /** Occupied voxels the operation affects (the source content). */
  readonly movedVoxels: number;
  /** Occupied destination voxels the operation overwrites (collisions). */
  readonly overwrittenVoxels: number;
  /** Occupied voxels the operation removes (cleared, not re-occupied). */
  readonly removedVoxels: number;
}
