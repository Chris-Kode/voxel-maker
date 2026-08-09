import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectBoundaries } from "./check-boundaries.mjs";

async function workspace(packages) {
  const root = await mkdtemp(join(tmpdir(), "voxel-boundaries-"));
  for (const [name, fixture] of Object.entries(packages)) {
    await mkdir(join(root, `packages/${name}/src`), { recursive: true });
    await writeFile(
      join(root, `packages/${name}/package.json`),
      JSON.stringify({
        name: `@voxel-maker/${name}`,
        dependencies: fixture.dependencies ?? {},
      }),
    );
    await writeFile(
      join(root, `packages/${name}/src/index.ts`),
      fixture.source ?? "export {};\n",
    );
  }
  return root;
}

test("an intentional forbidden import fails the boundary check", async () => {
  const root = await workspace({
    shared: { source: 'import "@voxel-maker/renderer";\n' },
  });
  assert.deepEqual(await inspectBoundaries(root), [
    "shared imports undeclared dependency renderer",
    "shared may not import renderer",
  ]);
});

test("cross-package relative and platform imports fail the boundary check", async () => {
  const root = await workspace({
    formats: {
      source: 'import "../../renderer/src/index.js";\nimport "node:fs";\n',
    },
  });
  assert.deepEqual(await inspectBoundaries(root), [
    "formats imports adapter dependency node:fs",
    "formats uses a cross-package relative import",
  ]);
});

test("the package graph rejects unsupported edges and cycles", async () => {
  const root = await workspace({
    editor: {
      dependencies: { "@voxel-maker/math": "workspace:*" },
      source: 'import "@voxel-maker/math";\n',
    },
    math: {
      dependencies: { "@voxel-maker/editor": "workspace:*" },
      source: 'import "@voxel-maker/editor";\n',
    },
  });
  // Editor is allowed to depend on math (its tool API exposes `Vec3i`),
  // so the findings are the cycle and the unsupported math -> editor edge.
  assert.deepEqual(await inspectBoundaries(root), [
    "dependency cycle: editor -> math -> editor",
    "math may not depend on editor",
    "math may not import editor",
  ]);
});
