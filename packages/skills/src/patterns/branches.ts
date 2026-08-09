import type { GeneratorDefinition, GeneratorContext } from "../generator.js";
import { createCommandFactory } from "../generator.js";
import type { Command } from "@voxel-maker/commands";
import type { IntAabb, Vec3i } from "../geometry.js";
import { boxFromMinSize, minVec3, unionAabb } from "../geometry.js";
import { createSeededRandom, seededInt } from "../prng.js";
import { VEC3I_SCHEMA, boundedIntSchema } from "../schemas.js";

/**
 * Branches generator (plan S14.5, ticket #37): a deterministic branching
 * structure (tree-like) built from a trunk and `levels` generations of
 * axis-aligned segment boxes, all generic `voxel.fillBox` commands. The
 * branch directions are chosen by a seeded PRNG, so the same seed always
 * yields the identical structure while different seeds vary it; the
 * level and dimension bounds keep the proposal small.
 */

export type BranchesParams = {
  /** Min corner of the trunk base. */
  readonly base: Vec3i;
  /** Trunk height in voxels. */
  readonly trunkHeight: number;
  /** Trunk cross-section size in voxels. */
  readonly trunkSize: number;
  /** Number of branching generations after the trunk (1..4). */
  readonly levels: number;
  /** Segment length per branch generation. */
  readonly branchLength: number;
  /** Branch cross-section thickness in voxels. */
  readonly branchSize: number;
  /** Horizontal offset of each branch from its parent tip. */
  readonly spread: number;
  /** Vertical rise of each branch from its parent tip. */
  readonly rise: number;
};

export const MAX_BRANCH_LEVELS = 4;
export const MAX_BRANCH_LENGTH = 64;

const HORIZONTAL_DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Axis-aligned segment box from a to b with cross-section `thickness`. */
function segmentBox(a: Vec3i, b: Vec3i, thickness: number): IntAabb {
  const base = boxFromMinSize(minVec3(a, b), [
    Math.abs(b[0] - a[0]) + 1,
    Math.abs(b[1] - a[1]) + 1,
    Math.abs(b[2] - a[2]) + 1,
  ]);
  // Dominant axis determines the run; the two cross axes get the
  // thickness margin on their positive side.
  const dominant = dominantAxis(a, b);
  const max = [...base.max];
  for (let axis = 0; axis < 3; axis += 1) {
    if (axis !== dominant) max[axis] = (max[axis] as number) + (thickness - 1);
  }
  return {
    min: base.min,
    max: [max[0] as number, max[1] as number, max[2] as number],
  };
}

function dominantAxis(a: Vec3i, b: Vec3i): number {
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  const dz = Math.abs(b[2] - a[2]);
  if (dx >= dy && dx >= dz) return 0;
  if (dy >= dz) return 1;
  return 2;
}

export const BRANCHES_GENERATOR: GeneratorDefinition<BranchesParams> = {
  name: "generator.branches",
  version: 1,
  description:
    "Builds a deterministic branching structure from a trunk and up to 4 branch generations (voxel.fillBox segments, seeded variation).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      base: VEC3I_SCHEMA,
      trunkHeight: boundedIntSchema(1, 64),
      trunkSize: boundedIntSchema(1, 16),
      levels: boundedIntSchema(1, MAX_BRANCH_LEVELS),
      branchLength: boundedIntSchema(1, MAX_BRANCH_LENGTH),
      branchSize: boundedIntSchema(1, 8),
      spread: boundedIntSchema(1, 32),
      rise: boundedIntSchema(1, 32),
    },
    required: [
      "base",
      "trunkHeight",
      "trunkSize",
      "levels",
      "branchLength",
      "branchSize",
      "spread",
      "rise",
    ],
  },
  parse(value: unknown): BranchesParams {
    return value as BranchesParams;
  },
  propose(params: BranchesParams, context: GeneratorContext) {
    const commands = createCommandFactory(this, params, context);
    // The seeded source mixes the generator name so different generators
    // never share a sequence; the params are fixed per proposal.
    const random = createSeededRandom(`${this.name}:${context.seed}`);
    const proposed: Command[] = [];
    const trunk = boxFromMinSize(params.base, [
      params.trunkSize,
      params.trunkHeight,
      params.trunkSize,
    ]);
    proposed.push(commands.fillBox(trunk));
    let bounds: IntAabb = trunk;
    let tips: Vec3i[] = [
      [params.base[0], params.base[1] + params.trunkHeight, params.base[2]],
    ];
    for (let level = 0; level < params.levels; level += 1) {
      const nextTips: Vec3i[] = [];
      for (const tip of tips) {
        for (let branch = 0; branch < 2; branch += 1) {
          const [dx, dz] = HORIZONTAL_DIRECTIONS[
            seededInt(random, HORIZONTAL_DIRECTIONS.length)
          ] as readonly [number, number];
          const end: Vec3i = [
            tip[0] + dx * params.spread,
            tip[1] + params.rise,
            tip[2] + dz * params.spread,
          ];
          const segment = segmentBox(tip, end, params.branchSize);
          proposed.push(commands.fillBox(segment));
          bounds = unionAabb(bounds, segment);
          nextTips.push(end);
        }
      }
      tips = nextTips;
    }
    return { commands: proposed, bounds };
  },
};
