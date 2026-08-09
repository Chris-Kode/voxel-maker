import { describe, expect, it } from "vitest";
import { WorkspaceError, type JsonValue } from "@voxel-maker/shared";
import { critiqueFromText, parseVisualCritique } from "./critique.js";

/**
 * Critique schema tests (plan S15.4, ticket #40): provider critique
 * output is untrusted, so every field is parsed, bounded, and validated
 * before the loop may act on it.
 */

const VALID: JsonValue = {
  view: "front",
  issueCategory: "geometry-gap",
  affectedNodeIds: ["node:body", "node:arm"],
  region: { min: [0, 0, 0], max: [4, 4, 4] },
  evidence: "A gap is visible between the body and the arm.",
  suggestedCorrection: "Extend the arm one voxel toward the body.",
  confidence: 0.9,
};

describe("parseVisualCritique", () => {
  it("parses a well-formed bounded critique", () => {
    const result = parseVisualCritique(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.view).toBe("front");
    expect(result.value.issueCategory).toBe("geometry-gap");
    expect(result.value.affectedNodeIds).toEqual(["node:body", "node:arm"]);
    expect(result.value.region).toEqual({ min: [0, 0, 0], max: [4, 4, 4] });
    expect(result.value.confidence).toBe(0.9);
  });

  it("accepts the any view and optional fields", () => {
    const result = parseVisualCritique({
      view: "any",
      issueCategory: "proportion",
      affectedNodeIds: [],
      evidence: "The head is too large.",
      confidence: 0.5,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown views, categories, and malformed fields", () => {
    for (const value of [
      null,
      [],
      "critique",
      { ...VALID, view: "bottom" },
      { ...VALID, issueCategory: "unknown" },
      { ...VALID, affectedNodeIds: "node:body" },
      { ...VALID, confidence: 2 },
      { ...VALID, confidence: "high" },
      { ...VALID, region: { min: [0, 0, 0], max: [1, 1] } },
      { ...VALID, region: { min: [0, 3, 0], max: [4, 2, 4] } },
      { ...VALID, evidence: "" },
    ]) {
      const result = parseVisualCritique(value as JsonValue);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(WorkspaceError);
        expect(result.error.code).toBe("INVALID_VISUAL_CRITIQUE");
      }
    }
  });

  it("bounds text, ids, and coordinates instead of failing", () => {
    const result = parseVisualCritique({
      view: "top",
      issueCategory: "other",
      affectedNodeIds: Array.from({ length: 100 }, (_, i) => `node:${String(i)}`),
      evidence: "e".repeat(5000),
      suggestedCorrection: "s".repeat(5000),
      region: {
        min: [-1_048_576, 0, 0],
        max: [1_048_576, 1, 1],
      },
      confidence: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("clamps oversized text and id lists deterministically", () => {
    const result = parseVisualCritique({
      view: "side",
      issueCategory: "floating-voxels",
      affectedNodeIds: Array.from({ length: 200 }, (_, i) => `node:${String(i)}`),
      evidence: "e".repeat(5000),
      confidence: 0.25,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.affectedNodeIds.length).toBeLessThanOrEqual(64);
    expect(result.value.evidence.length).toBeLessThanOrEqual(2000);
  });
});

describe("critiqueFromText", () => {
  it("extracts the first valid critique object from provider text", () => {
    const text =
      "I see an issue.\n" +
      JSON.stringify(VALID) +
      "\nI will fix it with tools.";
    const critique = critiqueFromText(text);
    expect(critique?.issueCategory).toBe("geometry-gap");
    expect(critique?.evidence).toContain("gap");
  });

  it("returns undefined for text without a critique", () => {
    expect(critiqueFromText("The images look correct.")).toBeUndefined();
    expect(critiqueFromText("")).toBeUndefined();
  });

  it("skips invalid JSON objects and hostile text within bounds", () => {
    const text = "{not json} " + JSON.stringify(VALID);
    const critique = critiqueFromText(text);
    expect(critique?.view).toBe("front");
    const hostile = "x".repeat(200_000);
    expect(critiqueFromText(hostile)).toBeUndefined();
  });
});
