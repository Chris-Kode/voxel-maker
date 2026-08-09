# Voxel Maker — Release

This is the repository for the AI-native generic voxel editor. The
initial release (v0.1.0, issue #46, milestone M5) is documented in:

- **[Release overview](./docs/release/release-v1.md)** — what ships,
  artifacts, checksums, installation, links to every other release doc.
- **[Support matrix](./docs/release/support-matrix-v1.md)** — platforms,
  hardware tiers, feature parity.
- **[Known limitations](./docs/release/known-limitations-v1.md)** —
  honest scope of the initial release.
- **[Format compatibility](./docs/release/format-compatibility-v1.md)** —
  `.vxl` / `.vox` / glTF semantics and loss reporting.
- **[Backup and recovery](./docs/release/backup-and-recovery-v1.md)** —
  user guidance.
- **[Privacy disclosure](./docs/release/privacy-disclosure-v1.md)** —
  user-facing privacy terms.
- **[Signing, updater, rollback](./docs/release/signing-notarization-v1.md)**.
- **[Crash handling and support procedures](./docs/release/support-procedures-v1.md)**.
- **[Clean-machine qualification](./docs/release/clean-machine-qualification-v1.md)**
  — per-platform evidence ledger and the mechanical remaining steps.
- **[Release gates](./docs/release/gates-v1.md)** — every mandatory gate
  with evidence or an approved exception.
- **[Genericity demonstrations](./docs/release/genericity-v1.md)** — the
  nine definition-of-done demonstrations above a category-free engine.

## Release commands

```sh
pnpm release:smoke           # headless clean-machine journey (part of pnpm check)
pnpm release:package         # build + bundle current platform + checksums + manifest
pnpm release:checksums       # (re)write SHASUMS256.txt for release/artifacts/<version>
pnpm release:verify-checksums # verify an artifact set
pnpm check:genericity        # engine category-free + nine demonstrations (part of pnpm check)
```
