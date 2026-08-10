import { describe, expect, it } from "vitest";
import {
  commandId,
  componentId,
  nodeId,
  transactionId,
  volumeId,
  type ComponentId,
} from "@voxel-maker/shared";
import {
  cloneDocument,
  createDocument,
  type ConstraintComponent,
  type RotationLimits,
  type VoxelDocument,
} from "@voxel-maker/model";
import type { DocumentStoreRead } from "@voxel-maker/document";
import { CommandBus } from "./bus.js";
import { CommandRegistry } from "./registry.js";
import {
  registerNodeCommands,
  setNodeComponentsCommand,
} from "./node-commands.js";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import {
  NODE_ADD_CONSTRAINT_COMMAND,
  NODE_REMOVE_CONSTRAINT_COMMAND,
  NODE_REORDER_CONSTRAINT_COMMAND,
  NODE_SET_CONSTRAINT_COMMAND,
  addConstraintCommand,
  registerArticulationCommands,
  removeConstraintCommand,
  reorderConstraintCommand,
  setConstraintCommand,
} from "./articulation-commands.js";
import {
  runCommandConformanceSuite,
  type CommandConformanceSpec,
} from "./conformance.js";

/**
 * Rotation constraint command conformance (plan S9.4, ticket #27): the
 * `node.addConstraint` / `node.setConstraint` / `node.reorderConstraint`
 * / `node.removeConstraint` lifecycle commands run the full shared
 * command battery — codec, validity, exact-restore undo/redo,
 * determinism, conflict, limits, rollback, idempotency, history, and
 * audit metadata. Constraints are stable local Euler XYZ rotation limits
 * with finite min <= max per axis (ADR-0006), carry caller-supplied
 * component ids unique within the document, and are ordered by their
 * persisted list position.
 */

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:conformance:constraint:root");
const CHILD = nodeId("node:conformance:constraint:child");
const VOLUME = volumeId("volume:conformance:constraint:0001");

const ID_A = componentId("component:conformance:constraint:a");
const ID_B = componentId("component:conformance:constraint:b");
const ID_C = componentId("component:conformance:constraint:c");

const LIMITS_A: RotationLimits = {
  min: [-Math.PI / 4, -0.1, -Math.PI],
  max: [Math.PI / 4, 0.1, Math.PI],
};
const LIMITS_B: RotationLimits = {
  min: [-1, -2, -3],
  max: [1, 2, 3],
};
const LIMITS_C: RotationLimits = {
  min: [-0.5, -0.5, -0.5],
  max: [0.5, 0.5, 0.5],
};

function buildFixtureDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:conformance:constraint" as never,
    metadata: { title: "constraint conformance" },
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

const createDocumentStoreFor = () =>
  createDocumentStoreHandle({ document: createFixture() });

const nodeRecord = (store: DocumentStoreRead, id: string) =>
  store.getDocument().nodes[id as never];

const constraintHolder = (
  store: DocumentStoreRead,
  id: string,
): ConstraintComponent | undefined =>
  nodeRecord(store, id)?.components.find(
    (component): component is ConstraintComponent =>
      component.kind === "constraint",
  );

const constraintList = (store: DocumentStoreRead, id: string) =>
  constraintHolder(store, id)?.constraints ?? [];

const descriptor = (
  store: DocumentStoreRead,
  id: string,
  componentIdValue: ComponentId,
) =>
  constraintList(store, id).find(
    (entry) => entry.componentId === componentIdValue,
  );

const tx = (
  sequence: string,
  revision: number,
): {
  readonly transactionId: ReturnType<typeof transactionId>;
  readonly expectedRevision: number;
  readonly source: "ui";
} => ({
  transactionId: transactionId(
    `transaction:conformance:constraint:${sequence}`,
  ),
  expectedRevision: revision,
  source: "ui",
});

