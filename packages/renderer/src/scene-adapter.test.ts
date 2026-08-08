import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  type MaterialId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import type { Transform } from "@voxel-maker/math";
import {
  createDocumentStore,
  type ChangedVolume,
  type DocumentStore,
} from "@voxel-maker/document";
import type { VoxelVolume, VoxelWriteCapability } from "@voxel-maker/voxel";
import { createSceneAdapter } from "./index.js";

/**
 * Scene adapter tests. Commits are driven through the store's public
 * surface (stage/validate/commit) instead of the command bus so the
 * renderer package keeps its architectural boundary (renderer never
 * imports `commands`; the boundary checker scans test files too).
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:scene:root");
const CHILD = nodeId("node:scene:child");
const VOLUME = volumeId("volume:scene:0001");

function boxChunkSeed(): Uint16Array {
  const values = new Uint16Array(4096);
  for (let z = 0; z < 4; z += 1) {
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        values[x + y * 16 + z * 256] = 1;
      }
    }
  }
  return values;
}

interface Harness {
  readonly store: DocumentStore;
  readonly writeCapability: VoxelWriteCapability;
  readonly scene: THREE.Scene;
  readonly adapter: ReturnType<typeof createSceneAdapter>;
  commit(spec: CommitSpec): void;
}

interface CommitSpec {
  readonly mutateDocument?: (document: VoxelDocument) => void;
  readonly stageVolume?: (
    volume: VoxelVolume,
    writeCapability: VoxelWriteCapability,
  ) => void;
  readonly changedNodeIds?: readonly NodeId[];
  readonly changedMaterialIds?: readonly MaterialId[];
  readonly changedVolumes?: readonly ChangedVolume[];
}

function createHarness(): Harness {
  const document = createDocument({
    documentId: documentId("document:scene:0001"),
    metadata: { title: "scene fixture" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [CHILD],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: CHILD,
        name: "Box",
        parentId: ROOT,
        children: [],
        transform: { ...IDENTITY, translation: [2, 0, 0] },
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "box",
        color: "#ff8800",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [{ volumeId: VOLUME, bounds: { min: [0, 0, 0], max: [5, 5, 5] } }],
  });
  const handle = createDocumentStore({
    document,
    volumes: new Map([
      [VOLUME, [{ coordinate: [0, 0, 0], values: boxChunkSeed() }]],
    ]),
  });
  const scene = new THREE.Scene();
  const adapter = createSceneAdapter({ scene });
  adapter.rebind(handle.store);
  let serial = 0;

  const commit = (spec: CommitSpec): void => {
    // Mutable working copy, like the command bus's staging overlay
    // (JSON round-trip; parseDocument/cloneDocument freeze their results).
    const clone = JSON.parse(
      JSON.stringify(handle.store.getDocument()),
    ) as VoxelDocument & { revision: number };
    clone.revision = handle.store.revision + 1;
    const stagedVolumes = new Map<VolumeId, VoxelVolume>();
    if (spec.stageVolume !== undefined) {
      const volume = handle.store.stageVolume(VOLUME);
      if (volume === undefined) throw new Error("missing staged volume");
      spec.stageVolume(volume, handle.writeCapability);
      stagedVolumes.set(VOLUME, volume);
    }
    spec.mutateDocument?.(clone);
    handle.store.commit(
      { document: clone, volumes: stagedVolumes },
      {
        revisionBefore: handle.store.revision,
        revisionAfter: clone.revision,
        transactionId: transactionId(
          `transaction:scene:${String(serial).padStart(3, "0")}`,
        ),
        source: "ui",
        commandIds: [],
        commandTypes: [],
        changedNodeIds: [...(spec.changedNodeIds ?? [])],
        changedMaterialIds: [...(spec.changedMaterialIds ?? [])],
        changedAnimationIds: [],
        changedVolumes: [...(spec.changedVolumes ?? [])],
      },
      handle.writeCapability,
    );
    serial += 1;
  };

  return {
    store: handle.store,
    writeCapability: handle.writeCapability,
    scene,
    adapter,
    commit,
  };
}

type ProjectedMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.Material | THREE.Material[]
>;

function chunkMeshes(scene: THREE.Scene): ProjectedMesh[] {
  const meshes: ProjectedMesh[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object as ProjectedMesh);
  });
  return meshes;
}

function childMesh(
  adapter: ReturnType<typeof createSceneAdapter>,
): ProjectedMesh {
  const group = adapter.objectForNode(CHILD);
  const mesh = group?.children.find(
    (child): child is ProjectedMesh => child instanceof THREE.Mesh,
  );
  if (mesh === undefined) throw new Error("missing chunk mesh");
  return mesh;
}

describe("scene adapter", () => {
  it("projects the node hierarchy and chunk meshes on rebind", () => {
    const { adapter, scene } = createHarness();
    expect(adapter.nodeCount).toBe(2);
    expect(adapter.chunkMeshCount).toBe(1);
    const rootGroup = adapter.objectForNode(ROOT);
    const childGroup = adapter.objectForNode(CHILD);
    expect(rootGroup?.parent).toBe(scene);
    expect(childGroup?.parent).toBe(rootGroup);
    const mesh = childMesh(adapter);
    expect(mesh.parent).toBe(childGroup);
    // 4x4x4 box: 6*16 faces * 4 verts = 384.
    expect(mesh.geometry.getAttribute("position").count).toBe(384);
    adapter.dispose();
  });

  it("applies the canonical local matrix including pivot", () => {
    const { adapter } = createHarness();
    const childGroup = adapter.objectForNode(CHILD);
    if (childGroup === undefined) throw new Error("missing group");
    expect(childGroup.matrix.elements[12]).toBe(2);
    expect(childGroup.matrix.elements[13]).toBe(0);
    expect(childGroup.matrix.elements[14]).toBe(0);
    adapter.dispose();
  });

  it("remeshes changed chunks after a voxel commit", () => {
    const harness = createHarness();
    expect(
      childMesh(harness.adapter).geometry.getAttribute("position").count,
    ).toBe(384);
    harness.commit({
      stageVolume(volume, capability) {
        volume.setVoxel([10, 10, 10], 1, capability);
      },
      changedVolumes: [
        {
          volumeId: VOLUME,
          chunks: [{ coordinate: [0, 0, 0], revision: 1 }],
        },
      ],
    });
    // The superseded geometry was disposed and a fresh one installed.
    expect(
      childMesh(harness.adapter).geometry.getAttribute("position").count,
    ).toBe(408);
    harness.adapter.dispose();
  });

  it("updates node transforms after a transform commit", () => {
    const harness = createHarness();
    const group = harness.adapter.objectForNode(CHILD);
    if (group === undefined) throw new Error("missing group");
    harness.commit({
      mutateDocument(document) {
        const node = document.nodes[CHILD];
        if (node === undefined) throw new Error("missing node");
        (node as { transform: Transform }).transform = {
          translation: [9, 3, -2] as const,
          pivot: [0, 0, 0] as const,
          rotation: [0, 0, 0, 1] as const,
          scale: [1, 1, 1] as const,
        };
      },
      changedNodeIds: [CHILD],
    });
    expect(group.matrix.elements[12]).toBe(9);
    expect(group.matrix.elements[13]).toBe(3);
    expect(group.matrix.elements[14]).toBe(-2);
    harness.adapter.dispose();
  });

  it("updates shared materials after a material commit", () => {
    const harness = createHarness();
    const mesh = childMesh(harness.adapter);
    const material = mesh.material;
    if (!(material instanceof THREE.MeshStandardMaterial)) {
      throw new Error("expected standard material");
    }
    expect(material.color.getHexString()).toBe("ff8800");
    harness.commit({
      mutateDocument(document) {
        const record = document.materials[materialId(1)];
        if (record === undefined) throw new Error("missing material");
        (record as { color: unknown }).color = "#00ff88";
      },
      changedMaterialIds: [materialId(1)],
    });
    expect(material.color.getHexString()).toBe("00ff88");
    harness.adapter.dispose();
  });

  it("disposes a deleted node subtree", () => {
    const harness = createHarness();
    const mesh = childMesh(harness.adapter);
    const dispose = vi.spyOn(mesh.geometry, "dispose");
    harness.commit({
      mutateDocument(document) {
        const node = document.nodes[CHILD];
        if (node === undefined) throw new Error("missing node");
        const remaining = Object.fromEntries(
          Object.entries(document.nodes as Record<string, unknown>).filter(
            ([id]) => id !== CHILD,
          ),
        );
        (document as { nodes: Record<string, unknown> }).nodes = remaining;
        const root = document.nodes[ROOT];
        if (root === undefined) throw new Error("missing root");
        (root as { children: readonly NodeId[] }).children = [];
      },
      changedNodeIds: [CHILD],
    });
    expect(dispose).toHaveBeenCalled();
    expect(harness.adapter.objectForNode(CHILD)).toBeUndefined();
    expect(harness.adapter.chunkMeshCount).toBe(0);
    harness.adapter.dispose();
  });

  it("clear disposes every projection and unsubscribes from the store", () => {
    const harness = createHarness();
    const mesh = childMesh(harness.adapter);
    const dispose = vi.spyOn(mesh.geometry, "dispose");
    const materialDispose = vi.spyOn(
      mesh.material as THREE.Material,
      "dispose",
    );
    harness.adapter.clear();
    expect(dispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    expect(harness.adapter.nodeCount).toBe(0);
    expect(harness.adapter.chunkMeshCount).toBe(0);
    expect(chunkMeshes(harness.scene)).toHaveLength(0);
    // Commits after clear must not resurrect projections.
    harness.commit({
      stageVolume(volume, capability) {
        volume.setVoxel([11, 11, 11], 1, capability);
      },
      changedVolumes: [
        { volumeId: VOLUME, chunks: [{ coordinate: [0, 0, 0], revision: 1 }] },
      ],
    });
    expect(harness.adapter.chunkMeshCount).toBe(0);
    harness.adapter.dispose();
  });

  it("rebind disposes the previous projection and subscribes to the new store", () => {
    const { adapter, scene } = createHarness();
    const mesh = childMesh(adapter);
    const dispose = vi.spyOn(mesh.geometry, "dispose");
    const oldMaterial = mesh.material;
    const materialDispose = vi.spyOn(oldMaterial as THREE.Material, "dispose");

    const second = createHarness();
    adapter.rebind(second.store);
    expect(dispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    // The rebound projection uses a fresh material instance, not the
    // disposed cache entry of the replaced document.
    const reboundMesh = childMesh(adapter);
    expect(reboundMesh.material).not.toBe(oldMaterial);
    expect(adapter.nodeCount).toBe(2);
    expect(adapter.chunkMeshCount).toBe(1);
    // Commits on the new store project.
    second.commit({
      stageVolume(volume, capability) {
        volume.setVoxel([12, 12, 12], 1, capability);
      },
      changedVolumes: [
        { volumeId: VOLUME, chunks: [{ coordinate: [0, 0, 0], revision: 1 }] },
      ],
    });
    expect(chunkMeshes(scene)).toHaveLength(1);
    second.adapter.dispose();
    adapter.dispose();
  });

  it("keeps a read view's chunk readable and byte-identical after dispatch", () => {
    const harness = createHarness();
    const before = harness.store.getVolume(VOLUME)?.getChunk([0, 0, 0]);
    expect(before).toBeDefined();
    const snapshot =
      before === undefined ? undefined : Uint16Array.from(before);
    harness.commit({
      stageVolume(volume, capability) {
        volume.setVoxel([10, 10, 10], 1, capability);
      },
      changedVolumes: [
        { volumeId: VOLUME, chunks: [{ coordinate: [0, 0, 0], revision: 1 }] },
      ],
    });
    expect(snapshot).toEqual(before);
    harness.adapter.dispose();
  });
});
