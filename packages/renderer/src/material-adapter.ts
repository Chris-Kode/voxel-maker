import * as THREE from "three";
import type { MaterialId } from "@voxel-maker/shared";
import type { MaterialRecord } from "@voxel-maker/model";

/**
 * Material renderer adapter (plan S6.9): maps canonical material records to
 * shared, disposable `MeshStandardMaterial` resources. Records update in
 * place so every mesh referencing a material refreshes together; missing or
 * deleted records resolve to a visibly distinct fallback error material.
 * The adapter never persists anything — materials are a runtime projection.
 */
export interface MaterialAdapter {
  /**
   * Returns the shared material for a record, creating or updating it.
   * Callers pass the current document record; the adapter mutates the
   * existing instance in place.
   */
  ensure(record: MaterialRecord): THREE.Material;
  /** Disposes the cached material for an id (deleted records). */
  remove(materialId: MaterialId): void;
  /** Fallback for a material id with no current document record. */
  errorMaterial(): THREE.Material;
  /** Disposes every cached material and the fallback. */
  dispose(): void;
  /** Number of cached materials (diagnostics/tests). */
  readonly size: number;
}

/** Fallback color: a highly visible magenta that cannot be canonical. */
const ERROR_COLOR = 0xff00ff;

export function createMaterialAdapter(): MaterialAdapter {
  const cache = new Map<MaterialId, THREE.MeshStandardMaterial>();
  let error: THREE.MeshStandardMaterial | undefined;

  return {
    ensure(record) {
      let material = cache.get(record.materialId);
      if (material === undefined) {
        material = new THREE.MeshStandardMaterial();
        material.name = `material:${String(record.materialId)}`;
        cache.set(record.materialId, material);
      }
      material.color.set(record.color);
      material.opacity = record.opacity;
      material.transparent = record.opacity < 1;
      material.roughness = record.roughness;
      material.metalness = record.metallic;
      material.emissive.set(record.color).multiplyScalar(record.emissive);
      material.needsUpdate = true;
      return material;
    },
    remove(materialId) {
      const material = cache.get(materialId);
      if (material !== undefined) {
        material.dispose();
        cache.delete(materialId);
      }
    },
    errorMaterial() {
      if (error === undefined) {
        error = new THREE.MeshStandardMaterial({
          color: ERROR_COLOR,
          emissive: ERROR_COLOR,
        });
        error.name = "material:error";
      }
      return error;
    },
    dispose() {
      for (const material of cache.values()) material.dispose();
      cache.clear();
      error?.dispose();
      error = undefined;
    },
    get size() {
      return cache.size;
    },
  };
}
