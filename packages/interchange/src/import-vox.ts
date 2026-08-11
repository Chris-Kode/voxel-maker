import {
  WorkspaceError,
  commandId,
  nodeId,
  transactionId,
  volumeId,
  type CommandId,
  type MaterialId,
  type NodeId,
  type TransactionId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { Transform } from "@voxel-maker/math";
import { canonicalColor } from "@voxel-maker/model";
import type { DocumentStoreRead } from "@voxel-maker/document";
import {
  CommandBus,
  createMaterialCommand,
  createNodeCommand,
  createVolumeCommand,
  type Command,
} from "@voxel-maker/commands";
import {
  DEFAULT_VOX_PARSE_LIMITS,
  mapVoxImport,
  parseVox,
  validateVoxParseLimits,
  type VoxParseLimits,
  type VoxWarning,
} from "@voxel-maker/formats";
import { hexColor } from "@voxel-maker/formats";

/**
 * VOX import service (plan S8.3, ticket #24): parses a VOX file with the
 * bounded codec and enters the mapped content into an open document through
 * ONE validated command transaction with source "import" and the caller's
 * observed revision. A malformed file, an id conflict, or a resource-limit
 * violation rejects the import atomically: no command is executed and no
 * state changes. Cancellation is checked before parsing and before commit;
 * the commit itself is atomic and synchronous, so a late signal never
 * leaves partial content.
 */

/** How many voxel entries one `volume.create` command may carry (budget). */
export const MAX_IMPORT_ENTRIES_PER_COMMAND = 50_000;

/** Options for one VOX import into an open document. */
export interface ImportVoxOptions {
  readonly bytes: Uint8Array;
  /** Revision the caller observed; mismatches reject with REVISION_CONFLICT. */
  readonly expectedRevision: number;
  readonly parseLimits?: VoxParseLimits;
  readonly signal?: AbortSignal;
  /** Fired between phases; `done`/`total` count voxels. */
  readonly onProgress?: (stage: string, done: number, total: number) => void;
  readonly transactionId?: TransactionId;
  readonly correlationId?: string;
  readonly label?: string;
}

/** Successful import outcome. */
export interface ImportVoxOutcome {
  readonly transactionId: TransactionId;
  readonly revisionAfter: number;
  readonly warnings: readonly VoxWarning[];
  readonly materialsCreated: number;
  readonly volumesCreated: number;
  readonly nodesCreated: number;
  readonly voxelsImported: number;
}

const identityTransform: Transform = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

const importCancelled = (): WorkspaceError =>
  new WorkspaceError({
    family: "conflict",
    code: "IMPORT_CANCELLED",
    message: "The import was cancelled",
  });

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw importCancelled();
};

/**
 * Imports one VOX file into the open document behind `bus`. The document
 * read surface `store` must be the bus's store (used for id collision
 * checks); both come from the same session.
 */
