# Signing, notarization, updater, and rollback v1

**Status:** v1 (issue #46, plan S17.10, threat-model row 14)
**App version:** 0.1.0

## Code signing and notarization

The v1 release ships **ad-hoc/unsigned** artifacts on this machine.
Signing is a mechanical pre-publish step owned by the maintainer; the
exact procedure is below.

### macOS (Developer ID + notarization)

1. Obtain an Apple Developer ID Application certificate and install it
   into the keychain (`security import`).
2. Build: `pnpm release:package` (runs `pnpm tauri build`).
3. Sign the app bundle and the DMG:

   ```sh
   codesign --deep --force --options runtime      --sign "Developer ID Application: <Team> (TEAMID)" \
     apps/desktop/src-tauri/target/release/bundle/macos/Voxel\ Maker.app
   codesign --verify --deep --strict \
     apps/desktop/src-tauri/target/release/bundle/macos/Voxel\ Maker.app
   ```

4. Notarize and staple:

   ```sh
   xcrun notarytool submit \
     apps/desktop/src-tauri/target/release/bundle/dmg/VoxelMaker_0.1.0_<arch>.dmg \
     --keychain-profile voxel-maker-notary --wait
   xcrun stapler staple \
     apps/desktop/src-tauri/target/release/bundle/dmg/VoxelMaker_0.1.0_<arch>.dmg
   ```

5. Re-generate checksums after signing (`pnpm release:checksums`).

A template script `scripts/release-sign-macos.sh` is provided; the CI
workflow can carry `APPLE_SIGNING_IDENTITY`, `APPLE_NOTARY_KEYCHAIN_PROFILE`
secrets and run it (see `.github/workflows/release.yml`).

### Windows (Authenticode)

1. Obtain a code-signing certificate (EV recommended) and install it in
   the machine certificate store.
2. Sign the MSI and NSIS artifacts with `signtool`:

   ```sh
   signtool sign /fd SHA256 /tr http://timestamp.digicert.com \
     /td SHA256 /a <installer.exe|.msi>
   signtool verify /pa /v <installer>
   ```

3. Re-generate checksums.

### Linux

Deb/rpm/AppImage signing is optional in v1 (packages install with the
distro's normal verification story). AppImage signing can be added with
`appimagetool --sign` when a maintainer key exists.

## Updater policy (v1: manual installs)

There is **no built-in updater** in v1 (threat-model row 14). Updates
are manual and verifiable:

1. Download the new installer from the release notes (or artifact set).
2. Verify the SHA-256 against the published `SHASUMS256.txt`
   (`pnpm release:verify-checksums` on the artifact directory, or
   `shasum -a 256`).
3. Install over the previous version. Projects and journals are
   untouched by installers (no shared-state writes).

When an updater is added (deferred), it must use signed manifests and
pinned signatures, and rollback must be re-qualified (S17.10 condition).

## Rollback

- **App:** keep the previous installer and checksum; uninstall or
  reinstall the previous version. Projects remain byte-compatible
  (format versioning).
- **Document:** every confirmed save keeps a last-known-good backup of
  the previous project file; recovery offers snapshot+journal replay.
  For extra safety before an update, save a checkpoint copy of open
  projects (Save As) — see [backup and recovery](./backup-and-recovery-v1.md).
- **Key rotation:** if a provider key is suspected compromised, delete
  it in the app (removes it from the keychain) and rotate at the
  provider; the app stores no other credentials.

## Release threat-model review

The v1 release review re-checks threat-model rows 6 (paths), 8
(credentials), 13 (logs), and 14 (updater). Findings: no updater code
ships, so row 14 is satisfied by absence plus this policy; signing is
documented as a mechanical pre-publish step; everything else is enforced
by `check:security` and the adversarial suites.
