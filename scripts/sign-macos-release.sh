#!/usr/bin/env bash
set -euo pipefail
for name in MACOS_CERTIFICATE_BASE64 MACOS_CERTIFICATE_PASSWORD MACOS_SIGNING_IDENTITY; do
  test -n "${!name:-}" || { echo "Missing macOS release secret: $name" >&2; exit 1; }
done
if [[ "$MACOS_SIGNING_IDENTITY" != 'Developer ID Application: '* ]]; then
  echo 'macOS public releases require a Developer ID Application certificate.' >&2
  exit 1
fi
if [ -n "${MACOS_API_KEY_BASE64:-}" ] && [ -n "${MACOS_API_KEY_ID:-}" ] && [ -n "${MACOS_API_ISSUER:-}" ]; then
  notarize_api=true
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  notarize_api=false
else
  echo 'Configure App Store Connect API key or Apple ID notarization secrets.' >&2
  exit 1
fi
signing_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/jobloop-signing.XXXXXX")"
keychain_path="$signing_dir/signing.keychain-db"
keychain_password="$(uuidgen)"
original_keychains=()
while IFS= read -r existing; do
  existing="${existing#*\"}"; existing="${existing%\"*}"
  test -z "$existing" || original_keychains+=("$existing")
done < <(security list-keychains -d user)
cleanup() {
  if [ "${#original_keychains[@]}" -gt 0 ]; then security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true; fi
  security delete-keychain "$keychain_path" >/dev/null 2>&1 || true
  rm -rf "$signing_dir"
}
trap cleanup EXIT
printf '%s' "$MACOS_CERTIFICATE_BASE64" | base64 -D > "$signing_dir/certificate.p12"
chmod 600 "$signing_dir/certificate.p12"
security create-keychain -p "$keychain_password" "$keychain_path"
security set-keychain-settings -lut 21600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
security list-keychains -d user -s "${original_keychains[@]}" "$keychain_path"
security import "$signing_dir/certificate.p12" -P "$MACOS_CERTIFICATE_PASSWORD" -t cert -f pkcs12 -k "$keychain_path" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain_path" >/dev/null
security find-identity -v -p codesigning "$keychain_path" | grep -Fq -- "$MACOS_SIGNING_IDENTITY"
export CSC_NAME="${MACOS_SIGNING_IDENTITY#Developer ID Application: }"
export CSC_KEYCHAIN="$keychain_path"
export CSC_IDENTITY_AUTO_DISCOVERY=true
export JOBLOOP_SIGNING_IDENTITY="$MACOS_SIGNING_IDENTITY"
if [ "$notarize_api" = true ]; then
  export APPLE_API_KEY="$signing_dir/AuthKey_${MACOS_API_KEY_ID}.p8"
  printf '%s' "$MACOS_API_KEY_BASE64" | base64 -D > "$APPLE_API_KEY"
  chmod 600 "$APPLE_API_KEY"
  export APPLE_API_KEY_ID="$MACOS_API_KEY_ID" APPLE_API_ISSUER="$MACOS_API_ISSUER"
fi
node scripts/package.mjs
codesign --verify --deep --strict --verbose=2 'release/mac-universal/AutoJev.app'
codesign -dvv 'release/mac-universal/AutoJev.app' 2>&1 | grep -q 'Authority=Developer ID Application'
xcrun stapler validate 'release/mac-universal/AutoJev.app'
spctl --assess --type execute --verbose 'release/mac-universal/AutoJev.app'
