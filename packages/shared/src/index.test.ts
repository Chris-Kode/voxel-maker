import { describe, expect, it } from "vitest";
import {
  WorkspaceError,
  animationId,
  canonicalJson,
  createListenerSet,
  commandId,
  componentId,
  err,
  keyframeId,
  materialId,
  nodeId,
  ok,
  recoverySessionId,
  trackId,
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
    expect(componentId("component:fixture:0001")).toBe(
      "component:fixture:0001",
    );
    expect(keyframeId("keyframe:fixture:0001")).toBe("keyframe:fixture:0001");
    expect(trackId("track:fixture:0001")).toBe("track:fixture:0001");
    expect(recoverySessionId("session:fixture:0001")).toBe(
      "session:fixture:0001",
    );
    expect(() => recoverySessionId("")).toThrow(/Invalid/u);
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

describe("createListenerSet", () => {
  it("notifies listeners and honors unsubscribe", () => {
    const set = createListenerSet<number>();
    const seen: number[] = [];
    const unsubscribe = set.add((value) => {
      seen.push(value);
    });
    set.emit(1);
    set.emit(2);
    unsubscribe();
    set.emit(3);
    expect(seen).toEqual([1, 2]);
  });

  it("isolates throwing listeners", () => {
    const set = createListenerSet<number>();
    set.add(() => {
      throw new Error("listener failure");
    });
    let reached = false;
    set.add(() => {
      reached = true;
    });
    expect(() => {
      set.emit(1);
    }).not.toThrow();
    expect(reached).toBe(true);
  });

  it("tracks size and clears", () => {
    const set = createListenerSet<string>();
    set.add(() => undefined);
    set.add(() => undefined);
    expect(set.size).toBe(2);
    set.clear();
    expect(set.size).toBe(0);
  });
});