export function importVox(
  bus: CommandBus,
  store: DocumentStoreRead,
  options: ImportVoxOptions,
): ImportVoxOutcome {
  const parseLimits = options.parseLimits ?? DEFAULT_VOX_PARSE_LIMITS;
  throwIfAborted(options.signal);
  // The profile is validated at the interchange boundary before parsing or
  // mutation: callers may only lower the frozen hard defaults (issue #90).
  validateVoxParseLimits(parseLimits);
  const totalVoxels = options.bytes.byteLength;
  const parsed = parseVox(options.bytes, parseLimits);
  throwIfAborted(options.signal);
  options.onProgress?.("parse", totalVoxels, totalVoxels);

  const document = store.getDocument();
  const usedNodeIds = new Set(Object.keys(document.nodes));
  const usedVolumeIds = new Set(Object.keys(document.volumes));
  const usedMaterialIds = new Set(
    Object.keys(document.materials).map((key) => Number(key)),
  );
  const materialIdByIndex = new Map<number, MaterialId>();
  const materialCreated = new Set<MaterialId>();
  // Keyed by canonical RGB plus the exact palette alpha byte: two palette
  // entries that share RGB but differ in alpha are distinct materials and
  // must not be merged (issue #89).
  const materialCacheByColorAndAlpha = new Map<string, MaterialId>();

  const nextFreeMaterialId = (): MaterialId => {
    for (let candidate = 1; candidate <= 65_535; candidate += 1) {
      if (!usedMaterialIds.has(candidate)) {
        usedMaterialIds.add(candidate);
        return candidate as MaterialId;
      }
    }
    throw new WorkspaceError({
      family: "limit",
      code: "LIMIT_EXCEEDED",
      message: "No free material id remains in the document",
    });
  };

  const resolveMaterialId = (colorIndex: number): MaterialId => {
    const cached = materialIdByIndex.get(colorIndex);
    if (cached !== undefined) return cached;
    const color = parsed.palette[colorIndex];
    if (color === undefined) {
      throw new WorkspaceError({
        family: "internal",
        code: "VOX_PALETTE_MISSING",
        message: "Palette entry missing while importing",
        context: { colorIndex },
      });
    }
    const colorKey = hexColor(color);
    const cacheKey = `${colorKey}@${String(color.a)}`;
    const opacity = color.a / 255;
    const existingByColorAndAlpha = materialCacheByColorAndAlpha.get(cacheKey);
    if (existingByColorAndAlpha !== undefined) {
      materialIdByIndex.set(colorIndex, existingByColorAndAlpha);
      return existingByColorAndAlpha;
    }
    let resolved: MaterialId | undefined;
    // 1. Reuse an existing material with the identical color AND opacity;
    //    reusing on color alone would silently discard the palette alpha.
    for (const [id, record] of Object.entries(document.materials)) {
      if (record.color === colorKey && record.opacity === opacity) {
        resolved = Number(id) as MaterialId;
        break;
      }
    }
    // 2. Prefer the palette index when it is free; 3. lowest free id.
    if (resolved === undefined) {
      const candidate = colorIndex as MaterialId;
      if (!usedMaterialIds.has(candidate)) {
        resolved = candidate;
      } else {
        resolved = nextFreeMaterialId();
      }
    }
    usedMaterialIds.add(resolved);
    materialCacheByColorAndAlpha.set(cacheKey, resolved);
    materialIdByIndex.set(colorIndex, resolved);
    return resolved;
  };

  const nextNodeId = (preferred: NodeId): NodeId => {
    let node = preferred;
    let counter = 1;
    while (usedNodeIds.has(node)) {
      node = nodeId(`${preferred}:${String(counter).padStart(3, "0")}`);
      counter += 1;
    }
    usedNodeIds.add(node);
    return node;
  };

  const nextVolumeId = (preferred: VolumeId): VolumeId => {
    let volume = preferred;
    let counter = 1;
    while (usedVolumeIds.has(volume)) {
      volume = volumeId(`${preferred}:${String(counter).padStart(3, "0")}`);
      counter += 1;
    }
    usedVolumeIds.add(volume);
    return volume;
  };

  const plan = mapVoxImport(parsed, {
    nodeId: (index) =>
      nextNodeId(nodeId(`node:import:${String(index + 1).padStart(4, "0")}`)),
    volumeId: (index) =>
      nextVolumeId(
        volumeId(`volume:import:${String(index + 1).padStart(4, "0")}`),
      ),
    materialId: resolveMaterialId,
  });

  // Compile commands: materials first, then volume.create (split into
  // payload-bounded commands, first one carrying the descriptor), then
  // root-level nodes with voxel components.
  // Issue #115: a command id is the unique identity of one committed
  // transaction on the open bus, so the per-import serial alone would
  // collide across imports (`command:import:000001` repeats for every
  // import). The namespace includes the observed revision: every
  // committed import on a bus targets a distinct expectedRevision, which
  // keeps ids unique while staying deterministic (ADR-0003).
  const commands: Command[] = [];
  let serial = 0;
  const importNamespace = String(options.expectedRevision).padStart(4, "0");
  const nextCommandId = (): CommandId => {
    serial += 1;
    return commandId(
      `command:import:${importNamespace}:${String(serial).padStart(6, "0")}`,
    );
  };
  for (const material of plan.materials) {
    if (materialCreated.has(material.materialId)) continue;
    const existing = document.materials[material.materialId];
    if (
      existing !== undefined &&
      existing.color === material.color &&
      existing.opacity === material.opacity
    ) {
      continue; // identical material already in the document
    }
    materialCreated.add(material.materialId);
    commands.push(
      createMaterialCommand(nextCommandId(), {
        materialId: material.materialId,
        name: material.name,
        color: canonicalColor(material.color),
        opacity: material.opacity,
        roughness: 0,
        metallic: 0,
        emissive: 0,
      }),
    );
  }
  let voxelsImported = 0;
  for (const volume of plan.volumes) {
    const entries = volume.entries;
    if (entries.length === 0) {
      commands.push(
        createVolumeCommand(nextCommandId(), {
          volumeId: volume.volumeId,
          name: volume.name,
          bounds: volume.bounds,
        }),
      );
      continue;
    }
    for (
      let offset = 0;
      offset < entries.length;
      offset += MAX_IMPORT_ENTRIES_PER_COMMAND
    ) {
      const slice = entries.slice(
        offset,
        Math.min(offset + MAX_IMPORT_ENTRIES_PER_COMMAND, entries.length),
      );
      commands.push(
        createVolumeCommand(nextCommandId(), {
          volumeId: volume.volumeId,
          ...(offset === 0 ? { name: volume.name } : {}),
          ...(offset === 0 ? { bounds: volume.bounds } : {}),
          entries: slice,
        }),
      );
      voxelsImported += slice.length;
    }
  }
  for (const node of plan.nodes) {
    const volume = plan.volumes.find(
      (candidate: { readonly volumeId: VolumeId }) =>
        candidate.volumeId === node.volumeId,
    );
    if (volume === undefined) {
      throw new WorkspaceError({
        family: "internal",
        code: "IMPORT_PLAN_MISMATCH",
        message: "Import plan node references an unknown volume",
        context: { nodeId: node.nodeId },
      });
    }
    commands.push(
      createNodeCommand(nextCommandId(), {
        nodeId: node.nodeId,
        name: node.name,
        parentId: document.rootNodeId,
        transform: identityTransform,
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: node.volumeId },
        ],
      }),
    );
  }

  throwIfAborted(options.signal);
  const transactionIdValue =
    options.transactionId ??
    transactionId(
      `transaction:import:${String(options.expectedRevision + 1).padStart(4, "0")}`,
    );
  const result = bus.executeTransaction(commands, {
    transactionId: transactionIdValue,
    expectedRevision: options.expectedRevision,
    source: "import",
    ...(options.correlationId !== undefined
      ? { correlationId: options.correlationId }
      : {}),
    ...(options.label !== undefined ? { label: options.label } : {}),
  });
  if (!result.ok) {
    throw result.error;
  }
  options.onProgress?.("commit", voxelsImported, voxelsImported);
  return {
    transactionId: result.value.transactionId,
    revisionAfter: result.value.revisionAfter,
    warnings: plan.warnings,
    materialsCreated: materialCreated.size,
    volumesCreated: plan.volumes.length,
    nodesCreated: plan.nodes.length,
    voxelsImported,
  };
}
