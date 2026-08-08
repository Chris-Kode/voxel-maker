import { describe, expect, it } from "vitest";
import {
  createMigrationChain,
  CURRENT_DOCUMENT_SCHEMA_VERSION,
} from "./migration.js";

/** Captures the order in which pure steps run. */
function recordingSteps(versions: readonly number[]): {
  steps: Parameters<typeof createMigrationChain>[0];
  calls: number[];
} {
  const calls: number[] = [];
  return {
    steps: versions.map((fromVersion) => ({
      fromVersion,
      toVersion: fromVersion + 1,
      migrate: (json: string) => {
        calls.push(fromVersion);
        return json;
      },
    })),
    calls,
  };
}

describe("createMigrationChain", () => {
  it("exposes an identity chain for the current version with no transitions", () => {
    const chain = createMigrationChain([]);
    expect(chain.currentVersion).toBe(CURRENT_DOCUMENT_SCHEMA_VERSION);
    expect(chain.oldestVersion).toBe(CURRENT_DOCUMENT_SCHEMA_VERSION);
    expect(chain.steps).toHaveLength(0);
    expect(chain.canMigrate(1)).toBe(true);
    expect(chain.canMigrate(2)).toBe(false);
    expect(chain.migrate('{"documentSchemaVersion":1}', 1)).toEqual({
      json: '{"documentSchemaVersion":1}',
      steps: [],
    });
  });

  it("rejects steps that skip a version", () => {
    expect(() =>
      createMigrationChain([
        { fromVersion: 1, toVersion: 3, migrate: (j) => j },
      ]),
    ).toThrowError(/one version at a time/);
  });

  it("rejects a gap between consecutive steps", () => {
    expect(() =>
      createMigrationChain(
        [
          { fromVersion: 1, toVersion: 2, migrate: (j) => j },
          { fromVersion: 3, toVersion: 4, migrate: (j) => j },
        ],
        4,
      ),
    ).toThrowError(/contiguous/);
  });

  it("rejects duplicate from-versions", () => {
    expect(() =>
      createMigrationChain([
        { fromVersion: 1, toVersion: 2, migrate: (j) => j },
        { fromVersion: 1, toVersion: 2, migrate: (j) => j },
      ]),
    ).toThrowError(/same fromVersion/);
  });

  it("rejects non-integer and below-one versions", () => {
    expect(() =>
      createMigrationChain([
        { fromVersion: 0, toVersion: 1, migrate: (j) => j },
      ]),
    ).toThrowError(/version/i);
    expect(() =>
      createMigrationChain([
        { fromVersion: 1.5, toVersion: 2.5, migrate: (j) => j },
      ]),
    ).toThrowError(/version/i);
  });

  it("rejects a chain that does not reach the current version", () => {
    expect(() =>
      createMigrationChain(
        [{ fromVersion: 1, toVersion: 2, migrate: (j) => j }],
        3,
      ),
    ).toThrowError(/reach/);
    expect(() =>
      createMigrationChain(
        [
          { fromVersion: 1, toVersion: 2, migrate: (j) => j },
          { fromVersion: 2, toVersion: 3, migrate: (j) => j },
        ],
        2,
      ),
    ).toThrowError(/beyond|reach/i);
  });

  it("accepts an unordered step list and orders it", () => {
    const { steps } = recordingSteps([2, 1]);
    const chain = createMigrationChain(steps, 3);
    expect(chain.steps.map((s) => s.fromVersion)).toEqual([1, 2]);
  });
});

describe("DocumentMigrationChain.migrate", () => {
  it("runs every transition exactly once, in order, and reports each step", () => {
    const { steps, calls } = recordingSteps([1, 2]);
    const chain = createMigrationChain(steps, 3);
    const result = chain.migrate('{"documentSchemaVersion":1}', 1);
    expect(calls).toEqual([1, 2]);
    expect(result.json).toBe('{"documentSchemaVersion":1}');
    expect(result.steps).toEqual([
      { fromVersion: 1, toVersion: 2 },
      { fromVersion: 2, toVersion: 3 },
    ]);
  });

  it("starts mid-chain when the file version is newer than the oldest", () => {
    const { steps, calls } = recordingSteps([1, 2]);
    const chain = createMigrationChain(steps, 3);
    const result = chain.migrate("{}", 2);
    expect(calls).toEqual([2]);
    expect(result.steps).toEqual([{ fromVersion: 2, toVersion: 3 }]);
  });

  it("feeds each step the previous step's output", () => {
    const chain = createMigrationChain(
      [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: (json) => `${json}-first`,
        },
        {
          fromVersion: 2,
          toVersion: 3,
          migrate: (json) => `${json}-second`,
        },
      ],
      3,
    );
    expect(chain.migrate("start", 1).json).toBe("start-first-second");
  });

  it("rejects unknown, future, and malformed versions with a compatibility error", () => {
    const chain = createMigrationChain([]);
    for (const version of [2, 2.5, 0, -1, Number.NaN]) {
      let thrown: unknown;
      try {
        chain.migrate("{}", version);
      } catch (error) {
        thrown = error;
      }
      expect(
        thrown,
        `version ${String(version)} must be a compatibility error`,
      ).toMatchObject({
        family: "compatibility",
        code: "UNSUPPORTED_DOCUMENT_VERSION",
      });
    }
  });

  it("migrates realistic versioned JSON end to end, one step at a time", () => {
    // A v1 payload is renamed and then restructured by two released
    // transitions; the pipeline must apply both in order and report them.
    const chain = createMigrationChain(
      [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: (json) => {
            const value = JSON.parse(json) as {
              legacyName: string;
            };
            return JSON.stringify({
              documentSchemaVersion: 2,
              name: value.legacyName,
            });
          },
        },
        {
          fromVersion: 2,
          toVersion: 3,
          migrate: (json) => {
            const value = JSON.parse(json) as {
              documentSchemaVersion: number;
              name: string;
            };
            return JSON.stringify({
              documentSchemaVersion: 3,
              title: value.name.toUpperCase(),
            });
          },
        },
      ],
      3,
    );
    const result = chain.migrate(
      JSON.stringify({ documentSchemaVersion: 1, legacyName: "spaceship" }),
      1,
    );
    expect(JSON.parse(result.json)).toEqual({
      documentSchemaVersion: 3,
      title: "SPACESHIP",
    });
    expect(result.steps).toEqual([
      { fromVersion: 1, toVersion: 2 },
      { fromVersion: 2, toVersion: 3 },
    ]);
  });

  it("propagates a failing step without returning a partial result", () => {
    const chain = createMigrationChain(
      [
        { fromVersion: 1, toVersion: 2, migrate: (j) => j },
        {
          fromVersion: 2,
          toVersion: 3,
          migrate: () => {
            throw new Error("boom");
          },
        },
      ],
      3,
    );
    expect(() => chain.migrate("{}", 1)).toThrowError("boom");
  });
});
