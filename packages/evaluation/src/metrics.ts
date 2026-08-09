import type { DocumentStoreRead } from "@voxel-maker/document";
import { validateDocument, type VoxelDocument } from "@voxel-maker/model";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import type { MaterialId, NodeId, VolumeId } from "@voxel-maker/shared";

/**
 * Structural metrics of the fixed evaluation suite (plan S12.2, ticket
 * #35): deterministic, bounded measurements over `DocumentStoreRead` —
 * occupied bounds and voxel counts, material usage, hierarchy validity,
 * symmetry, and the exact changed-voxel/material/node sets between a
 * scenario's starting and resulting documents. Every scan is bounded by
 * an explicit region; nothing here mutates state.
 */

export interface OccupiedMetrics {
  readonly volumeId: VolumeId;
  /** Axis-aligned bounds of occupied voxels within the scanned region. */
  readonly bounds: IntAabb | undefined;
  readonly voxelCount: number;
  /** materialId -> occupied voxel count (only nonzero entries). */
  readonly materialCounts: Readonly<Record<string, number>>;
}

/** Scans a half-open region of one volume (bounded by `region`). */
export function occupiedMetrics(
  store: DocumentStoreRead,
  volumeId: VolumeId,
  region: IntAabb,
): OccupiedMetrics {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let voxelCount = 0;
  const materialCounts: Record<string, number> = {};
  for (let x = region.min[0]; x < region.max[0]; x += 1) {
    for (let y = region.min[1]; y < region.max[1]; y += 1) {
      for (let z = region.min[2]; z < region.max[2]; z += 1) {
        const material = store.getVoxel(volumeId, [x, y, z]);
        if (material === 0) continue;
        voxelCount += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
        const key = String(material);
        materialCounts[key] = (materialCounts[key] ?? 0) + 1;
      }
    }
  }
  return {
    volumeId,
    bounds:
      voxelCount === 0
        ? undefined
        : { min: [minX, minY, minZ], max: [maxX + 1, maxY + 1, maxZ + 1] },
    voxelCount,
    materialCounts,
  };
}

/** True when every voxel of the region is occupied with a nonzero material. */
export function regionFilled(
  store: DocumentStoreRead,
  volumeId: VolumeId,
  region: IntAabb,
): boolean {
  for (let x = region.min[0]; x < region.max[0]; x += 1) {
    for (let y = region.min[1]; y < region.max[1]; y += 1) {
      for (let z = region.min[2]; z < region.max[2]; z += 1) {
        if (store.getVoxel(volumeId, [x, y, z]) === 0) return false;
      }
    }
  }
  return true;
}

/** True when every voxel of the region is empty (material 0). */
export function regionEmpty(
  store: DocumentStoreRead,
  volumeId: VolumeId,
  region: IntAabb,
): boolean {
  for (let x = region.min[0]; x < region.max[0]; x += 1) {
    for (let y = region.min[1]; y < region.max[1]; y += 1) {
      for (let z = region.min[2]; z < region.max[2]; z += 1) {
        if (store.getVoxel(volumeId, [x, y, z]) !== 0) return false;
      }
    }
  }
  return true;
}

/** True when every voxel of the region carries exactly `material`. */
export function regionHasMaterial(
  store: DocumentStoreRead,
  volumeId: VolumeId,
  region: IntAabb,
  material: MaterialId,
): boolean {
  for (let x = region.min[0]; x < region.max[0]; x += 1) {
    for (let y = region.min[1]; y < region.max[1]; y += 1) {
      for (let z = region.min[2]; z < region.max[2]; z += 1) {
        if (store.getVoxel(volumeId, [x, y, z]) !== material) return false;
      }
    }
  }
  return true;
}

/**
 * Symmetry score of the occupied voxels inside `region` across the mirror
 * plane `axis = plane` (a half-integer plane like x = 4). For every
 * occupied voxel whose mirrored twin is also occupied the voxel counts as
 * matched; the score is matched / occupied. Mirrored coordinates use the
 * same mapping as `voxel.mirrorRegion` across the region center:
 * `p' = 2*plane - p - 1` on the mirror axis.
 */
export function symmetryScore(
  store: DocumentStoreRead,
  volumeId: VolumeId,
  region: IntAabb,
  axis: "x" | "y" | "z",
  plane: number,
): { readonly score: number; readonly matched: number; readonly occupied: number } {
  const occupied = new Set<string>();
  const mirrorOf = (coordinate: Vec3i): Vec3i => {
    if (axis === "x") return [2 * plane - coordinate[0] - 1, coordinate[1], coordinate[2]];
    if (axis === "y") return [coordinate[0], 2 * plane - coordinate[1] - 1, coordinate[2]];
    return [coordinate[0], coordinate[1], 2 * plane - coordinate[2] - 1];
  };
  for (let x = region.min[0]; x < region.max[0]; x += 1) {
    for (let y = region.min[1]; y < region.max[1]; y += 1) {
      for (let z = region.min[2]; z < region.max[2]; z += 1) {
        if (store.getVoxel(volumeId, [x, y, z]) !== 0) {
          occupied.add(`${String(x)},${String(y)},${String(z)}`);
        }
      }
    }
  }
  let matched = 0;
  for (const key of occupied) {
    const [x, y, z] = key.split(",").map(Number) as [number, number, number];
    const twin = mirrorOf([x, y, z]);
    if (
      occupied.has(
        `${String(twin[0])},${String(twin[1])},${String(twin[2])}`,
      )
    ) {
      matched += 1;
    }
  }
  return {
    score: occupied.size === 0 ? 1 : matched / occupied.size,
    matched,
    occupied: occupied.size,
  };
}

