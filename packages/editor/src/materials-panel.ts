import type { MaterialId } from "@voxel-maker/shared";
import {
  canonicalColor,
  type Color,
  type MaterialRecord,
} from "@voxel-maker/model";
import type { DocumentStoreRead } from "@voxel-maker/document";
import type {
  CreateMaterialPayload,
  UpdateMaterialPayload,
} from "@voxel-maker/commands";

/**
 * Headless material panel model (plan S7.13, ticket #21): pure read-side
 * helpers the desktop materials panel consumes — material usage counts,
 * default payloads for `material.create`, the changed-field payload for
 * `material.update`. All functions are deterministic, bounded, and free
 * of UI state, so the panel behavior is testable in Node without React
 * or a document. (Material id allocation is session state and lives in
 * the desktop controller: ids are never reused while reachable history
 * or recovery records can mention them, ARCHITECTURE.md "Materials".)
 */

/**
 * Counts the voxels referencing every document material across all
 * volumes (plan S7.13 "usage counts"). The scan is bounded by the volume
 * resource limits: only allocated chunks are read, each chunk is a
 * bounded 4096-value copy, and the result is zero-filled so every
 * material record appears (unused materials show 0). The returned map is
 * freshly allocated on every call and never shares state with the store.
 */
export function countMaterialUsage(
  store: DocumentStoreRead,
): ReadonlyMap<MaterialId, number> {
  const counts = new Map<MaterialId, number>();
  const document = store.getDocument();
  for (const materialIdText of Object.keys(document.materials)) {
    counts.set(Number(materialIdText) as MaterialId, 0);
  }
  for (const descriptor of Object.values(document.volumes)) {
    const volume = store.getVolume(descriptor.volumeId);
    if (volume === undefined) continue;
    for (const chunkCoordinate of volume.chunkCoordinates()) {
      const values = volume.getChunk(chunkCoordinate);
      if (values === undefined) continue;
      for (let i = 0; i < values.length; i += 1) {
        const value = values[i];
        if (value === 0) continue;
        const id = value as MaterialId;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * Bounded default payload for a fresh material record: a neutral gray
 * canonical color, fully opaque, mid roughness, non-metallic, and
 * non-emissive. `material.create` validation (INVALID_NAME /
 * INVALID_COLOR / INVALID_MATERIAL_RANGE) accepts every field as-is.
 */
export function defaultNewMaterialPayload(
  id: MaterialId,
): CreateMaterialPayload {
  return {
    materialId: id,
    name: `Material ${String(id)}`,
    color: canonicalColor("#808080"),
    opacity: 1,
    roughness: 0.5,
    metallic: 0,
    emissive: 0,
  };
}

/** The editable subset of a material record (plan S7.13). */
export type MaterialFieldChanges = {
  readonly name?: string;
  /** Any `#rrggbb` string; canonicalized (lowercased) on comparison. */
  readonly color?: string;
  readonly opacity?: number;
  readonly roughness?: number;
  readonly metallic?: number;
  readonly emissive?: number;
};

/**
 * Builds the `material.update` payload for the fields that actually
 * differ from the committed record, or undefined when nothing changed.
 * Returning undefined lets the panel skip the command entirely: the bus
 * would otherwise reject an all-unchanged update with
 * `EMPTY_MATERIAL_UPDATE`, so a panel blur with no edits must not commit
 * anything. Colors are canonicalized before comparison and inclusion.
 */
export function materialUpdateChanges(
  record: MaterialRecord,
  changes: MaterialFieldChanges,
): UpdateMaterialPayload | undefined {
  let changed = false;
  let name: string | undefined;
  let color: Color | undefined;
  let opacity: number | undefined;
  let roughness: number | undefined;
  let metallic: number | undefined;
  let emissive: number | undefined;
  if (changes.name !== undefined && changes.name !== record.name) {
    name = changes.name;
    changed = true;
  }
  if (changes.color !== undefined) {
    const canonical = canonicalColor(changes.color);
    if (canonical !== record.color) {
      color = canonical;
      changed = true;
    }
  }
  if (changes.opacity !== undefined && changes.opacity !== record.opacity) {
    opacity = changes.opacity;
    changed = true;
  }
  if (
    changes.roughness !== undefined &&
    changes.roughness !== record.roughness
  ) {
    roughness = changes.roughness;
    changed = true;
  }
  if (changes.metallic !== undefined && changes.metallic !== record.metallic) {
    metallic = changes.metallic;
    changed = true;
  }
  if (changes.emissive !== undefined && changes.emissive !== record.emissive) {
    emissive = changes.emissive;
    changed = true;
  }
  if (!changed) return undefined;
  return {
    materialId: record.materialId,
    ...(name === undefined ? {} : { name }),
    ...(color === undefined ? {} : { color }),
    ...(opacity === undefined ? {} : { opacity }),
    ...(roughness === undefined ? {} : { roughness }),
    ...(metallic === undefined ? {} : { metallic }),
    ...(emissive === undefined ? {} : { emissive }),
  };
}
