import { rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

const allowedTargets = new Set([".turbo", "dist"]);
for (const target of process.argv.slice(2)) {
  if (!allowedTargets.has(basename(target))) {
    throw new Error(`Refusing to clean unsupported target: ${target}`);
  }
  await rm(resolve(target), { force: true, recursive: true });
}
