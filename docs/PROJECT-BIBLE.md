# Remote Access POC — Project Bible

> A single, exhaustive reference for the whole system: what it is, every folder and file,
> every technology and why it was chosen, the full data/consent/session flows, the security
> model, all three deployment modes, and a large anticipated-Q&A section.
>
> **Written for:** you, preparing for the calibration call — a study/reference document you can
> read end-to-end and answer deep technical questions from.

---

## 0. The one-paragraph version

An **operator** sits in a plain **web browser** and views (and optionally controls) a **macOS or Windows workstation** — but *only* after the person at that workstation clicks **Allow**. A central **broker** (Node + TypeScript) is the control plane: it authenticates operators, drives the consent handshake over an **outbound** WebSocket that each target keeps open, mints short-lived media tokens, creates **recorded** rooms, and writes a **tamper-evident audit trail** to Postgres. **LiveKit** is the media server (SFU + TURN + Egress recorder). **All screen pixels and input events flow operator ⇄ LiveKit ⇄ endpoint directly — never through the broker.** The broker gatekeeps *access*; it never sees the stream. Because all media is forced through the SFU inside a broker-created room that already has recording attached, recording cannot be bypassed.

```
 operator browser ──REST (poll)──▶  broker  ◀──WSS (outbound)── endpoint client (mac / win)
        ▲                            │ consent, tokens, audit, recording enforcement
        │                            │ (hidden "audit tap" joins each room to log input)
        └──────── WebRTC ──── LiveKit SFU + TURN ──── WebRTC ────────┘
                                     └── Egress → recordings/*.webm
```

---

## 1. The problem & the requirements

This is a Privileged Access Management (PAM) remote-support capability for endpoints. The brief (`remote-access-poc.md`, derived from `PAM_Remote Access for Endpoints.docx`):

- A support operator must be able to **see and control** an employee's Mac/Windows machine for troubleshooting.
- The employee must **consent per session** — nothing is captured or shared before an explicit **Allow**, and a visible indicator must show while a session runs.
- Every session must be **recorded server-side** and **fully audited** (who, when, why, what input).
- It must work on **locked-down corporate networks** (often only outbound TCP 443 is open).
- The endpoint must **not open any inbound port** (it dials out only).
- It must be built so the POC's shortcuts (local accounts, user-download install) can be swapped for enterprise integrations (Entra ID/AD, Intune/CrowdStrike) without a rewrite — via **five provider interfaces**.

### Milestones (status from `README.md`)

| # | Milestone | Status |
|---|---|---|
| M1 | Server up (stack runs; SFU smoke test) | ✅ verified |
| M2 | Native capture (mac/win) | ⚠ macOS built + self-test passes, not yet run live on hardware; Windows written, **not yet compiled** |
| M3 | Remote control | ✅ server path verified by e2e; ⚠ native injection untested on real hardware |
| M4 | Governance (consent, deny, re-consent, audit, banner) | ✅ verified; macOS banner built; Windows banner built but **fails safe** |
| M5 | Recording (auto egress → `.webm`, linked to session) | ✅ verified |
| M6 | Validation (legibility + latency on a 443-only network) | ⏳ needs the prod VM + restricted network; procedure documented |

---

## 2. Core design principles (and why)

1. **Control plane vs. data plane are separate.** The broker never proxies media or input. This keeps the broker cheap and stateless-ish, lets media take the optimal WebRTC path (direct or via TURN), and means a broker restart can't corrupt an in-flight stream.
2. **Consent-first, enforced server-side.** No media token is minted for anyone until the user clicks Allow. Scope (view vs control) is authoritative on the broker; the clients also self-gate as a courtesy, but can't self-escalate.
3. **Recording is unbypassable by construction.** LiveKit's `room.auto_create=false` means only the broker can make rooms, and it always attaches auto-egress. Plus runtime backstops end any session that isn't actually recording.
4. **Audit is tamper-evident at the database layer.** `BEFORE UPDATE OR DELETE` triggers make the audit/input tables append-only — even the broker's own DB user cannot rewrite history.
5. **Outbound-only endpoints.** Targets never listen on a port; they dial the broker and keep one WebSocket open. This is what makes machines behind NAT/firewalls reachable.
6. **One shared contract, two native clients.** Swift and Rust can't share code, so they share a spec (`PROTOCOL.md`) plus a **generated** keymap and **shared test vectors**, making the two clients identical by construction and catching drift in CI.
7. **Everything swappable behind provider interfaces.** Identity, Posture, Bootstrap, Lifecycle, Privilege are interfaces with POC stubs; real integrations drop in by editing one composition file.

---

## 3. Technology stack — every choice and why