const addConstraintSpec: CommandConformanceSpec = {
  name: "node.addConstraint@1",
  type: NODE_ADD_CONSTRAINT_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: (registry) => {
    registerNodeCommands(registry);
    registerArticulationCommands(registry);
  },
  buildValid: (id) =>
    addConstraintCommand(id, {
      nodeId: CHILD,
      componentId: ID_A,
      limits: LIMITS_A,
      before: null,
    }),
  buildInvalid: (id) =>
    addConstraintCommand(id, {
      nodeId: nodeId("node:conformance:missing"),
      componentId: ID_A,
      limits: LIMITS_A,
      before: null,
    }),
  buildSecondValid: (id) =>
    addConstraintCommand(id, {
      nodeId: ROOT,
      componentId: ID_B,
      limits: LIMITS_B,
      before: null,
    }),
  assertApplied: (store) => {
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_A]);
    expect(descriptor(store, CHILD, ID_A)?.limits).toEqual(LIMITS_A);
  },
  assertUndone: (store) => {
    expect(constraintList(store, CHILD)).toEqual([]);
    expect(
      nodeRecord(store, CHILD)?.components.some(
        (component) => component.kind === "constraint",
      ),
    ).toBe(false);
  },
  assertSecondApplied: (store) => {
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_A]);
    expect(
      constraintList(store, ROOT).map((entry) => entry.componentId),
    ).toEqual([ID_B]);
  },
};

const setConstraintSpec: CommandConformanceSpec = {
  name: "node.setConstraint@1",
  type: NODE_SET_CONSTRAINT_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: (registry) => {
    registerNodeCommands(registry);
    registerArticulationCommands(registry);
  },
  seed(bus: CommandBus, store: DocumentStoreRead): void {
    const result = bus.execute(
      addConstraintCommand(
        commandId("command:conformance:constraint:seed:0001"),
        {
          nodeId: CHILD,
          componentId: ID_A,
          limits: LIMITS_A,
          before: null,
        },
      ),
      tx("seed:0001", store.revision),
    );
    if (!result.ok) {
      throw new Error(`conformance seed failed: ${result.error.code}`);
    }
  },
  buildValid: (id) =>
    setConstraintCommand(id, {
      nodeId: CHILD,
      componentId: ID_A,
      limits: LIMITS_B,
    }),
  buildInvalid: (id) =>
    setConstraintCommand(id, {
      nodeId: nodeId("node:conformance:missing"),
      componentId: ID_A,
      limits: LIMITS_B,
    }),
  buildSecondValid: (id) =>
    setConstraintCommand(id, {
      nodeId: CHILD,
      componentId: ID_A,
      limits: LIMITS_C,
    }),
  assertApplied: (store) => {
    expect(descriptor(store, CHILD, ID_A)?.limits).toEqual(LIMITS_B);
    expect(constraintList(store, CHILD)).toHaveLength(1);
  },
  assertUndone: (store) => {
    expect(descriptor(store, CHILD, ID_A)?.limits).toEqual(LIMITS_A);
  },
  assertSecondApplied: (store) => {
    expect(descriptor(store, CHILD, ID_A)?.limits).toEqual(LIMITS_C);
  },
};

const reorderConstraintSpec: CommandConformanceSpec = {
  name: "node.reorderConstraint@1",
  type: NODE_REORDER_CONSTRAINT_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: (registry) => {
    registerNodeCommands(registry);
    registerArticulationCommands(registry);
  },
  seed(bus: CommandBus, store: DocumentStoreRead): void {
    const result = bus.executeTransaction(
      [
        addConstraintCommand(
          commandId("command:conformance:constraint:seed:0001"),
          { nodeId: CHILD, componentId: ID_A, limits: LIMITS_A, before: null },
        ),
        addConstraintCommand(
          commandId("command:conformance:constraint:seed:0002"),
          { nodeId: CHILD, componentId: ID_B, limits: LIMITS_B, before: null },
        ),
      ],
      tx("seed:0001", store.revision),
    );
    if (!result.ok) {
      throw new Error(`conformance seed failed: ${result.error.code}`);
    }
  },
  buildValid: (id) =>
    reorderConstraintCommand(id, {
      nodeId: CHILD,
      componentId: ID_B,
      before: ID_A,
    }),
  buildInvalid: (id) =>
    reorderConstraintCommand(id, {
      nodeId: nodeId("node:conformance:missing"),
      componentId: ID_B,
      before: ID_A,
    }),
  buildSecondValid: (id) =>
    reorderConstraintCommand(id, {
      nodeId: CHILD,
      componentId: ID_B,
      before: null,
    }),
  assertApplied: (store) => {
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_B, ID_A]);
  },
  assertUndone: (store) => {
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_A, ID_B]);
  },
  assertSecondApplied: (store) => {
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_A, ID_B]);
  },
};

