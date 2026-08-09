import type {
  DocumentCommitted,
  DocumentStoreHandle,
  DocumentStoreRead,
} from "@voxel-maker/document";
import { createDocumentStore } from "@voxel-maker/document";
import type { VoxelVolume } from "@voxel-maker/voxel";
import {
  animationId,
  commandId,
  componentId,
  keyframeId,
  materialId,
  nodeId,
  trackId,
  transactionId,
  volumeId,
  type AnimationId,
  type ComponentId,
  type MaterialId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import { quaternionFromAxisAngle } from "@voxel-maker/math";
import {
  createDocument,
  type AnimationDescriptor,
  type Component,
  type SceneNode,
  type VoxelDocument,
} from "@voxel-maker/model";
import {
  createAbstractSculptureFixture,
  createChestLidFixture,
  createLinkedArmFixture,
  createWheelFixture,
  createWingsFixture,
} from "@voxel-maker/rigging";
import { regionCoordinates } from "./fixtures.js";

/**
 * Fixed rig/animation evaluation fixtures (plan S13.7, ticket #36): the
 * five generic category assets — chest lid, wheel, paired wings, linked
 * arm, abstract sculpture — in two deterministic committed variants:
 * UNRIGGED (geometry and hierarchy only, no pivots/joints/constraints,
 * no clips) as the starting documents of the rigging scenarios, and
 * RIGGED (the exact end state the golden traces produce) as the starting
 * documents of the follow-up scenarios. Voxel content fills every volume
 * solidly with the primary material, so rendered preview evidence and
 * voxel-change accounting are deterministic.
 */

/** The five fixed rig fixture categories (plan S13.7). */
export type RigFixtureKind =
  | "chest-lid"
  | "wheel"
  | "wings"
  | "linked-arm"
  | "abstract";

/** Stable ids of every rig fixture part (mirrors @voxel-maker/rigging). */
export const RIG_IDS = {
  chestLid: {
    body: nodeId("node:rig:chest-lid:body"),
    lid: nodeId("node:rig:chest-lid:lid"),
    volumeBody: volumeId("volume:rig:chest-lid:body"),
    volumeLid: volumeId("volume:rig:chest-lid:lid"),
    hinge: componentId("component:rig:chest-lid:hinge"),
  },
  wheel: {
    axle: nodeId("node:rig:wheel:axle"),
    wheel: nodeId("node:rig:wheel:wheel"),
    volumeAxle: volumeId("volume:rig:wheel:axle"),
    volumeWheel: volumeId("volume:rig:wheel:wheel"),
  },
  wings: {
    body: nodeId("node:rig:wings:body"),
    right: nodeId("node:rig:wings:right"),
    leftMirror: nodeId("node:rig:wings:left-mirror"),
    left: nodeId("node:rig:wings:left"),
    volumeBody: volumeId("volume:rig:wings:body"),
    volumeRight: volumeId("volume:rig:wings:right"),
    volumeLeft: volumeId("volume:rig:wings:left"),
    rightFlap: componentId("component:rig:wings:right-flap"),
    leftFlap: componentId("component:rig:wings:left-flap"),
  },
  arm: {
    link1: nodeId("node:rig:arm:link1"),
    link2: nodeId("node:rig:arm:link2"),
    link3: nodeId("node:rig:arm:link3"),
    volume1: volumeId("volume:rig:arm:link1"),
    volume2: volumeId("volume:rig:arm:link2"),
    volume3: volumeId("volume:rig:arm:link3"),
    shoulder: componentId("component:rig:arm:shoulder"),
    elbow: componentId("component:rig:arm:elbow"),
    wrist: componentId("component:rig:arm:wrist"),
  },
  abstract: {
    base: nodeId("node:rig:sculpture:base"),
    column: nodeId("node:rig:sculpture:column"),
    arm: nodeId("node:rig:sculpture:arm"),
    finial: nodeId("node:rig:sculpture:finial"),
    volumeBase: volumeId("volume:rig:sculpture:base"),
    volumeColumn: volumeId("volume:rig:sculpture:column"),
    volumeArm: volumeId("volume:rig:sculpture:arm"),
    volumeFinial: volumeId("volume:rig:sculpture:finial"),
  },
} as const;

/** Stable ids of the fixed evaluation clips. */
export const RIG_CLIP_IDS = {
  chestOpen: animationId("animation:eval:chest-open:0001"),
  wheelSpin: animationId("animation:eval:wheel-spin:0001"),
  wingsFlap: animationId("animation:eval:wings-flap:0001"),
  armReach: animationId("animation:eval:arm-reach:0001"),
  abstractSpin: animationId("animation:eval:abstract-spin:0001"),
} as const;

/** The primary fixture material (all rig volumes fill with it). */
export const RIG_PRIMARY_MATERIAL: MaterialId = materialId(1);

/** The fixed eval clip ids per fixture kind. */
export function clipIdOf(kind: RigFixtureKind): AnimationId {
  switch (kind) {
    case "chest-lid":
      return RIG_CLIP_IDS.chestOpen;
    case "wheel":
      return RIG_CLIP_IDS.wheelSpin;
    case "wings":
      return RIG_CLIP_IDS.wingsFlap;
    case "linked-arm":
      return RIG_CLIP_IDS.armReach;
    case "abstract":
      return RIG_CLIP_IDS.abstractSpin;
  }
}

/** Full-revolution range used for unrestricted constraint axes. */
const FREE = [-Math.PI, Math.PI] as const;

const pivot = (value: readonly [number, number, number]): Component => ({
  kind: "pivot",
  schemaVersion: 1,
  pivot: [...value],
});

const joint: Component = { kind: "joint", schemaVersion: 1 };

/** A rotation-limits constraint component with one descriptor. */
function constraint(
  id: ComponentId,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): Component {
  return {
    kind: "constraint",
    schemaVersion: 1,
    constraints: [
      {
        componentId: id,
        type: "rotation-limits",
        limits: { min: [...min], max: [...max] },
      },
    ],
  };
}

/** Rotation keyframe helper (canonical quaternion from axis-angle). */
function rotationKeyframe(
  id: string,
  time: number,
  axis: readonly [number, number, number],
  angle: number,
): AnimationDescriptor["tracks"][number]["keyframes"][number] {
  return {
    keyframeId: keyframeId(id),
    time,
    property: {
      channel: "rotation",
      value: quaternionFromAxisAngle(axis, angle),
    },
  };
}

/** The five source fixture documents (from @voxel-maker/rigging). */
function sourceFixture(kind: RigFixtureKind): VoxelDocument {
  switch (kind) {
    case "chest-lid":
      return createChestLidFixture();
    case "wheel":
      return createWheelFixture();
    case "wings":
      return createWingsFixture();
    case "linked-arm":
      return createLinkedArmFixture();
    case "abstract":
      return createAbstractSculptureFixture();
  }
}

/** Removes every pivot/joint/constraint component (keeps voxel refs). */
function stripRigComponents(document: VoxelDocument): VoxelDocument {
  const nodes: SceneNode[] = Object.values(document.nodes).map((node) => ({
    ...node,
    components: node.components.filter(
      (component) =>
        component.kind !== "pivot" &&
        component.kind !== "joint" &&
        component.kind !== "constraint",
    ),
  }));
  return createDocument({
    documentId: document.documentId,
    metadata: document.metadata,
    rootNodeId: document.rootNodeId,
    nodes,
    materials: Object.values(document.materials),
    volumes: Object.values(document.volumes),
  });
}

/** The deterministic unrigged starting document of one category. */
export function unriggedDocument(kind: RigFixtureKind): VoxelDocument {
  return stripRigComponents(sourceFixture(kind));
}

/** The exact rig components the golden traces stage per category. */
function rigComponentsOf(kind: RigFixtureKind): readonly {
  readonly nodeId: NodeId;
  readonly components: readonly Component[];
}[] {
  switch (kind) {
    case "chest-lid":
      return [
        {
          nodeId: RIG_IDS.chestLid.lid,
          components: [
            pivot([0, 0, -3]),
            joint,
            constraint(
              RIG_IDS.chestLid.hinge,
              [-Math.PI / 6, FREE[0], FREE[0]],
              [Math.PI / 4, FREE[1], FREE[1]],
            ),
          ],
        },
      ];
    case "wheel":
      return [
        {
          nodeId: RIG_IDS.wheel.wheel,
          components: [pivot([0, 0, 0]), joint],
        },
      ];
    case "wings":
      return [
        {
          nodeId: RIG_IDS.wings.right,
          components: [
            pivot([0, 0, 0]),
            joint,
            constraint(
              RIG_IDS.wings.rightFlap,
              [FREE[0], FREE[0], -Math.PI / 4],
              [FREE[1], FREE[1], Math.PI / 6],
            ),
          ],
        },
        {
          nodeId: RIG_IDS.wings.left,
          components: [
            pivot([0, 0, 0]),
            joint,
            constraint(
              RIG_IDS.wings.leftFlap,
              [FREE[0], FREE[0], -Math.PI / 4],
              [FREE[1], FREE[1], Math.PI / 6],
            ),
          ],
        },
      ];
    case "linked-arm":
      return [
        {
          nodeId: RIG_IDS.arm.link1,
          components: [
            pivot([0, 0, 0]),
            joint,
            constraint(
              RIG_IDS.arm.shoulder,
              [-Math.PI / 3, -Math.PI / 6, FREE[0]],
              [Math.PI / 3, Math.PI / 6, FREE[1]],
            ),
          ],
        },
        {
          nodeId: RIG_IDS.arm.link2,
          components: [
            pivot([0, 0, 0]),
            joint,
            constraint(
              RIG_IDS.arm.elbow,
              [FREE[0], FREE[0], -Math.PI / 2],
              [FREE[1], FREE[1], Math.PI / 4],
            ),
          ],
        },
        {
          nodeId: RIG_IDS.arm.link3,
          components: [
            pivot([0, 0, 0]),
            joint,
            constraint(
              RIG_IDS.arm.wrist,
              [FREE[0], FREE[0], -Math.PI / 4],
              [FREE[1], FREE[1], Math.PI / 4],
            ),
          ],
        },
      ];
    case "abstract":
      return [
        {
          nodeId: RIG_IDS.abstract.column,
          components: [pivot([0, 0, 0]), joint],
        },
        {
          nodeId: RIG_IDS.abstract.arm,
          components: [pivot([0, 0, -1]), joint],
        },
      ];
  }
}

/** The fixed evaluation clip per category (golden end state). */
export function evalClipOf(kind: RigFixtureKind): AnimationDescriptor {
  switch (kind) {
    case "chest-lid":
      return {
        animationId: RIG_CLIP_IDS.chestOpen,
        name: "Open Lid",
        duration: 2,
        loop: "once",
        tracks: [
          {
            trackId: trackId("track:eval:chest-open:lid"),
            targetNodeId: RIG_IDS.chestLid.lid,
            interpolation: "smoothstep",
            keyframes: [
              rotationKeyframe("keyframe:eval:chest-open:0", 0, [1, 0, 0], 0),
              rotationKeyframe(
                "keyframe:eval:chest-open:1",
                2,
                [1, 0, 0],
                Math.PI / 3,
              ),
            ],
          },
        ],
      };
    case "wheel":
      return {
        animationId: RIG_CLIP_IDS.wheelSpin,
        name: "Wheel Spin",
        duration: 2,
        loop: "loop",
        tracks: [
          {
            trackId: trackId("track:eval:wheel-spin:wheel"),
            targetNodeId: RIG_IDS.wheel.wheel,
            interpolation: "linear",
            keyframes: [
              rotationKeyframe("keyframe:eval:wheel-spin:0", 0, [0, 1, 0], 0),
              rotationKeyframe(
                "keyframe:eval:wheel-spin:1",
                2,
                [0, 1, 0],
                2 * Math.PI,
              ),
            ],
          },
        ],
      };
    case "wings":
      return {
        animationId: RIG_CLIP_IDS.wingsFlap,
        name: "Flap",
        duration: 1,
        loop: "loop",
        tracks: [
          {
            trackId: trackId("track:eval:wings-flap:right"),
            targetNodeId: RIG_IDS.wings.right,
            interpolation: "smoothstep",
            keyframes: [
              rotationKeyframe(
                "keyframe:eval:wings-flap:right:0",
                0,
                [0, 0, 1],
                0,
              ),
              rotationKeyframe(
                "keyframe:eval:wings-flap:right:1",
                1,
                [0, 0, 1],
                Math.PI / 4,
              ),
            ],
          },
          {
            trackId: trackId("track:eval:wings-flap:left"),
            targetNodeId: RIG_IDS.wings.left,
            interpolation: "smoothstep",
            keyframes: [
              rotationKeyframe(
                "keyframe:eval:wings-flap:left:0",
                0,
                [0, 0, 1],
                0,
              ),
              rotationKeyframe(
                "keyframe:eval:wings-flap:left:1",
                1,
                [0, 0, 1],
                -Math.PI / 4,
              ),
            ],
          },
        ],
      };
    case "linked-arm":
      return {
        animationId: RIG_CLIP_IDS.armReach,
        name: "Reach",
        duration: 2,
        loop: "once",
        tracks: [
          {
            trackId: trackId("track:eval:arm-reach:shoulder"),
            targetNodeId: RIG_IDS.arm.link1,
            interpolation: "linear",
            keyframes: [
              rotationKeyframe(
                "keyframe:eval:arm-reach:shoulder:0",
                0,
                [1, 0, 0],
                0,
              ),
              rotationKeyframe(
                "keyframe:eval:arm-reach:shoulder:1",
                2,
                [1, 0, 0],
                Math.PI / 2,
              ),
            ],
          },
          {
            trackId: trackId("track:eval:arm-reach:elbow"),
            targetNodeId: RIG_IDS.arm.link2,
            interpolation: "linear",
            keyframes: [
              rotationKeyframe(
                "keyframe:eval:arm-reach:elbow:0",
                0,
                [0, 0, 1],
                0,
              ),
              rotationKeyframe(
                "keyframe:eval:arm-reach:elbow:1",
                2,
                [0, 0, 1],
                Math.PI / 3,
              ),
            ],
          },
          {
            trackId: trackId("track:eval:arm-reach:wrist"),
            targetNodeId: RIG_IDS.arm.link3,
            interpolation: "linear",
            keyframes: [
              rotationKeyframe(
                "keyframe:eval:arm-reach:wrist:0",
                0,
                [0, 0, 1],
                0,
              ),
              rotationKeyframe(
                "keyframe:eval:arm-reach:wrist:1",
                2,
                [0, 0, 1],
                Math.PI / 6,
              ),
            ],
          },
        ],
      };
    case "abstract":
      return {
        animationId: RIG_CLIP_IDS.abstractSpin,
        name: "Abstract Spin",
        duration: 2,
        loop: "loop",
        tracks: [
          {
            trackId: trackId("track:eval:abstract-spin:arm"),
            targetNodeId: RIG_IDS.abstract.arm,
            interpolation: "smoothstep",
            keyframes: [
              rotationKeyframe(
                "keyframe:eval:abstract-spin:0",
                0,
                [0, 0, 1],
                0,
              ),
              rotationKeyframe(
                "keyframe:eval:abstract-spin:1",
                2,
                [0, 0, 1],
                Math.PI / 2,
              ),
            ],
          },
        ],
      };
  }
}

/** The deterministic rigged document (initial end state / follow-up start). */
export function riggedDocument(kind: RigFixtureKind): VoxelDocument {
  const unrigged = unriggedDocument(kind);
  const rigged = new Map(
    rigComponentsOf(kind).map((entry) => [entry.nodeId, entry.components]),
  );
  const nodes: SceneNode[] = Object.values(unrigged.nodes).map((node) => ({
    ...node,
    components: [...node.components, ...(rigged.get(node.nodeId) ?? [])],
  }));
  return createDocument({
    documentId: unrigged.documentId,
    metadata: unrigged.metadata,
    rootNodeId: unrigged.rootNodeId,
    nodes,
    materials: Object.values(unrigged.materials),
    volumes: Object.values(unrigged.volumes),
    animations: [evalClipOf(kind)],
  });
}

/** The volumes of one fixture and their declared bounds. */
export function fixtureVolumes(kind: RigFixtureKind): readonly {
  readonly volumeId: VolumeId;
  readonly bounds: IntAabb;
}[] {
  const document = unriggedDocument(kind);
  return Object.values(document.volumes).flatMap((volume) =>
    volume.bounds === undefined
      ? []
      : [
          {
            volumeId: volume.volumeId,
            bounds: {
              min: [...volume.bounds.min],
              max: [...volume.bounds.max],
            },
          },
        ],
  );
}

/** The union scan region of a fixture's volumes (document-space bounds). */
export function fixtureScanRegions(kind: RigFixtureKind): readonly {
  readonly volumeId: VolumeId;
  readonly region: IntAabb;
}[] {
  return fixtureVolumes(kind).map((entry) => ({
    volumeId: entry.volumeId,
    region: entry.bounds,
  }));
}

/** Commits solid voxel content into every fixture volume (deterministic). */
function commitRigVoxels(
  handle: DocumentStoreHandle,
  kind: RigFixtureKind,
): void {
  const { store, writeCapability } = handle;
  const volumes = fixtureVolumes(kind);
  const staged = new Map<VolumeId, VoxelVolume>();
  const entries: {
    volumeId: VolumeId;
    coordinate: Vec3i;
    material: MaterialId;
  }[] = [];
  for (const entry of volumes) {
    const view = store.stageVolume(entry.volumeId);
    if (view === undefined)
      throw new Error(`rig fixture volume missing: ${entry.volumeId}`);
    staged.set(entry.volumeId, view);
    for (const coordinate of regionCoordinates(entry.bounds)) {
      view.setVoxel(coordinate, RIG_PRIMARY_MATERIAL, writeCapability);
      entries.push({
        volumeId: entry.volumeId,
        coordinate,
        material: RIG_PRIMARY_MATERIAL,
      });
    }
  }
  const document = { ...store.getDocument(), revision: store.revision + 1 };
  const event: DocumentCommitted = {
    revisionBefore: store.revision,
    revisionAfter: store.revision + 1,
    transactionId: transactionId(`transaction:eval:rig:${kind}:seed`),
    source: "system",
    commandIds: [commandId(`command:eval:rig:${kind}:seed`)],
    commandTypes: ["seedFixtureVoxels"],
    changedNodeIds: [],
    changedMaterialIds: [],
    changedAnimationIds: [],
    changedVolumes: volumes.map((entry) => ({
      volumeId: entry.volumeId,
      chunks: [],
      bounds: { min: [...entry.bounds.min], max: [...entry.bounds.max] },
    })),
  };
  store.commit(
    { document, volumes: staged, removedVolumes: [] },
    event,
    writeCapability,
  );
}

/** Builds the committed unrigged or rigged fixture store. */
export function createRigFixtureStore(
  kind: RigFixtureKind,
  rigged: boolean,
): { readonly store: DocumentStoreRead; readonly handle: DocumentStoreHandle } {
  const handle = createDocumentStore({
    document: rigged ? riggedDocument(kind) : unriggedDocument(kind),
  });
  commitRigVoxels(handle, kind);
  return { store: handle.store, handle };
}
