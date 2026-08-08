import * as THREE from "three";
import type {
  DocumentCommitted,
  DocumentStoreRead,
} from "@voxel-maker/document";
import { transformToMatrix } from "@voxel-maker/math";
import type { SceneNode } from "@voxel-maker/model";
import { chunkKey, type VoxelVolumeReadView } from "@voxel-maker/voxel";
import type { MaterialId, NodeId, VolumeId } from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import { buildChunkMesh } from "./mesher.js";
import {
  createMaterialAdapter,
  type MaterialAdapter,
} from "./material-adapter.js";
import type { ChunkNamespace, ChunkSampler } from "./types.js";

/**
 * Renderer scene adapter (plan S6.3/S6.7, ticket #15): a disposable
 * projection of the authoritative document into a Three.js scene.
 *
 * - Stable node IDs map to `Object3D` groups carrying the canonical local
 *   matrix (`transformToMatrix`, ADR-0001 pivot semantics).
 * - Voxel volumes project as one face-culled mesh per allocated chunk,
 *   sampled through the volume's own read view so halo faces are culled
 *   across chunk boundaries.
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

/** Bookkeeping for one projected chunk mesh. */
/** Mesh type of every chunk projection (three generics are `any` by default). */
type ProjectedMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.Material | THREE.Material[]
>;

interface ChunkMeshEntry {
  readonly volumeId: VolumeId;
  readonly coordinate: Vec3i;
  readonly revision: number;
  readonly mesh: ProjectedMesh;
  readonly geometry: THREE.BufferGeometry;
  readonly parentGroup: THREE.Group;
}

export interface SceneAdapterOptions {
  /** Target scene; the adapter only adds/removes its own projections. */
  readonly scene: THREE.Scene;
  /** Namespace for DTO tags; defaults to the live document namespace. */
  readonly namespace?: ChunkNamespace;
}

export interface SceneAdapter {
  readonly scene: THREE.Scene;
  readonly namespace: ChunkNamespace;
  /** Number of projected node groups (diagnostics/tests). */
  readonly nodeCount: number;
  /** Number of projected chunk meshes (diagnostics/tests). */
  readonly chunkMeshCount: number;
  /**
   * Full dispose and rebind for lifecycle replacement: clears every
   * projection, subscribes to the fresh store's commits, and projects the
   * document from scratch.
   */
  rebind(store: DocumentStoreRead): void;
  /** Incremental projection of one committed transaction. */
  handleCommit(event: DocumentCommitted, store: DocumentStoreRead): void;
  /** Disposes every projection and unsubscribes; the adapter stays usable. */
  clear(): void;
  /** The projected group for a node id, or undefined when not projected. */
  objectForNode(nodeId: NodeId): THREE.Object3D | undefined;
  /** Disposes every projection and releases the material cache. */
  dispose(): void;
}

class SceneAdapterImpl implements SceneAdapter {
  readonly scene: THREE.Scene;
  readonly namespace: ChunkNamespace;
  readonly #materials: MaterialAdapter;
  readonly #nodeProjections = new Map<NodeId, NodeProjection>();
  readonly #chunkMeshes = new Map<VolumeId, Map<string, ChunkMeshEntry>>();
  readonly #volumeOwners = new Map<VolumeId, NodeId>();
  #store: DocumentStoreRead | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(options: SceneAdapterOptions) {
    this.scene = options.scene;
    this.namespace = options.namespace ?? "live";
    this.#materials = createMaterialAdapter();
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

