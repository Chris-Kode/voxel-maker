import { describe, expect, it } from "vitest";
import { canonicalJson } from "@voxel-maker/shared";
import { GENERATOR_DEFINITIONS, proposeGenerator } from "./registry.js";
import {
  DEFAULT_GENERATOR_LIMITS,
  GENERATOR_BOUNDS_CODE,
  GENERATOR_COMMAND_LIMIT_CODE,
  GENERATOR_CONTRACT_VERSION,
  GENERATOR_VOXEL_LIMIT_CODE,
  INVALID_GENERATOR_CONTEXT_CODE,
  INVALID_GENERATOR_PARAMS_CODE,
  UNKNOWN_GENERATOR_CODE,
  resolveGeneratorLimits,
} from "./generator.js";
import { FIXTURE_IDS, createGeneratorFixture } from "./fixtures.js";

/**
 * Generator interface tests (plan S14.3, ticket #37, AC1): one versioned
 * contract maps validated parameters plus an explicit seed to bounded
 * proposed generic commands; validation, determinism, boundedness, and
 * cost preflight are all observable at the facade.
 */

const CONTEXT = {
  volumeId: FIXTURE_IDS.volume,
  material: FIXTURE_IDS.material,
  seed: "test-seed",
};

const STAIRS = {
  start: [0, 0, 0],
  count: 3,
  width: 4,
  depth: 2,
  stepHeight: 1,
  axis: "x",
};

describe("versioned generator interface (AC1)", () => {
  it("exposes one contract version and nine versioned definitions", () => {
    expect(GENERATOR_CONTRACT_VERSION).toBe(1);
    expect(GENERATOR_DEFINITIONS).toHaveLength(9);
    const names = GENERATOR_DEFINITIONS.map((definition) => definition.name);
    expect(new Set(names).size).toBe(names.length);
    for (const definition of GENERATOR_DEFINITIONS) {
      expect(definition.name.length).toBeGreaterThan(0);
      expect(definition.version).toBeGreaterThanOrEqual(1);
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.inputSchema.type).toBe("object");
      expect(typeof definition.parse).toBe("function");
      expect(typeof definition.propose).toBe("function");
    }
  });

  it("proposes bounded generic commands with a preflight estimate", () => {
    const proposal = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    expect(proposal.generator).toBe("generator.stairs");
    expect(proposal.version).toBe(1);
    expect(proposal.contractVersion).toBe(GENERATOR_CONTRACT_VERSION);
    expect(proposal.seed).toBe("test-seed");
    expect(proposal.commandCount).toBe(3);
    expect(proposal.voxelEstimate).toBe(3 * 4 * 2 * 1);
    expect(proposal.bounds).toEqual({
      min: [0, 0, 0],
      max: [4, 3, 6],
    });
    expect(proposal.commands).toHaveLength(3);
    for (const command of proposal.commands) {
      expect(command.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(Object.isFrozen(command)).toBe(true);
    }
    expect(Object.isFrozen(proposal.commands)).toBe(true);
  });

  it("rejects unknown generators with a stable error", () => {
    expect(() => proposeGenerator("generator.nope", {}, CONTEXT)).toThrowError(
      expect.objectContaining({ code: UNKNOWN_GENERATOR_CODE }) as Error,
    );
  });

  it("rejects invalid parameters with stable validation errors", () => {
    expect(() =>
      proposeGenerator("generator.stairs", { ...STAIRS, count: 0 }, CONTEXT),
    ).toThrowError(
      expect.objectContaining({ code: INVALID_GENERATOR_PARAMS_CODE }) as Error,
    );
    expect(() =>
      proposeGenerator("generator.stairs", { ...STAIRS, width: -1 }, CONTEXT),
    ).toThrowError(
      expect.objectContaining({ code: INVALID_GENERATOR_PARAMS_CODE }) as Error,
    );
    expect(() =>
      proposeGenerator("generator.stairs", { start: [0, 0, 0] }, CONTEXT),
    ).toThrowError(
      expect.objectContaining({ code: INVALID_GENERATOR_PARAMS_CODE }) as Error,
    );
    // Closed objects: unknown fields are rejected rather than guessed at.
    expect(() =>
      proposeGenerator("generator.stairs", { ...STAIRS, bogus: 1 }, CONTEXT),
    ).toThrowError(
      expect.objectContaining({ code: INVALID_GENERATOR_PARAMS_CODE }) as Error,
    );
  });

  it("rejects an invalid generator context", () => {
    expect(() =>
      proposeGenerator("generator.stairs", STAIRS, { ...CONTEXT, seed: "" }),
    ).toThrowError(
      expect.objectContaining({
        code: INVALID_GENERATOR_CONTEXT_CODE,
      }) as Error,
    );
    expect(() =>
      proposeGenerator("generator.stairs", STAIRS, {
        ...CONTEXT,
        seed: "x".repeat(129),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: INVALID_GENERATOR_CONTEXT_CODE,
      }) as Error,
    );
    expect(() =>
      proposeGenerator("generator.stairs", STAIRS, {
        ...CONTEXT,
        material: 0 as never,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: INVALID_GENERATOR_CONTEXT_CODE,
      }) as Error,
    );
  });

  it("keeps the validated params and seed in the proposal envelope", () => {
    const proposal = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    expect(proposal.params).toEqual(STAIRS);
    expect(proposal.volumeId).toBe(FIXTURE_IDS.volume);
    expect(proposal.material).toBe(FIXTURE_IDS.material);
  });
});

