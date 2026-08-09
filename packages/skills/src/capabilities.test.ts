import { describe, expect, it } from "vitest";
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
