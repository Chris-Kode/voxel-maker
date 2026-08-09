import { describe, expect, it } from "vitest";
import {
  ResponseBudget,
  boundedEmit,
  clampString,
  jsonUnits,
} from "./budget.js";

describe("jsonUnits", () => {
  it("measures serialized JSON deterministically", () => {
    expect(jsonUnits(null)).toBe(4);
    expect(jsonUnits("ab")).toBe(4);
    expect(jsonUnits([1, 2])).toBe(5);
  });
});

describe("ResponseBudget", () => {
  it("reserves scalar units and marks truncation when exhausted", () => {
    const budget = new ResponseBudget(10);
    budget.reserve(8);
    expect(budget.remaining).toBe(2);
    expect(budget.truncated).toBe(false);
    budget.reserve(8);
    expect(budget.truncated).toBe(true);
  });

  it("accepts items that fit and rejects the first oversized item", () => {
    const budget = new ResponseBudget(10);
    expect(budget.tryReserve("abcd")).toBe(true);
    expect(budget.tryReserve("abcdef")).toBe(false);
    expect(budget.truncated).toBe(true);
    expect(budget.remaining).toBe(4);
  });
});

describe("clampString", () => {
  it("keeps short strings untouched", () => {
    expect(clampString("hello", 8)).toEqual({ value: "hello", truncated: false });
  });

  it("clamps long strings on a character boundary", () => {
    const result = clampString("hello world", 5);
    expect(result.value).toBe("hello");
    expect(result.truncated).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    const result = clampString("ab\u{1f600}cdef", 4);
    expect(result.value).toBe("ab");
    expect(result.truncated).toBe(true);
  });
});

describe("boundedEmit", () => {
  it("emits everything that fits and flags the dropped tail", () => {
    const budget = new ResponseBudget(2);
    const { list, truncated } = boundedEmit(budget, [1, 2, 3], (item) => item);
    expect(list).toEqual([1, 2]);
    expect(truncated).toBe(true);
  });

  it("skips undefined emissions without consuming budget", () => {
    const budget = new ResponseBudget(10);
    const { list, truncated } = boundedEmit(
      budget,
      ["a", "b"],
      (item) => (item === "a" ? undefined : item),
    );
    expect(list).toEqual(["b"]);
    expect(truncated).toBe(false);
  });

  it("is deterministic for identical inputs", () => {
    const first = boundedEmit(new ResponseBudget(30), [1, 2, 3, 4, 5, 6], (i) => i);
    const second = boundedEmit(
      new ResponseBudget(30),
      [1, 2, 3, 4, 5, 6],
      (i) => i,
    );
    expect(first).toEqual(second);
  });
});
