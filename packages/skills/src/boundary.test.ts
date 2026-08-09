import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  VOXEL_COPY_REGION_COMMAND,
  VOXEL_DELETE_REGION_COMMAND,
  VOXEL_FILL_BOX_COMMAND,
  VOXEL_FILL_CYLINDER_COMMAND,
  VOXEL_MIRROR_REGION_COMMAND,
  VOXEL_SET_BATCH_COMMAND,
} from "@voxel-maker/commands";
import { createPreviewRegistry } from "@voxel-maker/agent";
import { GENERATOR_DEFINITIONS, proposeGenerator } from "./registry.js";
import { FIXTURE_IDS } from "./fixtures.js";

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
