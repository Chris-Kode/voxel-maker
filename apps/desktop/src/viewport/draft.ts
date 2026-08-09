import * as THREE from "three";
import {
  nodesReferencingVolume,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import type { EditorStore } from "@voxel-maker/editor";
import type { NodeId, VolumeId } from "@voxel-maker/shared";

/**
 * Transient stroke preview projection (plan S7.3/S7.5, ticket #17).
 *
 * The pencil/erase tools keep their in-progress voxel set in the runtime
 * `EditorStore` draft; this module projects it as a semi-transparent
 * instanced box mesh under the owning node's group, in volume-local
 * coordinates exactly like the chunk meshes. The preview is purely
 * cosmetic: it never reads command state, never mutates the scene
 * projection of committed voxels, and is removed on commit, cancel, and
 * lifecycle replacement (a "preview" is never authoritative).
 */

export interface DraftOverlayOptions {
  readonly scene: THREE.Scene;
  readonly editor: EditorStore;
  /** Resolves the authoritative read surface (undefined when closed). */
  readonly getStore: () => DocumentStoreRead | undefined;
  /** Resolves the projected group for a node id (renderer projection). */
  readonly objectForNode: (nodeId: NodeId) => THREE.Object3D | undefined;
}

export interface DraftOverlay {
  /** Number of voxels currently previewed (diagnostics/tests). */
  readonly voxelCount: number;
  /** The projected preview mesh, or undefined when nothing is shown. */
  readonly mesh: THREE.InstancedMesh | undefined;
  dispose(): void;
}

/** Preview material colors; the pencil uses the active material's color. */
const ERASE_COLOR = 0xff3b30;
const FALLBACK_COLOR = 0xff8800;

class DraftOverlayImpl implements DraftOverlay {
  readonly #editor: EditorStore;
  readonly #getStore: () => DocumentStoreRead | undefined;
  readonly #objectForNode: (nodeId: NodeId) => THREE.Object3D | undefined;
  readonly #geometry = new THREE.BoxGeometry(1, 1, 1);
  readonly #material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  readonly #dummy = new THREE.Object3D();
  #mesh: THREE.InstancedMesh | undefined;
  /** Instance capacity of the current mesh (fixed at construction). */
  #capacity = 0;
  #voxelCount = 0;
  #unsubscribe: (() => void) | undefined;

  constructor(options: DraftOverlayOptions) {
    this.#editor = options.editor;
    this.#getStore = options.getStore;
    this.#objectForNode = options.objectForNode;
    this.#unsubscribe = this.#editor.subscribe(() => {
      this.#refresh();
    });
  }

  get voxelCount(): number {
    return this.#voxelCount;
  }

  get mesh(): THREE.InstancedMesh | undefined {
    return this.#mesh;
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#removeMesh();
    this.#geometry.dispose();
    this.#material.dispose();
  }

  #refresh(): void {
    const draft = this.#editor.draft;
    const store = this.#getStore();
    if (
      draft === undefined ||
      store === undefined ||
      draft.voxels.length === 0
    ) {
      this.#removeMesh();
      return;
    }
    const owner = this.#volumeOwner(store, draft.volumeId);
    const parent = owner === undefined ? undefined : this.#objectForNode(owner);
    if (parent === undefined) {
      // The owning node is not projected (or not open): nothing to show.
      this.#removeMesh();
      return;
    }
    if (this.#mesh === undefined || draft.voxels.length > this.#capacity) {
      // Instance capacity is fixed at construction: a stroke that grows
      // beyond the current capacity needs a fresh mesh, otherwise the
      // extra instance matrices would be silently dropped. Capacity
      // doubles so a long stroke rebuilds the mesh logarithmically
      // often instead of once per pointer move.
      const previousCapacity = this.#capacity;
      this.#removeMesh();
      this.#capacity = Math.max(draft.voxels.length, previousCapacity * 2);
      this.#mesh = new THREE.InstancedMesh(
        this.#geometry,
        this.#material,
        this.#capacity,
      );
      this.#mesh.renderOrder = 1;
      this.#mesh.frustumCulled = false;
    }
    if (this.#mesh.parent !== parent) {
      this.#mesh.parent?.remove(this.#mesh);
      parent.add(this.#mesh);
    }
    this.#mesh.count = draft.voxels.length;
    const color =
      draft.material === undefined
        ? ERASE_COLOR
        : (store.getDocument().materials[draft.material]?.color ??
          FALLBACK_COLOR);
    this.#material.color.set(color);
    for (let index = 0; index < draft.voxels.length; index += 1) {
      const voxel = draft.voxels[index];
      if (voxel === undefined) continue;
      this.#dummy.position.set(voxel[0] + 0.5, voxel[1] + 0.5, voxel[2] + 0.5);
      this.#dummy.updateMatrix();
      this.#mesh.setMatrixAt(index, this.#dummy.matrix);
    }
    this.#mesh.instanceMatrix.needsUpdate = true;
    this.#voxelCount = draft.voxels.length;
  }

  #removeMesh(): void {
    if (this.#mesh !== undefined) {
      this.#mesh.parent?.remove(this.#mesh);
      this.#mesh = undefined;
    }
    this.#capacity = 0;
    this.#voxelCount = 0;
  }

  #volumeOwner(
    store: DocumentStoreRead,
    volumeId: VolumeId,
  ): NodeId | undefined {
    return nodesReferencingVolume(store.getDocument(), volumeId)[0];
  }
}

/** Creates the transient draft preview overlay for one composition. */
export function createDraftOverlay(options: DraftOverlayOptions): DraftOverlay {
  return new DraftOverlayImpl(options);
}
