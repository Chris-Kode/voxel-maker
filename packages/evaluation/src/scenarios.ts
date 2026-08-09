import type { DocumentStoreRead } from "@voxel-maker/document";
import type {
  DeterministicStep,
  EditorSelectionSnapshot,
  ToolCall,
} from "@voxel-maker/agent";
import type { IntAabb } from "@voxel-maker/math";
import type { MaterialId } from "@voxel-maker/shared";
import { STANDARD_PREVIEW_VIEWS } from "@voxel-maker/renderer";
import {
  CHAIR_REGIONS,
  CHAIR_SHAPE,
  CHAIR_SHAPE_WITH_ARMREST,
  CHAIR_LEGS,
  EVAL_IDS,
  EVAL_RED_COLOR,
  regionOf,
  regionSelection,
} from "./fixtures.js";
import {
  colorUsed,
  occupiedMetrics,
  regionEmpty,
  regionFilled,
  regionHasMaterial,
  symmetryScore,
} from "./metrics.js";
import {
  redPixelRatio,
  silhouetteSimilarity,
  type PreviewEvidenceSet,
} from "./previews.js";

const STANDARD_VIEWS = STANDARD_PREVIEW_VIEWS;

/**
 * Fixed geometry evaluation scenarios (plan S12.12/S12.13, ticket #35):
 * the four promotion-relevant workflows — initial chair creation, shorter
 * legs, a red seat, and left-side mirroring — each with a deterministic
 * starting document and selection, a fixed user prompt, a golden recorded
 * tool trace, task-completion checks, minimal-diff allowances, and
 * rendered-preview signals.
 */

export type ScenarioId =
  | "chair-create"
  | "shorter-legs"
  | "red-seat"
  | "mirror-left";

/** One semantic check over the resulting document. */
export interface TaskCheck {
  readonly name: string;
  readonly check: (store: DocumentStoreRead) => boolean;
}

/** One rendered-preview signal over the before/after evidence sets. */
export interface PreviewSignal {
  readonly name: string;
  readonly check: (
    before: PreviewEvidenceSet,
    after: PreviewEvidenceSet,
  ) => boolean;
}

/** One fixed evaluation scenario. */
export interface GeometryScenario {
  readonly id: ScenarioId;
  readonly name: string;
  readonly description: string;
  /**
   * True when occupancy must match the expected shape exactly (creation
   * scenarios): any voxel outside the expected shape counts as an
   * unrelated change even though the whole volume is the allowed region.
   */
  readonly strictShape: boolean;
  /** The fixed user prompt (recorded as the scenario prompt version). */
  readonly prompt: string;
  readonly fixtureVersion: string;
  readonly fixture: "empty-scaffold" | "chair" | "chair-armrest";
  /** Deterministic starting selection snapshots (empty = none). */
  readonly selection: readonly EditorSelectionSnapshot[];
  /** Golden recorded tool trace (deterministic provider script). */
  readonly goldenTrace: readonly DeterministicStep[];
  readonly goldenRounds: number;
  readonly goldenToolCalls: number;
  readonly goldenCommands: number;
  /** Bounded scan region for every voxel metric of the scenario. */
  readonly scanRegion: IntAabb;
  /** Voxel changes outside this region count as unrelated. */
  readonly allowedChangedRegion: IntAabb;
  /** Material ids the scenario is allowed to add (none may be updated). */
  readonly allowedAddedMaterials: readonly MaterialId[];
  /** Exact expected occupancy (chair-create: nothing outside the shape). */
  readonly expectedShape: readonly IntAabb[];
  /** Semantic completion checks over the resulting document. */
  readonly taskChecks: readonly TaskCheck[];
  /** Rendered-preview signals over before/after evidence. */
  readonly previewSignals: readonly PreviewSignal[];
}

/** JSON-safe region value for tool-call arguments. */
const box = (
  r: IntAabb,
): { readonly min: readonly number[]; readonly max: readonly number[] } => ({
  min: [...r.min],
  max: [...r.max],
});

