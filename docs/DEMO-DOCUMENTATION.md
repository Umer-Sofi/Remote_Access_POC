# Remote Access POC — Demo Documentation

## 1. What the demo shows

An **operator**, working entirely in a **web browser**, views and controls a **target Mac**, but
only after the person at that Mac clicks **Allow**. The whole session is **recorded on the server**
and every important step (consent, connect, control, end) is written to a **tamper-proof audit log**.

The one loop to keep in mind:

> Operator opens a browser → the target user sees a consent prompt and clicks **Allow** →
> the operator sees the screen and controls mouse + keyboard → the session is recorded
> server-side with a full audit trail.

Everything connects **outbound** — the target opens no ports — and **all video passes through a
relay server**, so recording cannot be bypassed.

---

## 2. How it works

### 2.1 The five components

| Component | Role | Where it runs | Tech |
|---|---|---|---|
| **Operator console** | The web page the operator uses: login, target list, live view, controls, audit history | Browser | React + TypeScript |
| **Session broker** | The "brain": login, consent, tokens, audit, session lifecycle | Server (a Mac in the demo, a VM in production) | Node.js + TypeScript |
| **Media server (SFU)** | Relays the screen video and input; records the session | LiveKit (self-hosted, or LiveKit Cloud in the demo) | LiveKit |
| **Endpoint component** | The app on the target Mac: screen capture, input injection, consent prompt, session banner | Target Mac | Swift |
| **Platform integration** | The five provider interfaces (identity, posture, bootstrap, lifecycle, privilege) | Inside the broker | TypeScript (stubs) |

These are the exact five parts the source specification mandates.

### 2.2 The three "planes" (paths data travels on)

```
 OPERATOR (browser)            SERVER                              TARGET (Mac)
 ------------------            ------                              ------------
 Console  ── REST/HTTPS ─────▶ Broker ◀── WebSocket (outbound) ─── Endpoint app
                                 │  └─ Postgres (audit log)          ├ consent prompt
                                 └──── LiveKit webhooks              ├ red session banner
 Video viewer ◀── WebRTC ──── LiveKit SFU + TURN ── WebRTC ─────────┤ screen capture
 Mouse/keyboard ─ data ch ──▶     │             ── data channel ──▶ └ input injection
                              Egress (recorder) → .webm file
```

- **Control plane** (REST + WebSocket): login, target list, consent request/result, token
  issuance, session start/stop. Console ⇄ broker ⇄ endpoint.
- **Media plane** (WebRTC video): the target's screen → SFU → operator's browser (and the recorder).
- **Input plane** (WebRTC data channel): the operator's mouse/keyboard → SFU → endpoint → the OS.

### 2.3 A session, step by step

1. **Target registers.** The endpoint app opens an **outbound WebSocket** to the broker and says
   "I'm online" (proving itself with a shared secret). No inbound port is opened on the target.
2. **Operator logs in** to the console (password → signed JWT stored in an httpOnly cookie).
3. **Operator clicks Connect.** The broker checks the target is online, not busy, and passes the
   posture check, then writes `requested` to the audit log.
4. **Consent request.** The broker sends the request to the endpoint; state → `CONSENT_PENDING`.
5. **Consent prompt.** The endpoint shows *"<operator> wants to view and control your screen"* with
   the reason and a **30-second countdown (timeout = deny)**, and reports `consent_shown`.
6. **User clicks Allow.** Only now does the broker: create the LiveKit room **with recording
   attached**, start a hidden "audit tap" that logs every operator input, and mint **short-lived,
   room-scoped tokens** for the endpoint and the operator. State → `APPROVED`.
7. **Streaming starts.** The endpoint captures the screen, publishes one VP9 video track, and shows
   the **red banner**. State → `ACTIVE`; recording starts.
8. **Operator views and controls.** Each mouse/key event travels over the data channel and is
   logged server-side by the audit tap.
9. **Scope changes.** The operator can drop to view-only instantly; going back to control sends a
   **new consent prompt** to the user (re-consent).
