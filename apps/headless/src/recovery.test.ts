import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  commandId,
  materialId,
  recoverySessionId,
  transactionId,
  volumeId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  canonicalAssetSemanticHash,
  createDocumentStore,
} from "@voxel-maker/document";
import { CommandBus, fillBoxCommand } from "@voxel-maker/commands";
import { readVxlProject } from "@voxel-maker/formats";
import { decodeJournalFrames } from "@voxel-maker/storage";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import { NodeProjectStorage } from "./node-storage.js";
import { createRecoverySession, recoverProject } from "./recovery.js";
import { journalEventOnce, runRecoveryTrace } from "./recovery-trace.js";

/** Immutable volume read views of every document volume (throws when missing). */
function volumeViews(store: {
  getDocument(): { volumes: Record<string, unknown> };
  getVolume(volumeId: VolumeId): VoxelVolumeReadView | undefined;
}): Map<VolumeId, VoxelVolumeReadView> {
  const views = new Map<VolumeId, VoxelVolumeReadView>();
  for (const volumeIdText of Object.keys(store.getDocument().volumes)) {
    const id = volumeId(volumeIdText);
    const view = store.getVolume(id);
    if (view === undefined) {
      throw new Error(`test volume ${volumeIdText} disappeared`);
    }
    views.set(id, view);
  }
  return views;
}

const CLI_PATH = fileURLToPath(
  new URL("../dist/recovery-cli.js", import.meta.url),
);

const SESSION = recoverySessionId("session:recovery:e2e:0001");
const VOLUME = volumeId("volume:recovery:body");

interface TraceOutput {
  snapshot: {
    revision: number;
    hash: string;
    saveStatus: string;
    savedRevision: number;
  };
  edits: {
    edit1: number;
    edit2: number;
    journaledBeforeCrash: number;
    liveBeforeCrash: number;
  };
  crash: {
    recoveredRevision: number;
    journalBaseRevision: number;
    journalBaseHash: string | null;
    replayedFrames: number;
    skippedCoveredFrames: number;
    journalAbsent: boolean;
    corruptTail: { frameIndex: number; reason: string } | null;
    hashStable: boolean;
    historyPast: number;
    historyFresh: string;
  };
  corruptTail: {
    replayedFrames: number;
    recoveredRevision: number;
    frameIndex: number;
    reason: string | null;
  };
  compaction: {
    status: string;
    savedRevision: number;
    framesAfterSave: number;
    headerPresent: boolean;
    baseRevisionAfterSave: number;
  };
  saveAs: {
    journalMoved: boolean;
    journalAtNewPath: boolean;
    sessionIdPreserved: boolean;
    recoveredRevisionAtNewPath: number;
    replayedAtNewPath: number;
  };
  degraded: {
    afterFailure: {
      degraded: boolean;
      lastJournaled: number;
      storeRevision: number;
      dirty: boolean;
    };
    afterRetry: { degraded: boolean; lastJournaled: number };
  };
}

