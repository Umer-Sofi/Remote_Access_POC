# Walkthrough: what every file does and why

Read this alongside the spec (`remote-access-poc.md`). The order follows how a session flows.

## The big picture in one paragraph

The **broker** is the only component everyone talks to for *control*. The endpoint client on the
target machine opens an outbound WebSocket to it and waits. An operator logs in to the **console**
and asks for a session. The broker forwards the request, the user sees a **consent prompt**, and
only after *Allow* does the broker create a **LiveKit room with recording attached** and hand out
**tokens**. Both sides then connect out to the **SFU**: the target publishes its screen, the
operator watches it and sends input back over a **data channel**. **Egress** records the video,
a hidden **audit tap** logs the input, and **webhooks** tell the broker what really happened so it
can write the **audit trail**.

---

## Root

| File | Purpose | Why this way |
|---|---|---|
| `docker-compose.yml` | Dev stack: postgres, redis, livekit, egress, broker. | One command brings up the whole server side (spec §7). Postgres is exposed on **5433** so it doesn't clash with a local Postgres on 5432. |
| `docker-compose.prod.yml` | VM stack with **host networking** plus **Caddy on :443**. | WebRTC/TURN need real host ports; Caddy splits 443 by TLS name so TURN works on 443-only networks (spec §11.5). |
| `.env.example`, `scripts/dev-env.sh` | Every secret and deploy setting in one place; the script fills in random secrets. | Keeps secrets out of committed config; one place to rotate them. `.env` is git-ignored. |
| `.dockerignore`, `.gitignore` | Keep node_modules, builds, recordings and secrets out of images and git. | |

## `infra/`

| File | Purpose | Why |
|---|---|---|
| `init.sql` | `sessions` and `audit_events` exactly as spec §8.3, plus `input_events`. **Triggers make the audit tables append-only.** | An audit log that can be edited isn't an audit log. Verified: a `DELETE` is rejected. |
| `livekit.yaml` | SFU + TURN config. Key setting: **`room.auto_create: false`**. | Clients cannot create rooms. The only rooms are the ones the broker creates with recording attached, so no unrecorded media path exists. |
| `prod/livekit.yaml` | Same, with TURN/TLS behind Caddy and localhost addresses. | Production networking. |
| `prod/caddy.yaml` | Layer-4 TLS router: `turn.` → TURN, `livekit.` → signalling, `broker.` → broker. | Everything shares TCP 443, which looks like HTTPS to a restrictive firewall. |

## `shared/`: the contract both endpoints obey

| File | Purpose | Why |
|---|---|---|
| `PROTOCOL.md` | Every broker⇄endpoint message, the input wire format, the coordinate formula, scope rules, required client behaviour. | Spec §8.5 requires one shared contract across two languages. Swift and Rust can't share code, so they share a spec plus data. |
| `keymap.json` | DOM `KeyboardEvent.code` → macOS keycode + Windows virtual-key (+ "extended key" flag). | The console sends physical key names, which is platform-neutral; each OS translates. One table = no drift. |
| `test-vectors.json` | Coordinate and message-parsing cases. | Both clients must produce identical results; tests prove it. |
| `gen-keymap.mjs` | Generates `Generated.swift` and `generated.rs` from the JSON. | Generated, not hand-copied, so the two tables are identical by construction. |

## `broker/`: the brain (Node + TypeScript)

