#!/usr/bin/env bash
# Internet test mode: broker + DB on this Mac, LiveKit Cloud for media, and a
# Cloudflare quick tunnel so a target anywhere on the internet can reach the broker.
#
#   scripts/cloud-up.sh          start (first run creates .env.cloud and stops)
#   scripts/cloud-up.sh down     stop tunnel + stack
#
# Needs: Docker, `brew install cloudflared`, a LiveKit Cloud project (free tier).
set -euo pipefail
cd "$(dirname "$0")/.."

ENV=.env.cloud
COMPOSE=(docker compose -p remote-access-cloud -f docker-compose.cloud.yml --env-file "$ENV")
PIDFILE=transfer/tunnel.pid
LOG=transfer/tunnel.log
mkdir -p transfer

if [[ "${1:-}" == "down" ]]; then
  [[ -f $PIDFILE ]] && kill "$(cat $PIDFILE)" 2>/dev/null && echo "tunnel stopped"
  rm -f $PIDFILE
  "${COMPOSE[@]}" down
  exit 0
fi

# 1. Config. The broker is reachable from the internet in this mode, so every
#    secret, including the operator password, is random.
if [[ ! -f $ENV ]]; then
  rnd() { openssl rand -hex "$1"; }
  sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rnd 16)|" \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=$(rnd 32)|" \
      -e "s|^ENDPOINT_SECRET=.*|ENDPOINT_SECRET=$(rnd 16)|" \
      -e "s|^OPERATORS=.*|OPERATORS=alice:$(rnd 8)|" \
      .env.cloud.example > $ENV
  echo "Created $ENV. Now fill in LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET"
  echo "(cloud.livekit.io → your project → Settings → Keys), then run this script again."
  exit 1
fi
get() { grep "^$1=" $ENV | cut -d= -f2-; }
if [[ -z "$(get LIVEKIT_API_KEY)" || -z "$(get LIVEKIT_API_SECRET)" || "$(get LIVEKIT_URL)" == *your-project* ]]; then
  echo "Fill in LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in $ENV first."; exit 1
fi
# Tunnel choice: ngrok (fixed address) when NGROK_DOMAIN is set in .env.cloud,
# otherwise a Cloudflare quick tunnel (random address each start).
NGROK_DOMAIN=$(get NGROK_DOMAIN || true)
if [[ -n "$NGROK_DOMAIN" ]]; then
  command -v ngrok >/dev/null || { echo "Install ngrok first:  brew install ngrok"; exit 1; }
  ngrok config check >/dev/null 2>&1 || { echo "Add your ngrok token:  ngrok config add-authtoken <token>"; exit 1; }
else
  command -v cloudflared >/dev/null || { echo "Install cloudflared first:  brew install cloudflared"; exit 1; }
fi

# 2. Stack.
"${COMPOSE[@]}" up -d --build
for i in $(seq 1 60); do curl -sf http://localhost:8081/healthz >/dev/null && break; sleep 2; done
curl -sf http://localhost:8081/healthz >/dev/null || { echo "broker not healthy; see: ${COMPOSE[*]} logs broker"; exit 1; }

# 3. Tunnel (outbound only; reuses a running one).
if [[ -f $PIDFILE ]] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
  echo "tunnel already running"
else
  : > $LOG
  if [[ -n "$NGROK_DOMAIN" ]]; then
    nohup ngrok http 8081 --url "https://$NGROK_DOMAIN" --log stdout >> $LOG 2>&1 &
  else
    nohup cloudflared tunnel --no-autoupdate --url http://localhost:8081 >> $LOG 2>&1 &
  fi
  echo $! > $PIDFILE
fi
if [[ -n "$NGROK_DOMAIN" ]]; then
  URL="https://$NGROK_DOMAIN"
else
  URL=""
  for i in $(seq 1 30); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' $LOG | head -1 || true)
    [[ -n "$URL" ]] && break; sleep 1
  done
  [[ -n "$URL" ]] || { echo "no tunnel URL; see $LOG"; exit 1; }
fi
for i in $(seq 1 30); do curl -sf "$URL/healthz" >/dev/null && break; sleep 2; done
curl -sf "$URL/healthz" >/dev/null || { echo "tunnel URL not answering yet: $URL (see $LOG; re-run in a minute)"; exit 1; }
HOST=${URL#https://}

# 4. macOS client with this tunnel's address baked in. Rebuilt ONLY when the
#    address changed. The app is ad-hoc signed, so a needless rebuild would make
#    macOS see a "new app" and drop the target's Screen Recording / Accessibility
#    grants. With a fixed ngrok address, restarts therefore keep the same app.
SECRET=$(get ENDPOINT_SECRET) # read before cd: get() uses a relative path
ZIP=transfer/RemoteAccessEndpoint-cloud.app.zip
WANT="wss://$HOST/ws/endpoint"
HAVE=$(unzip -p "$ZIP" RemoteAccessEndpoint.app/Contents/Resources/endpoint.json 2>/dev/null \
       | grep -oE 'wss://[^/"]+/ws/endpoint' || true)
if [[ "$HAVE" == "$WANT" ]]; then
  APP_NOTE="unchanged (same address) — targets keep their current app and permissions"
else
  (cd endpoint-mac && BROKER="$WANT" SECRET="$SECRET" scripts/build-app.sh | grep -E "^built")
  rm -f "$ZIP"
  ditto -c -k --keepParent endpoint-mac/build/RemoteAccessEndpoint.app "$ZIP"
  APP_NOTE="NEW build for $HOST — send it; targets redo the one-time permission setup"
fi

cat <<EOF

================================================================
 Internet test mode is up
----------------------------------------------------------------
 Operator console:  http://localhost:8081    (or $URL)
 Login:             $(get OPERATORS | cut -d, -f1 | sed 's/:/ \/ /')

 Target app:  transfer/RemoteAccessEndpoint-cloud.app.zip
              $APP_NOTE

 LiveKit Cloud webhook (optional, gives SFU-observed audit events):
   cloud.livekit.io → Settings → Webhooks → add
   $URL/livekit/webhook   (signing key: $(get LIVEKIT_API_KEY))

 Tunnel: $([[ -n "$NGROK_DOMAIN" ]] && echo "ngrok, FIXED address — safe to restart, no new app needed" || echo "Cloudflare, address CHANGES on restart — new app needed each time")
 Stop everything:   scripts/cloud-up.sh down
================================================================
EOF