10. **Session ends** (operator Disconnect, user's banner "End session", or link loss). The broker
    deletes the room (which finalizes the recording) and writes `ended`. The endpoint app **exits**.

The broker enforces a strict state machine — illegal transitions throw, and every transition writes
an audit row:

```
REQUESTED → CONSENT_PENDING → APPROVED → ACTIVE → ENDED
                   │
                   └────────── DENIED  (terminal)
```

### 2.4 What's recorded and audited

- **Video**: LiveKit Egress records the screen track to a `.webm` file, server-side. (Recording is
  on in local/production mode; it is **off in the internet-test mode** used for remote demos,
  because LiveKit Cloud can't write to the operator's laptop.)
- **Audit events** (append-only, cannot be edited or deleted): `requested`, `consent_shown`,
  `consent_granted` / `consent_denied`, `token_issued`, `recording_started`, `connected`,
  `control_granted`, `scope_changed`, `disconnected`, `recording_stopped`, `ended`.
- **Operator input log**: every mouse move, click, key, and Ctrl-Alt-Del the operator sends is
  captured server-side by a hidden participant — independent of both the browser and the endpoint,
  so neither side can omit anything. (The local user's own typing is **not** logged.)

---

## 3. Design decisions and why

### 3.1 Why a relay (SFU), not peer-to-peer
If video could flow directly operator↔target, an operator could run an unrecorded session. Routing
all media through a **selective forwarding unit** means the server always sees it, so **recording
cannot be bypassed** — a hard requirement in the source spec. We use **LiveKit** because it bundles
the SFU, the TURN relay, and the recorder (Egress), and has SDKs for the browser, Node, Swift, and
Rust — one stack across every component.

### 3.2 Why WebRTC transport
WebRTC gives one transport for both operating systems, **outbound-only** connectivity (ICE with a
TURN relay over TCP 443 for strict networks), native browser support (no operator install), and
built-in encryption (DTLS-SRTP). Crucially, it moves consent **out of the OS and into the product**,
where we can brand it, time it, and record it as an audit event.

### 3.3 Why a native app on the target is unavoidable
A browser can *share* a screen but is deliberately forbidden from *controlling* a computer. Screen
capture and synthetic input require native OS APIs and, on macOS, permissions bound to a signed app.
So the target needs a small native component. (Every comparable product — TeamViewer, BeyondTrust,
Splashtop — reaches the same conclusion.)

### 3.4 Language choices
| Component | Language | Deciding reason |
|---|---|---|
| Broker | Node.js + TypeScript | I/O-bound server; official LiveKit **Node** SDK; same language as the console |
| Console | React + TypeScript | It's a browser UI; official LiveKit **browser** SDK |
| Endpoint (mac) | Swift | Native **ScreenCaptureKit** (capture) + **CGEvent** (input); LiveKit **Swift** SDK |
| Endpoint (win) | Rust | LiveKit **Rust** SDK bundles WebRTC + a desktop capturer; memory safety for security-sensitive input/network code |

The pattern: each part uses the language its platform's native APIs and the LiveKit SDK are built for.

### 3.5 The five provider interfaces (future-proofing)
The single most important architectural instruction in the source spec: keep everything that will
change later behind **five interfaces**, present from day one even with trivial implementations, so
Phase 2/3 is not a rewrite. The broker defines all five (`broker/src/providers/`):

| Interface | POC implementation | Later |
|---|---|---|
| **Bootstrap** — how the app reaches the target | user download | CrowdStrike RTR, Intune, Jamf |
| **Lifecycle** — ephemeral vs persistent | ephemeral (exit after one session) | installed agent |
| **Privilege** — user vs SYSTEM | logged-in user | SYSTEM service, step-up admin |
| **Identity** — who the operator is | local users + JWT | Entra ID / Active Directory |
| **Posture** — device trust | static allow-list | live CrowdStrike / Intune posture |

### 3.6 Consent as a governed mechanism, not a dialog box
Consent is the product's differentiator, so it is: rendered by the product (not the OS), time-bounded
(30 s, timeout = deny), recorded as **distinct** audit outcomes (granted / denied / timeout),
**re-requested when scope escalates** (view→control), and paired with a **non-suppressible banner**
for the whole session. The banner can't be closed except by "End session," which itself ends the session.

### 3.7 Text legibility for admin work
General video codecs blur small text — exactly what operators need to read. Mitigations built in:
capture at **native (Retina) resolution**, **VP9** codec, **screencast/"text" content hint**, a
**degradation preference of "maintain resolution"** (under congestion the encoder drops frames, not
sharpness), a **6 Mbps ceiling**, and an **idle keyframe refresh** (the last frame is re-sent every
second on a static screen). The console shows live resolution/fps/bitrate/RTT/route for measurement.

### 3.8 Recording enforcement
LiveKit is configured so **clients cannot create rooms** (`auto_create: false`); only the broker
creates them, always with recording attached. If recording hasn't started shortly after the target
begins streaming, the broker **ends the session**. There is no code path to an unrecorded room.

### 3.9 Demo connectivity: ngrok + LiveKit Cloud (and why)
For remote demos the operator's laptop is behind a corporate firewall that blocks all inbound
connections, and the target is on a different network. So:
- The broker runs on the operator's laptop and is exposed through an **ngrok tunnel** — an
  outbound-only connection that gives the broker a **fixed public HTTPS address**.
- **LiveKit Cloud** relays the video (a laptop can't be a public media server).
- Both the operator's browser and the target app only make **outbound** connections.

We use **ngrok with a fixed domain** (not a random Cloudflare quick-tunnel) so the address never
changes; that lets the setup script **skip rebuilding the app** when nothing changed, which matters
for the next point.

### 3.10 Ad-hoc code signing — the known tradeoff
The macOS endpoint app is **ad-hoc signed** (no Apple Developer ID yet). Consequences, and how we
handle them:
- macOS blocks a downloaded ad-hoc app until the quarantine flag is cleared (`xattr -dr …`).
- macOS ties **Screen Recording / Accessibility** grants to the exact build, so every rebuild looks
  like a new app and grants reset. **Mitigation:** the fixed ngrok address means the script rebuilds
  the app **only when the address changes**, so a target set up once keeps its permissions.
- The app must be run from **/Applications**, not Downloads, to avoid macOS "App Translocation"
  (which runs a quarantined app from a random hidden path and breaks permission matching).
- On **corporate/managed Macs**, IT policy may block Screen Recording for an unsigned app entirely.
  The real fix is an **Apple Developer ID** (signing + notarization) and, for managed Macs, an **MDM
  PPPC profile** that pre-approves the app. Both are planned; the demo uses unmanaged Macs.

---

## 4. The macOS side: operator package vs endpoint package

On macOS there are **two distinct roles**, and it's important not to confuse them.

### 4.1 Operator package — the console (+ server)
- **What the operator uses:** just a **web browser**. There is **no macOS app to install** for the
  operator. The operator opens the console URL and logs in.
- **What runs on the operator's Mac in the demo:** the **server stack** in Docker (broker + database),
  plus the **ngrok tunnel**, started by one script. In production this stack lives on a cloud VM
  instead, and the operator's Mac only needs a browser.
- **Artifacts:** the `console/` web app (served by the broker) and the `broker/` server. No signed
  binary, no OS permissions — it's a website plus a server.

### 4.2 Endpoint package — `RemoteAccessEndpoint.app`
- **What the target user runs:** a single macOS application, **`RemoteAccessEndpoint.app`** (~41 MB).
- **What's inside it:**
  - the compiled Swift program (screen capture, input injection, consent prompt, banner, broker link);
  - the LiveKit **WebRTC** framework and LiveKit's Rust core (the video engine);
  - `endpoint.json` — the **only per-deployment part**: the broker address (the ngrok URL) and the
    shared secret, baked in at build time;
  - `Info.plist` (declares it a background "accessory" app: no Dock icon, only the prompt and banner);
  - an ad-hoc code signature.
- **What it can do:** register with the broker, show the consent prompt, and — only after Allow —
  capture the **main display** and apply the operator's input. It records nothing locally, uses no
  camera/mic, installs nothing, and exits after the session.
- **OS permissions it needs (granted once by the user):** **Screen Recording** (to see the screen)
  and **Accessibility** (to move the mouse / type).
- **How it's built:** `endpoint-mac/scripts/build-app.sh` compiles the Swift code, embeds the
  frameworks, writes `endpoint.json`, and signs the bundle. In the demo, `scripts/cloud-up.sh` calls
  this automatically with the current ngrok address and secret, and zips the result to
  `transfer/RemoteAccessEndpoint-cloud.app.zip` — the file sent to the target user.

**In one line:** the operator side is a *website + server* (nothing to install but a browser); the
endpoint side is a *signed native app* the target user runs.

---

## 5. Step-by-step setup on a fresh machine

This gets the internet-demo (remote target) running from nothing. Roles: **Operator machine** = your
Mac (runs the server + tunnel + browser). **Target machine** = any Apple-silicon Mac, anywhere.

### 5.1 Prerequisites (operator machine)

Install these:
1. **Docker Desktop** — https://www.docker.com/products/docker-desktop/ (start it; wait for the whale icon).
2. **Homebrew** — https://brew.sh (if not already installed).
3. **Xcode Command Line Tools:** `xcode-select --install` (needed to build the Swift app; full Xcode not required).
4. **ngrok:** `brew install ngrok`
5. **Node.js 20+** and **Git** — usually already present; else `brew install node git`.

Create two free accounts:
6. **LiveKit Cloud** — https://cloud.livekit.io → create a project → **Settings → Keys**. Note the
   **URL** (`wss://<project>.livekit.cloud`), **API Key**, and **API Secret**.
7. **ngrok** — https://dashboard.ngrok.com → copy your auth token and your **free static domain**
   (Dashboard → **Domains**; it looks like `something.ngrok-free.app`).

### 5.2 Get the code and configure

```bash
# clone the repo (or copy the project folder), then:
cd Remote_Access_POC

# authorize ngrok once (from the ngrok dashboard):
ngrok config add-authtoken <YOUR_NGROK_TOKEN>
```

Create the internet-mode config. The first run of the setup script creates `.env.cloud` with random
secrets and then stops so you can fill in the three LiveKit values:

```bash
scripts/cloud-up.sh          # creates .env.cloud, then exits asking for LiveKit keys
```

Open **`.env.cloud`** and set (no quotes, no spaces):
```
LIVEKIT_URL=wss://<your-project>.livekit.cloud
LIVEKIT_API_KEY=<your key>
LIVEKIT_API_SECRET=<your secret>
NGROK_DOMAIN=<your-static-domain>.ngrok-free.app
```
Leave the other lines (the random passwords) as generated.

### 5.3 Start the server + tunnel + build the app

```bash
scripts/cloud-up.sh
```
This builds and starts the broker + database, opens the ngrok tunnel on your fixed domain, and
builds `transfer/RemoteAccessEndpoint-cloud.app.zip`. When it finishes it prints a summary box with:
- the **console URL** (`http://localhost:8081`),
- the **login** (`alice` + the random password from the `OPERATORS=` line of `.env.cloud`),
- the **app to send** (`transfer/RemoteAccessEndpoint-cloud.app.zip`),
- the tunnel line (should say **"ngrok, FIXED address"**).

Keep the Mac awake during a session (in a second Terminal window):
```bash
caffeinate -d
```

### 5.4 Verify the operator console

Open **http://localhost:8081**, log in as `alice` with the password from `.env.cloud`
(only the part **after** `alice:` on the `OPERATORS=` line). You should see an empty **Targets** list.

### 5.5 Set up the target Mac (first time only)

Send the target user `transfer/RemoteAccessEndpoint-cloud.app.zip`. On the **target Mac**:

```bash
# unzip it (double-click, or `unzip` it into ~/Downloads), then:
mv ~/Downloads/RemoteAccessEndpoint.app /Applications/
xattr -dr com.apple.quarantine /Applications/RemoteAccessEndpoint.app
open /Applications/RemoteAccessEndpoint.app
```
- Grant **Screen Recording**: System Settings → Privacy & Security → **Screen & System Audio
  Recording** → switch **RemoteAccessEndpoint** on.
- Grant **Accessibility**: System Settings → Privacy & Security → **Accessibility** → switch it on.
- Restart the app so macOS applies the grants:
```bash
pkill -f RemoteAccessEndpoint; open /Applications/RemoteAccessEndpoint.app
```

> **Important:** run it from **/Applications**, not Downloads. Requirements: an **Apple-silicon** Mac,
> macOS 13+, and (for managed/corporate Macs) that IT allows Screen Recording for the app.

### 5.6 Run a session

1. On the operator machine, refresh **http://localhost:8081** → the target appears in **Targets**.
2. Type a reason, choose **View + control**, click **Connect**.
3. On the target Mac, the consent prompt appears → click **Allow**.
4. The operator now sees the target's screen (red banner on the target) and can control mouse/keyboard.
5. Test **Ctrl-Alt-Del**, the **view/control** toggle (control re-asks consent), and **Disconnect**.
6. Open **Audit history** in the console to see the full event trail.

### 5.7 Later sessions (no re-setup)

Because the ngrok address is fixed and the app isn't rebuilt when it hasn't changed:
- **Operator:** leave the stack running, or re-run `scripts/cloud-up.sh` (it will say "unchanged —
  targets need nothing new").
- **Target:** just `open /Applications/RemoteAccessEndpoint.app` before each session.
- **Stop everything:** `scripts/cloud-up.sh down`.

### 5.8 Showing recording (optional, local mode)

The internet mode has recording off. To demo recording, run **local mode** on the operator Mac and
use it as its own target:
```bash
docker compose up -d                 # local stack on http://localhost:8080
cd endpoint-mac
.build/debug/RemoteAccessEndpoint --broker ws://localhost:8080/ws/endpoint \
    --secret "$(grep '^ENDPOINT_SECRET=' ../.env | cut -d= -f2)" --target mac-local
```
Run the client from **Terminal.app** and grant Terminal the two permissions. Then connect from
http://localhost:8080 (login `alice` / `alice-pass`), run a session, and play it back under
**Audit history**.

### 5.9 Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Target not in the list | App not running (`open /Applications/RemoteAccessEndpoint.app`), or an old app pointing at the wrong address (resend the current zip) |
| "cannot be opened, unidentified developer" | quarantine not cleared: `xattr -dr com.apple.quarantine /Applications/RemoteAccessEndpoint.app` |
| Consent prompt never appears / auto-denied | Screen Recording missing — grant it, then **restart the app** |
| Screen shows but control doesn't work | Accessibility missing — grant it, then restart the app |
| Toggle is on but app still says permission missing | Run from **/Applications** (not Downloads); if it persists on a managed Mac, IT policy is blocking it — needs Developer ID + MDM PPPC profile |
| "Invalid username or password" | Use only the characters **after** `alice:` in `.env.cloud` |
| Login page won't load | Docker not running, or the stack is down — `scripts/cloud-up.sh` |
| App keeps asking for permission after a rebuild | Expected with ad-hoc signing; clean with `tccutil reset ScreenCapture/Accessibility com.example.remoteaccess.endpoint`, remove old System Settings entries, reboot, reinstall to /Applications |

---

## 6. Known limitations and next steps

- **Windows endpoint** — all modules are written, including the session banner (`endpoint-win/src/banner.rs`),
  but the client has **not been compiled yet**. Build it on a Windows 10/11 PC with the Rust MSVC
  toolchain (`cd endpoint-win && cargo build --release`); expect a round of compile fixes on the first build.
- **Ad-hoc signing** — causes the `xattr` / permission-reset friction and blocks managed Macs. Fix:
  **Apple Developer ID** (sign + notarize) and an **MDM PPPC profile** for managed Macs.
- **Recording off in internet mode** — LiveKit Cloud can't write to the laptop. Fix: production VM
  (self-hosted LiveKit + Egress) or S3 upload.
- **Capability negotiation** in the session handshake — required by the source spec for Phase 1,
  not yet implemented.
- **Policy engine, device discovery, live posture, SIEM export** — present only as interface stubs;
  these are the wider-platform items for later phases.
- **Text-legibility and latency thresholds** — mitigations are built; the *measured* acceptance tests
  need the production VM and a restricted (443-only) network.

For the full production plan and cost estimates, and the file-by-file breakdown, see the other docs
in this folder.
