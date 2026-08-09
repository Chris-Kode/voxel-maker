import type { Command } from "@voxel-maker/commands";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { Vec3i } from "@voxel-maker/math";
import type {
  CommandId,
  MaterialId,
  VolumeId,
  WorkspaceError,
} from "@voxel-maker/shared";

/**
 * Shared editor tool contracts (plan S7.3, ticket #17).
 *
 * A tool receives pointer input, reads immutable semantic state, maintains
 * a transient runtime preview, and constructs registered commands on
 * commit (ARCHITECTURE.md "Editor interaction"). The host — the desktop
 * viewport controller — injects picking, commit, and id services so the
 * tool stays headless and deterministic in Node tests.
 */

/** Runtime tool selection; only "select" predates ticket #17. */
export type EditorToolId = "select" | "pencil" | "erase";

/** The part of a deterministic pick a stroke tool consumes (S6.12). */
export interface ToolPick {
  readonly volumeId: VolumeId;
  /** Volume-local integer voxel coordinate (may be negative). */
  readonly voxel: Vec3i;
}

/**
 * Services injected into stroke tools by the composition root. `store` is
 * the authoritative read surface of the open document (undefined when none
 * is open) and may change between calls as documents open and close.
 */
export interface StrokeToolHost {
  /** The authoritative read surface of the open document. */
  readonly store: DocumentStoreRead | undefined;
  /**
   * Hard cap on voxels per stroke (ADR-0009: the same budget the batch
   * commands enforce); a longer stroke is rejected atomically.
   */
  readonly maxStrokeVoxels: number;
  /** Deterministic pick at viewport-relative pointer coordinates. */
  pick(clientX: number, clientY: number): ToolPick | undefined;
  /** Supplies a fresh command id for the next stroke command. */
  nextCommandId(): CommandId;
  /**
   * Atomically executes one labeled transaction and returns the error, or
   * undefined on success. Never partially applies a stroke.
   */
  commit(
    commands: readonly Command[],
    label: string,
  ): WorkspaceError | undefined;
}

/**
 * Transient, non-authoritative stroke preview (ARCHITECTURE.md "Editor
 * interaction"): the runtime-only voxel set of the in-progress gesture.
 * It is never persisted, never enters the command bus, and is discarded on
 * commit, cancel, or lifecycle replacement.
 */
export interface StrokeDraft {
  readonly volumeId: VolumeId;
  /**
   * Deduplicated volume-local voxels in rasterized order. Live runtime
   * view owned by the tool: read it between editor notifications, never
   * retain or mutate it (the draft object is replaced on every update).
   */
  readonly voxels: readonly Vec3i[];
  /** Pencil: the material the stroke paints; erase: undefined. */
  readonly material: MaterialId | undefined;
}

/** Result of one tool input; failures never mutate semantic state. */
export type ToolActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: WorkspaceError };
