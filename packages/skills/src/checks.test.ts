import { describe, expect, it } from "vitest";
import {
  INVALID_CHECK_OPTIONS_CODE,
  UNKNOWN_STRUCTURAL_CHECK_CODE,
  regionOption,
  runStructuralChecks,
  structuralCheckByName,
  validateStructuralCheck,
} from "./checks.js";
import { createGeneratorFixture, FIXTURE_IDS } from "./fixtures.js";
import type { Vec3i } from "./geometry.js";
import type { CheckResult } from "./checks.js";
import { fillBoxCommand, type Command } from "@voxel-maker/commands";
import { commandId, transactionId } from "@voxel-maker/shared";

/**
 * Structural-check tests (ticket #38 AC3): the generic checks resolve by
 * name, reject unknown names and malformed options at registration, and
 * evaluate deterministically against real committed documents through
 * the ordinary command bus.
 */

const CONTEXT = {
  volumeId: FIXTURE_IDS.volume,
  material: FIXTURE_IDS.material,
};

function fillBox(min: Vec3i, max: Vec3i, index: number): Command {
  return fillBoxCommand(commandId(`command:check:${String(index)}`), {
    volumeId: FIXTURE_IDS.volume,
    region: { min: [...min], max: [...max] },
    material: FIXTURE_IDS.material,
  });
}

function commitBoxes(boxes: readonly { min: Vec3i; max: Vec3i }[]): {
  store: ReturnType<typeof createGeneratorFixture>["store"];
} {
  const fixture = createGeneratorFixture();
  let revision = 0;
  for (const [index, box] of boxes.entries()) {
    const result = fixture.bus.execute(fillBox(box.min, box.max, index), {
      transactionId: transactionId(`transaction:check:${String(index)}`),
      expectedRevision: revision,
      source: "ui",
    });
    if (!result.ok) throw new Error("fixture commit failed");
    revision = result.value.revisionAfter;
  }
  return { store: fixture.store };
}

