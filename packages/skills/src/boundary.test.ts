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
  canonicalAssetSemanticHash,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import {
  createPreviewRegistry,
  createPreviewSession,
} from "@voxel-maker/agent";
import type { VolumeId } from "@voxel-maker/shared";
import { GENERATOR_DEFINITIONS, proposeGenerator } from "./registry.js";
import { FIXTURE_IDS, createGeneratorFixture } from "./fixtures.js";
import { applyWithProvenance } from "./provenance.js";

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
    const script = CHILD_SCRIPT;
    const result = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script, documentPath, journalPath],
      {
        cwd: skillsRoot(),
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
  const volumes = new Map<VolumeId, VoxelVolumeReadView>();
  for (const key of Object.keys(document.volumes)) {
    const volumeId = key as VolumeId;
    const volume = store.getVolume(volumeId);
    if (volume !== undefined) volumes.set(volumeId, volume);
  }
  return canonicalAssetSemanticHash(document, volumes);
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

/**
 * The catalog-free child script: deliberately imports none of the
 * skills package. It opens the saved document, replays the recovery
 * journal, runs one edit, one animation (create clip/track/keyframe and
 * evaluate the runtime), and one .vxl export round trip, then prints
 * the recovered document's canonical semantic hash for comparison with
 * the parent's post-apply state.
 */
const CHILD_SCRIPT = String.raw`
import { readFileSync } from "node:fs";
import { createDocumentStore } from "@voxel-maker/document";
import { canonicalAssetSemanticHash } from "@voxel-maker/document";
import {
  CommandBus,
  CommandRegistry,
  DEFAULT_COMMAND_LIMITS,
  addTrackCommand,
  createAnimationCommand,
  fillBoxCommand,
  parseJournalTransaction,
  registerAnimationCommands,
  registerArticulationCommands,
  registerBatchCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
  registerVolumeCommands,
  setKeyframeCommand,
} from "@voxel-maker/commands";
import {
  animationId,
  commandId,
  keyframeId,
  materialId,
  trackId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import { evaluateAnimationRuntime } from "@voxel-maker/animation";
import { readVxlProject, writeVxlProject } from "@voxel-maker/formats";

// With -e, process.argv[1] is the first positional argument.
const [documentPath, journalPath] = process.argv.slice(1);
const document = JSON.parse(readFileSync(documentPath, "utf8"));
const frames = readFileSync(journalPath, "utf8")
  .trim()
  .split("\n")
  .filter((line) => line.length > 0);

// OPEN: fresh store from the saved document — no skill catalog anywhere.
const { store: openedStore, writeCapability } = createDocumentStore({ document });
const registry = new CommandRegistry();
registerVoxelCommands(registry);
registerBatchCommands(registry);
registerRegionCommands(registry);
registerNodeCommands(registry);
registerMaterialCommands(registry);
registerVolumeCommands(registry);
registerArticulationCommands(registry);
registerAnimationCommands(registry);
const bus = new CommandBus(openedStore, registry, writeCapability);

// RECOVER: replay the journal frames (the provenance-labeled apply).
let expectedRevision = openedStore.revision;
for (const frame of frames) {
  const record = parseJournalTransaction(
    JSON.parse(frame),
    DEFAULT_COMMAND_LIMITS,
  );
  const result = bus.executeTransaction(record.commands, {
    transactionId: record.transactionId,
    expectedRevision: record.expectedRevision,
    source: record.source,
    ...(record.correlationId === undefined
      ? {}
      : { correlationId: record.correlationId }),
    ...(record.label === undefined ? {} : { label: record.label }),
  });
  if (!result.ok) throw new Error("replay failed: " + JSON.stringify(result));
  expectedRevision = result.value.revisionAfter;
}
if (openedStore.revision !== frames.length) {
  throw new Error("unexpected revision after replay");
}

// The recovered document is the exact skill-created state.
const hash = canonicalAssetSemanticHash(
  openedStore.getDocument(),
  volumeReadMap(openedStore),
);
if (JSON.stringify(openedStore.getDocument()).includes("skill")) {
  throw new Error("document must not reference a skill");
}

// EDIT: extend the stairs with one more box via the ordinary bus.
const edit = bus.execute(
  fillBoxCommand(commandId("command:child:edit:0001"), {
    volumeId: volumeId("volume:generator:main"),
    region: { min: [0, 3, 0], max: [4, 4, 1] },
    material: materialId(1),
  }),
  {
    transactionId: transactionId("transaction:child:edit:0001"),
    expectedRevision,
    source: "ui",
  },
);
if (!edit.ok) throw new Error("edit failed: " + JSON.stringify(edit));
expectedRevision = edit.value.revisionAfter;

// ANIMATE: create a clip on the first non-root node and evaluate it.
const nodes = Object.values(openedStore.getDocument().nodes);
const target = nodes.find((node) => node.parentId !== null);
if (target === undefined) throw new Error("no target node");
const clipId = animationId("animation:child:0001");
const trackIdValue = trackId("track:child:0001");
const okCreate = bus.execute(
  createAnimationCommand(commandId("command:child:anim:0001"), {
    animationId: clipId,
    duration: 1,
    loop: "loop",
  }),
  {
    transactionId: transactionId("transaction:child:anim:0001"),
    expectedRevision,
    source: "ui",
  },
);
if (!okCreate.ok) throw new Error("animation create failed");
expectedRevision = okCreate.value.revisionAfter;
const okTrack = bus.execute(
  addTrackCommand(commandId("command:child:track:0001"), {
    animationId: clipId,
    trackId: trackIdValue,
    targetNodeId: target.nodeId,
    interpolation: "linear",
  }),
  {
    transactionId: transactionId("transaction:child:track:0001"),
    expectedRevision,
    source: "ui",
  },
);
if (!okTrack.ok) throw new Error("track add failed");
expectedRevision = okTrack.value.revisionAfter;
const okKey = bus.execute(
  setKeyframeCommand(commandId("command:child:kf:0001"), {
    animationId: clipId,
    trackId: trackIdValue,
    keyframeId: keyframeId("keyframe:child:0001"),
    time: 0,
    property: { channel: "translation", value: [0, 0, 0] },
  }),
  {
    transactionId: transactionId("transaction:child:kf:0001"),
    expectedRevision,
    source: "ui",
  },
);
if (!okKey.ok) throw new Error("keyframe failed");
const clip = openedStore.getDocument().animations[clipId];
if (clip === undefined) throw new Error("clip missing");
const runtime = evaluateAnimationRuntime(
  openedStore.getDocument(),
  clip,
  0.5,
);
if (runtime.world.size === 0) throw new Error("animation runtime empty");

// EXPORT: .vxl container round trip through the formats package. The
// exported state is the edited and animated document; the container's
// verified semantic hash must equal the local canonical hash of that
// exact state.
const exportHash = canonicalAssetSemanticHash(
  openedStore.getDocument(),
  volumeReadMap(openedStore),
);
const exported = writeVxlProject({
  document: openedStore.getDocument(),
  volumes: volumeReadMap(openedStore),
});
if (exported.byteLength === 0) throw new Error("empty export");
const loaded = readVxlProject(exported);
if (loaded.semanticHash !== exportHash) {
  throw new Error("export semantic hash mismatch");
}

console.log("OPEN-EDIT-ANIMATE-EXPORT-OK");
console.log("HASH " + hash);

function volumeReadMap(store) {
  const volumes = new Map();
  for (const key of Object.keys(store.getDocument().volumes)) {
    const volume = store.getVolume(key);
    if (volume !== undefined) volumes.set(key, volume);
  }
  return volumes;
}
`;
