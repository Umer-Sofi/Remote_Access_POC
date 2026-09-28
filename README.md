# Remote Access POC

An operator in a web browser views and controls a macOS or Windows workstation, with the
user's consent, while the session is recorded on the server and every event is audited.

```
operator browser ──REST──▶ broker ◀──WSS (outbound)── endpoint client (mac / win)
       ▲                     │ creates recorded rooms, mints tokens, audits
       └──── WebRTC ──── LiveKit SFU + TURN ──── WebRTC ────┘
                             └── Egress → recordings/*.webm
```

Full spec: [remote-access-poc.md](remote-access-poc.md) · Shared endpoint contract:
[shared/PROTOCOL.md](shared/PROTOCOL.md) · File-by-file guide: [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md)

## Quickstart (laptop)

Needs Docker and Node 20+.

```bash
scripts/dev-env.sh                 # writes .env with random secrets
docker compose up -d --build       # postgres, redis, livekit, egress, broker (+ console)
open http://localhost:8080         # log in as alice / alice-pass (OPERATORS in .env)
```

No native client yet? Use the simulated target:

```bash
cd broker && npm install
npm run fake-endpoint -- --target fake-1      # appears in the console's target list
npm run e2e -- --target fake-1                # automated end-to-end check (20 assertions)
```

The **SFU smoke test** tab in the console (two browser tabs, one shares its screen) is milestone M1.

## macOS endpoint

Needs the Xcode Command Line Tools (full Xcode is only needed for notarisation).

```bash
cd endpoint-mac
swift build && .build/debug/RemoteAccessEndpoint --self-test
.build/debug/RemoteAccessEndpoint --broker ws://localhost:8080/ws/endpoint \
    --secret "$(grep ENDPOINT_SECRET ../.env | cut -d= -f2)" --target mac-1
```

For demos, build a signed app so the Screen Recording and Accessibility grants survive rebuilds:

```bash
SIGN_IDENTITY="Developer ID Application: … (TEAMID)" \
BROKER=wss://broker.example.com/ws/endpoint SECRET=… scripts/build-app.sh
```

On first launch, grant **Screen Recording** and **Accessibility** in System Settings →
Privacy & Security, then relaunch the app. The client explains what's missing if a grant isn't there.

## Windows endpoint

On Windows with the Rust MSVC toolchain:

```powershell
cd endpoint-win
cargo test                 # shared contract vectors
cargo build --release
target\release\remote-access-endpoint.exe --broker ws://<server>:8080/ws/endpoint --secret <ENDPOINT_SECRET>
```

For a target on your LAN, set `LIVEKIT_NODE_IP` in `.env` to the server machine's LAN IP and
`LIVEKIT_PUBLIC_URL=ws://<that-ip>:7880`, then run `docker compose up -d`.

> ⚠ **Known gap:** the Windows session banner (`SessionIndicator` in `endpoint-win/src/main.rs`)
> has no implementation yet. Until one is added the client **declines every session** and
> reports `session_banner_unavailable`, so there is never an unindicated session. The Windows
> client has also **not been compiled yet**; expect a round of compile fixes on first build.

## Production (Linux VM, TURN over TCP 443)

1. DNS: `broker.`, `livekit.` and `turn.<your-domain>` → VM public IP. Open TCP 80/443, 7881 and UDP 7882.
2. Replace `example.com` in `infra/prod/livekit.yaml` and `infra/prod/caddy.yaml`.
3. In `.env`, set `LIVEKIT_PUBLIC_URL=wss://livekit.<your-domain>`.
4. `docker compose -f docker-compose.prod.yml up -d --build`

Caddy owns :443 and splits it by TLS server name, so signalling, the broker and the TURN relay
all work on a network where only TCP 443 is open. Endpoints then use
`--broker wss://broker.<your-domain>/ws/endpoint`.

## M6 validation (legibility + latency)

1. Block everything except TCP 443 on the operator's machine (or the target's).
2. The session stats bar should show `route relay/tls` (media through TURN over 443).
3. **Legibility:** open a document with 10 and 11 pt text on the target and read it in the
   viewer at 100 % zoom. Record the resolution, fps and kbps from the stats bar and compare
   against the agreed threshold.
4. **Latency:** film the operator screen and the target screen together at 240 fps, click, and
   count frames between the click and the target reacting. The RTT in the stats bar is the
   network share of that.
5. **TURN bandwidth:** read kbps per session from the stats bar to size production.

## Milestone status

| # | Status |
|---|---|
| M1 Server up | ✅ verified: stack runs; SFU smoke-test page |
| M2 Native capture | ⚠ macOS built + self-test passes, not yet run live · Windows written, not compiled |
| M3 Remote control | ✅ server path verified (e2e) · ⚠ native injection untested on real hardware |
| M4 Governance | ✅ consent gate, deny path, re-consent, audit trail verified · macOS banner built · ⚠ Windows banner missing (fails safe) |
| M5 Recording | ✅ verified: auto track egress to .webm, linked via `sessions.recording_url` |
| M6 Validation | ⏳ needs the VM + a restricted network (procedure above) |

## Where things are

| Path | What |
|---|---|
| `docker-compose.yml` / `docker-compose.prod.yml` | dev stack / production stack (host networking, Caddy on 443) |
| `infra/` | LiveKit config, audit schema, production Caddy config |
| `broker/` | session broker (Node + TypeScript), plus `tools/` fake endpoint and e2e test |
| `console/` | operator web app (React + TypeScript, Vite) |
| `shared/` | endpoint contract, key map, test vectors, code generator |
| `endpoint-mac/` | macOS client (Swift, ScreenCaptureKit, CGEvent) |
| `endpoint-win/` | Windows client (Rust, WGC/DXGI, SendInput) |
