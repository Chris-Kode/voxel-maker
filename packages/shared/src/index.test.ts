import { describe, expect, it } from "vitest";
import {
  WorkspaceError,
  type JsonValue,
  animationId,
  canonicalJson,
  createListenerSet,
  commandId,
  componentId,
  documentId,
  err,
  keyframeId,
  materialId,
  nodeId,
  ok,
  recoverySessionId,
  trackId,
  transactionId,
  volumeId,
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

  function expectInvalidIdError(
    parse: (value: unknown) => unknown,
    name: string,
    inputLabel: string,
    input: unknown,
    code: string,
  ): void {
    try {
      parse(input);
      expect.unreachable(`expected ${name}(${inputLabel}) to throw`);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      expect(JSON.parse(JSON.stringify(error))).toMatchObject({
        family: "validation",
        code,
      });
    }
  }

  it("rejects non-string opaque IDs with a serializable INVALID_ID error", () => {
    const parsers: Array<[string, (value: unknown) => unknown]> = [
      ["animationId", animationId],
      ["commandId", commandId],
      ["componentId", componentId],
      ["documentId", documentId],
      ["keyframeId", keyframeId],
      ["nodeId", nodeId],
      ["recoverySessionId", recoverySessionId],
      ["trackId", trackId],
      ["transactionId", transactionId],
      ["volumeId", volumeId],
    ];
    const invalidInputs: Array<[string, unknown]> = [
      ["42", 42],
      ["null", null],
      ["true", true],
      ["{}", {}],
      ["undefined", undefined],
      ["1n", 1n],
      ['Symbol("s")', Symbol("s")],
    ];
    for (const [name, parse] of parsers) {
      for (const [label, invalid] of invalidInputs) {
        expectInvalidIdError(parse, name, label, invalid, "INVALID_ID");
      }
    }
  });

  it("rejects non-number material IDs with a serializable INVALID_MATERIAL_ID error", () => {
    const invalidInputs: Array<[string, unknown]> = [
      ["1n", 1n],
      ['"5"', "5"],
      ["true", true],
      ["null", null],
      ["{}", {}],
      ["undefined", undefined],
      ['Symbol("m")', Symbol("m")],
      ["NaN", NaN],
      ["Infinity", Infinity],
    ];
    for (const [label, invalid] of invalidInputs) {
      expectInvalidIdError(
        materialId,
        "materialId",
        label,
        invalid,
        "INVALID_MATERIAL_ID",
      );
    }
  });

  it("rejects nesting bombs with a structured limit error, not a stack overflow", () => {
    let nested: JsonValue = { leaf: true };
    for (let i = 0; i < 2000; i += 1) nested = { next: nested };
    try {
      canonicalJson(nested);
      expect.unreachable("expected LIMIT_EXCEEDED");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).family).toBe("limit");
      expect((error as WorkspaceError).code).toBe("LIMIT_EXCEEDED");
    }
    // Shallow payloads are unaffected.
    expect(canonicalJson({ a: [{ b: 1 }] })).toBe('{"a":[{"b":1}]}');
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

  it("freezes the instance so runtime writes cannot change serialized output (issue #69)", () => {
    const error = new WorkspaceError({
      family: "validation",
      code: "ORIGINAL",
      message: "original",
      path: ["payload", "id"],
      context: { nested: { reason: "initial" } },
      cause: new Error("secret native details"),
    });
    expect(Object.isFrozen(error)).toBe(true);
    // Freezing must preserve normal Error behavior.
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("WorkspaceError");
    const stack = error.stack;
    expect(stack).toBeTypeOf("string");
    expect(stack?.length).toBeGreaterThan(0);
    const before = JSON.stringify(error);
    // Attempted runtime writes are rejected (Reflect.set reports false on a
    // frozen instance) and must never change the serialized contract.
    expect(Reflect.set(error, "family", "internal")).toBe(false);
    expect(Reflect.set(error, "code", "MUTATED")).toBe(false);
    expect(Reflect.set(error, "message", "mutated")).toBe(false);
    expect(Reflect.set(error, "path", ["hacked"])).toBe(false);
    expect(Reflect.set(error, "context", { hacked: true })).toBe(false);
    expect(Reflect.set(error, "cause", "hacked")).toBe(false);
    expect(JSON.stringify(error)).toBe(before);
    expect(JSON.parse(before)).toEqual({
      family: "validation",
      code: "ORIGINAL",
      message: "original",
      path: ["payload", "id"],
      context: { nested: { reason: "initial" } },
      cause: { type: "Error" },
    });
  });

  it("redacts attacker-controlled and hostile error names in causes (issue #67)", () => {
    const secret = "Authorization: Bearer sk-secret";
    const hostile = new Error("safe");
    hostile.name = secret;
    const wrapped = new WorkspaceError({
      family: "io",
      code: "IO",
      message: "safe",
      cause: hostile,
    });
    const serialized = JSON.parse(JSON.stringify(wrapped)) as {
      cause: { type: string };
    };
    expect(serialized.cause.type).toBe("Error");
    expect(JSON.stringify(wrapped)).not.toContain(secret);

    // A throwing `name` getter must never break construction or serialization.
    const throwing = Object.create(Error.prototype) as Error;
    Object.defineProperty(throwing, "name", {
      get() {
        throw new Error("hostile getter");
      },
    });
    const wrappedThrowing = new WorkspaceError({
      family: "io",
      code: "IO",
      message: "safe",
      cause: throwing,
    });
    expect(JSON.parse(JSON.stringify(wrappedThrowing))).toEqual({
      family: "io",
      code: "IO",
      message: "safe",
      cause: { type: "Error" },
    });

    // A Proxy cause whose prototype lookup throws must also never break
    // construction or serialization.
    const proxyCause = new Proxy(Object.create(Error.prototype) as Error, {
      getPrototypeOf() {
        throw new Error("hostile prototype");
      },
    });
    const wrappedProxy = new WorkspaceError({
      family: "io",
      code: "IO",
      message: "safe",
      cause: proxyCause,
    });
    expect(JSON.parse(JSON.stringify(wrappedProxy))).toEqual({
      family: "io",
      code: "IO",
      message: "safe",
      cause: { type: "Error" },
    });

    // Standard error names still surface as their fixed category.
    const typed = new WorkspaceError({
      family: "io",
      code: "IO",
      message: "safe",
      cause: new TypeError("native detail"),
    });
    expect(JSON.parse(JSON.stringify(typed))).toEqual({
      family: "io",
      code: "IO",
      message: "safe",
      cause: { type: "TypeError" },
    });

    // Non-allowlisted custom class names collapse to the generic type.
    const custom = new Error("native detail");
    custom.name = "CustomNativeError";
    const wrappedCustom = new WorkspaceError({
      family: "io",
      code: "IO",
      message: "safe",
      cause: custom,
    });
    expect(JSON.parse(JSON.stringify(wrappedCustom))).toEqual({
      family: "io",
      code: "IO",
      message: "safe",
      cause: { type: "Error" },
    });

    // Non-Error causes keep their fixed typeof category.
    const objectCause = new WorkspaceError({
      family: "io",
      code: "IO",
      message: "safe",
      cause: { secret: "native detail" },
    });
    expect(JSON.parse(JSON.stringify(objectCause))).toEqual({
      family: "io",
      code: "IO",
      message: "safe",
      cause: { type: "object" },
    });
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
