#!/bin/bash
# Release bundle for macOS (universal: arm64 + x64), used by .github/workflows/release.yml.
# Produces in release-assets/:
#   Sinawi_<v>_universal.dmg              first install (drag to Applications)
#   Sinawi_<v>_universal.app.tar.gz(.sig) in-app updater payload + minisign signature
#
# Two signing modes:
#   - Developer ID (APPLE_SIGNING_IDENTITY + APPLE_CERTIFICATE[_PASSWORD] set, optionally APPLE_ID/
#     APPLE_PASSWORD/APPLE_TEAM_ID or APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH for
#     notarization): Tauri signs, notarizes and packs everything itself.
#   - Ad-hoc (no Apple secrets): the .app is re-signed with scripts/sign-app.sh so its designated
#     requirement is the stable "identifier dev.sinawi.app" (keeps macOS privacy grants across
#     updates), then the updater tarball is rebuilt and re-signed from that copy.
# Requires TAURI_SIGNING_PRIVATE_KEY (+ TAURI_SIGNING_PRIVATE_KEY_PASSWORD) in the environment.
# A local build also reads APPLE_* from ~/.config/sinawi/release.env (or $SINAWI_RELEASE_ENV) when
# that file exists; values already in the environment win. CI has no such file.
set -euo pipefail
cd "$(dirname "$0")/.."

RELEASE_ENV="${SINAWI_RELEASE_ENV:-$HOME/.config/sinawi/release.env}"
if [ -f "$RELEASE_ENV" ]; then
  while IFS='=' read -r var _; do
    if [[ "$var" =~ ^APPLE_[A-Z_]+$ ]] && [ -z "${!var:-}" ]; then
      eval "export $(grep -E "^$var=" "$RELEASE_ENV" | tail -1)"
    fi
  done < <(grep -E '^APPLE_[A-Z_]+=' "$RELEASE_ENV")
fi

TARGET="universal-apple-darwin"
VERSION="$(node -p "require('./package.json').version")"
OUT="release-assets"
BUNDLE="src-tauri/target/$TARGET/release/bundle"
NAME="Sinawi_${VERSION}_universal"

: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY is required to sign updater artifacts}"
# GitHub passes unset secrets as empty strings; Tauri treats a set-but-empty APPLE_* as configured.
for var in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD \
           APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
  if [ -z "${!var:-}" ]; then unset "$var"; fi
done

rm -rf "$OUT"
mkdir -p "$OUT"

if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "bundle: Developer ID mode ($APPLE_SIGNING_IDENTITY)"
  npx tauri build --ci --target "$TARGET" --bundles app,dmg
  cp "$BUNDLE/macos/Sinawi.app.tar.gz" "$OUT/$NAME.app.tar.gz"
  cp "$BUNDLE/macos/Sinawi.app.tar.gz.sig" "$OUT/$NAME.app.tar.gz.sig"
  cp "$BUNDLE"/dmg/*.dmg "$OUT/$NAME.dmg"
else
  echo "bundle: ad-hoc mode (no Apple Developer ID; Gatekeeper will warn on first install)"
  npx tauri build --ci --target "$TARGET" --bundles app
  APP="$BUNDLE/macos/Sinawi.app"
  bash scripts/sign-app.sh "$APP"
  # Tarball layout matches tauri-bundler's: the .app at the archive root.
  COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$OUT/$NAME.app.tar.gz" -C "$BUNDLE/macos" Sinawi.app
  npx tauri signer sign --app-version "$VERSION" "$OUT/$NAME.app.tar.gz"
  STAGE="$(mktemp -d)"
  ditto "$APP" "$STAGE/Sinawi.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "Sinawi" -srcfolder "$STAGE" -ov -format UDZO "$OUT/$NAME.dmg"
  rm -rf "$STAGE"
fi

test -s "$OUT/$NAME.app.tar.gz.sig" || { echo "bundle: missing updater signature" >&2; exit 1; }
ls -l "$OUT"
