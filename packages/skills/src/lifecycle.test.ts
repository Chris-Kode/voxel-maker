import { describe, expect, it } from "vitest";
import {
  CommandBus,
  DEFAULT_COMMAND_LIMITS,
  fillBoxCommand,
  journalTransactionToJson,
  parseJournalTransaction,
  type CommittedTransactionRecord,
} from "@voxel-maker/commands";
import {
  createInspector,
  createPreviewSession,
  createPreviewRegistry,
  previewSessionId,
} from "@voxel-maker/agent";
import { commandId, materialId, transactionId } from "@voxel-maker/shared";
import { proposeGenerator } from "./registry.js";
import { FIXTURE_IDS, createGeneratorFixture } from "./fixtures.js";

/**
 * Lifecycle tests (plan S14.3, ticket #37, AC3): generated commands flow
 * through the existing seams — staged into an isolated PreviewSession,
 * inspected through the inspection tools against the staged overlay,
 * applied as one optimistic transaction, discarded with zero live side
 * effects, undone through history, saved as journal transactions, and
 * replayed onto a fresh store through normal command decoding.
 */

const CONTEXT = {
  volumeId: FIXTURE_IDS.volume,
  material: FIXTURE_IDS.material,
  seed: "lifecycle-seed",
};

const STAIRS = {
  start: [0, 0, 0],
  count: 3,
  width: 4,
  depth: 2,
  stepHeight: 1,
  axis: "x",
};

/** Seeds a source block through the ordinary command bus (revision 1). */
function seedSourceBlock(bus: CommandBus): void {
  const result = bus.execute(
    fillBoxCommand(commandId("command:fixture:seed:0001"), {
      volumeId: FIXTURE_IDS.volume,
      region: { min: [0, 0, 0], max: [4, 4, 4] },
      material: materialId(1),
    }),
    {
      transactionId: transactionId("transaction:fixture:seed:0001"),
      expectedRevision: 0,
      source: "ui",
    },
  );
  if (!result.ok) throw new Error("fixture seed failed");
}

/** Records every committed transaction of a bus (journal seam). */
function recordingFixture() {
  const fixture = createGeneratorFixture();
  const records: CommittedTransactionRecord[] = [];
  const { handle } = fixture;
  const registry = createPreviewRegistry();
  const bus = new CommandBus(
    handle.store,
    registry,
    handle.writeCapability,
    undefined,
    {
      onCommitted: (record) => {
        records.push(record);
      },
    },
  );
  return { ...fixture, bus, records };
}

describe("previewed and inspected (AC3)", () => {
  it("stages a proposal into the preview session and inspects the overlay", () => {
    const { store, bus } = recordingFixture();
    seedSourceBlock(bus);
    const proposal = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    const session = createPreviewSession({
      live: store,
      applyBus: bus,
      sessionId: previewSessionId("preview:generator:inspect"),
    });
    const staged = session.stageMany(proposal.commands);
    expect(staged.ok, JSON.stringify(staged)).toBe(true);
    expect(session.stagedCount).toBe(proposal.commandCount);
    // Preflight and enforced estimates agree (single cost source).
    expect(session.voxelEstimate).toBe(proposal.voxelEstimate);

    const diff = session.diff();
    expect(diff.ok).toBe(true);
    if (!diff.ok) throw new Error("unreachable");
    expect(diff.value.stagedCommandCount).toBe(3);
    expect(diff.value.voxelEstimate).toBe(24);
    expect(diff.value.commandTypes).toEqual([
      { type: "voxel.fillBox", count: 3 },
    ]);
    expect(diff.value.changedVolumeIds).toContain(FIXTURE_IDS.volume);

    // Inspection tools run unchanged against the staged read model.
    const inspector = createInspector({ store: session });
    const query = inspector.inspect("queryVoxels", {
      volumeId: FIXTURE_IDS.volume,
      region: { min: [0, 0, 0], max: [4, 3, 6] },
      maxVoxels: 10_000,
    });
    expect(query.ok, JSON.stringify(query)).toBe(true);
    if (!query.ok) throw new Error("unreachable");
    const value = query.value as Readonly<Record<string, unknown>>;
    // Region [0..4)x[0..3)x[0..6): 3 of the seed block's 4 y-layers (48
    // voxels) plus the top stair step's 8 voxels in z [4..6); the two
    // lower steps overlap the seed block.
    expect(value.total).toBe(48 + 8);
    expect(value.revision).toBe(store.revision + 3);
    session.discard();
  });

  it("applies a proposal as one optimistic transaction", () => {
    const { store, bus } = recordingFixture();
    seedSourceBlock(bus);
    const proposal = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    const session = createPreviewSession({ live: store, applyBus: bus });
    const staged = session.stageMany(proposal.commands);
    expect(staged.ok).toBe(true);
    const applied = session.apply();
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    if (!applied.ok) throw new Error("unreachable");
    expect(applied.value.revisionAfter).toBe(2);
    expect(store.revision).toBe(2);
    // Stairs voxels are live now: the seed block is unchanged and the
    // top step (z in [4..6)) is new geometry from the proposal.
    expect(store.getVoxel(FIXTURE_IDS.volume, [1, 0, 0])).toBe(1);
    expect(store.getVoxel(FIXTURE_IDS.volume, [1, 2, 5])).toBe(1);
    expect(store.getVoxel(FIXTURE_IDS.volume, [9, 9, 9])).toBe(0);
    // The apply is one labeled history entry.
    expect(bus.historySnapshot().past).toHaveLength(2);
    expect(bus.historySnapshot().past[1]?.label).toBe("AI preview apply");
    expect(session.closed).toBe(true);
  });
});

