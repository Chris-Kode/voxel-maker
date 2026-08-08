import { describe, expect, it } from "vitest";
import {
  WorkspaceError,
  animationId,
  canonicalJson,
  commandId,
  err,
  materialId,
  nodeId,
  ok,
} from "./index.js";

describe("shared contracts", () => {
  it("serializes values canonically without insertion-order dependence", () => {
    expect(
      canonicalJson({ z: 1, nested: { b: true, a: "fixed" }, a: [3, 2, 1] }),
    ).toBe('{"a":[3,2,1],"nested":{"a":"fixed","b":true},"z":1}');
    expect(() => canonicalJson({ value: -0 })).toThrow(/negative zero/u);
  });

  it("exposes bounded branded identifier parsers", () => {
    expect(nodeId("node:fixture:0001")).toBe("node:fixture:0001");
    expect(animationId("animation:fixture:0001")).toBe(
      "animation:fixture:0001",
    );
    expect(commandId("command:fixture:0001")).toBe("command:fixture:0001");
    expect(materialId(65_535)).toBe(65_535);
    expect(() => materialId(0)).toThrow(/1 through 65535/u);
    expect(() => materialId(1.5)).toThrow(/1 through 65535/u);
  });

  it("exposes immutable serializable errors with redacted causes", () => {
    const context = { nested: { reason: "initial" } };
    const error = new WorkspaceError({
      family: "validation",
      code: "INVALID_TRACE",
      message: "Trace rejected",
      path: ["payload", "id"],
      context,
      cause: new Error("secret native details"),
    });
    context.nested.reason = "mutated";
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      family: "validation",
      code: "INVALID_TRACE",
      message: "Trace rejected",
      path: ["payload", "id"],
      context: { nested: { reason: "initial" } },
      cause: { type: "Error" },
    });
    expect(ok(4)).toEqual({ ok: true, value: 4 });
    expect(err(error)).toEqual({ ok: false, error });
  });
});
