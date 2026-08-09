#!/usr/bin/env bash
# Template: sign and notarize the macOS release artifacts (issue #46,
# plan S17.10). Run AFTER `pnpm release:package` on macOS and BEFORE
# publishing the artifact set. Signs the copied artifacts in
# release/artifacts/<version>/ in place, then regenerates checksums so
# SHASUMS256.txt covers the signed bytes.
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
ARTIFACTS="$ROOT/release/artifacts/$VERSION"

[ -d "$ARTIFACTS" ] || { echo "artifact set missing: $ARTIFACTS"; exit 1; }

# Sign .app bundles (directories).
shopt -s nullglob
for app in "$ARTIFACTS"/*.app; do
  codesign --deep --force --options runtime --sign "$APPLE_SIGNING_IDENTITY" "$app"
  codesign --verify --deep --strict "$app"
  echo "signed $app"
done

# Sign and notarize installers (dmg/pkg).
for installer in "$ARTIFACTS"/*.dmg "$ARTIFACTS"/*.pkg; do
  [ -e "$installer" ] || continue
  xcrun notarytool submit "$installer" \
    --keychain-profile "$APPLE_NOTARY_KEYCHAIN_PROFILE" --wait
  xcrun stapler staple "$installer" || true
  echo "notarized $installer"
done

# Regenerate checksums over the signed bytes.
node "$ROOT/scripts/release-checksums.mjs" "$ARTIFACTS"
echo "done — verify with pnpm release:verify-checksums"