describe("discarded with zero live side effects (AC3)", () => {
  it("discard leaves revision, voxels, and history untouched", () => {
    const { store, bus } = recordingFixture();
    seedSourceBlock(bus);
    const proposal = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    const session = createPreviewSession({ live: store, applyBus: bus });
    expect(session.stageMany(proposal.commands).ok).toBe(true);
    expect(store.revision).toBe(1);
    session.discard();
    expect(session.closed).toBe(true);
    expect(session.stagedCount).toBe(0);
    expect(store.revision).toBe(1);
    expect(store.getVoxel(FIXTURE_IDS.volume, [1, 2, 5])).toBe(0);
    expect(bus.historySnapshot().past).toHaveLength(1);
    // A closed session rejects further staging.
    const later = session.stage(proposal.commands[0] as never);
    expect(later.ok).toBe(false);
  });
});

describe("undone through history (AC3)", () => {
  it("undo restores the exact pre-apply state", () => {
    const { store, bus } = recordingFixture();
    seedSourceBlock(bus);
    const proposal = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    const session = createPreviewSession({ live: store, applyBus: bus });
    expect(session.stageMany(proposal.commands).ok).toBe(true);
    expect(session.apply().ok).toBe(true);
    expect(store.getVoxel(FIXTURE_IDS.volume, [1, 2, 5])).toBe(1);

    const undone = bus.undo({
      transactionId: transactionId("transaction:fixture:undo:0001"),
      expectedRevision: 2,
      source: "ui",
    });
    expect(undone.ok, JSON.stringify(undone)).toBe(true);
    if (!undone.ok) throw new Error("unreachable");
    expect(store.getVoxel(FIXTURE_IDS.volume, [1, 2, 5])).toBe(0);
    // The seed transaction remains in the past; the apply is undone.
    expect(bus.historySnapshot().past).toHaveLength(1);
    expect(bus.canUndo()).toBe(true);
    expect(bus.canRedo()).toBe(true);

    // Redo replays the generated commands exactly.
    const redone = bus.redo({
      transactionId: transactionId("transaction:fixture:redo:0001"),
      expectedRevision: 3,
      source: "ui",
    });
    expect(redone.ok, JSON.stringify(redone)).toBe(true);
    expect(store.getVoxel(FIXTURE_IDS.volume, [1, 2, 5])).toBe(1);
  });
});

describe("saved and replayed through the journal seam (AC3)", () => {
  it("saves committed transactions and replays them on a fresh store", () => {
    const { store, bus, records } = recordingFixture();
    seedSourceBlock(bus);
    const proposal = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    const session = createPreviewSession({ live: store, applyBus: bus });
    expect(session.stageMany(proposal.commands).ok).toBe(true);
    expect(session.apply().ok).toBe(true);
    expect(records).toHaveLength(2); // seed + apply

    // Save: canonical journal JSON for both committed transactions.
    const saved = records.map((record) => journalTransactionToJson(record));

    // Replay: fresh store and bus decode the frames through the registry.
    const replay = createGeneratorFixture();
    for (const frame of saved) {
      const record = parseJournalTransaction(frame, DEFAULT_COMMAND_LIMITS);
      const result = replay.bus.executeTransaction(record.commands, {
        transactionId: record.transactionId,
        expectedRevision: record.expectedRevision,
        source: record.source,
        ...(record.correlationId === undefined
          ? {}
          : { correlationId: record.correlationId }),
        ...(record.label === undefined ? {} : { label: record.label }),
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
    expect(replay.store.revision).toBe(2);
    expect(replay.store.getVoxel(FIXTURE_IDS.volume, [1, 0, 0])).toBe(1);
    expect(replay.store.getVoxel(FIXTURE_IDS.volume, [1, 2, 5])).toBe(1);
    expect(replay.store.getVoxel(FIXTURE_IDS.volume, [9, 9, 9])).toBe(0);
    // The replayed store is a fully ordinary open document.
    expect(replay.store.getDocument().documentId).toBe(FIXTURE_IDS.document);
  });
});
