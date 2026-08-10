import { describe, expect, it } from "vitest";
import { canonicalJson } from "@voxel-maker/shared";
import {
  VOXEL_COPY_REGION_COMMAND,
  VOXEL_DELETE_REGION_COMMAND,
  VOXEL_FILL_BOX_COMMAND,
  VOXEL_FILL_CYLINDER_COMMAND,
  VOXEL_MIRROR_REGION_COMMAND,
} from "@voxel-maker/commands";
import { proposeGenerator } from "./registry.js";
import { FIXTURE_IDS } from "./fixtures.js";

/**
 * Pattern tests (plan S14.4/S14.5, ticket #37, AC2): every repetition /
 * symmetry / structural pattern is deterministic, preflights its cost,
 * and composes only generic registered commands.
 */

const CONTEXT = {
  volumeId: FIXTURE_IDS.volume,
  material: FIXTURE_IDS.material,
  seed: "pattern-seed",
};

describe("generator.mirror", () => {
  it("mirrors a region with one generic mirrorRegion command", () => {
    const proposal = proposeGenerator(
      "generator.mirror",
      { region: { min: [0, 0, 0], max: [4, 4, 4] }, axis: "x" },
      CONTEXT,
    );
    expect(proposal.commandCount).toBe(1);
    expect(proposal.commands[0]?.type).toBe(VOXEL_MIRROR_REGION_COMMAND);
    expect(proposal.voxelEstimate).toBe(64);
    expect(proposal.bounds).toEqual({ min: [0, 0, 0], max: [4, 4, 4] });
  });

  it("is deterministic and rejects inverted regions", () => {
    const params = { region: { min: [0, 0, 0], max: [2, 2, 2] }, axis: "z" };
    const first = proposeGenerator("generator.mirror", params, CONTEXT);
    const second = proposeGenerator("generator.mirror", params, CONTEXT);
    expect(canonicalJson(first.commands as never)).toBe(
      canonicalJson(second.commands as never),
    );
    expect(() =>
      proposeGenerator(
        "generator.mirror",
        { region: { min: [4, 0, 0], max: [0, 2, 2] }, axis: "z" },
        CONTEXT,
      ),
    ).toThrow();
  });
});

describe("generator.linearRepeat", () => {
  it("copies a source region count times along the delta", () => {
    const proposal = proposeGenerator(
      "generator.linearRepeat",
      {
        source: { min: [0, 0, 0], max: [2, 1, 1] },
        count: 3,
        delta: [0, 0, 4],
      },
      CONTEXT,
    );
    expect(proposal.commandCount).toBe(3);
    for (const command of proposal.commands) {
      expect(command.type).toBe(VOXEL_COPY_REGION_COMMAND);
    }
    const destinations = proposal.commands.map(
      (command) => (command.payload as { destination: number[] }).destination,
    );
    // Copies start one delta away; the source position is not re-copied.
    expect(destinations).toEqual([
      [0, 0, 4],
      [0, 0, 8],
      [0, 0, 12],
    ]);
    // copyRegion estimates source + destination writes (2x region volume).
    expect(proposal.voxelEstimate).toBe(3 * 2 * (2 * 1 * 1));
    expect(proposal.bounds).toEqual({ min: [0, 0, 0], max: [2, 1, 13] });
  });
});

describe("generator.radialRepeat", () => {
  it("places count copies on evenly spaced integer positions", () => {
    const proposal = proposeGenerator(
      "generator.radialRepeat",
      {
        source: { min: [0, 0, 0], max: [2, 2, 2] },
        center: [10, 0, 10],
        axis: "y",
        count: 4,
        radius: 8,
      },
      CONTEXT,
    );
    expect(proposal.commandCount).toBe(4);
    for (const command of proposal.commands) {
      expect(command.type).toBe(VOXEL_COPY_REGION_COMMAND);
    }
    const destinations = proposal.commands.map(
      (command) => (command.payload as { destination: number[] }).destination,
    );
    // Angles 0, 90, 180, 270 degrees around [10, 0, 10] at radius 8.
    expect(destinations).toEqual([
      [18, 0, 10],
      [10, 0, 18],
      [2, 0, 10],
      [10, 0, 2],
    ]);
    expect(proposal.voxelEstimate).toBe(4 * 2 * 8);
  });

  it("is deterministic across repeated calls", () => {
    const params = {
      source: { min: [0, 0, 0], max: [3, 1, 1] },
      center: [5, 5, 5],
      axis: "z",
      count: 7,
      radius: 3,
    };
    const first = proposeGenerator("generator.radialRepeat", params, CONTEXT);
    const second = proposeGenerator("generator.radialRepeat", params, CONTEXT);
    expect(canonicalJson(first.commands as never)).toBe(
      canonicalJson(second.commands as never),
    );
  });
});

