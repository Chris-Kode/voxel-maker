import {
  CommandBus,
  CommandRegistry,
  decodeVolumeEntries,
  VOXEL_COPY_REGION_COMMAND,
  VOXEL_DELETE_REGION_COMMAND,
  VOXEL_FILL_BOX_COMMAND,
  VOXEL_FILL_CYLINDER_COMMAND,
  VOXEL_FILL_SPHERE_COMMAND,
  VOXEL_MIRROR_REGION_COMMAND,
  VOXEL_REMOVE_BATCH_COMMAND,
  VOXEL_REPLACE_MATERIAL_COMMAND,
  VOXEL_ROTATE_REGION_COMMAND,
  VOXEL_SET_BATCH_COMMAND,
  VOXEL_TRANSLATE_REGION_COMMAND,
  VOLUME_CREATE_COMMAND,
  type Command,
  type TransactionResult,
} from "@voxel-maker/commands";
import {
  WorkspaceError,
  err,
  ok,
  transactionId,
  type CommandId,
  type DocumentId,
  type JsonValue,
  type MaterialId,
  type NodeId,
  type TransactionId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import type { VoxelDocument } from "@voxel-maker/model";
import type {
  DocumentCommitted,
  DocumentStoreRead,
} from "@voxel-maker/document";
import type { VoxelWriteCapability } from "@voxel-maker/voxel";
import {
  cylinderEstimate,
  regionVolume,
  sphereEstimate,
} from "./mutation/parse.js";
import { resolveMutationLimits, type MutationLimits } from "./limits.js";
import { createPreviewRegistry } from "./registry.js";
import { PreviewStore } from "./preview-store.js";

/**
 * Preview session (plan S11.11/S11.15, ticket #32): an isolated
 * copy-on-write projection of the live document for staging AI geometry
 * changes. Staging executes each command as one atomic transaction on a
 * private store and bus, so staged reads observe prior staged commands
 * while live revision, history, dirty state, autosave, recovery, and
 * rendering stay untouched. Preview events are emitted only to preview
 * subscribers and the worker namespace is `preview:<sessionId>`.
 * Apply executes every staged command as ONE optimistic transaction on
 * the live bus against the captured base revision; Discard and
 * cancellation release all preview resources.
 */

/** Branded identifier of one preview session; doubles as its namespace. */
export type PreviewSessionId = string & {
  readonly __kind?: "PreviewSessionId";
};

/** Validates a preview session id (bounded, `preview:` prefix). */
export function previewSessionId(value: string): PreviewSessionId {
  if (
    value.length === 0 ||
    value.length > 128 ||
    !value.startsWith("preview:")
  ) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_PREVIEW_SESSION_ID",
      message:
        "Preview session ids must be non-empty strings of at most 128 characters prefixed with preview:",
      context: { value },
    });
  }
  return value as PreviewSessionId;
}

export interface PreviewSessionOptions {
  /** Authoritative live read surface; never written by the session. */
  readonly live: DocumentStoreRead;
  /**
   * Live command bus used by `apply`. When absent, `apply` fails with
   * APPLY_TARGET_MISSING and the session stays read/stage-only.
   */
  readonly applyBus?: CommandBus;
  /** Preview command registry; defaults to the scene/material/geometry set. */
  readonly registry?: CommandRegistry;
  /** Explicit session id; defaults to `preview:<documentId>:<baseRevision>`. */
  readonly sessionId?: PreviewSessionId;
  /** Mandatory base revision; defaults to the live revision. */
  readonly baseRevision?: number;
  /** Optional lowerings of the session budgets. */
  readonly limits?: Partial<MutationLimits>;
}

/** One staged command and the preview event it produced. */
export interface StagedStage {
  readonly command: Command;
  readonly revision: number;
  readonly event: DocumentCommitted;
}

export type StageResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly revision: number;
        readonly event: DocumentCommitted;
      };
    }
  | {
      readonly ok: false;
      readonly error: WorkspaceError;
    };

export type StageManyResult =
  | {
      readonly ok: true;
      readonly staged: readonly StagedStage[];
    }
  | {
      readonly ok: false;
      readonly error: WorkspaceError;
      readonly index: number;
    };

