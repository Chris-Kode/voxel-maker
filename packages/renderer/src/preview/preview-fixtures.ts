import {
  documentId,
  materialId,
  nodeId,
  volumeId,
  type MaterialId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  createDocumentStore,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";

/**
 * Shared deterministic fixtures for the standard preview tests (ticket
 * #25): one opaque red 2x2x2 cube, one half-transparent green voxel
 * beside it, and a scaled blue cube on a child node — representative
 * geometry covering camera conventions, materials, transparency, and
 * node transforms (the ticket's golden-image acceptance criteria).
 */

export const PREVIEW_ROOT: NodeId = nodeId("node:preview:root");
export const PREVIEW_CHILD: NodeId = nodeId("node:preview:child");
export const PREVIEW_VOLUME: VolumeId = volumeId("volume:preview:0001");
export const PREVIEW_VOLUME2: VolumeId = volumeId("volume:preview:0002");

export const PREVIEW_MATERIAL_RED: MaterialId = materialId(1);
export const PREVIEW_MATERIAL_GREEN: MaterialId = materialId(2);
export const PREVIEW_MATERIAL_BLUE: MaterialId = materialId(3);

export const PREVIEW_IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

/** Builds the preview fixture document (see module doc). */
export function createPreviewFixtureDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:preview:0001"),
    metadata: { title: "preview fixture" },
    rootNodeId: PREVIEW_ROOT,
    nodes: [
      {
        nodeId: PREVIEW_ROOT,
        name: "Root",
        parentId: null,
        children: [PREVIEW_CHILD],
        transform: PREVIEW_IDENTITY,
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: PREVIEW_VOLUME },
        ],
      },
      {
        nodeId: PREVIEW_CHILD,
        name: "Blue cube",
        parentId: PREVIEW_ROOT,
        children: [],
        transform: {
          ...PREVIEW_IDENTITY,
          translation: [0, 0, 3],
          scale: [2, 2, 2],
        },
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: PREVIEW_VOLUME2 },
        ],
      },
    ],
    materials: [
      {
        materialId: PREVIEW_MATERIAL_RED,
        name: "red",
        color: "#ff0000",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
      {
        materialId: PREVIEW_MATERIAL_GREEN,
        name: "green-glass",
        color: "#00ff00",
        opacity: 0.5,
        roughness: 0.2,
        metallic: 0,
        emissive: 0,
      },
      {
        materialId: PREVIEW_MATERIAL_BLUE,
        name: "blue",
        color: "#0000ff",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0.2,
      },
    ],
    volumes: [
      { volumeId: PREVIEW_VOLUME, bounds: { min: [0, 0, 0], max: [4, 4, 4] } },
      { volumeId: PREVIEW_VOLUME2, bounds: { min: [0, 0, 0], max: [2, 2, 2] } },
    ],
  });
}

/** Chunk seeds: red 2x2x2 cube + green voxel, and the blue single voxel. */
export function createPreviewFixtureSeeds(): ReadonlyMap<
  VolumeId,
  readonly VoxelChunkSeed[]
> {
  const values = new Uint16Array(4096);
  for (let z = 0; z < 2; z += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        values[x + y * 16 + z * 256] = PREVIEW_MATERIAL_RED;
      }
    }
  }
  values[2 + 1 * 16] = PREVIEW_MATERIAL_GREEN;
  const values2 = new Uint16Array(4096);
  values2[0] = PREVIEW_MATERIAL_BLUE;
  return new Map([
    [PREVIEW_VOLUME, [{ coordinate: [0, 0, 0], values }]],
    [PREVIEW_VOLUME2, [{ coordinate: [0, 0, 0], values: values2 }]],
  ]);
}

/** A fully installed fixture store (document + seeded volumes). */
export function createPreviewFixtureStore(): DocumentStoreRead {
  return createDocumentStore({
    document: createPreviewFixtureDocument(),
    volumes: createPreviewFixtureSeeds(),
  });
}

/** Builds a document with a single empty voxel volume (no content). */
export function createEmptyPreviewStore(): DocumentStoreRead {
  const root = nodeId("node:preview:empty");
  const volume = volumeId("volume:preview:empty");
  const document = createDocument({
    documentId: documentId("document:preview:empty"),
    metadata: { title: "empty fixture" },
    rootNodeId: root,
    nodes: [
      {
        nodeId: root,
        name: "Root",
        parentId: null,
        children: [],
        transform: PREVIEW_IDENTITY,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: volume }],
      },
    ],
    materials: [],
    volumes: [{ volumeId: volume, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }],
  });
  return createDocumentStore({ document });
}
