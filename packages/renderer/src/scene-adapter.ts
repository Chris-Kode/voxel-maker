import * as THREE from "three";
import type {
  DocumentCommitted,
  DocumentStoreRead,
} from "@voxel-maker/document";
import { transformToMatrix } from "@voxel-maker/math";
import type { SceneNode } from "@voxel-maker/model";
import { chunkKey } from "@voxel-maker/voxel";
import type { MaterialId, NodeId, VolumeId } from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import { CHUNK_EDGE } from "./mesher.js";
import { createChunkHalo } from "./halo.js";
import {
  createMaterialAdapter,
  type MaterialAdapter,
} from "./material-adapter.js";
import {
  createChunkScheduler,
  type ChunkScheduleSpec,
  type ChunkScheduler,
} from "./chunk-scheduler.js";
import {
  createInProcessMeshingExecutor,
  createWorkerMeshingExecutor,
  type MeshingWorkerLike,
} from "./meshing-executors.js";
import { nodeWorldMatrices } from "./pick.js";
import type { ChunkMeshInput, ChunkMeshOutput } from "./types.js";

/**
 * Renderer scene adapter (plan S6.3/S6.7, ticket #23): a disposable
 * projection of the authoritative document into a Three.js scene with
 * incremental, budgeted, asynchronous chunk meshing.
 *
 * - Stable node IDs map to `Object3D` groups carrying the canonical local
 *   matrix (`transformToMatrix`, ADR-0001 pivot semantics) — node
 *   projection stays synchronous so selection, overlays, and picking
 *   always have a hierarchy to attach to.
 * - Chunk meshes are produced by the dirty-chunk scheduler (S6.8) through
 *   a meshing pool (S6.6): every job carries copied immutable
 *   chunk-and-halo data tagged `{namespace, volume, coordinate,
 *   revision}`, results are validated twice (pool latest-wins, then the
 *   adapter's own latest-revision map), visible chunks dispatch first,
 *   and per-frame dispatch/upload budgets bound main-thread work. The
 *   old geometry stays visible until its replacement lands, so edits
 *   never flash or blank the viewport.
 * - Ordinary commits are incremental (`changedNodeIds`,
 *   `changedMaterialIds`, `changedVolumes`); lifecycle replacement
 *   (`document-opened` / `document-replaced` / `document-closed`) fully
 *   disposes and rebinds through `rebind`/`clear`.
 *
 * The adapter never issues commands, never mutates semantic state, and
 * never lets renderer state become authoritative (ADR-0002/0005). All
 * GPU-adjacent resources are created lazily and disposed exactly once.
 */

/** Bookkeeping for one projected node. */
interface NodeProjection {
  readonly group: THREE.Group;
  node: SceneNode;
  /** Volume ids currently projected under this node's group. */
  volumes: ReadonlySet<VolumeId>;
}

/** Mesh type of every chunk projection (three generics are `any` by default). */
type ProjectedMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.Material | THREE.Material[]
>;

/** Bookkeeping for one installed chunk mesh. */
interface ChunkMeshEntry {
  readonly volumeId: VolumeId;
  readonly coordinate: Vec3i;
  readonly revision: number;
  readonly mesh: ProjectedMesh;
  readonly geometry: THREE.BufferGeometry;
  readonly parentGroup: THREE.Group;
  /** Estimated GPU buffer bytes (positions + normals + indices). */
  readonly bytes: number;
  /** Estimated draw calls for this mesh (one per material group). */
  readonly drawCalls: number;
  readonly triangles: number;
}

/** Live renderer diagnostics (plan S6.14, ticket #23). */
export interface RendererDiagnostics {
  /** Dirty chunks waiting to be dispatched. */
  readonly pendingChunks: number;
  /** Mesh jobs currently computing. */
  readonly inFlightMeshes: number;
  /** Chunk meshes currently installed in the scene. */
  readonly installedChunks: number;
  /** Total triangles across installed chunk meshes. */
  readonly triangles: number;
  /** Estimated draw calls of installed chunk meshes. */
  readonly drawCallEstimate: number;
  /** Estimated GPU buffer bytes of installed chunk meshes. */
  readonly meshBytes: number;
  /** Wall time of the most recent completed mesh, in milliseconds. */
  readonly lastMeshMs: number;
  /** Mean mesh time over completed meshes, in milliseconds. */
  readonly averageMeshMs: number;
  /** Late results dropped because a newer job superseded them. */
  readonly staleDropped: number;
  /** Jobs cancelled (superseded, deleted, or disposed). */
  readonly cancelled: number;
  /** Jobs that exhausted their retries. */
  readonly failed: number;
  /** Installs performed by the most recent flush. */
  readonly uploadsThisFrame: number;
}

