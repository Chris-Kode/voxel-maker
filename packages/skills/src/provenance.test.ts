import { describe, expect, it } from "vitest";
import { transactionId } from "@voxel-maker/shared";
import {
  CommandBus,
  DEFAULT_COMMAND_LIMITS,
  journalTransactionToJson,
  parseJournalTransaction,
  type CommittedTransactionRecord,
} from "@voxel-maker/commands";
import { createPreviewSession, previewSessionId } from "@voxel-maker/agent";
import { createGeneratorFixture, FIXTURE_IDS } from "./fixtures.js";
import { proposeGenerator } from "./registry.js";
import {
  SKILL_PROVENANCE_PREFIX,
  applyWithProvenance,
  parseProvenanceLabel,
  provenanceCorrelationId,
  provenanceLabel,
} from "./provenance.js";
import { CREATION_SKILLS } from "./skill-registry.js";

/**
 * Provenance tests (plan S14.9, ticket #38): the active skill and its
 * version are recorded in the transaction metadata (apply label and
 * correlation id) of the one optimistic apply, travel through the
 * journal codec, and are never required by the document. The label is
 * parseable, deterministic per (skill, version, seed), and every
 * catalog skill applies with provenance.
 */

const CONTEXT = {
  volumeId: FIXTURE_IDS.volume,
  material: FIXTURE_IDS.material,
  seed: "provenance-seed",
};

const STAIRS = {
  start: [0, 0, 0],
  count: 3,
  width: 4,
  depth: 2,
  stepHeight: 1,
  axis: "x",
};

describe("provenance label format (S14.9)", () => {
  it("formats and parses skill provenance labels", () => {
    const label = provenanceLabel("skill.furniture", "1.0.0");
    expect(label).toBe("skill:skill.furniture@1.0.0");
    expect(label.startsWith(SKILL_PROVENANCE_PREFIX)).toBe(true);
    const parsed = parseProvenanceLabel(label);
    expect(parsed).toEqual({ name: "skill.furniture", version: "1.0.0" });
  });

  it("rejects malformed labels", () => {
    expect(parseProvenanceLabel("skill:skill.furniture@1.0")).toBeUndefined();
    expect(parseProvenanceLabel("furniture@1.0.0")).toBeUndefined();
    expect(parseProvenanceLabel("skill:furniture")).toBeUndefined();
    expect(parseProvenanceLabel("")).toBeUndefined();
  });

  it("derives deterministic correlation ids per seed", () => {
    const a = provenanceCorrelationId("skill.furniture", "1.0.0", "seed-1");
    const b = provenanceCorrelationId("skill.furniture", "1.0.0", "seed-1");
    const c = provenanceCorrelationId("skill.furniture", "1.0.0", "seed-2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("skill:skill.furniture@1.0.0:")).toBe(true);
  });
});

describe("apply with provenance (S14.9)", () => {
  function recordingFixture() {
    const fixture = createGeneratorFixture();
    const records: CommittedTransactionRecord[] = [];
    const bus = new CommandBus(
      fixture.handle.store,
      fixture.registry,
      fixture.handle.writeCapability,
      undefined,
      { onCommitted: (record) => records.push(record) },
    );
    return { ...fixture, bus, records };
  }

  it("labels the apply transaction and the journal record", () => {
    const { store, bus, records } = recordingFixture();
    const proposal = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    const session = createPreviewSession({
      live: store,
      applyBus: bus,
      sessionId: previewSessionId("preview:provenance:0001"),
    });
    expect(session.stageMany(proposal.commands).ok).toBe(true);
    const applied = applyWithProvenance(
      session,
      "skill.furniture",
      "1.0.0",
      "provenance-seed",
    );
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    if (!applied.ok) throw new Error("unreachable");
    // History entry carries the provenance label.
    const entry = bus.historySnapshot().past.at(-1);
    expect(entry?.label).toBe("skill:skill.furniture@1.0.0");
    // The committed journal record carries label and correlation id.
    const record = records.at(-1);
    expect(record?.label).toBe("skill:skill.furniture@1.0.0");
    expect(record?.correlationId).toBe(
      provenanceCorrelationId("skill.furniture", "1.0.0", "provenance-seed"),
    );

    // The journal codec round-trips the provenance metadata.
    const frame = journalTransactionToJson(
      record as CommittedTransactionRecord,
    );
    const parsed = parseJournalTransaction(frame, DEFAULT_COMMAND_LIMITS);
    expect(parsed.label).toBe("skill:skill.furniture@1.0.0");
    expect(parsed.correlationId).toBe(record?.correlationId);
    // Provenance is optional metadata: a fresh apply without it works too.
    expect(parseJournalTransaction(frame, DEFAULT_COMMAND_LIMITS).label).toBe(
      "skill:skill.furniture@1.0.0",
    );
  });

  it("lets caller options override provenance metadata", () => {
    const { store, bus } = recordingFixture();
    const proposal = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    const session = createPreviewSession({ live: store, applyBus: bus });
    expect(session.stageMany(proposal.commands).ok).toBe(true);
    const applied = applyWithProvenance(
      session,
      "skill.furniture",
      "1.0.0",
      "seed",
      {
        transactionId: transactionId("transaction:custom:apply:0001"),
        label: "custom label",
        correlationId: "custom-correlation",
      },
    );
    expect(applied.ok).toBe(true);
    const entry = bus.historySnapshot().past.at(-1);
    expect(entry?.label).toBe("custom label");
  });

  it("keeps the document free of any skill reference", () => {
    const { store, bus } = recordingFixture();
    const proposal = proposeGenerator("generator.stairs", STAIRS, CONTEXT);
    const session = createPreviewSession({ live: store, applyBus: bus });
    expect(session.stageMany(proposal.commands).ok).toBe(true);
    expect(
      applyWithProvenance(session, "skill.furniture", "1.0.0", "seed").ok,
    ).toBe(true);
    // The persisted document is plain semantic data: no provenance field,
    // no skill name, no version string.
    const document = store.getDocument();
    const json = JSON.stringify(document);
    expect(json).not.toContain("skill.furniture");
    expect(json).not.toContain("provenance");
  });
});

describe("every catalog skill applies with provenance (S14.9)", () => {
  it("derives parseable labels for all seven skills", () => {
    for (const skill of CREATION_SKILLS) {
      const label = provenanceLabel(skill.name, skill.version);
      expect(parseProvenanceLabel(label)).toEqual({
        name: skill.name,
        version: skill.version,
      });
    }
  });
});
