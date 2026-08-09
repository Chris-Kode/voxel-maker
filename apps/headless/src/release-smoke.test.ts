import { describe, expect, it } from "vitest";
import { runReleaseSmoke } from "./release-smoke.js";

/**
 * Release smoke assertions (issue #46, S17.8/S17.14): the packaged-app
 * journey must create, edit, rig, animate, save, recover, import, export,
 * and exercise the consent-gated offline AI surface. The report is
 * canonical JSON, so these assertions double as the contract for the
 * clean-machine qualification step in the release workflows.
 */
interface SmokeReport {
  readonly version: string;
  readonly appVersion: string;
  readonly created: {
    readonly documentId: string;
    readonly valid: boolean;
    readonly revision: number;
  };
  readonly edits: {
    readonly revisionAfter: number;
    readonly voxelAt: number | null;
    readonly undoAccepted: boolean;
    readonly redoAccepted: boolean;
    readonly transactions: number;
  };
  readonly rig: {
    readonly components: readonly string[];
    readonly pivotSet: boolean;
    readonly jointAdded: boolean;
    readonly constraintAdded: boolean;
  };
  readonly animate: {
    readonly clipDuration: number;
    readonly clipLoop: string | null;
    readonly trackKeyframes: number;
    readonly midPoseRotation: readonly number[] | null;
    readonly runtimeEvaluated: boolean;
  };
  readonly save: {
    readonly status: string;
    readonly savedRevision: number;
    readonly anchorRevision: number;
    readonly bytes: number;
    readonly journalFramesAfterSave: number;
    readonly headerPresent: boolean;
  };
  readonly recover: {
    readonly crash: {
      readonly recoveredRevision: number;
      readonly replayedFrames: number;
      readonly journalAbsent: boolean;
      readonly hashStable: boolean;
      readonly historyFresh: string;
      readonly editRevisionAfterSave: number;
    };
    readonly corruptTail: {
      readonly reported: boolean;
      readonly frameIndex: number;
      readonly reason: string | null;
      readonly recoveredRevision: number;
    };
  };
  readonly import: {
    readonly nodesCreated: number;
    readonly volumesCreated: number;
    readonly voxelsImported: number;
    readonly materialsCreated: number;
    readonly revisionAfter: number;
    readonly warnings: number;
  };
  readonly export: {
    readonly glb: {
      readonly format: string;
      readonly bytes: number;
      readonly magic: string;
    };
    readonly vox: { readonly bytes: number; readonly magic: string };
  };
  readonly aiOffline: {
    readonly inspectorSummary: boolean;
    readonly stagedCommandCount: number;
    readonly voxelEstimate: number;
    readonly discardLeavesVoxel: boolean;
    readonly applyAccepted: boolean;
    readonly applyChangesVoxel: boolean;
    readonly undoRestoresVoxel: boolean;
    readonly consentRequiredCode: string;
    readonly consentCoversMismatched: boolean;
    readonly providerTransmissions: number;
  };
  readonly offline: {
    readonly networkAccess: string;
    readonly providerAdapters: number;
  };
}

describe("release smoke", () => {
  it("passes the full create/edit/rig/animate/save/recover/import/export/AI journey", async () => {
    const report = JSON.parse(await runReleaseSmoke()) as SmokeReport;
    expect(report.version).toBe("release-smoke-v1");
    expect(report.appVersion).toBe("0.1.0");

    // create
    expect(report.created.valid).toBe(true);
    expect(report.created.revision).toBe(0);

    // edit + undo/redo
    expect(report.edits.revisionAfter).toBeGreaterThan(0);
    expect(report.edits.voxelAt).not.toBeNull();
    expect(report.edits.undoAccepted).toBe(true);
    expect(report.edits.redoAccepted).toBe(true);

    // rig
    expect(report.rig.pivotSet).toBe(true);
    expect(report.rig.jointAdded).toBe(true);
    expect(report.rig.constraintAdded).toBe(true);

    // animate
    expect(report.animate.clipDuration).toBe(2);
    expect(report.animate.clipLoop).toBe("loop");
    expect(report.animate.trackKeyframes).toBe(2);
    expect(report.animate.runtimeEvaluated).toBe(true);
    expect(report.animate.midPoseRotation).not.toBeNull();

    // save (atomic durable save with anchored journal)
    expect(report.save.status).toBe("saved");
    // Save anchors the journal at the current store revision, which
    // advanced past the edit phase through rig and animate.
    expect(report.save.savedRevision).toBe(report.save.anchorRevision);
    expect(report.save.savedRevision).toBeGreaterThan(
      report.edits.revisionAfter,
    );
    expect(report.save.bytes).toBeGreaterThan(0);
    expect(report.save.headerPresent).toBe(true);

    // recover (crash replay keeps the semantic hash; corrupt tail reported)
    expect(report.recover.crash.recoveredRevision).toBeGreaterThan(
      report.save.savedRevision,
    );
    expect(report.recover.crash.replayedFrames).toBeGreaterThan(0);
    expect(report.recover.crash.journalAbsent).toBe(false);
    expect(report.recover.crash.hashStable).toBe(true);
    expect(report.recover.crash.historyFresh).toBe("fresh");
    expect(report.recover.corruptTail.reported).toBe(true);
    expect(report.recover.corruptTail.frameIndex).toBeGreaterThanOrEqual(0);

    // import (VOX through one transaction)
    expect(report.import.voxelsImported).toBeGreaterThan(0);
    expect(report.import.nodesCreated).toBeGreaterThan(0);
    expect(report.import.volumesCreated).toBeGreaterThan(0);
    expect(report.import.revisionAfter).toBeGreaterThan(0);
    expect(report.import.warnings).toBeGreaterThanOrEqual(0);

    // export (glTF binary magic + VOX magic)
    expect(report.export.glb.format).toBe("glb");
    expect(report.export.glb.bytes).toBeGreaterThan(0);
    expect(report.export.glb.magic).toBe("glTF");
    expect(report.export.vox.bytes).toBeGreaterThan(0);
    expect(report.export.vox.magic).toBe("VOX ");

    // AI offline surface: inspection works, staging is side-effect free,
    // apply is one transaction, undo restores the hash, provider use is
    // consent-gated and nothing was transmitted.
    expect(report.aiOffline.inspectorSummary).toBe(true);
    expect(report.aiOffline.stagedCommandCount).toBe(1);
    expect(report.aiOffline.voxelEstimate).toBeGreaterThan(0);
    expect(report.aiOffline.discardLeavesVoxel).toBe(true);
    expect(report.aiOffline.applyAccepted).toBe(true);
    expect(report.aiOffline.applyChangesVoxel).toBe(true);
    expect(report.aiOffline.undoRestoresVoxel).toBe(true);
    expect(report.aiOffline.consentRequiredCode).toBe("CONSENT_REQUIRED");
    expect(report.aiOffline.consentCoversMismatched).toBe(false);
    expect(report.aiOffline.providerTransmissions).toBe(0);

    // offline manual use: no network and no provider adapter involved
    expect(report.offline.networkAccess).toBe("none");
    expect(report.offline.providerAdapters).toBe(0);
  });
});
