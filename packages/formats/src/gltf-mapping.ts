import {
  WorkspaceError,
  type MaterialId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { VoxelDocument } from "@voxel-maker/model";
import type { Vec3 } from "@voxel-maker/math";
import {
  DEFAULT_GLTF_EXPORT_LIMITS,
  GLTF_ERROR_CODES,
  GLTF_EXPORT_LOSSES,
  GLTF_GENERATOR,
  GLTF_METERS_PER_VOXEL,
  type GltfExportLimits,
  type GltfExportLoss,
  type GltfExportMetadata,
  type GltfExportPreflight,
  type GltfMaterialExport,
  type GltfMeshData,
  type GltfMeshExport,
  type GltfNodeExport,
  type GltfPivotHelperReport,
  type GltfPrimitiveExport,
  type GltfSceneGraph,
  type GltfVolumeAccess,
} from "./gltf-types.js";
import { buildVolumeMesh } from "./gltf-mesh.js";

/**
 * Document -> static glTF export mapping (plan S16.1-S16.3, ADR-0011,
 * ticket #41).
 *
 * The editor and glTF bases are both emitted as right-handed `+Y` up with
 * `+X` right; editor `+Z` forward is retained as positive glTF Z, so no
 * axis remapping happens. One voxel edge maps to one meter. Node hierarchy
 * and canonical node-id iteration, ordered local translation, canonical
 * quaternion rotation, and positive scale map to glTF Nodes; a non-zero pivot becomes a
 * deterministic helper-node chain
 *   `T(translation) x T(pivot) x R(rotation) x S(scale) x T(-pivot)`
 * so static and animated world transforms remain equivalent and helper
 * identity is reported in export metadata. Voxel surfaces are face-culled
 * indexed triangle meshes grouped by Material; base color/opacity,
 * roughness, metallic, and emissive map to the PBR factors, and alpha
 * below one selects `BLEND`.
 */

const isZero = (value: Vec3): boolean =>
  value[0] === 0 && value[1] === 0 && value[2] === 0;

const isIdentityQuat = (
  value: readonly [number, number, number, number],
): boolean =>
  value[0] === 0 && value[1] === 0 && value[2] === 0 && value[3] === 1;

const isIdentityScale = (value: Vec3): boolean =>
  value[0] === 1 && value[1] === 1 && value[2] === 1;

const negate = (value: Vec3): Vec3 => [
  value[0] === 0 ? 0 : -value[0],
  value[1] === 0 ? 0 : -value[1],
  value[2] === 0 ? 0 : -value[2],
];

/**
 * Code-unit string comparison matching the canonical JSON member order
 * (RFC 8785, `canonicalDocumentJson`), so the export is identical whether
 * the document was created in memory or parsed from disk.
 */
const compareCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Sanitizes a document name for glTF: removes control characters
 * (U+0000..U+001F, U+007F) and trims. Returns undefined when nothing
 * remains, so callers fall back to a deterministic `Node N` / `Material N`
 * / `Mesh N` label.
 */
export function sanitizeGltfName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  let sanitized = "";
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    sanitized += char;
  }
  sanitized = sanitized.trim();
  return sanitized.length === 0 ? undefined : sanitized;
}

/** Deterministic unique-name allocator (ADR-0011 naming policy). */
class NameAllocator {
  readonly #used = new Set<string>();

  /** Allocates `base`, or the fallback when base is undefined or empty. */
  allocate(base: string | undefined, fallback: string): string {
    const root = base === undefined || base.length === 0 ? fallback : base;
    let candidate = root;
    let suffix = 2;
    while (this.#used.has(candidate)) {
      candidate = `${root}-${String(suffix)}`;
      suffix += 1;
    }
    this.#used.add(candidate);
    return candidate;
  }
}

/** Iterates document nodes in canonical node-id (code-unit) order. */
function canonicalNodeOrder(
  document: VoxelDocument,
): VoxelDocument["nodes"][NodeId][] {
  return Object.values(document.nodes).sort((a, b) =>
    compareCodeUnit(a.nodeId, b.nodeId),
  );
}

/** One voxel-carrying node in canonical node-id order. */
interface VoxelNode {
  readonly nodeId: NodeId;
  readonly volumeId: VolumeId;
}

/** Collects every node carrying a voxel component, in canonical node-id order. */
function collectVoxelNodes(document: VoxelDocument): VoxelNode[] {
  const voxelNodes: VoxelNode[] = [];
  for (const node of canonicalNodeOrder(document)) {
    const component = node.components.find(
      (candidate) => candidate.kind === "voxel",
    );
    if (component === undefined) continue;
    voxelNodes.push({ nodeId: node.nodeId, volumeId: component.volumeId });
  }
  return voxelNodes;
}

