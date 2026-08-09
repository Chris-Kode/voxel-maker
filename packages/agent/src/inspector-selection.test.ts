import { describe, expect, it } from "vitest";
import type { JsonValue } from "@voxel-maker/shared";
import { createInspector } from "./inspector.js";
import {
  FIXTURE_IDS,
  createInspectionStore,
  createSelectionPort,
} from "./fixtures.js";
import type { EditorSelectionSnapshot } from "./port.js";

const { store } = createInspectionStore();

function ok(
  name: string,
  args: JsonValue = {},
  port?: ReturnType<typeof createSelectionPort>,
): Readonly<Record<string, JsonValue>> {
  const inspector = createInspector(
    port === undefined ? { store } : { store, port },
  );
  const result = inspector.inspect(name, args);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) return result.value as Readonly<Record<string, JsonValue>>;
  throw new Error("unreachable");
}

const selection: readonly EditorSelectionSnapshot[] = [
  { kind: "node", nodeId: FIXTURE_IDS.arm },
  { kind: "voxel", volumeId: FIXTURE_IDS.volumeMain, voxel: [1, 0, 0] },
  {
    kind: "region",
    volumeId: FIXTURE_IDS.volumeMain,
    region: { min: [0, 0, 0], max: [2, 2, 2] },
  },
];

describe("getSelection (AC: selection injection)", () => {
  it("reports available: false without an editor port", () => {
    const value = ok("getSelection", {});
    expect(value.available).toBe(false);
    expect(value.entries).toEqual([]);
  });

  it("returns the injected port selection verbatim", () => {
    const value = ok("getSelection", {}, createSelectionPort(selection));
    expect(value.available).toBe(true);
    expect(value.entries).toEqual([
      { kind: "node", nodeId: FIXTURE_IDS.arm },
      { kind: "voxel", volumeId: FIXTURE_IDS.volumeMain, voxel: [1, 0, 0] },
      {
        kind: "region",
        volumeId: FIXTURE_IDS.volumeMain,
        region: { min: [0, 0, 0], max: [2, 2, 2] },
      },
    ]);
    expect(value.pruned).toEqual([]);
  });

  it("prunes entries referencing deleted nodes and counts them", () => {
    const stale = createSelectionPort([
      { kind: "node", nodeId: FIXTURE_IDS.arm },
      { kind: "node", nodeId: "node:deleted" },
      { kind: "voxel", volumeId: "volume:deleted", voxel: [0, 0, 0] },
    ]);
    const value = ok("getSelection", {}, stale);
    expect(value.entries).toEqual([{ kind: "node", nodeId: FIXTURE_IDS.arm }]);
    expect(value.pruned).toEqual([
      { reason: "missing-node", nodeId: "node:deleted" },
      { reason: "missing-volume", volumeId: "volume:deleted" },
    ]);
  });

  it("reports an empty selection deterministically", () => {
    const value = ok("getSelection", {}, createSelectionPort([]));
    expect(value.available).toBe(true);
    expect(value.entries).toEqual([]);
  });
});

describe("inspectSummary selection context", () => {
  it("embeds the injected selection when requested", () => {
    const value = ok(
      "inspectSummary",
      { includeSelection: true },
      createSelectionPort(selection),
    );
    const summarySelection = value.selection as Readonly<
      Record<string, JsonValue>
    >;
    expect(summarySelection.available).toBe(true);
    expect(summarySelection.entries as readonly JsonValue[]).toHaveLength(3);
  });

  it("omits selection context when includeSelection is false", () => {
    const value = ok(
      "inspectSummary",
      { includeSelection: false },
      createSelectionPort(selection),
    );
    const summarySelection = value.selection as Readonly<
      Record<string, JsonValue>
    >;
    expect(summarySelection.available).toBe(false);
    expect(summarySelection.entries).toEqual([]);
  });
});

describe("selection port isolation", () => {
  it("never lets port state leak into other tools", () => {
    const port = createSelectionPort([{ kind: "node", nodeId: "node:evil" }]);
    const value = ok("inspectNode", { nodeId: FIXTURE_IDS.root }, port);
    expect(value.nodeId).toBe(FIXTURE_IDS.root);
    expect(value.name).toBe("Root");
  });

  it("caps selection entries at the configured limit", () => {
    const many = Array.from({ length: 300 }, () => ({
      kind: "node" as const,
      nodeId: FIXTURE_IDS.arm,
    }));
    const value = ok("getSelection", {}, createSelectionPort(many));
    expect((value.entries as readonly JsonValue[]).length).toBe(256); // capped at the configured limit
  });
});
