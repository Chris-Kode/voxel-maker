import { describe, expect, it } from "vitest";
import type { JsonValue } from "@voxel-maker/shared";
import { createInspector, type InspectionResult } from "./inspector.js";
import { FIXTURE_IDS, createInspectionStore } from "./fixtures.js";
import {
  INSPECTION_TOOL_CONTRACTS,
  authorizeTools,
  contractByName,
} from "./registry.js";
import { isValidValue } from "./schema.js";
import { INSPECTION_CAPABILITY } from "./registry.js";

const { store } = createInspectionStore();

function resultOf(name: string, args: JsonValue = {}): InspectionResult {
  const inspector = createInspector({ store });
  return inspector.inspect(name, args);
}

function expectOk(name: string, args: JsonValue = {}): JsonValue {
  const result = resultOf(name, args);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) return result.value;
  throw new Error("unreachable");
}

function expectError(
  name: string,
  args: JsonValue,
  code: string,
): InspectionResult {
  const result = resultOf(name, args);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
  }
  return result;
}

describe("inspection envelope (AC: stable ids, revision, conventions)", () => {
  it("carries documentId, revision, contract version, and coordinate conventions", () => {
    const value = expectOk("inspectSummary", { includeSelection: false });
    const record = value as Readonly<Record<string, JsonValue>>;
    expect(record.documentId).toBe(FIXTURE_IDS.document);
    expect(record.revision).toBe(1);
    expect(record.contractVersion).toBe(1);
    expect(record.tool).toBe("inspectSummary");
    expect(record.truncated).toBe(false);
    expect(typeof record.conventions).toBe("string");
    expect((record.conventions as string).length).toBeGreaterThan(50);
  });

  it("deep-freezes every successful response", () => {
    const value = expectOk("inspectMaterials");
    expect(Object.isFrozen(value)).toBe(true);
    const record = value as Readonly<Record<string, JsonValue>>;
    const materials = record.materials as readonly JsonValue[];
    expect(Object.isFrozen(materials)).toBe(true);
    expect(Object.isFrozen(materials[0])).toBe(true);
  });
});

