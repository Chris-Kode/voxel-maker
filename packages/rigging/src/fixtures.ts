import {
  documentId,
  materialId,
  nodeId,
  volumeId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  createDocument,
  type Component,
  type SceneNode,
  type VoxelDocument,
} from "@voxel-maker/model";
import type { Transform } from "@voxel-maker/math";

/**
 * Generic rig fixtures (plan S9.9, ticket #26): a chest lid, a wheel, a
 * three-link arm, bilateral wings, and an abstract sculpture articulated
 * with the existing node hierarchy, pivot annotations, and joint
 * annotations. The fixtures use only generic core symbols — nodes,
 * transforms, voxel volumes, pivots, and joints — with no
 * category-specific rig, bone, or asset kinds.
 */

const identity: Transform = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

const pivot = (value: readonly [number, number, number]): Component => ({
  kind: "pivot",
  schemaVersion: 1,
  pivot: [...value],
});

const joint: Component = { kind: "joint", schemaVersion: 1 };

const voxel = (id: VolumeId): Component => ({
  kind: "voxel",
  schemaVersion: 1,
  volumeId: id,
});

interface Part {
  readonly nodeId: NodeId;
  readonly name: string;
  readonly parentId: NodeId;
  readonly transform: Transform;
  readonly components: readonly Component[];
  readonly volume: {
    readonly volumeId: VolumeId;
    readonly bounds: readonly [
      readonly [number, number, number],
      readonly [number, number, number],
    ];
  };
  readonly materialId: number;
}

interface FixtureShape {
  readonly documentId: string;
  readonly title: string;
  readonly rootName: string;
  readonly parts: readonly Part[];
}

const materials = (): NonNullable<
  Parameters<typeof createDocument>[0]["materials"]
> => [
  {
    materialId: materialId(1),
    name: "primary",
    color: "#c8b89a",
    opacity: 1,
    roughness: 0.7,
    metallic: 0.05,
    emissive: 0,
  },
  {
    materialId: materialId(2),
    name: "accent",
    color: "#5a7f9e",
    opacity: 1,
    roughness: 0.5,
    metallic: 0.3,
    emissive: 0,
  },
  {
    materialId: materialId(3),
    name: "dark",
    color: "#3b3b3b",
    opacity: 1,
    roughness: 0.6,
    metallic: 0.2,
    emissive: 0,
  },
];

function buildFixture(shape: FixtureShape): VoxelDocument {
  const rootId = nodeId(`${shape.documentId}:root`);
  const childrenOf = (id: NodeId): readonly NodeId[] =>
    shape.parts
      .filter((part) => part.parentId === id)
      .map((part) => part.nodeId);
  const root: SceneNode = {
    nodeId: rootId,
    name: shape.rootName,
    parentId: null,
    children: childrenOf(rootId),
    transform: identity,
    components: [],
  };
  const nodes: SceneNode[] = [root];
  const volumes = [];
  for (const part of shape.parts) {
    nodes.push({
      nodeId: part.nodeId,
      name: part.name,
      parentId: part.parentId,
      children: childrenOf(part.nodeId),
      transform: part.transform,
      components: [...part.components],
    });
    volumes.push({
      volumeId: part.volume.volumeId,
      name: part.name,
      bounds: { min: part.volume.bounds[0], max: part.volume.bounds[1] },
    });
  }
  return createDocument({
    documentId: documentId(shape.documentId),
    metadata: { title: shape.title, kind: "fixture" },
    rootNodeId: rootId,
    nodes,
    materials: materials(),
    volumes,
  });
}

/** Chest with a hinged lid (plan S9.9): the lid pivots about its back-bottom edge. */
export function createChestLidFixture(): VoxelDocument {
  return buildFixture({
    documentId: "document:rig:chest-lid:0001",
    title: "chest with hinged lid",
    rootName: "Chest",
    parts: [
      {
        nodeId: nodeId("node:rig:chest-lid:body"),
        name: "Body",
        parentId: nodeId("document:rig:chest-lid:0001:root"),
        transform: identity,
        components: [voxel(volumeId("volume:rig:chest-lid:body"))],
        volume: {
          volumeId: volumeId("volume:rig:chest-lid:body"),
          bounds: [
            [-4, 0, -3],
            [4, 6, 3],
          ],
        },
        materialId: 1,
      },
      {
        nodeId: nodeId("node:rig:chest-lid:lid"),
        name: "Lid",
        parentId: nodeId("document:rig:chest-lid:0001:root"),
        transform: {
          translation: [0, 6, 0],
          pivot: [0, 0, -3],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          voxel(volumeId("volume:rig:chest-lid:lid")),
          pivot([0, 0, -3]),
          joint,
        ],
        volume: {
          volumeId: volumeId("volume:rig:chest-lid:lid"),
          bounds: [
            [-4, 0, -3],
            [4, 2, 3],
          ],
        },
        materialId: 1,
      },
    ],
  });
}

