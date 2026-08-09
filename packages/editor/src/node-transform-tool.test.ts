import { describe, expect, it } from "vitest";
import {
  commandId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  type CommandId,
  type NodeId,
} from "@voxel-maker/shared";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";
import {
  eulerXYZToQuaternion,
  quaternionToEulerXYZ,
  type Transform,
  type Vec3,
} from "@voxel-maker/math";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { createDocumentStore } from "@voxel-maker/document";
import {
  CommandBus,
  CommandRegistry,
  registerNodeCommands,
  setNodeTransformCommand,
  type Command,
  type TransactionOptions,
  type GestureHandle,
} from "@voxel-maker/commands";
import {
  createNodeTransformTool,
  transformTargets,
  type CameraRay,
  type GestureHost,
  type GizmoHandle,
  type NodeTransformTool,
  type NodeTransformToolHost,
} from "./node-transform-tool.js";
import type { SelectionEntry } from "./types.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:gizmo:root");
const A = nodeId("node:gizmo:a");
const B = nodeId("node:gizmo:b");
const VOLUME = volumeId("volume:gizmo:0001");

/**
 * Demo document: root with children A and B. A owns a 2x2x2 volume at
 * local [0,2)^3, so its world bounds center is (1,1,1) and the gizmo
 * radius is sqrt(3) (half the diagonal).
 */
function createDemoDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:gizmo:0001" as never,
    metadata: { title: "transform tool test" },
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
        children: [],
        transform: identity,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
      {
        nodeId: B,
        name: "B",
        parentId: ROOT,
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
    volumes: [{ volumeId: VOLUME, bounds: { min: [0, 0, 0], max: [2, 2, 2] } }],
  });
}

/** One chunk seeding the 2x2x2 occupied block of the demo volume. */
function seedVolume(): ReadonlyMap<
  ReturnType<typeof volumeId>,
  readonly VoxelChunkSeed[]
> {
  const values = new Uint16Array(4096);
  for (let x = 0; x < 2; x += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let z = 0; z < 2; z += 1) {
        values[x + 16 * y + 256 * z] = 1;
      }
    }
  }
  return new Map([[VOLUME, [{ coordinate: [0, 0, 0], values }]]]);
}

/** Camera looking down -Z; the gizmo center is (1,1,1). */
const CAMERA_FORWARD: Vec3 = [0, 0, -1];

/**
 * Ray geometry:
 * - `xPlaneRay(dx)`: from (0,4,10), intersects the translate-X plane
 *   (y=1) at x = 1 + 3*dx.
 * - `yPlaneRay(dy)`: from (0,4,10), intersects the translate-Y plane
 *   (x=1) at y = 1 + 3*dy.
 * - `zRotateRay(px,py)`: from (0,0,10), intersects the rotate-Z plane
 *   (z=1) at (px,py,1).
 * - `xRotateRay(dy,dz)`: from (0,0,10), intersects the rotate-X plane
 *   (x=1) at (1,dy,dz).
 */
const xPlaneRay = (dx: number): CameraRay => {
  const direction = [1 / 3 + dx, -1, 0] as const;
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  return {
    origin: [0, 4, 10],
    direction: [
      direction[0] / length,
      direction[1] / length,
      direction[2] / length,
    ],
  };
};

/**
 * Ray from (0,4,10) hitting the plane x=-1 (the translate plane of a node
 * whose local X is world +Y and whose content center moved to (-1,1,1)).
 */
const localXPlaneRay = (dy: number): CameraRay => {
  const direction = [-1, -3 + 3 * dy, 0] as const;
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  return {
    origin: [0, 4, 10],
    direction: [
      direction[0] / length,
      direction[1] / length,
      direction[2] / length,
    ],
  };
};

const zRotateRay = (px: number, py: number): CameraRay => {
  const direction = [px, py, -9] as const;
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  return {
    origin: [0, 0, 10],
    direction: [
      direction[0] / length,
      direction[1] / length,
      direction[2] / length,
    ],
  };
};

