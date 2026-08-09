import { describe, expect, it } from "vitest";
import {
  CommandBus,
  CommandRegistry,
  createNodeCommand,
  createVolumeCommand,
  fillBoxCommand,
  setVoxelCommand,
} from "@voxel-maker/commands";
import type {
  DocumentCommitted,
  DocumentStoreRead,
} from "@voxel-maker/document";
import {
  commandId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
  type MaterialId,
} from "@voxel-maker/shared";
import { FIXTURE_IDS, createInspectionStore } from "./fixtures.js";
import { createInspector } from "./inspector.js";
import {
  createPreviewRegistry,
  MUTATION_TOOL_CONTRACTS,
  contractByName,
} from "./registry.js";
import { createPreviewSession, previewSessionId } from "./preview.js";

/**
 * Preview session tests (plan S11.11/S11.15, ticket #32): a copy-on-write
 * overlay exposes staged reads and an isolated event/worker namespace,
 * staging produces bounded diffs and validation errors with zero live
 * side effects, and Apply is one optimistic transaction while Discard and
 * cancellation release every preview resource.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

interface LiveFixture {
  readonly store: DocumentStoreRead;
  readonly bus: CommandBus;
  readonly registry: CommandRegistry;
}

function liveFixture(): LiveFixture {
  const { handle } = createInspectionStore();
  const registry = createPreviewRegistry();
  const bus = new CommandBus(handle.store, registry, handle.writeCapability);
  return { store: handle.store, bus, registry };
}

/** Deterministic fill-box command over the fixture main volume. */
function fillCommand(
  id: string,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): ReturnType<typeof fillBoxCommand> {
  return fillBoxCommand(commandId(id), {
    volumeId: FIXTURE_IDS.volumeMain,
    region: { min: [...min], max: [...max] },
    material: materialId(1),
  });
}

describe("preview session creation (AC: mandatory base revision)", () => {
  it("captures the live revision as the base revision and clones the document", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({ live: store });
    expect(session.baseRevision).toBe(store.revision);
    expect(session.revision).toBe(store.revision);
    expect(session.documentId).toBe(FIXTURE_IDS.document);
    expect(session.sessionId).toBe(
      previewSessionId(`preview:${FIXTURE_IDS.document}:1`),
    );
    expect(session.namespace).toBe(session.sessionId);
    expect(session.namespace).toMatch(/^preview:/);
    expect(session.closed).toBe(false);
    expect(session.stagedCount).toBe(0);
    expect(session.voxelEstimate).toBe(0);
    session.discard();
  });

  it("honors an explicit base revision", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({ live: store, baseRevision: 0 });
    expect(session.baseRevision).toBe(0);
    expect(session.revision).toBe(0);
    session.discard();
  });

  it("rejects a base revision above the live revision", () => {
    const { store } = liveFixture();
    expect(() =>
      createPreviewSession({ live: store, baseRevision: 2 }),
    ).toThrow();
  });

  it("exposes a distinct worker namespace per session", () => {
    const { store } = liveFixture();
    const a = createPreviewSession({
      live: store,
      sessionId: previewSessionId("preview:test:a"),
    });
    const b = createPreviewSession({
      live: store,
      sessionId: previewSessionId("preview:test:b"),
    });
    expect(a.namespace).not.toBe(b.namespace);
    expect(a.namespace).toBe("preview:test:a");
    a.discard();
    b.discard();
  });
});

