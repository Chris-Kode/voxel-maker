import { describe, expect, it } from "vitest";
import { qualificationProblems, runBenchmarks } from "./run.js";

/** A protocol-compliant reference-tier invocation matrix. */
const COMPLIANT_REFERENCE = {
  sizes: [100_000, 500_000, 1_000_000],
  kinds: ["compact", "sparse", "checkerboard"] as const,
  samples: 100,
  saveLoadRuns: 5,
  animationFrames: 100,
};

describe("qualificationProblems (issue #72)", () => {
  it("accepts a protocol-compliant reference matrix", () => {
    expect(qualificationProblems(COMPLIANT_REFERENCE, "reference")).toEqual([]);
  });

  it("accepts a protocol-compliant low matrix (100k only)", () => {
    expect(
      qualificationProblems(
        { ...COMPLIANT_REFERENCE, sizes: [100_000] },
        "low",
      ),
    ).toEqual([]);
  });

  it("rejects a reference matrix missing required sizes and kinds", () => {
    const problems = qualificationProblems(
      {
        ...COMPLIANT_REFERENCE,
        sizes: [10_000],
        kinds: ["compact"],
      },
      "reference",
    );
    expect(
      problems.some((problem) =>
        problem.includes("missing required size 100000"),
      ),
    ).toBe(true);
    expect(
      problems.some((problem) =>
        problem.includes("missing required size 500000"),
      ),
    ).toBe(true);
    expect(
      problems.some((problem) =>
        problem.includes("missing required size 1000000"),
      ),
    ).toBe(true);
    expect(
      problems.some((problem) =>
        problem.includes("missing required kind sparse"),
      ),
    ).toBe(true);
    expect(
      problems.some((problem) =>
        problem.includes("missing required kind checkerboard"),
      ),
    ).toBe(true);
  });

  it("rejects below-protocol sample, run, and frame counts", () => {
    const problems = qualificationProblems(
      {
        ...COMPLIANT_REFERENCE,
        samples: 1,
        saveLoadRuns: 1,
        animationFrames: 1,
      },
      "reference",
    );
    expect(
      problems.some((problem) => problem.includes("samples 1 < 100")),
    ).toBe(true);
    expect(
      problems.some((problem) => problem.includes("save-load-runs 1 < 5")),
    ).toBe(true);
    expect(
      problems.some((problem) => problem.includes("animation-frames 1 < 100")),
    ).toBe(true);
  });

  it("never constrains the explicitly non-qualifying ci-smoke tier", () => {
    expect(
      qualificationProblems(
        {
          sizes: [10_000],
          kinds: ["compact"],
          samples: 1,
          saveLoadRuns: 1,
          animationFrames: 1,
        },
        "ci-smoke",
      ),
    ).toEqual([]);
  });
});

describe("runBenchmarks matrix pre-flight (issue #72)", () => {
  it("rejects an incomplete reference matrix with a structured error before measuring", async () => {
    await expect(
      runBenchmarks({
        tier: "reference",
        sizes: [10_000],
        kinds: ["compact"],
        samples: 1,
        saveLoadRuns: 1,
        previewSamples: 1,
        previewSize: 1,
        animationFrames: 1,
      }),
    ).rejects.toMatchObject({
      name: "WorkspaceError",
      code: "INCOMPLETE_BENCHMARK_MATRIX",
      family: "validation",
    });
  });
});