describe("headless crash recovery", () => {
  it("recovers journaled work after a crash and reports honestly at every step", async () => {
    const output = JSON.parse(await runRecoveryTrace()) as TraceOutput;

    // Snapshot anchor: the save before journaling started.
    expect(output.snapshot.saveStatus).toBe("saved");
    expect(output.snapshot.savedRevision).toBe(output.snapshot.revision);

    // Post-snapshot edits were journaled up to the live revision.
    expect(output.edits.journaledBeforeCrash).toBe(
      output.edits.liveBeforeCrash,
    );

    // Crash recovery: replay through normal decoding and invariants.
    expect(output.crash.recoveredRevision).toBe(output.edits.liveBeforeCrash);
    expect(output.crash.replayedFrames).toBe(2);
    expect(output.crash.skippedCoveredFrames).toBe(0);
    expect(output.crash.journalAbsent).toBe(false);
    expect(output.crash.corruptTail).toBeNull();
    expect(output.crash.hashStable).toBe(true);
    // A recovered document starts a fresh bounded user history.
    expect(output.crash.historyFresh).toBe("fresh");
    expect(output.crash.historyPast).toBe(2);

    // Corrupt tail: valid frames replay, garbage is reported, never guessed.
    expect(output.corruptTail.replayedFrames).toBe(2);
    expect(output.corruptTail.recoveredRevision).toBe(
      output.edits.liveBeforeCrash,
    );
    expect(output.corruptTail.frameIndex).toBe(3);
    expect(output.corruptTail.reason).toContain("limit");

    // Compaction: confirmed save installs the snapshot, then drops frames.
    expect(output.compaction.status).toBe("saved");
    expect(output.compaction.savedRevision).toBe(output.edits.liveBeforeCrash);
    expect(output.compaction.headerPresent).toBe(true);
    expect(output.compaction.framesAfterSave).toBe(0);
    expect(output.compaction.baseRevisionAfterSave).toBe(
      output.edits.liveBeforeCrash,
    );

    // Save-as: the recovery identity follows the journal to the new path.
    expect(output.saveAs.journalMoved).toBe(true);
    expect(output.saveAs.journalAtNewPath).toBe(true);
    expect(output.saveAs.sessionIdPreserved).toBe(true);
    expect(output.saveAs.recoveredRevisionAtNewPath).toBe(
      output.edits.liveBeforeCrash,
    );
    expect(output.saveAs.replayedAtNewPath).toBe(0);

    // Degraded durability: a failed append leaves the edit valid and dirty,
    // and retry restores journal coverage.
    expect(output.degraded.afterFailure.degraded).toBe(true);
    expect(output.degraded.afterFailure.storeRevision).toBe(1);
    expect(output.degraded.afterFailure.dirty).toBe(true);
    expect(output.degraded.afterFailure.lastJournaled).toBe(-1);
    expect(output.degraded.afterRetry.degraded).toBe(false);
    expect(output.degraded.afterRetry.lastJournaled).toBe(1);
  });

  it("recovers a snapshot alone when no journal exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voxel-maker-recovery-"));
    try {
      const projectPath = join(directory, "plain.vxl");
      const port = new NodeProjectStorage();
      const { store, writeCapability } = createDocumentStore({
        document: (await import("./recovery-trace.js")).createTraceDocument(),
      });
      const registry = (
        await import("./recovery-trace.js")
      ).createTraceRegistry();
      const bus = new CommandBus(store, registry, writeCapability);
      bus.execute(
        fillBoxCommand(commandId("command:e2e:fill"), {
          volumeId: VOLUME,
          region: { min: [0, 0, 0], max: [2, 2, 2] },
          material: materialId(1),
        }),
        {
          transactionId: transactionId("transaction:e2e:fill"),
          expectedRevision: 0,
          source: "ui",
        },
      );
      // A plain save coordinator writes the snapshot without ever touching
      // a recovery area, so no journal exists for this project.
      const saveCoordinator = (
        await import("@voxel-maker/storage")
      ).createSaveCoordinator({
        store,
        port,
        encoder: (
          await import("@voxel-maker/storage")
        ).createVxlProjectEncoder(),
      });
      await saveCoordinator.save(projectPath);
      saveCoordinator.dispose();

      const outcome = await recoverProject({
        port,
        projectPath,
        registry,
        expectedSessionId: SESSION,
      });
      expect(outcome.report.journalAbsent).toBe(true);
      expect(outcome.report.recoveredRevision).toBe(1);
      expect(outcome.report.replayedFrames).toBe(0);
      expect(outcome.report.corruptTail).toBeUndefined();
      expect(outcome.bus.historySnapshot().past).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a journal whose session does not match the expected recovery identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voxel-maker-recovery-"));
    try {
      const projectPath = join(directory, "identity.vxl");
      const port = new NodeProjectStorage();
      const trace = await import("./recovery-trace.js");
      const document = trace.createTraceDocument();
      const { store, writeCapability } = createDocumentStore({ document });
      const registry = trace.createTraceRegistry();
      const bus = new CommandBus(store, registry, writeCapability);
      bus.execute(
        fillBoxCommand(commandId("command:e2e:fill"), {
          volumeId: VOLUME,
          region: { min: [0, 0, 0], max: [2, 2, 2] },
          material: materialId(1),
        }),
        {
          transactionId: transactionId("transaction:e2e:fill"),
          expectedRevision: 0,
          source: "ui",
        },
      );
      const session = createRecoverySession({
        projectPath,
        port,
        store,
        writeCapability,
        registry,
        sessionId: SESSION,
        baseRevision: 0,
        baseSemanticHash: canonicalAssetSemanticHash(
          store.getDocument(),
          volumeViews(store),
        ),
      });
      await session.save(projectPath);
      // One journaled edit under session A.
      session.bus.execute(
        fillBoxCommand(commandId("command:e2e:fill2"), {
          volumeId: VOLUME,
          region: { min: [2, 2, 2], max: [3, 3, 3] },
          material: materialId(1),
        }),
        {
          transactionId: transactionId("transaction:e2e:fill2"),
          expectedRevision: 1,
          source: "ui",
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      session.dispose();

      // Recovery expecting a different session reports incompatibility
      // instead of replaying the foreign journal.
      const outcome = await recoverProject({
        port,
        projectPath,
        registry,
        expectedSessionId: recoverySessionId("session:recovery:other"),
      });
      expect(outcome.report.incompatible?.reason).toContain("does not match");
      expect(outcome.report.replayedFrames).toBe(0);
      expect(outcome.report.recoveredRevision).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays only frames beyond a newer snapshot (crash between save and truncation)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voxel-maker-recovery-"));
    try {
      const projectPath = join(directory, "covered.vxl");
      const port = new NodeProjectStorage();
      const trace = await import("./recovery-trace.js");
      const document = trace.createTraceDocument();
      const { store, writeCapability } = createDocumentStore({ document });
      const registry = trace.createTraceRegistry();
      const session = createRecoverySession({
        projectPath,
        port,
        store,
        writeCapability,
        registry,
        sessionId: SESSION,
        baseRevision: 0,
        baseSemanticHash: canonicalAssetSemanticHash(document, new Map()),
      });
      const run = (label: string, expectedRevision: number): number => {
        const result = session.bus.execute(
          fillBoxCommand(commandId(`command:e2e:${label}`), {
            volumeId: VOLUME,
            region: { min: [0, 0, 0], max: [2, 2, 2] },
            material: materialId(1),
          }),
          {
            transactionId: transactionId(`transaction:e2e:${label}`),
            expectedRevision,
            source: "ui",
          },
        );
        if (!result.ok) throw new Error(`${label} failed`);
        return result.value.revisionAfter;
      };
      run("a", 0); // rev 1, journal frame 0->1 under base 0
      await new Promise((resolve) => setTimeout(resolve, 100));
      // A save installs the rev-1 snapshot WITHOUT resetting the journal
      // anchor (crash between the atomic save and the truncation step).
      await session.saveCoordinator.save(projectPath);
      run("b", 1); // rev 2, journal frame 1->2
      await new Promise((resolve) => setTimeout(resolve, 100));
      session.dispose();

      const journalBytes = await port.readJournal(projectPath);
      const journal = decodeJournalFrames(journalBytes as Uint8Array);
      expect(journal.header?.baseRevision).toBe(0);
      expect(journal.frames.map((entry) => entry.frame.revisionAfter)).toEqual([
        1, 2,
      ]);
      const loaded = readVxlProject(await port.readProject(projectPath));
      expect(loaded.document.revision).toBe(1);

      const outcome = await recoverProject({
        port,
        projectPath,
        registry,
        expectedSessionId: SESSION,
      });
      // The newer snapshot covers frame 0->1; only frame 1->2 replays.
      expect(outcome.report.recoveredRevision).toBe(2);
      expect(outcome.report.replayedFrames).toBe(1);
      expect(outcome.report.skippedCoveredFrames).toBe(1);
      expect(outcome.report.journalSuperseded).toBe(true);
      const before = canonicalAssetSemanticHash(
        store.getDocument(),
        volumeViews(store),
      );
      const after = canonicalAssetSemanticHash(
        outcome.store.getDocument(),
        volumeViews(outcome.store),
      );
      expect(after).toBe(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("wires a new session after superseded recovery without degrading durability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voxel-maker-recovery-"));
    try {
      const projectPath = join(directory, "wiring.vxl");
      const port = new NodeProjectStorage();
      const trace = await import("./recovery-trace.js");
      const document = trace.createTraceDocument();
      const { store, writeCapability } = createDocumentStore({ document });
      const registry = trace.createTraceRegistry();
      const session = createRecoverySession({
        projectPath,
        port,
        store,
        writeCapability,
        registry,
        sessionId: SESSION,
        baseRevision: 0,
        baseSemanticHash: canonicalAssetSemanticHash(document, new Map()),
      });
      const run = (
        bus: CommandBus,
        label: string,
        expectedRevision: number,
      ): number => {
        const result = bus.execute(
          fillBoxCommand(commandId(`command:e2e:${label}`), {
            volumeId: VOLUME,
            region: { min: [0, 0, 0], max: [2, 2, 2] },
            material: materialId(1),
          }),
          {
            transactionId: transactionId(`transaction:e2e:${label}`),
            expectedRevision,
            source: "ui",
          },
        );
        if (!result.ok) throw new Error(`${label} failed`);
        return result.value.revisionAfter;
      };
      run(session.bus, "a", 0); // rev 1, journal base 0
      await journalEventOnce(
        session.journal,
        (event) => event.kind === "appended" && event.revisionAfter === 1,
        "append a",
      );
      // Save installs the rev-1 snapshot WITHOUT resetting the journal
      // (crash between the atomic save and the anchor reset).
      await session.saveCoordinator.save(projectPath);
      run(session.bus, "b", 1); // rev 2 journaled
      await journalEventOnce(
        session.journal,
        (event) => event.kind === "appended" && event.revisionAfter === 2,
        "append b",
      );
      session.dispose();

      const outcome = await recoverProject({
        port,
        projectPath,
        registry,
        expectedSessionId: SESSION,
      });
      expect(outcome.report.journalSuperseded).toBe(true);
      // The report exposes the journal header base so the next session can
      // anchor correctly (the snapshot itself is newer than the base).
      expect(outcome.report.journalBaseRevision).toBe(0);

      const next = createRecoverySession({
        projectPath,
        port,
        store: outcome.store,
        writeCapability: outcome.writeCapability,
        registry,
        sessionId: SESSION,
        baseRevision: outcome.report.journalBaseRevision as number,
        baseSemanticHash: outcome.report.journalBaseSemanticHash as string,
      });
      // Appends must not fail with JOURNAL_BASE_MISMATCH; the edit is
      // journaled and durability stays healthy.
      run(next.bus, "c", 2);
      await journalEventOnce(
        next.journal,
        (event) => event.kind === "appended" && event.revisionAfter === 3,
        "append after re-anchor",
      );
      expect(next.journal.isDegraded()).toBe(false);
      expect(next.journal.lastJournaledRevision()).toBe(3);
      next.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes the recovery trace byte-identically across fresh processes", () => {
    const first = execFileSync(process.execPath, [CLI_PATH], {
      encoding: "utf8",
    });
    const second = execFileSync(process.execPath, [CLI_PATH], {
      encoding: "utf8",
    });
    expect(first).toBe(second);
    expect(first).toContain('"hashStable":true');
    expect(first).toContain('"journalMoved":true');
    expect(first).toContain('"replayedFrames":2');
  });
});