const xRotateRay = (dy: number, dz: number): CameraRay => {
  const direction = [1, dy, dz - 10] as const;
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  return {
    origin: [0, 0, 10],
    direction: [
      direction[0] / length,
      direction[1] / length,
      direction[2] / length,
    ],
  };
};

interface Harness {
  bus: CommandBus;
  store: ReturnType<typeof createDocumentStore>["store"];
  tool: NodeTransformTool;
  setRay: (ray: CameraRay | undefined) => void;
  notices: string[];
}

function createHarness(selection: readonly SelectionEntry[]): Harness {
  const { store, writeCapability } = createDocumentStore({
    document: createDemoDocument(),
    volumes: seedVolume(),
  });
  const registry = new CommandRegistry();
  registerNodeCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);
  let ray: CameraRay | undefined;
  let sequence = 0;
  const notices: string[] = [];
  const options = (): TransactionOptions => {
    sequence += 1;
    return {
      transactionId: transactionId(
        `transaction:gizmo:host:${String(sequence)}`,
      ),
      expectedRevision: store.revision,
      source: "ui",
    };
  };
  const host: NodeTransformToolHost = {
    get store() {
      return store;
    },
    get selection() {
      return selection;
    },
    cameraForward: () => CAMERA_FORWARD,
    ray: () => ray,
    nextCommandId: (): CommandId => {
      sequence += 1;
      return commandId(`command:gizmo:${String(sequence)}`);
    },
    beginGesture: (): GestureHost | undefined => {
      const opened = bus.beginGesture(`gizmo:${String((sequence += 1))}`);
      if (!opened.ok) return undefined;
      const gesture: GestureHandle = opened.value;
      return {
        update: (commands: readonly Command[], label: string) => {
          const result = gesture.update(commands, { ...options(), label });
          return result.ok ? undefined : result.error;
        },
        end: () => {
          gesture.end();
        },
        cancel: () => {
          const result = gesture.cancel(options());
          return result.ok ? undefined : result.error;
        },
      };
    },
    pushNotice: (level, message) => {
      notices.push(`${level}: ${message}`);
    },
  };
  return {
    bus,
    store,
    tool: createNodeTransformTool(host),
    setRay: (next) => {
      ray = next;
    },
    notices,
  };
}

const nodeSelection = (...ids: readonly NodeId[]): SelectionEntry[] =>
  ids.map((id) => ({ kind: "node", nodeId: id }));

function nodeTransform(store: Harness["store"], id: NodeId): Transform {
  const node = store.getDocument().nodes[id];
  if (node === undefined) throw new Error(`missing node ${id}`);
  return node.transform;
}

const X: GizmoHandle = { mode: "translate", axis: 0 };
const RX: GizmoHandle = { mode: "rotate", axis: 0 };
const RZ: GizmoHandle = { mode: "rotate", axis: 2 };
const SX: GizmoHandle = { mode: "scale", axis: 0 };

const expectNear = (
  actual: readonly number[],
  expected: readonly number[],
): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index] as number, 6);
  });
};

describe("transformTargets", () => {
  it("derives the center and radius from the union world bounds", () => {
    const { store } = createHarness(nodeSelection(A));
    const targets = transformTargets(store, nodeSelection(A));
    expect(targets?.nodeIds).toEqual([A]);
    expect(targets?.center).toEqual([1, 1, 1]);
    expect(targets?.radius).toBeCloseTo(Math.sqrt(3), 9);
  });

  it("includes voxel-less nodes via their world origin", () => {
    const { store } = createHarness(nodeSelection(A, B));
    const targets = transformTargets(store, nodeSelection(A, B));
    expect(targets?.nodeIds).toEqual([A, B]);
    expect(targets?.center).toEqual([1, 1, 1]);
    const onlyB = transformTargets(store, nodeSelection(B));
    expect(onlyB?.center).toEqual([0, 0, 0]);
  });

  it("is undefined without live node entries", () => {
    const { store } = createHarness([]);
    expect(transformTargets(store, [])).toBeUndefined();
    expect(
      transformTargets(store, [
        { kind: "voxel", volumeId: VOLUME, voxel: [0, 0, 0] },
      ]),
    ).toBeUndefined();
  });
});

