import {
  WorkspaceError,
  type AnimationId,
  type CommandId,
  type MaterialId,
  type NodeId,
  type TransactionId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import {
  DEFAULT_DOCUMENT_LIMITS,
  validateDocument,
  type DocumentLimits,
  type VoxelDocument,
} from "@voxel-maker/model";
import {
  DEFAULT_VOXEL_VOLUME_LIMITS,
  type VoxelChunkSeed,
  type VoxelVolume,
  type VoxelVolumeLimits,
  type VoxelVolumeReadView,
  type VoxelWriteCapability,
} from "@voxel-maker/voxel";
import { VoxelRepository } from "./repository.js";

/** Provenance of a committed transaction (plan 4.1). */
export type Source = "ui" | "ai" | "import" | "recovery" | "system";

/** One chunk touched by a committed transaction (plan 5.2). */
export interface ChangedChunk {
  readonly coordinate: Vec3i;
  /** In-session chunk revision after the transaction; excluded from semantic state. */
  readonly revision: number;
}

/** One volume touched by a committed transaction (plan 5.2). */
export interface ChangedVolume {
  readonly volumeId: VolumeId;
  readonly chunks: readonly ChangedChunk[];
  /** Half-open bounds of the changed region, when any chunk changed. */
  readonly bounds?: IntAabb;
}

/**
 * Immutable, frozen event emitted exactly once per committed transaction
 * (plan 4.1). Consumers must treat it as read-only.
 */
export interface DocumentCommitted {
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly transactionId: TransactionId;
  readonly source: Source;
  readonly correlationId?: string;
  readonly commandIds: readonly CommandId[];
  readonly commandTypes: readonly string[];
  readonly changedNodeIds: readonly NodeId[];
  readonly changedMaterialIds: readonly MaterialId[];
  readonly changedAnimationIds: readonly AnimationId[];
  readonly changedVolumes: readonly ChangedVolume[];
  readonly label?: string;
}

/** Copy-on-write staging state produced by a transaction and installed by commit. */
export interface StagedState {
  readonly document: VoxelDocument;
  /** Volumes touched by the transaction; untouched volumes keep committed state. */
  readonly volumes: ReadonlyMap<VolumeId, VoxelVolume>;
  /**
   * Volumes removed by the transaction (ticket #24). Every id must exist in
   * the committed document and must be absent from the staged document;
   * otherwise the commit rejects atomically.
   */
  readonly removedVolumes: readonly VolumeId[];
}

/** Immutable read surface of the authoritative document store. */
export interface DocumentStoreRead {
  readonly revision: number;
  readonly limits: DocumentLimits;
  /** Volume resource limits applied to every volume of the document. */
  readonly volumeLimits: VoxelVolumeLimits;
  getDocument(): VoxelDocument;
  getVolume(volumeId: VolumeId): VoxelVolumeReadView | undefined;
  /** Material at a voxel coordinate; 0 when empty or the volume is missing. */
  getVoxel(volumeId: VolumeId, coordinate: Vec3i): MaterialId;
  /** Subscribes to committed events; returns an unsubscribe function. */
  subscribe(listener: (event: DocumentCommitted) => void): () => void;
}

/**
 * Authoritative in-session document state. Writes are possible only through
 * `commit`, which requires the private write capability held by the command
 * bus; public consumers receive only the read surface.
 */
export interface DocumentStore extends DocumentStoreRead {
  /**
   * Deep copy of a volume for transaction staging. Mutating the clone never
   * affects committed state; only `commit` installs it.
   */
  stageVolume(volumeId: VolumeId): VoxelVolume | undefined;
  /**
   * Validates and installs staged state, increments the revision exactly once,
   * and emits exactly one frozen `DocumentCommitted` event.
   */
  commit(
    staged: StagedState,
    event: DocumentCommitted,
    capability: VoxelWriteCapability,
  ): void;
}

export interface CreateDocumentStoreInput {
  readonly document: VoxelDocument;
  readonly limits?: DocumentLimits;
  /**
   * Validated load path (plan S5.3/S5.15): decoded chunk seeds installed
   * into fresh volumes before the store is handed out. Every key must name
   * a volume of `document`; chunk data is copied and checked against every
   * hard volume limit before install, so a corrupt or oversized load can
   * never produce a partial store. Volumes without seeds start empty.
   */
  readonly volumes?: ReadonlyMap<VolumeId, readonly VoxelChunkSeed[]>;
}

export interface DocumentStoreHandle {
  readonly store: DocumentStore;
  /** Private token minted once per store; held only by the command bus. */
  readonly writeCapability: VoxelWriteCapability;
}

/** Creates the authoritative store for one validated document. */
export function createDocumentStore(
  input: CreateDocumentStoreInput,
): DocumentStoreHandle {
  const limits = input.limits ?? DEFAULT_DOCUMENT_LIMITS;
  const issues = validateDocument(input.document, limits);
  if (issues[0] !== undefined) {
    throw new WorkspaceError({
      family: issues[0].family,
      code: issues[0].code,
      message: issues[0].message,
      path: issues[0].path,
    });
  }
  const writeCapability: VoxelWriteCapability = {
    __kind: "VoxelWriteCapability",
  };
  const volumeLimits = {
    ...DEFAULT_VOXEL_VOLUME_LIMITS,
    maxCoordinate: limits.maxVoxelCoordinate,
  };
  if (input.volumes !== undefined) {
    for (const volumeId of input.volumes.keys()) {
      if (input.document.volumes[volumeId] === undefined) {
        throw new WorkspaceError({
          family: "validation",
          code: "MISSING_VOLUME",
          message: "Seeded volume is not part of the document",
          context: { volumeId },
        });
      }
    }
  }
  const repository = new VoxelRepository(
    Object.keys(input.document.volumes) as VolumeId[],
    volumeLimits,
    writeCapability,
    input.volumes,
  );
  const store = new DocumentStoreImpl(
    input.document,
    repository,
    limits,
    writeCapability,
  );
  return { store, writeCapability };
}

class DocumentStoreImpl implements DocumentStore {
  #document: VoxelDocument;
  readonly #repository: VoxelRepository;
  readonly #limits: DocumentLimits;
  readonly #writeCapability: VoxelWriteCapability;
  readonly #listeners = new Set<(event: DocumentCommitted) => void>();

  constructor(
    document: VoxelDocument,
    repository: VoxelRepository,
    limits: DocumentLimits,
    writeCapability: VoxelWriteCapability,
  ) {
    // Installed documents are deeply frozen so public consumers cannot
    // mutate committed state outside the command bus.
    this.#document = deepFreeze(document);
    this.#repository = repository;
    this.#limits = limits;
    this.#writeCapability = writeCapability;
  }

  get revision(): number {
    return this.#document.revision;
  }

  get limits(): DocumentLimits {
    return this.#limits;
  }

  get volumeLimits(): VoxelVolumeLimits {
    return this.#repository.volumeLimits;
  }

  getDocument(): VoxelDocument {
    return this.#document;
  }

  getVolume(volumeId: VolumeId): VoxelVolumeReadView | undefined {
    return this.#repository.getVolume(volumeId);
  }

  getVoxel(volumeId: VolumeId, coordinate: Vec3i): MaterialId {
    return this.#repository.getVoxel(volumeId, coordinate);
  }

  stageVolume(volumeId: VolumeId): VoxelVolume | undefined {
    return this.#repository.stageVolume(volumeId);
  }

  subscribe(listener: (event: DocumentCommitted) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  commit(
    staged: StagedState,
    event: DocumentCommitted,
    capability: VoxelWriteCapability,
  ): void {
    if (capability !== this.#writeCapability) {
      throw new WorkspaceError({
        family: "internal",
        code: "WRITE_CAPABILITY_REQUIRED",
        message:
          "Document commit requires the store write capability held by the command bus",
      });
    }
    if (staged.document.documentId !== this.#document.documentId) {
      throw new WorkspaceError({
        family: "validation",
        code: "DOCUMENT_ID_MISMATCH",
        message: "Staged document belongs to a different document",
        context: { documentId: staged.document.documentId },
      });
    }
    if (staged.document.revision !== this.#document.revision + 1) {
      throw new WorkspaceError({
        family: "conflict",
        code: "REVISION_CONFLICT",
        message:
          "Staged document revision must be exactly current revision + 1",
        context: {
          expected: this.#document.revision + 1,
          actual: staged.document.revision,
        },
      });
    }
    if (
      event.revisionBefore !== this.#document.revision ||
      event.revisionAfter !== staged.document.revision
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_EVENT_REVISION",
        message: "Event revisions must match the committed revision transition",
        context: {
          revisionBefore: event.revisionBefore,
          revisionAfter: event.revisionAfter,
        },
      });
    }
    const issues = validateDocument(staged.document, this.#limits);
    if (issues[0] !== undefined) {
      throw new WorkspaceError({
        family: issues[0].family,
        code: issues[0].code,
        message: issues[0].message,
        path: issues[0].path,
      });
    }
    for (const volumeId of staged.volumes.keys()) {
      if (staged.document.volumes[volumeId] === undefined) {
        throw new WorkspaceError({
          family: "validation",
          code: "MISSING_VOLUME",
          message: "Staged volume is not part of the document",
          context: { volumeId },
        });
      }
    }
    for (const volumeId of staged.removedVolumes) {
      if (this.#document.volumes[volumeId] === undefined) {
        throw new WorkspaceError({
          family: "validation",
          code: "MISSING_VOLUME",
          message: "Removed volume is not part of the committed document",
          context: { volumeId },
        });
      }
      if (staged.document.volumes[volumeId] !== undefined) {
        throw new WorkspaceError({
          family: "validation",
          code: "REMOVED_VOLUME_KEPT",
          message: "Removed volume must be absent from the staged document",
          context: { volumeId },
        });
      }
    }
    this.#document = deepFreeze(staged.document);
    this.#repository.installVolumes(staged.volumes);
    this.#repository.removeVolumes(staged.removedVolumes);
    this.#emit(deepFreeze(event));
  }

  #emit(event: DocumentCommitted): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Subscriber exceptions are isolated and never break the commit.
      }
    }
  }
}

/** Deep-freezes a plain event object so consumers cannot mutate it. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}
