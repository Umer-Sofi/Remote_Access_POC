//! Invite-link enrollment (Phase 2 onboarding). Mirrors endpoint-mac/.../Enrollment.swift.
//!
//!   remoteaccess://enroll?token=<one-time>&server=<https://broker>
//!     │  Windows starts this exe with the link as its first argument (URL protocol handler)
//!     ▼
//!   ask the user ──▶ POST <server>/api/enroll ──▶ { deviceToken, targetId, wsUrl }
//!     ▼
//!   saved under %LOCALAPPDATA%\RemoteAccess; from then on the exe connects with that credential.
//!
//! Enrolling captures and shares nothing; every session still needs the user's Allow.
//!
//! Deliberately std-only: HTTP goes through the `curl.exe` that ships with Windows 10 1803+ and 11
//! (it also trusts the machine's certificate store), and registry changes go through `reg.exe`,
//! so this adds no crates and no unsafe code. The parsing half is plain Rust and unit-tested.
#![allow(dead_code)] // the Windows-only callers are compiled out on other platforms (tests still run anywhere)

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub const SCHEME: &str = "remoteaccess";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Enrollment {
    pub server: String,
    pub ws_url: String,
    pub target_id: String,
    pub device_token: String,
}

#[derive(Debug, PartialEq)]
pub struct Link {
    pub token: String,
    pub server: String,
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                let hex = s.get(i + 1..i + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => { out.push(b' '); i += 1 }
            c => { out.push(c); i += 1 }
        }
    }
    String::from_utf8(out).ok()
}

/// Parses `remoteaccess://enroll?token=…&server=…`. Rejects anything else.
pub fn parse_link(text: &str) -> Option<Link> {
    let rest = text.trim().strip_prefix(&format!("{SCHEME}://enroll"))?;
    let query = rest.strip_prefix('?')?.trim_end_matches('/');
    let (mut token, mut server) = (None, None);
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        match k {
            "token" => token = percent_decode(v),
            "server" => server = percent_decode(v),
            _ => {}
        }
    }
    let (token, server) = (token?, server?);
    let host_ok = server.strip_prefix("https://").or_else(|| server.strip_prefix("http://")).map_or(false, |h| !h.is_empty() && !h.starts_with('/'));
    if token.is_empty() || !host_ok {
        return None;
    }
    Some(Link { token, server: server.trim_end_matches('/').to_string() })
}

/// Host part for the confirmation text, e.g. "broker.example.com:8080".
pub fn host_of(server: &str) -> &str {
    server.split("://").nth(1).unwrap_or(server).split('/').next().unwrap_or(server)
}

// ---- storage -----------------------------------------------------------------

fn store_path() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("RemoteAccess").join("enrollment.json")
}

/// Per-user profile folder (owner-only by default ACL). Hardening idea for later: wrap with DPAPI.
pub fn save(e: &Enrollment) -> anyhow::Result<()> {
    let path = store_path();
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, serde_json::to_vec(e)?).with_context(|| format!("writing {}", path.display()))
}

pub fn load() -> Option<Enrollment> {
    serde_json::from_slice(&std::fs::read(store_path()).ok()?).ok()
}

pub fn clear() {
    let _ = std::fs::remove_file(store_path());
}

// ---- Windows integration (reg.exe / curl.exe) -----------------------------------

fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash
    }
    cmd
}

fn reg(args: &[&str]) {
    let _ = quiet(Command::new("reg.exe").arg("add").args(args).arg("/f")).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// Makes remoteaccess:// links open this exe. Per-user (HKCU), so no admin rights; re-run on every
/// start so the path stays correct if the exe is moved.
pub fn register_url_scheme() {
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = exe.display().to_string();
    let root = format!(r"HKCU\Software\Classes\{SCHEME}");
    reg(&[&root, "/ve", "/d", "URL:Remote Access invite"]);
    reg(&[&root, "/v", "URL Protocol", "/d", ""]);
    reg(&[&format!(r"{root}\shell\open\command"), "/ve", "/d", &format!("\"{exe}\" \"%1\"")]);
}

/// Start when the user logs in (HKCU Run key). Chosen by the user in the enroll confirmation.
pub fn enable_autostart() {
    if let Ok(exe) = std::env::current_exe() {
        reg(&[r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "RemoteAccess", "/d", &format!("\"{}\"", exe.display())]);
    }
}

fn post_json(url: &str, body: &str) -> anyhow::Result<(u16, String)> {
    let mut child = quiet(Command::new("curl.exe").args([
        "-sS", "-m", "20", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@-", "-w", "\n%{http_code}", url,
    ]))
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .context("could not start curl.exe (needs Windows 10 1803 or newer)")?;
    child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?.write_all(body.as_bytes())?;
    let out = child.wait_with_output()?;
    if !out.status.success() && out.stdout.is_empty() {
        bail!("could not reach the server: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let (body, code) = text.rsplit_once('\n').unwrap_or(("", "0"));
    Ok((code.trim().parse().unwrap_or(0), body.to_string()))
}

/// Exchanges the invite for a device credential and stores it. Blocking; call from spawn_blocking.
pub fn enroll(link: &Link, hostname: &str) -> anyhow::Result<Enrollment> {
    let body = serde_json::json!({ "token": link.token, "platform": "win", "hostname": hostname }).to_string();
    let (status, resp) = post_json(&format!("{}/api/enroll", link.server), &body)?;
    let v: serde_json::Value = serde_json::from_str(&resp).unwrap_or_default();
    if status != 200 {
        bail!("{}", v.get("error").and_then(|e| e.as_str()).map(String::from).unwrap_or(format!("the server refused the invite (HTTP {status})")));
    }
    let e: Enrollment = serde_json::from_value(v).context("unexpected reply from the server")?;
    save(&e)?;
    Ok(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_invite_page_link() {
        let l = parse_link("remoteaccess://enroll?token=abc-DEF_123&server=http%3A%2F%2F10.1.2.3%3A8080").unwrap();
        assert_eq!(l, Link { token: "abc-DEF_123".into(), server: "http://10.1.2.3:8080".into() });
        assert_eq!(host_of(&l.server), "10.1.2.3:8080");
    }

    #[test]
    fn rejects_other_links() {
        assert!(parse_link("https://evil.example/enroll?token=a&server=http%3A%2F%2Fx").is_none());
        assert!(parse_link("remoteaccess://enroll?token=a").is_none());
        assert!(parse_link("remoteaccess://enroll?token=&server=http%3A%2F%2Fx").is_none());
        assert!(parse_link("remoteaccess://enroll?token=a&server=ftp%3A%2F%2Fx").is_none());
        assert!(parse_link("remoteaccess://other?token=a&server=http%3A%2F%2Fx").is_none());
    }
}