/** Structural validity report: full document validation + orphan checks. */
export function structuralIssues(store: DocumentStoreRead): readonly string[] {
  const issues = validateDocument(store.getDocument(), store.limits);
  const messages: string[] = [];
  for (const issue of issues) {
    messages.push(
      `${issue.code}${issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`}: ${issue.message}`,
    );
  }
  const document = store.getDocument();
  for (const key of Object.keys(document.nodes)) {
    const node = document.nodes[key as NodeId];
    if (node === undefined) continue;
    if (node.parentId !== null && document.nodes[node.parentId] === undefined) {
      messages.push(`Orphan node ${key} references missing parent ${node.parentId}`);
    }
    for (const component of node.components) {
      if (
        component.kind === "voxel" &&
        document.volumes[component.volumeId] === undefined
      ) {
        messages.push(
          `Node ${key} references missing volume ${component.volumeId}`,
        );
      }
    }
  }
  return messages;
}

/**
 * Exact changed-voxel set between two committed stores of the same
 * document, bounded by `region`: coordinates where the material differs.
 */
export function changedVoxels(
  before: DocumentStoreRead,
  after: DocumentStoreRead,
  volumeId: VolumeId,
  region: IntAabb,
): readonly Vec3i[] {
  const changed: Vec3i[] = [];
  for (let x = region.min[0]; x < region.max[0]; x += 1) {
    for (let y = region.min[1]; y < region.max[1]; y += 1) {
      for (let z = region.min[2]; z < region.max[2]; z += 1) {
        const coordinate: Vec3i = [x, y, z];
        if (before.getVoxel(volumeId, coordinate) !== after.getVoxel(volumeId, coordinate)) {
          changed.push(coordinate);
        }
      }
    }
  }
  return changed;
}

/** Canonical JSON of one material record (stable comparison key). */
function materialKey(
  document: VoxelDocument,
  materialId: MaterialId,
): string {
  return JSON.stringify(
    (document.materials as Readonly<Record<string, unknown>>)[String(materialId)],
  );
}

/**
 * Changed material records between two documents: added, removed, and
 * updated (any canonical field difference). Material ids are string keys.
 */
export function changedMaterials(
  before: VoxelDocument,
  after: VoxelDocument,
): readonly { readonly materialId: string; readonly kind: "added" | "removed" | "updated" }[] {
  const changes: { materialId: string; kind: "added" | "removed" | "updated" }[] = [];
  const beforeIds = Object.keys(before.materials);
  const afterIds = Object.keys(after.materials);
  const beforeMaterials = before.materials as Readonly<Record<string, unknown>>;
  const afterMaterials = after.materials as Readonly<Record<string, unknown>>;
  for (const id of afterIds) {
    if (beforeMaterials[id] === undefined) {
      changes.push({ materialId: id, kind: "added" });
    }
  }
  for (const id of beforeIds) {
    if (afterMaterials[id] === undefined) {
      changes.push({ materialId: id, kind: "removed" });
    }
  }
  for (const id of beforeIds) {
    if (
      beforeMaterials[id] !== undefined &&
      afterMaterials[id] !== undefined &&
      materialKey(before, id as unknown as MaterialId) !==
        materialKey(after, id as unknown as MaterialId)
    ) {
      changes.push({ materialId: id, kind: "updated" });
    }
  }
  return changes;
}

/** Changed node ids between two documents (any canonical difference). */
export function changedNodes(
  before: VoxelDocument,
  after: VoxelDocument,
): readonly NodeId[] {
  const changed: NodeId[] = [];
  const beforeIds = Object.keys(before.nodes);
  const afterIds = Object.keys(after.nodes);
  const ids = new Set([...beforeIds, ...afterIds]);
  for (const id of ids) {
    const key = id as NodeId;
    const beforeNode = before.nodes[key];
    const afterNode = after.nodes[key];
    if (beforeNode === undefined || afterNode === undefined) {
      changed.push(key);
      continue;
    }
    if (JSON.stringify(beforeNode) !== JSON.stringify(afterNode)) {
      changed.push(key);
    }
  }
  return changed;
}

/** True when a material with the exact canonical color exists and is used. */
export function colorUsed(
  store: DocumentStoreRead,
  color: string,
  volumeId: VolumeId,
  region: IntAabb,
): boolean {
  const document = store.getDocument();
  const materialIds = Object.keys(document.materials).filter(
    (id) => document.materials[id as unknown as MaterialId]?.color === color,
  );
  if (materialIds.length === 0) return false;
  const used = new Set(materialIds);
  for (let x = region.min[0]; x < region.max[0]; x += 1) {
    for (let y = region.min[1]; y < region.max[1]; y += 1) {
      for (let z = region.min[2]; z < region.max[2]; z += 1) {
        const material = store.getVoxel(volumeId, [x, y, z]);
        if (material !== 0 && used.has(String(material))) return true;
      }
    }
  }
  return false;
}
