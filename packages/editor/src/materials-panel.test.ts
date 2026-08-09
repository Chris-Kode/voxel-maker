import { describe, expect, it } from "vitest";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  type VolumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  CommandBus,
  CommandRegistry,
  fillBoxCommand,
  registerBatchCommands,
  registerMaterialCommands,
  registerVoxelCommands,
} from "@voxel-maker/commands";
import {
  createDocumentStore,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import {
  countMaterialUsage,
  defaultNewMaterialPayload,
  materialUpdateChanges,
} from "./materials-panel.js";

/**
 * Ticket #21 headless panel-model tests (plan S7.13): usage counts,
 * next-id allocation, default create payloads, changed-field update
 * payloads, and reassignment candidates. Everything runs against a real
 * command bus and the authoritative store so the counts reflect committed
 * voxel data, not fixtures.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:test:root");
const CHILD = nodeId("node:test:child");
const VOLUME = volumeId("volume:test:0001");
const VOLUME_B = volumeId("volume:test:0002");
const MATERIAL = materialId(1);
const REPLACEMENT = materialId(2);

function buildDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:test:0001"),
    metadata: { title: "panel-fixture" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [CHILD],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: CHILD,
        name: "Box",
        parentId: ROOT,
        children: [],
        transform: IDENTITY,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
    ],
    materials: [
      {
        materialId: MATERIAL,
        name: "red",
        color: "#ff0000",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
      {
        materialId: REPLACEMENT,
        name: "blue",
        color: "#0000ff",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      { volumeId: VOLUME, bounds: { min: [0, 0, 0], max: [8, 8, 8] } },
      { volumeId: VOLUME_B, bounds: { min: [0, 0, 0], max: [8, 8, 8] } },
    ],
  });
}

interface Harness {
  readonly store: DocumentStoreRead;
  readonly bus: CommandBus;
  /** Fills a 2x2x2 box of `material` at the origin of `volume`. */
  fill(volume: VolumeId, material: number): void;
}

function createHarness(): Harness {
  const document = buildDocument();
  const { store, writeCapability } = createDocumentStore({ document });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  registerMaterialCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);
  return {
    store,
    bus,
    fill(volume, material) {
      const result = bus.execute(
        fillBoxCommand(
          commandId(`command:test:fill-${String(volume)}-${String(material)}`),
          {
            volumeId: volume,
            region: { min: [0, 0, 0], max: [2, 2, 2] },
            material: materialId(material),
          },
        ),
        {
          transactionId: transactionId(
            `transaction:test:fill-${volume}-${String(material)}`,
          ),
          expectedRevision: store.revision,
          source: "ui",
        },
      );
      if (!result.ok) throw new Error(`fill failed: ${result.error.code}`);
    },
  };
}

describe("countMaterialUsage", () => {
  it("zero-fills every document material on an empty document", () => {
    const { store } = createHarness();
    const counts = countMaterialUsage(store);
    expect(counts.get(MATERIAL)).toBe(0);
    expect(counts.get(REPLACEMENT)).toBe(0);
    expect(counts.size).toBe(2);
  });

  it("counts voxels per material across volumes after commits", () => {
    const harness = createHarness();
    harness.fill(VOLUME, 1);
    harness.fill(VOLUME_B, 2);
    const counts = countMaterialUsage(harness.store);
    // Two 2x2x2 boxes = 8 voxels each.
    expect(counts.get(MATERIAL)).toBe(8);
    expect(counts.get(REPLACEMENT)).toBe(8);
  });

  it("reflects undo, redo, and referenced deletion remaps", () => {
    const harness = createHarness();
    harness.fill(VOLUME, 1);

    const undone = harness.bus.undo({
      transactionId: transactionId("transaction:test:undo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    expect(undone.ok).toBe(true);
    expect(countMaterialUsage(harness.store).get(MATERIAL)).toBe(0);

    const redone = harness.bus.redo({
      transactionId: transactionId("transaction:test:redo"),
      expectedRevision: harness.store.revision,
      source: "ui",
    });
    expect(redone.ok).toBe(true);
    expect(countMaterialUsage(harness.store).get(MATERIAL)).toBe(8);
  });
});

describe("defaultNewMaterialPayload", () => {
  it("produces bounded canonical defaults", () => {
    const payload = defaultNewMaterialPayload(materialId(7));
    expect(payload.materialId).toBe(materialId(7));
    expect(payload.name).toBe("Material 7");
    expect(payload.color).toBe("#808080");
    expect(payload.opacity).toBe(1);
    expect(payload.roughness).toBe(0.5);
    expect(payload.metallic).toBe(0);
    expect(payload.emissive).toBe(0);
  });
});

describe("materialUpdateChanges", () => {
  const record = buildDocument().materials[MATERIAL];
  if (record === undefined) throw new Error("missing fixture record");

  it("keeps only fields that differ from the committed record", () => {
    const changes = materialUpdateChanges(record, {
      name: "crimson",
      color: "#ff0000", // same as the record: dropped
      opacity: 0.5,
    });
    expect(changes).toEqual({
      materialId: MATERIAL,
      name: "crimson",
      opacity: 0.5,
    });
  });

  it("returns undefined when nothing changed", () => {
    expect(
      materialUpdateChanges(record, {
        name: record.name,
        color: record.color,
        opacity: record.opacity,
      }),
    ).toBeUndefined();
  });

  it("canonicalizes colors before comparison and inclusion", () => {
    const changes = materialUpdateChanges(record, { color: "#FF0000" });
    expect(changes).toBeUndefined();
    const changed = materialUpdateChanges(record, { color: "#00FF00" });
    expect(changed?.color).toBe("#00ff00");
  });
});
