# Remote Access POC — Build Specification

**Version:** 1.0
**Status:** Ready to start
**Reference:** PAM_Remote_Access_for_Endpoints.docx
**Audience:** engineers / coding agent picking up the build

---

## 1. What we are building

A proof of concept that lets an **operator**, working entirely in a **web browser**, view and control a **target workstation**, with the end user's **consent**, while the whole session is **recorded on the server** and every important event is written to an **audit log**.

The one sentence to keep in mind:

> Operator opens a browser → user on the target sees a consent prompt and clicks **Allow** → operator sees the screen and controls mouse + keyboard → the session is recorded server-side with an audit trail.

If that loop works end to end on both target operating systems, the POC has succeeded.

### Both macOS and Windows are in scope
This POC targets **macOS and Windows together** — macOS testing is a required outcome, not a later increment. The server and the operator console are identical for both; only the **endpoint client** is platform-specific, so it is built as two implementations behind one shared contract (Section 8.5). Build the two endpoints in parallel, or start with whichever hardware is ready first, but **both must be demoed**.

---

## 2. Scope

### In scope (POC)
- Browser operator console: login, target list, connect, live view, remote control.
- Endpoint client on **both macOS and Windows** (ephemeral: downloaded, runs for one session, then exits).
- WebRTC transport through an **SFU**, with a **TURN** relay over TCP 443.
- Product-owned **consent prompt** and a non-suppressible **session banner**.
- Mouse + keyboard control over a WebRTC **data channel**, including a **Ctrl-Alt-Del** command.
- **Server-side recording** and **audit events** for the whole session lifecycle.
- Stub implementations of the five **provider interfaces** (Section 9).
- A measured **text-legibility** and **latency** check.

### Out of scope (later phases — do not build now)
- Persistent agent mode, unattended access, pre-logon access.
- CrowdStrike RTR / Intune integration (unless a Falcon sandbox is provided).
- Policy engine, dual approvals, manager-observation controls.
- Step-up admin rights; Windows UAC secure-desktop handling; SYSTEM-context capture.
- Jamf, proprietary codec pipeline.

Keep out-of-scope items behind the provider interfaces so they can be added later without a rewrite.

---

## 3. Architecture (summary)

Three zones. All connections are **outbound** to the cloud server; **no inbound ports** on operator or target machines. **All media passes through the SFU** — no peer-to-peer — so recording cannot be bypassed.

```
OPERATOR (browser)            CLOUD SERVER (Linux VM)             TARGET (macOS / Windows)
------------------            ----------------------             ------------------------
Browser console  ── REST/WSS ─ Session broker ─ WSS ───────────  Endpoint client
Video viewer     ◀─ WebRTC ──  LiveKit SFU  ──────── WebRTC ───▶  Screen capture → Encoder
Input capture    ── data ch ─▶ (TURN relay)  ──────── data ch ─▶  Input injector
Control panel                  Egress recorder                    Consent prompt
                               Audit DB (PostgreSQL)              Session banner
```

- **Media path (green):** screen capture → encoder → SFU → (viewer + recorder).
- **Input path (purple):** input capture / control → SFU → injector → OS.
- **Control path (grey):** console ↔ broker ↔ client for session setup, consent, teardown.

---

## 4. Technology stack

| Area | Choice | Notes |
|---|---|---|
| SFU + TURN + recording | **LiveKit** (self-hosted) | Bundles SFU, TURN and Egress. Use the latest stable server + SDKs. |
| Operator console | **React + TypeScript**, LiveKit JS SDK | Vite for the dev server/build. |
| Session broker | **Node.js (TypeScript)** or **Go** | REST + WebSocket. Pick one; examples below use Node. |
| Audit store | **PostgreSQL** | SQLite acceptable for the very first spike only. |
| Endpoint client — Windows | **Rust** (LiveKit Rust SDK) or C++ | Rust recommended for SDK + safety. |
| Endpoint client — macOS | **Swift** (LiveKit Swift SDK) | Native access to ScreenCaptureKit + CGEvent. |
| Screen capture | **Windows:** Windows.Graphics.Capture (fallback DXGI Desktop Duplication) · **macOS:** ScreenCaptureKit | Hardware-accelerated on both. |
| Input injection | **Windows:** SendInput (Win32) · **macOS:** CGEvent | Synthetic mouse/keyboard. |
| macOS permissions | **TCC:** Screen Recording + Accessibility; Developer ID signing | See Section 12. |
| Hosting | One **Linux VM**, public IP, TLS cert | Docker for LiveKit + broker + Postgres. |

