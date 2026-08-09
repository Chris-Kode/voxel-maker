import { describe, expect, it } from "vitest";
import { commandId, materialId, type JsonValue } from "@voxel-maker/shared";
import {
  authorizeTools,
  contractByName,
  createPreviewRegistry,
  MUTATION_CAPABILITY,
  MUTATION_TOOL_CONTRACTS,
} from "./registry.js";
import { FIXTURE_IDS, createInspectionStore } from "./fixtures.js";
import { CommandRegistry } from "@voxel-maker/commands";
import { createMutator, type Mutator } from "./mutator.js";
import { createPreviewSession } from "./preview.js";
import { isValidValue } from "./schema.js";
import { MUTATION_CONTRACT_VERSION } from "./contract.js";
import { fillBoxCommand } from "@voxel-maker/commands";

/**
 * Deterministic mutation-tool tests (plan S11.5/S11.6/S11.9/S11.10,
 * ticket #32): every mutation tool constructs exactly one registered
 * command with an explicit (or deterministically generated) command id and
 * a base revision; malformed arguments, missing references, and budget
 * violations fail with stable errors before any command is built.
 */

const { store } = createInspectionStore();

function makeMutator(
  options: { readonly capabilities?: readonly ("inspect" | "mutate")[] } = {},
): { readonly mutator: Mutator; readonly registry: CommandRegistry } {
  const registry = createPreviewRegistry();
  const mutator = createMutator({
    store,
    registry,
    ...(options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
  });
  return { mutator, registry };
}

function constructOk(
  mutator: Mutator,
  name: string,
  args: JsonValue = {},
): Readonly<Record<string, JsonValue>> {
  const result = mutator.construct(name, args);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.value as Readonly<Record<string, JsonValue>>;
}

function constructError(
  mutator: Mutator,
  name: string,
  args: JsonValue,
  code: string,
): void {
  const result = mutator.construct(name, args);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

/** Minimal valid arguments for every mutation tool (table-driven smoke). */
const VALID_ARGS: Readonly<Record<string, JsonValue>> = {
  createNode: {
    nodeId: "node:test:new",
    parentId: FIXTURE_IDS.root,
    name: "New",
    transform: IDENTITY,
  },
  deleteNode: { nodeId: FIXTURE_IDS.arm },
  renameNode: { nodeId: FIXTURE_IDS.arm, name: "Renamed" },
  reparentNode: {
    nodeId: FIXTURE_IDS.arm,
    newParentId: FIXTURE_IDS.root,
    placement: "preserve-local",
  },
  setNodeTransform: { nodeId: FIXTURE_IDS.arm, transform: IDENTITY },
  setNodeComponents: { nodeId: FIXTURE_IDS.arm, components: [] },
  setNodeMetadata: { nodeId: FIXTURE_IDS.arm, metadata: { tags: ["a"] } },
  createVolume: { volumeId: "volume:test:new" },
  deleteVolume: { volumeId: FIXTURE_IDS.volumeEmpty },
  createMaterial: {
    materialId: 7,
    name: "test",
    color: "#ff0000",
    opacity: 1,
    roughness: 0.5,
    metallic: 0,
    emissive: 0,
  },
  updateMaterial: { materialId: 1, name: "updated" },
  deleteMaterial: { materialId: 2 },
  fillBox: {
    volumeId: FIXTURE_IDS.volumeMain,
    region: { min: [0, 0, 0], max: [1, 1, 1] },
    material: 1,
  },
  fillSphere: {
    volumeId: FIXTURE_IDS.volumeMain,
    center: [0, 0, 0],
    radius: 1,
    material: 1,
  },
  fillCylinder: {
    volumeId: FIXTURE_IDS.volumeMain,
    center: [0, 0, 0],
    radius: 1,
    height: 2,
    axis: "y",
    material: 1,
  },
  setVoxelBatch: {
    volumeId: FIXTURE_IDS.volumeMain,
    entries: [{ coordinate: [0, 0, 0], material: 1 }],
  },
  removeVoxelBatch: {
    volumeId: FIXTURE_IDS.volumeMain,
    coordinates: [[0, 0, 0]],
  },
  replaceVoxelMaterial: {
    volumeId: FIXTURE_IDS.volumeMain,
    fromMaterial: 1,
    toMaterial: 2,
  },
  copyRegion: {
    volumeId: FIXTURE_IDS.volumeMain,
    source: { min: [0, 0, 0], max: [1, 1, 1] },
    destination: [2, 0, 0],
  },
  deleteRegion: {
    volumeId: FIXTURE_IDS.volumeMain,
    region: { min: [0, 0, 0], max: [1, 1, 1] },
  },
  translateRegion: {
    volumeId: FIXTURE_IDS.volumeMain,
    region: { min: [0, 0, 0], max: [1, 1, 1] },
    delta: [1, 0, 0],
  },
  rotateRegion: {
    volumeId: FIXTURE_IDS.volumeMain,
    region: { min: [0, 0, 0], max: [1, 1, 1] },
    axis: "y",
    quarterTurns: 1,
  },
  mirrorRegion: {
    volumeId: FIXTURE_IDS.volumeMain,
    region: { min: [0, 0, 0], max: [1, 1, 1] },
    axis: "x",
  },
};

describe("mutation tool surface (AC: registered commands, explicit ids, base revision)", () => {
  it("exposes only mutation-capability contracts", () => {
    const { mutator } = makeMutator();
    expect(mutator.contracts.length).toBe(MUTATION_TOOL_CONTRACTS.length);
    expect(MUTATION_TOOL_CONTRACTS.length).toBeGreaterThan(10);
    for (const contract of mutator.contracts) {
      expect(contract.capability).toBe(MUTATION_CAPABILITY);
      expect(contract.version).toBe(MUTATION_CONTRACT_VERSION);
    }
    expect(authorizeTools(MUTATION_TOOL_CONTRACTS, ["inspect"])).toHaveLength(
      0,
    );
  });

  it("authorization separates inspection from mutation", () => {
    const { mutator } = makeMutator({ capabilities: [] });
    expect(mutator.contracts).toHaveLength(0);
    constructError(mutator, "fillBox", {}, "TOOL_NOT_AUTHORIZED");
  });

  it("constructs a registered fillBox command with an explicit id and base revision", () => {
    const { mutator } = makeMutator();
    const value = constructOk(mutator, "fillBox", {
      volumeId: FIXTURE_IDS.volumeMain,
      region: { min: [0, 0, 0], max: [2, 2, 2] },
      material: 1,
      commandId: "command:test:fill:0001",
    });
    expect(value.baseRevision).toBe(store.revision);
    expect(value.revision).toBe(store.revision);
    expect(value.voxelEstimate).toBe(8);
    const command = value.command as Readonly<Record<string, JsonValue>>;
    expect(command.id).toBe("command:test:fill:0001");
    expect(command.type).toBe("voxel.fillBox");
    expect(command.schemaVersion).toBe(1);
    const payload = command.payload as Readonly<Record<string, JsonValue>>;
    expect(payload.volumeId).toBe(FIXTURE_IDS.volumeMain);
    expect(payload.material).toBe(1);
    expect(
      isValidValue(
        contractByName(MUTATION_TOOL_CONTRACTS, "fillBox")?.outputSchema ?? {},
        value,
      ),
    ).toBe(true);
  });

  it("generates deterministic command ids in call order when not supplied", () => {
    const { mutator } = makeMutator();
    const first = constructOk(mutator, "createNode", VALID_ARGS.createNode);
    const second = constructOk(mutator, "createNode", VALID_ARGS.createNode);
    const firstCommand = first.command as Readonly<Record<string, JsonValue>>;
    const secondCommand = second.command as Readonly<Record<string, JsonValue>>;
    expect(firstCommand.id).toBe("command:createNode:0");
    expect(secondCommand.id).toBe("command:createNode:1");
  });

  it("rejects unknown tool names", () => {
    constructError(makeMutator().mutator, "fillNothing", {}, "UNKNOWN_TOOL");
  });

  it("deep-freezes every successful response", () => {
    const value = constructOk(
      makeMutator().mutator,
      "fillBox",
      VALID_ARGS.fillBox,
    );
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.command)).toBe(true);
    expect(
      Object.isFrozen((value.command as Record<string, unknown>).payload),
    ).toBe(true);
  });

  it("constructs one registered command for every mutation tool", () => {
    const { mutator, registry } = makeMutator();
    for (const contract of mutator.contracts) {
      const args = VALID_ARGS[contract.name];
      expect(args, `fixture args for ${contract.name}`).toBeDefined();
      if (args === undefined) continue;
      const result = mutator.construct(contract.name, args);
      expect(result.ok, `${contract.name}: ${JSON.stringify(result)}`).toBe(
        true,
      );
      if (!result.ok) continue;
      const value = result.value as Readonly<Record<string, JsonValue>>;
      expect(isValidValue(contract.outputSchema, value), contract.name).toBe(
        true,
      );
      const command = value.command as Readonly<Record<string, JsonValue>>;
      // Every constructed command must be registered (AC 1).
      const registered = registry.get(
        command.type as string,
        command.schemaVersion as number,
      );
      expect(
        registered,
        `${contract.name} -> ${command.type as string}`,
      ).toBeDefined();
    }
  });
});

