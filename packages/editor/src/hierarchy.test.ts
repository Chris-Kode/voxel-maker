import { describe, expect, it } from "vitest";
import {
  animationId,
  commandId,
  nodeId,
  transactionId,
  type NodeId,
} from "@voxel-maker/shared";
import { type Transform } from "@voxel-maker/math";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { createDocumentStore } from "@voxel-maker/document";
import {
  CommandBus,
  CommandRegistry,
  registerNodeCommands,
  type TransactionOptions,
} from "@voxel-maker/commands";
import {
  buildCreateChildCommand,
  buildDeleteCommand,
  buildRenameCommand,
  buildReparentCommand,
  defaultChildName,
  deleteFeedback,
  isAncestor,
  reparentFeedback,
} from "./hierarchy.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:hier:root");
const A = nodeId("node:hier:a");
const B = nodeId("node:hier:b");
const C = nodeId("node:hier:c");
const D = nodeId("node:hier:d");

function createDemoDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:hier:0001" as never,
    metadata: { title: "hierarchy test" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [A, B],
        transform: identity,
        components: [],
      },
      {
        nodeId: A,
        name: "A",
        parentId: ROOT,
        children: [C],
        transform: identity,
        components: [],
      },
      {
        nodeId: B,
        name: "B",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: [],
      },
      {
        nodeId: C,
        name: "C",
        parentId: A,
        children: [D],
        transform: identity,
        components: [],
      },
      {
        nodeId: D,
        name: "D",
        parentId: C,
        children: [],
        transform: identity,
        components: [],
      },
    ],
    materials: [],
    volumes: [],
  });
}

describe("reparentFeedback (plan S7.11)", () => {
  const document = createDemoDocument();

  it("allows a drop on an unrelated node with preserve-world placement", () => {
    expect(reparentFeedback(document, A, B)).toEqual({
      ok: true,
      placement: "preserve-world",
    });
  });

  it("rejects dropping onto the node itself", () => {
    expect(reparentFeedback(document, A, A)).toEqual({
      ok: false,
      reason: "self",
    });
  });

  it("rejects dropping onto a descendant (cycle feedback)", () => {
    expect(reparentFeedback(document, A, D)).toEqual({
      ok: false,
      reason: "cycle",
    });
    expect(isAncestor(document, D, A)).toBe(true);
    expect(isAncestor(document, B, A)).toBe(false);
  });

  it("rejects dropping the root or unknown ids", () => {
    expect(reparentFeedback(document, ROOT, B)).toEqual({
      ok: false,
      reason: "root",
    });
    expect(reparentFeedback(document, nodeId("node:hier:ghost"), B)).toEqual({
      ok: false,
      reason: "missing-node",
    });
    expect(reparentFeedback(document, A, nodeId("node:hier:ghost"))).toEqual({
      ok: false,
      reason: "missing-target",
    });
    expect(reparentFeedback(document, A, undefined)).toEqual({
      ok: false,
      reason: "missing-target",
    });
  });
});

