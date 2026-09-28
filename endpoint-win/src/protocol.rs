//! Rust side of the shared endpoint contract (shared/PROTOCOL.md). Mirrors
//! endpoint-mac/Sources/RemoteAccessEndpoint/Protocol.swift; both are checked
//! against shared/test-vectors.json (`cargo test` here, `--self-test` on macOS).
use serde_json::{json, Value};

pub const VERSION: &str = "win-0.1.0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    View,
    Control,
}

impl Scope {
    pub fn parse(s: &str) -> Option<Scope> {
        match s {
            "view" => Some(Scope::View),
            "control" => Some(Scope::Control),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::View => "view",
            Scope::Control => "control",
        }
    }
}

// ---- input wire protocol (data channel, topic "input") ----------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Clone, Debug, PartialEq)]
pub enum InputMessage {
    MouseMove { x: f64, y: f64 },
    MouseButton { button: MouseButton, down: bool },
    Wheel { dx: i32, dy: i32 },
    Key { code: String, down: bool, mods: Vec<String> },
    Command(String),
    Scope(Scope),
}

impl InputMessage {
    /// None for anything malformed or unknown; the caller drops it.
    pub fn parse(data: &[u8]) -> Option<InputMessage> {
        let v: Value = serde_json::from_slice(data).ok()?;
        let num = |k: &str| v.get(k).and_then(Value::as_f64);
        Some(match v.get("t")?.as_str()? {
            "mm" => {
                let (x, y) = (num("x")?, num("y")?);
                if !x.is_finite() || !y.is_finite() {
                    return None;
                }
                InputMessage::MouseMove { x, y }
            }
            "mb" => InputMessage::MouseButton {
                button: match v.get("button")?.as_str()? {
                    "left" => MouseButton::Left,
                    "right" => MouseButton::Right,
                    "middle" => MouseButton::Middle,
                    _ => return None,
                },
                down: v.get("down")?.as_bool()?,
            },
            "mw" => InputMessage::Wheel { dx: num("dx").unwrap_or(0.0) as i32, dy: num("dy").unwrap_or(0.0) as i32 },
            "kb" => InputMessage::Key {
                code: v.get("code")?.as_str()?.to_string(),
                down: v.get("down")?.as_bool()?,
                mods: v
                    .get("mods")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|m| m.as_str().map(String::from)).collect())
                    .unwrap_or_default(),
            },
            "cmd" => InputMessage::Command(v.get("name")?.as_str()?.to_string()),
            "scope" => InputMessage::Scope(Scope::parse(v.get("value")?.as_str()?)?),
            _ => return None,
        })
    }
}

/// PROTOCOL.md §2: px = min(W-1, floor(clamp(x,0,1) * W)). Identical on macOS.
pub fn to_pixels(x: f64, y: f64, w: i32, h: i32) -> (i32, i32) {
    let cx = x.clamp(0.0, 1.0);
    let cy = y.clamp(0.0, 1.0);
    (((cx * w as f64).floor() as i32).min(w - 1), ((cy * h as f64).floor() as i32).min(h - 1))
}

// ---- broker control link ------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SessionRequest {
    pub session_id: String,
    pub operator: String,
    pub reason: String,
    pub scope: Scope,
}

#[derive(Debug, Clone)]
pub struct SessionToken {
    pub session_id: String,
    pub livekit_url: String,
    pub token: String,
}

#[derive(Debug, Clone)]
pub enum BrokerMessage {
    HelloOk,
    Request(SessionRequest),
    Token(SessionToken),
    Scope { session_id: String, scope: Scope },
    End { session_id: String, reason: String },
}

impl BrokerMessage {
    pub fn parse(text: &str) -> Option<BrokerMessage> {
        let v: Value = serde_json::from_str(text).ok()?;
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        Some(match v.get("type")?.as_str()? {
            "hello.ok" => BrokerMessage::HelloOk,
            "session.request" => BrokerMessage::Request(SessionRequest {
                session_id: s("sessionId"),
                operator: s("operator"),
                reason: s("reason"),
                scope: Scope::parse(&s("scope")).unwrap_or(Scope::Control),
            }),
            "session.token" => BrokerMessage::Token(SessionToken {
                session_id: s("sessionId"),
                livekit_url: s("livekitUrl"),
                token: s("token"),
            }),
            "session.scope" => BrokerMessage::Scope {
                session_id: s("sessionId"),
                scope: Scope::parse(&s("scope")).unwrap_or(Scope::View),
            },
            "session.end" => BrokerMessage::End { session_id: s("sessionId"), reason: s("reason") },
            _ => return None,
        })
    }
}

pub fn hello(target_id: &str, secret: &str, hostname: &str) -> String {
    json!({ "type": "hello", "targetId": target_id, "platform": "win", "hostname": hostname, "secret": secret, "version": VERSION })
        .to_string()
}

pub fn consent(session_id: &str, allow: bool) -> String {
    json!({ "type": "consent.result", "sessionId": session_id, "decision": if allow { "allow" } else { "deny" } }).to_string()
}

pub fn state(session_id: &str, state: &str, detail: Option<&str>) -> String {
    let mut v = json!({ "type": "session.state", "sessionId": session_id, "state": state });
    if let Some(d) = detail {
        v["detail"] = json!(d);
    }
    v.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated::{win_vk, COORD_VECTORS, MESSAGE_VECTORS};

    #[test]
    fn coordinate_vectors() {
        for v in COORD_VECTORS {
            assert_eq!(to_pixels(v.x, v.y, v.w, v.h), (v.px, v.py), "({}, {}) on {}x{}", v.x, v.y, v.w, v.h);
        }
    }

    #[test]
    fn message_vectors() {
        for (raw, valid) in MESSAGE_VECTORS {
            assert_eq!(InputMessage::parse(raw.as_bytes()).is_some(), *valid, "{raw}");
        }
    }

    #[test]
    fn keymap() {
        assert_eq!(win_vk("KeyA"), Some((65, false)));
        assert_eq!(win_vk("ArrowLeft"), Some((37, true)));
        assert_eq!(win_vk("NoSuchKey"), None);
    }
}