describe("generator.stairs", () => {
  it("builds count steps as fillBox commands with a preflight estimate", () => {
    const proposal = proposeGenerator(
      "generator.stairs",
      {
        start: [0, 0, 0],
        count: 4,
        width: 3,
        depth: 2,
        stepHeight: 1,
        axis: "x",
      },
      CONTEXT,
    );
    expect(proposal.commandCount).toBe(4);
    for (const command of proposal.commands) {
      expect(command.type).toBe(VOXEL_FILL_BOX_COMMAND);
    }
    expect(proposal.voxelEstimate).toBe(4 * 3 * 1 * 2);
    expect(proposal.bounds).toEqual({ min: [0, 0, 0], max: [8, 4, 3] });
  });

  it("advances only along the requested run axis (issue #109)", () => {
    // Asymmetric width (perpendicular to the run) vs depth (along the run)
    // makes a swapped-axis regression visible in the step mins.
    const cases: ReadonlyArray<{
      axis: "x" | "z";
      expectedMins: ReadonlyArray<[number, number, number]>;
      expectedBounds: {
        min: [number, number, number];
        max: [number, number, number];
      };
    }> = [
      {
        axis: "x",
        expectedMins: [
          [0, 0, 0],
          [3, 1, 0],
          [6, 2, 0],
        ],
        expectedBounds: { min: [0, 0, 0], max: [9, 3, 2] },
      },
      {
        axis: "z",
        expectedMins: [
          [0, 0, 0],
          [0, 1, 3],
          [0, 2, 6],
        ],
        expectedBounds: { min: [0, 0, 0], max: [2, 3, 9] },
      },
    ];
    for (const { axis, expectedMins, expectedBounds } of cases) {
      const proposal = proposeGenerator(
        "generator.stairs",
        { start: [0, 0, 0], count: 3, width: 2, depth: 3, stepHeight: 1, axis },
        CONTEXT,
      );
      const mins = proposal.commands.map(
        (command) =>
          (command.payload as { region: { min: number[] } }).region.min,
      );
      expect(mins).toEqual(expectedMins);
      expect(proposal.bounds).toEqual(expectedBounds);
    }
  });
});

describe("generator.wall", () => {
  it("builds a solid wall from one fillBox", () => {
    const proposal = proposeGenerator(
      "generator.wall",
      { min: [0, 0, 0], size: [10, 4, 1] },
      CONTEXT,
    );
    expect(proposal.commandCount).toBe(1);
    expect(proposal.commands[0]?.type).toBe(VOXEL_FILL_BOX_COMMAND);
    expect(proposal.voxelEstimate).toBe(40);
  });

  it("cuts a rectangular opening with a deleteRegion command", () => {
    const proposal = proposeGenerator(
      "generator.wall",
      {
        min: [0, 0, 0],
        size: [10, 5, 1],
        opening: { min: [2, 0, 0], max: [4, 2, 1] },
      },
      CONTEXT,
    );
    expect(proposal.commandCount).toBe(2);
    expect(proposal.commands[0]?.type).toBe(VOXEL_FILL_BOX_COMMAND);
    expect(proposal.commands[1]?.type).toBe(VOXEL_DELETE_REGION_COMMAND);
    // Preflight counts the wall plus the cut opening (deleteRegion).
    expect(proposal.voxelEstimate).toBe(50 + 4);
  });

  it("rejects an opening outside the wall", () => {
    expect(() =>
      proposeGenerator(
        "generator.wall",
        {
          min: [0, 0, 0],
          size: [10, 4, 1],
          opening: { min: [8, 0, 0], max: [12, 2, 1] },
        },
        CONTEXT,
      ),
    ).toThrow();
  });
});

