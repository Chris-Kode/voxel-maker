import { describe, expect, it } from "vitest";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import {
  DEFAULT_DOCUMENT_LIMITS,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { createDocumentStore } from "@voxel-maker/document";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import {
  DEFAULT_COMMAND_LIMITS,
  type CommandLimits,
  type TransactionOptions,
} from "./types.js";
import { fillBoxCommand, registerBatchCommands } from "./batch-commands.js";
import { registerVoxelCommands } from "./voxel-commands.js";

/**
 * Document/transaction voxel hard limits are totals per Document or per
 * Transaction (ADR-0009), never per volume or per command (issue #92).
 * These tests pin the two aggregate gates: the cumulative per-transaction
 * voxel meter on the command bus and the document-wide occupied/chunk
 * preflight in `DocumentStore.commit`.
 */

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const VOLUME_A = volumeId("volume:limits:a");
const VOLUME_B = volumeId("volume:limits:b");

function createTwoVolumeDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:limits:0001"),
    metadata: { title: "limits", tags: [] },
    rootNodeId: nodeId("node:limits:root"),
    nodes: [
      {
        nodeId: nodeId("node:limits:root"),
        name: "Root",
        parentId: null,
        children: [],
        transform: identity,
        components: [],
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
      { volumeId: VOLUME_A, bounds: { min: [0, 0, 0], max: [1, 1, 1] } },
      { volumeId: VOLUME_B, bounds: { min: [0, 0, 0], max: [1, 1, 1] } },
    ],
    animations: [],
  });
}

function createHarness(options?: {
  readonly commandLimits?: CommandLimits;
  readonly documentLimits?: typeof DEFAULT_DOCUMENT_LIMITS;
}): {
  readonly bus: CommandBus;
  readonly store: ReturnType<typeof createDocumentStore>["store"];
} {
  const { store, writeCapability } = createDocumentStore({
    document: createTwoVolumeDocument(),
    ...(options?.documentLimits === undefined
      ? {}
      : { limits: options.documentLimits }),
  });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  return {
    bus: new CommandBus(
      store,
      registry,
      writeCapability,
      options?.commandLimits,
    ),
    store,
  };
}

/** Half-open fill box of `x * y * z` voxels. */
function box(
  id: string,
  volume: ReturnType<typeof volumeId>,
  size: readonly [number, number, number],
): ReturnType<typeof fillBoxCommand> {
  return fillBoxCommand(commandId(`command:limits:${id}`), {
    volumeId: volume,
    region: {
      min: [0, 0, 0],
      max: [size[0], size[1], size[2]],
    },
    material: materialId(1),
  });
}

const options = (id: string, expectedRevision: number): TransactionOptions => ({
  transactionId: transactionId(`transaction:limits:${id}`),
  expectedRevision,
  source: "ui",
});

