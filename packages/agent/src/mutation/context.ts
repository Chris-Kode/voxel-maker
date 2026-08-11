import type { Command, CommandRegistry } from "@voxel-maker/commands";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type { JsonValue } from "@voxel-maker/shared";
import type { ToolContract } from "../contract.js";
import type { MutationLimits } from "../limits.js";

/**
 * Context handed to every mutation tool handler (plan S11.5/S11.6). Tools
 * receive the read surface (the preview session's staged view when bound,
 * otherwise the live store), the preview command registry, the base
 * revision their proposals are anchored to, and a deterministic command-id
 * sequence. They never receive a write capability or a command bus:
 * construction only, execution happens through the preview session.
 */
export interface MutationToolContext {
  readonly store: DocumentStoreRead;
  readonly limits: MutationLimits;
  readonly registry: CommandRegistry;
  /** Revision every constructed command is based on (mandatory base). */
  readonly baseRevision: number;
  /** Tool name of the dispatched call (stable kebab-case). */
  readonly toolName: string;
  /**
   * Deterministic per-mutator sequence for generated command ids; the
   * fallback id also carries `baseRevision`, so ids stay unique across
   * runs on the same bus (issue #115).
   */
  readonly commandSequence: number;
}

/** Animation deltas a staging tool reports for the session budget ledger. */
export type AnimationProposal = {
  /** New tracks this command would add. */
  readonly tracks?: number;
  /** New keyframes this command would write. */
  readonly keyframes?: number;
  /** Clip duration in seconds this command would establish. */
  readonly clipDurationSeconds?: number;
};

/** One constructed command plus its bounded voxel-change estimate. */
export interface MutationPayload {
  readonly command: Command;
  readonly voxelEstimate: number;
  /**
   * Optional animation deltas (rigging/animation tools, plan S13.5): the
   * loop reserves these against the session's animation budgets before
   * staging, exactly like the voxel estimate.
   */
  readonly animation?: AnimationProposal;
}

/** Handler signature shared by every mutation tool. */
export type MutationHandler = (
  ctx: MutationToolContext,
  args: JsonValue,
) => MutationPayload;

/** One registered mutation tool: versioned contract plus pure handler. */
export interface MutationToolDefinition {
  readonly contract: ToolContract;
  readonly handler: MutationHandler;
}
