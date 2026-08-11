import { describe, expect, it, vi } from "vitest";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  WorkspaceError,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  createDocumentStoreHandle,
  type DocumentStore,
} from "@voxel-maker/document/internal";
import {
  CommandBus,
  CommandRegistry,
  fillBoxCommand,
  registerBatchCommands,
} from "@voxel-maker/commands";
import {
  createSaveCoordinator,
  createVxlProjectEncoder,
  MemoryProjectStorage,
  type AtomicWriteResult,
  type ProjectStoragePort,
} from "@voxel-maker/storage";
import {
  createAutosave,
  type AutosaveController,
  type AutosaveOptions,
} from "./autosave.js";

/**
 * Debounced autosave binding (plan S5.8, ticket #22, issue #121): an edit
 * that lands while a snapshot save is in flight must schedule a second
 * serialized autosave of the newer revision and end clean. Tests drive the
 * real save coordinator, document store, and command bus; only the
 * storage write is gated to hold the first save open while later edits
 * commit.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:autosave:root");
const VOLUME = volumeId("volume:autosave:0001");

function buildDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:autosave:0001"),
    metadata: { title: "autosave fixture" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [],
        transform: IDENTITY,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "stone",
        color: "#aabbcc",
        opacity: 1,
        roughness: 0.8,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: VOLUME,
        bounds: { min: [0, 0, 0], max: [6, 6, 6] },
      },
    ],
  });
}

interface Fixture {
  readonly store: DocumentStore;
  readonly bus: CommandBus;
  readonly coordinator: ReturnType<typeof createSaveCoordinator>;
}

/** A store + bus over a fresh document with a real save coordinator. */
function createFixture(port: ProjectStoragePort): Fixture {
  const { store, writeCapability } = createDocumentStoreHandle({
    document: buildDocument(),
  });
  const registry = new CommandRegistry();
  registerBatchCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);
  const coordinator = createSaveCoordinator({
    store,
    port,
    encoder: createVxlProjectEncoder(),
  });
  return { store, bus, coordinator };
}

/**
 * Fixture coordinator seeded clean at the current revision plus a
 * debounced autosave bound to it. Callers override autosave options
 * (e.g. `onFailure`) through `options`.
 */
function setupAutosave(
  port: ProjectStoragePort,
  options: Partial<AutosaveOptions> = {},
): Fixture & { readonly autosave: AutosaveController } {
  const fixture = createFixture(port);
  fixture.coordinator.markDurable(
    fixture.store.revision,
    fixture.coordinator.capture().semanticHash,
    "project.vxl",
  );
  const autosave = createAutosave({
    coordinator: fixture.coordinator,
    path: () => "project.vxl",
    delayMs: 10,
    ...options,
  });
  return { ...fixture, autosave };
}

/** One deterministic voxel fill through the bus (revision + 1). */
function fill(store: DocumentStore, bus: CommandBus, serial: number): void {
  const result = bus.execute(
    fillBoxCommand(commandId(`command:autosave:fill:${String(serial)}`), {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [1, 1, 1] },
      material: materialId(1),
    }),
    {
      transactionId: transactionId(
        `transaction:autosave:fill:${String(serial)}`,
      ),
      expectedRevision: store.revision,
      source: "system",
    },
  );
  if (!result.ok) throw new Error(`fixture fill failed: ${result.error.code}`);
}

/** Storage port that gates every write behind a caller-controlled promise. */
class GatedPort implements ProjectStoragePort {
  readonly #inner: MemoryProjectStorage;
  #gate: Promise<void> | undefined;
  #release: (() => void) | undefined;
  writeCount = 0;
  /** Number of upcoming writes that fail before writes succeed again. */
  failNextWrites = 0;

  constructor(inner: MemoryProjectStorage) {
    this.#inner = inner;
  }

  gate(): void {
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release?.();
    this.#release = undefined;
    this.#gate = undefined;
  }

