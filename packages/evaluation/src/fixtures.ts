import type {
  DocumentCommitted,
  DocumentStoreHandle,
  DocumentStoreRead,
} from "@voxel-maker/document";
import { createDocumentStore } from "@voxel-maker/document";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import type { EditorSelectionSnapshot } from "@voxel-maker/agent";

/**
 * Deterministic evaluation fixtures (plan S12.12, ticket #35): the fixed
 * starting documents and selections of the AI geometry evaluation suite.
 * Every fixture uses stable branded ids, canonical materials, and a fixed
 * voxel layout, so a scenario's input document hash and its golden
 * behavior are stable across machines and runs.
 */

/** Stable fixture ids shared by every scenario. */
export const EVAL_IDS = {
  document: documentId("document:eval:chair:0001"),
  root: nodeId("node:chair"),
  volumeMain: volumeId("volume:main"),
  materialWood: materialId(1),
  materialRed: materialId(2),
} as const;

/** The chair's canonical material (wood, `#8b5a2b`). */
export const EVAL_WOOD_COLOR = "#8b5a2b";
/** The red seat material used by the red-seat scenario (`#ff0000`). */
export const EVAL_RED_COLOR = "#ff0000";

/** Builds a typed half-open region (contextual Vec3i tuples). */
export function regionOf(min: Vec3i, max: Vec3i): IntAabb {
  return { min, max };
}

/** Half-open regions of the fixed chair shape (X right, Y up, Z forward). */
export const CHAIR_REGIONS = Object.freeze({
  /** 8x2x8 seat slab: y in [4,6). */
  seat: regionOf([0, 4, 0], [8, 6, 8]),
  /** 8x4x2 backrest slab at the rear: y in [6,10), z in [6,8). */
  back: regionOf([0, 6, 6], [8, 10, 8]),
  /** The four 1x4x1 leg columns at the seat corners, y in [0,4). */
  leg1: regionOf([1, 0, 1], [2, 4, 2]),
  leg2: regionOf([6, 0, 1], [7, 4, 2]),
  leg3: regionOf([1, 0, 6], [2, 4, 7]),
  leg4: regionOf([6, 0, 6], [7, 4, 7]),
  /** 1x2x8 left armrest slab: x in [0,1), y in [5,7) (mirror scenario). */
  leftArmrest: regionOf([0, 5, 0], [1, 7, 8]),
  /** Whole-chair bounding region used by the mirror scenario. */
  wholeChair: regionOf([0, 0, 0], [8, 10, 8]),
  /** Bottom two rows of every leg (shorter-legs scenario target). */
  legBottoms: regionOf([0, 0, 0], [8, 2, 8]),
} as const);

/** The exact 208-voxel chair shape: seat + four legs + backrest. */
/** The four leg columns as a stable ordered list. */
export const CHAIR_LEGS: readonly IntAabb[] = Object.freeze([
  CHAIR_REGIONS.leg1,
  CHAIR_REGIONS.leg2,
  CHAIR_REGIONS.leg3,
  CHAIR_REGIONS.leg4,
]);

/** The exact 208-voxel chair shape: seat + four legs + backrest. */
export const CHAIR_SHAPE: readonly IntAabb[] = Object.freeze([
  CHAIR_REGIONS.seat,
  ...CHAIR_LEGS,
  CHAIR_REGIONS.back,
]);

/** The 224-voxel chair shape with the left armrest (mirror scenario). */
export const CHAIR_SHAPE_WITH_ARMREST: readonly IntAabb[] = Object.freeze([
  ...CHAIR_SHAPE,
  CHAIR_REGIONS.leftArmrest,
]);

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

/** The single scaffold layout shared by every evaluation document. */
function createEvalDocument(
  title: string,
  tags: readonly string[],
): VoxelDocument {
  return createDocument({
    documentId: EVAL_IDS.document,
    metadata: { title, tags: [...tags] },
    rootNodeId: EVAL_IDS.root,
    nodes: [
      {
        nodeId: EVAL_IDS.root,
        name: "Chair",
        parentId: null,
        children: [],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: EVAL_IDS.volumeMain,
          },
        ],
      },
    ],
    materials: [
      {
        materialId: EVAL_IDS.materialWood,
        name: "wood",
        color: EVAL_WOOD_COLOR,
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      {
        volumeId: EVAL_IDS.volumeMain,
        name: "main",
        bounds: { min: [0, 0, 0], max: [8, 10, 8] },
      },
    ],
  });
}

/** Builds the frozen chair document (optionally with the left armrest). */
export function createChairDocument(withArmrest = false): VoxelDocument {
  return createEvalDocument(withArmrest ? "chair with left armrest" : "chair", [
    "eval",
    "fixture",
    "chair",
  ]);
}

