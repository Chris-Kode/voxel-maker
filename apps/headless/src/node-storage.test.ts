import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSaveCoordinator,
  createVxlProjectEncoder,
  IO_ERROR_CODES,
  journalPathFor,
  recoveryJournalPortConformanceCases,
  storagePortConformanceCases,
  type AtomicWriteFaultPlan,
  type AtomicWriteOptions,
  type AtomicWriteResult,
  type ProjectStoragePort,
} from "@voxel-maker/storage";
import { createDocumentStore } from "@voxel-maker/document";
import { createDocument } from "@voxel-maker/model";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import { readVxlProject } from "@voxel-maker/formats";
import { NodeProjectStorage } from "./node-storage.js";

async function makeDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "voxel-maker-node-storage-"));
}

describe("NodeProjectStorage conformance", () => {
  for (const testCase of storagePortConformanceCases(async (options) => {
    const dir = await makeDirectory();
    const port = new NodeProjectStorage({
      ...(options?.faults === undefined ? {} : { faults: options.faults }),
      nonce: () => "nonce",
    });
    return {
      port,
      projectPath: join(dir, "project.vxl"),
      tempPaths: async () =>
        (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  })) {
    it(testCase.name, async () => {
      await testCase.run();
    });
  }
});

describe("NodeProjectStorage recovery journal conformance", () => {
  for (const testCase of recoveryJournalPortConformanceCases(
    async (options) => {
      const dir = await makeDirectory();
      const port = new NodeProjectStorage({
        ...(options?.faults === undefined ? {} : { faults: options.faults }),
        nonce: () => "nonce",
      });
      return {
        port,
        projectPath: join(dir, "project.vxl"),
        tempPaths: async () =>
          (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
        cleanup: async () => {
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
  )) {
    it(testCase.name, async () => {
      await testCase.run();
    });
  }
});

describe("NodeProjectStorage real journal behavior", () => {
  it("appends, replaces, reads, and removes a journal beside the project", async () => {
    const dir = await makeDirectory();
    try {
      const path = join(dir, "demo.vxl");
      const port = new NodeProjectStorage();
      expect(await port.readJournal(path)).toBeUndefined();

      await port.appendJournal(path, new TextEncoder().encode("frame-a"));
      await port.appendJournal(path, new TextEncoder().encode("frame-b"));
      const journalPath = journalPathFor(path);
      const bytes = await readFile(journalPath);
      expect(new TextDecoder().decode(bytes)).toBe("frame-aframe-b");
      expect((await readdir(dir)).includes("demo.vxl.journal")).toBe(true);

      await port.replaceJournal(path, new TextEncoder().encode("compact"));
      expect(new TextDecoder().decode(await readFile(journalPath))).toBe(
        "compact",
      );

      await port.removeJournal(path);
      expect(await port.readJournal(path)).toBeUndefined();
      expect((await readdir(dir)).includes("demo.vxl.journal")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves no temporary files after an atomic journal replacement", async () => {
    const dir = await makeDirectory();
    try {
      const path = join(dir, "demo.vxl");
      const port = new NodeProjectStorage();
      await port.appendJournal(path, new TextEncoder().encode("v1"));
      await port.replaceJournal(path, new TextEncoder().encode("v2"));
      const entries = await readdir(dir);
      expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(
        new TextDecoder().decode(await readFile(journalPathFor(path))),
      ).toBe("v2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("NodeProjectStorage real filesystem behavior", () => {
  it("writes, backs up, reads, and removes a project in a real directory", async () => {
    const dir = await makeDirectory();
    try {
      const path = join(dir, "demo.vxl");
      const port = new NodeProjectStorage();
      const first = await port.writeProjectAtomic(
        path,
        new TextEncoder().encode("v1"),
      );
      expect(first.backupCreated).toBe(false);
      const second = await port.writeProjectAtomic(
        path,
        new TextEncoder().encode("v2"),
      );
      expect(second.backupCreated).toBe(true);
      expect(second.backupPath).toBe(`${path}.bak`);
      expect(new TextDecoder().decode(await port.readProject(path))).toBe("v2");
      expect(
        new TextDecoder().decode((await port.readBackup(path)) as Uint8Array),
      ).toBe("v1");
      expect(await port.exists(path)).toBe(true);
      await port.remove(path);
      expect(await port.exists(path)).toBe(false);
      await expect(port.readProject(path)).rejects.toMatchObject({
        code: IO_ERROR_CODES.notFound,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses a same-directory temporary file and removes it on failure", async () => {
    const dir = await makeDirectory();
    try {
      const path = join(dir, "demo.vxl");
      const port = new NodeProjectStorage();
      await port.writeProjectAtomic(path, new TextEncoder().encode("v1"));

      const controller = new AbortController();
      controller.abort();
      const error = await port
        .writeProjectAtomic(path, new TextEncoder().encode("v2"), {
          signal: controller.signal,
        })
        .then(
          () => {
            throw new Error("expected interruption");
          },
          (caught: unknown) => caught,
        );
      expect(error).toMatchObject({ code: IO_ERROR_CODES.writeInterrupted });
      const tempPath = (error as { context?: { tempPath?: string } }).context
        ?.tempPath;
      expect(tempPath).toBeDefined();
      expect(dirname(tempPath as string)).toBe(dir);
      expect(basename(tempPath as string)).toMatch(/^\.demo\.vxl\..+\.tmp$/u);

      const entries = await readdir(dir);
      expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(new TextDecoder().decode(await readFile(path))).toBe("v1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the destination intact when the replace phase fails", async () => {
    const dir = await makeDirectory();
    try {
      const path = join(dir, "demo.vxl");
      const port = new NodeProjectStorage();
      await port.writeProjectAtomic(path, new TextEncoder().encode("v1"));
      const faults: AtomicWriteFaultPlan = { failAt: { replace: true } };
      await expect(
        port.writeProjectAtomic(path, new TextEncoder().encode("v2"), {
          faults,
        }),
      ).rejects.toMatchObject({ code: IO_ERROR_CODES.renameFailed });
      expect(new TextDecoder().decode(await readFile(path))).toBe("v1");
      const entries = await readdir(dir);
      expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps a real missing-directory failure to a stable error", async () => {
    const port = new NodeProjectStorage();
    const missing = join(tmpdir(), "no-such-voxel-maker-dir-xyz", "p.vxl");
    const error = await port
      .writeProjectAtomic(missing, new TextEncoder().encode("v1"))
      .then(
        () => {
          throw new Error("expected failure");
        },
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({ code: IO_ERROR_CODES.writeFailed });
  });

  it("interrupts a chunked write mid-flight and leaves destination and backup untouched", async () => {
    const dir = await makeDirectory();
    try {
      const path = join(dir, "demo.vxl");
      const port = new NodeProjectStorage({ writeChunkBytes: 1024 });
      await port.writeProjectAtomic(path, new TextEncoder().encode("v1"));
      // A signal whose `aborted` getter flips after a few phase checks makes
      // the mid-write interruption deterministic: several chunks are
      // written, then the next boundary check aborts the write.
      let reads = 0;
      const signal = {
        get aborted(): boolean {
          reads += 1;
          return reads >= 4;
        },
      } as unknown as AbortSignal;
      const payload = new Uint8Array(64 * 1024).fill(0x42);
      await expect(
        port.writeProjectAtomic(path, payload, { signal }),
      ).rejects.toMatchObject({ code: IO_ERROR_CODES.writeInterrupted });
      expect(reads).toBeGreaterThanOrEqual(4);
      expect(new TextDecoder().decode(await readFile(path))).toBe("v1");
      expect(await port.readBackup(path)).toBeUndefined();
      const entries = await readdir(dir);
      expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the previous last-known-good backup intact when the backup install fails", async () => {
    const dir = await makeDirectory();
    try {
      const path = join(dir, "demo.vxl");
      const port = new NodeProjectStorage();
      await port.writeProjectAtomic(path, new TextEncoder().encode("v1"));
      await port.writeProjectAtomic(path, new TextEncoder().encode("v2"));
      expect(
        new TextDecoder().decode((await port.readBackup(path)) as Uint8Array),
      ).toBe("v1");
      // Replace the backup file with a directory: the atomic backup refresh
      // copies to a temporary file and fails when renaming over the
      // directory, so the previous backup and destination must stay intact.
      await rm(join(dir, "demo.vxl.bak"), { force: true });
      await mkdir(join(dir, "demo.vxl.bak"));
      const error = await port
        .writeProjectAtomic(path, new TextEncoder().encode("v3"))
        .then(
          () => {
            throw new Error("expected backup failure");
          },
          (caught: unknown) => caught,
        );
      expect(error).toMatchObject({ family: "io" });
      expect([
        IO_ERROR_CODES.writeFailed,
        IO_ERROR_CODES.permissionDenied,
      ]).toContain((error as { code: string }).code);
      expect(new TextDecoder().decode(await readFile(path))).toBe("v2");
      const entries = await readdir(dir);
      expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drives a stale completion through the coordinator against the Node adapter", async () => {
    const dir = await makeDirectory();
    try {
      const path = join(dir, "project.vxl");
      const identity = {
        translation: [0, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      } as const;
      const volume = volumeId("volume:node-stale:0001");
      const document = createDocument({
        documentId: documentId("document:node-stale:0001"),
        metadata: {},
        rootNodeId: nodeId("node:node-stale:root"),
        nodes: [
          {
            nodeId: nodeId("node:node-stale:root"),
            name: "Root",
            parentId: null,
            children: [],
            transform: identity,
            components: [{ kind: "voxel", schemaVersion: 1, volumeId: volume }],
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
          { volumeId: volume, bounds: { min: [-1, -1, -1], max: [1, 1, 1] } },
        ],
      });
      const { store, writeCapability } = createDocumentStore({ document });
      const inner = new NodeProjectStorage();
      const gated = new GatedWritePort(inner);
      const coordinator = createSaveCoordinator({
        store,
        port: gated,
        encoder: createVxlProjectEncoder(),
      });
      const captured = coordinator.capture();

      gated.gate();
      const savePromise = coordinator.save(path);
      await gated.entered();

      // Edit while the rev-0 write is still in flight on the real adapter.
      const staged = store.stageVolume(volume);
      if (staged === undefined) throw new Error("volume missing");
      staged.setVoxel([0, 0, 0], 1, writeCapability);
      store.commit(
        {
          document: { ...store.getDocument(), revision: 1 },
          volumes: new Map([[volume, staged]]),
          removedVolumes: [],
        },
        {
          revisionBefore: 0,
          revisionAfter: 1,
          transactionId: transactionId("transaction:node-stale:0001"),
          source: "ui",
          commandIds: [commandId("command:node-stale:0001")],
          commandTypes: ["voxel.set"],
          changedNodeIds: [],
          changedMaterialIds: [],
          changedAnimationIds: [],
          changedVolumes: [
            {
              volumeId: volume,
              chunks: [{ coordinate: [0, 0, 0], revision: 1 }],
            },
          ],
        },
        writeCapability,
      );

      gated.release();
      const outcome = await savePromise;
      expect(outcome.status).toBe("saved");
      expect(outcome.revision).toBe(0);
      expect(coordinator.lastDurableRevision()).toBe(0);
      // Stale completion must not clear dirty state on the Node adapter.
      expect(coordinator.isDirty()).toBe(true);
      // The bytes that reached disk are the captured snapshot, not live state.
      const loaded = readVxlProject(await inner.readProject(path));
      expect(loaded.semanticHash).toBe(captured.semanticHash);
      expect(loaded.document.revision).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Gated storage port wrapper used to hold a Node write in flight. */
class GatedWritePort implements ProjectStoragePort {
  readonly #inner: ProjectStoragePort;
  #gate: Promise<void> | undefined;
  #release: (() => void) | undefined;
  #enteredResolve: (() => void) | undefined;
  readonly #entered = new Promise<void>((resolve) => {
    this.#enteredResolve = resolve;
  });

  constructor(inner: ProjectStoragePort) {
    this.#inner = inner;
  }

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

  readProject(path: string): Promise<Uint8Array> {
    return this.#inner.readProject(path);
  }

  async writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
    options?: AtomicWriteOptions,
  ): Promise<AtomicWriteResult> {
    this.#enteredResolve?.();
    this.#enteredResolve = undefined;
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