describe("generator.roof", () => {
  it("builds a flat roof from one slab", () => {
    const proposal = proposeGenerator(
      "generator.roof",
      { min: [0, 5, 0], width: 6, depth: 4, style: "flat", thickness: 1 },
      CONTEXT,
    );
    expect(proposal.commandCount).toBe(1);
    expect(proposal.commands[0]?.type).toBe(VOXEL_FILL_BOX_COMMAND);
    expect(proposal.voxelEstimate).toBe(24);
  });

  it("builds a gable roof from shrinking layers", () => {
    const proposal = proposeGenerator(
      "generator.roof",
      { min: [0, 5, 0], width: 5, depth: 4, style: "gable", thickness: 1 },
      CONTEXT,
    );
    expect(proposal.commandCount).toBe(3);
    for (const command of proposal.commands) {
      expect(command.type).toBe(VOXEL_FILL_BOX_COMMAND);
    }
    // Layers: 5x4 + 3x4 + 1x4.
    expect(proposal.voxelEstimate).toBe(20 + 12 + 4);
  });

  it("builds a pyramid roof shrinking both horizontal axes", () => {
    const proposal = proposeGenerator(
      "generator.roof",
      { min: [0, 5, 0], width: 5, depth: 3, style: "pyramid", thickness: 1 },
      CONTEXT,
    );
    expect(proposal.commandCount).toBe(3);
    // Layers: 5x3 + 3x1 + 1x1.
    expect(proposal.voxelEstimate).toBe(15 + 3 + 1);
  });
});

describe("generator.branches", () => {
  it("builds a trunk plus two branch generations", () => {
    const proposal = proposeGenerator(
      "generator.branches",
      {
        base: [0, 0, 0],
        trunkHeight: 6,
        trunkSize: 2,
        levels: 2,
        branchLength: 4,
        branchSize: 1,
        rise: 3,
      },
      CONTEXT,
    );
    // Trunk + 2 + 4 segments.
    expect(proposal.commandCount).toBe(7);
    for (const command of proposal.commands) {
      expect(command.type).toBe(VOXEL_FILL_BOX_COMMAND);
    }
    // Preflight equals the sum of the proposed fillBox volumes.
    const volumes = proposal.commands.map(
      (command) =>
        (command.payload as { region: { min: number[]; max: number[] } })
          .region,
    );
    const sum = volumes.reduce((total, region) => {
      const min = region.min;
      const max = region.max;
      return (
        total +
        ((max[0] as number) - (min[0] as number)) *
          ((max[1] as number) - (min[1] as number)) *
          ((max[2] as number) - (min[2] as number))
      );
    }, 0);
    expect(proposal.voxelEstimate).toBe(sum);
  });

  it("varies deterministically with the explicit seed", () => {
    const params = {
      base: [0, 0, 0],
      trunkHeight: 6,
      trunkSize: 2,
      levels: 3,
      branchLength: 4,
      branchSize: 1,
      rise: 3,
    };
    const seededA = proposeGenerator("generator.branches", params, {
      ...CONTEXT,
      seed: "seed-a",
    });
    const seededA2 = proposeGenerator("generator.branches", params, {
      ...CONTEXT,
      seed: "seed-a",
    });
    const seededB = proposeGenerator("generator.branches", params, {
      ...CONTEXT,
      seed: "seed-b",
    });
    expect(canonicalJson(seededA.commands as never)).toBe(
      canonicalJson(seededA2.commands as never),
    );
    expect(canonicalJson(seededA.commands as never)).not.toBe(
      canonicalJson(seededB.commands as never),
    );
  });
});

