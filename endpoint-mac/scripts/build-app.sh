#!/usr/bin/env bash
# Builds, bundles and signs RemoteAccessEndpoint.app.
#
# Why a signed .app and not the bare binary: macOS TCC binds the Screen Recording
# and Accessibility grants to the app's code signature. An unsigned (or ad-hoc
# signed) build looks like a NEW app after every rebuild and the grants reset
# (spec §6, §13). Sign with your Apple Developer ID:
#
#   SIGN_IDENTITY="Developer ID Application: Example Corp (TEAMID)" \
#   BROKER=wss://broker.example.com/ws/endpoint SECRET=... \
#   scripts/build-app.sh
#
# Without SIGN_IDENTITY the app is ad-hoc signed: fine for a first local try,
# but grants will need re-approving after each rebuild.
# BROKER / SECRET / TARGET (optional) are baked into Resources/endpoint.json so the
# downloaded app needs no command-line arguments.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=build/RemoteAccessEndpoint.app
BUNDLE_ID=${BUNDLE_ID:-com.example.remoteaccess.endpoint}
IDENTITY=${SIGN_IDENTITY:--}

swift build -c release
BIN=$(swift build -c release --show-bin-path)

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks" "$APP/Contents/Resources"
cp "$BIN/RemoteAccessEndpoint" "$APP/Contents/MacOS/"
# WebRTC and LiveKit's Rust core are dynamic frameworks: embed them.
for fw in LiveKitWebRTC RustLiveKitUniFFI; do
  cp -R "$BIN/$fw.framework" "$APP/Contents/Frameworks/"
done
install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/RemoteAccessEndpoint" 2>/dev/null || true

sed "s/__BUNDLE_ID__/$BUNDLE_ID/" Resources/Info.plist > "$APP/Contents/Info.plist"

if [[ -n "${BROKER:-}" && -n "${SECRET:-}" ]]; then
  printf '{ "broker": "%s", "secret": "%s"%s }\n' "$BROKER" "$SECRET" "${TARGET:+, \"target\": \"$TARGET\"}" \
    > "$APP/Contents/Resources/endpoint.json"
fi

# Sign inside-out: frameworks first (re-signed with OUR identity so hardened-runtime
# library validation accepts them), then the app.
SIGN_ARGS=(--force --sign "$IDENTITY")
if [[ "$IDENTITY" != "-" ]]; then SIGN_ARGS+=(--options runtime --timestamp); fi
for fw in "$APP"/Contents/Frameworks/*.framework; do codesign "${SIGN_ARGS[@]}" "$fw"; done
codesign "${SIGN_ARGS[@]}" --entitlements Resources/entitlements.plist "$APP"
codesign --verify --deep --strict "$APP"

echo "built $APP (signed: $IDENTITY)"
[[ "$IDENTITY" == "-" ]] && echo "note: ad-hoc signature, so TCC grants will not survive a rebuild. Set SIGN_IDENTITY for demos."
echo "notarize for distribution: xcrun notarytool submit … && xcrun stapler staple $APP  (needs Xcode)"
