import { describe, expect, it } from "vitest";
import { volumeId } from "@voxel-maker/shared";
import { CommandRegistry, type CommandHandler } from "./registry.js";

const handler: CommandHandler<"test.cmd", { value: number }> = {
  type: "test.cmd",
  schemaVersion: 1,
  parse: (payload) => payload as { value: number },
  validate: () => undefined,
  execute: () => ({
    changeSet: { volumeId: volumeId("volume:test:0001"), chunks: [] },
    inverse: { type: "test.cmd", schemaVersion: 1, payload: {} },
    declaredAffectedResources: {
      nodeIds: [],
      materialIds: [],
      animationIds: [],
      volumeIds: [volumeId("volume:test:0001")],
    },
  }),
};

describe("CommandRegistry", () => {
  it("registers and looks up handlers by type and schema version", () => {
    const registry = new CommandRegistry();
    registry.register(handler);
    expect(registry.get("test.cmd", 1)).toBe(handler);
    expect(registry.get("test.cmd", 2)).toBeUndefined();
    expect(registry.get("other.cmd", 1)).toBeUndefined();
    expect(registry.hasType("test.cmd")).toBe(true);
    expect(registry.hasType("other.cmd")).toBe(false);
  });

  it("rejects duplicate registration of the same type and version", () => {
    const registry = new CommandRegistry();
    registry.register(handler);
    expect(() => {
      registry.register(handler);
    }).toThrow(/duplicate/i);
  });

  it("allows the same type at a different schema version", () => {
    const registry = new CommandRegistry();
    registry.register(handler);
    const v2: CommandHandler<"test.cmd", { value: number }> = {
      ...handler,
      schemaVersion: 2,
    };
    registry.register(v2);
    expect(registry.get("test.cmd", 2)).toBe(v2);
  });
});