describe("generator.wheel", () => {
  it("builds a solid tire from one cylinder", () => {
    const proposal = proposeGenerator(
      "generator.wheel",
      {
        center: [0, 0, 0],
        axis: "y",
        radius: 4,
        thickness: 2,
        hubRadius: 0,
        spokeCount: 0,
        spokeWidth: 1,
      },
      CONTEXT,
    );
    expect(proposal.commandCount).toBe(1);
    expect(proposal.commands[0]?.type).toBe(VOXEL_FILL_CYLINDER_COMMAND);
    expect(proposal.voxelEstimate).toBe((2 * 4 + 1) * (2 * 4 + 1) * 2);
  });

  it("adds a hub cylinder and four cardinal box spokes", () => {
    const proposal = proposeGenerator(
      "generator.wheel",
      {
        center: [0, 0, 0],
        axis: "y",
        radius: 4,
        thickness: 2,
        hubRadius: 1,
        spokeCount: 4,
        spokeWidth: 1,
      },
      CONTEXT,
    );
    expect(proposal.commandCount).toBe(2 + 4);
    const types = proposal.commands.map((command) => command.type);
    expect(
      types.filter((type) => type === VOXEL_FILL_CYLINDER_COMMAND),
    ).toHaveLength(2);
    expect(
      types.filter((type) => type === VOXEL_FILL_BOX_COMMAND),
    ).toHaveLength(4);
    // Tire + hub + spokes: (2r+1)^2*t + (2h+1)^2*t + two 4x2x3 boxes
    // (x spokes) and two 3x2x4 boxes (z spokes).
    expect(proposal.voxelEstimate).toBe(
      9 * 9 * 2 + 3 * 3 * 2 + 2 * (4 * 2 * 3) + 2 * (3 * 2 * 4),
    );
  });

  it("rejects a hub larger than the tire", () => {
    expect(() =>
      proposeGenerator(
        "generator.wheel",
        {
          center: [0, 0, 0],
          axis: "y",
          radius: 4,
          thickness: 2,
          hubRadius: 5,
          spokeCount: 0,
          spokeWidth: 1,
        },
        CONTEXT,
      ),
    ).toThrow();
  });
});

describe("generator.linkage", () => {
  it("builds a straight chain of links", () => {
    const proposal = proposeGenerator(
      "generator.linkage",
      {
        start: [0, 0, 0],
        axis: "x",
        count: 5,
        segmentLength: 4,
        thickness: 2,
        pattern: "straight",
      },
      CONTEXT,
    );
    expect(proposal.commandCount).toBe(5);
    for (const command of proposal.commands) {
      expect(command.type).toBe(VOXEL_FILL_BOX_COMMAND);
    }
    expect(proposal.voxelEstimate).toBe(5 * 4 * 2 * 2);
  });

  it("zigzag alternates the perpendicular offset", () => {
    const proposal = proposeGenerator(
      "generator.linkage",
      {
        start: [0, 0, 0],
        axis: "x",
        count: 4,
        segmentLength: 3,
        thickness: 2,
        pattern: "zigzag",
      },
      CONTEXT,
    );
    const mins = proposal.commands.map(
      (command) =>
        (command.payload as { region: { min: number[] } }).region.min,
    );
    expect(mins[0]).toEqual([0, 0, 0]);
    expect(mins[1]).toEqual([3, 2, 0]);
    expect(mins[2]).toEqual([6, 0, 0]);
    expect(mins[3]).toEqual([9, 2, 0]);
  });

  it("seeded bends are deterministic and seed-sensitive", () => {
    const params = {
      start: [0, 0, 0],
      axis: "x",
      count: 12,
      segmentLength: 2,
      thickness: 2,
      pattern: "seeded",
    };
    const first = proposeGenerator("generator.linkage", params, CONTEXT);
    const second = proposeGenerator("generator.linkage", params, CONTEXT);
    const other = proposeGenerator("generator.linkage", params, {
      ...CONTEXT,
      seed: "other",
    });
    expect(canonicalJson(first.commands as never)).toBe(
      canonicalJson(second.commands as never),
    );
    expect(canonicalJson(first.commands as never)).not.toBe(
      canonicalJson(other.commands as never),
    );
  });
});