| Layer | Technology | Why this, not the alternative |
|---|---|---|
| **Broker** | Node.js 20 + TypeScript (ESM) | I/O-bound control plane holding many idle WebSockets suits Node's event loop; shared language/types with the console; strict TS catches message-shape/state-machine bugs at compile time. |
| Broker HTTP | **Express 5** | v5 forwards rejected promises from async handlers to the error middleware, so every route can be `async` with no try/catch wrapper boilerplate. |
| Broker WS | **`ws`** (noServer mode) | Raw, standard WebSocket server; broker fully controls the HTTP upgrade (path gating, payload cap). Socket.IO would impose a custom handshake the native clients would have to reimplement. |
| DB driver | **`pg`** (no ORM) | Few, deliberate queries (atomic invite claim, dynamic session UPDATE, batched input INSERT); hand-written SQL + transactions are clearer and the append-only logic lives in DB triggers anyway. |
| Operator JWT | **`jose`** | Standards-based JWS (HS256), ESM-native, no legacy `jsonwebtoken` footguns. Used only for operator login cookies. |
| Media SDK (server) | **`livekit-server-sdk`** | Room management, token minting with fine-grained grants, webhook signature verification — error-prone to hand-roll. |
| Audit tap | **`@livekit/rtc-node`** | Lets the broker *join* a room as a hidden participant to capture input server-side, independent of both clients. |
| **Console** | **React 19 + TypeScript + Vite 8** | Declarative state-driven UI; fast dev server + simple `/api` proxy; `tsc -b && vite build` for prod. No router (few views), no UI library (small bundle, full theming control). |
| Media SDK (browser) | **`livekit-client`** | Handles ICE/DTLS-SRTP, track subscription, the reliable data channel (input), and WebRTC stats. |
| **macOS endpoint** | **Swift + AppKit** (native) | Needs ScreenCaptureKit, CGEvent, TCC, Keychain, `SMAppService`, panels above full-screen apps — all native. Small, fast, one code-signing identity (which TCC grants bind to). Electron would bundle Chromium and complicate signing. |
| mac capture | **ScreenCaptureKit** | Modern, efficient (macOS 13+); delivers NV12 buffers the WebRTC encoder consumes directly; native-resolution capture for text legibility. |
| mac input | **CGEvent** | Standard low-level HID synthesis; integrates with the Accessibility trust model. |
| **Windows endpoint** | **Rust + tokio** | Memory-safe systems language with first-class LiveKit + WebRTC crates; static self-contained exe; no runtime/GC. (C#/Electron would add a runtime and a bigger install.) |
| win WS | **tokio-tungstenite** | Async WebSocket client matching the tokio runtime. |
| win OS APIs | **windows-sys** | Thin FFI to Win32 (SendInput, GDI, DPI, MessageBox) with no heavier abstraction. |
| win media | **`livekit` crate 0.9** | Same SFU client as everywhere else; re-exports libwebrtc's DesktopCapturer (WGC + DXGI). |
| **Media server** | **LiveKit** (self-hosted or Cloud) | SFU + TURN + Egress in one, with SDKs for browser/Node/Swift/Rust — one media stack across every component. Routing all media through the SFU is what makes recording unbypassable. |
| **DB** | **PostgreSQL 17** | JSONB for audit detail; strong constraints/uniqueness; triggers for append-only; transactional atomic invite claim. |
| **Bus** | **Redis 7** | Required specifically as the message bus between `livekit-server` and `egress`. Not a general cache; persistence disabled. |
| **Edge (prod)** | **Caddy + layer4 plugin** (`livekit/caddyl4`) | Automatic Let's Encrypt + SNI-based L4 routing lets broker, signalling, and TURN share one :443 listener — LiveKit's own reference approach. |
| **Packaging** | **Docker Compose** (×3) | One command per topology; three compose files share one broker image and schema. |
| **Tunnel (test)** | **ngrok / Cloudflare** | Give the operator's laptop a public HTTPS address via an outbound tunnel — no inbound ports, no public VM needed for a demo. |

---

## 4. Repository layout (folder by folder)

```
Remote_Access_POC/
├── broker/            Node + TypeScript control plane (REST + WS + LiveKit + audit)
│   ├── src/           source (see §5)
│   └── tools/         fake-endpoint.ts (simulated target) + e2e.ts (automated check)
├── console/           React + TypeScript operator web app ("GefyLink") (see §6)
│   └── src/
├── endpoint-mac/      macOS client — Swift, ScreenCaptureKit, CGEvent (see §7)
│   ├── Sources/RemoteAccessEndpoint/
│   ├── Resources/     Info.plist, entitlements.plist
│   └── scripts/       build-app.sh
├── endpoint-win/      Windows client — Rust, WGC/DXGI, SendInput (see §8)
│   ├── src/
│   ├── .cargo/        config.toml (static CRT)
│   └── scripts/       build-exe.ps1
├── shared/            the cross-client contract (see §9)
│   ├── PROTOCOL.md    the wire contract spec
│   ├── keymap.json    DOM code → mac/win key codes
│   ├── gen-keymap.mjs generator → Generated.swift / generated.rs
│   └── test-vectors.json  coordinate + message parse contract tests
├── infra/             init.sql (DB schema), livekit.yaml, prod/{livekit,caddy}.yaml
├── scripts/           dev-env.sh, lan-up.sh, cloud-up.sh, package-clients.sh
├── docker-compose.yml           local / LAN (port 8080)
├── docker-compose.cloud.yml     internet test via tunnel (port 8081, LiveKit Cloud)
├── docker-compose.prod.yml      production VM (Caddy :443, self-hosted)
├── recordings/        .webm recordings (git-ignored)
├── clients/           prebuilt endpoint zips the broker serves (git-ignored)
├── docs/              WALKTHROUGH.md, CONNECT-A-MAC.md, DEMO-DOCUMENTATION.md, this file
├── remote-access-poc.md   the original build spec
└── .env / .env.cloud  secrets (git-ignored)
```

Naming: **broker** = the server/control plane; **console** = the operator's browser app; **endpoint** = the agent on the controlled machine (the "target").

---

## 5. The broker (file by file)

Root: `broker/`. The only control-plane authority. Serves the REST API, hosts the endpoint WebSocket, mints LiveKit tokens, creates recorded rooms, receives LiveKit webhooks, runs the hidden audit tap, writes the audit trail, and statically serves the built console. **No media or input passes through it** (except the read-only audit-tap copy of input).

### `src/index.ts` — bootstrap, HTTP app, WS upgrade, lifecycle
- Builds the Express 5 app, registers every route, wires the WebSocket server, boots the process.
- `app.disable('x-powered-by')` strips the framework fingerprint.
- **The LiveKit webhook route is registered *before* `express.json()`** and uses `express.text({type:'*/*'})` — signature verification needs the *raw* body (ordering is load-bearing). JSON limit elsewhere is a tight `32kb`.
- `requireOperator` middleware resolves identity from the `ra_session` cookie **or** an `Authorization: Bearer` header, attaches `req.operator`, else 401.
- Boot order is strict: `waitForDb()` → `ensureSchema()` → `recoverAfterRestart()` → create HTTP server → attach WS → `listen`.
- WS upgrade is manual and path-gated: only `/ws/endpoint` is accepted (anything else `socket.destroy()`), `maxPayload: 64KB`.
- Global error handler maps `SessionError.status` → HTTP, else 500. Graceful shutdown flushes the buffered input batch before exit.

### `src/config.ts` — environment config (read once)
All `process.env` access is centralized here. `required(name)` throws if missing. Validates at load: `RECORDING_MODE ∈ {local,none}`, and `RECORDING_MODE=none` is incompatible with `REQUIRE_RECORDING=true` (otherwise every session would be killed for "not recording"). Hard-coded timings: `consentTimeoutS=40`, `tokenTtlS=120`, `recordingGraceS=20`, `heartbeatTimeoutS=20`. (Full env table in §12.)

### `src/db.ts` — Postgres pool
One shared `pg.Pool` (max 10). `waitForDb(30)` retries `SELECT 1` once a second so the broker survives starting before Postgres is ready (compose race).

### `src/schema.ts` — invite/device DDL (idempotent)
Owns the Phase-2 tables (`invites`, `devices`, `invite_events`) via `CREATE TABLE IF NOT EXISTS` on every boot — deliberately separate from `infra/init.sql` so an existing Postgres volume picks them up without a reset. Includes the append-only trigger for `invite_events`.

### `src/audit.ts` — audit writer, session CRUD, buffered input log
- `AuditEvent` union (the event vocabulary) + `SessionRow` interface.
- `audit(sessionId, event, detail)` → single INSERT into `audit_events` (also logs to stdout).
- `insertSession` / `updateSession` (dynamic SET for state/scope/recording_url, optional `ended_at=now()`).
- `listSessions`, `getSessionRow`, `listAudit`, `inputStats` (aggregate `input_events` by message type).
- **Buffered input log:** `logInput()` pushes to an in-memory array; `flushInput()` writes the whole batch in one multi-row INSERT; a 1s interval flushes. Rationale: input arrives ~60/s per session — one INSERT/sec beats one round-trip each. Also flushed on shutdown.

### `src/sessions.ts` — the session state machine (heart of the broker)
Lifecycle `REQUESTED → CONSENT_PENDING → APPROVED → ACTIVE → ENDED` (+ terminal `DENIED`). A `TRANSITIONS` table rejects illegal moves; each transition writes an audit row with `{from,to}`. Live state in two in-memory maps (`sessions`, `byRoom`); the DB is the durable record.
- `requestSession`: validates the target is online+idle, runs the posture check, inserts the row, audits `requested`, sends `session.request` to the endpoint, moves to `CONSENT_PENDING`, arms a **40s consent-timeout → auto-deny**.
- `sessionStatus`: returns live status; **mints a fresh operator token on every poll** when APPROVED/ACTIVE (so reloads can rejoin). Token returned only to the owning operator.
- `setScope`: **downgrade to view is immediate; upgrade to control** sets `reconsentPending` and re-sends `session.request` to force fresh consent.
- `approve` (the enforcement core, in strict order): (1) `createRecordedRoom` must succeed before any token exists; (2) the hidden **AuditTap joins first** so it sees every input; (3) mint the endpoint token and send `session.token` + `session.scope`.
- `activate`: → ACTIVE, audits `connected`/`control_granted`, arms a **20s recording grace timer** (ends the session if egress never started).
- `onLivekitEvent`: consumes SFU webhooks — participant join/left, `track_published` (→ activate), `egress_started/ended` (collect filenames → `recording_url`; end session on egress error under `requireRecording`).
- `endSession`, `scheduleForget` (keep finished sessions 10 min so late `egress_ended` webhooks resolve), `recoverAfterRestart` (force-end any non-terminal DB session on boot).

### `src/endpoints.ts` — endpoint WS registry & `hello` handshake
`conns: Map<targetId, Conn>`. On connect: a 10s `hello` timeout; first frame must be `hello`; a stale conn for the same target is replaced (close 4002). Liveness: ping every 10s, terminate a socket that missed its pong. If a `hello` carrying a `deviceToken` is rejected → send `{type:'revoked'}` and close **4003** so the client forgets its enrollment. `authenticate()` validates `targetId` against `/^[A-Za-z0-9._-]{1,64}$/` and uses `verifyDevice` (per-device token) or `secretOk` (shared secret, constant-time).

### `src/invites.ts` — invite onboarding routes + the join page HTML
Token regex `/^[A-Za-z0-9_-]{20,100}$/`; `usableInvite()` looks up by `sha256(token)`. In-memory per-IP/min **rate limiter**. A self-contained responsive **join page** (mac/win tabs, download button, `remoteaccess://enroll?token=…&server=…` deep link). The **enroll** path is a single atomic claim in a transaction (`UPDATE invites SET enrolled_at=now() WHERE enrolled_at IS NULL … RETURNING`) so two simultaneous enrolls can't both win.

### `src/devices.ts` — device credential hashing & verification
`sha256`, `newSecret(prefix)` = `prefix + randomBytes(32).base64url` (256-bit). `verifyDevice(token, targetId)`: requires a `dev_` prefix, then an UPDATE that verifies the hash **and** the `target_id` **and** not-revoked, stamping `last_seen_at` — binding the credential to one machine, so a stolen token can't impersonate another.

### `src/livekit.ts` — all LiveKit interactions + AuditTap
`RoomServiceClient` + `WebhookReceiver`. `createRecordedRoom` creates the room with `maxParticipants:4` and **Auto Track Egress** attached when `recordingMode=local` (passthrough VP9→.webm). `AuditTap` wraps a `@livekit/rtc-node` Room, joins hidden/receive-only, and logs every `input`-topic data message (attributed to the only identity granted `canPublishData` — the operator).

### `src/tokens.ts` — least-privilege LiveKit tokens
`ttl=120s`. `endpointToken` publishes **only** screen-share, `canPublishData:false`, subscribe:true. `operatorToken` `canPublish:false`, `canPublishData:true` (watch + send input, never publish media). `tapToken` hidden+recorder, subscribe-only. `smokeToken` for M1.

### `src/providers/*` — the five integration seams
`types.ts` defines `BootstrapProvider`, `LifecycleProvider`, `PrivilegeProvider`, `IdentityProvider`, `PostureProvider`. `index.ts` is the **composition root** — the one file to edit to swap stubs for Entra ID/Intune/CrowdStrike. `local-identity.ts`: operators from `OPERATORS="alice:pass"`, 8h HS256 JWT via `jose`, constant-time password compare. `stubs.ts`: `UserDownloadBootstrap`, `EphemeralLifecycle`, `UserPrivilege`, `AllowListPosture` (`TARGET_ALLOWLIST`, `*`=any).

### `Dockerfile` — 3-stage build
(1) build console → static; (2) `npm ci` + `tsc` build broker, then prune dev deps; (3) runtime on **`node:20-bookworm-slim`** (Debian/glibc, because `@livekit/rtc-node` ships prebuilt glibc binaries — Alpine/musl would break) with **ca-certificates** (the audit tap verifies TLS to wss:// LiveKit). Runs as non-root `node`, exposes 8080.

### `tools/`
- `e2e.ts`: plays the operator over HTTP — login → request → poll until APPROVED with token → join via rtc-node → assert video → publish synthetic input → exercise scope down/up → end → verify audit order, server-side input counts, downloadable recording. Asserts "no token before consent."
- `fake-endpoint.ts`: a simulated target that speaks the real protocol without native code (auto-answers consent, publishes a synthetic VP9 screen with a crosshair that tracks the operator's mouse). Great for demos/tests without hardware.

### Broker HTTP routes (summary)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/login` / `/api/logout` | public | set/clear `ra_session` cookie (httpOnly, sameSite=strict, secure on TLS, 8h) |
| GET | `/api/me` | operator | current identity |
| GET | `/api/targets` | operator | live endpoints + posture + bootstrap hint |
| POST | `/api/sessions` | operator | request a session (reason ≤500, scope coerced) |
| GET | `/api/sessions` | operator | last 50 session rows |
| GET | `/api/sessions/:id` | operator | live status (incl. token+url when approved & owner) |
| GET | `/api/sessions/:id/audit` | operator | audit trail + per-type input counts |
| POST | `/api/sessions/:id/scope` | operator | change scope (down=immediate, up=re-consent) |
| POST | `/api/sessions/:id/end` | operator | end session |
| GET | `/api/recordings/*` | operator | serve recording (path-traversal guarded) |
| GET | `/api/clients` / `/api/clients/:platform` | operator | which baked zips exist / download (secret inside) |
| GET | `/join/:token` | public (rate-limited) | the HTML join page |
| GET | `/join/:token/download/:platform` | public | generic client (no secret), token-gated |
| POST | `/api/enroll` | public | atomic claim → `{deviceToken,targetId,server,wsUrl}` |
| GET/POST | `/api/invites*`, `/api/devices*` | operator | manage invites + enrolled devices (revoke) |
| POST | `/livekit/webhook` | signature-verified | SFU events → audit |
| GET | `/healthz` | public | health |
| GET | `/{*spa}` | public | SPA fallback to the console |

**There is no operator WebSocket.** The console polls `/api/sessions/:id` for state/token and talks media+input directly to LiveKit. The only broker WS is the endpoint control link.

---

## 6. The console (file by file)

Root: `console/`. A React SPA ("GefyLink — Secure Remote Access") served by the broker in prod. Zero-install operator cockpit. Holds no durable state beyond a theme in `localStorage`; the only credential is the httpOnly cookie (JS never sees the token).

- **`index.html`** — bare Vite shell (`#root` + module script).
- **`main.tsx`** — mounts `<App/>` in `<StrictMode>` (effects run twice in dev — relevant to the polling intervals).
- **`api.ts`** — fully-typed wrapper over the REST API. Types: `Scope`, `SessionState`, `Target`, `SessionStatus`, `SessionRow`, `AuditEntry`, `InviteRow`, `DeviceRow`, `ApiError`. `call<T>()` uses `credentials:'same-origin'` (sends the cookie) and throws a typed `ApiError` with the server's `error` on non-2xx. One method per endpoint.
- **`App.tsx`** — the shell and most views:
  - **Login gate:** three-valued `user` (undefined=probing via `/api/me`, null=login, string=in). A live session takes over the whole screen.
  - **Layout:** topbar (brand, theme toggle, user menu with Settings/Logout), sidebar nav, main content (plain `view`-state switch, no router).
  - **`useTheme`:** light/dark persisted in `localStorage` (try/catch for private mode), applied as `<html data-theme>`, which the CSS token overrides key on.
  - **WelcomeBanner:** greeting + 4 live KPI cards (targets online, in session, total sessions, recordings).
  - **Targets:** 2s polling of targets+sessions; search + platform/status filters; table (platform mark, id, host, status, last-seen); **Connect dialog** (reason + access-level → `startSession`); proper empty states.
  - **History/Audit:** search (target/operator), state filter, status pills, **inline-expandable** consent trail + input summary + inline recording playback, **paginated 10 + Show more**.
  - **Recordings:** grid of `<video>` per session with a recording; copy notes recording is off in the LiveKit Cloud test mode.
  - **Download:** per-OS platform cards, **OS auto-detect** via `navigator.userAgent` (your OS card gets an accent ring + "Your computer" badge), download button + install steps.
  - **Settings:** static posture info (WebRTC/DTLS-SRTP, server-side recording, append-only audit; RBAC + IdP noted as planned).
- **`Session.tsx`** — the live session view:
  - Polls `/api/sessions/:id` (1s before connected, 2s after). The broker withholds `token`/`livekitUrl` until consent; the moment they appear it joins the LiveKit room.
  - Joins with `adaptiveStream:false, dynacast:false` and requests `VideoQuality.HIGH` so the operator always sees the full crisp screen. Attaches the remote video track to `<video>`.
  - **Input** is published over the LiveKit data channel (`topic:'input'`, reliable) — never through the broker.
  - Toolbar: target, state/recording/scope badges, Switch to view only / Request control (upgrade shows "awaiting user approval"), Fullscreen (+ keyboard lock), Disconnect.
  - **Live stats bar** (the M6 check): resolution, fps, kbps, codec, **RTT**, **route** (`relay/*` = via TURN), packet loss — read from LiveKit receiver stats + the RTCStatsReport candidate pair.
- **`input.ts`** — DOM→wire module (no React). Sends coordinates as **clamped fractions (0..1)** of the actual letterboxed picture rectangle (so any operator window size maps correctly). Throttles moves to ≤60/s; emits an exact move before every click; filters browser key auto-repeat (`e.repeat`); uses physical `KeyboardEvent.code`; sends `release-all` on blur; suppresses the context menu; gates everything on `canControl()` (view-only drops input client-side). Also `enterFullscreenWithKeyboardLock` (Keyboard Lock API, Chromium).
- **`Invites.tsx`** — create one-time links (ttl 1h–7d), list **pending** links, list **enrolled computers** with a "show revoked" toggle, revoke links/devices. 3s polling, status pills, auto-dismiss the link banner after copy.
- **`Smoke.tsx`** — the M1 SFU smoke test (two tabs, one shares screen) — proves the media path before any native endpoint exists.
- **`styles.css`** — design-token system on `:root` with a dark override block; all components read CSS variables so theming only re-defines tokens. Animations gated behind `prefers-reduced-motion`.
- **`vite.config.ts`** — dev server on 5173 proxies `/api` → `http://localhost:8080`, so the browser sees one origin exactly like prod (where the broker serves the built SPA). Media (LiveKit) is a separate origin, never proxied.

---

## 7. The macOS endpoint (file by file)

Root: `endpoint-mac/`. A Swift executable packaged as a dock-less signed `.app` ("Remote Access"). POC profile: user-download delivery, ephemeral lifecycle (exit after one session), runs as the logged-in user.

- **`main.swift`** — entry point. `EndpointConfig.load()` resolves config by **first-match-wins**: (1) CLI `--broker/--target/--secret`, (2) env `RA_*`, (3) baked `endpoint.json` in the bundle, (4) saved Keychain enrollment. Accessory app (`.accessory`, no dock icon). Registers the `remoteaccess://` URL handler early. Handles `--enroll` (scriptable, `--yes`) and `--self-test`. On revocation → clear enrollment, alert, exit.
- **`EndpointController.swift`** — the session state machine: `idle → consenting → approved → streaming → tearingDown`. Dispatches broker messages; **a `session.token` is only acted on in `.approved(sessionId)`** ("capture nothing before Allow"); handles re-consent for view→control upgrades; `startStreaming` order is connect → capture → prepare track → feed frames → publish; arms a 5s heartbeat; `revoked`/`4003` → `onRevoked`.
- **`BrokerLink.swift`** — the single outbound `URLSessionWebSocketTask`. 64KB max message; recursive receive; **surfaces the close code/reason** (so `4003`/`4001` revocation detection works). Ping/pong automatic.
- **`Capture.swift`** — ScreenCaptureKit at **native backing-pixel resolution** (for small-text legibility), NV12 pixel format (what the encoder consumes with no conversion), frame-rate cap via `minimumFrameInterval`, cursor shown. A 1Hz timer re-sends the last frame so a newly-joined viewer isn't black. Frames flow straight into the LiveKit `BufferCapturer`.
- **`Stream.swift`** — LiveKit publishing: source `.screenShareVideo` (screencast content hint = sharp text), `degradationPreference=.maintainResolution` (drop frames not resolution under congestion), **VP9**, no simulcast, 6 Mbps. Receives input on the `"input"` data topic.
- **`Input.swift`** — CGEvent injection in global display points. Serial queue preserves ordering. **Scope enforcement:** a `.scope` message is informational — a downgrade may apply, an upgrade never; `guard scope == .control` drops all input in view mode. Click-count synthesis for double/triple clicks; wheel sign inversion; `ctrl-alt-del` → Cmd+Opt+Esc (Force Quit, the closest macOS equivalent); `release-all` on end/blur.
- **`Consent.swift`** — a floating `NSPanel` (not `NSAlert`) with a live 30s countdown; **timeout = deny**; Allow is deliberately **not** the default/Return button ("consent must be a conscious click").
- **`Banner.swift`** — a non-suppressible red `NSPanel` at `.screenSaver` level, on all Spaces + above full-screen apps, re-asserting on top every second, with an **End session** button. The only ways to dismiss it are End or killing the process (which drops the link → ends the session).
- **`Permissions.swift`** — the two TCC grants: **Screen Recording** (`CGPreflightScreenCaptureAccess`) and **Accessibility** (`AXIsProcessTrusted`). Deep-links to the exact System Settings pane; startup alert explains that **macOS applies the grant only after the app restarts** (TCC authorization is cached at launch).
- **`Protocol.swift`** — the Swift side of the wire contract (message enums, `toPixels`, `runSelfTest`), in lockstep with Rust.
- **`Providers.swift`** — client-side deployment profile (user/ephemeral/user stubs).
- **`Enrollment.swift`** — parse `remoteaccess://enroll`, confirm with the user (naming the host), `POST /api/enroll`, store the per-device token in the **Keychain** (`com.example.remoteaccess.endpoint` / `enrollment`), fall back to an owner-only `0600` file; optional "start at login" via `SMAppService`. `clear()` on revocation.
- **`Generated.swift`** — generated keymap (DOM code → `kVK_*`) + test vectors. Do not edit.
- **`Resources/`** — `Info.plist` (`LSUIElement`, the `remoteaccess` URL type) and `entitlements.plist` (**not sandboxed** — CGEventPost can't work inside the sandbox).
- **`scripts/build-app.sh`** — assembles the `.app`, embeds the LiveKit frameworks (inside-out re-signed so hardened-runtime library validation passes), optionally bakes `endpoint.json`, signs. With a real `SIGN_IDENTITY` it adds hardened runtime + timestamp; otherwise ad-hoc (grants won't survive rebuilds).

**Signing reality (important for the call):** TCC binds the Screen Recording + Accessibility grants to the **code signature**. An ad-hoc signature looks like a *new app* after every rebuild, so grants reset. For stable grants you need a **Developer ID** identity; for public distribution, **notarize + staple**. Downloaded zips carry quarantine → App Translocation can run the app from a random read-only path and break the bundle path + grants; the fix is a Developer-ID-signed + notarized build run from `/Applications`.

---

## 8. The Windows endpoint (file by file)

Root: `endpoint-win/`. A Rust executable — same lifecycle and wire protocol as the macOS client, verified against the same `shared/test-vectors.json`. POC profile: user-download, ephemeral, user context. (Written; **not yet compiled** on a Windows machine — expect a round of compile fixes on first `cargo build`.)

- **`main.rs`** — tokio multi-thread runtime. `load_config()` is the same **first-match-wins** precedence (CLI → env `RA_*` → `endpoint.json` next to the exe → saved enrollment). `run()` sets **per-monitor DPI awareness** (so `GetSystemMetrics` returns real pixels), registers the `remoteaccess://` URL scheme (per-user HKCU, no admin), handles a launch via an invite link, connects to the broker (retrying every 3s, capturing nothing meanwhile), sends `hello`, then runs an event loop over a `Phase` enum (`Idle/Consenting/Approved/Streaming`). **Fail-safe banner:** on an initial request it creates the session indicator *first*; if it can't, it reports `session_banner_unavailable` and **declines** — never streams without a visible indicator. A `session.token` is acted on only in `Approved(sessionId)`. Revocation: a `4001` close with a device token → clear enrollment, notify, exit. `finish()` exits the process (ephemeral).
- **`broker.rs`** — tokio-tungstenite outbound WebSocket. A writer task with a **3s flush tick** (tungstenite queues the Pong for the broker's liveness ping and only sends it on the next write/flush — without the tick an idle endpoint would be dropped after ~20s). A reader task parses `BrokerMessage` and emits `LinkEvent::Message/Closed`.
- **`capture.rs`** — libwebrtc's **DesktopCapturer** (re-exported by the `livekit` crate), which on Windows uses **Windows.Graphics.Capture with DXGI Desktop Duplication fallback** — the exact pair the spec asks for, maintained upstream. Frames arrive BGRA → converted to I420 (`yuv_helper::argb_to_i420`) into a reused frame buffer, fed to the `NativeVideoSource` at the target fps on its own thread.
- **`stream.rs`** — the `livekit` crate: connects (`adaptive_stream=false, dynacast=false`), publishes one screen track as **VP9**, screencast source, `MaintainResolution`, 6 Mbps, no simulcast. Forwards `input`-topic data messages and disconnects as `MediaEvent`s.
- **`input.rs`** — **SendInput** injection. Fractions → `to_pixels` → SendInput absolute `0..65535`. Scope enforcement identical to macOS (downgrade may apply, upgrade never; non-control drops input). Key codes via the generated `win_vk(code) -> (vk, extended)`; `MapVirtualKeyW` for scan codes; wheel sign inversion; `ctrl-alt-del` sends the combo (real SAS needs the later-phase SYSTEM service); UIPI note (can't inject into elevated windows in user context).
- **`consent.rs`** — `MessageBoxTimeoutW` (always-on-top Yes/No with a built-in 30s timeout, default button **No** so consent is deliberate; timeout = deny). Plus `confirm` and `notify` helpers.
- **`banner.rs`** — a non-suppressible red top-centre **tool window** (not in taskbar/Alt-Tab, no close box), `WM_CLOSE` ignored (Alt-F4 can't dismiss), re-asserts `HWND_TOPMOST` every second, with an **End session** button. Runs on its own thread with its own message loop; other threads talk to it via `PostMessage`.
- **`enroll.rs`** — parse `remoteaccess://enroll`, confirm, `POST /api/enroll` via the built-in **`curl.exe`** (ships with Win10 1803+), store the device token under **`%LOCALAPPDATA%\RemoteAccess\enrollment.json`**, register the URL scheme + optional autostart via **`reg.exe`** (std-only, no extra crates, no unsafe). The link parser is unit-tested.
- **`protocol.rs`** — the Rust side of the wire contract; message enums, `to_pixels`, and the `cargo test` suite that runs the shared coordinate + message vectors.
- **`providers.rs`** — client-side profile stubs (UserDownload / Ephemeral / UserContext).
- **`generated.rs`** — generated `win_vk` keymap + test vectors. Do not edit.
- **`.cargo/config.toml`** — forces the **static CRT** (`-C target-feature=+crt-static`): libwebrtc (webrtc-sys) is built against the static MSVC CRT (/MT); Rust std links the dynamic CRT (/MD) by default, which collides at link time (LNK2005/LNK1169). Static CRT makes the whole binary consistent.
- **`Cargo.toml`** — `livekit 0.9`, `tokio`, `tokio-tungstenite 0.30`, `windows-sys 0.61`, serde. Crucially uses **`rustls-tls-webpki-roots`** (bundled Mozilla root set) instead of native-roots: native roots failed on some Windows machines ("UnknownIssuer") because the OS store wasn't loaded; bundled roots make the exe self-sufficient (trusts Let's Encrypt/ngrok/LiveKit Cloud, **but not** a corporate TLS-interception root — switch to `rustls-platform-verifier` for MITM networks). `lto=true, strip=true` release profile.
- **`scripts/build-exe.ps1`** — `cargo build --release`, then two zips: **generic** (exe only, no secret — served by invite links) always, and **baked** (exe + BOM-less `endpoint.json`) when `-Broker`/`-Secret` are given. Build gotchas learned the hard way: build under `C:\dev` not `Downloads` (corporate "Access is denied"); SmartScreen on first run ("More info → Run anyway").

---

## 9. The shared contract (`shared/`)

The single source of truth both clients + broker + console follow. Two native clients in two languages = the biggest drift risk, so they share a spec + machine-readable data + a generator.

- **`PROTOCOL.md`** — defines:
  - **§1 Control link** (endpoint ⇄ broker WS): JSON frames with a `type` — `hello`/`hello.ok`, `session.request`, `consent.result`, `session.token` (**only after Allow**), `session.scope`, `session.end`, `session.state` (incl. 5s heartbeats). Plus the invite-enrollment sub-flow.
  - **§2 Input wire protocol** (LiveKit data channel, topic `input`, reliable+ordered): `mm` (move, normalized 0..1), `mb` (button), `mw` (wheel, DOM convention), `kb` (physical `KeyboardEvent.code` + mods), `cmd` (`ctrl-alt-del`/`release-all`), `scope` (informational). **Coordinate normalization is identical on both OSes:** `px = min(W-1, floor(clamp(x,0,1)·W))`.
  - **§3 Scope rules:** scope changes go through the broker (no self-escalation); down is immediate, up forces re-consent; the data-channel `scope` message may downgrade but never upgrade.
  - **§4 Shared client behaviour:** capture nothing before the token; consent text + 30s-timeout-deny; non-closable always-on-top banner; VP9/contentHint=text/maintain-resolution/native-res/≤30fps/≤6Mbps; release all keys on end/scope-down.
- **`keymap.json`** — each DOM `KeyboardEvent.code` → `{mac: kVK_*, win: VK_*, ext?: extended-key}`; `null` = no equivalent. The `ext` flag is required for correct Windows injection of the extended-key set.
- **`gen-keymap.mjs`** — `node shared/gen-keymap.mjs` reads `keymap.json` + `test-vectors.json` and writes the checked-in, do-not-edit `Generated.swift` (`macKeyCodes`) and `generated.rs` (`win_vk`), each embedding the vectors. One edit + regenerate updates both clients in one PR.
- **`test-vectors.json`** — six coordinate cases (corners, center, out-of-range clamping, real Retina sizes) + nine message parse cases (valid + must-reject). Each client's self-test (`--self-test` / `cargo test`) runs them, so divergence fails a test rather than producing a misplaced click in production.

---

## 10. Data model & tamper-evident audit (`infra/init.sql` + `schema.ts`)

**Core tables** (`init.sql`, created once on volume init):
- **`sessions`** — `id(UUID PK), operator, target, reason, scope('control'), state, recording_url, created_at, ended_at`. Mutable (state/recording_url change).
- **`audit_events`** — `id(BIGSERIAL), session_id(FK), event, detail(JSONB), at`. Events: `requested, consent_shown, consent_granted, consent_denied, token_issued, recording_started, connected, control_granted, scope_changed, disconnected, recording_stopped, ended` (+ a few extras). Index `(session_id, at)`.
- **`input_events`** — `id, session_id(FK), sender, msg(JSONB), at`. Every data-channel input message captured by the audit tap (mouse moves included → full replay possible).

**Invite tables** (`schema.ts`, ensured every boot): `invites` (only `token_hash` stored, `expires_at`, `opened_at`, `enrolled_at`, `revoked_at` — status derived), `devices` (`target_id UNIQUE`, `credential_hash UNIQUE`, platform, hostname, `revoked_at`), `invite_events`.

**Tamper-evidence:** `BEFORE UPDATE OR DELETE` triggers on `audit_events`, `input_events`, and `invite_events` raise an exception — any UPDATE/DELETE fails, even from the broker's own DB user. Inserts still succeed → strictly append-only at the lowest layer, independent of application correctness. Two independent guarantees: (1) history can't be rewritten without a conspicuous schema change (DROP trigger); (2) operator input is logged by the **independent hidden audit tap**, not by either client, so neither side can omit an input event. (The local user's own typing is deliberately *not* logged — that would need macOS Input Monitoring; out of scope.)

---

## 11. Security model (consolidated)

- **Consent-first invariant:** no media token is minted before Allow; the recorded room exists before any token.
- **Recording unbypassable:** `room.auto_create=false` (only the broker makes rooms, always with egress) + a 20s grace timer + egress-error kill; `RECORDING_MODE=none` only allowed with `REQUIRE_RECORDING=false`.
- **Append-only audit** at the DB via triggers.
- **Least-privilege media grants:** endpoint = publish screen only; operator = watch + send data, never publish media; tap = hidden receive-only.
- **No self-escalation:** scope changes go through the broker; up forces re-consent; clients reject data-channel upgrades.
- **Hashed secrets at rest:** invite tokens + device credentials stored only as SHA-256 (256-bit entropy). Device credentials bound to one `target_id`.
- **Constant-time compares** for operator passwords and the endpoint secret.
- **Outbound-only endpoints:** no inbound ports; endpoint dials the broker, HTTPS to `/api/enroll`, WebRTC to the SFU.
- **Path-traversal guards** on recording downloads; whitelisted platforms + fixed filenames for client downloads.
- **Rate limiting** on all public invite routes; 32KB JSON limit; 64KB WS cap; 10s hello timeout; strict regexes; HTML escaping on the join page; `x-powered-by` off; `no-store`/`no-referrer` on the join page.
- **Webhook authenticity:** LiveKit webhooks HMAC-verified before any state change.
- **Cookie hardening:** httpOnly, sameSite=strict, secure on TLS, 8h; JWT algorithm pinned to HS256 on verify; JS never sees the token.
- **Immediate revocation:** revoking a device drops its live WS (close 4003) and the client clears its saved credential.

**POC shortcuts (explicitly not production):** local `OPERATORS` list (plaintext `user:pass`), the shared `ENDPOINT_SECRET` for non-enrolled clients, ad-hoc app signing. All are behind the provider seams / build flags so they swap cleanly.

---

## 12. The three deployment modes

| Dimension | Local (`docker-compose.yml`) | Cloud/ngrok (`docker-compose.cloud.yml`) | Prod (`docker-compose.prod.yml`) |
|---|---|---|---|
| Purpose | Everything self-hosted on one box/LAN | Demo to anyone over the internet, no VM | Real self-hosted VM, real DNS + TLS |
| Broker | port **8080** | `127.0.0.1:8081` + tunnel | `localhost:8080` behind Caddy :443 |
| SFU/TURN | self-hosted LiveKit | **LiveKit Cloud** | self-hosted LiveKit + TURN-over-443 |
| Egress/recording | **yes** (`local`) | **no** (`none`, off) | **yes** (`local`) |
| Redis | yes | no | yes |
| Networking | bridge + published ports | bridge, localhost-only | **host** throughout |
| TLS | none (ws/http) | tunnel provides HTTPS | Caddy + Let's Encrypt (wss/https) |
| Target reaches broker at | `http://<LAN IP>:8080` | ngrok/CF URL | `https://broker.<domain>` |
| Start | `docker compose up` / `lan-up.sh` | `scripts/cloud-up.sh` | `docker compose -f docker-compose.prod.yml up` |

**Why recording is off in cloud mode:** LiveKit Cloud runs egress in *its* cloud and can only upload to object storage you configure — it physically can't write a file back to your laptop. The cloud compose therefore has no egress container and sets `RECORDING_MODE=none` + `REQUIRE_RECORDING=false` (the broker refuses the unsafe combination). To get cloud recording: deploy prod (local disk), or wire LiveKit Cloud egress → S3/GCS.

**Prod edge (`infra/prod/caddy.yaml`):** one `:443` listener split by **SNI** (layer4) → `turn.` to `localhost:5349`, `livekit.` to `7880`, `broker.` to `8080`; automatic Let's Encrypt for all three names. This lets signalling, broker, and the TURN relay all live on 443 and all look like plain HTTPS — which is what makes it work on a 443-only corporate network. **TURN-over-443** (`turns:turn.<domain>:443?transport=tcp`) is the key: relayed media rides a connection indistinguishable from HTTPS.

**Env vars** (templates in `.env.example` / `.env.cloud.example`): `LIVEKIT_API_KEY/SECRET` (sign tokens + webhooks; the key *name* must equal `webhook.api_key` in livekit.yaml), `LIVEKIT_URL` (broker→LiveKit API), `LIVEKIT_WS_URL` (audit-tap), `LIVEKIT_PUBLIC_URL` (what browsers/endpoints use), `POSTGRES_PASSWORD`, `JWT_SECRET` (operator logins), `OPERATORS` (local operators), `ENDPOINT_SECRET` (baked into non-generic zips), `TARGET_ALLOWLIST` (`*`=any), `REQUIRE_RECORDING`, `RECORDING_MODE`, `PUBLIC_URL` (**the address targets use to reach the broker — goes into invite links**), `NGROK_DOMAIN` (cloud only). Secrets are generated by `scripts/dev-env.sh` / `cloud-up.sh` and git-ignored.

---

## 13. The invite & enrollment flow (end to end)

1. **Create** — operator `POST /api/invites {server,note,ttlHours}`. Broker generates a 256-bit token, stores only `sha256(token)`, returns the one-time URL `https://<server>/join/<token>`. The `server` default comes from `PUBLIC_URL`; it's editable in the Invite form. Status: **pending**.
2. **Open** — user opens `/join/:token`. The browser's user-agent picks mac vs win on the page (same link for everyone). Opening sets `opened_at` once but **does not consume** the token (Teams/Outlook link previews are harmless). Status: **opened**.
3. **Download** — `/join/:token/download/:platform` serves the **generic** client (no secret inside), token-gated.
4. **Run + enroll** — the app opens, the user clicks "Connect this computer" (or the deep link `remoteaccess://enroll?…` launches the installed app). The app confirms with the user, then `POST /api/enroll {token,platform,hostname}`. An **atomic claim** issues a per-device `dev_` token + a `targetId`; the app stores the token (Keychain / `%LOCALAPPDATA%`). Status: **enrolled**.
5. **Connect** — the app opens `/ws/endpoint`, sends `hello` with its device token, appears under **Targets**. Enrolling starts no session — the operator still requests one and the user still clicks Allow every time.

**Revocation:** revoke an unused invite (only while `enrolled_at IS NULL`); or revoke a device → `revoked_at` set + its live WS dropped (close 4003) → it disappears from Targets and clears its saved credential on next start. Expiry is automatic.

---

## 14. The session lifecycle (end to end)

1. Operator clicks **Connect**, enters a reason + access level → `POST /api/sessions` → broker creates the session, audits `requested`, sends `session.request` down the endpoint's WS. State `CONSENT_PENDING` (40s backstop → auto-deny).
2. Endpoint shows the **consent prompt** (30s, timeout=deny). The operator's `Session.tsx` polls and shows "Waiting for the user to allow…".
3. On **Allow**: endpoint replies `consent.result: allow`. Broker `approve()` → creates the **recorded room**, joins the **audit tap** first, mints the endpoint token, sends `session.token` + `session.scope`. It also starts returning the operator's join token on the next poll.
4. Endpoint shows the **banner**, starts **capture**, connects to LiveKit, publishes the **screen track**. Operator's browser joins the room, subscribes to the video, and starts sending input over the data channel. Broker transitions to `ACTIVE` on `track_published`; a 20s grace timer ensures egress actually started.
5. **During:** operator input → data channel → endpoint injects via CGEvent/SendInput (gated by scope). The audit tap logs every input to `input_events`. Scope changes go through the broker (down immediate, up re-consent). Heartbeats every 5s.
6. **End:** operator Disconnect, user clicks the banner's End, link loss, or an error → broker transitions to `ENDED`, deletes the room (finalizes the egress file), the `egress_ended` webhook fills `recording_url`. The endpoint tears down and (ephemeral) exits.

---

## 15. Known gaps / next steps

- **Windows client not yet compiled** on a Windows machine (all modules written, incl. the fail-safe banner).
- **Ad-hoc signing** on macOS (needs Apple Developer ID + notarization; and an MDM PPPC profile to pre-grant TCC on managed Macs). Windows wants an EV code-signing cert to avoid SmartScreen.
- **Recording off in cloud mode** (LiveKit Cloud can't write locally) — prod VM or S3 upload fixes it.
- **M6 validation** (measured legibility + latency on a 443-only network) pending the prod VM.
- **Provider stubs** for Identity (Entra ID/AD), Posture (live Intune/CrowdStrike), Bootstrap (managed install), Privilege (SYSTEM service for secure-desktop/real SAS), Lifecycle (persistent agent) are interfaces only.
- Capability negotiation in the handshake, device discovery, SIEM export — later phase.

---

## 16. Anticipated Q&A (grouped)

### Architecture
- **Does any screen/input data flow through the broker?** No — media + input go operator ⇄ LiveKit ⇄ endpoint directly. The broker's only data-plane touch is the read-only audit tap that *copies* input for the log.
- **How do you reach a machine behind NAT with no inbound port?** The endpoint dials *out* to `/ws/endpoint` and keeps it open; the broker pushes requests/tokens down that existing socket.
- **Why an SFU, not peer-to-peer?** Centralized media routing enables server-side recording and audit, scales to more participants, and keeps the consent/token gate authoritative.
- **Why no operator WebSocket?** The console polls REST for state/token and talks to LiveKit directly for media + input; simpler, and the real-time path (media) is already WebRTC.

### Consent & governance
- **Can an operator see/control without the user agreeing?** No. The token is only acted on after Allow; capture/stream start only then; timeout = deny; view→control requires fresh consent.
- **How does the user know they're watched and stop it?** A non-suppressible red banner for the whole session (all Spaces, above full-screen), with End session; killing the app also ends it.
- **Can an operator escalate their own privileges?** No — scope goes through the broker; clients reject data-channel upgrades; media grants are least-privilege per role.
- **Can the audit log be tampered with?** No — DB triggers make the audit/input tables append-only, even for the broker's own user; input is logged by an independent hidden tap.

### Recording
- **Can an operator run an unrecorded session?** No — only the broker creates rooms (`auto_create=false`), always with auto-egress; a 20s grace timer and egress-error kill enforce it; `none` mode is only allowed with recording not required.
- **Where do recordings go?** `.webm` in `./recordings` (shared volume: egress writes `/out`, broker reads `/recordings`), linked via `sessions.recording_url`; downloads are auth-gated + path-safe.
- **Why is recording off in the ngrok demo?** LiveKit Cloud can't write to your laptop. Fix: prod VM, or egress→S3.

### Networking / firewalls
- **Does it work when only TCP 443 is open?** Yes — TURN runs over TLS on 443 and Caddy SNI-routes signalling/broker/TURN all on 443. Verify via `route relay/tls` in the stats bar.

### Clients, permissions, signing
- **What macOS permissions, and why the restart?** Screen Recording (capture) + Accessibility (input), both TCC grants bound to the code signature; macOS caches TCC at launch, so a new grant isn't honored until relaunch. Without Accessibility, view still works (reports `input_unavailable`).
- **Why the unsigned-app friction?** Ad-hoc signing ties grants to the exact build, so rebuilds reset them. A fixed ngrok address avoids needless rebuilds; the real fix is Developer ID + notarization (+ MDM PPPC for managed Macs).
- **Is the Windows client ready?** All modules written including the fail-safe banner; not yet compiled — expect compile fixes on first `cargo build`. If the banner can't be created, the session is declined, so there's never an unindicated session.
- **Why Rust for Windows and Swift for macOS (not one cross-platform client)?** Each needs deep native OS APIs (ScreenCaptureKit/CGEvent/TCC vs WGC/DXGI/SendInput) and native UI above full-screen apps; a shared generated keymap + test vectors keep the two honest without shared code.

### Operations
- **What happens to live sessions if the broker restarts?** In-memory state is lost, so `recoverAfterRestart()` force-ends any non-terminal DB session and deletes its room; operators re-request.
- **Can two operators drive the same target at once?** No — one session per target (409 if busy).
- **How is operator input attributed if the tap can't resolve the sender?** Only the operator's token has `canPublishData`, so attribution defaults to that identity — exact by the SFU's grant enforcement.
- **What's the difference between the two client zips?** The operator-only "Download" zip has `ENDPOINT_SECRET` baked in (never public); the invite "generic" zip has no secret and self-enrolls via a per-device token.

### Enterprise readiness
- **How would you add Entra ID / AD login?** Implement `IdentityProvider` (OIDC auth-code for `login`, JWKS for `resolve`) and change one line in `broker/src/providers/index.ts`. Same pattern for Posture (Intune/CrowdStrike), Bootstrap (managed install), Privilege (SYSTEM service), Lifecycle (persistent agent).
- **What changes to go to production?** Point three DNS names at the VM, edit the `example.com` names in `infra/prod/*.yaml`, set the prod `.env` (strong secrets, `LIVEKIT_PUBLIC_URL`, `PUBLIC_URL=https://broker.<domain>`, `REQUIRE_RECORDING=true`), then `docker compose -f docker-compose.prod.yml up -d --build`. From the user's side, nothing changes except the link domain (and, if notarized, no right-click/SmartScreen friction).

---

*Generated as a study reference from a full read of the codebase (broker, console, macOS + Windows endpoints, shared contract, infra, scripts, docs, and the original spec).*
