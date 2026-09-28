# Built from the repo root (docker-compose sets context: .) so it can include the console.
# Debian (glibc) base, not Alpine: @livekit/rtc-node ships prebuilt linux-*-gnu binaries.

# 1. Operator console → static files
FROM node:20-bookworm-slim AS console
WORKDIR /app/console
COPY console/package*.json ./
RUN npm ci
COPY console/ ./
RUN npm run build

# 2. Broker → dist/
FROM node:20-bookworm-slim AS broker
WORKDIR /app/broker
COPY broker/package*.json ./
RUN npm ci
COPY broker/tsconfig.json ./
COPY broker/src ./src
RUN npm run build && npm prune --omit=dev

# 3. Runtime
FROM node:20-bookworm-slim
# CA roots: rtc-node (the audit tap) verifies TLS against the OS store when it
# connects to a wss:// LiveKit (LiveKit Cloud, or production behind Caddy).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app/broker
COPY --from=broker /app/broker/package.json ./
COPY --from=broker /app/broker/node_modules ./node_modules
COPY --from=broker /app/broker/dist ./dist
COPY --from=console /app/console/dist /app/console/dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
