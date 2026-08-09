import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  VOXEL_COPY_REGION_COMMAND,
  VOXEL_DELETE_REGION_COMMAND,
  VOXEL_FILL_BOX_COMMAND,
  VOXEL_FILL_CYLINDER_COMMAND,
  VOXEL_MIRROR_REGION_COMMAND,
  VOXEL_SET_BATCH_COMMAND,
  CommandBus,
  journalTransactionToJson,
  type CommittedTransactionRecord,
} from "@voxel-maker/commands";
import {
  RIG_MOTION_FIXTURE_IDS,
  bipedRigGoldenCommands,
  rigMotionFixtureById,
  walkGoldenCommands,
} from "./rig-motion-fixtures.js";
import {
  canonicalAssetSemanticHash,
  createDocumentStore,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import {
  createPreviewRegistry,
  createPreviewSession,
} from "@voxel-maker/agent";
import type { VolumeId } from "@voxel-maker/shared";
import type { VoxelDocument } from "@voxel-maker/model";
import { GENERATOR_DEFINITIONS, proposeGenerator } from "./registry.js";
import { FIXTURE_IDS, createGeneratorFixture } from "./fixtures.js";
import { applyWithProvenance, provenanceLabel } from "./provenance.js";

/**
 * Boundary tests (ticket #37, AC4): generators require no renderer and no
 * asset-category core type. Every proposed command is a registered
 * generic voxel/region command; the package declares no renderer or
 * provider dependency and imports none; and proposals stage on the
 * generic preview registry with no category commands installed.
 */

const CONTEXT = {
  volumeId: FIXTURE_IDS.volume,
  material: FIXTURE_IDS.material,
  seed: "boundary-seed",
};

/** One representative parameter set per generator. */
const REPRESENTATIVE_PARAMS: Readonly<Record<string, unknown>> = {
  "generator.mirror": { region: { min: [0, 0, 0], max: [4, 4, 4] }, axis: "x" },
  "generator.linearRepeat": {
    source: { min: [0, 0, 0], max: [2, 1, 1] },
    count: 3,
    delta: [0, 0, 4],
  },
  "generator.radialRepeat": {
    source: { min: [0, 0, 0], max: [2, 2, 2] },
    center: [10, 0, 10],
    axis: "y",
    count: 4,
    radius: 8,
  },
  "generator.stairs": {
    start: [0, 0, 0],
    count: 3,
    width: 4,
    depth: 2,
    stepHeight: 1,
    axis: "x",
  },
  "generator.wall": {
    min: [0, 0, 0],
    size: [10, 4, 1],
    opening: { min: [2, 0, 0], max: [4, 2, 1] },
  },
  "generator.roof": {
    min: [0, 5, 0],
    width: 6,
    depth: 4,
    style: "pyramid",
    thickness: 1,
  },
  "generator.branches": {
    base: [0, 0, 0],
    trunkHeight: 6,
    trunkSize: 2,
    levels: 2,
    branchLength: 4,
    branchSize: 1,
    rise: 3,
  },
  "generator.wheel": {
    center: [0, 0, 0],
    axis: "y",
    radius: 4,
    thickness: 2,
    hubRadius: 1,
    spokeCount: 4,
    spokeWidth: 1,
  },
  "generator.linkage": {
    start: [0, 0, 0],
    axis: "x",
    count: 5,
    segmentLength: 4,
    thickness: 2,
    pattern: "straight",
  },
};

const GENERIC_COMMAND_TYPES: ReadonlySet<string> = new Set([
  VOXEL_FILL_BOX_COMMAND,
  VOXEL_FILL_CYLINDER_COMMAND,
  VOXEL_COPY_REGION_COMMAND,
  VOXEL_DELETE_REGION_COMMAND,
  VOXEL_MIRROR_REGION_COMMAND,
  VOXEL_SET_BATCH_COMMAND,
]);

describe("no renderer or asset-category core type (AC4)", () => {
  it("proposes only registered generic voxel/region commands", () => {
    const registry = createPreviewRegistry();
    for (const definition of GENERATOR_DEFINITIONS) {
      const proposal = proposeGenerator(
        definition.name,
        REPRESENTATIVE_PARAMS[definition.name],
        CONTEXT,
      );
      for (const command of proposal.commands) {
        expect(GENERIC_COMMAND_TYPES.has(command.type)).toBe(true);
        // Every proposed command is registered on the generic preview
        // registry: no renderer and no asset-category command is needed.
        expect(registry.get(command.type, command.schemaVersion)).toBeDefined();
      }
    }
  });

  it("declares no renderer, provider, or UI dependency", async () => {
    const manifest = JSON.parse(
      await readFile(join(skillsRoot(), "package.json"), "utf8"),
    ) as { dependencies?: Readonly<Record<string, string>> };
    const dependencies = Object.keys(manifest.dependencies ?? {});
    for (const forbidden of [
      "@voxel-maker/renderer",
      "three",
      "react",
      "@tauri-apps",
      "openai",
      "@anthropic-ai",
    ]) {
      expect(
        dependencies.some(
          (name) => name === forbidden || name.startsWith(`${forbidden}/`),
        ),
        `${forbidden} must not be a skills dependency`,
      ).toBe(false);
    }
    expect(dependencies).toContain("@voxel-maker/commands");
    expect(dependencies).toContain("@voxel-maker/agent");
  });

  it("imports no renderer or provider module from source", async () => {
    const forbiddenPrefixes = [
      "@voxel-maker/renderer",
      "@voxel-maker/formats",
      "three",
      "react",
      "@tauri-apps",
      "node:",
    ];
    const files = await sourceFiles(skillsRoot());
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      for (const match of contents.matchAll(importSpecifierPattern)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        for (const forbidden of forbiddenPrefixes) {
          expect(
            specifier === forbidden || specifier.startsWith(`${forbidden}/`),
            `${relative(skillsRoot(), file)} must not import ${forbidden}`,
          ).toBe(false);
        }
      }
    }
  });
});

