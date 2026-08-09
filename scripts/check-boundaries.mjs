import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const allowedDependencies = {
  shared: [],
  math: ["shared"],
  model: ["shared", "math"],
  voxel: ["shared", "math", "model"],
  document: ["shared", "math", "model", "voxel"],
  rigging: ["shared", "math", "model", "document"],
  animation: ["shared", "math", "model", "document", "rigging"],
  commands: [
    "shared",
    "math",
    "model",
    "document",
    "voxel",
    "rigging",
    "animation",
  ],
  renderer: [
    "shared",
    "math",
    "model",
    "document",
    "voxel",
    "rigging",
    "animation",
  ],
  session: [
    "shared",
    "math",
    "model",
    "document",
    "voxel",
    "commands",
    "rigging",
    "animation",
  ],
  editor: [
    "shared",
    "math",
    "model",
    "document",
    "voxel",
    "commands",
    "rigging",
    "animation",
  ],
  formats: [
    "shared",
    "math",
    "model",
    "document",
    "voxel",
    "rigging",
    "animation",
    "testkit",
  ],
  interchange: [
    "shared",
    "math",
    "model",
    "document",
    "voxel",
    "commands",
    "formats",
    "storage",
  ],
  storage: [
    "shared",
    "math",
    "model",
    "document",
    "voxel",
    "formats",
    "testkit",
  ],
  agent: [
    "shared",
    "math",
    "model",
    "document",
    "voxel",
    "commands",
    "rigging",
    "animation",
  ],
  // Generators themselves depend only on shared/agent/commands; the
  // generic document stack is declared for the generator lifecycle and
  // boundary tests that stage proposals into a real preview session.
  // animation/formats are test-only devDependencies (ticket #38 boundary
  // proof) and are never imported by skills source.
  skills: ["shared", "agent", "commands", "model", "document", "animation", "formats"],
  testkit: ["shared"],
  evaluation: [
    "shared",
    "math",
    "model",
    "document",
    "voxel",
    "commands",
    "agent",
    "renderer",
    "rigging",
    "animation",
  ],
  // QA harness (ticket #45): measures every gate metric through the real
  // seams, so it may depend on every semantic and adapter package. Nothing
  // may depend on benchmarks (it is a leaf tool, never imported by core).
  benchmarks: [
    "shared",
    "math",
    "model",
    "document",
    "voxel",
    "commands",
    "rigging",
    "animation",
    "renderer",
    "formats",
    "storage",
    "interchange",
    "agent",
    "evaluation",
    "session",
  ],
};
const packageOnlyAdapterPattern =
  /^(react|@react-three|@tauri-apps|@anthropic-ai|openai|node:(?:child_process|fs|http|https|net|path|worker_threads))(\/|$)/u;
const threePattern = /^(three)(\/|$)/u;
const importPattern = /(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/gu;

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

export async function inspectBoundaries(workspaceRoot) {
  const findings = [];
  const packageRoot = resolve(workspaceRoot, "packages");
  const directories = (
    await readdir(packageRoot, { withFileTypes: true })
  ).filter((entry) => entry.isDirectory());
  const graph = new Map();
  for (const directory of directories) {
    const packageName = directory.name;
    const manifestPath = resolve(packageRoot, packageName, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    // Both runtime and test-only (dev) workspace dependencies count as
    // declared; the allowed-graph rule below still bounds both.
    const declared = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    };
    const dependencies = Object.keys(declared)
      .filter((name) => name.startsWith("@voxel-maker/"))
      .map((name) => name.slice(13));
    graph.set(packageName, dependencies);
    const allowed = new Set(allowedDependencies[packageName] ?? []);
    for (const dependency of dependencies)
      if (!allowed.has(dependency))
        findings.push(`${packageName} may not depend on ${dependency}`);
    const src = resolve(packageRoot, packageName, "src");
    for (const file of await sourceFiles(src)) {
      const contents = await readFile(file, "utf8");
      for (const match of contents.matchAll(importPattern)) {
        const specifier = match[1];
        if (specifier?.startsWith("@voxel-maker/")) {
          const parts = specifier.split("/");
          const dependency = parts[1];
          if (parts.length !== 2)
            findings.push(
              `${packageName} uses forbidden deep import ${specifier}`,
            );
          if (dependency && !allowed.has(dependency))
            findings.push(`${packageName} may not import ${dependency}`);
          if (dependency && !dependencies.includes(dependency))
            findings.push(
              `${packageName} imports undeclared dependency ${dependency}`,
            );
        }
        if (specifier?.startsWith(".")) {
          const packageDirectory = resolve(packageRoot, packageName);
          const target = resolve(dirname(file), specifier);
          const packageRelativeTarget = relative(packageDirectory, target);
          if (
            packageRelativeTarget === ".." ||
            packageRelativeTarget.startsWith(
              `..${process.platform === "win32" ? "\\" : "/"}`,
            )
          ) {
            findings.push(
              `${packageName} uses a cross-package relative import`,
            );
          }
        }
        const isTestFile = /\.test\.[cm]?[jt]sx?$/u.test(file);
        if (
          !isTestFile &&
          specifier &&
          packageOnlyAdapterPattern.test(specifier)
        )
          findings.push(
            `${packageName} imports adapter dependency ${specifier}`,
          );
        if (
          !isTestFile &&
          packageName !== "renderer" &&
          specifier &&
          threePattern.test(specifier)
        )
          findings.push(
            `${packageName} imports renderer dependency ${specifier}`,
          );
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(name, path) {
    if (visiting.has(name)) {
      findings.push(`dependency cycle: ${[...path, name].join(" -> ")}`);
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of graph.get(name) ?? [])
      visit(dependency, [...path, name]);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of graph.keys()) visit(name, []);
  return [...new Set(findings)].sort();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const findings = await inspectBoundaries(process.cwd());
  if (findings.length > 0) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
  } else console.log("Package boundaries and dependency graph are valid.");
}