| File | Purpose | Why |
|---|---|---|
| `src/config.ts` | Reads all env vars once, fails fast if a required one is missing. | No `process.env` scattered through the code; misconfiguration shows at startup. |
| `src/db.ts` | Postgres pool + wait-for-DB on boot. | Postgres may start slower than the broker. |
| `src/audit.ts` | The **only** code that writes audit rows; batches input logs once per second. | One choke point means no transition can skip auditing. Batching handles ~60 msgs/s cheaply. |
| `src/providers/types.ts` | The **5 provider interfaces** (spec §9). | Later integrations (CrowdStrike, Entra ID, Intune) are new classes, not rewrites. |
| `src/providers/local-identity.ts` | POC IdentityProvider: local users, HS256 JWT, constant-time password compare. | |
| `src/providers/stubs.ts` | POC Bootstrap / Lifecycle / Privilege / Posture (allow-list). | Trivial by design; they exist so the seams exist. |
| `src/providers/index.ts` | Chooses which implementation of each provider is live. | Single composition root to swap implementations. |
| `src/tokens.ts` | Mints LiveKit tokens: room-scoped, 120 s TTL, **least privilege**. Endpoint = screen-share only; operator = watch + send data, never publish media; tap = hidden receive-only. | The SFU enforces these grants, so even a modified client can't do more. |
| `src/livekit.ts` | Creates rooms with **Auto Track Egress**, deletes rooms (which finalises recordings), verifies webhook signatures, runs the **AuditTap**. | Recording is attached to the room itself, so nothing can opt out. The tap logs operator input on the server. Sender attribution uses the grant: only the operator can publish data. |
| `src/endpoints.ts` | WebSocket registry of connected targets: `hello` + shared-secret check, ping/pong liveness every 10 s. | This outbound link is why targets need **no inbound ports**. A frozen endpoint is terminated, which ends its session. |
| `src/sessions.ts` | **The state machine** `REQUESTED → CONSENT_PENDING → APPROVED → ACTIVE → ENDED / DENIED`. Illegal transitions throw; each transition audits. | Enforces the rules: no token before Allow; room (recording) exists before any token; session ends if recording doesn't start within 20 s; view→control needs re-consent; restart recovery closes orphaned sessions. |
| `src/index.ts` | Express routes (spec §8.1 table + audit/scope/recordings/smoke), webhook endpoint, WebSocket upgrade, serves the console build. | One origin for console + API means no CORS, and the login cookie can be httpOnly + SameSite=Strict. Recording downloads are auth-gated and path-traversal safe. |
| `Dockerfile` | 3 stages: build console → build broker → slim runtime (Debian, non-root). | `@livekit/rtc-node` ships glibc binaries, so the image is Debian-based rather than Alpine. |
| `tools/fake-endpoint.ts` | A simulated target speaking the real protocol; draws a crosshair where the operator's mouse is. | Tests the entire server pipeline without native code, and demos without hardware. |
| `tools/e2e.ts` | Automated operator: 20 assertions from consent to recording download. | Regression safety for everything server-side. |

## `console/`: the operator web app (React + TypeScript, Vite)

| File | Purpose | Why |
|---|---|---|
| `src/api.ts` | Typed wrapper for broker REST calls. | JS never sees the login token (httpOnly cookie). |
| `src/App.tsx` | Login → target list (polled every 2 s) → session; audit history with recordings; smoke test. | Spec §8.4 flow. No router library; four views don't need one. |
| `src/Session.tsx` | Polls until APPROVED, joins the room, renders video, hosts the control panel (Ctrl-Alt-Del, view/control, fullscreen + keyboard lock, disconnect), shows live stats. | Stats (resolution, fps, kbps, RTT, **route relay/tls**) are the M6 measurement tool. |
| `src/input.ts` | DOM events → wire protocol. Maps against the **letterboxed picture rect**, not the element; throttles moves to 60/s; sends exact position before every click; skips browser key repeat; releases everything on blur. | Each of these prevents a real bug: misplaced clicks, flooding, double-typing, stuck keys. |
| `src/Smoke.tsx` | M1: two tabs share a screen through the SFU. | Proves the server before any native code (spec §7.5). |
| `vite.config.ts` | Dev server on :5173 proxying `/api` to the broker. | Same single-origin behaviour in dev as in prod. |

## `endpoint-mac/`: macOS client (Swift)

