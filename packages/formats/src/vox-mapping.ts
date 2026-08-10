import {
  WorkspaceError,
  type MaterialId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { Vec3i } from "@voxel-maker/math";
import type { VoxelDocument } from "@voxel-maker/model";
import { CHUNK_EDGE } from "@voxel-maker/voxel";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import {
  VOX_MAX_AXIS_SIZE,
  VOX_MAX_COLOR_INDEX,
  VOX_PALETTE_ENTRIES,
} from "./vox.js";
import {
  VOX_EXPORT_LOSSES,
  VOX_IMPORT_WARNINGS,
  type VoxColor,
  type VoxExportChoices,
  type VoxExportLoss,
  type VoxExportModel,
  type VoxExportPlan,
  type VoxExportPreflight,
  type VoxImportMaterial,
  type VoxImportNode,
  type VoxImportPlan,
  type VoxImportVolume,
  type VoxParseResult,
  type VoxVoxel,
  type VoxWarning,
} from "./vox-types.js";

/**
 * Document <-> VOX mapping (plan S8.3/S8.4, ADR-0011, ticket #24).
 *
 * Import axis mapping (file -> editor):
 *   (X, Y, Z) = (vox x, vox z, -vox y)
 * Export applies the inverse: (vox x, vox y, vox z) = (X, -Z, Y).
 *
 * Palette index 0 is empty; used indices 1..255 become Materials. Export
 * preflights dimensions (256 per axis), color count (255), identity
 * transforms, hierarchy, and origin rebasing before any bytes are written.
 */

/** Deterministic id factory for one import (caller supplies the prefix). */
export interface VoxImportIdFactory {
  nodeId(modelIndex: number): NodeId;
  volumeId(modelIndex: number): VolumeId;
  /**
   * Resolves a used palette color index to a document material id. The
   * caller may reuse an existing material with the same color or allocate a
   * fresh id; returning a material whose color differs corrupts the plan.
   */
  materialId(colorIndex: number): MaterialId;
}

/**
 * Maps a parsed VOX file into generic document intent (materials, volumes,
 * root-level nodes). Every conversion is explicit: axes are mapped, palette
 * entries become materials, and index-0 voxels were already dropped by the
 * parser with a warning. Node names are deterministic "Model N" labels
 * because the supported subset carries no names.
 */
export function mapVoxImport(
  parsed: VoxParseResult,
  ids: VoxImportIdFactory,
): VoxImportPlan {
  const warnings: VoxWarning[] = [...parsed.warnings];
  const materialByIndex = new Map<number, VoxImportMaterial>();
  const volumes: VoxImportVolume[] = [];
  const nodes: VoxImportNode[] = [];
  for (const model of parsed.models) {
    // Editor bounds over the mapped coordinates (half-open).
    let min: Vec3i | undefined;
    let max: Vec3i | undefined;
    const entries: { coordinate: Vec3i; material: MaterialId }[] = [];
    for (const voxel of model.voxels) {
      const color = parsed.palette[voxel.colorIndex];
      if (color === undefined) {
        throw new WorkspaceError({
          family: "internal",
          code: "VOX_PALETTE_MISSING",
          message: "Palette entry missing while mapping a voxel",
          context: { colorIndex: voxel.colorIndex },
        });
      }
      let material = materialByIndex.get(voxel.colorIndex);
      if (material === undefined) {
        const materialIdValue = ids.materialId(voxel.colorIndex);
        material = {
          materialId: materialIdValue,
          name: `Palette ${String(voxel.colorIndex)}`,
          color: hexColor(color),
          opacity: color.a / 255,
        };
        materialByIndex.set(voxel.colorIndex, material);
      }
      // (X, Y, Z) = (vox x, vox z, -vox y); normalize negative zero so the
      // canonical pipeline never sees -0.
      const mappedY = -voxel.y;
      const coordinate: Vec3i = [
        voxel.x,
        voxel.z,
        Object.is(mappedY, -0) ? 0 : mappedY,
      ];
      min = min === undefined ? [...coordinate] : minVec(min, coordinate);
      max = max === undefined ? [...coordinate] : maxVec(max, coordinate);
      entries.push({ coordinate, material: material.materialId });
    }
    if (
      min !== undefined &&
      max !== undefined &&
      (model.sizeX > max[0] - min[0] + 1 ||
        model.sizeY > max[1] - min[1] + 1 ||
        model.sizeZ > max[2] - min[2] + 1)
    ) {
      warnings.push({
        code: VOX_IMPORT_WARNINGS.modelCubeTrimmed,
        message:
          "The declared model cube exceeds the occupied voxel bounds; empty space is not preserved on re-export",
        context: {
          declaredX: model.sizeX,
          declaredY: model.sizeY,
          declaredZ: model.sizeZ,
          occupiedX: max[0] - min[0] + 1,
          occupiedY: max[1] - min[1] + 1,
          occupiedZ: max[2] - min[2] + 1,
        },
      });
    }
    const volumeId = ids.volumeId(volumes.length);
    const nodeId = ids.nodeId(nodes.length);
    const name = `Model ${String(nodes.length + 1)}`;
    volumes.push({
      volumeId,
      name,
      bounds:
        min === undefined || max === undefined
          ? { min: [0, 0, 0], max: [0, 0, 0] }
          : {
              min,
              max: [max[0] + 1, max[1] + 1, max[2] + 1],
            },
      entries,
    });
    nodes.push({ nodeId, name, volumeId });
  }
  if (parsed.models.length > 1) {
    // The subset has no names; a multi-model file still maps to separate
    // root nodes, but MagicaVoxel's PACK models are one "object".
    warnings.push({
      code: VOX_IMPORT_WARNINGS.modelName,
      message:
        "VOX files carry no node names; imported models are named Model N",
    });
  }
  return {
    materials: [...materialByIndex.values()].sort(
      (a, b) => a.materialId - b.materialId,
    ),
    volumes,
    nodes,
    warnings,
  };
}

const minVec = (a: Vec3i, b: Vec3i): Vec3i => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.min(a[2], b[2]),
];

