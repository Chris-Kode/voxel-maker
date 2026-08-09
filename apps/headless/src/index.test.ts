import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalDocumentHash, parseDocument } from "@voxel-maker/model";
import { runAnimationDemosTrace, runHeadlessTrace } from "./index.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const DEMO_HASH =
  "3ccd4db83c7213025751e5e925962a07bdb6af176fe9d46b0732932a43c583a9";

describe("headless workspace tracer", () => {
  it("round-trips a versioned document deterministically", () => {
    const output = runHeadlessTrace();
    const parsed = JSON.parse(output) as {
      command: {
        accepted: boolean;
        transactionId: string;
        revisionAfter: number;
      };
      document: {
        documentId: string;
        hash: string;
        nodeCount: number;
        reloadedHash: string;
        roundTripStable: boolean;
      };
      serialized: string;
      voxel: { chunk: number[]; local: number[]; material: number };
      edit: {
        afterSet: number;
        afterUndo: number;
        afterRedo: number;
        revisions: number[];
      };
      hierarchy: {
        createNodeAccepted: boolean;
        reparentAccepted: boolean;
        renameAccepted: boolean;
        extraParent: string | null;
        extraName: string | null;
        childChildren: string[];
      };
      materials: {
        createAccepted: boolean;
        updateAccepted: boolean;
        deleteAccepted: boolean;
        materialCount: number;
      };
    };
    expect(parsed.command).toEqual({
      accepted: true,
      transactionId: "transaction:demo:set:0001",
      revisionAfter: 1,
    });
    expect(parsed.document).toEqual({
      documentId: "document:demo:0001",
      hash: DEMO_HASH,
      nodeCount: 2,
      reloadedHash: DEMO_HASH,
      roundTripStable: true,
    });
    expect(typeof parsed.serialized).toBe("string");
    expect(parsed.voxel).toEqual({
      chunk: [-1, 0, 0],
      local: [15, 0, 1],
      material: 1,
    });
    expect(parsed.edit).toEqual({
      afterSet: 1,
      afterUndo: 0,
      afterRedo: 1,
      revisions: [1, 2, 3],
    });
    expect(parsed.hierarchy).toEqual({
      createNodeAccepted: true,
      reparentAccepted: true,
      renameAccepted: true,
      extraParent: "node:demo:child",
      extraName: "Extra-renamed",
      childChildren: ["node:demo:extra"],
    });
    expect(parsed.materials).toEqual({
      createAccepted: true,
      updateAccepted: true,
      deleteAccepted: true,
      materialCount: 1,
    });
    expect(canonicalDocumentHash(parseDocument(parsed.serialized))).toBe(
      parsed.document.hash,
    );
    expect(runHeadlessTrace()).toBe(output);
  });

  it("traces all six definition-of-done animation demos deterministically", () => {
    const output = JSON.parse(runAnimationDemosTrace()) as {
      demos: Array<{
        kind: string;
        name: string;
        duration: number;
        loop: string;
        tracks: number;
        keyframes: number;
        componentKinds: string[];
        clampedAny: boolean;
        deterministic: boolean;
        hashStable: boolean;
        baseRestored: boolean;
        midPose: Array<{
          nodeId: string;
          localEuler: number[] | null;
          worldEuler: number[] | null;
        }>;
      }>;
    };
    expect(output.demos.map((demo) => demo.kind)).toEqual([
      "chest-lid",
      "wheel",
      "linked-arm",
      "wings",
      "simple-character",
      "abstract",
    ]);
    for (const demo of output.demos) {
      // No category-specific core symbols in any demo (ticket #30):
      // every component kind is one of the four generic articulation
      // symbols (constraints are optional per category).
      expect(
        demo.componentKinds.every((kind) =>
          ["voxel", "pivot", "joint", "constraint"].includes(kind),
        ),
      ).toBe(true);
      expect(demo.componentKinds).toContain("voxel");
      expect(demo.componentKinds).toContain("pivot");
      expect(demo.componentKinds).toContain("joint");
      expect(demo.deterministic).toBe(true);
      expect(demo.hashStable).toBe(true);
      expect(demo.baseRestored).toBe(true);
      expect(demo.tracks).toBeGreaterThan(0);
      expect(demo.keyframes).toBeGreaterThan(0);
      for (const pose of demo.midPose) {
        expect(pose.nodeId.length).toBeGreaterThan(0);
      }
    }
    // The constrained categories clamp at least one animated node at an
    // over-driven peak: the world pose differs from the raw sampled local
    // rotation (the unconstrained wheel and abstract demos pass through).
    const constrained = [
      "chest-lid",
      "linked-arm",
      "wings",
      "simple-character",
    ];
    for (const demo of output.demos) {
      if (constrained.includes(demo.kind)) {
        expect(demo.clampedAny).toBe(true);
      }
    }
  });

  it("serializes byte-identically across fresh processes", () => {
    const first = execFileSync(process.execPath, [CLI_PATH], {
      encoding: "utf8",
    });
    const second = execFileSync(process.execPath, [CLI_PATH], {
      encoding: "utf8",
    });
    expect(first).toBe(second);
    expect(first).toContain('"roundTripStable":true');
    expect(first).toContain('"revisions":[1,2,3]');
    expect(first).toContain('"extraParent":"node:demo:child"');
    expect(first).toContain('"materialCount":1');
  });
});