describe("check registry (AC3)", () => {
  it("exposes every generic check in stable order", () => {
    const names = [
      "occupied-voxel-count-in-range",
      "occupancy-inside-region",
      "region-nonempty",
      "material-present",
      "node-count-in-range",
      "symmetric-along-axis",
    ];
    expect(
      structuralCheckByName("occupied-voxel-count-in-range"),
    ).toBeDefined();
    expect(structuralCheckByName("has-wings")).toBeUndefined();
    for (const name of names) {
      expect(structuralCheckByName(name)?.name).toBe(name);
    }
  });

  it("rejects unknown check names at validation", () => {
    let caught: unknown;
    try {
      validateStructuralCheck("has-wings", {});
    } catch (error) {
      caught = error;
    }
    const error = caught as { code?: string };
    expect(error.code).toBe(UNKNOWN_STRUCTURAL_CHECK_CODE);
  });

  it("rejects malformed options and unbounded regions at validation", () => {
    let caught: unknown;
    try {
      validateStructuralCheck("region-nonempty", {
        region: { min: [0, 0, 0], max: [3_000, 3_000, 3_000] },
      });
    } catch (error) {
      caught = error;
    }
    const error = caught as { code?: string };
    expect(error.code).toBe(INVALID_CHECK_OPTIONS_CODE);
  });

  it("accepts the regionOption helper output", () => {
    let caught: unknown;
    try {
      validateStructuralCheck(
        "region-nonempty",
        regionOption([0, 0, 0], [4, 4, 4]),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUndefined();
  });
});

describe("occupied-voxel-count-in-range", () => {
  it("passes when the count is inside the declared range", () => {
    const { store } = commitBoxes([
      { min: [0, 0, 0], max: [4, 4, 4] }, // 64 voxels
    ]);
    const results = runStructuralChecks(
      [
        {
          name: "occupied-voxel-count-in-range",
          options: {
            region: { min: [0, 0, 0], max: [16, 16, 16] },
            min: 60,
            max: 70,
          },
        },
      ],
      store,
      CONTEXT,
    );
    const result = results[0] as CheckResult;
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("64");
  });

  it("fails when the count is outside the range", () => {
    const { store } = commitBoxes([
      { min: [0, 0, 0], max: [4, 4, 4] }, // 64 voxels
    ]);
    const results = runStructuralChecks(
      [
        {
          name: "occupied-voxel-count-in-range",
          options: {
            region: { min: [0, 0, 0], max: [16, 16, 16] },
            min: 100,
            max: 200,
          },
        },
      ],
      store,
      CONTEXT,
    );
    const result = results[0] as CheckResult;
    expect(result.passed).toBe(false);
  });
});

describe("occupancy-inside-region", () => {
  it("passes when all scanned voxels stay inside the inner region", () => {
    const { store } = commitBoxes([{ min: [2, 2, 2], max: [6, 6, 6] }]);
    const results = runStructuralChecks(
      [
        {
          name: "occupancy-inside-region",
          options: {
            region: { min: [0, 0, 0], max: [8, 8, 8] },
            scanRegion: { min: [0, 0, 0], max: [8, 8, 8] },
          },
        },
      ],
      store,
      CONTEXT,
    );
    expect(results[0]?.passed).toBe(true);
  });

  it("fails when a scanned voxel lies outside the inner region", () => {
    const { store } = commitBoxes([
      { min: [2, 2, 2], max: [6, 6, 6] },
      { min: [9, 0, 0], max: [10, 1, 1] }, // outside inner region, inside scan
    ]);
    const results = runStructuralChecks(
      [
        {
          name: "occupancy-inside-region",
          options: {
            region: { min: [0, 0, 0], max: [8, 8, 8] },
            scanRegion: { min: [0, 0, 0], max: [12, 12, 12] },
          },
        },
      ],
      store,
      CONTEXT,
    );
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.evidence).toContain("9,0,0");
  });
});

describe("region-nonempty and material-present", () => {
  it("passes when the region is filled and the material exists", () => {
    const { store } = commitBoxes([{ min: [0, 0, 0], max: [4, 4, 4] }]);
    const results = runStructuralChecks(
      [
        {
          name: "region-nonempty",
          options: { region: { min: [1, 1, 1], max: [3, 3, 3] } },
        },
        { name: "material-present", options: {} },
      ],
      store,
      CONTEXT,
    );
    expect(results[0]?.passed).toBe(true);
    expect(results[1]?.passed).toBe(true);
  });

  it("fails when the region is empty", () => {
    const { store } = commitBoxes([]);
    const results = runStructuralChecks(
      [
        {
          name: "region-nonempty",
          options: { region: { min: [0, 0, 0], max: [4, 4, 4] } },
        },
      ],
      store,
      CONTEXT,
    );
    expect(results[0]?.passed).toBe(false);
  });
});

describe("node-count-in-range", () => {
  it("counts the document nodes", () => {
    const { store } = commitBoxes([]);
    const results = runStructuralChecks(
      [{ name: "node-count-in-range", options: { min: 2, max: 2 } }],
      store,
      CONTEXT,
    );
    expect(results[0]?.passed).toBe(true);
    const tooMany = runStructuralChecks(
      [{ name: "node-count-in-range", options: { min: 5, max: 9 } }],
      store,
      CONTEXT,
    );
    expect(tooMany[0]?.passed).toBe(false);
  });
});

describe("symmetric-along-axis", () => {
  it("passes for mirror-symmetric occupancy", () => {
    const { store } = commitBoxes([
      { min: [1, 0, 0], max: [8, 2, 4] }, // left x in [1,8)
      { min: [8, 0, 0], max: [16, 2, 4] }, // right x in [8,16) = mirror twin
    ]);
    const results = runStructuralChecks(
      [
        {
          name: "symmetric-along-axis",
          options: {
            axis: "x",
            plane: 8,
            region: { min: [0, 0, 0], max: [16, 4, 8] },
          },
        },
      ],
      store,
      CONTEXT,
    );
    expect(results[0]?.passed).toBe(true);
  });

  it("fails when a mirror twin falls outside the declared region", () => {
    // Region [0,16) about x=8: the voxel at x=0 has its twin at x=16
    // OUTSIDE the region. A same-material voxel placed at that outside
    // position must not rescue the verdict — the check stays bounded by
    // its declared region.
    const { store } = commitBoxes([
      { min: [0, 0, 0], max: [1, 2, 4] }, // in-region voxel at x=0
      { min: [1, 0, 0], max: [8, 2, 4] }, // in-region left half
      { min: [8, 0, 0], max: [16, 2, 4] }, // in-region right half
      { min: [16, 0, 0], max: [17, 2, 4] }, // outside: would-be rescuer
    ]);
    const results = runStructuralChecks(
      [
        {
          name: "symmetric-along-axis",
          options: {
            axis: "x",
            plane: 8,
            region: { min: [0, 0, 0], max: [16, 4, 8] },
          },
        },
      ],
      store,
      CONTEXT,
    );
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.evidence).toContain("asymmetric");
  });

  it("fails for asymmetric occupancy", () => {
    const { store } = commitBoxes([
      { min: [1, 0, 0], max: [10, 2, 4] }, // left x in [1,10)
      { min: [8, 0, 0], max: [11, 2, 4] }, // right x in [8,11): short of mirror
    ]);
    const results = runStructuralChecks(
      [
        {
          name: "symmetric-along-axis",
          options: {
            axis: "x",
            plane: 8,
            region: { min: [0, 0, 0], max: [16, 4, 8] },
          },
        },
      ],
      store,
      CONTEXT,
    );
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.evidence).toContain("asymmetric");
  });
});