/**
 * Preflights a document for static glTF export (plan S16.1, ADR-0011).
 * Every unsupported feature (Clips, constraints, joints, metadata, empty
 * volumes) is reported as a documented bake loss; structural problems (no
 * voxel volumes, missing volume data) block the export. Nothing is dropped
 * silently. Resource limits are enforced later by the mesher and encoder
 * with structured `limit`-family errors (ADR-0009), before any bytes are
 * written.
 */
export function preflightGltfExport(
  document: VoxelDocument,
  getVolume: GltfVolumeAccess,
): GltfExportPreflight {
  const blocked: GltfExportLoss[] = [];
  const losses: GltfExportLoss[] = [];
  const voxelNodes = collectVoxelNodes(document);
  if (voxelNodes.length === 0) {
    return {
      ok: false,
      blocked: [
        {
          code: GLTF_EXPORT_LOSSES.noVolumes,
          message: "The document has no voxel volumes to export",
          severity: "block",
        },
      ],
    };
  }
  const emptyVolumes = new Set<VolumeId>();
  for (const node of voxelNodes) {
    const volume = getVolume(node.volumeId);
    if (volume === undefined) {
      blocked.push({
        code: GLTF_EXPORT_LOSSES.missingVolume,
        message: "Voxel volume is missing from the store",
        severity: "block",
        context: { volumeId: node.volumeId },
      });
      continue;
    }
    if (volume.occupiedBounds() === undefined) {
      emptyVolumes.add(node.volumeId);
    }
  }
  for (const volumeId of emptyVolumes) {
    losses.push({
      code: GLTF_EXPORT_LOSSES.emptyVolume,
      message: "Empty volumes are omitted from the export",
      severity: "bake",
      context: { volumeId },
    });
  }
  const animationCount = Object.keys(document.animations).length;
  if (animationCount > 0) {
    losses.push({
      code: GLTF_EXPORT_LOSSES.clips,
      message:
        "Clips are not exported by the static exporter; animated glTF export is a separate feature",
      severity: "bake",
      context: { clips: animationCount },
    });
  }
  for (const node of Object.values(document.nodes)) {
    for (const component of node.components) {
      if (component.kind === "constraint") {
        losses.push({
          code: GLTF_EXPORT_LOSSES.constraints,
          message: "Rotation-limit constraints are omitted from the export",
          severity: "bake",
          context: { nodeId: node.nodeId },
        });
      } else if (component.kind === "joint") {
        losses.push({
          code: GLTF_EXPORT_LOSSES.joints,
          message: "Joint annotations are omitted from the export",
          severity: "bake",
          context: { nodeId: node.nodeId },
        });
      }
    }
    if (node.metadata !== undefined && Object.keys(node.metadata).length > 0) {
      losses.push({
        code: GLTF_EXPORT_LOSSES.metadata,
        message: "Node metadata is not represented in glTF and is omitted",
        severity: "bake",
        context: { nodeId: node.nodeId },
      });
    }
  }
  if (Object.keys(document.metadata).length > 0) {
    losses.push({
      code: GLTF_EXPORT_LOSSES.metadata,
      message: "Document metadata is not represented in glTF and is omitted",
      severity: "bake",
      context: { scope: "document" },
    });
  }
  return blocked.length > 0 ? { ok: false, blocked } : { ok: true, losses };
}

const channel = (hex: string, offset: number): number =>
  Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;

/** Canonical material -> glTF PBR mapping (ADR-0011). */
function materialToExport(
  material: VoxelDocument["materials"][MaterialId],
  name: string,
): GltfMaterialExport {
  const alpha = material.opacity;
  return {
    name,
    baseColorFactor: [
      channel(material.color, 1),
      channel(material.color, 3),
      channel(material.color, 5),
      alpha,
    ],
    metallicFactor: material.metallic,
    roughnessFactor: material.roughness,
    emissiveFactor: [material.emissive, material.emissive, material.emissive],
    alphaMode: alpha < 1 ? "BLEND" : "OPAQUE",
  };
}

/**
 * Builds the deterministic static export scene graph after a successful
 * preflight (plan S16.3, ADR-0011): document nodes in document order
 * become glTF node chains (pivot helper nodes when the pivot is non-zero),
 * each distinct Voxel Volume becomes one mesh referenced by every node
 * that carries it, and used materials become PBR materials in ascending
 * material-id order. Names are sanitized and made unique deterministically
 * without changing stable ID mappings. The total-face resource limit is
 * enforced here; the per-volume face limit is enforced by the mesher.
 */