| File | Purpose | Why |
|---|---|---|
| `Package.swift` | SwiftPM + LiveKit Swift SDK. | Builds with the Command Line Tools alone (verified). |
| `Protocol.swift` | Message parsing, coordinate formula, `--self-test` against the shared vectors. | Swift side of the contract. |
| `EndpointController.swift` | The shared lifecycle (idle → consenting → approved → streaming → exit). | **Capture nothing before Allow:** a token is ignored unless this client approved that session. |
| `BrokerLink.swift` | Outbound WebSocket to the broker. | |
| `Consent.swift` | Floating panel, 30 s countdown, timeout = deny; Allow is deliberately not the Return-key default. | Consent must be a deliberate click. |
| `Banner.swift` | Red pill above everything, every Space, re-asserted each second; only "End session" removes it. | Hiding it means killing the process, which drops the broker link and ends the session. |
| `Capture.swift` | ScreenCaptureKit at **native Retina pixels**, NV12; re-sends the last frame on a static screen. | Sharp text; no black screen for a viewer joining while nothing moves. |
| `Stream.swift` | Connect + publish VP9 screencast track, `maintainResolution`, 6 Mbps; waits for the first frame before publishing. | The SDK's contentHint equivalent. The SDK requires a frame before publishing. |
| `Input.swift` | CGEvent injection: drags, click counts, modifier flags, Cmd+Opt+Esc for Ctrl-Alt-Del, release-all. | CGEvent works in points; capture is in pixels. |
| `Permissions.swift` | TCC checks for Screen Recording + Accessibility, with guidance to the right Settings pane. | Spec §12.1: never fail silently. |
| `Providers.swift` | Client-side provider stubs (ephemeral, user context). | |
| `Generated.swift` | Generated key map + vectors. | Do not edit. |
| `scripts/build-app.sh`, `Resources/` | Bundles the embedded WebRTC frameworks, signs inside-out, bakes in config. | TCC grants bind to the signature; unsigned rebuilds lose them. |

## `endpoint-win/`: Windows client (Rust), not yet compiled

| File | Purpose | Why |
|---|---|---|
| `Cargo.toml` | livekit 0.9 + tokio + tungstenite + windows-sys. | Raw windows-sys bindings change less between versions than the higher-level crate. |
| `protocol.rs` | Contract parsing + coordinate formula + `cargo test` against shared vectors. | Mirror of `Protocol.swift`. |
| `main.rs` | The same lifecycle as macOS; per-monitor DPI awareness; **fail-safe `SessionIndicator` gap**. | No banner implementation → every session is declined. |
| `broker.rs` | Outbound WebSocket, with a periodic flush. | tungstenite only sends the pong reply on the next write; without the flush an idle client would be dropped. |
| `consent.rs` | Native Yes/No box, topmost, "No" default, 30 s timeout = deny. | |
| `capture.rs` | LiveKit's DesktopCapturer (= **WGC with DXGI fallback**, as spec §4 asks) → I420. | Maintained upstream instead of hand-written D3D code. |
| `stream.rs` | VP9 screencast track, `MaintainResolution`, input data events. | |
| `input.rs` | SendInput: absolute 0..65535 mapping, extended-key flags, wheel sign flip. | User-context limits documented: UIPI, no real SAS. |
| `providers.rs`, `generated.rs` | Provider stubs; generated key map. | |

---

## Security properties and how each is enforced

| Property | Enforced by |
|---|---|
| No inbound ports on targets | Endpoints only dial out (`endpoints.ts`, `BrokerLink`) |
| No video before consent | Broker issues no token before Allow; clients ignore unsolicited tokens |
| Recording can't be bypassed | `auto_create: false` + auto egress on broker-created rooms + session killed if egress doesn't start |
| Least privilege in the SFU | Per-role token grants (`tokens.ts`) |
| Operator can't self-escalate to control | Scope upgrades go through the broker → user re-consent |
| Tamper-evident audit | Append-only triggers; input logged by the server-side tap |
| Visible indicator throughout | Banner (macOS); Windows declines until its banner exists |