/** Trace helpers: minimal valid tool calls. */
const summary = (id = "call_summary"): ToolCall => ({
  id,
  name: "inspectSummary",
  arguments: {},
});
const getSelection = (id = "call_selection"): ToolCall => ({
  id,
  name: "getSelection",
  arguments: {},
});
const fillBox = (
  id: string,
  region: IntAabb,
  material: MaterialId,
): ToolCall => ({
  id,
  name: "fillBox",
  arguments: { volumeId: EVAL_IDS.volumeMain, region: box(region), material },
});
const deleteRegion = (id: string, region: IntAabb): ToolCall => ({
  id,
  name: "deleteRegion",
  arguments: { volumeId: EVAL_IDS.volumeMain, region: box(region) },
});
const createMaterial = (
  id: string,
  materialId: MaterialId,
  name: string,
  color: string,
): ToolCall => ({
  id,
  name: "createMaterial",
  arguments: { materialId, name, color },
});
const replaceVoxelMaterial = (
  id: string,
  region: IntAabb,
  fromMaterial: MaterialId,
  toMaterial: MaterialId,
): ToolCall => ({
  id,
  name: "replaceVoxelMaterial",
  arguments: {
    volumeId: EVAL_IDS.volumeMain,
    region: box(region),
    fromMaterial,
    toMaterial,
  },
});
const copyRegion = (
  id: string,
  source: IntAabb,
  destination: readonly [number, number, number],
): ToolCall => ({
  id,
  name: "copyRegion",
  arguments: {
    volumeId: EVAL_IDS.volumeMain,
    source: box(source),
    destination: [...destination],
  },
});

/** Shared signal: every rendered view completed and the edit changed pixels. */
const CHANGED_SIGNAL: PreviewSignal = {
  name: "rendered previews complete and differ",
  check: (before, after) => {
    if (!before.completed || !after.completed) return false;
    return STANDARD_VIEWS.some((view) => {
      const b = before.views[view];
      const a = after.views[view];
      return b.pixelHash !== a.pixelHash;
    });
  },
};

const SIMILARITY_SIGNAL = (minimum: number): PreviewSignal => ({
  name: `normalized silhouette similarity >= ${String(minimum)}`,
  check: (before, after) => {
    if (!before.completed || !after.completed) return false;
    return STANDARD_VIEWS.every((view) => {
      const b = before.views[view];
      const a = after.views[view];
      return silhouetteSimilarity(b.rgba, a.rgba) >= minimum;
    });
  },
});

const RED_PRESENCE_SIGNAL: PreviewSignal = {
  name: "red pixels present in a rendered view",
  check: (_before, after) => {
    if (!after.completed) return false;
    return STANDARD_VIEWS.some(
      (view) => redPixelRatio(after.views[view].rgba) > 0,
    );
  },
};

const NONEMPTY_SIGNAL: PreviewSignal = {
  name: "after render has a non-empty silhouette",
  check: (_before, after) => {
    if (!after.completed) return false;
    return after.silhouettePixels > 0;
  },
};