/** Wheel on an axle (plan S9.9): the wheel joint sits at the wheel center. */
export function createWheelFixture(): VoxelDocument {
  return buildFixture({
    documentId: "document:rig:wheel:0001",
    title: "wheel on axle",
    rootName: "WheelAssembly",
    parts: [
      {
        nodeId: nodeId("node:rig:wheel:axle"),
        name: "Axle",
        parentId: nodeId("document:rig:wheel:0001:root"),
        transform: identity,
        components: [voxel(volumeId("volume:rig:wheel:axle"))],
        volume: {
          volumeId: volumeId("volume:rig:wheel:axle"),
          bounds: [
            [-1, -1, -4],
            [1, 1, 4],
          ],
        },
        materialId: 2,
      },
      {
        nodeId: nodeId("node:rig:wheel:wheel"),
        name: "Wheel",
        parentId: nodeId("document:rig:wheel:0001:root"),
        transform: identity,
        components: [
          voxel(volumeId("volume:rig:wheel:wheel")),
          pivot([0, 0, 0]),
          joint,
        ],
        volume: {
          volumeId: volumeId("volume:rig:wheel:wheel"),
          bounds: [
            [-3, -3, -1],
            [3, 3, 1],
          ],
        },
        materialId: 3,
      },
    ],
  });
}

/**
 * Three-link arm (plan S9.9): shoulder, elbow, and wrist joints; each link
 * hangs off the previous link's tip so rotating one link swings the whole
 * chain.
 */
export function createLinkedArmFixture(): VoxelDocument {
  const rootId = nodeId("document:rig:arm:0001:root");
  const link1 = nodeId("node:rig:arm:link1");
  const link2 = nodeId("node:rig:arm:link2");
  const link3 = nodeId("node:rig:arm:link3");
  return buildFixture({
    documentId: "document:rig:arm:0001",
    title: "three-link arm",
    rootName: "Arm",
    parts: [
      {
        nodeId: link1,
        name: "Link 1",
        parentId: rootId,
        transform: identity,
        components: [
          voxel(volumeId("volume:rig:arm:link1")),
          pivot([0, 0, 0]),
          joint,
        ],
        volume: {
          volumeId: volumeId("volume:rig:arm:link1"),
          bounds: [
            [0, -1, -1],
            [4, 1, 1],
          ],
        },
        materialId: 1,
      },
      {
        nodeId: link2,
        name: "Link 2",
        parentId: link1,
        transform: { ...identity, translation: [4, 0, 0] },
        components: [
          voxel(volumeId("volume:rig:arm:link2")),
          pivot([0, 0, 0]),
          joint,
        ],
        volume: {
          volumeId: volumeId("volume:rig:arm:link2"),
          bounds: [
            [0, -1, -1],
            [4, 1, 1],
          ],
        },
        materialId: 2,
      },
      {
        nodeId: link3,
        name: "Link 3",
        parentId: link2,
        transform: { ...identity, translation: [4, 0, 0] },
        components: [
          voxel(volumeId("volume:rig:arm:link3")),
          pivot([0, 0, 0]),
          joint,
        ],
        volume: {
          volumeId: volumeId("volume:rig:arm:link3"),
          bounds: [
            [0, -1, -1],
            [4, 1, 1],
          ],
        },
        materialId: 3,
      },
    ],
  });
}

/**
 * Bilateral wings (plan S9.9): two mirrored wing nodes flapping about
 * their shoulder joints; the left wing mirrors the right with a 180
 * degree rotation instead of negative scale.
 */
