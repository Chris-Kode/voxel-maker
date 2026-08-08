import { describe, expect, it } from "vitest";
import { runHeadlessTrace } from "./index.js";

describe("headless workspace tracer", () => {
  it("crosses shared, model, voxel, and command seams deterministically", () => {
    expect(runHeadlessTrace()).toBe(
      '{"command":{"accepted":true,"commandId":"command:trace:0001","revision":1},"document":{"documentId":"document:trace:0001","formatVersion":1,"rootNodeId":"node:trace:root","volumeId":"volume:trace:0001"},"voxel":{"chunk":[-1,0,0],"local":[15,0,1],"material":1}}',
    );
    expect(runHeadlessTrace()).toBe(runHeadlessTrace());
  });
});