/** Builds the empty scaffold document used by the chair-create scenario. */
export function createEmptyScaffoldDocument(): VoxelDocument {
  return createEvalDocument("empty scaffold", ["eval", "fixture"]);
}

/**
 * Commits fixed voxels into the store as ONE atomic transaction: the
 * entries are written through the store's staging surface and committed
 * with a fixed transaction id and event, so the committed store is
 * byte-deterministic (same document hash on every run).
 */
export function commitFixtureVoxels(
  handle: DocumentStoreHandle,
  entries: readonly {
    readonly coordinate: Vec3i;
    readonly material: MaterialId;
  }[],
  transactionSuffix: string,
): void {
  const { store, writeCapability } = handle;
  const staged = store.stageVolume(EVAL_IDS.volumeMain);
  if (staged === undefined) throw new Error("eval fixture volume missing");
  for (const entry of entries) {
    staged.setVoxel(entry.coordinate, entry.material, writeCapability);
  }
  const document = {
    ...store.getDocument(),
    revision: store.revision + 1,
  };
  const event: DocumentCommitted = {
    revisionBefore: store.revision,
    revisionAfter: store.revision + 1,
    transactionId: transactionId(`transaction:eval:${transactionSuffix}`),
    source: "system",
    commandIds: [commandId(`command:eval:seed:${transactionSuffix}`)],
    commandTypes: ["seedFixtureVoxels"],
    changedNodeIds: [],
    changedMaterialIds: [],
    changedAnimationIds: [],
    changedVolumes: [
      {
        volumeId: EVAL_IDS.volumeMain,
        chunks: [],
        bounds: { min: [0, 0, 0], max: [8, 10, 8] },
      },
    ],
  };
  store.commit(
    {
      document,
      volumes: new Map([[EVAL_IDS.volumeMain, staged]]),
      removedVolumes: [],
    },
    event,
    writeCapability,
  );
}

/** Enumerates every integer coordinate of a half-open region (bounded). */
export function regionCoordinates(region: IntAabb): readonly Vec3i[] {
  const coordinates: Vec3i[] = [];
  for (let x = region.min[0]; x < region.max[0]; x += 1) {
    for (let y = region.min[1]; y < region.max[1]; y += 1) {
      for (let z = region.min[2]; z < region.max[2]; z += 1) {
        coordinates.push([x, y, z]);
      }
    }
  }
  return coordinates;
}

/** Stable string key of one voxel coordinate (canonical set/diff identity). */
export function voxelKey(coordinate: Vec3i): string {
  return `${String(coordinate[0])},${String(coordinate[1])},${String(coordinate[2])}`;
}

/** All voxel entries of a set of regions with one material (fixed order). */
export function shapeEntries(
  regions: readonly IntAabb[],
  material: MaterialId,
): readonly { readonly coordinate: Vec3i; readonly material: MaterialId }[] {
  const entries: { coordinate: Vec3i; material: MaterialId }[] = [];
  for (const region of regions) {
    for (const coordinate of regionCoordinates(region)) {
      entries.push({ coordinate, material });
    }
  }
  return entries;
}

/** Builds the committed chair store (optionally with the left armrest). */
export function createChairStore(withArmrest = false): {
  readonly store: DocumentStoreRead;
  readonly handle: DocumentStoreHandle;
} {
  const handle = createDocumentStore({
    document: createChairDocument(withArmrest),
  });
  commitFixtureVoxels(
    handle,
    shapeEntries(
      withArmrest ? CHAIR_SHAPE_WITH_ARMREST : CHAIR_SHAPE,
      EVAL_IDS.materialWood,
    ),
    withArmrest ? "chair-with-armrest" : "chair",
  );
  return { store: handle.store, handle };
}

/** Builds the committed empty scaffold store (chair-create scenario). */
export function createEmptyScaffoldStore(): {
  readonly store: DocumentStoreRead;
  readonly handle: DocumentStoreHandle;
} {
  const handle = createDocumentStore({
    document: createEmptyScaffoldDocument(),
  });
  return { store: handle.store, handle };
}

/** A deterministic selection port over fixed snapshot entries. */
export function createEvalSelectionPort(
  selection: readonly EditorSelectionSnapshot[],
): { getSelection(): readonly EditorSelectionSnapshot[] } {
  return { getSelection: () => selection };
}

/** Region selection snapshot used by the follow-up scenarios. */
export function regionSelection(
  volumeId: VolumeId,
  region: IntAabb,
): EditorSelectionSnapshot {
  return {
    kind: "region",
    volumeId,
    region: {
      min: [region.min[0], region.min[1], region.min[2]],
      max: [region.max[0], region.max[1], region.max[2]],
    },
  };
}