export function createWingsFixture(): VoxelDocument {
  const rootId = nodeId("document:rig:wings:0001:root");
  return buildFixture({
    documentId: "document:rig:wings:0001",
    title: "bilateral wings",
    rootName: "Bird",
    parts: [
      {
        nodeId: nodeId("node:rig:wings:body"),
        name: "Body",
        parentId: rootId,
        transform: identity,
        components: [voxel(volumeId("volume:rig:wings:body"))],
        volume: {
          volumeId: volumeId("volume:rig:wings:body"),
          bounds: [
            [-2, -1, -1],
            [2, 1, 1],
          ],
        },
        materialId: 1,
      },
      {
        nodeId: nodeId("node:rig:wings:right"),
        name: "Right Wing",
        parentId: rootId,
        transform: identity,
        components: [
          voxel(volumeId("volume:rig:wings:right")),
          pivot([0, 0, 0]),
          joint,
        ],
        volume: {
          volumeId: volumeId("volume:rig:wings:right"),
          bounds: [
            [0, -1, -1],
            [5, 1, 1],
          ],
        },
        materialId: 2,
      },
      {
        nodeId: nodeId("node:rig:wings:left"),
        name: "Left Wing",
        parentId: rootId,
        transform: { ...identity, rotation: [0, 1, 0, 0] },
        components: [
          voxel(volumeId("volume:rig:wings:left")),
          pivot([0, 0, 0]),
          joint,
        ],
        volume: {
          volumeId: volumeId("volume:rig:wings:left"),
          bounds: [
            [0, -1, -1],
            [5, 1, 1],
          ],
        },
        materialId: 2,
      },
    ],
  });
}

/**
 * Abstract sculpture (plan S9.9): stacked parts with pivots at their
 * support points and joints at each articulation; no real-world category
 * semantics.
 */
export function createAbstractSculptureFixture(): VoxelDocument {
  const rootId = nodeId("document:rig:sculpture:0001:root");
  const column = nodeId("node:rig:sculpture:column");
  return buildFixture({
    documentId: "document:rig:sculpture:0001",
    title: "abstract sculpture",
    rootName: "Sculpture",
    parts: [
      {
        nodeId: nodeId("node:rig:sculpture:base"),
        name: "Base",
        parentId: rootId,
        transform: identity,
        components: [voxel(volumeId("volume:rig:sculpture:base")), joint],
        volume: {
          volumeId: volumeId("volume:rig:sculpture:base"),
          bounds: [
            [-5, 0, -5],
            [5, 1, 5],
          ],
        },
        materialId: 3,
      },
      {
        nodeId: column,
        name: "Column",
        parentId: rootId,
        transform: { ...identity, translation: [0, 1, 0] },
        components: [
          voxel(volumeId("volume:rig:sculpture:column")),
          pivot([0, 0, 0]),
          joint,
        ],
        volume: {
          volumeId: volumeId("volume:rig:sculpture:column"),
          bounds: [
            [-1, 0, -1],
            [1, 5, 1],
          ],
        },
        materialId: 1,
      },
      {
        nodeId: nodeId("node:rig:sculpture:arm"),
        name: "Arm",
        parentId: column,
        transform: { ...identity, translation: [0, 5, 0] },
        components: [
          voxel(volumeId("volume:rig:sculpture:arm")),
          pivot([0, 0, -1]),
          joint,
        ],
        volume: {
          volumeId: volumeId("volume:rig:sculpture:arm"),
          bounds: [
            [-1, 0, -3],
            [1, 1, 3],
          ],
        },
        materialId: 2,
      },
      {
        nodeId: nodeId("node:rig:sculpture:finial"),
        name: "Finial",
        parentId: column,
        transform: { ...identity, translation: [0, 5, 1] },
        components: [
          voxel(volumeId("volume:rig:sculpture:finial")),
          pivot([0, 0, 0]),
          joint,
        ],
        volume: {
          volumeId: volumeId("volume:rig:sculpture:finial"),
          bounds: [
            [-2, 0, -2],
            [2, 1, 2],
          ],
        },
        materialId: 3,
      },
    ],
  });
}

/** Registry of the five generic rig fixtures (plan S9.9). */
export const RIG_FIXTURES: readonly {
  readonly kind:
    | "chest-lid"
    | "wheel"
    | "linked-arm"
    | "wings"
    | "abstract-sculpture";
  readonly name: string;
  readonly create: () => VoxelDocument;
}[] = [
  {
    kind: "chest-lid",
    name: "Chest with hinged lid",
    create: createChestLidFixture,
  },
  { kind: "wheel", name: "Wheel on axle", create: createWheelFixture },
  {
    kind: "linked-arm",
    name: "Three-link arm",
    create: createLinkedArmFixture,
  },
  { kind: "wings", name: "Bilateral wings", create: createWingsFixture },
  {
    kind: "abstract-sculpture",
    name: "Abstract sculpture",
    create: createAbstractSculptureFixture,
  },
];
