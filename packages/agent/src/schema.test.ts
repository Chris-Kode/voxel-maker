import { describe, expect, it } from "vitest";
import { isValidValue, schemaErrors, type JsonSchema } from "./schema.js";

const objectSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 8 },
    count: { type: "integer", minimum: 0, maximum: 10 },
    ratio: { type: "number" },
    enabled: { type: "boolean" },
    items: { type: "array", items: { type: "string" }, maxItems: 2 },
    mode: { type: "string", enum: ["fast", "slow"] },
    version: { const: 1 },
  },
  required: ["name"],
};

describe("validateValue (draft-07 subset)", () => {
  it("accepts a well-formed object", () => {
    expect(
      isValidValue(objectSchema, {
        name: "root",
        count: 3,
        ratio: 1.5,
        enabled: true,
        items: ["a", "b"],
        mode: "fast",
        version: 1,
      }),
    ).toBe(true);
  });

  it("rejects a missing required property with a path", () => {
    const errors = schemaErrors(objectSchema, { count: 1 });
    expect(errors).toContain("$.name: is a required property");
  });

  it("rejects unknown properties on closed objects", () => {
    const errors = schemaErrors(objectSchema, { name: "n", path: "/etc" });
    expect(errors).toContain("$.path: is not an allowed property");
  });

  it("rejects non-integer numbers for integer types", () => {
    expect(isValidValue(objectSchema, { name: "n", count: 1.5 })).toBe(false);
  });

  it("rejects numbers outside the declared range", () => {
    expect(isValidValue(objectSchema, { name: "n", count: 11 })).toBe(false);
    expect(isValidValue(objectSchema, { name: "n", count: -1 })).toBe(false);
  });

  it("rejects strings outside the declared length range", () => {
    expect(isValidValue(objectSchema, { name: "" })).toBe(false);
    expect(isValidValue(objectSchema, { name: "toolonger" })).toBe(false);
  });

  it("rejects values outside the enum", () => {
    expect(isValidValue(objectSchema, { name: "n", mode: "warp" })).toBe(false);
  });

  it("rejects non-const values", () => {
    expect(isValidValue(objectSchema, { name: "n", version: 2 })).toBe(false);
  });

  it("rejects array items and length violations", () => {
    expect(isValidValue(objectSchema, { name: "n", items: [1] })).toBe(false);
    expect(isValidValue(objectSchema, { name: "n", items: ["a", "b", "c"] })).toBe(
      false,
    );
  });

  it("reports nested array element paths", () => {
    const errors = schemaErrors(objectSchema, {
      name: "n",
      items: ["ok", 7],
    });
    expect(errors).toContain("$.items[1]: expected string, got number");
  });

  it("rejects a non-object at the root", () => {
    expect(isValidValue(objectSchema, "name")).toBe(false);
  });

  it("rejects NaN and infinities for numbers", () => {
    expect(isValidValue(objectSchema, { name: "n", ratio: NaN })).toBe(false);
    expect(isValidValue(objectSchema, { name: "n", ratio: Infinity })).toBe(false);
  });

  it("accepts null for null-typed schemas", () => {
    expect(isValidValue({ type: "null" }, null)).toBe(true);
    expect(isValidValue({ type: "null" }, 0)).toBe(false);
  });

  it("matches anyOf alternatives", () => {
    const schema: JsonSchema = {
      anyOf: [{ type: "string" }, { type: "integer", minimum: 0 }],
    };
    expect(isValidValue(schema, "x")).toBe(true);
    expect(isValidValue(schema, 3)).toBe(true);
    expect(isValidValue(schema, -1)).toBe(false);
    expect(isValidValue(schema, 1.5)).toBe(false);
  });
});