/** chair-create: empty scaffold document, no selection. */
const CHAIR_CREATE: GeometryScenario = {
  id: "chair-create",
  name: "Initial chair creation",
  strictShape: true,
  description:
    "Create a complete chair (seat, four legs, backrest) from the deterministic empty scaffold document.",
  prompt: "Create a chair with a seat, four legs, and a backrest.",
  fixtureVersion: "v1",
  fixture: "empty-scaffold",
  selection: [],
  goldenTrace: [
    {
      text: "I will inspect the empty scaffold first.",
      toolCalls: [summary()],
    },
    {
      text: "Building the seat.",
      toolCalls: [
        fillBox("call_seat", CHAIR_REGIONS.seat, EVAL_IDS.materialWood),
      ],
    },
    {
      text: "Building leg 1.",
      toolCalls: [
        fillBox("call_leg1", CHAIR_REGIONS.leg1, EVAL_IDS.materialWood),
      ],
    },
    {
      text: "Building leg 2.",
      toolCalls: [
        fillBox("call_leg2", CHAIR_REGIONS.leg2, EVAL_IDS.materialWood),
      ],
    },
    {
      text: "Building leg 3.",
      toolCalls: [
        fillBox("call_leg3", CHAIR_REGIONS.leg3, EVAL_IDS.materialWood),
      ],
    },
    {
      text: "Building leg 4.",
      toolCalls: [
        fillBox("call_leg4", CHAIR_REGIONS.leg4, EVAL_IDS.materialWood),
      ],
    },
    {
      text: "Building the backrest.",
      toolCalls: [
        fillBox("call_back", CHAIR_REGIONS.back, EVAL_IDS.materialWood),
      ],
    },
    {
      text: "Verifying the staged result.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The chair proposal is ready for approval." },
  ],
  goldenRounds: 9,
  goldenToolCalls: 8,
  goldenCommands: 6,
  scanRegion: CHAIR_REGIONS.wholeChair,
  allowedChangedRegion: CHAIR_REGIONS.wholeChair,
  allowedAddedMaterials: [],
  expectedShape: CHAIR_SHAPE,
  taskChecks: [
    {
      name: "total voxel count is the 208-voxel chair",
      check: (store) =>
        occupiedMetrics(store, EVAL_IDS.volumeMain, CHAIR_REGIONS.wholeChair)
          .voxelCount === 208,
    },
    {
      name: "occupied bounds are [0,8)x[0,10)x[0,8)",
      check: (store) => {
        const bounds = occupiedMetrics(
          store,
          EVAL_IDS.volumeMain,
          CHAIR_REGIONS.wholeChair,
        ).bounds;
        return (
          bounds !== undefined &&
          bounds.min[0] === 0 &&
          bounds.min[1] === 0 &&
          bounds.min[2] === 0 &&
          bounds.max[0] === 8 &&
          bounds.max[1] === 10 &&
          bounds.max[2] === 8
        );
      },
    },
    {
      name: "seat region is filled",
      check: (store) =>
        regionFilled(store, EVAL_IDS.volumeMain, CHAIR_REGIONS.seat),
    },
    {
      name: "all four legs are filled",
      check: (store) =>
        CHAIR_LEGS.every((leg) =>
          regionFilled(store, EVAL_IDS.volumeMain, leg),
        ),
    },
    {
      name: "backrest region is filled",
      check: (store) =>
        regionFilled(store, EVAL_IDS.volumeMain, CHAIR_REGIONS.back),
    },
  ],
  previewSignals: [CHANGED_SIGNAL, NONEMPTY_SIGNAL],
};

/** shorter-legs: full chair, bottom halves of the legs selected. */
const SHORTER_LEGS: GeometryScenario = {
  id: "shorter-legs",
  strictShape: false,
  name: "Shorter chair legs",
  description:
    "Shorten every chair leg by removing its bottom two rows; the seat and backrest must stay untouched.",
  prompt:
    "Make the chair legs shorter by removing the bottom half of each leg.",
  fixtureVersion: "v1",
  fixture: "chair",
  selection: [regionSelection(EVAL_IDS.volumeMain, CHAIR_REGIONS.legBottoms)],
  goldenTrace: [
    {
      text: "I will inspect the chair and the selected legs.",
      toolCalls: [summary()],
    },
    { text: "Checking the selection context.", toolCalls: [getSelection()] },
    {
      text: "Removing the bottom two rows of every leg.",
      toolCalls: [deleteRegion("call_shorten", CHAIR_REGIONS.legBottoms)],
    },
    {
      text: "Verifying the staged result.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The shortened-leg proposal is ready for approval." },
  ],
  goldenRounds: 5,
  goldenToolCalls: 4,
  goldenCommands: 1,
  scanRegion: CHAIR_REGIONS.wholeChair,
  allowedChangedRegion: CHAIR_REGIONS.legBottoms,
  allowedAddedMaterials: [],
  expectedShape: CHAIR_SHAPE,
  taskChecks: [
    {
      name: "total voxel count is 200 (eight leg voxels removed)",
      check: (store) =>
        occupiedMetrics(store, EVAL_IDS.volumeMain, CHAIR_REGIONS.wholeChair)
          .voxelCount === 200,
    },
    {
      name: "leg bottoms are empty and leg tops remain",
      check: (store) => {
        const bottom = regionOf([0, 0, 0], [8, 2, 8]);
        const top = regionOf([0, 2, 0], [8, 4, 8]);
        return (
          CHAIR_LEGS.every((leg) => {
            const bottomHalf = regionOf(
              [leg.min[0], leg.min[1], leg.min[2]],
              [leg.max[0], leg.min[1] + 2, leg.max[2]],
            );
            const topHalf = regionOf(
              [leg.min[0], leg.min[1] + 2, leg.min[2]],
              [leg.max[0], leg.max[1], leg.max[2]],
            );
            return (
              regionEmpty(store, EVAL_IDS.volumeMain, bottomHalf) &&
              regionFilled(store, EVAL_IDS.volumeMain, topHalf)
            );
          }) &&
          regionEmpty(store, EVAL_IDS.volumeMain, bottom) &&
          !regionEmpty(store, EVAL_IDS.volumeMain, top)
        );
      },
    },
    {
      name: "seat is unchanged",
      check: (store) =>
        regionHasMaterial(
          store,
          EVAL_IDS.volumeMain,
          CHAIR_REGIONS.seat,
          EVAL_IDS.materialWood,
        ),
    },
    {
      name: "backrest is unchanged",
      check: (store) =>
        regionHasMaterial(
          store,
          EVAL_IDS.volumeMain,
          CHAIR_REGIONS.back,
          EVAL_IDS.materialWood,
        ),
    },
    {
      name: "lowest occupied row is y=2",
      check: (store) => {
        const bounds = occupiedMetrics(
          store,
          EVAL_IDS.volumeMain,
          CHAIR_REGIONS.wholeChair,
        ).bounds;
        return bounds !== undefined && bounds.min[1] === 2;
      },
    },
  ],
  previewSignals: [CHANGED_SIGNAL, SIMILARITY_SIGNAL(0.9)],
};