describe("translate drag (plan S7.8)", () => {
  it("moves along the world X axis with grid snapping and one history entry", () => {
    const { bus, store, tool, setRay } = createHarness(nodeSelection(A));
    tool.setSpace("world");
    setRay(xPlaneRay(0));
    expect(tool.pointerDown(X, 0, 0).ok).toBe(true);
    expect(tool.active).toBe(true);
    // dx = 0.5 -> plane x = 2.5, delta 1.5, snapped to 1.5.
    setRay(xPlaneRay(0.5));
    expect(tool.pointerMove(10, 10).ok).toBe(true);
    expect(nodeTransform(store, A).translation).toEqual([1.5, 0, 0]);
    // dx = 0.75 -> delta 2.25, snapped to 2.25.
    setRay(xPlaneRay(0.75));
    expect(tool.pointerMove(20, 20).ok).toBe(true);
    expect(nodeTransform(store, A).translation).toEqual([2.25, 0, 0]);
    expect(tool.pointerUp().ok).toBe(true);

    const history = bus.historySnapshot();
    expect(history.past).toHaveLength(1);
    expect(history.past[0]?.label).toBe("Move");
    expect(history.past[0]?.revisionBefore).toBe(0);
    expect(history.past[0]?.revisionAfter).toBe(2);

    // Undo restores the exact pre-drag transform; redo replays the drag.
    expect(bus.undo(txOptions(store.revision)).ok).toBe(true);
    expect(nodeTransform(store, A).translation).toEqual([0, 0, 0]);
    expect(bus.redo(txOptions(store.revision)).ok).toBe(true);
    expect(nodeTransform(store, A).translation).toEqual([2.25, 0, 0]);
  });

  it("applies exact deltas when snapping is off", () => {
    const { store, tool, setRay } = createHarness(nodeSelection(A));
    tool.setSnapping(false);
    setRay(xPlaneRay(0));
    expect(tool.pointerDown(X, 0, 0).ok).toBe(true);
    setRay(xPlaneRay(0.1));
    expect(tool.pointerMove(10, 10).ok).toBe(true);
    expect(nodeTransform(store, A).translation[0]).toBeCloseTo(0.3, 9);
  });

  it("moves along each node's local axis in local mode", () => {
    const h = createHarness(nodeSelection(A));
    // Rotate A 90 deg around Z: its local X is world +Y and the gizmo
    // center (the volume bounds center) moves to (-1,1,1).
    const rotated = eulerXYZToQuaternion([0, 0, Math.PI / 2]);
    expect(
      h.bus.execute(
        setNodeTransformCommand(commandId("command:gizmo:rot"), {
          nodeId: A,
          transform: { ...identity, rotation: rotated },
        }),
        txOptions(h.store.revision),
      ).ok,
    ).toBe(true);
    h.tool.setSpace("local");
    h.setRay(localXPlaneRay(0));
    expect(h.tool.pointerDown(X, 0, 0).ok).toBe(true);
    // dy = 1/3 -> plane x = -1 at y = 2, delta 1 along world Y.
    h.setRay(localXPlaneRay(1 / 3));
    expect(h.tool.pointerMove(10, 10).ok).toBe(true);
    expectNear(nodeTransform(h.store, A).translation, [0, 1, 0]);
    expect(h.tool.pointerUp().ok).toBe(true);
  });

  it("translates every selected node by the same delta", () => {
    const { bus, store, tool, setRay } = createHarness(nodeSelection(A, B));
    setRay(xPlaneRay(0));
    expect(tool.pointerDown(X, 0, 0).ok).toBe(true);
    setRay(xPlaneRay(0.5));
    expect(tool.pointerMove(10, 10).ok).toBe(true);
    expect(nodeTransform(store, A).translation).toEqual([1.5, 0, 0]);
    expect(nodeTransform(store, B).translation).toEqual([1.5, 0, 0]);
    expect(tool.pointerUp().ok).toBe(true);
    expect(bus.historySnapshot().past).toHaveLength(1);
  });
});

