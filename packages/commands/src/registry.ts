import {
  WorkspaceError,
  type AnimationId,
  type MaterialId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import type { DocumentLimits, VoxelDocument } from "@voxel-maker/model";
import type {
  VoxelChangeSet,
  VoxelVolume,
  VoxelVolumeReadView,
  VoxelWriteCapability,
} from "@voxel-maker/voxel";

/** Read context shared by validation and execution (plan 4.1). */
export interface CommandValidationContext {
  readonly document: VoxelDocument;
  readonly limits: DocumentLimits;
  getVoxel(volumeId: VolumeId, coordinate: Vec3i): MaterialId;
  getVolume(volumeId: VolumeId): VoxelVolumeReadView | undefined;
}

/** Execution context; staged writes are visible to later commands. */
export interface CommandExecutionContext extends CommandValidationContext {
  /** Copy-on-write clone of a volume for this transaction, or undefined. */
  stageVolume(volumeId: VolumeId): VoxelVolume | undefined;
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
  readonly changeSet: VoxelChangeSet;
  readonly inverse: InverseCommand;
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
}
