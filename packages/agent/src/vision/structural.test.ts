import { describe, expect, it } from "vitest";
import { CommandBus, CommandRegistry } from "@voxel-maker/commands";
import { commandId } from "@voxel-maker/shared";
import { createInspectionStore } from "../fixtures.js";
import { createPreviewRegistry } from "../registry.js";
import { createPreviewSession, previewSessionId } from "../preview.js";
import {
  measureStructure,
  structuralDelta,
  type StructuralMetrics,
} from "./structural.js";

/**
 * Structural metrics tests (plan S15.9, ticket #40): deterministic
 * occupied/chunk/volume/node/material/bounds summaries and the delta
 * between two snapshots used by the refinement regression gate.
 */

describe("measureStructure", () => {
  it("reports the fixture occupancy, chunks, nodes, and bounds", () => {
    const { handle } = createInspectionStore();
    const metrics = measureStructure(handle.store);
    expect(metrics.occupiedVoxels).toBe(4);
    expect(metrics.nonEmptyChunks).toBe(1);
    expect(metrics.volumeCount).toBe(2);
    expect(metrics.voxelVolumeCount).toBe(1);
    expect(metrics.nodeCount).toBe(4);
    expect(metrics.voxelNodeCount).toBe(1);
    expect(metrics.materialCount).toBe(2);
    expect(metrics.revision).toBe(handle.store.revision);
    expect(metrics.bounds).toEqual({
      min: [0, 0, 0],
      max: [1, 1, 1],
    });
  });

  it("is a pure read: measuring never mutates the store", () => {
    const { handle } = createInspectionStore();
    const before = handle.store.revision;
    measureStructure(handle.store);
    expect(handle.store.revision).toBe(before);
  });

  it("detects staged changes through the preview session", () => {
    const { handle } = createInspectionStore();
    const registry = createPreviewRegistry();
    const bus = new CommandBus(handle.store, registry, handle.writeCapability);
    void bus;
    const session = createPreviewSession({
      live: handle.store,
      registry,
      sessionId: previewSessionId("preview:structural:test"),
    });
    const before = measureStructure(handle.store);
    const fill = {
      id: commandId("cmd:fill:test"),
      type: "voxel.fillBox",
      schemaVersion: 1,
      payload: {
        volumeId: "volume:main",
        region: { min: [0, 0, 0], max: [2, 2, 2] },
        material: 1,
      },
    };
    const result = session.stage(fill);
    expect(result.ok).toBe(true);
    const after = measureStructure(session);
    expect(after.occupiedVoxels).toBeGreaterThan(before.occupiedVoxels);
    const delta = structuralDelta(before, after);
    expect(delta.occupiedVoxels).toBe(
      after.occupiedVoxels - before.occupiedVoxels,
    );
    expect(delta.occupiedFraction).toBeGreaterThan(0);
  });
});

describe("structuralDelta", () => {
  it("computes signed deltas and the bounds growth factor", () => {
    const empty: StructuralMetrics = {
      revision: 1,
      occupiedVoxels: 0,
      nonEmptyChunks: 0,
      volumeCount: 1,
      voxelVolumeCount: 0,
      nodeCount: 1,
      voxelNodeCount: 0,
      materialCount: 0,
      bounds: undefined,
    };
    const full: StructuralMetrics = {
      ...empty,
      occupiedVoxels: 100,
      nonEmptyChunks: 2,
      voxelVolumeCount: 1,
      voxelNodeCount: 1,
      materialCount: 3,
      bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    };
    const delta = structuralDelta(empty, full);
    expect(delta.occupiedVoxels).toBe(100);
    expect(delta.occupiedFraction).toBe(Infinity);
    expect(delta.materialCount).toBe(3);
    expect(delta.boundsDiagonalFactor).toBe(Infinity);
    const back = structuralDelta(full, empty);
    expect(back.occupiedVoxels).toBe(-100);
    expect(back.boundsDiagonalFactor).toBe(0);
  });
});

// Silence unused-import warnings for the CommandBus pairing used in the
// preview staging test above.
void CommandBus;
