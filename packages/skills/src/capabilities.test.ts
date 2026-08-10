import { describe, expect, it } from "vitest";
import type { ToolCapability } from "@voxel-maker/agent";
import { ALL_SKILLS, CREATION_SKILLS } from "./skill-registry.js";
import {
  TOOL_CAPABILITIES,
  requiredCapabilities,
  skillUsableWith,
  unauthorizedTools,
} from "./capabilities.js";

/**
 * Capability tests (plan S14.2, tickets #38 and #39): every catalog
 * skill's allowed tools resolve to capability classes, every skill
 * requires both inspection and mutation, and capability filtering
 * decides usability exactly.
 */

describe("tool capability map", () => {
  it("resolves every registered tool to a capability class", () => {
    expect(TOOL_CAPABILITIES.get("fillBox")).toBe("mutate");
    expect(TOOL_CAPABILITIES.get("queryVoxels")).toBe("inspect");
    expect(TOOL_CAPABILITIES.get("inspectSummary")).toBe("inspect");
    expect(TOOL_CAPABILITIES.get("createMaterial")).toBe("mutate");
    expect(TOOL_CAPABILITIES.has("notATool")).toBe(false);
  });

  it("every catalog skill requires inspection and mutation", () => {
    for (const skill of ALL_SKILLS) {
      const required = requiredCapabilities(skill);
      expect(required.has("inspect"), skill.name).toBe(true);
      expect(required.has("mutate"), skill.name).toBe(true);
    }
  });

  it("rigging and motion tool names resolve to capability classes", () => {
    expect(TOOL_CAPABILITIES.get("setNodePivot")).toBe("mutate");
    expect(TOOL_CAPABILITIES.get("addConstraint")).toBe("mutate");
    expect(TOOL_CAPABILITIES.get("inspectRigging")).toBe("inspect");
    expect(TOOL_CAPABILITIES.get("createAnimation")).toBe("mutate");
    expect(TOOL_CAPABILITIES.get("setKeyframe")).toBe("mutate");
    expect(TOOL_CAPABILITIES.get("inspectClips")).toBe("inspect");
  });
});

describe("rigging and motion skill usability (ticket #39 AC3)", () => {
  it("rigging skills are usable under inspect+mutate and blocked under inspect alone", () => {
    const biped = ALL_SKILLS.find((skill) => skill.name === "skill.biped-rig");
    expect(biped).toBeDefined();
    const skill = biped as NonNullable<typeof biped>;
    expect(skillUsableWith(skill, ["inspect", "mutate"])).toBe(true);
    expect(skillUsableWith(skill, ["inspect"])).toBe(false);
    const unauthorized = unauthorizedTools(skill, ["inspect"]);
    expect(unauthorized).toContain("setNodePivot");
    expect(
      unauthorized.every((tool) => TOOL_CAPABILITIES.get(tool) === "mutate"),
    ).toBe(true);
  });

  it("motion skills are usable under inspect+mutate and blocked under inspect alone", () => {
    const walk = ALL_SKILLS.find((skill) => skill.name === "skill.walk");
    expect(walk).toBeDefined();
    const skill = walk as NonNullable<typeof walk>;
    expect(skillUsableWith(skill, ["inspect", "mutate"])).toBe(true);
    expect(skillUsableWith(skill, ["inspect"])).toBe(false);
    const unauthorized = unauthorizedTools(skill, ["inspect"]);
    expect(unauthorized).toContain("createAnimation");
    expect(unauthorized).toContain("setKeyframe");
  });
});

describe("skill usability under a capability set (S14.2)", () => {
  it("is usable exactly when every allowed tool is authorized", () => {
    const furniture = CREATION_SKILLS[0] as (typeof CREATION_SKILLS)[number];
    expect(skillUsableWith(furniture, ["inspect", "mutate"])).toBe(true);
    expect(skillUsableWith(furniture, ["inspect"])).toBe(false);
    expect(skillUsableWith(furniture, [])).toBe(false);
  });

  it("names the unauthorized tools", () => {
    const furniture = CREATION_SKILLS[0] as (typeof CREATION_SKILLS)[number];
    const unauthorized = unauthorizedTools(furniture, ["inspect"]);
    expect(unauthorized.length).toBeGreaterThan(0);
    expect(unauthorized).toContain("fillBox");
    expect(
      unauthorized.every((tool) => TOOL_CAPABILITIES.get(tool) === "mutate"),
    ).toBe(true);
    expect(unauthorizedTools(furniture, ["inspect", "mutate"])).toHaveLength(0);
  });
});

/**
 * Asserts the full read-only-view contract of the exported capability
 * map: reads work, the view is not a live Map, mutation methods do not
 * exist (attempts throw), and the authoritative backing collection is
 * not reachable through the facade.
 */
function expectReadOnlyMapView(
  view: ReadonlyMap<string, ToolCapability>,
): void {
  expect(view instanceof Map).toBe(false);
  expect("set" in view).toBe(false);
  expect("delete" in view).toBe(false);
  expect("clear" in view).toBe(false);
  expect(() =>
    (view as Map<string, ToolCapability>).set("fillBox", "inspect"),
  ).toThrow();
  // The backing collection must never be reachable as a runtime
  // property: TS `private` is erased, so the facade holds it in an
  // ES-private field that no consumer can probe.
  expect("backing" in view).toBe(false);
  expect(Object.getOwnPropertyNames(view)).not.toContain("backing");
  expect(Reflect.get(view, "backing")).toBeUndefined();
}

describe("public capability view (issue #108)", () => {
  it("exposes capabilities through a non-mutating read-only map view", () => {
    expect(TOOL_CAPABILITIES.get("fillBox")).toBe("mutate");
    expect(TOOL_CAPABILITIES.has("queryVoxels")).toBe(true);
    expect(TOOL_CAPABILITIES.size).toBeGreaterThan(0);
    expectReadOnlyMapView(TOOL_CAPABILITIES);
  });

  it("keeps creation skills blocked under inspect-only capability after a mutation attempt (issue #108 repro)", () => {
    const furniture = CREATION_SKILLS[0] as (typeof CREATION_SKILLS)[number];
    expect(skillUsableWith(furniture, ["inspect"])).toBe(false);
    // A consumer rewriting the public map must fail...
    expect(() =>
      (TOOL_CAPABILITIES as Map<string, ToolCapability>).set(
        "fillBox",
        "inspect",
      ),
    ).toThrow();
    // ...and the capability decision stays unchanged.
    expect(skillUsableWith(furniture, ["inspect"])).toBe(false);
  });

  it("a consumer probing for the backing map cannot corrupt usability (issue #108 repro)", () => {
    // The full corruption route from the issue must be gone: even a
    // consumer that probes the facade for its backing reference finds
    // nothing to mutate, so capability decisions stay authoritative.
    const backing: unknown = Reflect.get(TOOL_CAPABILITIES, "backing");
    expect(backing).toBeUndefined();
    const furniture = CREATION_SKILLS[0] as (typeof CREATION_SKILLS)[number];
    if (backing !== undefined) {
      for (const tool of furniture.allowedTools) {
        (backing as Map<string, string>).set(tool, "inspect");
      }
    }
    expect(skillUsableWith(furniture, ["inspect"])).toBe(false);
  });
});
