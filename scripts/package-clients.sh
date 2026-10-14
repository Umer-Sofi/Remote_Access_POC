#!/usr/bin/env bash
# Builds the macOS endpoint with this server's address and secret baked in, and drops the
# zip where the broker serves it from the console's "Download client" page.
#
#   scripts/package-clients.sh                       # broker = ws://<this Mac's LAN IP>:8080/ws/endpoint
#   BROKER=wss://broker.example.com/ws/endpoint scripts/package-clients.sh
#   SIGN_IDENTITY="Developer ID Application: … (TEAMID)" scripts/package-clients.sh
#
# The zip contains ENDPOINT_SECRET: clients/ is git-ignored and the broker only serves it to
# logged-in operators. Re-run after rotating the secret or changing the broker address.
#
# Windows: on a Windows machine run endpoint-win\scripts\build-exe.ps1 with the same -Broker and
# -Secret, then copy dist\remote-access-endpoint-win.zip to clients/ on the server.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "no .env; run scripts/dev-env.sh first"; exit 1; }
SECRET=$(grep -E '^ENDPOINT_SECRET=' .env | cut -d= -f2-)
[[ -n "$SECRET" ]] || { echo "ENDPOINT_SECRET is empty in .env"; exit 1; }

if [[ -z "${BROKER:-}" ]]; then
  IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
  [[ -n "$IP" ]] || { echo "could not find a LAN IP; set BROKER=ws://host:8080/ws/endpoint"; exit 1; }
  BROKER="ws://$IP:8080/ws/endpoint"
fi
echo "baking in broker: $BROKER"

(cd endpoint-mac && BROKER="$BROKER" SECRET="$SECRET" scripts/build-app.sh)

mkdir -p clients
rm -f clients/RemoteAccessEndpoint-mac.zip
# ditto keeps the bundle's symlinks and code signature intact; plain `zip` can break them.
ditto -c -k --keepParent endpoint-mac/build/RemoteAccessEndpoint.app clients/RemoteAccessEndpoint-mac.zip
echo "wrote clients/RemoteAccessEndpoint-mac.zip"
