//! Product-owned consent prompt (PROTOCOL.md §4.2) with a 30 s timeout = deny.
//!
//! Uses user32's MessageBoxTimeoutW: undocumented but present and stable since
//! Windows XP. It gives a native, always-on-top Yes/No box with a built-in
//! timeout and no custom window code. Default button is "No" so consent
//! always needs a deliberate click. A branded dialog can replace this later.
use crate::protocol::Scope;
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    IDYES, MB_DEFBUTTON2, MB_ICONQUESTION, MB_SETFOREGROUND, MB_SYSTEMMODAL, MB_TOPMOST, MB_YESNO,
};

pub const TIMEOUT_SECS: u32 = 30;
const MB_TIMEDOUT: i32 = 32000;

#[link(name = "user32")]
extern "system" {
    fn MessageBoxTimeoutW(hwnd: HWND, text: *const u16, caption: *const u16, utype: u32, lang: u16, ms: u32) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Blocks until the user answers or the timeout elapses. Returns true only for Yes.
/// Call from a blocking thread (tokio::task::spawn_blocking).
pub fn ask(operator: &str, reason: &str, scope: Scope) -> bool {
    let what = if scope == Scope::Control { "view and control your screen" } else { "view your screen" };
    let reason = if reason.is_empty() { "No reason given.".to_string() } else { format!("Reason: {reason}") };
    let text = format!(
        "{operator} wants to {what}.\n\n{reason}\n\nThe session will be recorded. You can end it at any time from the red banner.\n\n\
         Allow this remote session?  (Automatically denied in {TIMEOUT_SECS} seconds.)"
    );
    let (text, caption) = (wide(&text), wide("Remote Access request"));
    let flags = MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_TOPMOST | MB_SETFOREGROUND | MB_SYSTEMMODAL;
    let r = unsafe {
        MessageBoxTimeoutW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), flags as u32, 0, TIMEOUT_SECS * 1000)
    };
    if r == MB_TIMEDOUT {
        eprintln!("consent timed out → deny");
    }
    r == IDYES as i32
}
