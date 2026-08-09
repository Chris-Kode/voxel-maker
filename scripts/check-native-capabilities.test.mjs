import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectNativeCapabilities } from "./check-native-capabilities.mjs";

const VALID_CAPABILITIES = {
  $schema: "desktop-schema.json",
  identifier: "default",
  description: "Minimum native allowlist.",
  windows: ["main"],
  permissions: ["core:default", "dialog:allow-open", "dialog:allow-save"],
};

const VALID_CONFIG = {
  app: {
    windows: [{ label: "main", width: 1280, height: 800 }],
    security: {
      csp: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  },
};

const VALID_CARGO = `[package]
name = "voxel-maker"
edition = "2021"

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
keyring = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
`;

const VALID_RUST = `use tauri::Manager;

#[tauri::command]
fn project_exists(path: String) -> Result<bool, String> {
    validate_path(&path)?;
    Ok(Path::new(&path).exists())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_project_bytes,
            write_project_bytes_atomic,
            project_exists,
            read_backup_bytes,
            remove_project,
            write_image_bytes_atomic,
            image_exists,
            read_journal_bytes,
            append_journal_bytes,
            replace_journal_bytes,
            remove_journal,
            read_recent_projects,
            write_recent_projects,
            credential_save,
            credential_get,
            credential_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running");
}
`;

async function tree(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "voxel-native-"));
  const tauri = join(root, "apps/desktop/src-tauri");
  await mkdir(join(tauri, "capabilities"), { recursive: true });
  await mkdir(join(tauri, "src"), { recursive: true });
  await mkdir(join(root, "apps/desktop/src"), { recursive: true });
  await mkdir(join(root, "packages/shared/src"), { recursive: true });
  await writeFile(
    join(tauri, "capabilities/default.json"),
    JSON.stringify(overrides.capabilities ?? VALID_CAPABILITIES),
  );
  await writeFile(
    join(tauri, "tauri.conf.json"),
    JSON.stringify(overrides.config ?? VALID_CONFIG),
  );
  await writeFile(join(tauri, "Cargo.toml"), overrides.cargo ?? VALID_CARGO);
  await writeFile(join(tauri, "src/lib.rs"), overrides.rust ?? VALID_RUST);
  await writeFile(
    join(root, "packages/shared/src/index.ts"),
    overrides.source ?? "export const value = 1;\n",
  );
  await writeFile(
    join(root, "apps/desktop/src/App.tsx"),
    overrides.desktopSource ?? "export function App() { return null; }\n",
  );
  return root;
}

test("a minimal allowlist tree passes the gate", async () => {
  const root = await tree();
  assert.deepEqual(await inspectNativeCapabilities(root), []);
});

test("a widened capability permission fails the gate", async () => {
  const root = await tree({
    capabilities: {
      ...VALID_CAPABILITIES,
      permissions: ["core:default", "shell:allow-execute"],
    },
  });
  const problems = await inspectNativeCapabilities(root);
  assert.ok(
    problems.some((problem) => problem.includes("shell:allow-execute")),
  );
  assert.ok(problems.some((problem) => problem.includes("forbidden prefix")));
});

test("a second capability file is audited too (Tauri merges all files)", async () => {
  const root = await tree();
  await writeFile(
    join(root, "apps/desktop/src-tauri/capabilities/extra.json"),
    JSON.stringify({
      identifier: "extra",
      description: "extra",
      permissions: ["shell:allow-open"],
    }),
  );
  const problems = await inspectNativeCapabilities(root);
  assert.ok(problems.some((problem) => problem.includes("shell:allow-open")));
});

test("a filesystem permission fails the gate", async () => {
  const root = await tree({
    capabilities: {
      ...VALID_CAPABILITIES,
      permissions: ["core:default", "fs:allow-read-text-file"],
    },
  });
  const problems = await inspectNativeCapabilities(root);
  assert.ok(
    problems.some((problem) => problem.includes("fs:allow-read-text-file")),
  );
});

test("a CSP with unsafe-eval fails the gate", async () => {
  const root = await tree({
    config: {
      app: {
        windows: [{ label: "main" }],
        security: {
          csp: "default-src 'self'; script-src 'self' 'unsafe-eval'; object-src 'none'; frame-ancestors 'none'",
        },
      },
    },
  });
  const problems = await inspectNativeCapabilities(root);
  assert.ok(problems.some((problem) => problem.includes("unsafe-eval")));
});

test("a remote window URL fails the gate", async () => {
  const root = await tree({
    config: {
      app: {
        windows: [{ label: "main", url: "https://evil.example.com" }],
        security: { csp: VALID_CONFIG.app.security.csp },
      },
    },
  });
  const problems = await inspectNativeCapabilities(root);
  assert.ok(problems.some((problem) => problem.includes("remote content")));
});

test("a forbidden Rust crate dependency fails the gate", async () => {
  const root = await tree({
    cargo: `${VALID_CARGO}\ntauri-plugin-shell = "2"\n`,
  });
  const problems = await inspectNativeCapabilities(root);
  assert.ok(problems.some((problem) => problem.includes("tauri-plugin-shell")));
});

test("an undeclared Rust command fails the gate", async () => {
  const root = await tree({
    rust: VALID_RUST.replace(
      "credential_delete",
      "credential_delete, read_arbitrary_file",
    ),
  });
  const problems = await inspectNativeCapabilities(root);
  assert.ok(
    problems.some((problem) => problem.includes("read_arbitrary_file")),
  );
});

test("eval and child_process in product source fail the gate", async () => {
  const root = await tree({
    desktopSource: "export function App() { eval(code); return null; }\n",
  });
  const problems = await inspectNativeCapabilities(root);
  assert.ok(problems.some((problem) => problem.includes("eval")));
});

test("test files may use child_process for the harness without failing", async () => {
  const root = await tree();
  await writeFile(
    join(root, "packages/shared/src/index.test.ts"),
    'import { execFileSync } from "node:child_process";\nexport {};\n',
  );
  assert.deepEqual(await inspectNativeCapabilities(root), []);
});
