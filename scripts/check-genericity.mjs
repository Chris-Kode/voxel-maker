#!/usr/bin/env node
/**
 * Final genericity gate (issue #46, plan S17.13, M5): proves that the
 * engine stays free of asset-category concepts while every PRD
 * definition-of-done category is represented by demonstrations above the
 * engine (skills, generators, fixtures, animation demos).
 *
 * Two halves:
 *  1. Engine surface — no core package exports or assigns category
 *     concepts (names or kind/category literals) in non-test, non-fixture
 *     source.
 *  2. Demonstration coverage — the nine definition-of-done categories are
 *     each represented by a skill/generator/fixture/demo outside the
 *     engine, so the core needs no category knowledge to express them.
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceRoot = process.cwd();

/** The nine demonstrations: the PRD definition-of-done categories plus
 * non-humanoid creatures split into quadruped and flying-creature
 * demonstrations. Each maps to the category tokens used by the evidence
 * layer (skills, fixtures, demos) above the engine. */
const NINE_DEMONSTRATIONS = [
  { name: "architecture", tokens: ["architecture", "house"] },
  { name: "furniture", tokens: ["furniture"] },
  { name: "vehicles", tokens: ["vehicle", "vehicles", "wheel"] },
  { name: "vegetation", tokens: ["vegetation", "tree", "plant"] },
  {
    name: "humanoids",
    tokens: ["humanoid", "humanoids", "simple-character", "character"],
  },
  { name: "quadruped", tokens: ["quadruped"] },
  { name: "flying-creature", tokens: ["flying-creature", "wings", "bird"] },
  {
    name: "mechanical-linkage",
    tokens: ["mechanical-linkage", "mechanical", "linked-arm", "robot"],
  },
  { name: "abstract", tokens: ["abstract"] },
];

/**
 * The single asset-category vocabulary of this gate. It drives both
 * directions: demonstration tokens are the evidence layer's category
 * names, and the forbidden pattern is derived from the same list so the
 * engine scan and the demonstration coverage can never drift apart.
 */
const CATEGORY_TOKENS = [
  "architecture",
  "furniture",
  "vehicle",
  "vegetation",
  "humanoid",
  "quadruped",
  "flying-creature",
  "mechanical-linkage",
  "mechanical",
  "abstract",
  "house",
  "wheel",
  "tree",
  "plant",
  "bird",
  "character",
  "chest",
  "linked-arm",
  "robot",
  "door",
  "car",
  "building",
  "fish",
  "creature",
  "animal",
  "wing",
];

/** Asset-category identifiers that must never appear in the engine. */
const FORBIDDEN_DOMAIN_NAMES = new RegExp(
  `(${CATEGORY_TOKENS.join("|")})`,
  "iu",
);

/** Engine packages: everything below the skills/evaluation layer. */
const ENGINE_PACKAGES = [
  "shared",
  "math",
  "model",
  "voxel",
  "document",
  "rigging",
  "animation",
  "commands",
  "renderer",
  "session",
  "editor",
  "formats",
  "interchange",
  "storage",
  "agent",
  "testkit",
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name))
      files.push(path);
  }
  return files;
}

/** One exported identifier: `export const NAME`, `export function NAME`,
 * `export type NAME`, `export interface NAME`, `export class NAME`. */