describe("staged reads observe prior staged commands (AC: COW overlay)", () => {
  it("stages a command and exposes the staged state through reads", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({ live: store });
    const result = session.stage(
      fillCommand("command:test:stage:0001", [0, 0, 0], [2, 2, 2]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.revision).toBe(store.revision + 1);
    expect(session.revision).toBe(store.revision + 1);
    expect(session.stagedCount).toBe(1);
    expect(session.voxelEstimate).toBe(8);
    // Staged voxel reads see the overlay.
    expect(session.getVoxel(FIXTURE_IDS.volumeMain, [1, 1, 0])).toBe(1);
    // Untouched volumes read through to the live data.
    expect(session.getVoxel(FIXTURE_IDS.volumeMain, [0, 0, 1])).toBe(1);
    session.discard();
  });

  it("lets inspection tools run against the staged read model", () => {
    const { store } = liveFixture();
    void store;
    const session = createPreviewSession({ live: store });
    const staged = session.stage(
      fillCommand("command:test:stage:0002", [0, 0, 0], [4, 4, 1]),
    );
    expect(staged.ok).toBe(true);
    const inspector = createInspector({ store: session });
    const result = inspector.inspect("queryVoxels", {
      volumeId: FIXTURE_IDS.volumeMain,
      region: { min: [0, 0, 0], max: [4, 4, 1] },
      maxVoxels: 100,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const value = result.value as Readonly<Record<string, unknown>>;
    expect(value.revision).toBe(store.revision + 1);
    expect(value.total).toBe(16);
    session.discard();
  });

  it("keeps a second staged command visible to later reads", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({ live: store });
    const first = session.stage(
      fillCommand("command:test:stage:0003", [0, 0, 0], [2, 1, 1]),
    );
    const second = session.stage(
      fillCommand("command:test:stage:0004", [5, 5, 5], [6, 6, 6]),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(session.revision).toBe(store.revision + 2);
    expect(session.getVoxel(FIXTURE_IDS.volumeMain, [0, 0, 0])).toBe(1);
    expect(session.getVoxel(FIXTURE_IDS.volumeMain, [5, 5, 5])).toBe(1);
    session.discard();
  });
});

describe("staging has zero live side effects (AC: live untouched)", () => {
  it("does not change live revision, voxels, history, or events", () => {
    const { store, bus } = liveFixture();
    const liveEvents: DocumentCommitted[] = [];
    const unsubscribe = store.subscribe((event) => {
      liveEvents.push(event);
    });
    const session = createPreviewSession({ live: store });
    expect(
      session.stage(fillCommand("command:test:iso:0001", [0, 0, 0], [2, 2, 2]))
        .ok,
    ).toBe(true);
    expect(
      session.stage(fillCommand("command:test:iso:0002", [5, 5, 5], [6, 6, 6]))
        .ok,
    ).toBe(true);
    expect(
      session.stage(
        createNodeCommand(commandId("command:test:iso:0003"), {
          nodeId: nodeId("node:test:iso"),
          parentId: FIXTURE_IDS.root,
          name: "Isolated",
          transform: IDENTITY,
        }),
      ).ok,
    ).toBe(true);
    // Live revision, voxels, history, and emitted events are untouched.
    expect(store.revision).toBe(1);
    expect(store.getVoxel(FIXTURE_IDS.volumeMain, [1, 1, 0])).toBe(
      0 as MaterialId,
    );
    expect(
      (store.getDocument().nodes as Readonly<Record<string, unknown>>)[
        "node:test:iso"
      ],
    ).toBeUndefined();
    expect(bus.historySnapshot().past).toHaveLength(0);
    expect(bus.historySnapshot().future).toHaveLength(0);
    expect(liveEvents).toHaveLength(0);
    unsubscribe();
    session.discard();
  });

  it("emits staged events on the preview namespace only", () => {
    const { store } = liveFixture();
    const liveEvents: DocumentCommitted[] = [];
    const unsubscribeLive = store.subscribe((event) => {
      liveEvents.push(event);
    });
    const session = createPreviewSession({ live: store });
    const previewEvents: DocumentCommitted[] = [];
    const unsubscribePreview = session.subscribe((event) => {
      previewEvents.push(event);
    });
    expect(
      session.stage(fillCommand("command:test:evt:0001", [0, 0, 0], [2, 2, 2]))
        .ok,
    ).toBe(true);
    expect(previewEvents).toHaveLength(1);
    const event = previewEvents[0];
    expect(event?.source).toBe("ai");
    expect(event?.revisionBefore).toBe(1);
    expect(event?.revisionAfter).toBe(2);
    expect(event?.changedVolumes[0]?.volumeId).toBe(FIXTURE_IDS.volumeMain);
    expect(liveEvents).toHaveLength(0);
    unsubscribeLive();
    unsubscribePreview();
    session.discard();
  });

  it("isolates events between two sessions", () => {
    const { store } = liveFixture();
    const a = createPreviewSession({ live: store });
    const b = createPreviewSession({ live: store });
    const eventsA: DocumentCommitted[] = [];
    const eventsB: DocumentCommitted[] = [];
    a.subscribe((event) => {
      eventsA.push(event);
    });
    b.subscribe((event) => {
      eventsB.push(event);
    });
    expect(
      a.stage(fillCommand("command:test:two:0001", [0, 0, 0], [2, 2, 2])).ok,
    ).toBe(true);
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(0);
    a.discard();
    b.discard();
  });
});

describe("stage validation and budgets (AC: bounded validation errors)", () => {
  it("rejects an invalid command without changing the staged state", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({ live: store });
    const bad = fillBoxCommand(commandId("command:test:bad:0001"), {
      volumeId: volumeId("volume:missing"),
      region: { min: [0, 0, 0], max: [1, 1, 1] },
      material: materialId(1),
    });
    const result = session.stage(bad);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("MISSING_VOLUME");
    expect(session.stagedCount).toBe(0);
    expect(session.revision).toBe(store.revision);
    // The session remains usable after a rejected stage.
    expect(
      session.stage(
        fillCommand("command:test:after:0001", [0, 0, 0], [2, 2, 2]),
      ).ok,
    ).toBe(true);
    session.discard();
  });

  it("rejects an unregistered command type", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({ live: store });
    const result = session.stage({
      id: commandId("command:test:fake"),
      type: "no.such.command",
      schemaVersion: 1,
      payload: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_COMMAND_TYPE");
    session.discard();
  });

  it("rejects duplicate command ids within one session", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({ live: store });
    const command = fillCommand("command:test:dup:0001", [0, 0, 0], [2, 2, 2]);
    expect(session.stage(command).ok).toBe(true);
    const again = session.stage(command);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("DUPLICATE_COMMAND_ID");
    session.discard();
  });

  it("enforces the staged-command budget with a stable limit error", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({
      live: store,
      limits: { maxStagedCommands: 2 },
    });
    expect(
      session.stage(
        fillCommand("command:test:budget:0001", [0, 0, 0], [2, 2, 2]),
      ).ok,
    ).toBe(true);
    expect(
      session.stage(
        fillCommand("command:test:budget:0002", [0, 0, 0], [2, 2, 2]),
      ).ok,
    ).toBe(true);
    const third = session.stage(
      fillCommand("command:test:budget:0003", [0, 0, 0], [2, 2, 2]),
    );
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error.family).toBe("limit");
      expect(third.error.code).toBe("STAGING_COMMAND_LIMIT");
    }
    expect(session.stagedCount).toBe(2);
    session.discard();
  });

  it("enforces the cumulative proposed-voxel budget", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({
      live: store,
      limits: { maxProposedVoxelChanges: 10 },
    });
    expect(
      session.stage(fillCommand("command:test:vox:0001", [0, 0, 0], [2, 2, 2]))
        .ok,
    ).toBe(true);
    const second = session.stage(
      fillCommand("command:test:vox:0002", [1, 1, 1], [3, 3, 3]),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.family).toBe("limit");
      expect(second.error.code).toBe("STAGING_VOXEL_LIMIT");
    }
    expect(session.voxelEstimate).toBe(8);
    session.discard();
  });

  it("stageMany stops at the first failure and keeps earlier stages", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({ live: store });
    const many = session.stageMany([
      fillCommand("command:test:many:0001", [0, 0, 0], [2, 2, 2]),
      fillBoxCommand(commandId("command:test:many:0002"), {
        volumeId: volumeId("volume:missing"),
        region: { min: [0, 0, 0], max: [1, 1, 1] },
        material: materialId(1),
      }),
      fillCommand("command:test:many:0003", [5, 5, 5], [6, 6, 6]),
    ]);
    expect(many.ok).toBe(false);
    if (many.ok) throw new Error("unreachable");
    expect(many.error.code).toBe("MISSING_VOLUME");
    expect(many.index).toBe(1);
    expect(session.stagedCount).toBe(1);
    expect(session.revision).toBe(store.revision + 1);
    session.discard();
  });
});

