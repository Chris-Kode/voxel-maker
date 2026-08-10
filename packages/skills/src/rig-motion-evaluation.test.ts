import { describe, expect, it } from "vitest";
import {
  CommandBus,
  type CommittedTransactionRecord,
} from "@voxel-maker/commands";
import {
  canonicalAssetSemanticHash,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import { createDocumentStoreHandle } from "@voxel-maker/document/internal";
import {
  createPreviewRegistry,
  createPreviewSession,
} from "@voxel-maker/agent";
import { type AnimationId, type VolumeId } from "@voxel-maker/shared";
import { MOTION_SKILLS, RIGGING_SKILLS } from "./skill-registry.js";
import { runStructuralChecks } from "./checks.js";
import { checkEfficiency } from "./efficiency.js";
import {
  RIG_MOTION_FIXTURE_IDS,
  motionGoldenCommands,
  rigGoldenCommands,
  rigMotionFixtureById,
  type RigMotionFixture,
} from "./rig-motion-fixtures.js";
import {
  applyWithProvenance,
  parseProvenanceLabel,
  provenanceLabel,
} from "./provenance.js";
import type { SkillManifest } from "./manifest.js";

/**
 * Rig/motion skill evaluation tests (plan S14.10, ticket #39 AC3): every
 * rigging skill's fixed checks pass on the golden rigged end state of
 * its fixed fixture and fail on the unrigged start; every motion skill's
 * checks pass on the golden rigged-plus-clip end state and fail on the
 * clip-free start; efficiency limits are coherent; and a recorded golden
 * trace stages through the preview seam, applies with provenance
 * metadata, and lands in exactly the golden end state (same canonical
 * semantic hash) — with the staged clip readable before Apply.
 */

const CONTEXT = {
  volumeId: "volume:rig:biped:torso" as VolumeId,
  material: undefined,
};

/** The fixture the manifest references; a broken id fails the suite. */
function fixtureOf(skill: SkillManifest): RigMotionFixture {
  const fixture = rigMotionFixtureById(skill.evaluation.fixtureId ?? "");
  expect(
    fixture,
    `${skill.name} references fixture ${skill.evaluation.fixtureId ?? "missing"}`,
  ).toBeDefined();
  return fixture as RigMotionFixture;
}

function storeOf(document: RigMotionFixture["end"]): DocumentStoreRead {
  return createDocumentStoreHandle({ document }).store;
}

function runChecks(
  skill: SkillManifest,
  store: DocumentStoreRead,
): readonly { readonly name: string; readonly passed: boolean }[] {
  return runStructuralChecks(skill.evaluation.structuralChecks, store, {
    volumeId: CONTEXT.volumeId,
  });
}

describe("rigging skills evaluate against fixed fixtures (AC3)", () => {
  it("covers the four required rig categories", () => {
    const categories = RIGGING_SKILLS.map((skill) => skill.category);
    for (const required of [
      "biped",
      "quadruped",
      "wings",
      "mechanical-linkage",
    ]) {
      expect(categories).toContain(required);
    }
  });

  it("every rigging skill's checks pass on its golden end state", () => {
    for (const skill of RIGGING_SKILLS) {
      const fixture = fixtureOf(skill);
      expect(fixture.kind).toBe("rigging");
      const results = runChecks(skill, storeOf(fixture.end));
      for (const check of results) {
        expect(
          check.passed,
          `${skill.name}: ${check.name}: ${String(check.passed)}`,
        ).toBe(true);
      }
    }
  });

  it("every rigging skill's checks fail on the unrigged start", () => {
    for (const skill of RIGGING_SKILLS) {
      const fixture = fixtureOf(skill);
      const results = runChecks(skill, storeOf(fixture.start));
      const rigChecks = results.filter(
        (check) =>
          check.name === "pivot-count-in-range" ||
          check.name === "joint-count-in-range" ||
          check.name === "constraint-count-in-range",
      );
      expect(rigChecks.length).toBeGreaterThan(0);
      for (const check of rigChecks) {
        expect(check.passed, `${skill.name}: ${check.name}`).toBe(false);
      }
    }
  });

  it("keeps efficiency limits coherent and within constraints", () => {
    for (const skill of RIGGING_SKILLS) {
      const limits = skill.evaluation.efficiency;
      expect(limits.goldenToolCalls).toBeLessThanOrEqual(limits.maxToolCalls);
      expect(limits.goldenRounds).toBeLessThanOrEqual(limits.maxRounds);
      expect(limits.goldenCommands).toBeLessThanOrEqual(limits.maxCommands);
      expect(limits.maxToolCalls).toBeLessThanOrEqual(
        skill.constraints.maxToolCallsPerRun,
      );
      expect(limits.maxRounds).toBeLessThanOrEqual(
        skill.constraints.maxRoundsPerRun,
      );
      expect(limits.maxCommands).toBeLessThanOrEqual(
        skill.constraints.maxCommandsPerRun,
      );
      const clean = checkEfficiency(limits, {
        toolCalls: limits.goldenToolCalls,
        rounds: limits.goldenRounds,
        commands: limits.goldenCommands,
      });
      expect(clean.withinGolden, skill.name).toBe(true);
      expect(clean.withinLimits, skill.name).toBe(true);
    }
  });
});

describe("motion skills evaluate against fixed fixtures (AC3)", () => {
  it("covers the six required motion categories", () => {
    const categories = MOTION_SKILLS.map((skill) => skill.category);
    for (const required of [
      "walk",
      "run",
      "jump",
      "idle",
      "fly",
      "mechanical",
    ]) {
      expect(categories).toContain(required);
    }
  });

  it("every motion skill's checks pass on its golden end state", () => {
    for (const skill of MOTION_SKILLS) {
      const fixture = fixtureOf(skill);
      expect(fixture.kind).toBe("motion");
      const results = runChecks(skill, storeOf(fixture.end));
      for (const check of results) {
        expect(
          check.passed,
          `${skill.name}: ${check.name}: ${String(check.passed)}`,
        ).toBe(true);
      }
    }
  });

  it("every motion skill's checks fail on the clip-free start", () => {
    for (const skill of MOTION_SKILLS) {
      const fixture = fixtureOf(skill);
      const results = runChecks(skill, storeOf(fixture.start));
      const animationChecks = results.filter((check) =>
        check.name.startsWith("animation-"),
      );
      expect(animationChecks.length).toBeGreaterThan(0);
      for (const check of animationChecks) {
        expect(check.passed, `${skill.name}: ${check.name}`).toBe(false);
      }
      // The asset stays rigged: rig-state checks still pass on the start.
      const pivotCheck = results.find(
        (check) => check.name === "pivot-count-in-range",
      );
      expect(pivotCheck?.passed, skill.name).toBe(true);
    }
  });

  it("keeps efficiency limits coherent and within constraints", () => {
    for (const skill of MOTION_SKILLS) {
      const limits = skill.evaluation.efficiency;
      expect(limits.goldenToolCalls).toBeLessThanOrEqual(limits.maxToolCalls);
      expect(limits.goldenRounds).toBeLessThanOrEqual(limits.maxRounds);
      expect(limits.goldenCommands).toBeLessThanOrEqual(limits.maxCommands);
      const clean = checkEfficiency(limits, {
        toolCalls: limits.goldenToolCalls,
        rounds: limits.goldenRounds,
        commands: limits.goldenCommands,
      });
      expect(clean.withinGolden, skill.name).toBe(true);
      expect(clean.withinLimits, skill.name).toBe(true);
    }
  });
});

/** Canonical semantic hash of a store's committed state. */
function semanticHashOf(store: DocumentStoreRead): string {
  const document = store.getDocument();
  const volumes = new Map<VolumeId, unknown>();
  for (const key of Object.keys(document.volumes)) {
    const volumeId = key as VolumeId;
    const volume = store.getVolume(volumeId);
    if (volume !== undefined) volumes.set(volumeId, volume);
  }
  return canonicalAssetSemanticHash(
    document,
    volumes as unknown as Parameters<typeof canonicalAssetSemanticHash>[1],
  );
}

describe("recorded golden traces apply through the preview seam (AC3/AC4)", () => {
  it("every rigging skill's golden trace lands in its golden end state with provenance", () => {
    for (const skill of RIGGING_SKILLS) {
      const fixture = fixtureOf(skill);
      const commands = rigGoldenCommands(fixture.id);
      // The recorded trace length is the skill's golden command budget:
      // the efficiency metadata is measured against a real recorded run.
      expect(commands.length, skill.name).toBe(
        skill.evaluation.efficiency.goldenCommands,
      );

      const records: CommittedTransactionRecord[] = [];
      const handle = createDocumentStoreHandle({ document: fixture.start });
      const bus = new CommandBus(
        handle.store,
        createPreviewRegistry(),
        handle.writeCapability,
        undefined,
        { onCommitted: (record) => records.push(record) },
      );
      const session = createPreviewSession({
        live: handle.store,
        applyBus: bus,
      });
      const staged = session.stageMany(commands);
      expect(staged.ok, `${skill.name}: ${JSON.stringify(staged)}`).toBe(true);
      const applied = applyWithProvenance(
        session,
        skill.name,
        skill.version,
        `trace-${fixture.id}`,
      );
      expect(applied.ok, `${skill.name}: ${JSON.stringify(applied)}`).toBe(
        true,
      );

      // Provenance metadata is recorded on the committed transaction.
      expect(records[0]?.label).toBe(
        provenanceLabel(skill.name, skill.version),
      );
      expect(parseProvenanceLabel(records[0]?.label ?? "")).toEqual({
        name: skill.name,
        version: skill.version,
      });

      // The committed state is EXACTLY the golden end fixture.
      expect(semanticHashOf(handle.store), skill.name).toBe(
        semanticHashOf(storeOf(fixture.end)),
      );
      // And the skill's fixed checks pass on the applied result.
      const results = runChecks(skill, handle.store);
      for (const check of results) {
        expect(
          check.passed,
          `${skill.name}: ${check.name}: ${String(check.passed)}`,
        ).toBe(true);
      }
    }
  });

  it("every motion skill's golden trace stages a playable overlay clip and applies with provenance", () => {
    for (const skill of MOTION_SKILLS) {
      const fixture = fixtureOf(skill);
      const commands = motionGoldenCommands(fixture.id);
      expect(commands.length, skill.name).toBe(
        skill.evaluation.efficiency.goldenCommands,
      );

      const records: CommittedTransactionRecord[] = [];
      const handle = createDocumentStoreHandle({ document: fixture.start });
      const bus = new CommandBus(
        handle.store,
        createPreviewRegistry(),
        handle.writeCapability,
        undefined,
        { onCommitted: (record) => records.push(record) },
      );
      const session = createPreviewSession({
        live: handle.store,
        applyBus: bus,
      });
      const staged = session.stageMany(commands);
      expect(staged.ok, `${skill.name}: ${JSON.stringify(staged)}`).toBe(true);

      // The staged clip is readable from the overlay before Apply (the
      // playback projection of the preview session, plan S13.5): the
      // fixed fixture's clip id resolves to the staged descriptor.
      const goldenAnimation = Object.values(fixture.end.animations)[0];
      expect(goldenAnimation).toBeDefined();
      const overlay = session.overlayClip(
        goldenAnimation?.animationId as AnimationId,
      );
      expect(overlay).toBeDefined();
      expect(overlay?.duration).toBe(goldenAnimation?.duration);
      expect(overlay?.loop).toBe(goldenAnimation?.loop);
      expect(overlay?.tracks).toHaveLength(goldenAnimation?.tracks.length ?? 0);

      const applied = applyWithProvenance(
        session,
        skill.name,
        skill.version,
        `trace-${fixture.id}`,
      );
      expect(applied.ok, `${skill.name}: ${JSON.stringify(applied)}`).toBe(
        true,
      );
      expect(records[0]?.label).toBe(
        provenanceLabel(skill.name, skill.version),
      );

      expect(semanticHashOf(handle.store), skill.name).toBe(
        semanticHashOf(storeOf(fixture.end)),
      );
      const results = runChecks(skill, handle.store);
      for (const check of results) {
        expect(
          check.passed,
          `${skill.name}: ${check.name}: ${String(check.passed)}`,
        ).toBe(true);
      }
    }
  });
});

describe("motion fixtures keep the looping endpoint policy (AC2)", () => {
  it("every looping fixture clip starts and ends at the same value", () => {
    for (const id of [
      RIG_MOTION_FIXTURE_IDS.walk,
      RIG_MOTION_FIXTURE_IDS.run,
      RIG_MOTION_FIXTURE_IDS.idle,
      RIG_MOTION_FIXTURE_IDS.fly,
      RIG_MOTION_FIXTURE_IDS.mechanical,
    ]) {
      const fixture = rigMotionFixtureById(id);
      expect(fixture).toBeDefined();
      const animations = Object.values(fixture?.end.animations ?? {});
      expect(animations.length).toBe(1);
      const animation = animations[0];
      expect(animation?.loop).toBe("loop");
      for (const track of animation?.tracks ?? []) {
        const first = track.keyframes[0];
        const last = track.keyframes[track.keyframes.length - 1];
        expect(first?.property).toEqual(last?.property);
      }
    }
  });
});
