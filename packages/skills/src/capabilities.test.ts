import { describe, expect, it } from "vitest";
import { CREATION_SKILLS } from "./skill-registry.js";
import {
  TOOL_CAPABILITIES,
  requiredCapabilities,
  skillUsableWith,
  unauthorizedTools,
} from "./capabilities.js";

/**
 * Capability tests (plan S14.2, ticket #38): the creation skills'
 * allowed tools resolve to capability classes, every catalog skill
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
    for (const skill of CREATION_SKILLS) {
      const required = requiredCapabilities(skill);
      expect(required.has("inspect"), skill.name).toBe(true);
      expect(required.has("mutate"), skill.name).toBe(true);
    }
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
