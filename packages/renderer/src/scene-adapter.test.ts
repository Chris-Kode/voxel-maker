import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  componentId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  type MaterialId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  canonicalDocumentHash,
  createDocument,
  type VoxelDocument,
} from "@voxel-maker/model";
import { createSimpleCharacterFixture } from "@voxel-maker/rigging";
import { transformToMatrix, type Transform } from "@voxel-maker/math";
import { type ChangedVolume } from "@voxel-maker/document";
import {
  createDocumentStoreHandle,
  type DocumentStore,
} from "@voxel-maker/document/internal";
import type { VoxelVolume, VoxelWriteCapability } from "@voxel-maker/voxel";
import {
  ANIMATED_DEMOS,
  evaluateAnimationRuntime,
} from "@voxel-maker/animation";
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
  const handle = createDocumentStoreHandle({
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
      diagnostics.deferredChunks === 0 &&
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

  it("exposes column-major matrices consumable by Three.js without transpose (issue #82)", () => {
    // Regression test for issue #82: `transformToMatrix` must store the
    // matrix column-major so a standard consumer (`THREE.Matrix4.fromArray`
    // + `applyMatrix4`) maps the origin to the translation directly. The
    // scene adapter must not need its former `.transpose()` workaround.
    const matrix = new THREE.Matrix4().fromArray(
      transformToMatrix({
        translation: [1, 2, 3],
        pivot: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      }),
    );
    expect(new THREE.Vector3(0, 0, 0).applyMatrix4(matrix).toArray()).toEqual([
      1, 2, 3,
    ]);
  });

  it("projects the constrained local rotation (plan S9.6, ticket #27)", () => {
    const harness = createHarness();
    harness.commit({
      mutateDocument: (document) => {
        const child = document.nodes[CHILD];
        if (child === undefined) return;
        (child as { transform: Transform }).transform = {
          ...child.transform,
          rotation: [
            Math.sin((60 * Math.PI) / 360),
            0,
            0,
            Math.cos((60 * Math.PI) / 360),
          ],
        };
        (child as { components: typeof child.components }).components = [
          { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
          {
            kind: "constraint",
            schemaVersion: 1,
            constraints: [
              {
                componentId: componentId("component:scene:limit"),
                type: "rotation-limits",
                limits: {
                  min: [(-30 * Math.PI) / 180, 0, 0],
                  max: [(30 * Math.PI) / 180, 0, 0],
                },
              },
            ],
          },
        ];
      },
      changedNodeIds: [CHILD],
    });
    const childGroup = harness.adapter.objectForNode(CHILD);
    if (childGroup === undefined) throw new Error("missing group");
    // The authored 60 deg rotation clamps to 30 deg: the group matrix
    // shows cos(30)/sin(30), not cos(60)/sin(60) (column-major storage:
    // row 1 col 1 at elements[5], row 2 col 1 at elements[9]).
    expect(childGroup.matrix.elements[5]).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    expect(childGroup.matrix.elements[6]).toBeCloseTo(Math.sin(Math.PI / 6), 6);
    expect(childGroup.matrix.elements[9]).toBeCloseTo(
      -Math.sin(Math.PI / 6),
      6,
    );
    // The base document is untouched.
    const child = harness.store.getDocument().nodes[CHILD];
    expect(child?.transform.rotation[0]).toBeCloseTo(Math.sin(Math.PI / 6), 10);
    harness.adapter.dispose();
  });

  it("projects a definition-of-done demo rig deterministically without mutating the store (ticket #30)", () => {
    const document = createSimpleCharacterFixture();
    const handle = createDocumentStoreHandle({ document });
    const scene = new THREE.Scene();
    const adapter = createSceneAdapter({ scene });
    adapter.rebind(handle.store);

    // The adapter projects every demo node synchronously (renderer path
    // for selection, overlays, and picking).
    expect(adapter.nodeCount).toBe(Object.keys(document.nodes).length);
    const matrices: number[][] = [];
    for (const node of Object.values(document.nodes)) {
      const group = adapter.objectForNode(node.nodeId);
      if (group === undefined) throw new Error(`missing group ${node.nodeId}`);
      matrices.push([...group.matrix.elements]);
    }
    // Deterministic evaluation: a fresh adapter over the same store
    // produces bit-identical matrices.
    const secondAdapter = createSceneAdapter({ scene: new THREE.Scene() });
    secondAdapter.rebind(handle.store);
    for (const node of Object.values(document.nodes)) {
      const group = secondAdapter.objectForNode(node.nodeId);
      if (group === undefined) throw new Error(`missing group ${node.nodeId}`);
      expect([...group.matrix.elements]).toEqual(
        matrices[Object.values(document.nodes).indexOf(node)],
      );
    }
    // The base document state is untouched: same revision and hash.
    expect(handle.store.revision).toBe(0);
    expect(canonicalDocumentHash(handle.store.getDocument())).toBe(
      canonicalDocumentHash(document),
    );
    // The demo rig's authored pose projects through the canonical
    // transform math: the head sits on the torso, the arms hang at the
    // shoulders (column-major elements 12..14 = translation).
    const head = adapter.objectForNode(nodeId("node:rig:character:head"));
    expect(head?.matrix.elements.slice(12, 15)).toEqual([0, 3, 0]);
    const rightArm = adapter.objectForNode(
      nodeId("node:rig:character:right-arm"),
    );
    expect(rightArm?.matrix.elements.slice(12, 15)).toEqual([2, 2, 0]);
    const leftArm = adapter.objectForNode(
      nodeId("node:rig:character:left-arm"),
    );
    expect(leftArm?.matrix.elements.slice(12, 15)).toEqual([-2, 2, 0]);
    adapter.dispose();
    secondAdapter.dispose();
  });

  it("projects an animated definition-of-done pose deterministically without mutating the store (ticket #30)", () => {
    const demo = ANIMATED_DEMOS.find(
      (entry) => entry.kind === "simple-character",
    );
    if (demo === undefined) throw new Error("character demo missing");
    const { document, clip } = demo.create();
    // The renderer consumes the store's document, so install the animated
    // locals at the wave peak (t = 1) as the authored state through the
    // store's public commit path — the same path a future animation
    // integration uses to drive the viewport.
    const runtime = evaluateAnimationRuntime(document, clip, 1);
    const animated = JSON.parse(JSON.stringify(document)) as VoxelDocument;
    for (const [nodeId, transform] of runtime.local) {
      const node = animated.nodes[nodeId];
      if (node === undefined) continue;
      (node as { transform: typeof node.transform }).transform = {
        ...transform,
      };
    }
    const handle = createDocumentStoreHandle({ document: animated });
    const adapter = createSceneAdapter({ scene: new THREE.Scene() });
    adapter.rebind(handle.store);

    // The runtime world pass clamped the head turn (driven to 90 deg) at
    // the 60-deg neck limit; the adapter re-evaluates the same clamped
    // pose through its own constrained world path (column-major Ry).
    const head = adapter.objectForNode(nodeId("node:rig:character:head"));
    expect(head?.matrix.elements[0]).toBeCloseTo(Math.cos(Math.PI / 3), 6);
    expect(head?.matrix.elements[2]).toBeCloseTo(-Math.sin(Math.PI / 3), 6);

    // Deterministic evaluation: a fresh adapter over the same store
    // produces bit-identical matrices for every node.
    const secondAdapter = createSceneAdapter({ scene: new THREE.Scene() });
    secondAdapter.rebind(handle.store);
    for (const node of Object.values(animated.nodes)) {
      const first = adapter.objectForNode(node.nodeId);
      const second = secondAdapter.objectForNode(node.nodeId);
      expect(second?.matrix.elements).toEqual(first?.matrix.elements);
    }

    // The base store state is untouched: same revision and hash.
    expect(handle.store.revision).toBe(0);
    expect(canonicalDocumentHash(handle.store.getDocument())).toBe(
      canonicalDocumentHash(animated),
    );
    adapter.dispose();
    secondAdapter.dispose();
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
    const handle = createDocumentStoreHandle({
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

  it("eventually meshes every chunk when a project overflows maxPending", () => {
    // Issue #59 regression: projecting a sparse volume with more
    // allocated chunks than the scheduler's 256-slot pending set evicted
    // the overflow chunk permanently, leaving it invisible until a later
    // edit touched it. Eviction must defer, not drop: repeated flushes
    // install every chunk while the pending set stays bounded.
    const chunkCount = 257;
    // 13x13x2 = 338 candidate chunk slots; take the first 257. A 3D slab
    // keeps every axis well under the 2,048-voxel occupied-extent limit
    // (ADR-0009) while still overflowing the 256-slot pending set.
    const chunks: {
      coordinate: [number, number, number];
      values: Uint16Array;
    }[] = [];
    for (let z = 0; z < 2 && chunks.length < chunkCount; z += 1) {
      for (let y = 0; y < 13 && chunks.length < chunkCount; y += 1) {
        for (let x = 0; x < 13 && chunks.length < chunkCount; x += 1) {
          chunks.push({ coordinate: [x, y, z], values: boxChunkSeed() });
        }
      }
    }
    expect(chunks).toHaveLength(chunkCount);
    const document = createDocument({
      documentId: documentId("document:scene:overflow"),
      metadata: { title: "overflow fixture" },
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
        {
          volumeId: VOLUME,
          bounds: { min: [0, 0, 0], max: [13 * 16, 13 * 16, 2 * 16] },
        },
      ],
    });
    const handle = createDocumentStoreHandle({
      document,
      volumes: new Map([[VOLUME, chunks]]),
    });
    const scene = new THREE.Scene();
    const adapter = createSceneAdapter({ scene });
    adapter.rebind(handle.store);
    // Projection scheduled 257 chunks into a 256-slot pending set; the
    // overflow sits in the deferred dirty source.
    expect(adapter.diagnostics().pendingChunks).toBe(256);
    expect(adapter.diagnostics().deferredChunks).toBe(1);
    let flushes = 0;
    for (; flushes < 300; flushes += 1) {
      adapter.flush();
      const diagnostics = adapter.diagnostics();
      expect(diagnostics.pendingChunks).toBeLessThanOrEqual(256);
      if (
        diagnostics.pendingChunks === 0 &&
        diagnostics.inFlightMeshes === 0 &&
        diagnostics.uploadsThisFrame === 0
      ) {
        break;
      }
    }
    expect(flushes).toBeLessThan(300);
    expect(adapter.diagnostics().deferredChunks).toBe(0);
    expect(adapter.diagnostics().pendingChunks).toBe(0);
    expect(adapter.chunkMeshCount).toBe(chunkCount);
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
    const handle = createDocumentStoreHandle({
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

describe("scene adapter preview projections (plan S12.15, ticket #34)", () => {
  /** A second store standing in for a preview session overlay: the same
   * document and volume ids, with staged chunk geometry of its own. */
  function previewHarness(
    options: {
      readonly materialColor?: string;
    } = {},
  ): {
    readonly store: DocumentStore;
    readonly writeCapability: VoxelWriteCapability;
    readonly namespace: `preview:${string}`;
    commit(
      set: (volume: VoxelVolume, capability: VoxelWriteCapability) => void,
    ): void;
  } {
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
          color: options.materialColor ?? "#ff8800",
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
    // The staged overlay starts from a 2x2x2 box (staged geometry differs
    // from the live 4x4x4 box) and grows through preview commits.
    const values = new Uint16Array(4096);
    for (let z = 0; z < 2; z += 1) {
      for (let y = 0; y < 2; y += 1) {
        for (let x = 0; x < 2; x += 1) {
          values[x + y * 16 + z * 256] = 1;
        }
      }
    }
    const handle = createDocumentStoreHandle({
      document,
      volumes: new Map([[VOLUME, [{ coordinate: [0, 0, 0], values }]]]),
    });
    let serial = 0;
    return {
      store: handle.store,
      writeCapability: handle.writeCapability,
      namespace: "preview:document:scene:0001:0:0",
      commit(set) {
        const clone = JSON.parse(
          JSON.stringify(handle.store.getDocument()),
        ) as VoxelDocument & { revision: number };
        clone.revision = handle.store.revision + 1;
        const volume = handle.store.stageVolume(VOLUME);
        if (volume === undefined) throw new Error("missing staged volume");
        set(volume, handle.writeCapability);
        handle.store.commit(
          {
            document: clone,
            volumes: new Map([[VOLUME, volume]]),
            removedVolumes: [],
          },
          {
            revisionBefore: handle.store.revision,
            revisionAfter: clone.revision,
            transactionId: transactionId(
              `transaction:scene:preview:${String(serial)}`,
            ),
            source: "ai",
            commandIds: [],
            commandTypes: [],
            changedNodeIds: [],
            changedMaterialIds: [],
            changedAnimationIds: [],
            changedVolumes: [
              {
                volumeId: VOLUME,
                chunks: [{ coordinate: [0, 0, 0], revision: clone.revision }],
              },
            ],
          },
          handle.writeCapability,
        );
        serial += 1;
      },
    };
  }

  it("projects a preview overlay separately from the live projection", () => {
    const harness = createHarness();
    const preview = previewHarness();
    flushAll(harness.adapter);
    expect(harness.adapter.chunkMeshCount).toBe(1);

    const overlay = harness.adapter.projectPreview(
      preview.store,
      preview.namespace,
    );
    expect(harness.adapter.previewProjectionCount).toBe(1);
    expect(overlay.nodeCount).toBe(2);
    flushAll(harness.adapter);

    // The overlay owns a dedicated root group inside the scene; the live
    // projection is untouched.
    const rootGroup = harness.scene.getObjectByName(preview.namespace);
    if (rootGroup === undefined) throw new Error("missing preview root");
    const overlayMeshes = chunkMeshes(harness.scene).filter(
      (mesh) => rootGroup.getObjectById(mesh.id) !== undefined,
    );
    expect(overlayMeshes).toHaveLength(1);
    // Staged geometry: 2x2x2 box = 6*4 faces * 4 verts = 96.
    expect(overlayMeshes[0]?.geometry.getAttribute("position").count).toBe(96);
    // The live projection still shows the 4x4x4 box.
    expect(
      childMesh(harness.adapter).geometry.getAttribute("position").count,
    ).toBe(384);
    expect(harness.adapter.chunkMeshCount).toBe(1);
    expect(overlay.chunkMeshCount).toBe(1);
    harness.adapter.dispose();
  });

  it("updates only the overlay when the preview store commits", () => {
    const harness = createHarness();
    const preview = previewHarness();
    flushAll(harness.adapter);
    const overlay = harness.adapter.projectPreview(
      preview.store,
      preview.namespace,
    );
    flushAll(harness.adapter);
    const rootGroup = harness.scene.getObjectByName(preview.namespace);
    if (rootGroup === undefined) throw new Error("missing preview root");
    const overlayMeshBefore = chunkMeshes(harness.scene).filter(
      (mesh) => rootGroup.getObjectById(mesh.id) !== undefined,
    )[0];
    if (overlayMeshBefore === undefined)
      throw new Error("missing overlay mesh");

    preview.commit((volume, capability) => {
      volume.setVoxel([10, 10, 10], 1, capability);
    });
    flushAll(harness.adapter);

    const overlayMeshAfter = chunkMeshes(harness.scene).filter(
      (mesh) => rootGroup.getObjectById(mesh.id) !== undefined,
    )[0];
    if (overlayMeshAfter === undefined) throw new Error("missing overlay mesh");
    // 2x2x2 (96) + one voxel (24) = 120 verts.
    expect(overlayMeshAfter.geometry.getAttribute("position").count).toBe(120);
    // The live mesh still shows the untouched 4x4x4 box and the live
    // store revision never moved.
    expect(
      childMesh(harness.adapter).geometry.getAttribute("position").count,
    ).toBe(384);
    expect(harness.store.revision).toBe(0);
    expect(harness.adapter.chunkMeshCount).toBe(1);
    expect(overlay.chunkMeshCount).toBe(1);
    harness.adapter.dispose();
  });

  it("disposes only the overlay, leaving the live projection intact", () => {
    const harness = createHarness();
    const preview = previewHarness();
    flushAll(harness.adapter);
    const overlay = harness.adapter.projectPreview(
      preview.store,
      preview.namespace,
    );
    flushAll(harness.adapter);
    expect(harness.adapter.previewProjectionCount).toBe(1);
    const previewRoot = harness.scene.getObjectByName(preview.namespace);
    if (previewRoot === undefined) throw new Error("missing preview root");
    const geometry = chunkMeshes(harness.scene).filter(
      (mesh) => previewRoot.getObjectById(mesh.id) !== undefined,
    )[0]?.geometry;
    const dispose = vi.spyOn(geometry as THREE.BufferGeometry, "dispose");

    overlay.dispose();
    // Idempotent.
    overlay.dispose();

    expect(dispose).toHaveBeenCalled();
    expect(harness.adapter.previewProjectionCount).toBe(0);
    expect(harness.scene.getObjectByName(preview.namespace)).toBeUndefined();
    expect(harness.adapter.chunkMeshCount).toBe(1);
    expect(
      childMesh(harness.adapter).geometry.getAttribute("position").count,
    ).toBe(384);
    harness.adapter.dispose();
  });

  it("keeps staged material changes out of the live projection and disposes preview materials on discard (issue #60)", () => {
    const harness = createHarness();
    flushAll(harness.adapter);
    const liveMesh = childMesh(harness.adapter);
    const liveMaterial = liveMesh.material;
    if (!(liveMaterial instanceof THREE.MeshStandardMaterial)) {
      throw new Error("expected standard material");
    }
    expect(liveMaterial.color.getHexString()).toBe("ff8800");

    // The preview stages a blue version of the SAME material id; the live
    // store still owns the red record.
    const preview = previewHarness({ materialColor: "#0000ff" });
    const overlay = harness.adapter.projectPreview(
      preview.store,
      preview.namespace,
    );
    flushAll(harness.adapter);
    const previewRoot = harness.scene.getObjectByName(preview.namespace);
    if (previewRoot === undefined) throw new Error("missing preview root");
    const overlayMeshes = chunkMeshes(harness.scene).filter(
      (mesh) => previewRoot.getObjectById(mesh.id) !== undefined,
    );
    expect(overlayMeshes).toHaveLength(1);
    const previewMaterial = overlayMeshes[0]?.material;
    if (!(previewMaterial instanceof THREE.MeshStandardMaterial)) {
      throw new Error("expected standard material");
    }
    // The staged material is a distinct instance owned by the preview; the
    // live mesh keeps its own untouched instance and color.
    expect(previewMaterial).not.toBe(liveMaterial);
    expect(previewMaterial.color.getHexString()).toBe("0000ff");
    expect(liveMaterial.color.getHexString()).toBe("ff8800");

    // Discard: the preview overlay and its materials are disposed; the live
    // mesh retains its original material instance and properties.
    const previewMaterialDispose = vi.spyOn(previewMaterial, "dispose");
    overlay.dispose();
    expect(previewMaterialDispose).toHaveBeenCalled();
    expect(harness.adapter.previewProjectionCount).toBe(0);
    expect(childMesh(harness.adapter).material).toBe(liveMaterial);
    expect(liveMaterial.color.getHexString()).toBe("ff8800");
    harness.adapter.dispose();
  });

  it("rejects invalid or duplicate preview namespaces", () => {
    const harness = createHarness();
    const preview = previewHarness();
    expect(() => harness.adapter.projectPreview(preview.store, "live")).toThrow(
      /preview:/,
    );
    expect(() =>
      harness.adapter.projectPreview(
        preview.store,
        "staging" as unknown as `preview:${string}`,
      ),
    ).toThrow(/preview:/);
    const overlay = harness.adapter.projectPreview(
      preview.store,
      preview.namespace,
    );
    expect(() =>
      harness.adapter.projectPreview(preview.store, preview.namespace),
    ).toThrow(/already projected/);
    overlay.dispose();
    harness.adapter.dispose();
  });

  it("clears preview overlays on lifecycle replacement", () => {
    const harness = createHarness();
    const preview = previewHarness();
    flushAll(harness.adapter);
    const overlay = harness.adapter.projectPreview(
      preview.store,
      preview.namespace,
    );
    flushAll(harness.adapter);
    expect(harness.adapter.previewProjectionCount).toBe(1);

    harness.adapter.clear();
    expect(harness.adapter.previewProjectionCount).toBe(0);
    expect(harness.scene.getObjectByName(preview.namespace)).toBeUndefined();
    expect(harness.adapter.chunkMeshCount).toBe(0);
    overlay.dispose();
    harness.adapter.dispose();
  });
});