const removeConstraintSpec: CommandConformanceSpec = {
  name: "node.removeConstraint@1",
  type: NODE_REMOVE_CONSTRAINT_COMMAND,
  schemaVersion: 1,
  inversePolicy: "exact-restore",
  createDocument: createFixture,
  register: (registry) => {
    registerNodeCommands(registry);
    registerArticulationCommands(registry);
  },
  seed(bus: CommandBus, store: DocumentStoreRead): void {
    const result = bus.executeTransaction(
      [
        addConstraintCommand(
          commandId("command:conformance:constraint:seed:0001"),
          { nodeId: CHILD, componentId: ID_A, limits: LIMITS_A, before: null },
        ),
        addConstraintCommand(
          commandId("command:conformance:constraint:seed:0002"),
          { nodeId: CHILD, componentId: ID_B, limits: LIMITS_B, before: null },
        ),
      ],
      tx("seed:0001", store.revision),
    );
    if (!result.ok) {
      throw new Error(`conformance seed failed: ${result.error.code}`);
    }
  },
  buildValid: (id) =>
    removeConstraintCommand(id, { nodeId: CHILD, componentId: ID_A }),
  buildInvalid: (id) =>
    removeConstraintCommand(id, {
      nodeId: nodeId("node:conformance:missing"),
      componentId: ID_A,
    }),
  buildSecondValid: (id) =>
    removeConstraintCommand(id, { nodeId: CHILD, componentId: ID_B }),
  assertApplied: (store) => {
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_B]);
  },
  assertUndone: (store) => {
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_A, ID_B]);
  },
  assertSecondApplied: (store) => {
    // Removing the last constraint also removes the component.
    expect(constraintList(store, CHILD)).toEqual([]);
    expect(
      nodeRecord(store, CHILD)?.components.some(
        (component) => component.kind === "constraint",
      ),
    ).toBe(false);
  },
};

runCommandConformanceSuite(addConstraintSpec, { describe, expect, it });
runCommandConformanceSuite(setConstraintSpec, { describe, expect, it });
runCommandConformanceSuite(reorderConstraintSpec, { describe, expect, it });
runCommandConformanceSuite(removeConstraintSpec, { describe, expect, it });