/** Bounded semantic diff of the staged overlay (plan S11.11). */
export interface PreviewDiff {
  readonly sessionId: PreviewSessionId;
  readonly namespace: string;
  readonly documentId: DocumentId;
  /** Revision the session was created at (mandatory base). */
  readonly baseRevision: number;
  /** Current staged revision (base + staged count). */
  readonly revision: number;
  readonly stagedCommandCount: number;
  /** Command types with counts, in first-staged order. */
  readonly commandTypes: readonly {
    readonly type: string;
    readonly count: number;
  }[];
  /** Changed node ids in staging order, bounded by `maxDiffEntries`. */
  readonly changedNodeIds: readonly NodeId[];
  readonly changedMaterialIds: readonly MaterialId[];
  readonly changedVolumeIds: readonly VolumeId[];
  /** Cumulative proposed voxel changes of the staged commands. */
  readonly voxelEstimate: number;
  /** True when an id list was capped at the diff entry budget. */
  readonly truncated: boolean;
}

export type DiffResult =
  | { readonly ok: true; readonly value: PreviewDiff }
  | { readonly ok: false; readonly error: WorkspaceError };

export interface ApplyOptions {
  readonly transactionId?: TransactionId;
  readonly label?: string;
  readonly correlationId?: string;
}

/**
 * The preview session read model: implements `DocumentStoreRead` so the
 * inspection tools run unchanged against the staged overlay.
 */
export interface PreviewSession extends DocumentStoreRead {
  readonly sessionId: PreviewSessionId;
  /** Worker/event namespace: `preview:<sessionId>` (renderer ChunkNamespace). */
  readonly namespace: string;
  readonly baseRevision: number;
  /** Live revision captured at creation. */
  readonly liveRevision: number;
  readonly documentId: DocumentId;
  readonly stagedCount: number;
  /** Staged commands in order; empty after release. */
  readonly stagedCommands: readonly Command[];
  readonly voxelEstimate: number;
  readonly closed: boolean;
  /** Session budgets (maxStagedCommands, voxels, diff entries). */
  readonly budgets: MutationLimits;
  /** Stages one command; atomic per stage, never touches the live store. */
  stage(command: Command): StageResult;
  /** Stages commands in order, stopping at the first failure. */
  stageMany(commands: readonly Command[]): StageManyResult;
  /** Bounded semantic diff of the staged overlay. */
  diff(): DiffResult;
  /** One optimistic live transaction with all staged commands. */
  apply(options?: ApplyOptions): TransactionResult;
  /** Releases all preview resources with no live side effects. */
  discard(): void;
  /** Cancellation alias of `discard` (plan S12.1 cancel state). */
  cancel(): void;
}

interface PreviewSessionState {
  readonly live: DocumentStoreRead;
  readonly store: PreviewStore;
  readonly bus: CommandBus;
  readonly applyBus?: CommandBus;
  readonly sessionId: PreviewSessionId;
  readonly baseRevision: number;
  readonly budgets: MutationLimits;
}

class PreviewSessionImpl implements PreviewSession {
  readonly sessionId: PreviewSessionId;
  readonly namespace: string;
  readonly baseRevision: number;
  readonly liveRevision: number;
  readonly documentId: DocumentId;
  readonly budgets: MutationLimits;

  readonly #store: PreviewStore;
  readonly #bus: CommandBus;
  readonly #applyBus: CommandBus | undefined;
  /**
   * Bounded session tag used inside derived transaction ids so a
   * maximum-length session id can never push an id past the 128-char
   * limit (transactionId validation).
   */
  readonly #idTag: string;
  #staged: Command[] = [];
  #ids = new Set<CommandId>();
  #voxelEstimate = 0;
  #closed = false;
  #changedNodes = new Set<NodeId>();
  #changedMaterials = new Set<MaterialId>();
  #changedVolumes = new Set<VolumeId>();
  #commandTypes: { type: string; count: number }[] = [];

