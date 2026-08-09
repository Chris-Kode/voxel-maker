import { describe, expect, it } from "vitest";
import {
  commandId,
  nodeId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import {
  cloneDocument,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import type { DocumentStoreRead } from "@voxel-maker/document";
import { CommandBus } from "./bus.js";
import {
  NODE_ADD_JOINT_COMMAND,
  NODE_REMOVE_JOINT_COMMAND,
  NODE_REMOVE_PIVOT_COMMAND,
  NODE_SET_PIVOT_COMMAND,
  addJointCommand,
  registerArticulationCommands,
  removeJointCommand,
  removePivotCommand,
  setPivotCommand,
} from "./articulation-commands.js";
import {
  runCommandConformanceSuite,
  type CommandConformanceSpec,
} from "./conformance.js";

/**
 * Articulation component command conformance (plan S9.3, ticket #26):
 * the per-discriminant pivot/joint lifecycle commands run the full shared
 * command battery — codec, validity, exact-restore undo/redo, determinism,
 * conflict, limits, rollback, idempotency, history, and audit metadata.
 * A joint annotation lives on the single node hierarchy; these commands
 * never introduce a skeleton graph.
 */

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:conformance:articulation:root");
const CHILD = nodeId("node:conformance:articulation:child");
const VOLUME = volumeId("volume:conformance:articulation:0001");

function buildFixtureDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:conformance:articulation" as never,
    metadata: { title: "articulation conformance" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [CHILD],
        transform: identity,
        components: [],
      },
      {
        nodeId: CHILD,
        name: "Child",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
    ],
    volumes: [{ volumeId: VOLUME }],
  });
}

const fixture = buildFixtureDocument();

const createFixture = (): VoxelDocument => cloneDocument(fixture);

const nodeRecord = (store: DocumentStoreRead, id: string) =>
  store.getDocument().nodes[id as never];

const setPivotSpec: CommandConformanceSpec = {
  name: "node.setPivot@1",
  type: NODE_SET_PIVOT_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerArticulationCommands,
  buildValid: (id) => setPivotCommand(id, { nodeId: CHILD, pivot: [2, 0, -1] }),
  buildInvalid: (id) =>
    setPivotCommand(id, {
      nodeId: nodeId("node:conformance:missing"),
      pivot: [0, 0, 0],
    }),
  buildSecondValid: (id) =>
    setPivotCommand(id, { nodeId: ROOT, pivot: [0, 1, 0] }),
  assertApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
      { kind: "pivot", schemaVersion: 1, pivot: [2, 0, -1] },
    ]);
  },
  assertUndone: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
    ]);
  },
  assertSecondApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
      { kind: "pivot", schemaVersion: 1, pivot: [2, 0, -1] },
    ]);
    expect(nodeRecord(store, ROOT)?.components).toEqual([
      { kind: "pivot", schemaVersion: 1, pivot: [0, 1, 0] },
    ]);
  },
};

const removePivotSpec: CommandConformanceSpec = {
  name: "node.removePivot@1",
  type: NODE_REMOVE_PIVOT_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerArticulationCommands,
  seed(bus: CommandBus, store: DocumentStoreRead): void {
    const result = bus.execute(
      setPivotCommand(commandId("command:conformance:seed:pivot:0001"), {
        nodeId: CHILD,
        pivot: [1, 2, 3],
      }),
      {
        transactionId: transactionId("transaction:conformance:seed:pivot:0001"),
        expectedRevision: store.revision,
        source: "ui",
      },
    );
    if (!result.ok) {
      throw new Error(`conformance seed failed: ${result.error.code}`);
    }
  },
  buildValid: (id) => removePivotCommand(id, { nodeId: CHILD }),
  buildInvalid: (id) =>
    removePivotCommand(id, { nodeId: nodeId("node:conformance:missing") }),
  buildSecondValid: (id) => removePivotCommand(id, { nodeId: ROOT }), // absent: no-op commit
  assertApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
    ]);
  },
  assertUndone: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
      { kind: "pivot", schemaVersion: 1, pivot: [1, 2, 3] },
    ]);
  },
};

const addJointSpec: CommandConformanceSpec = {
  name: "node.addJoint@1",
  type: NODE_ADD_JOINT_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerArticulationCommands,
  buildValid: (id) => addJointCommand(id, { nodeId: CHILD }),
  buildInvalid: (id) =>
    addJointCommand(id, { nodeId: nodeId("node:conformance:missing") }),
  buildSecondValid: (id) => addJointCommand(id, { nodeId: ROOT }),
  assertApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
      { kind: "joint", schemaVersion: 1 },
    ]);
  },
  assertUndone: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
    ]);
  },
  assertSecondApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
      { kind: "joint", schemaVersion: 1 },
    ]);
    expect(nodeRecord(store, ROOT)?.components).toEqual([
      { kind: "joint", schemaVersion: 1 },
    ]);
  },
};

const removeJointSpec: CommandConformanceSpec = {
  name: "node.removeJoint@1",
  type: NODE_REMOVE_JOINT_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: registerArticulationCommands,
  seed(bus: CommandBus, store: DocumentStoreRead): void {
    const result = bus.execute(
      addJointCommand(commandId("command:conformance:seed:joint:0001"), {
        nodeId: CHILD,
      }),
      {
        transactionId: transactionId("transaction:conformance:seed:joint:0001"),
        expectedRevision: store.revision,
        source: "ui",
      },
    );
    if (!result.ok) {
      throw new Error(`conformance seed failed: ${result.error.code}`);
    }
  },
  buildValid: (id) => removeJointCommand(id, { nodeId: CHILD }),
  buildInvalid: (id) =>
    removeJointCommand(id, { nodeId: nodeId("node:conformance:missing") }),
  buildSecondValid: (id) => removeJointCommand(id, { nodeId: ROOT }), // absent: no-op commit
  assertApplied: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
    ]);
  },
  assertUndone: (store) => {
    expect(nodeRecord(store, CHILD)?.components).toEqual([
      { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
      { kind: "joint", schemaVersion: 1 },
    ]);
  },
};

runCommandConformanceSuite(setPivotSpec, { describe, expect, it });
runCommandConformanceSuite(removePivotSpec, { describe, expect, it });
runCommandConformanceSuite(addJointSpec, { describe, expect, it });
runCommandConformanceSuite(removeJointSpec, { describe, expect, it });