/** red-seat: full chair, seat region selected. */
const RED_SEAT: GeometryScenario = {
  id: "red-seat",
  strictShape: false,
  name: "Red seat",
  description:
    "Recolor only the seat voxels red via a new red material; legs and backrest keep the wood material.",
  prompt: "Make the seat red.",
  fixtureVersion: "v1",
  fixture: "chair",
  selection: [regionSelection(EVAL_IDS.volumeMain, CHAIR_REGIONS.seat)],
  goldenTrace: [
    { text: "I will inspect the chair materials.", toolCalls: [summary()] },
    {
      text: "Creating a red material.",
      toolCalls: [
        createMaterial("call_mat", EVAL_IDS.materialRed, "red", EVAL_RED_COLOR),
      ],
    },
    {
      text: "Painting only the seat voxels red.",
      toolCalls: [
        replaceVoxelMaterial(
          "call_paint",
          CHAIR_REGIONS.seat,
          EVAL_IDS.materialWood,
          EVAL_IDS.materialRed,
        ),
      ],
    },
    {
      text: "Verifying the staged result.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The red-seat proposal is ready for approval." },
  ],
  goldenRounds: 5,
  goldenToolCalls: 4,
  goldenCommands: 2,
  scanRegion: CHAIR_REGIONS.wholeChair,
  allowedChangedRegion: CHAIR_REGIONS.seat,
  allowedAddedMaterials: [EVAL_IDS.materialRed],
  expectedShape: CHAIR_SHAPE,
  taskChecks: [
    {
      name: "a #ff0000 material exists",
      check: (store) =>
        store.getDocument().materials[EVAL_IDS.materialRed]?.color ===
        EVAL_RED_COLOR,
    },
    {
      name: "seat voxels use the red material",
      check: (store) =>
        regionHasMaterial(
          store,
          EVAL_IDS.volumeMain,
          CHAIR_REGIONS.seat,
          EVAL_IDS.materialRed,
        ),
    },
    {
      name: "legs keep the wood material",
      check: (store) =>
        CHAIR_LEGS.every((leg) =>
          regionHasMaterial(
            store,
            EVAL_IDS.volumeMain,
            leg,
            EVAL_IDS.materialWood,
          ),
        ),
    },
    {
      name: "backrest keeps the wood material",
      check: (store) =>
        regionHasMaterial(
          store,
          EVAL_IDS.volumeMain,
          CHAIR_REGIONS.back,
          EVAL_IDS.materialWood,
        ),
    },
    {
      name: "red is used on the seat",
      check: (store) =>
        colorUsed(
          store,
          EVAL_RED_COLOR,
          EVAL_IDS.volumeMain,
          CHAIR_REGIONS.seat,
        ),
    },
    {
      name: "occupied voxel count is unchanged (208)",
      check: (store) =>
        occupiedMetrics(store, EVAL_IDS.volumeMain, CHAIR_REGIONS.wholeChair)
          .voxelCount === 208,
    },
  ],
  previewSignals: [
    CHANGED_SIGNAL,
    RED_PRESENCE_SIGNAL,
    SIMILARITY_SIGNAL(0.95),
  ],
};

