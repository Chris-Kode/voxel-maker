import { describe, expect, it } from "vitest";
import {
  FIXED_SEED,
  assertCanonicalEqual,
  createFixedIds,
  createSeededRng,
  fixedIds,
  mutateBytes,
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

  it("returns a distinct, byte-identical copy when the mutation budget is zero", () => {
    const input = Uint8Array.of(0, 1, 2, 3, 4);
    const output = mutateBytes(input, createSeededRng(1), 0);
    expect(output).not.toBe(input);
    expect(Array.from(output)).toEqual(Array.from(input));
  });

  it("leaves the issue-50 repro input unchanged for a zero budget", () => {
    const input = Uint8Array.of(0);
    const output = mutateBytes(input, createSeededRng(1), 0);
    expect(output).not.toBe(input);
    expect(output[0]).toBe(0);
  });

  it("returns an empty copy for empty input regardless of budget", () => {
    const input = new Uint8Array(0);
    for (const count of [0, 1, 8]) {
      const output = mutateBytes(input, createSeededRng(count), count);
      expect(output).not.toBe(input);
      expect(output.byteLength).toBe(0);
    }
  });

  it("is deterministic and flips no more than the requested bytes", () => {
    const input = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (let count = 1; count <= 16; count += 1) {
      const first = mutateBytes(input, createSeededRng(count), count);
      const second = mutateBytes(input, createSeededRng(count), count);
      expect(Array.from(second)).toEqual(Array.from(first));
      const flips = first.reduce(
        (total, byte, index) => total + (byte === input[index] ? 0 : 1),
        0,
      );
      expect(flips).toBeGreaterThan(0);
      expect(flips).toBeLessThanOrEqual(count);
    }
  });

  it("rejects a negative or fractional mutation budget", () => {
    const input = Uint8Array.of(1, 2, 3);
    expect(() => mutateBytes(input, createSeededRng(1), -1)).toThrow(
      /non-negative integer/u,
    );
    expect(() => mutateBytes(input, createSeededRng(1), 1.5)).toThrow(
      /non-negative integer/u,
    );
  });
});
