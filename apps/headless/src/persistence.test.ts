import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPersistenceTrace } from "./persistence.js";

const CLI_PATH = fileURLToPath(
  new URL("../dist/persistence-cli.js", import.meta.url),
);

interface PersistenceOutput {
  save: {
    bytes: number;
    entryNames: string[];
    byteStable: boolean;
    hashBefore: string;
    hashAfter: string;
    hashStable: boolean;
    volumeCount: number;
    chunkCounts: { volumeId: string; chunks: number }[];
  };
  reload: {
    documentId: string;
    revision: number;
    nodeCount: number;
    materialCount: number;
    animationCount: number;
    rootName: string | null;
    armParent: string | null;
    extraParent: string | null;
    extraName: string | null;
    accentColor: string | null;
    accentEmissive: number | null;
    occupiedBody: number;
    occupiedBodyAfter: number;
    occupiedArm: number;
    occupiedArmAfter: number;
    voxelSamples: { coordinate: number[]; before: number; after: number }[];
  };
  transactions: { label: string; accepted: boolean; revision: number }[];
  animationReload: {
    clipCountAfterReload: number;
    createBounceAccepted: boolean;
    addBounceTrackAccepted: boolean;
    setBounceKeysAccepted: boolean;
    moveAccepted: boolean;
    timesAfterMove: number[];
    timesAfterUndo: number[];
    timesAfterRedo: number[];
    undoMoveAccepted: boolean;
    redoMoveAccepted: boolean;
    editValueAccepted: boolean;
    valueAfterEdit: number[] | null;
    valueAfterUndo: number[] | null;
    valueEditUndone: boolean;
    undoValueAccepted: boolean;
    deleteKeyAccepted: boolean;
    keyframesAfterDelete: number;
    undoDeleteKeyAccepted: boolean;
    keyframesAfterUndoDelete: number;
    deleteClipAccepted: boolean;
    clipsAfterDelete: number;
    undoDeleteClipAccepted: boolean;
    clipsAfterUndoDelete: number;
    reloadedRevision: number;
  };
  durable: {
    firstSave: {
      status: string;
      revision: number;
      cleanAfter: boolean;
      backupAfter: boolean;
    };
    edit: { revision: number; dirtyAfter: boolean };
    secondSave: {
      status: string;
      revision: number;
      cleanAfter: boolean;
      backupAfter: boolean;
      bytes: number;
      savedHashMatches: boolean;
      backupMatchesFirstSave: boolean;
      leftoverTempFiles: string[];
    };
  };
}

