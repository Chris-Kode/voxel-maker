import { access, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const packageDirectories = (await readdir("packages", { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const entrypoints = packageDirectories.map(
  (packageDirectory) => `packages/${packageDirectory}/dist/index.js`,
);

for (const entrypoint of entrypoints) {
  await access(entrypoint);
  await import(pathToFileURL(entrypoint));
}

await build({
  build: {
    emptyOutDir: false,
    lib: {
      entry: entrypoints,
      formats: ["es"],
    },
    write: false,
  },
  logLevel: "silent",
});