> Always resolve exact package/image versions to the current stable release at build time; do not hard-code old versions.

---

## 5. Repository layout

Monorepo:

```
remote-access-poc/
├── README.md                     # this spec, trimmed to a quickstart
├── docker-compose.yml            # livekit, turn, postgres, broker
├── infra/
│   ├── livekit.yaml              # LiveKit server config (keys, TURN, egress)
│   └── init.sql                  # audit schema
├── broker/                       # session broker (Node + TS)
│   ├── src/
│   │   ├── index.ts              # REST + WS bootstrap
│   │   ├── sessions.ts           # session lifecycle + state machine
│   │   ├── tokens.ts             # LiveKit access-token minting
│   │   ├── audit.ts              # audit event writer
│   │   └── providers/            # the 5 provider interfaces (stubs)
│   └── package.json
├── console/                      # operator web app (React + TS)
│   ├── src/
│   │   ├── App.tsx
│   │   ├── Session.tsx           # LiveKit room join, video, input capture
│   │   └── input.ts              # DOM events → data-channel messages
│   └── package.json
├── endpoint-win/                 # Windows endpoint client (Rust)
│   ├── src/
│   │   ├── main.rs               # mode select, broker connect (WSS)
│   │   ├── consent.rs            # consent dialog
│   │   ├── banner.rs             # always-on-top indicator
│   │   ├── capture.rs            # Windows.Graphics.Capture → frames
│   │   ├── stream.rs             # LiveKit publish (video track)
│   │   ├── input.rs              # data channel → SendInput
│   │   └── providers.rs          # provider interface stubs
│   └── Cargo.toml
└── endpoint-mac/                 # macOS endpoint client (Swift)
    ├── Sources/
    │   ├── main.swift            # mode select, broker connect (WSS)
    │   ├── Consent.swift         # consent dialog
    │   ├── Banner.swift          # always-on-top indicator
    │   ├── Capture.swift         # ScreenCaptureKit → frames
    │   ├── Stream.swift          # LiveKit publish (video track)
    │   ├── Input.swift           # data channel → CGEvent
    │   ├── Permissions.swift     # TCC checks: Screen Recording + Accessibility
    │   └── Providers.swift       # provider interface stubs
    └── Package.swift
```

The two endpoints implement the **same contract** (Section 8.5): identical broker WSS messages, identical input wire protocol, identical consent/banner behaviour. Only capture, injection and permissions differ.

---

## 6. Prerequisites

**Accounts / infra**
- A Linux cloud VM (2 vCPU / 4 GB is fine for the POC), public IP, DNS name, TLS certificate.
- A **Windows 10/11** machine or VM as one target.
- A **macOS** machine as the other target (Apple silicon or Intel). A real Mac is needed — screen capture and input permissions don't behave in most VMs.
- A **code-signing certificate for Windows** (recommended, avoids SmartScreen noise in demos).
- An **Apple Developer ID** for signing the macOS client — **required**, not optional: TCC permission grants are bound to the signed identity, and an unsigned build loses its Screen Recording / Accessibility grants on every rebuild.

**Local dev tools**
- Docker + Docker Compose.
- Node.js LTS + pnpm (or npm).
- **Windows endpoint:** Rust toolchain (stable) with the MSVC target.
- **macOS endpoint:** Xcode + Swift toolchain.

---

## 7. Environment setup

1. **Bring up the server stack** with `docker-compose.yml`:
   - `livekit` (SFU + built-in TURN; enable Egress),
   - `postgres` (audit store),
   - `broker` (built from `/broker`).
2. **Configure LiveKit** (`infra/livekit.yaml`): API key/secret, TURN enabled on TCP 443, Egress configured to write recordings to a local volume or object storage.
3. **Create the audit schema** from `infra/init.sql` (Section 8.3).
4. **Set broker env vars:** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `DATABASE_URL`.
5. **Smoke test:** run the console, open two browser tabs, and confirm a basic LiveKit room connects through the SFU. This proves the server before any native code exists.