const importSpecifierPattern =
  /(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/gu;

const SKILLS_SRC = fileURLToPath(new URL(".", import.meta.url));

function skillsRoot(): string {
  return join(SKILLS_SRC, "..");
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    )
      files.push(path);
  }
  return files;
}

describe("skill catalog removal (AC4, plan S14 boundary test)", () => {
  it("no package in the workspace depends on the skill catalog", async () => {
    const root = join(skillsRoot(), "..", "..");
    const packageDirs = ["packages", "apps"];
    const manifests = [];
    for (const dir of packageDirs) {
      const base = join(root, dir);
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = join(base, entry.name, "package.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          dependencies?: Readonly<Record<string, string>>;
        };
        manifests.push({ name: entry.name, manifest });
      }
    }
    for (const { name, manifest } of manifests) {
      const dependencies = Object.keys(manifest.dependencies ?? {});
      expect(
        dependencies.includes("@voxel-maker/skills"),
        `${name} must not depend on @voxel-maker/skills (removable catalog)`,
      ).toBe(false);
    }
  });

  it("core packages never import the skill catalog from source", async () => {
    const root = join(skillsRoot(), "..", "..");
    const coreDirs = ["packages", "apps"];
    for (const dir of coreDirs) {
      const base = join(root, dir);
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "skills") continue;
        for (const file of await sourceFiles(join(base, entry.name))) {
          const contents = await readFile(file, "utf8");
          expect(
            contents.includes("@voxel-maker/skills"),
            `${relative(root, file)} must not import @voxel-maker/skills`,
          ).toBe(false);
        }
      }
    }
  });

  it("documents created with a skill open, edit, animate, and export without the catalog", async () => {
    // Build a skill-created document: one stairs proposal applied with
    // provenance through the ordinary preview seam.
    const fixture = createGeneratorFixture();
    const records: CommittedTransactionRecord[] = [];
    const registry = createPreviewRegistry();
    const bus = new CommandBus(
      fixture.handle.store,
      registry,
      fixture.handle.writeCapability,
      undefined,
      { onCommitted: (record) => records.push(record) },
    );
    const proposal = proposeGenerator("generator.stairs", STAIRS_PARAMS, {
      volumeId: FIXTURE_IDS.volume,
      material: FIXTURE_IDS.material,
      seed: "ac4-removal-seed",
    });
    const session = createPreviewSession({
      live: fixture.store,
      applyBus: bus,
    });
    expect(session.stageMany(proposal.commands).ok).toBe(true);
    const applied = applyWithProvenance(
      session,
      "skill.furniture",
      "1.0.0",
      "ac4-removal-seed",
    );
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    const expectedHash = canonicalSemanticHashOf(fixture.store);

    // Persisted artifacts: the base document (revision 0) and the
    // recovery journal (seed + provenance-labeled apply).
    const dir = await mkdtemp(join(tmpdir(), "voxel-maker-ac4-"));
    const documentPath = join(dir, "document.json");
    const journalPath = join(dir, "journal.jsonl");
    await writeFile(documentPath, JSON.stringify(BASE_DOCUMENT), "utf8");
    await writeFile(
      journalPath,
      records
        .map((record) => JSON.stringify(journalTransactionToJson(record)))
        .join("\n"),
      "utf8",
    );

    // A child process that imports ONLY the generic stack
    // (commands/document/model/animation/formats) — never the skill
    // catalog — opens, recovers, edits, animates, and exports the
    // document, then reports the recovered semantic hash.
    const scriptPath = join(skillsRoot(), "test", "catalog-free-child.mjs");
    const result = await execFileAsync(
      process.execPath,
      [scriptPath, documentPath, journalPath],
      {
        timeout: 30_000,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      },
    );
    expect(result.stderr, result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("OPEN-EDIT-ANIMATE-EXPORT-OK");
    expect(lines[1]).toBe(`HASH ${expectedHash}`);
    await rm(dir, { recursive: true, force: true });
  });

  it("rigged and animated documents open, edit, animate, and export without the catalog", async () => {
    // Build a skill-created rigged and animated document: the biped
    // rig trace and the walk clip applied with provenance through the
    // ordinary preview seam (two labeled applies, two journal frames).
    const fixture = rigMotionFixtureById(RIG_MOTION_FIXTURE_IDS.bipedRig);
    expect(fixture).toBeDefined();
    const handle = createDocumentStore({
      document: fixture?.start as VoxelDocument,
    });
    const records: CommittedTransactionRecord[] = [];
    const bus = new CommandBus(
      handle.store,
      createPreviewRegistry(),
      handle.writeCapability,
      undefined,
      { onCommitted: (record) => records.push(record) },
    );

    const rigSession = createPreviewSession({
      live: handle.store,
      applyBus: bus,
    });
    expect(rigSession.stageMany(bipedRigGoldenCommands()).ok).toBe(true);
    const rigApplied = applyWithProvenance(
      rigSession,
      "skill.biped-rig",
      "1.0.0",
      "ac4-rig-seed",
    );
    expect(rigApplied.ok, JSON.stringify(rigApplied)).toBe(true);

    const motionSession = createPreviewSession({
      live: handle.store,
      applyBus: bus,
    });
    expect(motionSession.stageMany(walkGoldenCommands()).ok).toBe(true);
    const motionApplied = applyWithProvenance(
      motionSession,
      "skill.walk",
      "1.0.0",
      "ac4-walk-seed",
    );
    expect(motionApplied.ok, JSON.stringify(motionApplied)).toBe(true);
    expect(records).toHaveLength(2);
    expect(records[0]?.label).toBe(provenanceLabel("skill.biped-rig", "1.0.0"));
    expect(records[1]?.label).toBe(provenanceLabel("skill.walk", "1.0.0"));
    const expectedHash = canonicalSemanticHashOf(handle.store);

    // Persisted artifacts: the base document (revision 0) and the
    // recovery journal (both provenance-labeled applies).
    const dir = await mkdtemp(join(tmpdir(), "voxel-maker-ac4-rig-"));
    const documentPath = join(dir, "document.json");
    const journalPath = join(dir, "journal.jsonl");
    await writeFile(
      documentPath,
      JSON.stringify(fixture?.start as VoxelDocument),
      "utf8",
    );
    await writeFile(
      journalPath,
      records
        .map((record) => JSON.stringify(journalTransactionToJson(record)))
        .join("\n"),
      "utf8",
    );

    // A child process that imports ONLY the generic stack opens the
    // saved rigged and animated document, replays the journal, edits,
    // animates, and exports it, then reports the recovered hash. The
    // child edits the fixture's torso volume (the rig/motion fixture
    // volumes differ from the generator fixture's).
    const scriptPath = join(skillsRoot(), "test", "catalog-free-child.mjs");
    const result = await execFileAsync(
      process.execPath,
      [scriptPath, documentPath, journalPath, "volume:rig:biped:torso", "1"],
      {
        timeout: 30_000,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      },
    );
    expect(result.stderr, result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("OPEN-EDIT-ANIMATE-EXPORT-OK");
    expect(lines[1]).toBe(`HASH ${expectedHash}`);
    await rm(dir, { recursive: true, force: true });
  });
});

const execFileAsync = promisify(execFileCallback);

/** Canonical semantic hash of the current committed store state. */
function canonicalSemanticHashOf(store: DocumentStoreRead): string {
  const document = store.getDocument();
  const volumes = new Map<VolumeId, unknown>();
  for (const key of Object.keys(document.volumes)) {
    const volumeId = key as VolumeId;
    const volume = store.getVolume(volumeId);
    if (volume !== undefined) volumes.set(volumeId, volume);
  }
  // The map holds the store's volume read views; the hash function only
  // reads their runtime shape, so this cast is test-only glue.
  return canonicalAssetSemanticHash(
    document,
    volumes as unknown as Parameters<typeof canonicalAssetSemanticHash>[1],
  );
}

/** The empty base fixture document exactly as it was opened (revision 0). */
const BASE_DOCUMENT = (() => {
  const fixture = createGeneratorFixture();
  return fixture.store.getDocument();
})();

const STAIRS_PARAMS = {
  start: [0, 0, 0],
  count: 3,
  width: 4,
  depth: 2,
  stepHeight: 1,
  axis: "x",
};
