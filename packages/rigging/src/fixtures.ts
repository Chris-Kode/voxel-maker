import {
  componentId,
  documentId,
  materialId,
  nodeId,
  volumeId,
  type ComponentId,
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

/** A rotation-limits constraint component with one descriptor. */
const constraint = (
  id: ComponentId,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): Component => ({
  kind: "constraint",
  schemaVersion: 1,
  constraints: [
    {
      componentId: id,
      type: "rotation-limits",
      limits: { min: [...min], max: [...max] },
    },
  ],
});

/** Full-revolution range used for axes a fixture leaves unrestricted. */
const FREE = [-Math.PI, Math.PI] as const;

const voxel = (id: VolumeId): Component => ({
  kind: "voxel",
  schemaVersion: 1,
  volumeId: id,
});

interface Part {
  readonly nodeId: NodeId;
  readonly name: string;
  /** `null` means the fixture root (resolved at build time). */
  readonly parentId: NodeId | null;
  readonly transform: Transform;
  readonly components: readonly Component[];
  readonly volume: {
    readonly volumeId: VolumeId;
    readonly bounds: readonly [
      readonly [number, number, number],
      readonly [number, number, number],
    ];
  };
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
  const parentOf = (part: Part): NodeId => part.parentId ?? rootId;
  const childrenOf = (id: NodeId): readonly NodeId[] =>
    shape.parts
      .filter((part) => parentOf(part) === id)
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
      parentId: parentOf(part),
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
        parentId: null,
        transform: identity,
        components: [voxel(volumeId("volume:rig:chest-lid:body"))],
        volume: {
          volumeId: volumeId("volume:rig:chest-lid:body"),
          bounds: [
            [-4, 0, -3],
            [4, 6, 3],
          ],
        },
      },
      {
        nodeId: nodeId("node:rig:chest-lid:lid"),
        name: "Lid",
        parentId: null,
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
          constraint(
            componentId("component:rig:chest-lid:hinge"),
            [-Math.PI / 6, FREE[0], FREE[0]],
            [Math.PI / 4, FREE[1], FREE[1]],
          ),
        ],
        volume: {
          volumeId: volumeId("volume:rig:chest-lid:lid"),
          bounds: [
            [-4, 0, -3],
            [4, 2, 3],
          ],
        },
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
        parentId: null,
        transform: identity,
        components: [voxel(volumeId("volume:rig:wheel:axle"))],
        volume: {
          volumeId: volumeId("volume:rig:wheel:axle"),
          bounds: [
            [-1, -1, -4],
            [1, 1, 4],
          ],
        },
      },
      {
        nodeId: nodeId("node:rig:wheel:wheel"),
        name: "Wheel",
        parentId: null,
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
        parentId: null,
        transform: identity,
        components: [
          voxel(volumeId("volume:rig:arm:link1")),
          pivot([0, 0, 0]),
          joint,
          constraint(
            componentId("component:rig:arm:shoulder"),
            [-Math.PI / 3, -Math.PI / 6, FREE[0]],
            [Math.PI / 3, Math.PI / 6, FREE[1]],
          ),
        ],
        volume: {
          volumeId: volumeId("volume:rig:arm:link1"),
          bounds: [
            [0, -1, -1],
            [4, 1, 1],
          ],
        },
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
          constraint(
            componentId("component:rig:arm:elbow"),
            [FREE[0], FREE[0], -Math.PI / 2],
            [FREE[1], FREE[1], Math.PI / 4],
          ),
        ],
        volume: {
          volumeId: volumeId("volume:rig:arm:link2"),
          bounds: [
            [0, -1, -1],
            [4, 1, 1],
          ],
        },
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
          constraint(
            componentId("component:rig:arm:wrist"),
            [FREE[0], FREE[0], -Math.PI / 4],
            [FREE[1], FREE[1], Math.PI / 4],
          ),
        ],
        volume: {
          volumeId: volumeId("volume:rig:arm:link3"),
          bounds: [
            [0, -1, -1],
            [4, 1, 1],
          ],
        },
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
  return buildFixture({
    documentId: "document:rig:wings:0001",
    title: "bilateral wings",
    rootName: "Bird",
    parts: [
      {
        nodeId: nodeId("node:rig:wings:body"),
        name: "Body",
        parentId: null,
        transform: identity,
        components: [voxel(volumeId("volume:rig:wings:body"))],
        volume: {
          volumeId: volumeId("volume:rig:wings:body"),
          bounds: [
            [-2, -1, -1],
            [2, 1, 1],
          ],
        },
      },
      {
        nodeId: nodeId("node:rig:wings:right"),
        name: "Right Wing",
        parentId: null,
        transform: identity,
        components: [
          voxel(volumeId("volume:rig:wings:right")),
          pivot([0, 0, 0]),
          joint,
          constraint(
            componentId("component:rig:wings:right-flap"),
            [FREE[0], FREE[0], -Math.PI / 4],
            [FREE[1], FREE[1], Math.PI / 6],
          ),
        ],
        volume: {
          volumeId: volumeId("volume:rig:wings:right"),
          bounds: [
            [0, -1, -1],
            [5, 1, 1],
          ],
        },
      },
      {
        nodeId: nodeId("node:rig:wings:left-mirror"),
        name: "Left Mirror",
        parentId: null,
        // The mirror lives on a parent so that rotation animation of the
        // wing node (ticket #30) composes through it instead of replacing
        // the mirror: the left wing flaps mirrored about the body.
        transform: { ...identity, rotation: [0, 1, 0, 0] },
        components: [],
        volume: {
          volumeId: volumeId("volume:rig:wings:left-mirror"),
          bounds: [
            [0, 0, 0],
            [1, 1, 1],
          ],
        },
      },
      {
        nodeId: nodeId("node:rig:wings:left"),
        name: "Left Wing",
        parentId: nodeId("node:rig:wings:left-mirror"),
        transform: identity,
        components: [
          voxel(volumeId("volume:rig:wings:left")),
          pivot([0, 0, 0]),
          joint,
          constraint(
            componentId("component:rig:wings:left-flap"),
            [FREE[0], FREE[0], -Math.PI / 4],
            [FREE[1], FREE[1], Math.PI / 6],
          ),
        ],
        volume: {
          volumeId: volumeId("volume:rig:wings:left"),
          bounds: [
            [0, -1, -1],
            [5, 1, 1],
          ],
        },
      },
    ],
  });
}