export interface SceneAdapterOptions {
  /** Target scene; the adapter only adds/removes its own projections. */
  readonly scene: THREE.Scene;
  /**
   * Builds the Web Worker that computes meshes off the main thread. When
   * omitted, meshing runs in-process (headless and tests use the same
   * lifecycle with a synchronous executor).
   */
  readonly createWorker?: () => MeshingWorkerLike;
  /** Bounded scheduler pending set (default 256). */
  readonly maxPending?: number;
  /** Pending jobs dispatched per animation frame (default 4). */
  readonly maxDispatchesPerFrame?: number;
  /** Completed meshes installed per animation frame (default 4). */
  readonly maxUploadsPerFrame?: number;
  /** Maximum simultaneously executing mesh jobs (default 2). */
  readonly maxConcurrent?: number;
  /** Mesh retries before a chunk is reported failed (default 2). */
  readonly maxRetries?: number;
}

export interface SceneAdapter {
  readonly scene: THREE.Scene;
  /** Number of projected node groups (diagnostics/tests). */
  readonly nodeCount: number;
  /** Number of projected chunk meshes (diagnostics/tests). */
  readonly chunkMeshCount: number;
  /**
   * Full dispose and rebind for lifecycle replacement: clears every
   * projection, subscribes to the fresh store's commits, and schedules
   * the document's chunks for meshing.
   */
  rebind(store: DocumentStoreRead): void;
  /** Incremental projection of one committed transaction. */
  handleCommit(event: DocumentCommitted, store: DocumentStoreRead): void;
  /**
   * Per-frame step: dispatch and install meshes within the frame budgets,
   * visible chunks first. The camera (when provided) drives visibility
   * priority; call it from the render loop before rendering.
   */
  flush(camera?: THREE.Camera): void;
  /** Live diagnostics (plan S6.14): queues, mesh time, draw calls,
   * triangles, and memory estimates. */
  diagnostics(): RendererDiagnostics;
  /** Disposes every projection and unsubscribes; the adapter stays usable. */
  clear(): void;
  /** The projected group for a node id, or undefined when not projected. */
  objectForNode(nodeId: NodeId): THREE.Object3D | undefined;
  /** Disposes every projection and releases the material cache. */
  dispose(): void;
}

class SceneAdapterImpl implements SceneAdapter {
  readonly scene: THREE.Scene;
  readonly #materials: MaterialAdapter;
  readonly #scheduler: ChunkScheduler;
  readonly #nodeProjections = new Map<NodeId, NodeProjection>();
  readonly #chunkMeshes = new Map<VolumeId, Map<string, ChunkMeshEntry>>();
  readonly #volumeOwners = new Map<VolumeId, NodeId>();
  /** Authoritative latest revision per chunk (install verification). */
  readonly #latestRevision = new Map<VolumeId, Map<string, number>>();
  /** Cached node world matrix per volume (frustum priority). */
  readonly #volumeWorldMatrices = new Map<VolumeId, THREE.Matrix4>();
  #store: DocumentStoreRead | undefined;
  #unsubscribe: (() => void) | undefined;
  #camera: THREE.Camera | undefined;
  #installedBytes = 0;
  #installedDrawCalls = 0;
  #installedTriangles = 0;