  async entered(): Promise<void> {
    while (this.writeCount === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  async readProject(path: string): Promise<Uint8Array> {
    return this.#inner.readProject(path);
  }

  async writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
    options?: {
      readonly signal?: AbortSignal;
      readonly onPhase?: (phase: string) => void;
    },
  ): Promise<AtomicWriteResult> {
    this.writeCount += 1;
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      throw new WorkspaceError({
        family: "io",
        code: "IO_DISK_FULL",
        message: "simulated disk full",
        context: { path },
      });
    }
    if (this.#gate !== undefined) await this.#gate;
    return this.#inner.writeProjectAtomic(path, bytes, options);
  }

  exists(path: string): Promise<boolean> {
    return this.#inner.exists(path);
  }

  remove(path: string): Promise<void> {
    return this.#inner.remove(path);
  }

  readBackup(path: string): Promise<Uint8Array | undefined> {
    return this.#inner.readBackup(path);
  }
}

describe("Autosave", () => {
  it("autosaves a debounced edit and clears the dirty state", async () => {
    const memory = new MemoryProjectStorage();
    const gated = new GatedPort(memory);
    const { store, bus, coordinator, autosave } = setupAutosave(gated);
    try {
      fill(store, bus, 1);
      expect(coordinator.isDirty()).toBe(true);
      await vi.waitFor(() => {
        expect(gated.writeCount).toBe(1);
      });
      await vi.waitFor(() => {
        expect(coordinator.isDirty()).toBe(false);
      });
      expect(coordinator.lastDurableRevision()).toBe(1);
    } finally {
      autosave.dispose();
    }
  });

  it("schedules a second autosave when an edit lands during an in-flight save and ends clean (issue #121)", async () => {
    const memory = new MemoryProjectStorage();
    const gated = new GatedPort(memory);
    const { store, bus, coordinator, autosave } = setupAutosave(gated);
    try {
      // First edit schedules an autosave; hold its write open. The
      // dirty read is how the app observes the coordinator (status
      // reads trigger the dirty-changed transition the autosave listens
      // for).
      fill(store, bus, 1);
      expect(coordinator.isDirty()).toBe(true);
      gated.gate();
      await gated.entered();
      expect(gated.writeCount).toBe(1);

      // A second edit lands while the first snapshot is still being
      // written: dirty is already true, so no new dirty-changed
      // transition will arrive when the stale save completes.
      fill(store, bus, 2);
      expect(coordinator.isDirty()).toBe(true);
      expect(store.revision).toBe(2);

      // The stale completion must schedule one more serialized autosave
      // of the latest revision, which then clears the dirty state.
      gated.release();
      await vi.waitFor(() => {
        expect(gated.writeCount).toBe(2);
      });
      await vi.waitFor(() => {
        expect(coordinator.isDirty()).toBe(false);
      });
      expect(coordinator.lastDurableRevision()).toBe(2);
      const saved = await memory.readProject("project.vxl");
      expect(saved.byteLength).toBeGreaterThan(0);
    } finally {
      autosave.dispose();
    }
  });

  it("does not schedule a follow-up after a clean save", async () => {
    const memory = new MemoryProjectStorage();
    const gated = new GatedPort(memory);
    const { store, bus, coordinator, autosave } = setupAutosave(gated);
    try {
      fill(store, bus, 1);
      expect(coordinator.isDirty()).toBe(true);
      await vi.waitFor(() => {
        expect(gated.writeCount).toBe(1);
      });
      await vi.waitFor(() => {
        expect(coordinator.isDirty()).toBe(false);
      });
      // No edits landed during the save, so the clean completion must
      // not start another write.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(gated.writeCount).toBe(1);
    } finally {
      autosave.dispose();
    }
  });

  it("disposal prevents a follow-up autosave after a stale completion", async () => {
    const memory = new MemoryProjectStorage();
    const gated = new GatedPort(memory);
    const { store, bus, coordinator, autosave } = setupAutosave(gated);
    fill(store, bus, 1);
    expect(coordinator.isDirty()).toBe(true);
    gated.gate();
    await gated.entered();
    fill(store, bus, 2);
    expect(coordinator.isDirty()).toBe(true);
    // Dispose while the stale save is still in flight: the terminal
    // binding must not schedule the follow-up after completion.
    autosave.dispose();
    gated.release();
    await vi.waitFor(() => {
      expect(gated.writeCount).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(gated.writeCount).toBe(1);
    expect(coordinator.isDirty()).toBe(true);
  });

  it("retries a failed autosave once and never loops on persistent failure", async () => {
    const memory = new MemoryProjectStorage();
    const gated = new GatedPort(memory);
    const failures: string[] = [];
    const { store, bus, coordinator, autosave } = setupAutosave(gated, {
      onFailure: (error) => {
        failures.push(error.code);
      },
    });
    try {
      // The initial attempt and its single bounded retry both fail, so
      // the project stays dirty.
      gated.failNextWrites = 2;
      fill(store, bus, 1);
      expect(coordinator.isDirty()).toBe(true);
      await vi.waitFor(() => {
        expect(gated.writeCount).toBe(2);
      });
      await vi.waitFor(() => {
        expect(failures.length).toBe(2);
      });
      // A second failure must not loop: no third write happens even
      // though the project stays dirty.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(gated.writeCount).toBe(2);
      expect(failures.length).toBe(2);
      expect(coordinator.isDirty()).toBe(true);
    } finally {
      autosave.dispose();
    }
  });
});
