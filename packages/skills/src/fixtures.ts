import type {
  DocumentStore,
  DocumentStoreHandle,
  DocumentStoreRead,
} from "@voxel-maker/document";
import { createDocumentStore } from "@voxel-maker/document";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  documentId,
  materialId,
  nodeId,
  volumeId,
  type MaterialId,
} from "@voxel-maker/shared";
import { CommandBus, CommandRegistry } from "@voxel-maker/commands";
import { createPreviewRegistry } from "@voxel-maker/agent";

/**
 * Deterministic fixture for generator tests (pattern: agent fixtures
 * module): one document with a roomy empty volume and one material. The
 * store starts empty so every generator test controls exactly which
 * voxels exist; helper transactions seed a source block through the
 * ordinary command bus when a generator needs existing geometry.
 */

export const FIXTURE_IDS = {
  document: documentId("document:generator:0001"),
  root: nodeId("node:generator:root"),
  body: nodeId("node:generator:body"),
  volume: volumeId("volume:generator:main"),
  material: materialId(1),
  materialAccent: materialId(2),
} as const;

export const FIXTURE_MATERIAL: MaterialId = FIXTURE_IDS.material;

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

/** Builds the frozen fixture document (empty volume). */
export function createGeneratorDocument(): VoxelDocument {
  return createDocument({
    documentId: FIXTURE_IDS.document,
    metadata: { title: "generator fixture" },
    rootNodeId: FIXTURE_IDS.root,
    nodes: [
      {
        nodeId: FIXTURE_IDS.root,
        name: "Root",
        parentId: null,
        children: [FIXTURE_IDS.body],
        transform: identity,
        components: [],
      },
      {
        nodeId: FIXTURE_IDS.body,
        name: "Body",
        parentId: FIXTURE_IDS.root,
        children: [],
        transform: identity,
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: FIXTURE_IDS.volume },
        ],
      },
    ],
    materials: [
      {
        materialId: FIXTURE_IDS.material,
        name: "stone",
        color: "#888888",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: FIXTURE_IDS.volume,
        name: "main",
        bounds: { min: [-256, -256, -256], max: [256, 256, 256] },
      },
    ],
  });
}

/** A live store plus a fully registered preview command bus. */
export interface GeneratorFixture {
  readonly store: DocumentStoreRead;
  readonly handle: DocumentStoreHandle;
  readonly registry: CommandRegistry;
  readonly bus: CommandBus;
}

/** Creates the live fixture: store, generic preview registry, and bus. */
export function createGeneratorFixture(): GeneratorFixture {
  const handle = createDocumentStore({ document: createGeneratorDocument() });
  const registry = createPreviewRegistry();
  const bus = new CommandBus(handle.store, registry, handle.writeCapability);
  return { store: handle.store, handle, registry, bus };
}

export type { DocumentStore };