describe("per-transaction voxel limit (ADR-0009, issue #92)", () => {
  it(
    "rejects one transaction changing 1,020,000 voxels across two volumes",
    // Full-scale acceptance case: staging 1.02M voxels takes seconds under
    // parallel CI load, so the default 5s vitest timeout is insufficient.
    { timeout: 60_000 },
    () => {
      // Issue #92 evidence: two fillBoxCommands of 510,000 voxels in two
      // volumes previously committed with `{ ok: true, revision: 1 }`.
      const { bus, store } = createHarness();
      const result = bus.executeTransaction(
        [
          box("tx-over:a", VOLUME_A, [510, 100, 10]),
          box("tx-over:b", VOLUME_B, [510, 100, 10]),
        ],
        options("tx-over", 0),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.family).toBe("limit");
      expect(result.error.code).toBe("TOO_MANY_VOXELS");
      expect(result.error.message).toMatch(/transaction/u);
      expect(result.error.context).toMatchObject({
        requested: 1_020_000,
        limit: 1_000_000,
        resource: "voxelsPerTransaction",
      });
      // Atomic rejection at Revision 0: no volume, revision, or history
      // change leaks out of the staged overlay.
      expect(store.revision).toBe(0);
      expect(store.getVolume(VOLUME_A)?.occupiedCount()).toBe(0);
      expect(store.getVolume(VOLUME_B)?.occupiedCount()).toBe(0);
      expect(store.getVolume(VOLUME_A)?.chunkCount()).toBe(0);
      expect(store.getVolume(VOLUME_B)?.chunkCount()).toBe(0);
      expect(bus.canUndo()).toBe(false);
    },
  );

  it(
    "commits one transaction changing exactly 1,000,000 voxels across two volumes",
    { timeout: 60_000 },
    () => {
      const { bus, store } = createHarness();
      const result = bus.executeTransaction(
        [
          box("tx-exact:a", VOLUME_A, [500, 100, 10]),
          box("tx-exact:b", VOLUME_B, [500, 100, 10]),
        ],
        options("tx-exact", 0),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(store.revision).toBe(1);
      expect(store.getVolume(VOLUME_A)?.occupiedCount()).toBe(500_000);
      expect(store.getVolume(VOLUME_B)?.occupiedCount()).toBe(500_000);
    },
  );

  it("enforces the cumulative meter with a lowered transaction limit", () => {
    const { bus, store } = createHarness({
      commandLimits: {
        ...DEFAULT_COMMAND_LIMITS,
        maxVoxelsPerTransaction: 100,
      },
    });
    const first = bus.execute(
      box("low:first", VOLUME_A, [60, 1, 1]),
      options("low:first", 0),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(store.revision).toBe(1);
    // Both boxes write disjoint voxels (60 + 60 = 120 > 100). Reusing the
    // already-filled region would make the first box a no-op and correctly
    // count 0 toward the meter.
    const second = bus.executeTransaction(
      [
        fillBoxCommand(commandId("command:limits:low:a"), {
          volumeId: VOLUME_A,
          region: { min: [100, 0, 0], max: [160, 1, 1] },
          material: materialId(1),
        }),
        box("low:b", VOLUME_B, [60, 1, 1]),
      ],
      options("low:second", 1),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("TOO_MANY_VOXELS");
    expect(second.error.context).toMatchObject({
      requested: 120,
      limit: 100,
    });
    expect(store.revision).toBe(1);
    expect(store.getVolume(VOLUME_B)?.occupiedCount()).toBe(0);
  });
});

describe("document-wide voxel totals (ADR-0009, issue #92)", () => {
  it("rejects a commit whose aggregate occupied voxels exceed the document limit", () => {
    const { bus, store } = createHarness({
      documentLimits: {
        ...DEFAULT_DOCUMENT_LIMITS,
        maxOccupiedVoxels: 100,
      },
    });
    const first = bus.execute(
      box("doc-occ:first", VOLUME_A, [60, 1, 1]),
      options("doc-occ:first", 0),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(store.revision).toBe(1);
    // Volume B alone is within every per-volume limit; only the aggregate
    // document total rejects.
    const second = bus.execute(
      box("doc-occ:second", VOLUME_B, [60, 1, 1]),
      options("doc-occ:second", 1),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("TOO_MANY_OCCUPIED_VOXELS");
    expect(second.error.message).toMatch(/document/i);
    expect(second.error.context).toMatchObject({
      requested: 120,
      limit: 100,
    });
    expect(store.revision).toBe(1);
    expect(store.getVolume(VOLUME_B)?.occupiedCount()).toBe(0);
  });

  it("rejects a commit whose aggregate non-empty chunks exceed the document limit", () => {
    const { bus, store } = createHarness({
      documentLimits: {
        ...DEFAULT_DOCUMENT_LIMITS,
        maxChunks: 3,
      },
    });
    // Each box spans two chunks (x = 0..17 covers chunk 0 and chunk 1).
    const twoChunkBox = (
      id: string,
      volume: ReturnType<typeof volumeId>,
    ): ReturnType<typeof fillBoxCommand> =>
      fillBoxCommand(commandId(`command:limits:${id}`), {
        volumeId: volume,
        region: { min: [0, 0, 0], max: [18, 1, 1] },
        material: materialId(1),
      });
    const first = bus.execute(
      twoChunkBox("doc-chunk:first", VOLUME_A),
      options("doc-chunk:first", 0),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(store.getVolume(VOLUME_A)?.chunkCount()).toBe(2);
    const second = bus.execute(
      twoChunkBox("doc-chunk:second", VOLUME_B),
      options("doc-chunk:second", 1),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("TOO_MANY_CHUNKS");
    expect(second.error.message).toMatch(/document/i);
    expect(second.error.context).toMatchObject({ requested: 4, limit: 3 });
    expect(store.revision).toBe(1);
    expect(store.getVolume(VOLUME_B)?.chunkCount()).toBe(0);
  });
});