describe("deleteFeedback (plan S7.11 reference feedback)", () => {
  it("allows deleting a plain leaf node", () => {
    expect(deleteFeedback(createDemoDocument(), B)).toEqual({ ok: true });
  });

  it("rejects deleting the root or a node with children", () => {
    const document = createDemoDocument();
    expect(deleteFeedback(document, ROOT)).toEqual({
      ok: false,
      reason: "root",
    });
    expect(deleteFeedback(document, A)).toEqual({
      ok: false,
      reason: "has-children",
    });
  });

  it("rejects deleting a node referenced by an animation track", () => {
    const base = createDemoDocument();
    const document: VoxelDocument = createDocument({
      documentId: base.documentId,
      metadata: base.metadata,
      rootNodeId: base.rootNodeId,
      nodes: Object.values(base.nodes),
      materials: [],
      volumes: [],
      animations: [
        {
          animationId: animationId("animation:hier:0001"),
          name: "bounce",
          duration: 1,
          loop: "once",
          tracks: [
            {
              trackId: "track:hier:0001" as never,
              targetNodeId: B,
              interpolation: "linear",
              keyframes: [
                {
                  keyframeId: "keyframe:hier:0001" as never,
                  time: 0,
                  property: { channel: "translation", value: [0, 0, 0] },
                },
                {
                  keyframeId: "keyframe:hier:0002" as never,
                  time: 1,
                  property: { channel: "translation", value: [1, 0, 0] },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(deleteFeedback(document, B)).toEqual({
      ok: false,
      reason: "referenced",
    });
  });
});

describe("defaultChildName", () => {
  it("produces collision-free sibling names", () => {
    expect(defaultChildName(createDemoDocument(), ROOT)).toBe("Node");
    const document = createDocument({
      documentId: "document:hier:0001" as never,
      metadata: { title: "hierarchy test" },
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [A, B, nodeId("node:hier:extra")],
          transform: identity,
          components: [],
        },
        {
          nodeId: A,
          name: "A",
          parentId: ROOT,
          children: [],
          transform: identity,
          components: [],
        },
        {
          nodeId: B,
          name: "B",
          parentId: ROOT,
          children: [],
          transform: identity,
          components: [],
        },
        {
          nodeId: nodeId("node:hier:extra"),
          name: "Node",
          parentId: ROOT,
          children: [],
          transform: identity,
          components: [],
        },
      ],
      materials: [],
      volumes: [],
    });
    expect(defaultChildName(document, ROOT)).toBe("Node 2");
  });

  it("falls back to Node for unknown parents", () => {
    expect(
      defaultChildName(createDemoDocument(), nodeId("node:hier:ghost")),
    ).toBe("Node");
  });
});

describe("hierarchy command construction", () => {
  it("creates a child with the default name through the real bus", () => {
    const document = createDemoDocument();
    const { store, writeCapability } = createDocumentStore({ document });
    const registry = new CommandRegistry();
    registerNodeCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const created = buildCreateChildCommand(
      commandId("command:hier:create"),
      document,
      B,
    );
    expect(created.nodeId).toBe(nodeId("node:hier:create"));
    const result = bus.execute(created.command, txOptions(store.revision));
    expect(result.ok).toBe(true);
    const installed = store.getDocument().nodes[nodeId("node:hier:create")];
    expect(installed?.name).toBe("Node");
    expect(installed?.parentId).toBe(B);
    expect(installed?.transform).toEqual(identity);
    const createdParent = store.getDocument().nodes[B];
    if (createdParent === undefined) throw new Error("missing parent");
    expect(createdParent.children).toContain(nodeId("node:hier:create"));
  });

  it("renames and deletes through the real bus", () => {
    const document = createDemoDocument();
    const { store, writeCapability } = createDocumentStore({ document });
    const registry = new CommandRegistry();
    registerNodeCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    const rename = buildRenameCommand(
      commandId("command:hier:rename"),
      B,
      "Bolt",
    );
    expect(bus.execute(rename, txOptions(store.revision)).ok).toBe(true);
    const renamed = store.getDocument().nodes[B];
    if (renamed === undefined) throw new Error("missing renamed node");
    expect(renamed.name).toBe("Bolt");
    const remove = buildDeleteCommand(commandId("command:hier:delete"), B);
    expect(bus.execute(remove, txOptions(store.revision)).ok).toBe(true);
    expect(store.getDocument().nodes[B]).toBeUndefined();
  });

  it("builds a preserve-world reparent under a transformed parent", () => {
    const base = createDemoDocument();
    // Parent B sits at world translation (10, 0, 0); moving A under B must
    // resolve A's local transform so its world placement is unchanged.
    const document: VoxelDocument = createDocument({
      documentId: base.documentId,
      metadata: base.metadata,
      rootNodeId: base.rootNodeId,
      nodes: Object.values(base.nodes).map((node) =>
        node.nodeId === B
          ? { ...node, transform: { ...identity, translation: [10, 0, 0] } }
          : node,
      ),
      materials: [],
      volumes: [],
    });
    const command = buildReparentCommand(
      commandId("command:hier:reparent"),
      document,
      A,
      B,
    );
    expect(command).toBeDefined();
    const { store, writeCapability } = createDocumentStore({ document });
    const registry = new CommandRegistry();
    registerNodeCommands(registry);
    const bus = new CommandBus(store, registry, writeCapability);
    if (command === undefined) throw new Error("expected a reparent command");
    expect(bus.execute(command, txOptions(0)).ok).toBe(true);
    const after = store.getDocument();
    const moved = after.nodes[A];
    if (moved === undefined) throw new Error("missing moved node");
    expect(moved.parentId).toBe(B);
    // World placement preserved: A's world origin is still (0,0,0).
    const world = worldOrigin(after, A);
    expect(world[0]).toBeCloseTo(0, 6);
    expect(world[1]).toBeCloseTo(0, 6);
    expect(world[2]).toBeCloseTo(0, 6);
  });

  it("refuses to build a cyclic reparent", () => {
    const document = createDemoDocument();
    expect(
      buildReparentCommand(commandId("command:hier:cycle"), document, A, D),
    ).toBeUndefined();
    expect(
      buildReparentCommand(commandId("command:hier:root"), document, ROOT, B),
    ).toBeUndefined();
  });
});

function worldOrigin(document: VoxelDocument, id: NodeId): readonly number[] {
  let matrix = identityMatrix();
  const chain: NodeId[] = [];
  let current: NodeId | undefined = id;
  const seen = new Set<NodeId>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = document.nodes[current]?.parentId ?? undefined;
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const node = document.nodes[chain[index] as NodeId];
    if (node === undefined) throw new Error("missing node in chain");
    matrix = multiply(matrix, transformToMatrix(node.transform));
  }
  return [matrix[3] as number, matrix[7] as number, matrix[11] as number];
}

const identityMatrix = (): readonly number[] => [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

const multiply = (
  a: readonly number[],
  b: readonly number[],
): readonly number[] => {
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += (a[row * 4 + k] as number) * (b[k * 4 + col] as number);
      }
      out[row * 4 + col] = sum;
    }
  }
  return out;
};

const transformToMatrix = (transform: Transform): readonly number[] => {
  const [tx, ty, tz] = transform.translation;
  const [qx, qy, qz, qw] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  const r00 = 1 - 2 * (qy * qy + qz * qz);
  const r01 = 2 * (qx * qy - qz * qw);
  const r02 = 2 * (qx * qz + qy * qw);
  const r10 = 2 * (qx * qy + qz * qw);
  const r11 = 1 - 2 * (qx * qx + qz * qz);
  const r12 = 2 * (qy * qz - qx * qw);
  const r20 = 2 * (qx * qz - qy * qw);
  const r21 = 2 * (qy * qz + qx * qw);
  const r22 = 1 - 2 * (qx * qx + qy * qy);
  return [
    r00 * sx,
    r01 * sy,
    r02 * sz,
    tx,
    r10 * sx,
    r11 * sy,
    r12 * sz,
    ty,
    r20 * sx,
    r21 * sy,
    r22 * sz,
    tz,
    0,
    0,
    0,
    1,
  ];
};

let sequence = 0;
function txOptions(expectedRevision: number): TransactionOptions {
  sequence += 1;
  return {
    transactionId: transactionId(`transaction:hier:${String(sequence)}`),
    expectedRevision,
    source: "ui",
  };
}