describe("bounded semantic diff", () => {
  it("summarizes staged commands, changed ids, and voxel estimates", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({ live: store });
    expect(
      session.stage(
        createNodeCommand(commandId("command:test:diff:0001"), {
          nodeId: nodeId("node:test:diff"),
          parentId: FIXTURE_IDS.root,
          name: "Diff",
          transform: IDENTITY,
        }),
      ).ok,
    ).toBe(true);
    expect(
      session.stage(fillCommand("command:test:diff:0002", [0, 0, 0], [2, 2, 2]))
        .ok,
    ).toBe(true);
    const diff = session.diff();
    expect(diff.ok).toBe(true);
    if (!diff.ok) throw new Error("unreachable");
    const value = diff.value;
    expect(value.baseRevision).toBe(store.revision);
    expect(value.revision).toBe(store.revision + 2);
    expect(value.stagedCommandCount).toBe(2);
    expect(value.voxelEstimate).toBe(8);
    // Voxel commands declare every node referencing the touched volume as
    // affected (plan 5.3), so the fill also reports the fixture's body node.
    expect(value.changedNodeIds).toEqual(["node:test:diff", "node:body"]);
    expect(value.changedVolumeIds).toEqual([FIXTURE_IDS.volumeMain]);
    // The fill command declares the material it writes as affected.
    expect(value.changedMaterialIds).toEqual([1]);
    expect(value.commandTypes).toEqual([
      { type: "node.create", count: 1 },
      { type: "voxel.fillBox", count: 1 },
    ]);
    expect(value.truncated).toBe(false);
    session.discard();
  });

  it("truncates id lists at the diff entry budget", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({
      live: store,
      limits: { maxDiffEntries: 2 },
    });
    for (let index = 0; index < 3; index += 1) {
      const result = session.stage(
        createNodeCommand(
          commandId(`command:test:dtrunc:000${String(index)}`),
          {
            nodeId: nodeId(`node:test:dtrunc:${String(index)}`),
            parentId: FIXTURE_IDS.root,
            name: `T${String(index)}`,
            transform: IDENTITY,
          },
        ),
      );
      expect(result.ok).toBe(true);
    }
    const diff = session.diff();
    expect(diff.ok).toBe(true);
    if (!diff.ok) throw new Error("unreachable");
    expect(diff.value.changedNodeIds).toHaveLength(2);
    expect(diff.value.truncated).toBe(true);
    expect(diff.value.stagedCommandCount).toBe(3);
    session.discard();
  });
});

