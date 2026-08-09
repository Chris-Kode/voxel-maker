import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Least-privilege native-capability gate (issue #44, plan §11.2, S17.6):
 * the desktop shell's native surface must stay a minimal allowlist. This
 * script fails the build when:
 *
 * - the Tauri capability file grants anything outside the v1 allowlist
 *   (no shell, filesystem, http, process, updater, websocket, or CLI
 *   permissions);
 * - the production CSP is missing, allows 'unsafe-eval', or permits remote
 *   frames/content; any window loads remote content;
 * - the Rust crate depends on a shell/fs/http/updater/process plugin;
 * - the Rust command surface grows beyond the documented command list;
 * - product source uses eval / new Function / child_process / shell
 *   execution constructs.
 *
 * Tested by scripts/check-native-capabilities.test.mjs against fixture
 * trees; runs in `pnpm check:security`.
 */

export const ALLOWED_PERMISSIONS = new Set([
  "core:default",
  "dialog:allow-open",
  "dialog:allow-save",
]);

/** Permission prefixes that would widen the native attack surface. */
const FORBIDDEN_PERMISSION_PREFIXES = [
  "shell:",
  "fs:",
  "http:",
  "https:",
  "process:",
  "updater:",
  "websocket:",
  "cli:",
  "os:",
  "global:",
  "core:window:",
  "core:webview:",
];

/** Direct Rust dependencies that must never appear in the shell crate. */
const FORBIDDEN_CRATE_DEPENDENCIES = [
  "tauri-plugin-shell",
  "tauri-plugin-fs",
  "tauri-plugin-http",
  "tauri-plugin-updater",
  "tauri-plugin-process",
  "tauri-plugin-websocket",
  "tauri-plugin-cli",
  "reqwest",
  "ureq",
];

/** The only commands the Rust invoke handler may expose. */
const ALLOWED_RUST_COMMANDS = new Set([
  "read_project_bytes",
  "write_project_bytes_atomic",
  "project_exists",
  "read_backup_bytes",
  "remove_project",
  "write_image_bytes_atomic",
  "image_exists",
  "read_journal_bytes",
  "append_journal_bytes",
  "replace_journal_bytes",
  "remove_journal",
  "read_recent_projects",
  "write_recent_projects",
  "credential_save",
  "credential_get",
  "credential_delete",
]);

/** Forbidden dynamic-execution constructs in product source. */
const FORBIDDEN_SOURCE_PATTERNS = [
  /\beval\s*\(/u,
  /\bnew\s+Function\s*\(/u,
  /child_process/u,
  /\bexecSync\s*\(/u,
  /\bexecFileSync\s*\(/u,
  /\bspawnSync\s*\(/u,
  /\b(?:exec|spawn)\s*\(\s*["'`]/u,
];

const isTestFile = (name) => /[._-]test\.(?:ts|tsx|mjs|js)$/u.test(name);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function listSourceFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (
        /\.(?:ts|tsx|rs)$/u.test(entry.name) &&
        !isTestFile(entry.name)
      ) {
        files.push(path);
      }
    }
  }
  await walk(root);
  return files;
}

export async function inspectNativeCapabilities(root) {
  const problems = [];
  const configPath = join(root, "apps/desktop/src-tauri/tauri.conf.json");
  const cargoPath = join(root, "apps/desktop/src-tauri/Cargo.toml");
  const rustPath = join(root, "apps/desktop/src-tauri/src/lib.rs");

  // 1. Capability allowlist. Tauri merges EVERY JSON file in the
  // capabilities directory, so every file is audited, not just
  // default.json; a file without a `windows` key still grants permissions.
  const capabilityDir = join(root, "apps/desktop/src-tauri/capabilities");
  const capabilityFiles = (await readdir(capabilityDir)).filter((name) =>
    name.endsWith(".json"),
  );
  if (capabilityFiles.length === 0) {
    problems.push("no Tauri capability files found to audit");
  }
  for (const capabilityFile of capabilityFiles) {
    const capabilities = await readJson(join(capabilityDir, capabilityFile));
    for (const permission of capabilities.permissions ?? []) {
      if (!ALLOWED_PERMISSIONS.has(permission)) {
        problems.push(
          `capability permission ${permission} (${capabilityFile}) is outside the allowlist`,
        );
      }
      for (const prefix of FORBIDDEN_PERMISSION_PREFIXES) {
        if (permission.startsWith(prefix)) {
          problems.push(
            `capability permission ${permission} uses the forbidden prefix ${prefix}`,
          );
        }
      }
    }
  }

  // 2. CSP and remote-content posture.
  const config = await readJson(configPath);
  const security = config.app?.security ?? {};
  const csp = security.csp;
  if (typeof csp !== "string" || csp.length === 0) {
    problems.push("production CSP is missing");
  } else {
    if (!csp.includes("default-src 'self'")) {
      problems.push("production CSP must start from default-src 'self'");
    }
    if (/unsafe-eval/u.test(csp)) {
      problems.push("production CSP must not allow unsafe-eval");
    }
    if (!csp.includes("frame-ancestors 'none'")) {
      problems.push("production CSP must set frame-ancestors 'none'");
    }
    if (!csp.includes("object-src 'none'")) {
      problems.push("production CSP must set object-src 'none'");
    }
  }
  for (const window of config.app?.windows ?? []) {
    if (typeof window.url === "string" && window.url.length > 0) {
      problems.push(
        `window ${String(window.label)} loads remote content (${window.url})`,
      );
    }
  }
  if (security.dangerousRemoteDomainIpcAccess !== undefined) {
    problems.push(
      "dangerousRemoteDomainIpcAccess must stay unset (no remote IPC)",
    );
  }

  // 3. Rust direct dependencies.
  const cargo = await readFile(cargoPath, "utf8");
  for (const dependency of FORBIDDEN_CRATE_DEPENDENCIES) {
    if (
      new RegExp(`^\\s*${dependency.replaceAll("-", "\\-")}\\s*=`, "m").test(
        cargo,
      )
    ) {
      problems.push(
        `Rust crate directly depends on forbidden crate ${dependency}`,
      );
    }
  }

  // 4. Rust command surface.
  const rust = await readFile(rustPath, "utf8");
  const handlerMatch = rust.match(/generate_handler!\[([^\]]*)\]/u);
  if (handlerMatch === null) {
    problems.push("lib.rs has no generate_handler! list to audit");
  } else {
    // Re-append the closing bracket so the final command is audited too.
    const body = `${handlerMatch[1]}]`;
    const commands = [...body.matchAll(/\b([a-z_][a-z0-9_]*)\s*[,)\]]/gu)].map(
      (match) => match[1],
    );
    for (const command of commands) {
      if (!ALLOWED_RUST_COMMANDS.has(command)) {
        problems.push(
          `Rust invoke handler exposes undeclared command ${command}`,
        );
      }
    }
  }
  if (/\bCommand::new\s*\(/u.test(rust)) {
    problems.push("Rust code spawns child processes (Command::new)");
  }

  // 5. Product source scan for dynamic execution.
  for (const sourceRoot of ["apps/desktop/src", "packages"]) {
    for (const file of await listSourceFiles(join(root, sourceRoot))) {
      const source = await readFile(file, "utf8");
      for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
        if (pattern.test(source)) {
          problems.push(
            `forbidden construct ${String(pattern)} in ${file.replace(root, ".")}`,
          );
        }
      }
    }
  }

  return problems;
}

// Runs as `node scripts/check-native-capabilities.mjs` from the repo root.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = process.cwd();
  try {
    const problems = await inspectNativeCapabilities(root);
    if (problems.length > 0) {
      console.error("Native capability check failed:");
      for (const problem of problems) console.error(`- ${problem}`);
      process.exit(1);
    }
    console.log("Native capability check passed: minimal allowlist intact.");
  } catch (error) {
    console.error(`Native capability check could not run: ${String(error)}`);
    process.exit(1);
  }
}
