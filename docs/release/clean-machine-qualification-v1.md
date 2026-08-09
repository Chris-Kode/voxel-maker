# Clean-machine qualification v1

**Status:** v1 (issue #46, plan S17.8/S17.14, M5)
**App version:** 0.1.0

This ledger records what was executed where, and what remains as
mechanical steps. The release policy accepts an **approved exception**
pattern: a platform qualification that cannot be executed in the current
environment ships as scripts/artifacts/templates plus a precise
procedure, so the remaining work is install-and-run with a fixed
evidence checklist.

## Evidence matrix

| Step | macOS (this machine) | Windows | Linux |
|---|---|---|---|
| Headless build + full check suite (`pnpm check`, `check:security`, `check:audit`) | ✅ executed (CI + local) | ✅ CI (ubuntu runner = Linux) | ✅ CI |
| Release smoke (create/edit/rig/animate/save/recover/import/export/AI-offline) | ✅ executed | ✅ CI | ✅ CI |
| Native `tauri build` (installer produced) | ✅ executed (see below) | ✅ CI scheduled/tag workflow | ✅ CI scheduled/tag workflow |
| Checksums + manifest for the artifact set | ✅ executed | ✅ CI | ✅ CI |
| Interactive install + launch + manual edit on a clean machine | ✅ executed (local macOS) | ⏳ mechanical (run the installer; checklist below) | ⏳ mechanical (install package; checklist below) |
| Signing / notarization | ⏳ mechanical (procedure + template script) | ⏳ mechanical (procedure) | ⏳ n/a (optional) |
| Hardware-tier benchmarks (reference/low tiers) | ⏳ named tiers are external hardware; CI smoke thresholds pass | ⏳ | ⏳ |

## Executed on this machine (macOS, Apple silicon)

- `pnpm install --frozen-lockfile`
- `pnpm check` (format, lint, strict typecheck, unit/property/
  integration/conformance tests, coverage, build, boundaries,
  entrypoints, demo traces, genericity gate, release smoke) — green.
- `pnpm check:security` — green (native capabilities, licenses, secrets).
- `pnpm check:audit` — green (dependency audit).
- `pnpm bench:smoke` — green (scale/performance regression thresholds).
- `pnpm release:package` — produces the macOS artifact set (`.app`,
  `.dmg`) plus headless CLIs, `SHASUMS256.txt`, `manifest.json`.
- `pnpm release:verify-checksums` — green.

## Mechanical steps for Windows and Linux (approved exception)

### Windows (x86-64, Windows 10 22H2+)

1. From the release artifact set for `win32-x64`, verify checksums
   (`certutil -hashfile <file> SHA256` against `SHASUMS256.txt`).
2. Install the MSI or NSIS artifact; confirm WebView2 Evergreen is
   present.
3. Launch Voxel Maker; confirm the WebGL 2 compatibility check passes.
4. Run the qualification checklist (below) interactively.
5. Optional: sign with `signtool` per
   [signing and notarization](./signing-notarization-v1.md), then
   re-verify checksums.

### Linux (Ubuntu 22.04 LTS, x86-64)

1. Verify checksums (`sha256sum -c SHASUMS256.txt`).
2. Install the `.deb` (or `.rpm`/AppImage); confirm WebKitGTK 4.1 with
   hardware WebGL 2 (X11 or Wayland).
3. Launch; run the qualification checklist.
4. Record CPU model/platform/arch in the evidence row.

### Interactive qualification checklist (every platform)

- [ ] Installer installs on a clean machine (no dev toolchain).
- [ ] App launches; WebGL 2 compatibility path shows or the editor opens.
- [ ] Create a document; edit voxels (set/fill/erase); undo/redo.
- [ ] Rig a node (pivot + joint + constraint); animate a clip
  (track + keyframes) and play it.
- [ ] Save as `.vxl`; reopen; hash stable.
- [ ] Simulate a crash (force-quit after edits); reopen; recovery
  prompt appears and replays committed transactions.
- [ ] Import a `.vox` file (loss report shown when applicable).
- [ ] Export `.glb`/`.gltf` and `.vox`; files open in a viewer.
- [ ] AI: with no key configured the panel shows an unavailable state
  and manual editing keeps working; with a key, consent gates the first
  transmission.
- [ ] Offline: disconnect the network; the whole manual workflow still
  works.
- [ ] Diagnostics export produces a redacted JSON file (the smoke's
  `aiOffline.diagnostics` fields assert prompt redaction, no raw paths,
  no raw URLs, and structured error codes).

The headless probe `voxel-maker-smoke` (shipped in every artifact set)
covers the same journey deterministically on any platform:

```sh
node headless-release-smoke-cli.js   # prints the canonical JSON report
```

## Recording the evidence

For each platform row, append a dated entry to this file (or the release
notes) with: machine model, OS version, artifact checksums verified,
checklist results, and the smoke report hash. Until a row is filled,
that platform ships with the exception recorded here and the note in
[known limitations](./known-limitations-v1.md).