  constructor(options: SceneAdapterOptions) {
    this.scene = options.scene;
    this.#materials = createMaterialAdapter();
    const executor =
      options.createWorker === undefined
        ? createInProcessMeshingExecutor()
        : createWorkerMeshingExecutor(options.createWorker());
    this.#scheduler = createChunkScheduler({
      executor,
      resolve: (spec) => this.#resolveChunkData(spec),
      install: (result) => {
        this.#installChunkMesh(result);
      },
      onFailure: () => {
        // The chunk stays unmeshed; the previous geometry (if any) stays
        // visible, and the pool diagnostics count the failure.
      },
      priorityFor: (spec) => this.#priorityFor(spec),
      ...(options.maxPending === undefined
        ? {}
        : { maxPending: options.maxPending }),
      ...(options.maxDispatchesPerFrame === undefined
        ? {}
        : { maxDispatchesPerFrame: options.maxDispatchesPerFrame }),
      ...(options.maxUploadsPerFrame === undefined
        ? {}
        : { maxUploadsPerFrame: options.maxUploadsPerFrame }),
      ...(options.maxConcurrent === undefined
        ? {}
        : { maxConcurrent: options.maxConcurrent }),
      ...(options.maxRetries === undefined
        ? {}
        : { maxRetries: options.maxRetries }),
    });
  }

  get nodeCount(): number {
    return this.#nodeProjections.size;
  }

  get chunkMeshCount(): number {
    let count = 0;
    for (const chunks of this.#chunkMeshes.values()) count += chunks.size;
    return count;
  }

  rebind(store: DocumentStoreRead): void {
    this.clear();
    this.#store = store;
    this.#unsubscribe = store.subscribe((event) => {
      this.handleCommit(event, store);
    });
    const document = store.getDocument();
    for (const material of Object.values(document.materials)) {
      this.#materials.ensure(material);
    }
    for (const node of Object.values(document.nodes)) {
      this.#ensureNodeProjection(node);
    }
    this.#attachHierarchy();
    for (const node of Object.values(document.nodes)) {
      this.#syncNodeVolumes(node);
    }
    this.#refreshVolumeWorldMatrices();
    // `#syncNodeVolumes` above already scheduled every allocated chunk of
    // every projected volume (revision 0); the scheduler dispatches
    // visible chunks first and installs them within the frame budget.
  }

  handleCommit(event: DocumentCommitted, store: DocumentStoreRead): void {
    if (this.#store === undefined || this.#store !== store) return;
    const document = store.getDocument();

    for (const materialId of event.changedMaterialIds) {
      const record = document.materials[materialId];
      if (record === undefined) {
        this.#materials.remove(materialId);
      } else {
        this.#materials.ensure(record);
      }
    }

    for (const nodeId of event.changedNodeIds) {
      const node = document.nodes[nodeId];
      if (node === undefined) {
        this.#disposeNodeSubtree(nodeId);
      } else {
        this.#ensureNodeProjection(node);
      }
    }
    this.#attachHierarchy();
    for (const nodeId of event.changedNodeIds) {
      const node = document.nodes[nodeId];
      if (node !== undefined) this.#syncNodeVolumes(node);
    }
    this.#refreshVolumeWorldMatrices();

    for (const volume of event.changedVolumes) {
      const readView = store.getVolume(volume.volumeId);
      for (const chunk of volume.chunks) {
        const key = chunkKey(chunk.coordinate);
        let revisions = this.#latestRevision.get(volume.volumeId);
        if (revisions === undefined) {
          revisions = new Map();
          this.#latestRevision.set(volume.volumeId, revisions);
        }
        revisions.set(key, chunk.revision);
        if (readView?.getChunk(chunk.coordinate) === undefined) {
          // The chunk was emptied or removed: dispose its mesh now (no
          // worker round-trip) and cancel any pending job for it.
          this.#disposeChunk(volume.volumeId, chunk.coordinate);
          this.#scheduler.cancelChunk({
            namespace: "live",
            volumeId: volume.volumeId,
            coordinate: chunk.coordinate,
            revision: chunk.revision,
          });
        } else {
          this.#scheduleChunk(
            volume.volumeId,
            chunk.coordinate,
            chunk.revision,
          );
        }
      }
    }
  }

  flush(camera?: THREE.Camera): void {
    if (camera !== undefined) this.#camera = camera;
    this.#scheduler.flush();
  }

  diagnostics(): RendererDiagnostics {
    const scheduler = this.#scheduler.diagnostics();
    return {
      pendingChunks: scheduler.pending,
      inFlightMeshes: scheduler.inFlight,
      installedChunks: this.chunkMeshCount,
      triangles: this.#installedTriangles,
      drawCallEstimate: this.#installedDrawCalls,
      meshBytes: this.#installedBytes,
      lastMeshMs: scheduler.pool.lastMeshMs,
      averageMeshMs: scheduler.pool.averageMeshMs,
      staleDropped: scheduler.pool.staleDropped,
      cancelled: scheduler.pool.cancelled,
      failed: scheduler.pool.failed,
      uploadsThisFrame: scheduler.uploadsThisFrame,
    };
  }

  clear(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#store = undefined;
    this.#camera = undefined;
    this.#scheduler.cancelAll();
    for (const volumeId of [...this.#volumeOwners.keys()]) {
      this.#disposeChunk(volumeId, undefined);
    }
    for (const projection of this.#nodeProjections.values()) {
      projection.group.removeFromParent();
    }
    this.#nodeProjections.clear();
    this.#chunkMeshes.clear();
    this.#volumeOwners.clear();
    this.#latestRevision.clear();
    this.#volumeWorldMatrices.clear();
    this.#installedBytes = 0;
    this.#installedDrawCalls = 0;
    this.#installedTriangles = 0;
    // Lifecycle replacement fully releases material resources too (S6.7):
    // the cache is recreated lazily by the next rebind.
    this.#materials.dispose();
  }

  objectForNode(nodeId: NodeId): THREE.Object3D | undefined {
    return this.#nodeProjections.get(nodeId)?.group;
  }

  dispose(): void {
    this.clear();
    this.#scheduler.dispose();
    this.#materials.dispose();
  }

  /** Copies the current chunk data for one scheduled chunk (dispatch time). */
  #resolveChunkData(spec: ChunkScheduleSpec): ChunkMeshInput | undefined {
    const readView = this.#store?.getVolume(spec.volumeId);
    if (readView === undefined) return undefined;
    const values = readView.getChunk(spec.coordinate);
    if (values === undefined) return undefined;
    return {
      namespace: spec.namespace,
      volumeId: spec.volumeId,
      coordinate: spec.coordinate,
      revision: spec.revision,
      values,
      halo: createChunkHalo(readView, spec.coordinate),
    };
  }

  /**
   * Visibility priority: 0 when the chunk's world box intersects the
   * camera frustum, 1 otherwise. The frustum is rebuilt only when the
   * camera changes; per-chunk work is a single box transform + test.
   */
  #priorityFor(spec: ChunkScheduleSpec): number {
    const camera = this.#camera;
    const worldMatrix = this.#volumeWorldMatrices.get(spec.volumeId);
    if (camera === undefined || worldMatrix === undefined) return 1;
    if (this.#frustumCamera !== camera) {
      camera.updateMatrixWorld(true);
      this.#viewProjection.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      this.#frustum.setFromProjectionMatrix(this.#viewProjection);
      this.#frustumCamera = camera;
    }
    const minX = spec.coordinate[0] * CHUNK_EDGE;
    const minY = spec.coordinate[1] * CHUNK_EDGE;
    const minZ = spec.coordinate[2] * CHUNK_EDGE;
    this.#chunkBox.min.set(minX, minY, minZ);
    this.#chunkBox.max.set(
      minX + CHUNK_EDGE,
      minY + CHUNK_EDGE,
      minZ + CHUNK_EDGE,
    );
    this.#chunkBox.applyMatrix4(worldMatrix);
    return this.#frustum.intersectsBox(this.#chunkBox) ? 0 : 1;
  }

  readonly #frustum = new THREE.Frustum();
  #frustumCamera: THREE.Camera | undefined;
  readonly #viewProjection = new THREE.Matrix4();
  readonly #chunkBox = new THREE.Box3();

  #scheduleChunk(
    volumeId: VolumeId,
    coordinate: Vec3i,
    revision: number,
  ): void {
    // Record the authoritative latest revision for install verification
    // (both the rebind path and the commit path route through here).
    let revisions = this.#latestRevision.get(volumeId);
    if (revisions === undefined) {
      revisions = new Map();
      this.#latestRevision.set(volumeId, revisions);
    }
    revisions.set(chunkKey(coordinate), revision);
    this.#scheduler.schedule({
      namespace: "live",
      volumeId,
      coordinate,
      revision,
    });
  }

  /** Installs one validated fresh mesh; superseded geometry is disposed. */
  #installChunkMesh(result: ChunkMeshOutput): void {
    // Preview namespaces never touch the live scene (explicit behavior:
    // live and preview results are isolated by namespace).
    if (result.namespace !== "live") return;
    const revisions = this.#latestRevision.get(result.volumeId);
    const latest = revisions?.get(chunkKey(result.coordinate));
    // Only a result matching the latest namespace, volume, coordinate,
    // and revision may update the scene; anything else is stale.
    if (latest !== result.revision) return;
    const readView = this.#store?.getVolume(result.volumeId);
    if (
      readView === undefined ||
      readView.getChunk(result.coordinate) === undefined
    ) {
      // The chunk vanished between dispatch and install.
      return;
    }

    // Dispose the superseded geometry exactly once, then install.
    this.#disposeChunk(result.volumeId, result.coordinate);

    if (result.voxelCount === 0) return;

    const ownerId = this.#volumeOwners.get(result.volumeId);
    const parentGroup =
      ownerId === undefined
        ? undefined
        : this.#nodeProjections.get(ownerId)?.group;
    if (parentGroup === undefined) return;

    const bufferGeometry = new THREE.BufferGeometry();
    bufferGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(result.positions, 3),
    );
    bufferGeometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(result.normals, 3),
    );
    bufferGeometry.setIndex(new THREE.BufferAttribute(result.indices, 1));

    const materials = result.materialGroups.map((group) =>
      this.#materialForId(group.materialId),
    );
    const mesh = new THREE.Mesh(
      bufferGeometry,
      materials.length === 1 ? (materials[0] as THREE.Material) : materials,
    );
    mesh.name = `chunk:${result.volumeId}:${chunkKey(result.coordinate)}`;
    if (materials.length > 1) {
      bufferGeometry.groups = result.materialGroups.map((group, index) => ({
        start: group.start,
        count: group.count,
        materialIndex: index,
      }));
    }
    parentGroup.add(mesh);

    let volumeMeshes = this.#chunkMeshes.get(result.volumeId);
    if (volumeMeshes === undefined) {
      volumeMeshes = new Map();
      this.#chunkMeshes.set(result.volumeId, volumeMeshes);
    }
    const groups = result.materialGroups.length;
    const bytes =
      result.positions.byteLength +
      result.normals.byteLength +
      result.indices.byteLength;
    const triangles = result.indices.length / 3;
    volumeMeshes.set(chunkKey(result.coordinate), {
      volumeId: result.volumeId,
      coordinate: result.coordinate,
      revision: result.revision,
      mesh,
      geometry: bufferGeometry,
      parentGroup,
      bytes,
      drawCalls: Math.max(1, groups),
      triangles,
    });
    this.#installedBytes += bytes;
    this.#installedDrawCalls += Math.max(1, groups);
    this.#installedTriangles += triangles;
  }

  #materialForId(materialId: MaterialId): THREE.Material {
    const record = this.#store?.getDocument().materials[materialId];
    return record === undefined
      ? this.#materials.errorMaterial()
      : this.#materials.ensure(record);
  }

  #ensureNodeProjection(node: SceneNode): void {
    const existing = this.#nodeProjections.get(node.nodeId);
    if (existing === undefined) {
      const group = new THREE.Group();
      group.name = node.name ?? node.nodeId;
      this.#applyNodeMatrix(group, node);
      this.#nodeProjections.set(node.nodeId, {
        group,
        node,
        volumes: new Set(),
      });
      return;
    }
    existing.node = node;
    if (existing.group.name !== (node.name ?? node.nodeId)) {
      existing.group.name = node.name ?? node.nodeId;
    }
    this.#applyNodeMatrix(existing.group, node);
  }

  #applyNodeMatrix(group: THREE.Group, node: SceneNode): void {
    // The canonical local matrix already folds in the pivot (ADR-0001);
    // Three.js recomposition would drift, so matrices are explicit. The
    // math package stores row-major arrays; THREE.Matrix4 is column-major,
    // so `fromArray` yields the transpose and must be flipped back.
    group.matrixAutoUpdate = false;
    group.matrix.fromArray(transformToMatrix(node.transform)).transpose();
  }

  #attachHierarchy(): void {
    for (const projection of this.#nodeProjections.values()) {
      const node = projection.node;
      const desiredParent =
        node.parentId === null
          ? undefined
          : this.#nodeProjections.get(node.parentId)?.group;
      const currentParent = projection.group.parent;
      if (currentParent !== (desiredParent ?? this.scene)) {
        if (currentParent !== null) projection.group.removeFromParent();
        (desiredParent ?? this.scene).add(projection.group);
      }
    }
  }

  #syncNodeVolumes(node: SceneNode): void {
    const projection = this.#nodeProjections.get(node.nodeId);
    if (projection === undefined) return;
    const desired = new Set<VolumeId>();
    for (const component of node.components) {
      if (component.kind === "voxel") desired.add(component.volumeId);
    }
    for (const volumeId of projection.volumes) {
      if (!desired.has(volumeId)) {
        this.#disposeChunk(volumeId, undefined);
        this.#scheduler.cancelVolume(volumeId);
        this.#volumeOwners.delete(volumeId);
      }
    }
    for (const volumeId of desired) {
      if (!projection.volumes.has(volumeId)) {
        this.#volumeOwners.set(volumeId, node.nodeId);
        this.#projectVolume(volumeId);
      }
    }
    projection.volumes = desired;
  }

  #projectVolume(volumeId: VolumeId): void {
    const readView = this.#store?.getVolume(volumeId);
    if (readView === undefined) return;
    for (const coordinate of readView.chunkCoordinates()) {
      this.#scheduleChunk(volumeId, coordinate, 0);
    }
  }

  #disposeNodeSubtree(nodeId: NodeId): void {
    const projection = this.#nodeProjections.get(nodeId);
    if (projection === undefined) return;
    // Children are removed with their parent: every volume owned by the
    // subtree is disposed and cancelled (volumes belong to exactly one
    // node, so volume-scoped disposal covers every descendant mesh).
    const subtreeVolumes = new Set<VolumeId>();
    for (const volumeId of projection.volumes) subtreeVolumes.add(volumeId);
    for (const descendant of [...this.#nodeProjections.values()]) {
      if (descendant.group === projection.group) continue;
      if (projection.group.getObjectById(descendant.group.id) !== undefined) {
        for (const volumeId of descendant.volumes) {
          subtreeVolumes.add(volumeId);
        }
        this.#nodeProjections.delete(descendant.node.nodeId);
      }
    }
    for (const volumeId of subtreeVolumes) {
      this.#disposeChunk(volumeId, undefined);
      this.#scheduler.cancelVolume(volumeId);
      this.#volumeOwners.delete(volumeId);
    }
    projection.group.removeFromParent();
    this.#nodeProjections.delete(nodeId);
  }

  /**
   * Disposes one chunk's mesh (all coordinates when `coordinate` is
   * undefined) and subtracts its diagnostics. The latest-revision entry
   * is pruned with the mesh so per-chunk bookkeeping cannot grow with
   * edit history.
   */
  #disposeChunk(volumeId: VolumeId, coordinate: Vec3i | undefined): void {
    const volumeMeshes = this.#chunkMeshes.get(volumeId);
    const revisions = this.#latestRevision.get(volumeId);
    if (coordinate === undefined) {
      if (volumeMeshes !== undefined) {
        for (const entry of [...volumeMeshes.values()]) {
          this.#disposeChunkMesh(entry);
        }
        this.#chunkMeshes.delete(volumeId);
      }
      this.#latestRevision.delete(volumeId);
      return;
    }
    const entry = volumeMeshes?.get(chunkKey(coordinate));
    if (entry !== undefined) this.#disposeChunkMesh(entry);
    revisions?.delete(chunkKey(coordinate));
    if (revisions !== undefined && revisions.size === 0) {
      this.#latestRevision.delete(volumeId);
    }
  }

  #disposeChunkMesh(entry: ChunkMeshEntry): void {
    entry.mesh.removeFromParent();
    entry.geometry.dispose();
    this.#installedBytes -= entry.bytes;
    this.#installedDrawCalls -= entry.drawCalls;
    this.#installedTriangles -= entry.triangles;
    const volumeMeshes = this.#chunkMeshes.get(entry.volumeId);
    volumeMeshes?.delete(chunkKey(entry.coordinate));
    if (volumeMeshes !== undefined && volumeMeshes.size === 0) {
      this.#chunkMeshes.delete(entry.volumeId);
    }
  }

  /** Refreshes the cached world matrix of every projected volume. */
  #refreshVolumeWorldMatrices(): void {
    this.#volumeWorldMatrices.clear();
    if (this.#store === undefined) return;
    const world = nodeWorldMatrices(this.#store);
    for (const [volumeId, ownerId] of this.#volumeOwners) {
      const matrix = world.get(ownerId);
      if (matrix === undefined) continue;
      const threeMatrix = new THREE.Matrix4();
      threeMatrix.fromArray(matrix).transpose();
      this.#volumeWorldMatrices.set(volumeId, threeMatrix);
    }
  }
}

/** Creates a scene adapter projecting into `options.scene`. */
export function createSceneAdapter(options: SceneAdapterOptions): SceneAdapter {
  return new SceneAdapterImpl(options);
}
