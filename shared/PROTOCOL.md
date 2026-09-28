# Shared endpoint contract

This file is the single source of truth that **both** endpoint clients
(`endpoint-mac`, `endpoint-win`), the broker and the operator console follow.
If you change anything here, change it in every implementation in the same PR.

Machine-readable parts live next to this file:

| File | What it is |
|---|---|
| `keymap.json` | DOM `KeyboardEvent.code` → macOS virtual keycode + Windows virtual-key |
| `test-vectors.json` | Coordinate-maths and message-parsing cases both clients must pass |
| `gen-keymap.mjs` | Generates `KeyMap.swift` and `keymap_gen.rs` from the JSON above |

---

## 1. Control link: endpoint ⇄ broker (WebSocket)

The endpoint opens **one outbound WebSocket** to `wss://<broker>/ws/endpoint`
on launch. All frames are UTF-8 JSON objects with a `type` field.

| Dir | `type` | Payload | Notes |
|---|---|---|---|
| client→broker | `hello` | `{targetId, platform: "mac"\|"win", hostname, secret, version}` | First frame. Registers availability. *(extension to spec §8.1: registration needs a frame)* |
| broker→client | `hello.ok` | `{targetId}` | Registration accepted. On failure the broker closes the socket with code 4001. |
| broker→client | `session.request` | `{sessionId, operator, reason, scope}` | Show the consent prompt. Also sent mid-session when scope is raised to `control` (re-consent). |
| client→broker | `consent.result` | `{sessionId, decision: "allow"\|"deny"}` | Timeout on the client = `deny`. |
| broker→client | `session.token` | `{sessionId, livekitUrl, token, room}` | Only ever sent after `allow`. |
| broker→client | `session.scope` | `{sessionId, scope: "view"\|"control"}` | Authoritative scope. The client drops input while `view`. *(extension)* |
| broker→client | `session.end` | `{sessionId, reason}` | Tear down and exit. |
| client→broker | `session.state` | `{sessionId, state, detail?}` | Status + heartbeat (every 5 s). States below. |

`session.state.state` values sent by clients:

| state | meaning |
|---|---|
| `consent_shown` | the dialog is on screen (the broker audits this as `consent_shown`) |
| `connecting` | token received, connecting to the SFU |
| `streaming` | video track published |
| `heartbeat` | periodic liveness while streaming |
| `input_unavailable` | injection not possible (macOS: Accessibility grant missing) |
| `ended` | the local user ended the session from the banner |
| `error` | something failed; `detail` explains |

## 2. Input wire protocol (LiveKit data channel, topic `input`)

Sent by the console, **reliable + ordered** so a click can never overtake the
move that positioned it. JSON, one message per packet.

```jsonc
{ "t": "mm", "x": 0.4212, "y": 0.6310 }                    // mouse move, normalized 0..1
{ "t": "mb", "button": "left|right|middle", "down": true }  // button at last mm position
{ "t": "mw", "dx": 0, "dy": -120 }                          // wheel, DOM convention: +dy = scroll down
{ "t": "kb", "code": "KeyA", "down": true, "mods": ["ctrl","alt","shift","meta"] }
{ "t": "cmd", "name": "ctrl-alt-del" }
{ "t": "scope", "value": "view|control" }                   // informational, see §3
```

**Key codes are DOM `KeyboardEvent.code` values** (physical key position, e.g.
`KeyA`, `ArrowLeft`, `ControlLeft`). That keeps the console platform-neutral;
each client translates via `keymap.json`. Unknown codes are ignored.

### Coordinate maths (identical on both OSes)

```
fx, fy  = clamp(x, 0, 1), clamp(y, 0, 1)
px      = min(W - 1, floor(fx * W))
py      = min(H - 1, floor(fy * H))
```

* Windows: `W,H` = primary display size in **pixels**, then mapped to SendInput's
  absolute 0..65535 space.
* macOS: `W,H` = main display size in **points** (CGEvent works in points; the
  Retina scale factor is already folded in). Capture itself is done at the
  native **pixel** size so text stays sharp.

`test-vectors.json` holds cases both implementations must satisfy.

### `cmd` names

| name | Windows | macOS |
|---|---|---|
| `ctrl-alt-del` | Ctrl+Alt+Del via SendInput. Windows ignores synthetic SAS; real secure-desktop handling (`SendSAS` from a SYSTEM service) is later-phase and sits behind `PrivilegeProvider`. | Cmd+Option+Esc (Force Quit), the closest macOS equivalent. |
| `release-all` | Key-up for every key the client believes is held. The console sends this on blur. | same |

## 3. Scope (view vs control)

The operator changes scope through the **broker** (`POST /api/sessions/:id/scope`),
never by talking to the endpoint directly, so the operator cannot escalate their
own rights:

* `control → view`: the broker applies it immediately and sends `session.scope`.
* `view → control`: the broker sends a fresh `session.request` (scope `control`).
  Only after the user clicks **Allow** again does it send `session.scope: control`.

The data-channel `scope` message is only informational. A client may apply a
**downgrade** to `view` from it, but must **never** apply an upgrade from it.

## 4. Behaviour both clients must share

1. Capture **nothing** before `session.token` arrives (which only follows Allow).
2. Consent prompt text: `"<operator> wants to view and control your screen"`
   (or `"…view your screen"` for scope `view`), plus the reason. Buttons Allow / Deny.
   **30 s timeout = deny.**
3. Session banner: always on top, on every desktop/space, not closable except
   via its **End session** button (which sends `session.state: ended`).
4. On `session.end`, banner close, or broker link loss: stop capture, remove the
   banner, disconnect from the SFU, **exit the process** (ephemeral mode).
5. Video: codec **VP9** (AV1 fallback where supported), `contentHint=text` /
   degradation preference *maintain-resolution*, native resolution, ≤30 fps,
   max bitrate 6 Mbps. WebRTC has no hard bitrate floor, so *maintain resolution*
   is the lever that keeps text legible: under congestion the encoder drops frames
   rather than resolution.
6. Release all held keys and mouse buttons when the session ends or the scope
   drops to `view`.