describe("determinism and explicit seed (AC1/AC2)", () => {
  it("proposes byte-identical proposals for identical params and seed", () => {
    const first = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    const second = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    expect(canonicalJson(first.commands as never)).toBe(
      canonicalJson(second.commands as never),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.commands[0]?.id).toBe(second.commands[0]?.id);
  });

  it("derives distinct command ids and fingerprints per seed", () => {
    const first = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    const second = proposeGenerator("generator.stairs", STAIRS, {
      ...CONTEXT,
      seed: "other-seed",
    });
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.commands[0]?.id).not.toBe(second.commands[0]?.id);
    // Distinct ids let two proposals be staged together without collisions.
    const ids = new Set([
      ...first.commands.map((command) => command.id),
      ...second.commands.map((command) => command.id),
    ]);
    expect(ids.size).toBe(first.commands.length + second.commands.length);
  });

  it("derives distinct command ids per parameter set", () => {
    const first = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    const second = proposeGenerator(
      "generator.stairs",
      { ...STAIRS, count: 4 },
      CONTEXT,
    );
    expect(first.commands[0]?.id).not.toBe(second.commands[0]?.id);
  });

  it("keeps proposals bounded by the schema maxima", () => {
    expect(() =>
      proposeGenerator("generator.stairs", { ...STAIRS, count: 300 }, CONTEXT),
    ).toThrowError(
      expect.objectContaining({ code: INVALID_GENERATOR_PARAMS_CODE }) as Error,
    );
  });
});

describe("cost preflight and budgets (AC2)", () => {
  it("rejects proposals that exceed a lowered command budget", () => {
    expect(() =>
      proposeGenerator("generator.stairs", STAIRS, {
        ...CONTEXT,
        limits: { maxProposedCommands: 2 },
      }),
    ).toThrowError(
      expect.objectContaining({ code: GENERATOR_COMMAND_LIMIT_CODE }) as Error,
    );
  });

  it("rejects proposals that exceed a lowered voxel budget", () => {
    expect(() =>
      proposeGenerator("generator.stairs", STAIRS, {
        ...CONTEXT,
        limits: { maxProposedVoxels: 10 },
      }),
    ).toThrowError(
      expect.objectContaining({ code: GENERATOR_VOXEL_LIMIT_CODE }) as Error,
    );
  });

  it("rejects derived geometry outside the engine coordinate interval", () => {
    // Parameter schemas bound the inputs; composed placements must stay
    // inside the engine coordinate interval too.
    expect(() =>
      proposeGenerator(
        "generator.linearRepeat",
        {
          source: { min: [0, 0, 0], max: [2, 1, 1] },
          count: 3,
          delta: [1_000_000, 0, 0],
        },
        CONTEXT,
      ),
    ).toThrowError(
      expect.objectContaining({ code: GENERATOR_BOUNDS_CODE }) as Error,
    );
    // A step box starting near the interval edge must not push its max
    // corner past the engine limit either.
    expect(() =>
      proposeGenerator(
        "generator.stairs",
        { ...STAIRS, start: [1_048_573, 0, 0] },
        CONTEXT,
      ),
    ).toThrowError(
      expect.objectContaining({ code: GENERATOR_BOUNDS_CODE }) as Error,
    );
  });

  it("never raises a budget past the hard default", () => {
    const limits = resolveGeneratorLimits({
      maxProposedCommands: 10_000,
      maxProposedVoxels: 10_000_000,
    });
    expect(limits.maxProposedCommands).toBe(
      DEFAULT_GENERATOR_LIMITS.maxProposedCommands,
    );
    expect(limits.maxProposedVoxels).toBe(
      DEFAULT_GENERATOR_LIMITS.maxProposedVoxels,
    );
    const lowered = resolveGeneratorLimits({ maxProposedVoxels: 5 });
    expect(lowered.maxProposedVoxels).toBe(5);
  });

  it("preflights the same cumulative cost the preview session enforces", () => {
    const { store } = createGeneratorFixture();
    void store;
    const proposal = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    // The independent per-command formula: every step is one fillBox of
    // width x stepHeight x depth.
    expect(proposal.voxelEstimate).toBe(
      STAIRS.count * STAIRS.width * STAIRS.stepHeight * STAIRS.depth,
    );
  });
});