describe("tool dispatch and authorization (AC: separate authorization)", () => {
  it("rejects unknown tool names with UNKNOWN_TOOL", () => {
    expectError("inspectNothing", {}, "UNKNOWN_TOOL");
  });

  it("rejects tools not enabled by the capabilities", () => {
    const inspector = createInspector({ store, capabilities: [] });
    const result = inspector.inspect("inspectSummary", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOOL_NOT_AUTHORIZED");
  });

  it("exposes no inspection tools when only mutation is enabled", () => {
    const inspector = createInspector({
      store,
      capabilities: ["mutate"],
    });
    expect(inspector.contracts).toHaveLength(0);
    const result = inspector.inspect("inspectSummary", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOOL_NOT_AUTHORIZED");
  });

  it("authorizeTools filters purely by capability", () => {
    const all = INSPECTION_TOOL_CONTRACTS;
    expect(authorizeTools(all, [INSPECTION_CAPABILITY])).toHaveLength(
      all.length,
    );
    expect(authorizeTools(all, ["mutate"])).toHaveLength(0);
    expect(authorizeTools(all, [])).toHaveLength(0);
  });
});

describe("malformed arguments (AC: deterministic malformed-argument coverage)", () => {
  it("rejects non-object arguments", () => {
    expectError("inspectMaterials", "nope" as never, "INVALID_ARGUMENT");
  });

  it("rejects unknown properties on closed input schemas", () => {
    expectError(
      "inspectMaterials",
      { pageSize: 5, path: "/etc/passwd" },
      "INVALID_ARGUMENT",
    );
  });

  it("rejects wrong types with stable paths", () => {
    const result = expectError(
      "inspectMaterials",
      { page: "first" },
      "INVALID_ARGUMENT",
    );
    if (!result.ok) {
      expect(result.error.path).toEqual(["page"]);
      expect(result.error.context?.errors).toEqual(["expected an integer"]);
    }
  });

  it("rejects pageSize above the configured maximum with a stable limit error", () => {
    const result = expectError(
      "inspectMaterials",
      { pageSize: 10_000 },
      "INSPECTION_LIMIT",
    );
    if (!result.ok) {
      expect(result.error.family).toBe("limit");
      expect(result.error.context?.limit).toBe("pageSize");
      expect(result.error.path).toEqual(["pageSize"]);
    }
  });

  it("rejects page below 1", () => {
    expectError("inspectMaterials", { page: 0 }, "INVALID_ARGUMENT");
  });

  it("rejects missing required nodeId on inspectNode", () => {
    expectError("inspectNode", {}, "INVALID_ARGUMENT");
  });

  it("rejects a zero ray direction", () => {
    expectError(
      "raycast",
      { origin: [0, 0, 0], direction: [0, 0, 0] },
      "INVALID_ARGUMENT",
    );
  });

  it("rejects hierarchy depth above the hard limit with a stable limit error", () => {
    expectError("inspectHierarchy", { maxDepth: 100 }, "INSPECTION_LIMIT");
  });

  it("rejects measureDistance without a from reference", () => {
    expectError("measureDistance", { toPoint: [1, 1, 1] }, "INVALID_ARGUMENT");
  });

  it("rejects measureDistance with both node and point on one side", () => {
    expectError(
      "measureDistance",
      {
        fromNodeId: FIXTURE_IDS.root,
        fromPoint: [0, 0, 0],
        toPoint: [1, 1, 1],
      },
      "INVALID_ARGUMENT",
    );
  });

  it("rejects a non-integer voxel region", () => {
    expectError(
      "queryVoxels",
      {
        volumeId: FIXTURE_IDS.volumeMain,
        region: { min: [0, 0, 0], max: [1.5, 1, 1] },
      },
      "INVALID_ARGUMENT",
    );
  });

  it("rejects an inverted voxel region", () => {
    expectError(
      "queryVoxels",
      {
        volumeId: FIXTURE_IDS.volumeMain,
        region: { min: [1, 0, 0], max: [0, 1, 1] },
      },
      "INVALID_ARGUMENT",
    );
  });

  it("rejects maxVoxels above the configured budget with a stable limit error", () => {
    expectError(
      "queryVoxels",
      { volumeId: FIXTURE_IDS.volumeMain, maxVoxels: 1_000_000_000 },
      "INSPECTION_LIMIT",
    );
  });

  it("rejects unknown enum loop values", () => {
    expectError("inspectClips", { loop: "pingpong" }, "INVALID_ARGUMENT");
  });
});

describe("missing references (AC: stable missing-reference errors)", () => {
  it("rejects an unknown node with UNKNOWN_NODE", () => {
    expectError("inspectNode", { nodeId: "node:missing" }, "UNKNOWN_NODE");
  });

  it("rejects an unknown volume with UNKNOWN_VOLUME", () => {
    expectError(
      "queryVoxels",
      { volumeId: "volume:missing" },
      "UNKNOWN_VOLUME",
    );
    expectError(
      "inspectBounds",
      { volumeId: "volume:missing" },
      "UNKNOWN_VOLUME",
    );
    expectError(
      "raycast",
      { origin: [0, 0, 0], direction: [1, 0, 0], volumeId: "volume:missing" },
      "UNKNOWN_VOLUME",
    );
  });

  it("rejects an unknown animation with UNKNOWN_ANIMATION", () => {
    expectError(
      "inspectTracks",
      { animationId: "anim:missing" },
      "UNKNOWN_ANIMATION",
    );
  });

  it("rejects an unknown track with UNKNOWN_TRACK", () => {
    expectError(
      "inspectKeyframes",
      { trackId: "track:missing" },
      "UNKNOWN_TRACK",
    );
  });

  it("keeps the store untouched after failed calls", () => {
    expect(store.revision).toBe(1);
    expect(store.getVolume(FIXTURE_IDS.volumeMain)?.occupiedCount()).toBe(4);
  });
});

describe("response budgets (AC: truncation and budgets)", () => {
  it("truncates oversized responses predictably", () => {
    const inspector = createInspector({
      store,
      limits: { maxResponseBytes: 400 },
    });
    const result = inspector.inspect("inspectMaterials", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const record = result.value as Readonly<Record<string, JsonValue>>;
      expect(record.truncated).toBe(true);
      expect(record.truncatedReason).toBe("byte-budget");
    }
  });

  it("does not truncate responses within budget", () => {
    const value = expectOk("inspectMaterials", {});
    expect((value as Readonly<Record<string, JsonValue>>).truncated).toBe(
      false,
    );
  });

  it("truncates hierarchy trees at the byte budget", () => {
    const inspector = createInspector({
      store,
      limits: { maxResponseBytes: 350 },
    });
    const result = inspector.inspect("inspectHierarchy", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const record = result.value as Readonly<Record<string, JsonValue>>;
      expect(record.truncated).toBe(true);
    }
  });

  it("truncates long names deterministically", () => {
    const inspector = createInspector({ store, limits: { maxNameLength: 4 } });
    const result = inspector.inspect("inspectNode", {
      nodeId: FIXTURE_IDS.arm,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const record = result.value as Readonly<Record<string, JsonValue>>;
      expect(record.name).toBe("Arm");
    }
  });
});

describe("contract/output conformance (AC: versioned JSON-schema contracts)", () => {
  const toolArgs: Readonly<Record<string, JsonValue>> = {
    inspectSummary: { includeSelection: false },
    getSelection: {},
    inspectHierarchy: {},
    inspectNode: { nodeId: FIXTURE_IDS.arm, includeWorldTransform: true },
    inspectMaterials: {},
    inspectBounds: {},
    queryVoxels: { volumeId: FIXTURE_IDS.volumeMain },
    raycast: { origin: [-1, 0.5, 0.5], direction: [1, 0, 0] },
    inspectRigging: {},
    inspectClips: {},
    inspectTracks: {},
    inspectKeyframes: { trackId: FIXTURE_IDS.trackWave },
    searchNodes: { query: "arm" },
    measureDistance: {
      fromNodeId: FIXTURE_IDS.root,
      toNodeId: FIXTURE_IDS.arm,
    },
  };

  it("exposes every tool with a versioned, capability-flagged contract", () => {
    expect(INSPECTION_TOOL_CONTRACTS.length).toBeGreaterThanOrEqual(14);
    for (const contract of INSPECTION_TOOL_CONTRACTS) {
      expect(contract.version).toBe(1);
      expect(contract.capability).toBe("inspect");
      expect(contract.name.length).toBeGreaterThan(0);
      expect(contract.description.length).toBeGreaterThan(10);
      expect(contract.inputSchema.type).toBe("object");
      expect(contract.outputSchema.type).toBe("object");
    }
  });

  it("accepts valid arguments against every input schema", () => {
    const inspector = createInspector({ store });
    for (const contract of inspector.contracts) {
      const args = toolArgs[contract.name] ?? {};
      expect(
        isValidValue(contract.inputSchema, args),
        `${contract.name} input schema`,
      ).toBe(true);
    }
  });

  it("validates every real response against its output schema", () => {
    const inspector = createInspector({ store });
    for (const contract of inspector.contracts) {
      const args = toolArgs[contract.name] ?? {};
      const result = inspector.inspect(contract.name, args);
      expect(result.ok, `${contract.name}: ${JSON.stringify(result)}`).toBe(
        true,
      );
      if (result.ok) {
        expect(
          isValidValue(contract.outputSchema, result.value),
          `${contract.name} output schema`,
        ).toBe(true);
      }
    }
  });

  it("never accepts path/url/shell/script-like argument names", () => {
    const forbidden = [
      "path",
      "url",
      "uri",
      "command",
      "shell",
      "script",
      "code",
      "executable",
      "expression",
      "regex",
      "file",
    ];
    for (const contract of INSPECTION_TOOL_CONTRACTS) {
      const properties = Object.keys(contract.inputSchema.properties ?? {});
      for (const property of properties) {
        expect(
          forbidden.includes(property),
          `${contract.name}.${property}`,
        ).toBe(false);
        expect(property.toLowerCase()).not.toMatch(
          /path|url|shell|script|exec|command/,
        );
      }
    }
  });

  it("has a stable unique contract name set", () => {
    const names = INSPECTION_TOOL_CONTRACTS.map((contract) => contract.name);
    expect(new Set(names).size).toBe(names.length);
    expect(contractByName(INSPECTION_TOOL_CONTRACTS, "raycast")?.name).toBe(
      "raycast",
    );
    expect(contractByName(INSPECTION_TOOL_CONTRACTS, "nope")).toBeUndefined();
  });
});
