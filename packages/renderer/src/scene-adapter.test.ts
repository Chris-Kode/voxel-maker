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
import {
  createSceneAdapter,
  handleMeshingRequest,
  type MeshingWorkerLike,
} from "./index.js";

/**
 * Scene adapter tests for the incremental meshing pipeline (plan
 * S6.3/S6.6-S6.8, ticket #23). Commits are driven through the store's
 * public surface (stage/validate/commit) instead of the command bus so
 * the renderer package keeps its architectural boundary (renderer never
 * imports `commands`; the boundary checker scans test files too).
 *
 * Meshing is asynchronous and budgeted: after `rebind` or a commit the
 * adapter only schedules work, so tests flush the scheduler until the
 * queues drain before asserting installed geometry. The old geometry
 * stays visible until its replacement lands, and a controlled fake
 * worker proves stale results never win.
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

function createHarness(
  options: { readonly maxUploadsPerFrame?: number } = {},
): Harness {
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
  const adapter = createSceneAdapter({
    scene,
    ...(options.maxUploadsPerFrame === undefined
      ? {}
      : { maxUploadsPerFrame: options.maxUploadsPerFrame }),
  });
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
      { document: clone, volumes: stagedVolumes, removedVolumes: [] },
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

/** Flushes until every queue drains (bounded, deterministic). */
function flushAll(adapter: ReturnType<typeof createSceneAdapter>): void {
  for (let index = 0; index < 64; index += 1) {
    adapter.flush();
    const diagnostics = adapter.diagnostics();
    if (
      diagnostics.pendingChunks === 0 &&
      diagnostics.inFlightMeshes === 0 &&
      diagnostics.uploadsThisFrame === 0
    ) {
      return;
    }
  }
  throw new Error("meshing queues did not drain");
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
  it("projects the node hierarchy synchronously and chunk meshes after flush", () => {
    const { adapter, scene } = createHarness();
    // Node projection is synchronous; meshes are scheduled.
    expect(adapter.nodeCount).toBe(2);
    expect(adapter.chunkMeshCount).toBe(0);
    expect(adapter.diagnostics().pendingChunks).toBe(1);
    const rootGroup = adapter.objectForNode(ROOT);
    const childGroup = adapter.objectForNode(CHILD);
    expect(rootGroup?.parent).toBe(scene);
    expect(childGroup?.parent).toBe(rootGroup);
    flushAll(adapter);
    expect(adapter.chunkMeshCount).toBe(1);
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

  it("keeps the old geometry visible until the replacement mesh lands", () => {
    const harness = createHarness();
    flushAll(harness.adapter);
    const before = childMesh(harness.adapter).geometry.getAttribute("position");
    expect(before.count).toBe(384);
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
    // The commit only schedules; the superseded geometry stays visible.
    expect(harness.adapter.diagnostics().pendingChunks).toBe(1);
    const mesh = childMesh(harness.adapter);
    expect(mesh.geometry.getAttribute("position").count).toBe(384);
    // The superseded geometry must be disposed exactly once when the
    // replacement installs (spy before the pipeline drains).
    const dispose = vi.spyOn(mesh.geometry, "dispose");
    flushAll(harness.adapter);
    const fresh = childMesh(harness.adapter);
    expect(fresh.geometry.getAttribute("position").count).toBe(408);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(fresh.geometry).not.toBe(mesh.geometry);
    harness.adapter.dispose();
  });

  it("disposes a chunk immediately when an edit empties it", () => {
    const harness = createHarness();
    flushAll(harness.adapter);
    const mesh = childMesh(harness.adapter);
    const dispose = vi.spyOn(mesh.geometry, "dispose");
    harness.commit({
      stageVolume(volume, capability) {
        // Remove every voxel of the 4x4x4 box (keep 1 for the change set).
        for (let z = 0; z < 4; z += 1) {
          for (let y = 0; y < 4; y += 1) {
            for (let x = 0; x < 4; x += 1) {
              if (x === 0 && y === 0 && z === 0) continue;
              volume.removeVoxel([x, y, z], capability);
            }
          }
        }
        volume.removeVoxel([0, 0, 0], capability);
      },
      changedVolumes: [
        {
          volumeId: VOLUME,
          chunks: [{ coordinate: [0, 0, 0], revision: 1 }],
        },
      ],
    });
    // The emptied chunk is disposed on the main thread: no worker
    // round-trip, no pending work, no lingering mesh.
    expect(dispose).toHaveBeenCalled();
    expect(harness.adapter.chunkMeshCount).toBe(0);
    expect(harness.adapter.diagnostics().pendingChunks).toBe(0);
    flushAll(harness.adapter);
    expect(chunkMeshes(harness.scene)).toHaveLength(0);
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
    flushAll(harness.adapter);
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

  it("budgets main-thread uploads per frame", () => {
    // Two volumes, two chunks: with one upload per frame the meshes must
    // appear one frame apart.
    const SECOND = nodeId("node:scene:child-2");
    const SECOND_VOLUME = volumeId("volume:scene:0002");
    const document = createDocument({
      documentId: documentId("document:scene:budget"),
      metadata: { title: "budget fixture" },
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [CHILD, SECOND],
          transform: IDENTITY,
          components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
        },
        {
          nodeId: CHILD,
          name: "Box",
          parentId: ROOT,
          children: [],
          transform: IDENTITY,
          components: [],
        },
        {
          nodeId: SECOND,
          name: "Box 2",
          parentId: ROOT,
          children: [],
          transform: IDENTITY,
          components: [
            { kind: "voxel", schemaVersion: 1, volumeId: SECOND_VOLUME },
          ],
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
      volumes: [
        { volumeId: VOLUME, bounds: { min: [0, 0, 0], max: [5, 5, 5] } },
        {
          volumeId: SECOND_VOLUME,
          bounds: { min: [0, 0, 0], max: [5, 5, 5] },
        },
      ],
    });
    const handle = createDocumentStore({
      document,
      volumes: new Map([
        [VOLUME, [{ coordinate: [0, 0, 0], values: boxChunkSeed() }]],
        [SECOND_VOLUME, [{ coordinate: [0, 0, 0], values: boxChunkSeed() }]],
      ]),
    });
    const scene = new THREE.Scene();
    const adapter = createSceneAdapter({ scene, maxUploadsPerFrame: 1 });
    adapter.rebind(handle.store);
    adapter.flush();
    expect(adapter.chunkMeshCount).toBe(1);
    expect(adapter.diagnostics().uploadsThisFrame).toBe(1);
    adapter.flush();
    expect(adapter.chunkMeshCount).toBe(2);
    expect(adapter.diagnostics().uploadsThisFrame).toBe(1);
    adapter.dispose();
  });

  it("reports diagnostics: triangles, draw calls, and memory estimates", () => {
    const harness = createHarness();
    flushAll(harness.adapter);
    const diagnostics = harness.adapter.diagnostics();
    // 4x4x4 box = 6 faces * 16 face-voxels = 96 quads = 192 triangles.
    expect(diagnostics.installedChunks).toBe(1);
    expect(diagnostics.triangles).toBe(192);
    // One material group -> one draw call.
    expect(diagnostics.drawCallEstimate).toBe(1);
    // 384 verts * 3 floats * 4 bytes * 2 (pos+normal) + 576 indices * 4.
    expect(diagnostics.meshBytes).toBe(384 * 3 * 4 * 2 + 96 * 6 * 4);
    expect(diagnostics.lastMeshMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.averageMeshMs).toBeGreaterThanOrEqual(0);
    harness.adapter.dispose();
    expect(harness.adapter.diagnostics().meshBytes).toBe(0);
    expect(harness.adapter.diagnostics().triangles).toBe(0);
    expect(harness.adapter.diagnostics().installedChunks).toBe(0);
  });

  it("disposes a deleted node subtree and cancels its pending meshes", () => {
    const harness = createHarness();
    flushAll(harness.adapter);
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
    flushAll(harness.adapter);
    expect(chunkMeshes(harness.scene)).toHaveLength(0);
    harness.adapter.dispose();
  });

  it("clear disposes every projection and unsubscribes from the store", () => {
    const harness = createHarness();
    flushAll(harness.adapter);
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
    flushAll(adapter);
    const mesh = childMesh(adapter);
    const dispose = vi.spyOn(mesh.geometry, "dispose");
    const oldMaterial = mesh.material;
    const materialDispose = vi.spyOn(oldMaterial as THREE.Material, "dispose");

    const second = createHarness();
    adapter.rebind(second.store);
    expect(dispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    flushAll(adapter);
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
    flushAll(adapter);
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
    flushAll(harness.adapter);
    expect(snapshot).toEqual(before);
    harness.adapter.dispose();
  });

  it("never lets a stale worker result win over a newer edit", () => {
    // A controllable fake worker lets the test deliver the OLD revision's
    // result AFTER the newer edit was scheduled; the adapter must drop it
    // and install only the newest mesh.
    const worker: MeshingWorkerLike = {
      postMessage: () => undefined,
      onmessage: null,
      terminate: () => undefined,
    };
    const document = createDocument({
      documentId: documentId("document:scene:stale"),
      metadata: { title: "stale fixture" },
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
          transform: IDENTITY,
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
      volumes: [
        { volumeId: VOLUME, bounds: { min: [0, 0, 0], max: [5, 5, 5] } },
      ],
    });
    const handle = createDocumentStore({
      document,
      volumes: new Map([
        [VOLUME, [{ coordinate: [0, 0, 0], values: boxChunkSeed() }]],
      ]),
    });
    const adapter = createSceneAdapter({
      scene: new THREE.Scene(),
      createWorker: () => worker,
    });
    adapter.rebind(handle.store);

    // Helper: read the pool's posted request and answer it.
    const requests: Array<{
      readonly requestId: number;
      readonly input: Parameters<typeof handleMeshingRequest>[0];
    }> = [];
    const originalPost = worker.postMessage.bind(worker);
    worker.postMessage = (message, transfer) => {
      originalPost(message, transfer);
      const record = message as Record<string, unknown>;
      if (record.kind === "meshing-request") {
        requests.push({
          requestId: record.requestId as number,
          input: record.input as Parameters<typeof handleMeshingRequest>[0],
        });
      }
    };
    const respond = (index: number): void => {
      const request = requests[index];
      if (request === undefined) throw new Error("missing request");
      worker.onmessage?.({
        data: {
          kind: "meshing-result",
          requestId: request.requestId,
          result: handleMeshingRequest(request.input),
        },
      });
    };

    adapter.flush();
    expect(requests).toHaveLength(1);

    // A newer edit supersedes the in-flight revision-0 job.
    const clone = JSON.parse(
      JSON.stringify(handle.store.getDocument()),
    ) as VoxelDocument & { revision: number };
    clone.revision = handle.store.revision + 1;
    const stagedVolumes = new Map<VolumeId, VoxelVolume>();
    const volume = handle.store.stageVolume(VOLUME);
    if (volume === undefined) throw new Error("missing staged volume");
    volume.setVoxel([10, 10, 10], 1, handle.writeCapability);
    stagedVolumes.set(VOLUME, volume);
    handle.store.commit(
      { document: clone, volumes: stagedVolumes, removedVolumes: [] },
      {
        revisionBefore: handle.store.revision,
        revisionAfter: clone.revision,
        transactionId: transactionId("transaction:scene:stale"),
        source: "ui",
        commandIds: [],
        commandTypes: [],
        changedNodeIds: [],
        changedMaterialIds: [],
        changedAnimationIds: [],
        changedVolumes: [
          {
            volumeId: VOLUME,
            chunks: [{ coordinate: [0, 0, 0], revision: 1 }],
          },
        ],
      },
      handle.writeCapability,
    );
    adapter.flush();
    expect(requests).toHaveLength(2);

    // Deliver the OLD result first: it must be dropped (the newer job is
    // the latest for the chunk). Then the new result installs.
    respond(0);
    adapter.flush();
    expect(adapter.chunkMeshCount).toBe(0);
    respond(1);
    adapter.flush();
    expect(adapter.chunkMeshCount).toBe(1);
    expect(adapter.diagnostics().installedChunks).toBe(1);
    expect(adapter.diagnostics().staleDropped).toBe(0);
    expect(adapter.diagnostics().cancelled).toBe(1);
    adapter.dispose();
  });
});