describe("rotate drag (plan S7.8)", () => {
  it("rotates the world placement around the gizmo center in world mode", () => {
    const { store, tool, setRay } = createHarness(nodeSelection(A));
    tool.setSpace("world");
    setRay(zRotateRay(2, 1));
    expect(tool.pointerDown(RZ, 0, 0).ok).toBe(true);
    // Move 90 deg counter-clockwise around +Z.
    setRay(zRotateRay(1, 2));
    expect(tool.pointerMove(10, 10).ok).toBe(true);
    const transform = nodeTransform(store, A);
    // The world origin (0,0,0) rotates 90 deg around (1,1,1) about +Z to
    // (2,0,0), and the local rotation becomes 90 deg about +Z.
    expectNear(transform.translation, [2, 0, 0]);
    expectNear(transform.rotation, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    expect(tool.pointerUp().ok).toBe(true);
  });

  it("rotates around the local axis in local mode", () => {
    const { store, tool, setRay } = createHarness(nodeSelection(A));
    tool.setSpace("local");
    setRay(xRotateRay(2, 1));
    expect(tool.pointerDown(RX, 0, 0).ok).toBe(true);
    setRay(xRotateRay(1, 2));
    expect(tool.pointerMove(10, 10).ok).toBe(true);
    const transform = nodeTransform(store, A);
    expectNear(transform.rotation, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    expect(transform.translation).toEqual([0, 0, 0]);
    expect(tool.pointerUp().ok).toBe(true);
  });

  it("snaps the angle to the configured increment", () => {
    const { store, tool, setRay } = createHarness(nodeSelection(A));
    tool.setSpace("local");
    tool.setRotateSnap(Math.PI / 12); // 15 degrees
    setRay(xRotateRay(2, 1));
    expect(tool.pointerDown(RX, 0, 0).ok).toBe(true);
    // A 35-degree drag snaps to 30 degrees.
    const cos35 = Math.cos((35 * Math.PI) / 180);
    const sin35 = Math.sin((35 * Math.PI) / 180);
    setRay(xRotateRay(1 + cos35, 1 + sin35));
    expect(tool.pointerMove(10, 10).ok).toBe(true);
    const euler = quaternionToEulerXYZ(nodeTransform(store, A).rotation);
    expect(euler[0]).toBeCloseTo(Math.PI / 6, 6);
  });
});

describe("scale drag (plan S7.8)", () => {
  it("scales the local axis component in local mode", () => {
    const { store, tool, setRay } = createHarness(nodeSelection(A));
    tool.setSpace("local");
    setRay(xPlaneRay(0));
    expect(tool.pointerDown(SX, 0, 0).ok).toBe(true);
    // delta = radius -> factor 2 (radius = sqrt(3)).
    setRay(xPlaneRay(Math.sqrt(3) / 3));
    expect(tool.pointerMove(10, 10).ok).toBe(true);
    expectNear(nodeTransform(store, A).scale, [2, 1, 1]);
    expect(tool.pointerUp().ok).toBe(true);
  });

  it("scales along the world axis through the local frame in world mode", () => {
    const h = createHarness(nodeSelection(A));
    // Rotate A 90 deg around Z: world X maps onto local -Y.
    expect(
      h.bus.execute(
        setNodeTransformCommand(commandId("command:gizmo:rot"), {
          nodeId: A,
          transform: {
            ...identity,
            rotation: eulerXYZToQuaternion([0, 0, Math.PI / 2]),
          },
        }),
        txOptions(h.store.revision),
      ).ok,
    ).toBe(true);
    h.tool.setSpace("world");
    h.setRay(xPlaneRay(0));
    expect(h.tool.pointerDown(SX, 0, 0).ok).toBe(true);
    h.setRay(xPlaneRay(Math.sqrt(3) / 3));
    expect(h.tool.pointerMove(10, 10).ok).toBe(true);
    expectNear(nodeTransform(h.store, A).scale, [1, 2, 1]);
    expect(h.tool.pointerUp().ok).toBe(true);
  });

  it("never produces a non-positive scale", () => {
    const { store, tool, setRay } = createHarness(nodeSelection(A));
    setRay(xPlaneRay(0));
    expect(tool.pointerDown(SX, 0, 0).ok).toBe(true);
    // A huge negative drag would push the factor below zero; the tool
    // clamps it to the minimum and the command stays valid.
    setRay(xPlaneRay(-100));
    expect(tool.pointerMove(10, 10).ok).toBe(true);
    expect(nodeTransform(store, A).scale[0]).toBeGreaterThan(0);
    expect(tool.pointerUp().ok).toBe(true);
  });
});

describe("drag lifecycle (plan S7.8/S4.10)", () => {
  it("pins space and snapping at pointer-down", () => {
    const { store, tool, setRay } = createHarness(nodeSelection(A));
    tool.setSpace("world");
    setRay(xPlaneRay(0));
    expect(tool.pointerDown(X, 0, 0).ok).toBe(true);
    // dx = 0.15 -> delta 0.45, snapped to 0.5.
    setRay(xPlaneRay(0.15));
    expect(tool.pointerMove(10, 10).ok).toBe(true);
    // Toggling snapping and space mid-drag must not change the drag:
    // the values are pinned at pointer-down.
    tool.setSnapping(false);
    tool.setSpace("local");
    setRay(xPlaneRay(0.3));
    expect(tool.pointerMove(20, 20).ok).toBe(true);
    // delta 0.9 stays snapped to 1.0; live snapping would give 0.9.
    expect(nodeTransform(store, A).translation).toEqual([1, 0, 0]);
    expect(tool.pointerUp().ok).toBe(true);
  });

  it("pointer cancel restores the exact pre-drag transforms and history", () => {
    const { bus, store, tool, setRay } = createHarness(nodeSelection(A, B));
    setRay(xPlaneRay(0));
    expect(tool.pointerDown(X, 0, 0).ok).toBe(true);
    setRay(xPlaneRay(0.5));
    expect(tool.pointerMove(10, 10).ok).toBe(true);
    setRay(xPlaneRay(1));
    expect(tool.pointerMove(20, 20).ok).toBe(true);
    tool.pointerCancel();
    expect(tool.active).toBe(false);
    expect(nodeTransform(store, A).translation).toEqual([0, 0, 0]);
    expect(nodeTransform(store, B).translation).toEqual([0, 0, 0]);
    expect(bus.historySnapshot().past).toHaveLength(0);
    expect(bus.canUndo()).toBe(false);
  });

  it("is a no-op without a node selection", () => {
    const { store, tool, setRay } = createHarness([]);
    setRay(xPlaneRay(0));
    expect(tool.pointerDown(X, 0, 0).ok).toBe(true);
    expect(tool.active).toBe(false);
    expect(store.revision).toBe(0);
  });

  it("surfaces a failed update as a notice and stops the drag", () => {
    const h = createHarness(nodeSelection(A));
    h.setRay(xPlaneRay(0));
    expect(h.tool.pointerDown(X, 0, 0).ok).toBe(true);
    // An intervening commit (another node) seals the gesture mid-drag;
    // the next update must fail and surface a notice.
    expect(
      h.bus.execute(
        setNodeTransformCommand(commandId("command:gizmo:other"), {
          nodeId: B,
          transform: { ...identity, translation: [5, 0, 0] },
        }),
        txOptions(h.store.revision),
      ).ok,
    ).toBe(true);
    h.setRay(xPlaneRay(0.5));
    const result = h.tool.pointerMove(10, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("GESTURE_SEALED");
    expect(h.notices.length).toBeGreaterThan(0);
    // Further moves are no-ops; ending the drag is still safe.
    h.setRay(xPlaneRay(1));
    expect(h.tool.pointerMove(20, 20).ok).toBe(true);
    expect(h.tool.pointerUp().ok).toBe(true);
  });
});

let optionsSequence = 0;
function txOptions(expectedRevision: number): TransactionOptions {
  optionsSequence += 1;
  return {
    transactionId: transactionId(
      `transaction:gizmo:test:${String(optionsSequence)}`,
    ),
    expectedRevision,
    source: "ui",
  };
}
