import {
  WorkspaceError,
  type AnimationId,
  type DocumentId,
  type MaterialId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { Transform, Vec3i } from "@voxel-maker/math";
import type {
  AnimationDescriptor,
  Color,
  Component,
  DocumentLimits,
  MetadataRecord,
  VoxelDocument,
  VolumeDescriptor,
} from "@voxel-maker/model";
import type {
  VoxelChangeSet,
  VoxelVolume,
  VoxelVolumeReadView,
  VoxelWriteCapability,
} from "@voxel-maker/voxel";

/** Read context shared by validation and execution (plan 4.1). */
export interface CommandValidationContext {
  readonly document: VoxelDocument;
  /** The committed document before this transaction; never sees staged effects. */
  readonly committedDocument: VoxelDocument;
  readonly limits: DocumentLimits;
  getVoxel(volumeId: VolumeId, coordinate: Vec3i): MaterialId;
  getVolume(volumeId: VolumeId): VoxelVolumeReadView | undefined;
  /**
   * True when a volume was staged earlier in this transaction (created or
   * cloned). Unlike `getVolume`, this never reports committed volumes.
   */
  isVolumeStaged(volumeId: VolumeId): boolean;
}

/**
 * Mutable copy-on-write working copy of the document for one transaction
 * (plan 4.3). Only registered command handlers receive it, through
 * `CommandExecutionContext.stageDocument`; public consumers never see it.
 */
export interface MutableDocument {
  documentId: DocumentId;
  documentSchemaVersion: 1;
  revision: number;
  metadata: MetadataRecord;
  rootNodeId: NodeId;
  nodes: Record<NodeId, MutableSceneNode>;
  materials: Record<MaterialId, MutableMaterialRecord>;
  volumes: Record<VolumeId, VolumeDescriptor>;
  animations: Record<AnimationId, AnimationDescriptor>;
}

/** Mutable scene node record; children order is preserved by commands. */
export interface MutableSceneNode {
  nodeId: NodeId;
  name?: string;
  parentId: NodeId | null;
  children: NodeId[];
  transform: Transform;
  components: Component[];
  metadata?: MetadataRecord;
}

/** Mutable material record; every field is bounded by the model schema. */
export interface MutableMaterialRecord {
  materialId: MaterialId;
  name: string;
  color: Color;
  opacity: number;
  roughness: number;
  metallic: number;
  emissive: number;
}

/** Execution context; staged writes are visible to later commands. */
export interface CommandExecutionContext extends CommandValidationContext {
  /** Copy-on-write clone of a volume for this transaction, or undefined. */
  stageVolume(volumeId: VolumeId): VoxelVolume | undefined;
  /**
   * Copy-on-write working copy of the document for this transaction. The
   * first call clones the committed document; later commands see earlier
   * staged record effects. The returned object is mutable and private to the
   * transaction; it is discarded on failure.
   */
  stageDocument(): MutableDocument;
  /**
   * Creates a fresh volume in the staged overlay (ticket #24). The caller
   * must also stage a matching `VolumeDescriptor`; the store rejects a
   * staged volume without a descriptor. Fails when the committed document
   * already contains the volume.
   */
  stageNewVolume(volumeId: VolumeId): VoxelVolume;
  /**
   * Marks a committed volume for removal in this transaction (ticket #24).
   * The caller must also remove its descriptor from the staged document;
   * the store rejects an inconsistent removal.
   */
  stageRemoveVolume(volumeId: VolumeId): void;
  /**
   * Cancels a volume created earlier in this transaction (ticket #111): the
   * staged-new volume is dropped from the overlay so the commit never
   * installs it. The caller must also remove its descriptor from the staged
   * document; the store rejects an inconsistent removal. Unlike
   * `stageRemoveVolume`, the volume never reached the committed document,
   * so no repository removal is recorded. Fails when the volume was not
   * staged in this transaction.
   */
  stageCancelVolume(volumeId: VolumeId): void;
  readonly writeCapability: VoxelWriteCapability;
}

/** Inverse command without an id; the bus derives a deterministic id. */
export interface InverseCommand {
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
}

/**
 * Resources a command declares as affected (plan 5.3), used for diagnostics
 * and conflict reporting. The bus intersects this with the actual change set
 * when building the commit event.
 */
export interface DeclaredAffectedResources {
  readonly nodeIds: readonly NodeId[];
  readonly materialIds: readonly MaterialId[];
  readonly animationIds: readonly AnimationId[];
  readonly volumeIds: readonly VolumeId[];
}

/** Result of executing one command against the staged state. */
export interface CommandExecution {
  /** Voxel change set of the primary touched volume, when any. */
  readonly changeSet?: VoxelChangeSet;
  /** Additional touched volumes (for example a material remap). */
  readonly additionalChangeSets?: readonly VoxelChangeSet[];
  /**
   * Exact inverse intent. A command may return several inverse commands
   * (for example recreating a record and restoring voxels); the bus replays
   * them in reverse order on undo.
   */
  readonly inverse: InverseCommand | readonly InverseCommand[];
  /**
   * True when the command mutated a document record (node, material, or
   * metadata). Voxel commands leave it unset; the bus treats a command as
   * changed when it reports record changes or any non-empty change set.
   */
  readonly changedRecords?: boolean;
  readonly declaredAffectedResources: DeclaredAffectedResources;
}

/**
 * A registered command handler. `parse` bounds untrusted input, `validate`
 * checks it against the document, and `execute` mutates staged state and
 * returns the change set plus an exact inverse.
 */
export interface CommandHandler<
  TType extends string = string,
  TPayload = unknown,
> {
  readonly type: TType;
  readonly schemaVersion: number;
  parse(payload: unknown, limits: DocumentLimits): TPayload;
  validate(payload: TPayload, context: CommandValidationContext): void;
  execute(
    payload: TPayload,
    context: CommandExecutionContext,
  ): CommandExecution;
}

/** Registry of command handlers keyed by `type@schemaVersion`. */
export class CommandRegistry {
  readonly #handlers = new Map<string, CommandHandler>();

  register(handler: CommandHandler): void {
    const key = `${handler.type}@${String(handler.schemaVersion)}`;
    if (this.#handlers.has(key)) {
      throw new WorkspaceError({
        family: "internal",
        code: "DUPLICATE_COMMAND_REGISTRATION",
        message: `Duplicate registration of command ${key}`,
      });
    }
    this.#handlers.set(key, handler);
  }

  get(type: string, schemaVersion: number): CommandHandler | undefined {
    return this.#handlers.get(`${type}@${String(schemaVersion)}`);
  }

  hasType(type: string): boolean {
    for (const key of this.#handlers.keys()) {
      if (key.startsWith(`${type}@`)) return true;
    }
    return false;
  }

  /** Registered `type@schemaVersion` pairs in stable order (plan 4.1). */
  list(): readonly { readonly type: string; readonly schemaVersion: number }[] {
    return [...this.#handlers.values()]
      .map((handler) => ({
        type: handler.type,
        schemaVersion: handler.schemaVersion,
      }))
      .sort(
        (a, b) =>
          a.type.localeCompare(b.type) || a.schemaVersion - b.schemaVersion,
      );
  }
}