const maxVec = (a: Vec3i, b: Vec3i): Vec3i => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.max(a[2], b[2]),
];

/** Canonical lowercase `#rrggbb` from a VOX palette color. */
export function hexColor(color: VoxColor): string {
  const channel = (value: number): string =>
    value.toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** Volume read access used by the export preflight. */
export type VoxVolumeAccess = (
  volumeId: VolumeId,
) => VoxelVolumeReadView | undefined;

interface VoxelNode {
  readonly nodeId: NodeId;
  readonly volumeId: VolumeId;
  readonly parentIsRoot: boolean;
  readonly transformIsIdentity: boolean;
  readonly hasChildren: boolean;
  readonly name: string | undefined;
}

/**
 * Builds the deterministic export palette: indices 1..255 assigned in
 * material-id order, one entry per distinct color (opacity maps to alpha
 * with 8-bit rounding). Shared by preflight (loss checks) and plan.
 */
function buildExportPalette(
  document: VoxelDocument,
  usedMaterialIds: readonly MaterialId[],
): { palette: VoxColor[]; materialToIndex: Map<MaterialId, number> } {
  const sorted = [...usedMaterialIds].sort((a, b) => a - b);
  const materialToIndex = new Map<MaterialId, number>();
  const colorToIndex = new Map<string, number>();
  const palette: VoxColor[] = [
    { r: 0, g: 0, b: 0, a: 0 },
    ...Array.from({ length: VOX_PALETTE_ENTRIES - 1 }, () => ({
      r: 0,
      g: 0,
      b: 0,
      a: 255,
    })),
  ];
  const channel = (hex: string, offset: number): number =>
    Number.parseInt(hex.slice(offset, offset + 2), 16);
  for (const materialIdValue of sorted) {
    const material = document.materials[materialIdValue];
    if (material === undefined) continue;
    let index = colorToIndex.get(material.color);
    if (index === undefined) {
      index = colorToIndex.size + 1;
      colorToIndex.set(material.color, index);
      palette[index] = {
        r: channel(material.color, 1),
        g: channel(material.color, 3),
        b: channel(material.color, 5),
        a: Math.round(material.opacity * 255),
      };
    }
    materialToIndex.set(materialIdValue, index);
  }
  return { palette, materialToIndex };
}

/** Collects every node carrying a voxel component, in document order. */
function collectVoxelNodes(document: VoxelDocument): VoxelNode[] {
  const voxelNodes: VoxelNode[] = [];
  for (const node of Object.values(document.nodes)) {
    const component = node.components.find(
      (candidate) => candidate.kind === "voxel",
    );
    if (component === undefined) continue;
    voxelNodes.push({
      nodeId: node.nodeId,
      volumeId: component.volumeId,
      parentIsRoot: node.parentId === document.rootNodeId,
      transformIsIdentity: transformEqualsIdentity(node.transform),
      hasChildren: node.children.length > 0,
      name: node.name,
    });
  }
  return voxelNodes;
}

/**
 * Preflights a document for VOX export (plan S8.4, ADR-0011). Every
 * unsupported feature is either resolved through an explicit choice or
 * blocks the export with a structured loss report; nothing is dropped
 * silently. Clips, pivots, joints, constraints, and node/document
 * metadata are the ADR-0011 semantics audited here: Clips have no VOX
 * representation and block the export, while rig annotations and metadata
 * on any node are reported as bake losses.
 */
export function preflightVoxExport(
  document: VoxelDocument,
  getVolume: VoxVolumeAccess,
  choices: VoxExportChoices = {},
): VoxExportPreflight {
  const blocked: VoxExportLoss[] = [];
  const losses: VoxExportLoss[] = [];
  const voxelNodes = collectVoxelNodes(document);
  const nonRoot = voxelNodes.filter((node) => !node.parentIsRoot);
  if (nonRoot.length > 0) {
    if (choices.flattenHierarchy === true) {
      losses.push({
        code: VOX_EXPORT_LOSSES.hierarchy,
        message:
          "Voxel volumes are nested below the document root; hierarchy is flattened into separate models",
        severity: "bake",
        context: { nested: nonRoot.length },
      });
    } else {
      blocked.push({
        code: VOX_EXPORT_LOSSES.hierarchy,
        message:
          "Nested voxel volumes cannot be exported; flatten the hierarchy or choose flattenHierarchy",
        severity: "block",
        context: { nested: nonRoot.length },
      });
    }
  }
  for (const node of voxelNodes) {
    if (!node.transformIsIdentity) {
      blocked.push({
        code: VOX_EXPORT_LOSSES.transform,
        message:
          "Only identity-transformed volumes export; the VOX subset writes no transforms",
        severity: "block",
        context: { nodeId: node.nodeId },
      });
    }
    if (node.hasChildren) {
      losses.push({
        code: VOX_EXPORT_LOSSES.hierarchy,
        message: "Children of voxel nodes are not exported",
        severity: "bake",
        context: { nodeId: node.nodeId },
      });
    }
    if (node.name !== undefined) {
      losses.push({
        code: VOX_EXPORT_LOSSES.metadata,
        message: "Node names are not represented in the VOX subset",
        severity: "bake",
        context: { nodeId: node.nodeId },
      });
    }
  }
  // ADR-0011 semantics audit: Clips cannot be represented anywhere in the
  // VOX subset (no animation chunks are written), so their presence blocks
  // the export with a deterministic loss instead of dropping motion
  // silently. Pivots, joints, constraints, and metadata have no VOX
  // representation either; they are reported as bake losses on every node
  // (the voxel content itself is still exported, mirroring the node-name
  // policy and the glTF preflight's all-node scan).
  const animationCount = Object.keys(document.animations).length;
  if (animationCount > 0) {
    blocked.push({
      code: VOX_EXPORT_LOSSES.clips,
      message:
        "Clips are not representable in the VOX subset; remove the animation before exporting",
      severity: "block",
      context: { clips: animationCount },
    });
  }
  if (Object.keys(document.metadata).length > 0) {
    losses.push({
      code: VOX_EXPORT_LOSSES.metadata,
      message: "Document metadata is not represented in the VOX subset",
      severity: "bake",
      context: { scope: "document" },
    });
  }
  for (const node of Object.values(document.nodes)) {
    if (node.metadata !== undefined && Object.keys(node.metadata).length > 0) {
      losses.push({
        code: VOX_EXPORT_LOSSES.metadata,
        message: "Node metadata is not represented in the VOX subset",
        severity: "bake",
        context: { nodeId: node.nodeId },
      });
    }
    for (const component of node.components) {
      if (component.kind === "joint") {
        losses.push({
          code: VOX_EXPORT_LOSSES.joints,
          message: "Joint annotations are not represented in the VOX subset",
          severity: "bake",
          context: { nodeId: node.nodeId },
        });
      } else if (component.kind === "constraint") {
        losses.push({
          code: VOX_EXPORT_LOSSES.constraints,
          message:
            "Rotation-limit constraints are not represented in the VOX subset",
          severity: "bake",
          context: { nodeId: node.nodeId },
        });
      } else if (
        component.kind === "pivot" &&
        (component.pivot[0] !== 0 ||
          component.pivot[1] !== 0 ||
          component.pivot[2] !== 0)
      ) {
        losses.push({
          code: VOX_EXPORT_LOSSES.pivot,
          message: "Pivot annotations are not represented in the VOX subset",
          severity: "bake",
          context: { nodeId: node.nodeId },
        });
      }
    }
  }
  if (voxelNodes.length === 0) {
    return {
      ok: false,
      blocked: [
        {
          code: VOX_EXPORT_LOSSES.dimensions,
          message: "The document has no voxel volumes to export",
          severity: "block",
        },
        ...blocked,
      ],
    };
  }

  // Dimensions and origin: occupied bounds per volume.
  const usedMaterialIds = new Set<MaterialId>();
  const emptyVolumes: string[] = [];
  for (const node of voxelNodes) {
    const volume = getVolume(node.volumeId);
    if (volume === undefined) {
      blocked.push({
        code: VOX_EXPORT_LOSSES.dimensions,
        message: "Voxel volume is missing from the store",
        severity: "block",
        context: { volumeId: node.volumeId },
      });
      continue;
    }
    const bounds = volume.occupiedBounds();
    if (bounds === undefined) {
      emptyVolumes.push(node.volumeId);
      continue;
    }
    for (const axis of [0, 1, 2] as const) {
      const extent = bounds.max[axis] - bounds.min[axis];
      if (extent > VOX_MAX_AXIS_SIZE) {
        blocked.push({
          code: VOX_EXPORT_LOSSES.dimensions,
          message:
            "Volume occupies more than 256 voxels on an axis; the VOX subset cannot represent it",
          severity: "block",
          context: {
            volumeId: node.volumeId,
            axis,
            extent,
          },
        });
      }
    }
    // The unsigned-cube origin is evaluated in VOX space: after the axis
    // mapping (x, y, z) = (X, -Z, Y), vox y is non-negative only when the
    // editor Z extent is non-positive. Bounds are half-open [min, max), so
    // the occupied Z range is [minZ, maxZ - 1] and VOX-space minima are:
    //   voxMinX = bounds.min[0], voxMinY = -(bounds.max[2] - 1),
    //   voxMinZ = bounds.min[1]
    const voxMin = [
      bounds.min[0],
      -(bounds.max[2] - 1),
      bounds.min[1],
    ] as const;
    for (const axis of [0, 1, 2] as const) {
      const minimum = voxMin[axis];
      if (minimum < 0) {
        if (choices.rebaseOrigins === true) {
          losses.push({
            code: VOX_EXPORT_LOSSES.origin,
            message:
              "Volume is rebased to the unsigned VOX origin; absolute coordinates are lost",
            severity: "bake",
            context: { volumeId: node.volumeId, axis, min: minimum },
          });
        } else {
          blocked.push({
            code: VOX_EXPORT_LOSSES.origin,
            message:
              "Volume extends below the unsigned VOX origin; choose rebaseOrigins to shift it",
            severity: "block",
            context: { volumeId: node.volumeId, axis, min: minimum },
          });
        }
      }
    }
    for (const coordinate of volume.chunkCoordinates()) {
      const chunk = volume.getChunk(coordinate);
      if (chunk === undefined) continue;
      for (let index = 0; index < chunk.length; index += 1) {
        const material = chunk[index];
        if (material !== 0) usedMaterialIds.add(material as MaterialId);
      }
    }
  }
  if (emptyVolumes.length > 0) {
    losses.push({
      code: VOX_EXPORT_LOSSES.emptyModel,
      message: "Empty volumes are omitted from the export",
      severity: "bake",
      context: { volumeIds: emptyVolumes.join(",") },
    });
  }

  // Palette and material semantics: project every used material onto the
  // deterministic export palette (one entry per distinct color, assigned in
  // material-id order). Every material that collapses into an existing
  // entry loses its identity, and every used material name is dropped by
  // the subset; both are reported before encoding (ADR-0011 never silently
  // drops semantic content). The 255-entry limit applies to the projected
  // palette, not the raw material count, so representable exports are not
  // falsely blocked.
  const { materialToIndex } = buildExportPalette(document, [
    ...usedMaterialIds,
  ]);
  const entryOwners = new Map<number, MaterialId>();
  for (const materialIdValue of [...usedMaterialIds].sort((a, b) => a - b)) {
    const material = document.materials[materialIdValue];
    if (material === undefined) {
      blocked.push({
        code: VOX_EXPORT_LOSSES.colorLimit,
        message: "Volume references a material that is not defined",
        severity: "block",
        context: { material: String(materialIdValue) },
      });
      continue;
    }
    if (
      material.roughness !== 0 ||
      material.metallic !== 0 ||
      material.emissive !== 0
    ) {
      losses.push({
        code: VOX_EXPORT_LOSSES.materialSemantics,
        message:
          "Roughness, metallic, and emissive values are not represented in the VOX subset",
        severity: "bake",
        context: { material: String(materialIdValue) },
      });
    }
    if (material.opacity !== 1) {
      losses.push({
        code: VOX_EXPORT_LOSSES.materialSemantics,
        message: "Material opacity maps to palette alpha with 8-bit rounding",
        severity: "bake",
        context: { material: String(materialIdValue) },
      });
    }
    if (material.name !== "") {
      losses.push({
        code: VOX_EXPORT_LOSSES.metadata,
        message: "Material names are not represented in the VOX subset",
        severity: "bake",
        context: { material: String(materialIdValue) },
      });
    }
    const entry = materialToIndex.get(materialIdValue);
    if (entry === undefined) continue;
    const owner = entryOwners.get(entry);
    if (owner === undefined) {
      entryOwners.set(entry, materialIdValue);
      continue;
    }
    const ownerMaterial = document.materials[owner];
    const opacityDiffers =
      ownerMaterial !== undefined &&
      Math.round(ownerMaterial.opacity * 255) !==
        Math.round(material.opacity * 255);
    losses.push({
      code: VOX_EXPORT_LOSSES.materialDistinction,
      message: opacityDiffers
        ? "Materials with the same color but different opacity share one palette entry"
        : "Distinct materials with the same color share one palette entry; their identities and names are not preserved",
      severity: "bake",
      context: {
        material: String(materialIdValue),
        collapsedInto: String(owner),
      },
    });
  }
  // Palette entries are assigned contiguously from index 1, so the number
  // of owned entries is the projected palette size.
  const projectedEntryCount = entryOwners.size;
  if (projectedEntryCount > VOX_MAX_COLOR_INDEX) {
    blocked.push({
      code: VOX_EXPORT_LOSSES.colorLimit,
      message: `Export needs ${String(projectedEntryCount)} colors but the VOX palette holds 255`,
      severity: "block",
      context: { colors: projectedEntryCount },
    });
  }

  return blocked.length > 0 ? { ok: false, blocked } : { ok: true, losses };
}

function transformEqualsIdentity(
  transform: VoxelDocument["nodes"][NodeId]["transform"],
): boolean {
  return (
    transform.translation[0] === 0 &&
    transform.translation[1] === 0 &&
    transform.translation[2] === 0 &&
    transform.pivot[0] === 0 &&
    transform.pivot[1] === 0 &&
    transform.pivot[2] === 0 &&
    transform.rotation[0] === 0 &&
    transform.rotation[1] === 0 &&
    transform.rotation[2] === 0 &&
    transform.rotation[3] === 1 &&
    transform.scale[0] === 1 &&
    transform.scale[1] === 1 &&
    transform.scale[2] === 1
  );
}

/**
 * Builds the deterministic export plan (palette + models) after a
 * successful preflight. Applies origin rebasing when chosen, maps axes to
 * VOX space, and assigns palette indices in material-id order.
 */
export function planVoxExport(
  document: VoxelDocument,
  getVolume: VoxVolumeAccess,
  preflight: Extract<VoxExportPreflight, { readonly ok: true }>,
  choices: VoxExportChoices = {},
): VoxExportPlan {
  const voxelNodes = collectVoxelNodes(document);
  const usedMaterialIds = new Set<MaterialId>();
  for (const node of voxelNodes) {
    const volume = getVolume(node.volumeId);
    if (volume === undefined) continue;
    for (const coordinate of volume.chunkCoordinates()) {
      const chunk = volume.getChunk(coordinate);
      if (chunk === undefined) continue;
      for (let index = 0; index < chunk.length; index += 1) {
        const material = chunk[index];
        if (material !== 0) usedMaterialIds.add(material as MaterialId);
      }
    }
  }
  const { palette, materialToIndex } = buildExportPalette(document, [
    ...usedMaterialIds,
  ]);

  const models: VoxExportModel[] = [];
  for (const node of voxelNodes) {
    const volume = getVolume(node.volumeId);
    if (volume === undefined) continue;
    const bounds = volume.occupiedBounds();
    if (bounds === undefined) continue; // empty volumes were reported
    // Map every voxel to VOX space first, then rebase by the VOX-space
    // minimum so the model always fits the unsigned cube.
    const mapped: VoxVoxel[] = [];
    for (const coordinate of volume.chunkCoordinates()) {
      const chunk = volume.getChunk(coordinate);
      if (chunk === undefined) continue;
      for (let index = 0; index < chunk.length; index += 1) {
        const material = chunk[index] as number;
        if (material === 0) continue;
        const local: Vec3i = [
          index % CHUNK_EDGE,
          Math.floor(index / CHUNK_EDGE) % CHUNK_EDGE,
          Math.floor(index / (CHUNK_EDGE * CHUNK_EDGE)),
        ];
        const editor: Vec3i = [
          coordinate[0] * 16 + local[0],
          coordinate[1] * 16 + local[1],
          coordinate[2] * 16 + local[2],
        ];
        const colorIndex = materialToIndex.get(material as MaterialId);
        if (colorIndex === undefined) {
          throw new WorkspaceError({
            family: "internal",
            code: "VOX_PALETTE_MISSING",
            message: "Material missing from the export palette",
            context: { material: String(material) },
          });
        }
        // (vox x, vox y, vox z) = (X, -Z, Y)
        const mappedY = -editor[2];
        mapped.push({
          x: editor[0],
          y: Object.is(mappedY, -0) ? 0 : mappedY,
          z: editor[1],
          colorIndex,
        });
      }
    }
    if (mapped.length === 0) continue;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const item of mapped) {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      minZ = Math.min(minZ, item.z);
      maxX = Math.max(maxX, item.x);
      maxY = Math.max(maxY, item.y);
      maxZ = Math.max(maxZ, item.z);
    }
    // Preflight guarantees non-negative VOX-space bounds unless rebasing;
    // with no rebase the model keeps its absolute (non-negative) origin.
    const rebase: Vec3i =
      choices.rebaseOrigins === true ? [minX, minY, minZ] : [0, 0, 0];
    const voxels: VoxVoxel[] = mapped.map((item) => ({
      x: item.x - rebase[0],
      y: item.y - rebase[1],
      z: item.z - rebase[2],
      colorIndex: item.colorIndex,
    }));
    voxels.sort(
      (a, b) =>
        a.x - b.x || a.y - b.y || a.z - b.z || a.colorIndex - b.colorIndex,
    );
    models.push({
      name: node.name ?? `Model ${String(models.length + 1)}`,
      sizeX: maxX - rebase[0] + 1,
      sizeY: maxY - rebase[1] + 1,
      sizeZ: maxZ - rebase[2] + 1,
      voxels,
      materialToIndex,
    });
  }
  return { palette, models, losses: preflight.losses };
}
