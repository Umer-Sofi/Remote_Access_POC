#!/usr/bin/env bash
# Run the server on THIS Mac so other machines on the same network can use it:
# sets LIVEKIT_NODE_IP / LIVEKIT_PUBLIC_URL to this machine's LAN IP and starts
# the stack. Usage: scripts/lan-up.sh [interface]   (default en0 = Wi-Fi)
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || scripts/dev-env.sh

IP=$(ipconfig getifaddr "${1:-en0}" || true)
[[ -n "$IP" ]] || { echo "no IP on ${1:-en0}; try: scripts/lan-up.sh en1"; exit 1; }

sed -i '' -e "s|^LIVEKIT_NODE_IP=.*|LIVEKIT_NODE_IP=$IP|" \
          -e "s|^LIVEKIT_PUBLIC_URL=.*|LIVEKIT_PUBLIC_URL=ws://$IP:7880|" .env
docker compose up -d --build

for i in $(seq 1 30); do curl -sf "http://$IP:8080/healthz" >/dev/null && break; sleep 2; done
if curl -sf "http://$IP:8080/healthz" >/dev/null; then
  echo
  echo "Server is up. From the operator machine open:  http://$IP:8080"
else
  echo "Server did not answer on $IP:8080. Check: docker compose ps, and the macOS firewall"
  echo "(System Settings → Network → Firewall must allow incoming connections for Docker)."
  exit 1
fi
