import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  createDocumentStore,
  type DocumentCommitted,
  type DocumentStore,
  type DocumentStoreHandle,
  type StagedState,
} from "@voxel-maker/document";
import { WorkspaceError } from "@voxel-maker/shared";
import { MemoryProjectStorage } from "./memory-storage.js";
import type {
  AtomicWriteOptions,
  AtomicWriteResult,
  ProjectStoragePort,
} from "./port.js";

export const VOLUME = volumeId("volume:storage:0001");

export const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

export function createDemoDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:storage:0001"),
    metadata: { title: "storage test", tags: [] },
    rootNodeId: nodeId("node:storage:root"),
    nodes: [
      {
        nodeId: nodeId("node:storage:root"),
        name: "Root",
        parentId: null,
        children: [],
        transform: identity,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "demo",
        color: "#ff8800",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: VOLUME,
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    ],
  });
}

export function createStore(): DocumentStoreHandle {
  return createDocumentStore({ document: createDemoDocument() });
}

/** Commits one voxel write as a new transaction (revision + 1). */
/** Removes one voxel as a new transaction (revision + 1). */
export function removeVoxel(
  store: DocumentStore,
  writeCapability: DocumentStoreHandle["writeCapability"],
  coordinate: Vec3i,
): number {
  const staged = store.stageVolume(VOLUME);
  if (staged === undefined) throw new Error("volume missing");
  staged.removeVoxel(coordinate, writeCapability);
  return commitStaged(store, writeCapability, staged, coordinate);
}

export function commitVoxel(
  store: DocumentStore,
  writeCapability: DocumentStoreHandle["writeCapability"],
  coordinate: Vec3i,
  material: number,
): number {
  const staged = store.stageVolume(VOLUME);
  if (staged === undefined) throw new Error("volume missing");
  staged.setVoxel(coordinate, material, writeCapability);
  return commitStaged(store, writeCapability, staged, coordinate);
}

function commitStaged(
  store: DocumentStore,
  writeCapability: DocumentStoreHandle["writeCapability"],
  staged: ReturnType<DocumentStore["stageVolume"]>,
  coordinate: Vec3i,
): number {
  if (staged === undefined) throw new Error("volume missing");
  const document = { ...store.getDocument(), revision: store.revision + 1 };
  const event: DocumentCommitted = {
    revisionBefore: store.revision,
    revisionAfter: store.revision + 1,
    transactionId: transactionId(
      `transaction:storage:${String(store.revision + 1)}`,
    ),
    source: "ui",
    commandIds: [commandId(`command:storage:${String(store.revision + 1)}`)],
    commandTypes: ["voxel.set"],
    changedNodeIds: [],
    changedMaterialIds: [],
    changedAnimationIds: [],
    changedVolumes: [
      {
        volumeId: VOLUME,
        chunks: [{ coordinate, revision: store.revision + 1 }],
      },
    ],
  };
  const stagedState: StagedState = {
    document,
    volumes: new Map([[VOLUME, staged]]),
  };
  store.commit(stagedState, event, writeCapability);
  return store.revision;
}

/** Storage port wrapper that gates every write behind a caller-controlled promise. */
export class GatedPort implements ProjectStoragePort {
  readonly #inner: ProjectStoragePort;
  #gate: Promise<void> | undefined;
  #release: (() => void) | undefined;
  #enteredResolve: (() => void) | undefined;
  readonly #entered = new Promise<void>((resolve) => {
    this.#enteredResolve = resolve;
  });
  writeCount = 0;

  constructor(inner: ProjectStoragePort) {
    this.#inner = inner;
  }

  /** Waits until the next writeProjectAtomic call has entered the adapter. */
  entered(): Promise<void> {
    return this.#entered;
  }

  gate(): void {
    this.#gate = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release?.();
    this.#release = undefined;
    this.#gate = undefined;
  }

  async readProject(path: string): Promise<Uint8Array> {
    return this.#inner.readProject(path);
  }

  async writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
    options?: AtomicWriteOptions,
  ): Promise<AtomicWriteResult> {
    this.writeCount += 1;
    this.#enteredResolve?.();
    this.#enteredResolve = undefined;
    if (this.#gate !== undefined) await this.#gate;
    return this.#inner.writeProjectAtomic(path, bytes, options);
  }

  async exists(path: string): Promise<boolean> {
    return this.#inner.exists(path);
  }

  async remove(path: string): Promise<void> {
    return this.#inner.remove(path);
  }

  async readBackup(path: string): Promise<Uint8Array | undefined> {
    return this.#inner.readBackup(path);
  }
}

/** Counting port: records the maximum number of concurrent writes. */
export class CountingPort extends GatedPort {
  active = 0;
  maxActive = 0;

  override async writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
    options?: AtomicWriteOptions,
  ): Promise<AtomicWriteResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await super.writeProjectAtomic(path, bytes, options);
    } finally {
      this.active -= 1;
    }
  }
}

/** Memory port that fails the next write with a disk-full style error. */
export class FailingPort extends MemoryProjectStorage {
  failNextWrite = false;

  override async writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
    options?: AtomicWriteOptions,
  ): Promise<AtomicWriteResult> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new WorkspaceError({
        family: "io",
        code: "IO_DISK_FULL",
        message: "simulated disk full",
        context: { path },
      });
    }
    return super.writeProjectAtomic(path, bytes, options);
  }
}
