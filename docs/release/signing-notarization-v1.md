# Signing, notarization, updater, and rollback v1

**Status:** v1 (issue #46, plan S17.10, threat-model row 14)
**App version:** 0.1.0

## Code signing and notarization

The v1 release ships **ad-hoc/unsigned** artifacts on this machine.
Signing is a mechanical pre-publish step owned by the maintainer; the
exact procedure is below.

### macOS (Developer ID + notarization)

The packaging automation signs in the correct order: `pnpm release:package`
signs the freshly built `.app` bundle first and then rebuilds the DMG from
the signed bundle (headless-safe `--skip-jenkins`), so the DMG embeds the
signed app and the published checksums cover signed bytes end to end.

1. Obtain an Apple Developer ID Application certificate and install it
   into the keychain (`security import`).
2. Build and sign: `APPLE_SIGNING_IDENTITY="Developer ID Application: <Team> (TEAMID)" pnpm release:package`.
3. Notarize and staple (interactive keychain profile), then refresh the
   published copies and checksums — exactly one command:

   ```sh
   APPLE_SIGNING_IDENTITY="Developer ID Application: <Team> (TEAMID)" \
   APPLE_NOTARY_KEYCHAIN_PROFILE="voxel-maker-notary" \
   scripts/release-sign-macos.sh
   ```

   The script signs the bundle, rebuilds the DMG, submits to
   `notarytool --wait`, staples, re-zips the app, refreshes
   `release/artifacts/<version>/` and regenerates `SHASUMS256.txt` —
   without rebuilding, so the notarized bytes are exactly what is
   published.

4. Verify: `pnpm release:verify-checksums`.

The CI workflow carries `APPLE_SIGNING_IDENTITY`,
`APPLE_NOTARY_KEYCHAIN_PROFILE`, `APPLE_ID`, `APPLE_PASSWORD`, and
`APPLE_TEAM_ID` secrets for the tag/nightly runs (see
`.github/workflows/release.yml`).

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