---

## 8. Component specifications

### 8.1 Session broker

Owns session state, consent state, token issuance and audit writes. It is the only component that talks to both the console and the endpoint for control.

**Session state machine:**
```
REQUESTED → CONSENT_PENDING → APPROVED → ACTIVE → ENDED
                    │
                    └────────── DENIED  (terminal)
```

**REST endpoints (operator side):**
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/login` | Operator auth → session cookie/JWT (POC: local users). |
| GET | `/api/targets` | List connectable targets (POC: those with a live WSS link). |
| POST | `/api/sessions` | Start a session for a target → returns `sessionId`. |
| POST | `/api/sessions/:id/end` | End a session. |
| GET | `/api/sessions/:id` | Session status + LiveKit token once `APPROVED`. |

**WebSocket (endpoint side):** the endpoint client opens a persistent WSS to the broker on launch and stays connected. Messages:
| Direction | Type | Payload |
|---|---|---|
| broker→client | `session.request` | `{sessionId, operator, reason, scope}` |
| client→broker | `consent.result` | `{sessionId, decision: "allow"|"deny"}` |
| broker→client | `session.token` | `{sessionId, livekitUrl, token, room}` |
| broker→client | `session.end` | `{sessionId}` |
| client→broker | `session.state` | `{sessionId, state}` (heartbeat / status) |

**Responsibilities:**
- Enforce the state machine (no token before `APPROVED`; no media before token).
- Mint **short-lived, room-scoped** LiveKit tokens for both console and client.
- Tell LiveKit Egress to **start recording** on `APPROVED`, **stop** on `ENDED`.
- Write an **audit event** at every transition (Section 8.3).

### 8.2 Input wire protocol (data channel)

All operator input travels as JSON messages on the WebRTC data channel. **Coordinates are normalized fractions (0.0–1.0)** of the remote screen, so resolution differences don't matter. The endpoint converts them to pixels on arrival.

```jsonc
// mouse move
{ "t": "mm", "x": 0.4212, "y": 0.6310 }
// mouse button  (down=true / up=false)
{ "t": "mb", "button": "left|right|middle", "down": true }
// scroll wheel
{ "t": "mw", "dx": 0, "dy": -120 }
// key            (Windows virtual-key or DOM code; pick one and document it)
{ "t": "kb", "code": "KeyA", "down": true, "mods": ["ctrl","alt"] }
// special/control commands (things the browser cannot send as keys)
{ "t": "cmd", "name": "ctrl-alt-del" }
// scope change (e.g. view-only ↔ control) — triggers re-consent server-side
{ "t": "scope", "value": "control" }
```

Rules:
- Throttle `mm` to a sane rate (e.g. 60/s max) to avoid flooding.
- The **encoder must set the WebRTC `contentHint = "text"`** on the video track and use a screen-friendly codec (VP9 or AV1) with a bitrate floor, so small text stays legible.

### 8.3 Data model (audit)

```sql
-- infra/init.sql
CREATE TABLE sessions (
  id            UUID PRIMARY KEY,
  operator      TEXT NOT NULL,
  target        TEXT NOT NULL,
  reason        TEXT,
  scope         TEXT NOT NULL DEFAULT 'control',
  state         TEXT NOT NULL,
  recording_url TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ
);