/**
 * Simple character (plan S10.15, ticket #30): a generic humanoid built
 * entirely from nodes, voxel volumes, pivots, joints, and rotation
 * constraints — head, torso, two mirrored arms, and two legs. Each limb
 * pivots at its joint (neck, shoulders, hips) and carries a joint
 * annotation plus rotation limits; nothing here is a category-specific
 * skeleton, bone, or rig component.
 */
export function createSimpleCharacterFixture(): VoxelDocument {
  const parts: readonly Part[] = [
    {
      nodeId: nodeId("node:rig:character:torso"),
      name: "Torso",
      parentId: null,
      transform: identity,
      components: [voxel(volumeId("volume:rig:character:torso"))],
      volume: {
        volumeId: volumeId("volume:rig:character:torso"),
        bounds: [
          [-2, 0, -1],
          [2, 3, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:character:head"),
      name: "Head",
      parentId: null,
      transform: { ...identity, translation: [0, 3, 0] },
      components: [
        voxel(volumeId("volume:rig:character:head")),
        pivot([0, 0, 0]),
        joint,
        constraint(
          componentId("component:rig:character:neck"),
          [-Math.PI / 6, -Math.PI / 3, FREE[0]],
          [Math.PI / 6, Math.PI / 3, FREE[1]],
        ),
      ],
      volume: {
        volumeId: volumeId("volume:rig:character:head"),
        bounds: [
          [-1, 0, -1],
          [1, 1, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:character:left-arm"),
      name: "Left Arm",
      parentId: null,
      transform: { ...identity, translation: [-2, 2, 0] },
      components: [
        voxel(volumeId("volume:rig:character:left-arm")),
        pivot([0, 0, 0]),
        joint,
        constraint(
          componentId("component:rig:character:left-shoulder"),
          [-Math.PI / 2, FREE[0], -Math.PI / 6],
          [Math.PI / 3, FREE[1], Math.PI / 6],
        ),
      ],
      volume: {
        volumeId: volumeId("volume:rig:character:left-arm"),
        bounds: [
          [-1, -2, -1],
          [1, 1, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:character:right-arm"),
      name: "Right Arm",
      parentId: null,
      transform: { ...identity, translation: [2, 2, 0] },
      components: [
        voxel(volumeId("volume:rig:character:right-arm")),
        pivot([0, 0, 0]),
        joint,
        constraint(
          componentId("component:rig:character:right-shoulder"),
          [-Math.PI / 2, FREE[0], -Math.PI / 6],
          [Math.PI / 3, FREE[1], Math.PI / 6],
        ),
      ],
      volume: {
        volumeId: volumeId("volume:rig:character:right-arm"),
        bounds: [
          [-1, -2, -1],
          [1, 1, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:character:left-leg"),
      name: "Left Leg",
      parentId: null,
      transform: { ...identity, translation: [-1, 0, 0] },
      components: [
        voxel(volumeId("volume:rig:character:left-leg")),
        pivot([0, 0, 0]),
        joint,
        constraint(
          componentId("component:rig:character:left-hip"),
          [-Math.PI / 3, FREE[0], -Math.PI / 6],
          [Math.PI / 3, FREE[1], Math.PI / 6],
        ),
      ],
      volume: {
        volumeId: volumeId("volume:rig:character:left-leg"),
        bounds: [
          [-1, -3, -1],
          [1, 0, 1],
        ],
      },
    },
    {
      nodeId: nodeId("node:rig:character:right-leg"),
      name: "Right Leg",
      parentId: null,
      transform: { ...identity, translation: [1, 0, 0] },
      components: [
        voxel(volumeId("volume:rig:character:right-leg")),
        pivot([0, 0, 0]),
        joint,
        constraint(
          componentId("component:rig:character:right-hip"),
          [-Math.PI / 3, FREE[0], -Math.PI / 6],
          [Math.PI / 3, FREE[1], Math.PI / 6],
        ),
      ],
      volume: {
        volumeId: volumeId("volume:rig:character:right-leg"),
        bounds: [
          [-1, -3, -1],
          [1, 0, 1],
        ],
      },
    },
  ];
  return buildFixture({
    documentId: "document:rig:character:0001",
    title: "simple character",
    rootName: "Character",
    parts,
  });
}

/**
 * Abstract sculpture (plan S9.9): stacked parts with pivots at their
 * support points and joints at each articulation; no real-world category
 * semantics.
 */
export function createAbstractSculptureFixture(): VoxelDocument {
  const column = nodeId("node:rig:sculpture:column");
  return buildFixture({
    documentId: "document:rig:sculpture:0001",
    title: "abstract sculpture",
    rootName: "Sculpture",
    parts: [
      {
        nodeId: nodeId("node:rig:sculpture:base"),
        name: "Base",
        parentId: null,
        transform: identity,
        components: [voxel(volumeId("volume:rig:sculpture:base")), joint],
        volume: {
          volumeId: volumeId("volume:rig:sculpture:base"),
          bounds: [
            [-5, 0, -5],
            [5, 1, 5],
          ],
        },
      },
      {
        nodeId: column,
        name: "Column",
        parentId: null,
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
      },
      {
        nodeId: nodeId("node:rig:sculpture:arm"),
        name: "Arm",
        parentId: column,
        transform: { ...identity, translation: [0, 5, 0], pivot: [0, 0, -1] },
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
    | "abstract-sculpture"
    | "simple-character";
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
  {
    kind: "simple-character",
    name: "Simple character",
    create: createSimpleCharacterFixture,
  },
];
