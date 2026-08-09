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
import type { VoxelDocument } from "@voxel-maker/model";
import {
  addConstraintCommand,
  addJointCommand,
  fillBoxCommand,
  setPivotCommand,
  type Command,
} from "@voxel-maker/commands";
import { createDocumentStore } from "@voxel-maker/document";
import { commandId, componentId, transactionId } from "@voxel-maker/shared";
import { rigMotionFixtureById } from "./rig-motion-fixtures.js";

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

describe("rig and animation state checks (ticket #39 AC3)", () => {
  it("counts pivots, joints, constraints, and parented nodes", () => {
    // The fixture store has one root and one body node; the body gets a
    // pivot, a joint, and a constraint through the command bus.
    const fixture = createGeneratorFixture();
    let revision = 0;
    const commit = (command: Command) => {
      const result = fixture.bus.execute(command, {
        transactionId: transactionId(
          `transaction:check:rig:${String(revision)}`,
        ),
        expectedRevision: revision,
        source: "ui",
      });
      if (!result.ok) throw new Error("rig commit failed");
      revision = result.value.revisionAfter;
    };
    commit(
      setPivotCommand(commandId("command:check:pivot"), {
        nodeId: FIXTURE_IDS.body,
        pivot: [1, 1, 1],
      }),
    );
    commit(
      addJointCommand(commandId("command:check:joint"), {
        nodeId: FIXTURE_IDS.body,
      }),
    );
    commit(
      addConstraintCommand(commandId("command:check:constraint"), {
        nodeId: FIXTURE_IDS.body,
        componentId: componentId("component:check:limit"),
        limits: { min: [-1, 0, 0], max: [1, 0, 0] },
        before: null,
      }),
    );

    const results = runStructuralChecks(
      [
        {
          name: "pivot-count-in-range",
          options: { min: 1, max: 2 },
        },
        {
          name: "joint-count-in-range",
          options: { min: 1, max: 2 },
        },
        {
          name: "constraint-count-in-range",
          options: { min: 1, max: 2 },
        },
        {
          name: "parented-node-count-in-range",
          options: { min: 1, max: 2 },
        },
      ],
      fixture.store,
      CONTEXT,
    );
    for (const result of results) {
      expect(result.passed, result.evidence).toBe(true);
    }
    expect(results[0]?.evidence).toContain("pivots=1");
    expect(results[2]?.evidence).toContain("constraints=1");
  });

  it("node-present resolves against the document nodes", () => {
    const { store } = commitBoxes([{ min: [0, 0, 0], max: [2, 2, 2] }]);
    const present = runStructuralChecks(
      [{ name: "node-present", options: { nodeId: FIXTURE_IDS.body } }],
      store,
      CONTEXT,
    );
    expect(present[0]?.passed).toBe(true);
    const missing = runStructuralChecks(
      [{ name: "node-present", options: { nodeId: "node:not-there" } }],
      store,
      CONTEXT,
    );
    expect(missing[0]?.passed).toBe(false);
  });

  it("counts animations, tracks, and keyframes", () => {
    const { store } = commitBoxes([{ min: [0, 0, 0], max: [2, 2, 2] }]);
    const empty = runStructuralChecks(
      [
        { name: "animation-count-in-range", options: { min: 1, max: 1 } },
        { name: "track-count-in-range", options: { min: 1, max: 4 } },
        { name: "keyframe-count-in-range", options: { min: 1, max: 8 } },
      ],
      store,
      CONTEXT,
    );
    for (const result of empty) {
      expect(result.passed, result.evidence).toBe(false);
    }
  });

  it("validates the fixed fixture documents through the new checks", () => {
    // The rigged end states of the fixed fixtures satisfy the rig and
    // motion checks; the unrigged starts do not.
    const biped = rigMotionFixtureById("rig-biped");
    expect(biped).toBeDefined();
    const { store: endStore } = createDocumentStore({
      document: biped?.end as VoxelDocument,
    });
    const results = runStructuralChecks(
      [
        { name: "pivot-count-in-range", options: { min: 8, max: 12 } },
        { name: "joint-count-in-range", options: { min: 8, max: 12 } },
        { name: "constraint-count-in-range", options: { min: 2, max: 8 } },
        { name: "parented-node-count-in-range", options: { min: 8, max: 16 } },
        { name: "animation-count-in-range", options: { min: 0, max: 0 } },
      ],
      endStore,
      CONTEXT,
    );
    for (const result of results) {
      expect(result.passed, result.evidence).toBe(true);
    }

    const { store: startStore } = createDocumentStore({
      document: biped?.start as VoxelDocument,
    });
    const startResults = runStructuralChecks(
      [
        { name: "pivot-count-in-range", options: { min: 1, max: 100 } },
        { name: "joint-count-in-range", options: { min: 1, max: 100 } },
      ],
      startStore,
      CONTEXT,
    );
    for (const result of startResults) {
      expect(result.passed, result.evidence).toBe(false);
    }
  });

  it("animation duration and loop policy require at least one animation", () => {
    const fixture = rigMotionFixtureById("motion-walk");
    expect(fixture).toBeDefined();
    const { store } = createDocumentStore({
      document: fixture?.end as VoxelDocument,
    });
    const results = runStructuralChecks(
      [
        { name: "animation-duration-in-range", options: { min: 1.5, max: 3 } },
        { name: "animation-loop-policy", options: { policy: "loop" } },
        { name: "animation-count-in-range", options: { min: 1, max: 2 } },
        { name: "track-count-in-range", options: { min: 4, max: 12 } },
        { name: "keyframe-count-in-range", options: { min: 8, max: 48 } },
      ],
      store,
      CONTEXT,
    );
    for (const result of results) {
      expect(result.passed, result.evidence).toBe(true);
    }

    const { store: startStore } = createDocumentStore({
      document: fixture?.start as VoxelDocument,
    });
    const startResults = runStructuralChecks(
      [
        { name: "animation-duration-in-range", options: { min: 1.5, max: 3 } },
        { name: "animation-loop-policy", options: { policy: "loop" } },
      ],
      startStore,
      CONTEXT,
    );
    for (const result of startResults) {
      expect(result.passed, result.evidence).toBe(false);
    }
  });

  it("rejects malformed rig/animation check options", () => {
    const expectCode = (run: () => void): void => {
      let caught: unknown;
      try {
        run();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as { readonly code?: unknown };
      expect(error.code).toBe(INVALID_CHECK_OPTIONS_CODE);
    };
    expectCode(() => {
      validateStructuralCheck("pivot-count-in-range", { min: -1 });
    });
    expectCode(() => {
      validateStructuralCheck("animation-loop-policy", { policy: "bounce" });
    });
    expectCode(() => {
      validateStructuralCheck("node-present", { nodeId: 7 });
    });
  });
});
