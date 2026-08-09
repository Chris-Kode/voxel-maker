import type {
  DocumentCommitted,
  DocumentStore,
  DocumentStoreRead,
  DocumentStoreHandle,
} from "@voxel-maker/document";
import { createDocumentStore } from "@voxel-maker/document";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  animationId,
  commandId,
  componentId,
  documentId,
  keyframeId,
  materialId,
  nodeId,
  transactionId,
  trackId,
  volumeId,
  type MaterialId,
} from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import type { EditorContextPort, EditorSelectionSnapshot } from "./port.js";

/**
 * Deterministic fixture for inspection tests (pattern: rigging/animation
 * fixture modules). One document with hierarchy, materials, a populated
 * volume, rig annotations, metadata tags, and one animation clip; the
 * store is committed with fixed voxels so every inspection test runs
 * against identical state.
 */

export const FIXTURE_IDS = {
  document: documentId("document:inspect:0001"),
  root: nodeId("node:root"),
  body: nodeId("node:body"),
  arm: nodeId("node:arm"),
  decoration: nodeId("node:decoration"),
  volumeMain: volumeId("volume:main"),
  volumeEmpty: volumeId("volume:empty"),
  materialAccent: materialId(1),
  materialMetal: materialId(2),
  animationWave: animationId("anim:wave"),
  trackWave: trackId("track:wave"),
  keyframeStart: keyframeId("keyframe:wave:start"),
  keyframeEnd: keyframeId("keyframe:wave:end"),
} as const;

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

/** Populated voxel entries of the main volume (X-fastest, fixed). */
export const FIXTURE_VOXELS: readonly {
  coordinate: Vec3i;
  material: MaterialId;
}[] = [
  { coordinate: [0, 0, 0], material: materialId(1) },
  { coordinate: [1, 0, 0], material: materialId(1) },
  { coordinate: [0, 1, 0], material: materialId(2) },
  { coordinate: [0, 0, 1], material: materialId(1) },
];

/** Builds the frozen fixture document. */
export function createInspectionDocument(): VoxelDocument {
  return createDocument({
    documentId: FIXTURE_IDS.document,
    metadata: { title: "inspection fixture", tags: ["test", "fixture"] },
    rootNodeId: FIXTURE_IDS.root,
    nodes: [
      {
        nodeId: FIXTURE_IDS.root,
        name: "Root",
        parentId: null,
        children: [FIXTURE_IDS.body, FIXTURE_IDS.decoration],
        transform: identity,
        components: [],
      },
      {
        nodeId: FIXTURE_IDS.body,
        name: "Body",
        parentId: FIXTURE_IDS.root,
        children: [FIXTURE_IDS.arm],
        transform: { ...identity, translation: [0, 2, 0] },
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: FIXTURE_IDS.volumeMain },
        ],
      },
      {
        nodeId: FIXTURE_IDS.arm,
        name: "Arm",
        parentId: FIXTURE_IDS.body,
        children: [],
        transform: { ...identity, translation: [1, 0, 0] },
        components: [
          { kind: "pivot", schemaVersion: 1, pivot: [0, 0.5, 0] },
          { kind: "joint", schemaVersion: 1 },
          {
            kind: "constraint",
            schemaVersion: 1,
            constraints: [
              {
                componentId: componentId("component:arm:limits"),
                type: "rotation-limits",
                limits: {
                  min: [-1, -1, -1],
                  max: [1, 1, 1],
                },
              },
            ],
          },
        ],
      },
      {
        nodeId: FIXTURE_IDS.decoration,
        name: "Deco",
        parentId: FIXTURE_IDS.root,
        children: [],
        transform: identity,
        components: [],
        metadata: { tags: ["decor", "tagged"], note: "shiny" },
      },
    ],
    materials: [
      {
        materialId: FIXTURE_IDS.materialAccent,
        name: "accent",
        color: "#ff8800",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
      {
        materialId: FIXTURE_IDS.materialMetal,
        name: "metal",
        color: "#334455",
        opacity: 0.9,
        roughness: 0.2,
        metallic: 0.8,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: FIXTURE_IDS.volumeMain,
        name: "main",
        bounds: { min: [0, 0, 0], max: [2, 2, 2] },
      },
      { volumeId: FIXTURE_IDS.volumeEmpty, name: "empty" },
    ],
    animations: [
      {
        animationId: FIXTURE_IDS.animationWave,
        name: "wave",
        duration: 1,
        loop: "loop",
        tracks: [
          {
            trackId: FIXTURE_IDS.trackWave,
            targetNodeId: FIXTURE_IDS.arm,
            interpolation: "smoothstep",
            keyframes: [
              {
                keyframeId: FIXTURE_IDS.keyframeStart,
                time: 0,
                property: { channel: "rotation", value: [0, 0, 0, 1] },
              },
              {
                keyframeId: FIXTURE_IDS.keyframeEnd,
                time: 1,
                property: { channel: "rotation", value: [0, 0, 1, 0] },
              },
            ],
          },
        ],
      },
    ],
  });
}

/** Commits the fixture voxels into the store (one atomic transaction). */
function commitFixtureVoxels(handle: DocumentStoreHandle): void {
  const { store, writeCapability } = handle;
  const staged = store.stageVolume(FIXTURE_IDS.volumeMain);
  if (staged === undefined) throw new Error("fixture volume missing");
  for (const entry of FIXTURE_VOXELS) {
    staged.setVoxel(entry.coordinate, entry.material, writeCapability);
  }
  const document = {
    ...store.getDocument(),
    revision: store.revision + 1,
  };
  const event: DocumentCommitted = {
    revisionBefore: store.revision,
    revisionAfter: store.revision + 1,
    transactionId: transactionId("transaction:inspect:0001"),
    source: "system",
    commandIds: [commandId("command:inspect:seed")],
    commandTypes: ["seedFixtureVoxels"],
    changedNodeIds: [],
    changedMaterialIds: [],
    changedAnimationIds: [],
    changedVolumes: [
      {
        volumeId: FIXTURE_IDS.volumeMain,
        chunks: [],
        bounds: { min: [0, 0, 0], max: [0, 1, 1] },
      },
    ],
  };
  store.commit(
    {
      document,
      volumes: new Map([[FIXTURE_IDS.volumeMain, staged]]),
      removedVolumes: [],
    },
    event,
    writeCapability,
  );
}

/** Builds the committed fixture store. */
export function createInspectionStore(): {
  readonly store: DocumentStoreRead;
  readonly handle: DocumentStoreHandle;
} {
  const handle = createDocumentStore({ document: createInspectionDocument() });
  commitFixtureVoxels(handle);
  return { store: handle.store, handle };
}

/** A deterministic selection port used by selection tests. */
export function createSelectionPort(
  selection: readonly EditorSelectionSnapshot[],
): EditorContextPort {
  return { getSelection: () => selection };
}

export type { DocumentStore };
