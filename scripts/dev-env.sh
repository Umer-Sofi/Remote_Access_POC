#!/usr/bin/env bash
# Creates .env from .env.example with fresh random secrets (never overwrites).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .env ]]; then echo ".env already exists, leaving it alone"; exit 0; fi
rnd() { openssl rand -hex "$1"; }
sed -e "s|^LIVEKIT_API_SECRET=.*|LIVEKIT_API_SECRET=$(rnd 32)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rnd 16)|" \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$(rnd 32)|" \
    -e "s|^ENDPOINT_SECRET=.*|ENDPOINT_SECRET=$(rnd 16)|" \
    .env.example > .env
echo "wrote .env"
