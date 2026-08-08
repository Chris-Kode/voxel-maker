import { describe, expect, it } from "vitest";
import {
  FIXED_SEED,
  assertCanonicalEqual,
  createFixedIds,
  fixedIds,
} from "./index.js";

describe("deterministic testkit", () => {
  it("provides fixed identifiers and canonical assertions", () => {
    expect(FIXED_SEED).toBe(1_592_590_337);
    expect(createFixedIds("stable").command).toBe("command:stable:0001");
    expect(fixedIds).toEqual({
      command: "command:fixture:0001",
      document: "document:fixture:0001",
      transaction: "transaction:fixture:0001",
      volume: "volume:fixture:0001",
    });
    expect(() => {
      assertCanonicalEqual({ b: 2, a: 1 }, { a: 1, b: 2 });
    }).not.toThrow();
    expect(() => {
      assertCanonicalEqual({ value: 1 }, { value: 2 });
    }).toThrow(/Canonical values differ/u);
  });
});
