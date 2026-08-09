# Voxel Maker 0.1.0 — Initial Release

**Status:** v1 (issue #46, plan Stage 17 / Milestone M5)
**App version:** 0.1.0 · **Container/format:** vxl container v1, document v1
**Release date:** recorded in `release/artifacts/0.1.0/manifest.json`

This is the supportable initial desktop release of the AI-native generic
voxel editor. It is the release-qualification and packaging ticket: every
manual and AI workflow ships with deterministic headless evidence, the
full gate suite is green, and the cross-platform packaging is either
executed (macOS, this machine) or reduced to mechanical steps with
scripts and templates (Windows, Linux — see
[clean-machine qualification](./clean-machine-qualification-v1.md)).

## What ships

- **Desktop app** — Tauri 2 shell (Rust + WebView2 / WKWebView /
  WebKitGTK) with the editor: create, open, save, save-as, close,
  undo/redo, voxel/region/stroke tools, materials, node hierarchy and
  inspector, transform gizmo, rigging (pivots, joints, constraints),
  animation (clips, tracks, keyframes, timeline), keyboard and
  accessibility workflows, and the consent-gated AI panel.
- **Headless CLIs** — `voxel-maker-headless` (edit demo),
  `voxel-maker-persistence` (save/reload), `voxel-maker-recovery`
  (crash recovery), `voxel-maker-smoke` (release smoke; this is the
  clean-machine qualification probe).
- **Release artifact set** — installers per platform plus the headless
  CLIs, with SHA-256 checksums and a machine-readable manifest, in
  `release/artifacts/<version>/` (see below).

## Release artifacts and checksums

`pnpm release:package` builds the desktop bundle for the current
platform, collects every installer, adds the headless CLIs, writes
`SHASUMS256.txt` (SHA-256 over the exact artifact bytes) and
`manifest.json` (version, platform, arch, git commit, built-at,
artifact list, bundle status) into `release/artifacts/<version>/`.

Verify an artifact set with:

```sh
pnpm release:verify-checksums
```

or manually:

```sh
shasum -a 256 <artifact>        # macOS/Linux
certutil -hashfile <file> SHA256 # Windows
```

Every release note links the manifest and checksum file. Never install
an artifact whose checksum does not match the published manifest.

## Installation

- **macOS:** mount the DMG, drag Voxel Maker into Applications. First
  launch: the app is currently ad-hoc signed (see
  [signing and notarization](./signing-notarization-v1.md)); Gatekeeper
  may require right-click → Open on first launch until notarization is
  configured.
- **Windows:** run the MSI/NSIS installer; WebView2 Evergreen runtime is
  required (Windows 10 22H2+ ships it).
- **Linux:** install the `.deb`/`.rpm`/AppImage; WebKitGTK 4.1 with
  hardware WebGL 2 is required (Ubuntu 22.04 LTS supported baseline).

## Supported platforms and performance

See the [support matrix](./support-matrix-v1.md) (ADR-0008) and
[performance.md](../performance.md) + `benchmarks/` for the named-tier
gates (reference M1/16 GiB and low i5-8250U/8 GiB tiers, 100k/500k/1M
fixtures).

## Privacy and security

- No telemetry in v1; diagnostics are local and locally previewable.
- Cloud model use is explicit and consent-gated; nothing is transmitted
  until the user confirms provider, model, and data categories.
- Credentials live only in the OS keychain.
- See the [user-facing privacy disclosure](./privacy-disclosure-v1.md),
  the [privacy and diagnostics policy](../security/privacy-and-diagnostics-v1.md),
  and the [threat model](../security/threat-model-v1.md).

## Backup and recovery

- Every confirmed save is atomic (temp + fsync + rename) and keeps a
  last-known-good backup of the previous project file.
- Every project has an adjacent bounded recovery journal; after a crash,
  the app offers recovery by replaying journaled transactions.
- Guidance: [backup and recovery](./backup-and-recovery-v1.md).

## Format compatibility

- `.vxl` (native container v1, document v1) is the canonical format and
  is versioned/migratable.
- MagicaVoxel `.vox` import and export ship with a structured loss
  report; glTF 2.0 / GLB export ships (import is deferred).
- Details and loss semantics: [format compatibility](./format-compatibility-v1.md)
  and [`docs/format/`](../format/).

## Known limitations

The release is scoped; the honest list lives in
[known limitations](./known-limitations-v1.md). Notable: no updater in
v1 (manual installs with checksum verification), no glTF import, `.vox`
subset with loss reporting, AI requires an OpenAI API key with explicit
per-run consent, no telemetry/diagnostics upload.

## Support procedures

Crash handling, diagnostics export, and the support playbook:
[support procedures](./support-procedures-v1.md).

## Gate evidence

Every mandatory gate (PR, scheduled, migration, recovery, accessibility,
privacy, threat, performance, AI promotion) and its evidence or approved
exception: [release gates](./gates-v1.md). Genericity demonstrations:
[genericity](./genericity-v1.md).
