import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertDistinctOutputPaths } from "./output-paths.js";

function captureError(call: () => void): string {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("assertDistinctOutputPaths", () => {
  it("allows missing or single output paths", () => {
    expect(() => {
      assertDistinctOutputPaths(undefined, undefined);
    }).not.toThrow();
    expect(() => {
      assertDistinctOutputPaths("/tmp/report.json", undefined);
    }).not.toThrow();
    expect(() => {
      assertDistinctOutputPaths(undefined, "/tmp/trends.json");
    }).not.toThrow();
  });

  it("rejects identical resolved targets with a clear error naming the path", () => {
    const target = join(tmpdir(), "voxel-maker-bench-same.json");
    const message = captureError(() => {
      assertDistinctOutputPaths(target, target);
    });
    expect(message).toContain("--json and --trends resolve to the same file");
    expect(message).toContain(target);
  });

  it("rejects aliased spellings that resolve to the same file", () => {
    const base = join(tmpdir(), "voxel-maker-bench-alias");
    const dotted = join(base, ".", "same.json");
    const plain = join(base, "same.json");
    expect(
      captureError(() => {
        assertDistinctOutputPaths(dotted, plain);
      }),
    ).toContain("resolve to the same file");
    const parent = join(base, "a", "..", "same.json");
    expect(
      captureError(() => {
        assertDistinctOutputPaths(parent, plain);
      }),
    ).toContain("resolve to the same file");
  });

  it("allows distinct targets", () => {
    const base = join(tmpdir(), "voxel-maker-bench-distinct");
    expect(() => {
      assertDistinctOutputPaths(
        join(base, "report.json"),
        join(base, "trends.json"),
      );
    }).not.toThrow();
  });
});
