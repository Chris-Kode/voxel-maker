import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  KNOWN_FIXTURE_IDS,
  KNOWN_GENERATOR_NAMES,
  KNOWN_TOOL_NAMES,
  SKILL_ENVIRONMENT,
} from "./environment.js";
import { GENERATOR_DEFINITIONS, generatorByName } from "./registry.js";
import { registerSkill } from "./skill-registry.js";
import { SKILL_GENERATOR_CODE } from "./manifest.js";

/**
 * Public registry view tests (issue #108): the exported registry
 * collections are read-only facades over private authoritative
 * collections. Consumers cannot rewrite validation decisions by
 * mutating the exported views: the views expose no mutation surface,
 * the authoritative backing collection is not reachable as a runtime
 * property, and phantom generators stay rejected by `registerSkill`
 * even after mutation attempts.
 */

/**
 * Asserts the full read-only-view contract of one exported set view:
 * reads work, the view is not a live Set, mutation methods do not
 * exist (attempts throw), and the authoritative backing collection is
 * not reachable through the facade.
 */
function expectReadOnlySetView(view: ReadonlySet<string>): void {
  expect(view instanceof Set).toBe(false);
  expect("add" in view).toBe(false);
  expect("delete" in view).toBe(false);
  expect("clear" in view).toBe(false);
  expect(() => (view as Set<string>).add("injected")).toThrow();
  // The backing collection must never be reachable as a runtime
  // property: TS `private` is erased, so the facade holds it in an
  // ES-private field that no consumer can probe.
  expect("backing" in view).toBe(false);
  expect(Object.getOwnPropertyNames(view)).not.toContain("backing");
  expect(Reflect.get(view, "backing")).toBeUndefined();
}

/** A creation manifest valid in every dimension except its generators. */
function phantomGeneratorManifest(): unknown {
  return {
    manifestVersion: 1,
    name: "skill.phantom-repro",
    version: "1.0.0",
    description: "phantom generator repro",
    kind: "creation",
    category: "furniture",
    instructions: "Use the tools.",
    allowedTools: ["fillBox", "queryVoxels"],
    generators: ["generator.not-registered"],
    constraints: {
      maxRoundsPerRun: 4,
      maxToolCallsPerRun: 12,
      maxCommandsPerRun: 32,
      maxCommandsPerProposal: 16,
      maxVoxelsPerProposal: 50_000,
    },
    provenance: {
      author: "test",
      source: "voxel-maker/skills",
      license: "UNLICENSED",
      created: "2026-08-09",
    },
    evaluation: {
      scenarioId: "phantom-repro-v1",
      fixedPrompt: "Create a custom thing.",
      structuralChecks: [
        {
          name: "region-nonempty",
          description: "core filled",
          options: { region: { min: [0, 0, 0], max: [4, 4, 4] } },
        },
      ],
      visualBaselines: [{ view: "front", description: "visible" }],
      efficiency: {
        goldenToolCalls: 6,
        goldenRounds: 2,
        goldenCommands: 10,
        maxToolCalls: 12,
        maxRounds: 4,
        maxCommands: 32,
      },
    },
  };
}

describe("public registry views (issue #108)", () => {
  it("exposes generator names as a non-mutating read-only view", () => {
    expect(KNOWN_GENERATOR_NAMES.has("generator.mirror")).toBe(true);
    expect(KNOWN_GENERATOR_NAMES.size).toBe(GENERATOR_DEFINITIONS.length);
    expect([...KNOWN_GENERATOR_NAMES]).toEqual(
      GENERATOR_DEFINITIONS.map((definition) => definition.name),
    );
    expectReadOnlySetView(KNOWN_GENERATOR_NAMES);
  });

  it("exposes tool names and fixture ids as non-mutating read-only views", () => {
    expect(KNOWN_TOOL_NAMES.has("fillBox")).toBe(true);
    expect(KNOWN_FIXTURE_IDS.has("rig-biped")).toBe(true);
    expectReadOnlySetView(KNOWN_TOOL_NAMES);
    expectReadOnlySetView(KNOWN_FIXTURE_IDS);
  });

  it("backs the skill environment with the same non-mutating views", () => {
    expect(SKILL_ENVIRONMENT.knownTools).toBe(KNOWN_TOOL_NAMES);
    expect(SKILL_ENVIRONMENT.knownGenerators).toBe(KNOWN_GENERATOR_NAMES);
    expect(SKILL_ENVIRONMENT.knownFixtureIds).toBe(KNOWN_FIXTURE_IDS);
    expectReadOnlySetView(SKILL_ENVIRONMENT.knownTools);
    expectReadOnlySetView(SKILL_ENVIRONMENT.knownGenerators);
    expectReadOnlySetView(SKILL_ENVIRONMENT.knownFixtureIds);
  });

  it("keeps rejecting phantom generators after a mutation attempt (issue #108 repro)", () => {
    // A consumer trying to register a generator through the public view
    // must fail; the manifest referencing the phantom generator must
    // still be rejected, and the generator must stay unresolvable.
    expect(() =>
      (KNOWN_GENERATOR_NAMES as Set<string>).add("generator.not-registered"),
    ).toThrow();
    let caught: unknown;
    try {
      registerSkill(phantomGeneratorManifest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceError);
    expect((caught as WorkspaceError).code).toBe(SKILL_GENERATOR_CODE);
    expect(generatorByName("generator.not-registered")).toBeUndefined();
  });

  it("a consumer probing for the backing set cannot corrupt the registry (issue #108 repro)", () => {
    // The full corruption route from the issue must be gone: even a
    // consumer that probes the facade for its backing reference finds
    // nothing to mutate, so the phantom generator stays unknown to the
    // validation environment.
    const backing: unknown = Reflect.get(KNOWN_GENERATOR_NAMES, "backing");
    expect(backing).toBeUndefined();
    if (backing !== undefined) {
      (backing as Set<string>).add("generator.not-registered");
    }
    expect(
      SKILL_ENVIRONMENT.knownGenerators.has("generator.not-registered"),
    ).toBe(false);
    expect(generatorByName("generator.not-registered")).toBeUndefined();
  });
});