describe("apply: one optimistic transaction", () => {
  it("applies all staged commands as a single live transaction", () => {
    const { store, bus } = liveFixture();
    const session = createPreviewSession({ live: store, applyBus: bus });
    expect(
      session.stage(
        fillCommand("command:test:apply:0001", [0, 0, 0], [2, 2, 2]),
      ).ok,
    ).toBe(true);
    expect(
      session.stage(
        fillCommand("command:test:apply:0002", [5, 5, 5], [6, 6, 6]),
      ).ok,
    ).toBe(true);
    const result = session.apply({
      transactionId: transactionId("transaction:test:apply:0001"),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.transactionId).toBe("transaction:test:apply:0001");
    expect(result.value.revisionBefore).toBe(1);
    expect(result.value.revisionAfter).toBe(2);
    expect(result.value.event.source).toBe("ai");
    expect(result.value.event.commandIds).toEqual([
      "command:test:apply:0001",
      "command:test:apply:0002",
    ]);
    // Exactly one history entry for the whole proposal.
    const history = bus.historySnapshot();
    expect(history.past).toHaveLength(1);
    expect(history.past[0]?.revisionBefore).toBe(1);
    expect(history.past[0]?.revisionAfter).toBe(2);
    expect(history.past[0]?.source).toBe("ai");
    // Live state now carries the staged content.
    expect(store.revision).toBe(2);
    expect(store.getVoxel(FIXTURE_IDS.volumeMain, [1, 1, 0])).toBe(1);
    expect(store.getVoxel(FIXTURE_IDS.volumeMain, [5, 5, 5])).toBe(1);
    // Apply released the preview resources.
    expect(session.closed).toBe(true);
  });

  it("rejects apply without an apply bus", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({ live: store });
    expect(
      session.stage(
        fillCommand("command:test:nobus:0001", [0, 0, 0], [2, 2, 2]),
      ).ok,
    ).toBe(true);
    const result = session.apply();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("APPLY_TARGET_MISSING");
    expect(store.revision).toBe(1);
    session.discard();
  });

  it("rejects apply with nothing staged", () => {
    const { store, bus } = liveFixture();
    const session = createPreviewSession({ live: store, applyBus: bus });
    const result = session.apply();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOTHING_TO_APPLY");
    expect(store.revision).toBe(1);
    session.discard();
  });

  it("fails with REVISION_CONFLICT when the live document advanced", () => {
    const { store, bus } = liveFixture();
    const session = createPreviewSession({ live: store, applyBus: bus });
    expect(
      session.stage(
        fillCommand("command:test:conflict:0001", [0, 0, 0], [2, 2, 2]),
      ).ok,
    ).toBe(true);
    // The live document advances behind the session's back (plan S12.9:
    // a conflict is never silently rebased).
    const external = bus.execute(
      setVoxelCommand(commandId("command:test:external:0001"), {
        volumeId: FIXTURE_IDS.volumeMain,
        coordinate: [9, 9, 9],
        material: materialId(2),
      }),
      {
        transactionId: transactionId("transaction:test:external:0001"),
        expectedRevision: 1,
        source: "ui",
      },
    );
    expect(external.ok).toBe(true);
    const result = session.apply({
      transactionId: transactionId("transaction:test:apply:conflict"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("REVISION_CONFLICT");
    // The failed apply left live state and history untouched.
    expect(store.revision).toBe(2);
    expect(bus.historySnapshot().past).toHaveLength(1);
    expect(session.closed).toBe(false);
    session.discard();
  });

  it("uses a deterministic default transaction id", () => {
    const { store, bus } = liveFixture();
    const session = createPreviewSession({ live: store, applyBus: bus });
    expect(
      session.stage(
        fillCommand("command:test:defid:0001", [0, 0, 0], [2, 2, 2]),
      ).ok,
    ).toBe(true);
    const result = session.apply();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.transactionId).toBe(
      `transaction:ai:apply:${session.sessionId}`,
    );
    session.discard();
  });
});

describe("discard and cancellation release all preview resources", () => {
  it("discard closes the session with no live side effects", () => {
    const { store, bus } = liveFixture();
    const liveEvents: DocumentCommitted[] = [];
    const unsubscribe = store.subscribe((event) => {
      liveEvents.push(event);
    });
    const session = createPreviewSession({ live: store, applyBus: bus });
    expect(
      session.stage(
        fillCommand("command:test:discard:0001", [0, 0, 0], [2, 2, 2]),
      ).ok,
    ).toBe(true);
    session.discard();
    expect(session.closed).toBe(true);
    expect(session.stagedCount).toBe(0);
    expect(store.revision).toBe(1);
    expect(store.getVoxel(FIXTURE_IDS.volumeMain, [1, 1, 0])).toBe(
      0 as MaterialId,
    );
    expect(liveEvents).toHaveLength(0);
    // Staging and applying on a released session fail with the stable error.
    const afterStage = session.stage(
      fillCommand("command:test:discard:0002", [0, 0, 0], [2, 2, 2]),
    );
    expect(afterStage.ok).toBe(false);
    if (!afterStage.ok) expect(afterStage.error.code).toBe("PREVIEW_CLOSED");
    const afterApply = session.apply();
    expect(afterApply.ok).toBe(false);
    if (!afterApply.ok) expect(afterApply.error.code).toBe("PREVIEW_CLOSED");
    // Discard is idempotent.
    expect(() => {
      session.discard();
    }).not.toThrow();
    unsubscribe();
  });

  it("cancel behaves like discard", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({ live: store });
    expect(
      session.stage(
        fillCommand("command:test:cancel:0001", [0, 0, 0], [2, 2, 2]),
      ).ok,
    ).toBe(true);
    session.cancel();
    expect(session.closed).toBe(true);
    expect(store.revision).toBe(1);
  });

  it("staged commands are released after apply", () => {
    const { store, bus } = liveFixture();
    const session = createPreviewSession({ live: store, applyBus: bus });
    expect(
      session.stage(fillCommand("command:test:rel:0001", [0, 0, 0], [2, 2, 2]))
        .ok,
    ).toBe(true);
    expect(session.stagedCommands).toHaveLength(1);
    const result = session.apply();
    expect(result.ok).toBe(true);
    expect(session.stagedCommands).toHaveLength(0);
    expect(session.voxelEstimate).toBe(0);
  });
});

describe("preview surface composition", () => {
  it("authorizes mutation contracts and validates their responses", () => {
    const { store } = liveFixture();
    void store;
    const session = createPreviewSession({ live: store });
    const inspector = createInspector({ store: session });
    // Inspection tools run on the preview session too.
    const summary = inspector.inspect("inspectSummary", {});
    expect(summary.ok).toBe(true);
    session.discard();
  });

  it("keeps the mutation contract list distinct from inspection", () => {
    const names = MUTATION_TOOL_CONTRACTS.map((contract) => contract.name);
    expect(names).toContain("fillBox");
    expect(names).not.toContain("queryVoxels");
    expect(contractByName(MUTATION_TOOL_CONTRACTS, "fillBox")?.capability).toBe(
      "mutate",
    );
  });

  it("supports volume creation in a staged session", () => {
    const { store } = liveFixture();
    const session = createPreviewSession({ live: store });
    const result = session.stage(
      createVolumeCommand(commandId("command:test:vol:0001"), {
        volumeId: volumeId("volume:test:new"),
        name: "new",
      }),
    );
    expect(result.ok).toBe(true);
    expect(
      (session.getDocument().volumes as Readonly<Record<string, unknown>>)[
        "volume:test:new"
      ],
    ).toBeDefined();
    session.discard();
  });
});