describe("mutation argument validation (AC: same schemas and errors as UI)", () => {
  const { mutator } = makeMutator();

  it("rejects malformed fillBox arguments", () => {
    constructError(
      mutator,
      "fillBox",
      { volumeId: FIXTURE_IDS.volumeMain },
      "INVALID_ARGUMENT",
    );
    constructError(
      mutator,
      "fillBox",
      {
        volumeId: FIXTURE_IDS.volumeMain,
        region: { min: [0, 0, 0], max: [2, 2, 2] },
        material: 0,
      },
      "INVALID_ARGUMENT",
    );
    constructError(
      mutator,
      "fillBox",
      {
        volumeId: FIXTURE_IDS.volumeMain,
        region: { min: [0, 0, 0], max: [2, 2, 2] },
        material: 1,
        sneaky: true,
      },
      "INVALID_ARGUMENT",
    );
    constructError(
      mutator,
      "fillBox",
      {
        volumeId: FIXTURE_IDS.volumeMain,
        region: { min: [0, 0, 0], max: [2, 2, 2] },
        material: 70_000,
      },
      "INVALID_ARGUMENT",
    );
  });

  it("rejects unknown node, volume, and material references", () => {
    constructError(
      mutator,
      "fillBox",
      {
        volumeId: "volume:nope",
        region: { min: [0, 0, 0], max: [1, 1, 1] },
        material: 1,
      },
      "UNKNOWN_VOLUME",
    );
    constructError(
      mutator,
      "createNode",
      {
        nodeId: "node:test:x",
        parentId: "node:nope",
      },
      "UNKNOWN_NODE",
    );
    constructError(
      mutator,
      "updateMaterial",
      { materialId: 42 },
      "UNKNOWN_MATERIAL",
    );
  });

  it("rejects batch entries beyond the configured budget", () => {
    const small = createMutator({
      store,
      registry: createPreviewRegistry(),
      limits: { maxBatchEntries: 2 },
    });
    const entries = [
      { coordinate: [0, 0, 0], material: 1 },
      { coordinate: [1, 0, 0], material: 1 },
      { coordinate: [2, 0, 0], material: 1 },
    ];
    constructError(
      small,
      "setVoxelBatch",
      { volumeId: FIXTURE_IDS.volumeMain, entries },
      "MUTATION_LIMIT",
    );
  });

  it("reports the same voxel estimate the session budget enforces", () => {
    const { mutator } = makeMutator();
    const value = constructOk(mutator, "copyRegion", VALID_ARGS.copyRegion);
    // copyRegion touches source and destination regions: the session
    // budgets 2x the source volume, and the tool reports the same number.
    expect(value.voxelEstimate).toBe(2);
  });

  it("rejects a command id that is too long", () => {
    constructError(
      mutator,
      "fillBox",
      {
        volumeId: FIXTURE_IDS.volumeMain,
        region: { min: [0, 0, 0], max: [1, 1, 1] },
        material: 1,
        commandId: "x".repeat(200),
      },
      "INVALID_ARGUMENT",
    );
  });
});