  constructor(state: PreviewSessionState) {
    this.#store = state.store;
    this.#bus = state.bus;
    this.#applyBus = state.applyBus;
    this.sessionId = state.sessionId;
    this.namespace = state.sessionId;
    this.#idTag =
      state.sessionId.length <= 96
        ? state.sessionId
        : state.sessionId.slice(0, 96);
    this.baseRevision = state.baseRevision;
    this.liveRevision = state.live.revision;
    this.documentId = state.store.getDocument().documentId;
    this.budgets = state.budgets;
  }

  get revision(): number {
    return this.#store.revision;
  }

  get limits() {
    return this.#store.limits;
  }

  get volumeLimits() {
    return this.#store.volumeLimits;
  }

  get stagedCount(): number {
    return this.#staged.length;
  }

  get stagedCommands(): readonly Command[] {
    return this.#staged;
  }

  get voxelEstimate(): number {
    return this.#voxelEstimate;
  }

  get closed(): boolean {
    return this.#closed;
  }

  getDocument(): VoxelDocument {
    this.#ensureOpen();
    return this.#store.getDocument();
  }

  getVolume(volumeId: VolumeId) {
    this.#ensureOpen();
    return this.#store.getVolume(volumeId);
  }

  getVoxel(volumeId: VolumeId, coordinate: Vec3i): MaterialId {
    this.#ensureOpen();
    return this.#store.getVoxel(volumeId, coordinate);
  }

  subscribe(listener: (event: DocumentCommitted) => void): () => void {
    if (this.#closed) return () => {};
    return this.#store.subscribe(listener);
  }

  stage(command: Command): StageResult {
    if (this.#closed) return err(closedError());
    if (!isCommandShape(command)) {
      return err(
        new WorkspaceError({
          family: "validation",
          code: "INVALID_COMMAND",
          message: "Staged value is not a valid command",
        }),
      );
    }
    if (this.#staged.length >= this.budgets.maxStagedCommands) {
      return err(
        stagingLimitError(
          "STAGING_COMMAND_LIMIT",
          "maxStagedCommands",
          this.#staged.length + 1,
          this.budgets.maxStagedCommands,
        ),
      );
    }
    if (this.#ids.has(command.id)) {
      return err(
        new WorkspaceError({
          family: "validation",
          code: "DUPLICATE_COMMAND_ID",
          message: "A preview session cannot stage the same command id twice",
          context: { commandId: command.id },
        }),
      );
    }
    const estimate = estimateVoxelDelta(command, this.#store);
    if (this.#voxelEstimate + estimate > this.budgets.maxProposedVoxelChanges) {
      return err(
        stagingLimitError(
          "STAGING_VOXEL_LIMIT",
          "maxProposedVoxelChanges",
          this.#voxelEstimate + estimate,
          this.budgets.maxProposedVoxelChanges,
        ),
      );
    }
    const result = this.#bus.executeTransaction([command], {
      transactionId: transactionId(
        `transaction:staging:${String(this.#staged.length + 1)}:${this.#idTag}`,
      ),
      expectedRevision: this.#store.revision,
      source: "ai",
      correlationId: this.sessionId,
      label: "preview stage",
    });
    if (!result.ok) return result;
    this.#staged.push(Object.freeze(command));
    this.#ids.add(command.id);
    this.#voxelEstimate += estimate;
    const event = result.value.event;
    for (const id of event.changedNodeIds) this.#changedNodes.add(id);
    for (const id of event.changedMaterialIds) this.#changedMaterials.add(id);
    for (const volume of event.changedVolumes) {
      this.#changedVolumes.add(volume.volumeId);
    }
    for (const type of event.commandTypes) {
      const entry = this.#commandTypes.find((item) => item.type === type);
      if (entry !== undefined) {
        entry.count += 1;
      } else {
        this.#commandTypes.push({ type, count: 1 });
      }
    }
    return ok({ revision: result.value.revisionAfter, event });
  }

  stageMany(commands: readonly Command[]): StageManyResult {
    const staged: StagedStage[] = [];
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      if (command === undefined) continue;
      const result = this.stage(command);
      if (!result.ok) return { ok: false, error: result.error, index };
      staged.push({
        command,
        revision: result.value.revision,
        event: result.value.event,
      });
    }
    return { ok: true, staged };
  }