CREATE TABLE audit_events (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID REFERENCES sessions(id),
  event       TEXT NOT NULL,        -- requested|consent_shown|consent_granted|
                                    -- consent_denied|token_issued|recording_started|
                                    -- connected|control_granted|scope_changed|
                                    -- disconnected|recording_stopped|ended
  detail      JSONB,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Every state transition and consent decision writes an `audit_events` row. On `ENDED`, set `sessions.recording_url` to the Egress output and write the `ended` event.

### 8.4 Operator console

- **Login** → **target list** → **Connect**.
- On connect, poll `GET /api/sessions/:id` until state is `APPROVED`, then join the LiveKit room with the returned token.
- Render the remote video track in a `<video>` element (the **video viewer**).
- **Input capture** (`input.ts`): attach pointer + keyboard listeners to the video element, convert to the wire protocol (Section 8.2), send on the data channel. Convert screen pixels to normalized fractions before sending.
- **Control panel:** a Ctrl-Alt-Del button (sends `{"t":"cmd","name":"ctrl-alt-del"}`), a view-only/control toggle, and Disconnect.
- Capture browser-swallowed keys where possible (Keyboard Lock API, Chromium + fullscreen); otherwise route them as `cmd` messages.

### 8.5 Endpoint client (macOS **and** Windows)

Both clients follow the **same lifecycle** and speak the **same protocol**. Only the three shaded steps (capture, injection, permissions) are platform-specific. Keep the shared logic (broker WSS, consent state, banner behaviour, data-channel parsing, coordinate maths) in a common module so the two builds don't drift.

**Shared lifecycle:**
1. Launch (ephemeral mode), open a **WSS** control link to the broker, register availability and platform (`mac` / `win`).
2. Wait for `session.request`.
3. **Consent prompt:** product-owned dialog — "*[operator] wants to view and control your screen — Allow / Deny*" — with a **timeout** (timeout = deny). Send `consent.result`. **Capture nothing before Allow.**
4. On Allow, receive `session.token`, connect **outbound** to the SFU.
5. **Screen capture** → frames *(platform-specific)*.
6. **Stream:** feed frames to the LiveKit video track; set `contentHint=text`, codec VP9/AV1, bitrate floor.
7. **Session banner:** non-suppressible, always-on-top indicator for the whole session.
8. **Input:** read data-channel messages, convert normalized coords to pixels, apply *(platform-specific)*. Map `cmd: ctrl-alt-del` explicitly. A `scope` change to `control` re-triggers consent via the broker.
9. On `session.end` (or the user closing the banner): stop capture, remove banner, disconnect, **exit** (ephemeral cleanup).

**Platform-specific pieces:**

| Step | Windows (`endpoint-win`, Rust) | macOS (`endpoint-mac`, Swift) |
|---|---|---|
| Capture | `Windows.Graphics.Capture` (fallback DXGI Desktop Duplication) | `ScreenCaptureKit` (`SCStream`) |
| Mouse | `SendInput` with `MOUSEINPUT` | `CGEventCreateMouseEvent` + `CGEventPost` |
| Keyboard | `SendInput` with `KEYBDINPUT` | `CGEventCreateKeyboardEvent` + modifier flags |
| Ctrl-Alt-Del | Explicit command (browser can't send it); full secure-desktop handling is later-phase | Send the mapped combo via CGEvent |
| Permissions | None for user-context capture in the POC | **TCC: Screen Recording + Accessibility** (Section 12) — check on startup, guide the user if missing |
| Coordinate maths | fraction × display pixels | fraction × display points (handle Retina scale factor) |

> macOS note: because injection needs the **Accessibility** grant, the client must detect a missing grant and surface a clear "enable in System Settings" message instead of silently failing (a denied grant makes `CGEventPost` a no-op).

---

## 9. Provider interfaces (stub now, implement later)

Define these five interfaces from day one, each with a trivial POC implementation, so later phases slot in without a rewrite.

```ts
interface BootstrapProvider {   // how the client reaches the target
  // POC: user-download. Later: CrowdStrike RTR, Intune install.
  deliver(target: TargetId): Promise<void>;
}
interface LifecycleProvider {   // ephemeral vs persistent agent
  // POC: ephemeral (exit after session). Later: persistent registration.
  mode(): "ephemeral" | "agent";
}
interface PrivilegeProvider {   // user vs SYSTEM
  // POC: user context. Later: SYSTEM service, step-up admin.
  context(): "user" | "system";
}
interface IdentityProvider {    // who is the operator
  // POC: local users. Later: Entra ID / AD.
  resolve(token: string): Promise<Identity>;
}
interface PostureProvider {     // device trust for authorization
  // POC: allow-list. Later: live CrowdStrike / Intune posture.
  check(target: TargetId): Promise<PostureResult>;
}
```

---

## 10. Milestones (definition of done per step)

| # | Milestone | Done when… |
|---|---|---|
| M1 | Server up | LiveKit + TURN + Postgres + broker run in Docker; two browser tabs share a screen through the SFU. |
| M2 | Native capture | **Both** clients capture the screen and the operator sees it live in the browser (macOS after granting Screen Recording). |
| M3 | Remote control | Operator's mouse + keyboard work on the target; Ctrl-Alt-Del command wired. |
| M4 | Governance | Consent prompt gates capture; banner shows for the session; broker writes audit events. |
| M5 | Recording | Egress records each session server-side; recording is linked to the session's audit rows. |
| M6 | Validation | Text-legibility + latency measured on a restricted (TURN-only, TCP 443) network; demo runs. |

---

## 11. Definition of done (POC acceptance)

1. Operator connects from a plain browser to a target on **both macOS and Windows**, with **no inbound ports** on the target.
2. The user sees a **product-owned consent prompt**; **no video** is sent before Allow.
3. Operator **views** the screen and **controls** mouse + keyboard with acceptable responsiveness **on both OSes**.
4. A **non-suppressible banner** is visible the whole session.
5. The session works on a network where **only TCP 443** is open (TURN relay).
6. The session is **recorded server-side** and every lifecycle + consent event is in the **audit log**.
7. Typical office text (~10–11pt) is **legible** on both OSes, measured against an agreed threshold.
8. On macOS, the client correctly requests and uses the **Screen Recording** and **Accessibility** permissions.
9. Code is structured around the **five provider interfaces**, with one shared endpoint contract across the two OS builds.

---

## 12. macOS specifics (first-class target)

The server and console are identical to Windows; only the `endpoint-mac` client differs.

- **Capture:** `ScreenCaptureKit` (`SCStream`). **Input:** `CGEvent` (`CGEventCreateMouseEvent`, `CGEventCreateKeyboardEvent`, `CGEventPost`). **Language:** Swift + LiveKit Swift SDK.
- **Retina / scaling:** displays use points with a scale factor; multiply normalized coordinates by the backing pixel size, and capture at the native resolution so text stays sharp.

### 12.1 Permissions (TCC) — how macOS allows this
macOS gates screen capture and synthetic input behind **TCC** (Transparency, Consent and Control). The client needs **two separate** grants:

| Permission | Needed for | Without it |
|---|---|---|
| **Screen Recording** | ScreenCaptureKit capture | capture is black / empty |
| **Accessibility** | CGEvent input injection | `CGEventPost` silently does nothing |

Two ways they get granted:
- **Unmanaged / BYOD Mac (POC default):** the user grants each permission **once**, in System Settings → Privacy & Security. Grants are bound to the app's **code signature**, so the client must be signed with an **Apple Developer ID** — otherwise every rebuild looks like a new app and grants reset. Accessibility typically needs an app **restart** to take effect. The client must detect a missing grant and show a clear "enable in System Settings" message rather than failing silently.
- **Managed Mac (later):** push a **PPPC configuration profile** via MDM (Intune/Jamf) to pre-approve the signed app with no user prompt. Note Screen Recording is extra-sensitive — Apple has tightened it repeatedly and may still require a user touch after OS upgrades. This is the "Apple changes behaviour between releases" risk; isolate capture/permission code behind the platform layer.

### 12.2 What is (and isn't) recorded on macOS
The client records the **operator's injected input** on the server (the data-channel event log), exactly as on Windows, and the screen video via Egress. It does **not** key-log the **local** Mac user's own typing — that would require the separate **Input Monitoring** permission and is intentionally excluded. State this plainly to any security reviewer.

---

## 13. Things to validate early (top risks)

- **Text legibility over video** — agree a numeric threshold; test `contentHint=text`, bitrate floors, VP9/AV1.
- **Latency** — agree an input-to-screen target; measure under TURN relay.
- **TURN cost/bandwidth** — measure bandwidth per session to size production later.
- **Native skill** — capture + injection is the hardest part on **each** OS; make sure someone owns Windows and someone owns macOS.
- **macOS TCC** — get Developer ID signing working **first**, before writing capture/injection, so permission grants persist across rebuilds and don't waste days.
- **Parallel endpoints** — keep the shared endpoint logic in one module so the macOS and Windows builds stay in sync.

---

## 14. References

- Source spec: `PAM_Remote_Access_for_Endpoints.docx`
- LiveKit docs (server, SDKs, Egress, TURN)
- Microsoft: Windows.Graphics.Capture, DXGI Desktop Duplication, SendInput
- Apple: ScreenCaptureKit, CGEvent, PPPC / TCC configuration profiles
- WebRTC: data channels, `contentHint`, Keyboard Lock API