describe("headless persistence tracer", () => {
  it("creates, saves, reloads, and reinstalls the same semantic asset", async () => {
    const output = JSON.parse(await runPersistenceTrace()) as PersistenceOutput;

    // Same canonical semantic hash before and after reload (acceptance).
    expect(output.save.hashStable).toBe(true);
    expect(output.save.hashBefore).toBe(output.save.hashAfter);
    expect(output.save.hashBefore).toMatch(/^[0-9a-f]{64}$/u);

    // Byte-stable container with the canonical indexed entry order.
    expect(output.save.byteStable).toBe(true);
    expect(output.save.entryNames).toEqual([
      "document.json",
      "voxels/volume%3Ademo%3Apersist%3Aarm.bin",
      "voxels/volume%3Ademo%3Apersist%3Abody.bin",
    ]);
    expect(output.save.volumeCount).toBe(2);
    expect(output.save.chunkCounts).toEqual([
      { volumeId: "volume:demo:persist:arm", chunks: 1 },
      { volumeId: "volume:demo:persist:body", chunks: 4 },
    ]);

    // Full reconstruction: hierarchy, materials, animation, volumes.
    expect(output.reload.documentId).toBe("document:demo:persist:0001");
    expect(output.reload.revision).toBe(6);
    expect(output.reload.nodeCount).toBe(4);
    expect(output.reload.materialCount).toBe(2);
    expect(output.reload.animationCount).toBe(1);
    expect(output.reload.rootName).toBe("Root");
    expect(output.reload.armParent).toBe("node:demo:persist:child");
    expect(output.reload.extraParent).toBe("node:demo:persist:child");
    expect(output.reload.extraName).toBe("Extra-renamed");
    expect(output.reload.accentColor).toBe("#00ff88");
    expect(output.reload.accentEmissive).toBe(0.2);
    // The live store gained the extra fillBox transaction (81 voxels) after
    // the reload snapshot was captured; the reloaded store stays at 729.
    expect(output.reload.occupiedBody).toBe(810);
    expect(output.reload.occupiedBodyAfter).toBe(729);
    expect(output.reload.occupiedArm).toBe(33);
    expect(output.reload.occupiedArmAfter).toBe(33);
    for (const sample of output.reload.voxelSamples) {
      expect(sample.before).toBe(sample.after);
    }

    // Every transaction committed through the command bus.
    expect(output.transactions).toHaveLength(7);
    for (const transaction of output.transactions) {
      expect(transaction.accepted).toBe(true);
    }
    expect(
      output.transactions.map((transaction) => transaction.revision),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Atomic durable save (ticket #13): first save writes the captured
    // snapshot and leaves the project clean with no backup; an edit marks
    // it dirty; the second save writes the new snapshot, preserves the
    // first one as last-known-good, and leaves no temporary files.
    expect(output.durable.firstSave.status).toBe("saved");
    expect(output.durable.firstSave.revision).toBe(6);
    expect(output.durable.firstSave.cleanAfter).toBe(true);
    expect(output.durable.firstSave.backupAfter).toBe(false);
    expect(output.durable.edit.revision).toBe(7);
    expect(output.durable.edit.dirtyAfter).toBe(true);
    expect(output.durable.secondSave.status).toBe("saved");
    expect(output.durable.secondSave.revision).toBe(7);
    expect(output.durable.secondSave.cleanAfter).toBe(true);
    expect(output.durable.secondSave.backupAfter).toBe(true);
    expect(output.durable.secondSave.savedHashMatches).toBe(true);
    expect(output.durable.secondSave.backupMatchesFirstSave).toBe(true);
    expect(output.durable.secondSave.leftoverTempFiles).toEqual([]);

    // Editing and undoing clips and keyframes after save and reload
    // (ticket #30 acceptance): a fresh bus over the reloaded store authors
    // a new clip, moves a keyframe with exact undo/redo, and edits a
    // keyframe value with exact undo.
    expect(output.animationReload.clipCountAfterReload).toBe(1);
    expect(output.animationReload.createBounceAccepted).toBe(true);
    expect(output.animationReload.addBounceTrackAccepted).toBe(true);
    expect(output.animationReload.setBounceKeysAccepted).toBe(true);
    expect(output.animationReload.moveAccepted).toBe(true);
    expect(output.animationReload.timesAfterMove).toEqual([0, 1.5]);
    expect(output.animationReload.timesAfterUndo).toEqual([0, 2]);
    expect(output.animationReload.timesAfterRedo).toEqual([0, 1.5]);
    expect(output.animationReload.undoMoveAccepted).toBe(true);
    expect(output.animationReload.redoMoveAccepted).toBe(true);
    expect(output.animationReload.editValueAccepted).toBe(true);
    // The edited keyframe value is a 90-degree X rotation; after undo the
    // original 45-degree value returns (x component sin(angle/2)).
    expect(output.animationReload.valueAfterEdit?.[0]).toBeCloseTo(
      Math.sin(Math.PI / 4),
      9,
    );
    expect(output.animationReload.valueAfterUndo?.[0]).toBeCloseTo(
      Math.sin(Math.PI / 8),
      9,
    );
    expect(output.animationReload.valueEditUndone).toBe(true);
    expect(output.animationReload.undoValueAccepted).toBe(true);
    // Deleting works after reload too: keyframe delete + undo restores
    // the two-keyframe track, clip delete + undo restores the clip.
    expect(output.animationReload.deleteKeyAccepted).toBe(true);
    expect(output.animationReload.keyframesAfterDelete).toBe(1);
    expect(output.animationReload.undoDeleteKeyAccepted).toBe(true);
    expect(output.animationReload.keyframesAfterUndoDelete).toBe(2);
    expect(output.animationReload.deleteClipAccepted).toBe(true);
    expect(output.animationReload.clipsAfterDelete).toBe(1);
    expect(output.animationReload.undoDeleteClipAccepted).toBe(true);
    expect(output.animationReload.clipsAfterUndoDelete).toBe(2);
  });

  it("serializes byte-identically across fresh processes", () => {
    const first = execFileSync(process.execPath, [CLI_PATH], {
      encoding: "utf8",
    });
    const second = execFileSync(process.execPath, [CLI_PATH], {
      encoding: "utf8",
    });
    expect(first).toBe(second);
    expect(first).toContain('"hashStable":true');
    expect(first).toContain('"byteStable":true');
    expect(first).toContain('"occupiedBodyAfter":729');
  });
});