  diff(): DiffResult {
    if (this.#closed) return err(closedError());
    const max = this.budgets.maxDiffEntries;
    let truncated = false;
    const cap = <T>(list: readonly T[]): readonly T[] => {
      if (list.length <= max) return list;
      truncated = true;
      return list.slice(0, max);
    };
    return ok({
      sessionId: this.sessionId,
      namespace: this.namespace,
      documentId: this.documentId,
      baseRevision: this.baseRevision,
      revision: this.#store.revision,
      stagedCommandCount: this.#staged.length,
      commandTypes: this.#commandTypes.map((entry) => ({ ...entry })),
      changedNodeIds: cap([...this.#changedNodes]),
      changedMaterialIds: cap([...this.#changedMaterials]),
      changedVolumeIds: cap([...this.#changedVolumes]),
      voxelEstimate: this.#voxelEstimate,
      truncated,
    });
  }

  apply(options: ApplyOptions = {}): TransactionResult {
    if (this.#closed) return err(closedError());
    if (this.#applyBus === undefined) {
      return err(
        new WorkspaceError({
          family: "conflict",
          code: "APPLY_TARGET_MISSING",
          message: "No live command bus is configured for this preview session",
        }),
      );
    }
    if (this.#staged.length === 0) {
      return err(
        new WorkspaceError({
          family: "conflict",
          code: "NOTHING_TO_APPLY",
          message: "There are no staged commands to apply",
        }),
      );
    }
    const result = this.#applyBus.executeTransaction([...this.#staged], {
      transactionId:
        options.transactionId ??
        transactionId(`transaction:ai:apply:${this.#idTag}`),
      expectedRevision: this.baseRevision,
      source: "ai",
      ...(options.correlationId === undefined
        ? { correlationId: this.sessionId }
        : { correlationId: options.correlationId }),
      ...(options.label === undefined
        ? { label: "AI preview apply" }
        : { label: options.label }),
    });
    if (result.ok) this.discard();
    return result;
  }

  discard(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.release();
    this.#staged = [];
    this.#ids.clear();
    this.#voxelEstimate = 0;
    this.#changedNodes.clear();
    this.#changedMaterials.clear();
    this.#changedVolumes.clear();
    this.#commandTypes = [];
  }

  cancel(): void {
    this.discard();
  }

  #ensureOpen(): void {
    if (this.#closed) throw closedError();
  }
}

/** Creates one isolated copy-on-write preview session. */
export function createPreviewSession(
  options: PreviewSessionOptions,
): PreviewSession {
  const live = options.live;
  const baseRevision = options.baseRevision ?? live.revision;
  // The staged snapshot must equal the live state at creation: staged reads
  // fall through to live data for untouched volumes, so an older base would
  // mix the base record snapshot with newer live voxel data. When the live
  // document advances later, Apply reports REVISION_CONFLICT and the caller
  // discards and reinspects (plan S12.9) instead of silently rebasing.
  if (!Number.isInteger(baseRevision) || baseRevision !== live.revision) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_BASE_REVISION",
      message: "baseRevision must equal the live revision at session creation",
      context: { baseRevision, liveRevision: live.revision },
    });
  }
  // Clone the committed document; the clone starts at the base revision so
  // the preview revision namespace is fully isolated from the live one.
  const document = JSON.parse(
    JSON.stringify(live.getDocument()),
  ) as VoxelDocument;
  (document as { revision: number }).revision = baseRevision;
  const sessionId =
    options.sessionId ??
    previewSessionId(`preview:${document.documentId}:${String(baseRevision)}`);
  const capability: VoxelWriteCapability = { __kind: "VoxelWriteCapability" };
  const store = new PreviewStore(live, document, capability);
  const registry = options.registry ?? createPreviewRegistry();
  const bus = new CommandBus(store, registry, capability);
  return new PreviewSessionImpl({
    live,
    store,
    bus,
    ...(options.applyBus === undefined ? {} : { applyBus: options.applyBus }),
    sessionId,
    baseRevision,
    budgets: resolveMutationLimits(options.limits),
  });
}

/** Stable closed-session error. */
function closedError(): WorkspaceError {
  return new WorkspaceError({
    family: "conflict",
    code: "PREVIEW_CLOSED",
    message: "The preview session is closed",
  });
}

/** Stable session-budget limit error (plan S11.10). */
function stagingLimitError(
  code: string,
  limit: string,
  value: number,
  max: number,
): WorkspaceError {
  return new WorkspaceError({
    family: "limit",
    code,
    message: `${limit} must be <= ${String(max)} (requested ${String(value)})`,
    context: { limit, value, max },
  });
}

/** Minimal shape guard for untrusted staged values. */
function isCommandShape(value: unknown): value is Command {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    record.id.length <= 128 &&
    typeof record.type === "string" &&
    record.type.length > 0 &&
    record.type.length <= 128 &&
    typeof record.schemaVersion === "number" &&
    Number.isInteger(record.schemaVersion) &&
    record.schemaVersion >= 1 &&
    typeof record.payload === "object" &&
    record.payload !== null &&
    !Array.isArray(record.payload)
  );
}

/**
 * Conservative proposed-voxel estimate of one staged command (plan
 * S11.10). Region operations use the region volume (an upper bound);
 * replaceMaterial without a region uses the volume's occupied count;
 * everything else reports 0. Malformed payloads estimate 0 and are
 * rejected by command validation instead.
 */
function estimateVoxelDelta(
  command: Command,
  store: DocumentStoreRead,
): number {
  const payload = command.payload as
    | Readonly<Record<string, JsonValue>>
    | undefined;
  if (payload === undefined) return 0;
  switch (command.type) {
    case VOXEL_SET_BATCH_COMMAND:
      return arrayLength(payload.entries);
    case VOXEL_REMOVE_BATCH_COMMAND:
      return arrayLength(payload.coordinates);
    case VOXEL_FILL_BOX_COMMAND:
      return regionVolumeOf(payload.region);
    case VOXEL_FILL_SPHERE_COMMAND:
      return sphereEstimate(finiteNumber(payload.radius));
    case VOXEL_FILL_CYLINDER_COMMAND:
      return cylinderEstimate(
        finiteNumber(payload.radius),
        finiteNumber(payload.height),
      );
    case VOXEL_REPLACE_MATERIAL_COMMAND: {
      const region = payload.region;
      if (region !== undefined) return regionVolumeOf(region);
      const volumeId =
        typeof payload.volumeId === "string" ? payload.volumeId : "";
      const view = store.getVolume(volumeId as VolumeId);
      return view === undefined ? 0 : view.occupiedCount();
    }
    case VOXEL_COPY_REGION_COMMAND:
      return 2 * regionVolumeOf(payload.source);
    case VOXEL_DELETE_REGION_COMMAND:
    case VOXEL_TRANSLATE_REGION_COMMAND:
    case VOXEL_ROTATE_REGION_COMMAND:
    case VOXEL_MIRROR_REGION_COMMAND:
      return regionVolumeOf(payload.region);
    case VOLUME_CREATE_COMMAND:
      return volumeEntriesCount(payload.entries);
    default:
      return 0;
  }
}

/** Length of a payload array, or 0 for malformed values. */
function arrayLength(value: JsonValue | undefined): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Volume of a payload region, or 0 for malformed values. */
function regionVolumeOf(value: JsonValue | undefined): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 0;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  const min = record.min;
  const max = record.max;
  if (!isVec3iValue(min) || !isVec3iValue(max)) {
    return 0;
  }
  const minArr = min as readonly [number, number, number];
  const maxArr = max as readonly [number, number, number];
  if (minArr[0] > maxArr[0] || minArr[1] > maxArr[1] || minArr[2] > maxArr[2]) {
    return 0;
  }
  return regionVolume({ min: minArr, max: maxArr });
}

/** True when `value` is an integer array of exactly three numbers. */
function isVec3iValue(value: JsonValue | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number" && Number.isInteger(item))
  );
}

/** Finite number or 0 for malformed values. */
function finiteNumber(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Decoded entry count of a volume.create payload, or 0. */
function volumeEntriesCount(value: JsonValue | undefined): number {
  if (value === undefined) return 0;
  try {
    return decodeVolumeEntries(value, []).length;
  } catch {
    return 0;
  }
}