/** mirror-left: chair with a left armrest, whole chair selected. */
const MIRROR_LEFT: GeometryScenario = {
  id: "mirror-left",
  strictShape: false,
  name: "Left-side mirroring",
  description:
    "Mirror the left armrest to the right side across the chair's symmetry plane (x=4) so the chair becomes symmetric. The tool surface's voxel.mirrorRegion has move semantics (the destination is the source region), so the minimal-diff realization of a copy mirror is voxel.copyRegion anchored at the mirrored position.",
  prompt: "Mirror the left side to the right side to make the chair symmetric.",
  fixtureVersion: "v1",
  fixture: "chair-armrest",
  selection: [regionSelection(EVAL_IDS.volumeMain, CHAIR_REGIONS.wholeChair)],
  goldenTrace: [
    {
      text: "I will inspect the chair with the left armrest.",
      toolCalls: [summary()],
    },
    {
      text: "Copying the left armrest to its mirrored position at x in [7,8).",
      toolCalls: [
        copyRegion("call_copy", CHAIR_REGIONS.leftArmrest, [7, 5, 0]),
      ],
    },
    {
      text: "Verifying the staged result.",
      toolCalls: [summary("call_summary2")],
    },
    { text: "The mirrored proposal is ready for approval." },
  ],
  goldenRounds: 4,
  goldenToolCalls: 3,
  goldenCommands: 1,
  scanRegion: CHAIR_REGIONS.wholeChair,
  allowedChangedRegion: CHAIR_REGIONS.wholeChair,
  allowedAddedMaterials: [],
  expectedShape: CHAIR_SHAPE_WITH_ARMREST,
  taskChecks: [
    {
      name: "symmetry score across x=4 is 1.0",
      check: (store) =>
        symmetryScore(
          store,
          EVAL_IDS.volumeMain,
          CHAIR_REGIONS.wholeChair,
          "x",
          4,
        ).score === 1,
    },
    {
      name: "a right armrest exists at x in [7,8)",
      check: (store) => {
        const rightArmrest = regionOf([7, 5, 0], [8, 7, 8]);
        return regionHasMaterial(
          store,
          EVAL_IDS.volumeMain,
          rightArmrest,
          EVAL_IDS.materialWood,
        );
      },
    },
    {
      name: "the left armrest is unchanged",
      check: (store) =>
        regionHasMaterial(
          store,
          EVAL_IDS.volumeMain,
          CHAIR_REGIONS.leftArmrest,
          EVAL_IDS.materialWood,
        ),
    },
    {
      name: "total voxel count is 220 (armrest copied, not moved)",
      check: (store) =>
        occupiedMetrics(store, EVAL_IDS.volumeMain, CHAIR_REGIONS.wholeChair)
          .voxelCount === 220,
    },
  ],
  previewSignals: [CHANGED_SIGNAL, SIMILARITY_SIGNAL(0.9)],
};

/** All four fixed scenarios in canonical order. */
export const GEOMETRY_SCENARIOS: readonly GeometryScenario[] = Object.freeze([
  CHAIR_CREATE,
  SHORTER_LEGS,
  RED_SEAT,
  MIRROR_LEFT,
]);

/** Scenario lookup by id (stable). */
export function scenarioById(id: ScenarioId): GeometryScenario {
  const scenario = GEOMETRY_SCENARIOS.find((entry) => entry.id === id);
  if (scenario === undefined) {
    throw new Error(`Unknown evaluation scenario: ${id}`);
  }
  return scenario;
}
