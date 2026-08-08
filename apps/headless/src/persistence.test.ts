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
}

describe("headless persistence tracer", () => {
  it("creates, saves, reloads, and reinstalls the same semantic asset", () => {
    const output = JSON.parse(runPersistenceTrace()) as PersistenceOutput;

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
    expect(output.reload.occupiedBody).toBe(729);
    expect(output.reload.occupiedBodyAfter).toBe(729);
    expect(output.reload.occupiedArm).toBe(33);
    expect(output.reload.occupiedArmAfter).toBe(33);
    for (const sample of output.reload.voxelSamples) {
      expect(sample.before).toBe(sample.after);
    }

    // Every transaction committed through the command bus.
    expect(output.transactions).toHaveLength(6);
    for (const transaction of output.transactions) {
      expect(transaction.accepted).toBe(true);
    }
    expect(
      output.transactions.map((transaction) => transaction.revision),
    ).toEqual([1, 2, 3, 4, 5, 6]);
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
