import type { VolumeId } from "@voxel-maker/shared";
import type { VoxelDocument } from "@voxel-maker/model";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import {
  encodeVox,
  planVoxExport,
  preflightVoxExport,
  type VoxExportChoices,
  type VoxExportLoss,
} from "@voxel-maker/formats";
import {
  type AtomicWritePhase,
  type AtomicWriteResult,
  type ProjectStoragePort,
} from "@voxel-maker/storage";

/**
 * VOX export service (plan S8.4, ticket #24): preflights the open document
 * (dimensions, palette, hierarchy, transforms, origin), maps it to VOX
 * space, encodes deterministically, and writes through the scoped atomic
 * storage port with progress and cancellation. Export never mutates the
 * document. A preflight block returns a structured loss report and writes
 * nothing.
 */

/** Options for one VOX export. */
export interface ExportVoxOptions {
  readonly document: VoxelDocument;
  /** Volume read access; the caller supplies the session store. */
  readonly getVolume: (volumeId: VolumeId) => VoxelVolumeReadView | undefined;
  /** Scoped atomic-write port (memory in tests, Node/Tauri in apps). */
  readonly storagePort: ProjectStoragePort;
  /** Destination path; the caller has already resolved overwrite consent. */
  readonly path: string;
  /** Explicit bake/loss choices (rebaseOrigins, flattenHierarchy). */
  readonly choices?: VoxExportChoices;
  /** Cooperative cancellation for the atomic write. */
  readonly signal?: AbortSignal;
  /** Per-phase progress (mirrors the atomic-write phases). */
  readonly onPhase?: (phase: AtomicWritePhase) => void;
}

/** Outcome of one export: either written or blocked by the loss report. */
export type ExportVoxOutcome =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly losses: readonly VoxExportLoss[];
      readonly write: AtomicWriteResult;
    }
  | {
      readonly ok: false;
      readonly blocked: readonly VoxExportLoss[];
    };

/** Exports the document to a VOX file through the scoped storage port. */
export async function exportVox(
  options: ExportVoxOptions,
): Promise<ExportVoxOutcome> {
  const preflight = preflightVoxExport(
    options.document,
    options.getVolume,
    options.choices ?? {},
  );
  if (!preflight.ok) return { ok: false, blocked: preflight.blocked };
  const plan = planVoxExport(
    options.document,
    options.getVolume,
    preflight,
    options.choices ?? {},
  );
  const bytes = encodeVox({ models: plan.models, palette: plan.palette });
  const write = await options.storagePort.writeProjectAtomic(
    options.path,
    bytes,
    {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onPhase !== undefined ? { onPhase: options.onPhase } : {}),
    },
  );
  return { ok: true, bytes, losses: plan.losses, write };
}