describe("constraint lifecycle semantics (plan S9.4, ticket #27)", () => {
  it("inserts before an existing constraint using `before`", () => {
    const { store, writeCapability } = createDocumentStoreFor();
    const registry = new CommandRegistry();
    registerArticulationCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    bus.executeTransaction(
      [
        addConstraintCommand(commandId("command:constraint:unit:0001"), {
          nodeId: CHILD,
          componentId: ID_A,
          limits: LIMITS_A,
          before: null,
        }),
        addConstraintCommand(commandId("command:constraint:unit:0002"), {
          nodeId: CHILD,
          componentId: ID_C,
          limits: LIMITS_C,
          before: null,
        }),
      ],
      tx("unit:0001", 0),
    );
    const result = bus.execute(
      addConstraintCommand(commandId("command:constraint:unit:0003"), {
        nodeId: CHILD,
        componentId: ID_B,
        limits: LIMITS_B,
        before: ID_C,
      }),
      tx("unit:0002", 1),
    );
    expect(result.ok).toBe(true);
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_A, ID_B, ID_C]);
  });

  it("rejects duplicate component ids document-wide", () => {
    const { store, writeCapability } = createDocumentStoreFor();
    const registry = new CommandRegistry();
    registerArticulationCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const first = bus.execute(
      addConstraintCommand(commandId("command:constraint:unit:0010"), {
        nodeId: CHILD,
        componentId: ID_A,
        limits: LIMITS_A,
        before: null,
      }),
      tx("unit:0010", 0),
    );
    expect(first.ok).toBe(true);
    const second = bus.execute(
      addConstraintCommand(commandId("command:constraint:unit:0011"), {
        nodeId: ROOT,
        componentId: ID_A,
        limits: LIMITS_B,
        before: null,
      }),
      tx("unit:0011", 1),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("DUPLICATE_COMPONENT_ID");
    expect(constraintList(store, ROOT)).toEqual([]);
  });

  it("rolls back the whole transaction when a duplicate id appears mid-transaction", () => {
    const { store, writeCapability } = createDocumentStoreFor();
    const registry = new CommandRegistry();
    registerArticulationCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const result = bus.executeTransaction(
      [
        addConstraintCommand(commandId("command:constraint:unit:0020"), {
          nodeId: CHILD,
          componentId: ID_A,
          limits: LIMITS_A,
          before: null,
        }),
        addConstraintCommand(commandId("command:constraint:unit:0021"), {
          nodeId: CHILD,
          componentId: ID_A,
          limits: LIMITS_B,
          before: null,
        }),
      ],
      tx("unit:0020", 0),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DUPLICATE_COMPONENT_ID");
    expect(store.revision).toBe(0);
    expect(constraintList(store, CHILD)).toEqual([]);
  });

  it("rejects min greater than max per axis at parse time", () => {
    const { store, writeCapability } = createDocumentStoreFor();
    const registry = new CommandRegistry();
    registerArticulationCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const result = bus.execute(
      {
        id: commandId("command:constraint:unit:0030"),
        type: NODE_ADD_CONSTRAINT_COMMAND,
        schemaVersion: 1,
        payload: {
          nodeId: CHILD,
          componentId: ID_A,
          limits: { min: [1, 0, 0], max: [0, 0, 0] },
          before: null,
        },
      },
      tx("unit:0030", 0),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_CONSTRAINT");
  });

  it("rejects non-finite limits at construction time", () => {
    expect(() =>
      addConstraintCommand(commandId("command:constraint:unit:0031"), {
        nodeId: CHILD,
        componentId: ID_A,
        limits: { min: [Number.NaN, 0, 0], max: [1, 0, 0] },
        before: null,
      }),
    ).toThrow(
      expect.objectContaining({ code: "INVALID_CANONICAL_NUMBER" }) as Error,
    );
  });

  it("rejects unknown constraint payload fields", () => {
    const { store, writeCapability } = createDocumentStoreFor();
    const registry = new CommandRegistry();
    registerArticulationCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const result = bus.execute(
      {
        id: commandId("command:constraint:unit:0032"),
        type: NODE_ADD_CONSTRAINT_COMMAND,
        schemaVersion: 1,
        payload: {
          nodeId: CHILD,
          componentId: ID_A,
          limits: { min: [-1, 0, 0], max: [1, 0, 0] },
          before: null,
          extra: true,
        },
      },
      tx("unit:0032", 0),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_FIELD");
  });

  it("rejects setConstraint on a missing constraint", () => {
    const { store, writeCapability } = createDocumentStoreFor();
    const registry = new CommandRegistry();
    registerArticulationCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const result = bus.execute(
      setConstraintCommand(commandId("command:constraint:unit:0040"), {
        nodeId: CHILD,
        componentId: ID_A,
        limits: LIMITS_B,
      }),
      tx("unit:0040", 0),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MISSING_CONSTRAINT");
  });

  it("rejects self and missing order targets", () => {
    const { store, writeCapability } = createDocumentStoreFor();
    const registry = new CommandRegistry();
    registerArticulationCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    bus.execute(
      addConstraintCommand(commandId("command:constraint:unit:0050"), {
        nodeId: CHILD,
        componentId: ID_A,
        limits: LIMITS_A,
        before: null,
      }),
      tx("unit:0050", 0),
    );
    const self = bus.execute(
      reorderConstraintCommand(commandId("command:constraint:unit:0051"), {
        nodeId: CHILD,
        componentId: ID_A,
        before: ID_A,
      }),
      tx("unit:0051", 1),
    );
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.code).toBe("INVALID_ORDER_TARGET");
    const missing = bus.execute(
      reorderConstraintCommand(commandId("command:constraint:unit:0052"), {
        nodeId: CHILD,
        componentId: ID_A,
        before: ID_B,
      }),
      tx("unit:0052", 1),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("INVALID_ORDER_TARGET");
    const otherNode = bus.execute(
      reorderConstraintCommand(commandId("command:constraint:unit:0053"), {
        nodeId: ROOT,
        componentId: ID_A,
        before: null,
      }),
      tx("unit:0053", 1),
    );
    expect(otherNode.ok).toBe(false);
    if (!otherNode.ok) expect(otherNode.error.code).toBe("MISSING_CONSTRAINT");
  });

  it("commits a no-op when reordering to the same position", () => {
    const { store, writeCapability } = createDocumentStoreFor();
    const registry = new CommandRegistry();
    registerArticulationCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    bus.executeTransaction(
      [
        addConstraintCommand(commandId("command:constraint:unit:0060"), {
          nodeId: CHILD,
          componentId: ID_A,
          limits: LIMITS_A,
          before: null,
        }),
        addConstraintCommand(commandId("command:constraint:unit:0061"), {
          nodeId: CHILD,
          componentId: ID_B,
          limits: LIMITS_B,
          before: null,
        }),
      ],
      tx("unit:0060", 0),
    );
    const result = bus.execute(
      reorderConstraintCommand(commandId("command:constraint:unit:0062"), {
        nodeId: CHILD,
        componentId: ID_A,
        before: ID_B,
      }),
      tx("unit:0061", 1),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.event.changedNodeIds).toEqual([]);
    expect(store.revision).toBe(2);
  });

  it("commits a no-op when removing an absent constraint", () => {
    const { store, writeCapability } = createDocumentStoreFor();
    const registry = new CommandRegistry();
    registerArticulationCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const result = bus.execute(
      removeConstraintCommand(commandId("command:constraint:unit:0070"), {
        nodeId: CHILD,
        componentId: ID_A,
      }),
      tx("unit:0070", 0),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.event.changedNodeIds).toEqual([]);
    expect(store.revision).toBe(1);
  });

  it("restores an empty constraint component after undo of an add", () => {
    const { store, writeCapability } = createDocumentStoreFor();
    const registry = new CommandRegistry();
    registerArticulationCommands(registry);
    registerNodeCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const seed = bus.execute(
      setNodeComponentsCommand(commandId("command:constraint:unit:0080"), {
        nodeId: CHILD,
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
          { kind: "constraint", schemaVersion: 1, constraints: [] },
        ],
      }),
      tx("unit:0080", 0),
    );
    expect(seed.ok).toBe(true);
    const added = bus.execute(
      addConstraintCommand(commandId("command:constraint:unit:0081"), {
        nodeId: CHILD,
        componentId: ID_A,
        limits: LIMITS_A,
        before: null,
      }),
      tx("unit:0081", 1),
    );
    expect(added.ok).toBe(true);
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_A]);
    const undone = bus.undo(tx("unit:0081-undo", 2));
    expect(undone.ok).toBe(true);
    // The pre-command empty constraint component is restored exactly.
    expect(
      nodeRecord(store, CHILD)?.components.filter(
        (component) => component.kind === "constraint",
      ),
    ).toEqual([{ kind: "constraint", schemaVersion: 1, constraints: [] }]);
  });

  it("undoes an add/reorder/remove sequence back to the exact original list", () => {
    const { store, writeCapability } = createDocumentStoreFor();
    const registry = new CommandRegistry();
    registerArticulationCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    bus.executeTransaction(
      [
        addConstraintCommand(commandId("command:constraint:unit:0090"), {
          nodeId: CHILD,
          componentId: ID_A,
          limits: LIMITS_A,
          before: null,
        }),
        addConstraintCommand(commandId("command:constraint:unit:0091"), {
          nodeId: CHILD,
          componentId: ID_B,
          limits: LIMITS_B,
          before: null,
        }),
        addConstraintCommand(commandId("command:constraint:unit:0092"), {
          nodeId: CHILD,
          componentId: ID_C,
          limits: LIMITS_C,
          before: null,
        }),
      ],
      tx("unit:0090", 0),
    );
    bus.execute(
      reorderConstraintCommand(commandId("command:constraint:unit:0093"), {
        nodeId: CHILD,
        componentId: ID_C,
        before: ID_A,
      }),
      tx("unit:0091", 1),
    );
    bus.execute(
      removeConstraintCommand(commandId("command:constraint:unit:0094"), {
        nodeId: CHILD,
        componentId: ID_B,
      }),
      tx("unit:0092", 2),
    );
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_C, ID_A]);
    bus.undo(tx("unit:0092-undo", 3));
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_C, ID_A, ID_B]);
    bus.undo(tx("unit:0091-undo", 4));
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_A, ID_B, ID_C]);
    bus.undo(tx("unit:0090-undo", 5));
    expect(constraintList(store, CHILD)).toEqual([]);
    // Redo restores everything in order (each undo/redo commits one
    // transaction and increments the revision).
    bus.redo(tx("unit:0090-redo", 6));
    bus.redo(tx("unit:0091-redo", 7));
    bus.redo(tx("unit:0092-redo", 8));
    expect(
      constraintList(store, CHILD).map((entry) => entry.componentId),
    ).toEqual([ID_C, ID_A]);
  });
});