describe("mutation tools bound to a preview session", () => {
  it("reports the session base revision and staged revision", () => {
    const session = createPreviewSession({ live: store });
    const mutator = createMutator({
      store: session,
      registry: createPreviewRegistry(),
      session,
    });
    const first = constructOk(mutator, "fillBox", {
      volumeId: FIXTURE_IDS.volumeMain,
      region: { min: [0, 0, 0], max: [1, 1, 1] },
      material: 1,
      commandId: "command:test:fill:0001",
    });
    expect(first.baseRevision).toBe(store.revision);
    expect(first.revision).toBe(store.revision);
    const staged = session.stage(
      fillBoxCommand(commandId("command:test:fill:0001"), {
        volumeId: FIXTURE_IDS.volumeMain,
        region: { min: [0, 0, 0], max: [1, 1, 1] },
        material: materialId(1),
      }),
    );
    expect(staged.ok).toBe(true);
    const second = constructOk(mutator, "fillBox", {
      volumeId: FIXTURE_IDS.volumeMain,
      region: { min: [1, 1, 1], max: [2, 2, 2] },
      material: 1,
      commandId: "command:test:fill:0002",
    });
    // Staged reads observe prior staged commands: the revision moves with
    // the overlay while the base revision stays fixed.
    expect(second.baseRevision).toBe(store.revision);
    expect(second.revision).toBe(store.revision + 1);
    session.discard();
  });
});