const exportNamePattern =
  /export\s+(?:const|function|class|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu;

/** A category literal assigned to kind/category/type discriminators. */
const kindLiteralPattern = new RegExp(
  `(?:kind|category|type)\\s*[:=]\\s*["']([a-z-]*(?:${CATEGORY_TOKENS.join("|")})[a-z-]*)["']`,
  "giu",
);

function isFixtureModule(path) {
  return /\/fixtures\.ts$/u.test(path) || /\/fixtures\//u.test(path);
}

async function engineViolations() {
  const violations = [];
  for (const packageName of ENGINE_PACKAGES) {
    const src = resolve(workspaceRoot, "packages", packageName, "src");
    for (const file of await sourceFiles(src)) {
      if (/\.test\./u.test(file) || isFixtureModule(file)) continue;
      const contents = await readFile(file, "utf8");
      for (const match of contents.matchAll(exportNamePattern)) {
        if (FORBIDDEN_DOMAIN_NAMES.test(match[1]))
          violations.push(
            `${packageName}: export ${match[1]} (${file.replace(workspaceRoot, ".")})`,
          );
      }
      for (const match of contents.matchAll(kindLiteralPattern)) {
        violations.push(
          `${packageName}: category literal "${match[1]}" (${file.replace(workspaceRoot, ".")})`,
        );
      }
    }
  }
  return violations;
}

async function demonstrationCoverage() {
  const covered = new Set();
  const evidence = [];

  // Skill catalogs (creation/, rigging/, motion/) — domain knowledge above
  // the engine, allowed to name categories by design.
  for (const directory of ["creation", "rigging", "motion"]) {
    const skillDir = resolve(
      workspaceRoot,
      "packages",
      "skills",
      "src",
      directory,
    );
    for (const file of await sourceFiles(skillDir)) {
      const contents = await readFile(file, "utf8");
      const match = contents.match(/category:\s*"([a-z-]+)"/u);
      if (match) {
        covered.add(match[1]);
        evidence.push(
          `skill ${directory}/${match[1]} (${file.replace(workspaceRoot, ".")})`,
        );
      }
    }
  }

  // Rig/motion fixture ids (packages/skills/src/rig-motion-fixtures.ts).
  const rigFixtures = resolve(
    workspaceRoot,
    "packages",
    "skills",
    "src",
    "rig-motion-fixtures.ts",
  );
  const rigContents = await readFile(rigFixtures, "utf8");
  for (const match of rigContents.matchAll(
    /\b(biped|quadruped|wings|simple-character|mechanical|abstract)[A-Za-z]*\b/gu,
  )) {
    covered.add(match[1]);
  }
  evidence.push(`rig/motion fixture catalog (rig-motion-fixtures.ts)`);

  // Model release fixtures (house / vehicle / abstract).
  const modelFixtures = resolve(
    workspaceRoot,
    "packages",
    "model",
    "src",
    "fixtures.ts",
  );
  const modelContents = await readFile(modelFixtures, "utf8");
  for (const name of [
    "createHouseFixture",
    "createVehicleFixture",
    "createAbstractFixture",
  ]) {
    if (modelContents.includes(`export function ${name}`)) {
      const category = name.slice(6, -"Fixture".length).toLowerCase();
      covered.add(category);
      evidence.push(`model fixture ${category} (fixtures.ts)`);
    }
  }

  // Animation demos (packages/animation/src/fixtures.ts ANIMATED_DEMOS kinds).
  const animationFixtures = resolve(
    workspaceRoot,
    "packages",
    "animation",
    "src",
    "fixtures.ts",
  );
  const animationContents = await readFile(animationFixtures, "utf8");
  const demoSection = animationContents.slice(
    animationContents.indexOf("ANIMATED_DEMOS"),
  );
  for (const match of demoSection.matchAll(/kind:\s*"([a-z-]+)"/gu)) {
    covered.add(match[1]);
    evidence.push(`animated demo ${match[1]} (animation fixtures.ts)`);
  }

  const missing = NINE_DEMONSTRATIONS.filter(
    (demonstration) =>
      !demonstration.tokens.some((token) => covered.has(token)),
  ).map((demonstration) => demonstration.name);
  return { missing, evidence: [...evidence].sort() };
}

const violations = await engineViolations();
const { missing, evidence } = await demonstrationCoverage();

let failed = false;
if (violations.length > 0) {
  failed = true;
  console.error("GENERICITY ENGINE VIOLATIONS");
  for (const violation of violations) console.error(`  - ${violation}`);
}
if (missing.length > 0) {
  failed = true;
  console.error(`GENERICITY MISSING DEMONSTRATIONS: ${missing.join(", ")}`);
}
console.log(`genericity demonstrations covered: ${evidence.length}`);
for (const line of evidence) console.log(`  - ${line}`);

if (failed) {
  console.error("check:genericity FAILED");
  process.exitCode = 1;
} else {
  console.log(
    "check:genericity passed: engine is category-free; all nine definition-of-done demonstrations exist above the engine.",
  );
}
