#!/usr/bin/env bash
# Template: sign and notarize the macOS release artifacts (issue #46,
# plan S17.10). Run AFTER `pnpm release:package` on macOS and BEFORE
# publishing the artifact set.
#
# The automation in release-package.mjs already signs the .app and rebuilds
# the DMG when APPLE_SIGNING_IDENTITY is set; this template covers the
# notarization step (which needs the interactive keychain profile) and the
# manual fallback path. It signs the bundle outputs in place, then refreshes
# the published artifact copies and checksums - without rebuilding, so the
# notarized bytes are exactly what gets published.
#
# Usage:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" \
#   APPLE_NOTARY_KEYCHAIN_PROFILE="voxel-maker-notary" \
#   scripts/release-sign-macos.sh [version]
#
# The keychain profile must already exist:
#   xcrun notarytool store-credentials "voxel-maker-notary" \
#     --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
#     --password "$APPLE_PASSWORD"
set -euo pipefail

: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}"
: "${APPLE_NOTARY_KEYCHAIN_PROFILE:?set APPLE_NOTARY_KEYCHAIN_PROFILE}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-0.1.0}"
BUNDLE="$ROOT/apps/desktop/src-tauri/target/release/bundle"
ARTIFACTS="$ROOT/release/artifacts/$VERSION"
APP_BUNDLE="$BUNDLE/macos/Voxel Maker.app"
ARCH="$(uname -m | sed 's/x86_64/x64/;s/arm64/arm64/')"
DMG_NAME="Voxel Maker_${VERSION}_${ARCH}.dmg"
DMG_PATH="$BUNDLE/dmg/$DMG_NAME"
ZIP_PATH="$BUNDLE/dmg/Voxel Maker.app.zip"

[ -d "$BUNDLE/macos" ] || { echo "bundle missing; run pnpm release:package first"; exit 1; }
mkdir -p "$ARTIFACTS"

# 1. Sign the app bundle (deep) and verify.
codesign --deep --force --options runtime --sign "$APPLE_SIGNING_IDENTITY" "$APP_BUNDLE"
codesign --verify --deep --strict "$APP_BUNDLE"
echo "signed $APP_BUNDLE"

# 2. Rebuild the DMG from the signed bundle (headless-safe).
"$BUNDLE/dmg/bundle_dmg.sh" --skip-jenkins --volname "Voxel Maker" \
  "$DMG_NAME" "$BUNDLE/macos"

# 3. Notarize and staple the DMG.
xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile "$APPLE_NOTARY_KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$DMG_PATH" || true
echo "notarized $DMG_PATH"

# 4. Rebuild the zipped app artifact from the signed bundle.
ditto -c -k --sequesterRsrc --keepParent "$APP_BUNDLE" "$ZIP_PATH"

# 5. Refresh the published copies (no rebuild) and checksums.
cp -f "$DMG_PATH" "$ARTIFACTS/"
cp -f "$ZIP_PATH" "$ARTIFACTS/"
node "$ROOT/scripts/release-checksums.mjs" "$ARTIFACTS"
echo "done - verify with pnpm release:verify-checksums"