export function planGltfExport(
  document: VoxelDocument,
  getVolume: GltfVolumeAccess,
  preflight: Extract<GltfExportPreflight, { readonly ok: true }>,
  limits: GltfExportLimits = DEFAULT_GLTF_EXPORT_LIMITS,
): GltfSceneGraph {
  void preflight; // the ok preflight gates the plan; losses carry through
  const nodes: GltfNodeExport[] = [];
  const meshes: GltfMeshExport[] = [];
  const nodeNames = new NameAllocator();
  const meshNames = new NameAllocator();
  const materialNames = new NameAllocator();
  const meshDataByVolume = new Map<VolumeId, GltfMeshData>();
  const meshIndexByVolume = new Map<VolumeId, number>();
  const usedMaterials = new Set<MaterialId>();
  const pivotHelpers: GltfPivotHelperReport[] = [];
  const chainStartByNode = new Map<NodeId, number>();
  const chainLastByNode = new Map<NodeId, number>();
  let totalFaces = 0;
  let totalVoxels = 0;

  const docNodes = canonicalNodeOrder(document);

  // Pass A: mesh every distinct volume (canonical node-id order of first
  // use) and
  // collect the materials the exported meshes reference.
  for (const node of docNodes) {
    const voxelComponent = node.components.find(
      (candidate) => candidate.kind === "voxel",
    );
    if (voxelComponent === undefined) continue;
    if (meshDataByVolume.has(voxelComponent.volumeId)) continue;
    const volume = getVolume(voxelComponent.volumeId);
    if (volume === undefined) {
      // Preflight blocks missing volumes; this is unreachable.
      throw new WorkspaceError({
        family: "internal",
        code: "GLTF_MISSING_VOLUME",
        message: "Voxel volume disappeared between preflight and plan",
        context: { volumeId: voxelComponent.volumeId },
      });
    }
    const data = buildVolumeMesh(volume, limits.maxFacesPerVolume);
    if (data === undefined) continue; // empty volumes were reported
    totalFaces += data.faceCount;
    if (totalFaces > limits.maxTotalFaces) {
      throw new WorkspaceError({
        family: "limit",
        code: GLTF_ERROR_CODES.faceLimit,
        message:
          "Export exceeds the total glTF face limit; the document is too large to export",
        context: { faces: totalFaces, limit: limits.maxTotalFaces },
      });
    }
    totalVoxels += data.voxelCount;
    for (const group of data.materialGroups) {
      usedMaterials.add(group.materialId);
    }
    meshDataByVolume.set(voxelComponent.volumeId, data);
  }

  // Material table: ascending material-id order (deterministic mapping).
  const materialIndexById = new Map<MaterialId, number>();
  const materials: GltfMaterialExport[] = [];
  for (const materialIdValue of [...usedMaterials].sort((a, b) => a - b)) {
    const material = document.materials[materialIdValue];
    if (material === undefined) {
      // Volume data references a material the document does not define.
      throw new WorkspaceError({
        family: "validation",
        code: "GLTF_MATERIAL_MISSING",
        message: "Voxel volume references a material that is not defined",
        context: { material: String(materialIdValue) },
      });
    }
    const name = materialNames.allocate(
      sanitizeGltfName(material.name),
      `Material ${String(materialIdValue)}`,
    );
    materialIndexById.set(materialIdValue, materials.length);
    materials.push(materialToExport(material, name));
  }

  // Pass B: create every node chain in canonical node-id order, meshing
  // volumes on first reference, then wire children and the scene root.
  docNodes.forEach((node, index) => {
    const baseName = nodeNames.allocate(
      sanitizeGltfName(node.name),
      `Node ${String(index + 1)}`,
    );
    const transform = node.transform;
    const voxelComponent = node.components.find(
      (candidate) => candidate.kind === "voxel",
    );
    let meshIndex: number | undefined;
    if (voxelComponent !== undefined) {
      const existing = meshIndexByVolume.get(voxelComponent.volumeId);
      if (existing !== undefined) {
        meshIndex = existing;
      } else {
        const data = meshDataByVolume.get(voxelComponent.volumeId);
        if (data === undefined) {
          meshIndex = undefined; // empty volume; no mesh
        } else {
          const volumeName = document.volumes[voxelComponent.volumeId]?.name;
          const meshBase =
            sanitizeGltfName(volumeName) ?? sanitizeGltfName(node.name);
          const meshName = meshNames.allocate(
            meshBase,
            `Mesh ${String(meshes.length + 1)}`,
          );
          const primitives: GltfPrimitiveExport[] = data.materialGroups.map(
            (group) => {
              const materialIndex = materialIndexById.get(group.materialId);
              if (materialIndex === undefined) {
                throw new WorkspaceError({
                  family: "internal",
                  code: "GLTF_MATERIAL_MISSING",
                  message: "Material missing from the export material table",
                  context: { material: String(group.materialId) },
                });
              }
              return {
                materialIndex,
                indices: data.indices.subarray(
                  group.start,
                  group.start + group.count,
                ),
              };
            },
          );
          meshIndex = meshes.length;
          meshes.push({
            name: meshName,
            positions: data.positions,
            normals: data.normals,
            primitives,
          });
          meshIndexByVolume.set(voxelComponent.volumeId, meshIndex);
        }
      }
    }

    const pivot = transform.pivot;
    if (isZero(pivot)) {
      const gltfNode: GltfNodeExport = {
        name: baseName,
        ...(!isZero(transform.translation)
          ? { translation: [...transform.translation] }
          : {}),
        ...(!isIdentityQuat(transform.rotation)
          ? { rotation: [...transform.rotation] }
          : {}),
        ...(!isIdentityScale(transform.scale)
          ? { scale: [...transform.scale] }
          : {}),
        ...(meshIndex !== undefined ? { mesh: meshIndex } : {}),
      };
      chainStartByNode.set(node.nodeId, nodes.length);
      chainLastByNode.set(node.nodeId, nodes.length);
      nodes.push(gltfNode);
      return;
    }

    // Pivot helper chain: N0 = T(t), H1 = T(p) R S, H2 = T(-p) + mesh.
    const pivotName = nodeNames.allocate(
      `${baseName} pivot`,
      `${baseName} pivot`,
    );
    const offsetName = nodeNames.allocate(
      `${baseName} pivot offset`,
      `${baseName} pivot offset`,
    );
    const headIndex = nodes.length;
    const helperIndex = headIndex + 1;
    const offsetIndex = headIndex + 2;
    nodes.push(
      {
        name: baseName,
        ...(!isZero(transform.translation)
          ? { translation: [...transform.translation] }
          : {}),
        children: [helperIndex],
      },
      {
        name: pivotName,
        translation: [...pivot],
        ...(!isIdentityQuat(transform.rotation)
          ? { rotation: [...transform.rotation] }
          : {}),
        ...(!isIdentityScale(transform.scale)
          ? { scale: [...transform.scale] }
          : {}),
        children: [offsetIndex],
      },
      {
        name: offsetName,
        translation: negate(pivot),
        ...(meshIndex !== undefined ? { mesh: meshIndex } : {}),
      },
    );
    chainStartByNode.set(node.nodeId, headIndex);
    chainLastByNode.set(node.nodeId, offsetIndex);
    pivotHelpers.push({
      nodeId: node.nodeId,
      name: baseName,
      helperNodes: [pivotName, offsetName],
    });
  });

  // Wire document children to the last node of each child chain.
  for (const node of docNodes) {
    if (node.children.length === 0) continue;
    const last = chainLastByNode.get(node.nodeId);
    const childStarts = node.children.map((childId) => {
      const start = chainStartByNode.get(childId);
      if (start === undefined) {
        throw new WorkspaceError({
          family: "internal",
          code: "GLTF_NODE_MISSING",
          message: "Child node missing from the export node table",
          context: { nodeId: childId },
        });
      }
      return start;
    });
    const targetIndex = last ?? -1;
    const target = nodes[targetIndex];
    if (target === undefined) {
      throw new WorkspaceError({
        family: "internal",
        code: "GLTF_NODE_MISSING",
        message: "Parent chain missing from the export node table",
        context: { nodeId: node.nodeId },
      });
    }
    nodes[targetIndex] = { ...target, children: childStarts };
  }

  const rootStart = chainStartByNode.get(document.rootNodeId);
  if (rootStart === undefined) {
    throw new WorkspaceError({
      family: "internal",
      code: "GLTF_NODE_MISSING",
      message: "Document root missing from the export node table",
    });
  }

  const metadata: GltfExportMetadata = {
    generator: GLTF_GENERATOR,
    metersPerVoxel: GLTF_METERS_PER_VOXEL,
    pivotHelpers,
    nodes: nodes.length,
    meshes: meshes.length,
    materials: materials.length,
    faces: totalFaces,
    voxels: totalVoxels,
  };
  return {
    sceneNodes: [rootStart],
    nodes,
    meshes,
    materials,
    metadata,
    losses: preflight.losses,
  };
}