    for (const volume of event.changedVolumes) {
      for (const chunk of volume.chunks) {
        this.#remeshChunk(volume.volumeId, chunk.coordinate, chunk.revision);
      }
    }
  }

  clear(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#store = undefined;
    for (const projection of this.#nodeProjections.values()) {
      this.#disposeProjection(projection);
    }
    this.#nodeProjections.clear();
    this.#chunkMeshes.clear();
    this.#volumeOwners.clear();
  }

  objectForNode(nodeId: NodeId): THREE.Object3D | undefined {
    return this.#nodeProjections.get(nodeId)?.group;
  }

  dispose(): void {
    this.clear();
    this.#materials.dispose();
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
        this.#disposeVolume(volumeId);
        this.#volumeOwners.delete(volumeId);
      }
    }
    for (const volumeId of desired) {
      if (!projection.volumes.has(volumeId)) {
        this.#volumeOwners.set(volumeId, node.nodeId);
        this.#projectVolume(volumeId, projection.group);
      }
    }
    projection.volumes = desired;
  }

  #projectVolume(volumeId: VolumeId, parentGroup: THREE.Group): void {
    const readView = this.#store?.getVolume(volumeId);
    if (readView === undefined) return;
    for (const coordinate of readView.chunkCoordinates()) {
      this.#buildChunkMesh(volumeId, coordinate, 0, parentGroup);
    }
  }

  #remeshChunk(volumeId: VolumeId, coordinate: Vec3i, revision: number): void {
    const volumeMeshes = this.#chunkMeshes.get(volumeId);
    const key = chunkKey(coordinate);
    const entry = volumeMeshes?.get(key);
    if (entry !== undefined) {
      // Dispose the superseded geometry, then rebuild from the committed
      // state; stale results never win because this is the main thread
      // reading authoritative state after commit.
      this.#disposeChunkMesh(entry);
    }
    const ownerId = this.#volumeOwners.get(volumeId);
    const parentGroup =
      ownerId === undefined
        ? undefined
        : this.#nodeProjections.get(ownerId)?.group;
    if (parentGroup !== undefined) {
      this.#buildChunkMesh(volumeId, coordinate, revision, parentGroup);
    }
  }

  #buildChunkMesh(
    volumeId: VolumeId,
    coordinate: Vec3i,
    revision: number,
    parentGroup: THREE.Group,
  ): void {
    const readView = this.#store?.getVolume(volumeId);
    if (readView === undefined) return;
    const values = readView.getChunk(coordinate);
    if (values === undefined || isEmptyChunk(values)) return;
    const geometry = buildChunkMesh(
      values,
      this.#createChunkSampler(readView, coordinate, values),
    );

    const bufferGeometry = new THREE.BufferGeometry();
    bufferGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(geometry.positions, 3),
    );
    bufferGeometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(geometry.normals, 3),
    );
    bufferGeometry.setIndex(new THREE.BufferAttribute(geometry.indices, 1));

    const materials = geometry.materialGroups.map((group) =>
      this.#materialForId(group.materialId),
    );
    const mesh = new THREE.Mesh(
      bufferGeometry,
      materials.length === 1 ? (materials[0] as THREE.Material) : materials,
    );
    mesh.name = `chunk:${volumeId}:${chunkKey(coordinate)}`;
    if (materials.length > 1) {
      bufferGeometry.groups = geometry.materialGroups.map((group, index) => ({
        start: group.start,
        count: group.count,
        materialIndex: index,
      }));
    }
    parentGroup.add(mesh);

    let volumeMeshes = this.#chunkMeshes.get(volumeId);
    if (volumeMeshes === undefined) {
      volumeMeshes = new Map();
      this.#chunkMeshes.set(volumeId, volumeMeshes);
    }
    volumeMeshes.set(chunkKey(coordinate), {
      volumeId,
      coordinate,
      revision,
      mesh,
      geometry: bufferGeometry,
      parentGroup,
    });
  }

  #createChunkSampler(
    readView: VoxelVolumeReadView,
    coordinate: Vec3i,
    values: Uint16Array,
  ): ChunkSampler {
    const [chunkX, chunkY, chunkZ] = coordinate;
    return (localX, localY, localZ) => {
      if (
        localX >= 0 &&
        localX < 16 &&
        localY >= 0 &&
        localY < 16 &&
        localZ >= 0 &&
        localZ < 16
      ) {
        return values[localX + localY * 16 + localZ * 256] as MaterialId;
      }
      return readView.getVoxel([
        chunkX * 16 + localX,
        chunkY * 16 + localY,
        chunkZ * 16 + localZ,
      ]);
    };
  }

  #materialForId(materialId: MaterialId): THREE.Material {
    const record = this.#store?.getDocument().materials[materialId];
    return record === undefined
      ? this.#materials.errorMaterial()
      : this.#materials.ensure(record);
  }

  #disposeNodeSubtree(nodeId: NodeId): void {
    const projection = this.#nodeProjections.get(nodeId);
    if (projection === undefined) return;
    // Children are removed with their parent: dispose every descendant
    // chunk mesh before dropping the whole subtree.
    const meshes: ProjectedMesh[] = [];
    projection.group.traverse((object) => {
      if (object instanceof THREE.Mesh) meshes.push(object as ProjectedMesh);
    });
    for (const mesh of meshes) {
      const entry = this.#entryForMesh(mesh);
      if (entry !== undefined) this.#disposeChunkMesh(entry);
    }
    for (const descendant of [...this.#nodeProjections.values()]) {
      if (descendant.group === projection.group) continue;
      if (projection.group.getObjectById(descendant.group.id) !== undefined) {
        for (const volumeId of descendant.volumes) {
          this.#volumeOwners.delete(volumeId);
        }
        this.#nodeProjections.delete(descendant.node.nodeId);
      }
    }
    this.#disposeProjection(projection);
    this.#nodeProjections.delete(nodeId);
  }

  #entryForMesh(mesh: ProjectedMesh): ChunkMeshEntry | undefined {
    for (const volumeMeshes of this.#chunkMeshes.values()) {
      for (const entry of volumeMeshes.values()) {
        if (entry.mesh === mesh) return entry;
      }
    }
    return undefined;
  }

  #disposeProjection(projection: NodeProjection): void {
    for (const child of [...projection.group.children]) {
      if (child instanceof THREE.Mesh) {
        const entry = this.#entryForMesh(child as ProjectedMesh);
        if (entry !== undefined) this.#disposeChunkMesh(entry);
      }
    }
    projection.group.removeFromParent();
  }

  #disposeVolume(volumeId: VolumeId): void {
    const volumeMeshes = this.#chunkMeshes.get(volumeId);
    if (volumeMeshes === undefined) return;
    for (const entry of [...volumeMeshes.values()]) {
      this.#disposeChunkMesh(entry);
    }
    this.#chunkMeshes.delete(volumeId);
  }

  #disposeChunkMesh(entry: ChunkMeshEntry): void {
    entry.mesh.removeFromParent();
    entry.geometry.dispose();
    const volumeMeshes = this.#chunkMeshes.get(entry.volumeId);
    volumeMeshes?.delete(chunkKey(entry.coordinate));
    if (volumeMeshes !== undefined && volumeMeshes.size === 0) {
      this.#chunkMeshes.delete(entry.volumeId);
    }
  }
}

function isEmptyChunk(values: Uint16Array): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if ((values[index] as number) !== 0) return false;
  }
  return true;
}

/** Creates a scene adapter projecting into `options.scene`. */
export function createSceneAdapter(options: SceneAdapterOptions): SceneAdapter {
  return new SceneAdapterImpl(options);
}
