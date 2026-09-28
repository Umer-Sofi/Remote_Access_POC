//! Data channel → SendInput injection (spec §8.5 step 8). Platform-specific step.
//!
//! Coordinates: the process is per-monitor DPI aware (see main.rs), so
//! GetSystemMetrics returns real pixels of the primary display. Fractions go
//! through the shared to_pixels() and are then mapped to SendInput's absolute
//! 0..65535 space.
//!
//! Limits in user context (later phase, behind PrivilegeProvider):
//!  * UIPI: input cannot reach windows of elevated (admin) processes.
//!  * Ctrl-Alt-Del: Windows ignores a synthetic SAS; real SAS needs SendSAS
//!    from a SYSTEM service.
use crate::generated::win_vk;
use crate::protocol::{to_pixels, InputMessage, MouseButton, Scope};
use std::collections::HashSet;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

pub struct Injector {
    scope: Scope,
    keys_down: HashSet<(u16, bool)>,
    buttons_down: HashSet<MouseButton>,
}

impl Injector {
    pub fn new() -> Self {
        Injector { scope: Scope::View, keys_down: HashSet::new(), buttons_down: HashSet::new() }
    }

    pub fn set_scope(&mut self, s: Scope) {
        self.scope = s;
        if s == Scope::View {
            self.release_all(); // PROTOCOL.md §4.6
        }
    }

    pub fn handle(&mut self, data: &[u8]) {
        let Some(msg) = InputMessage::parse(data) else { return };
        if let InputMessage::Scope(s) = msg {
            // Informational only: a downgrade may be applied, an upgrade NEVER (PROTOCOL.md §3).
            if s == Scope::View {
                self.set_scope(Scope::View);
            }
            return;
        }
        if self.scope != Scope::Control {
            return;
        }
        match msg {
            InputMessage::MouseMove { x, y } => {
                let (w, h) = screen_size();
                let (px, py) = to_pixels(x, y, w, h);
                let ax = (px as i64 * 65535 / (w - 1).max(1) as i64) as i32;
                let ay = (py as i64 * 65535 / (h - 1).max(1) as i64) as i32;
                send(&[mouse(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE)]);
            }
            InputMessage::MouseButton { button, down } => {
                let flag = match (button, down) {
                    (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
                    (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
                    (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
                    (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
                    (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
                    (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
                };
                if down {
                    self.buttons_down.insert(button);
                } else {
                    self.buttons_down.remove(&button);
                }
                // Windows derives double-clicks from timing itself; no click count needed.
                send(&[mouse(0, 0, 0, flag)]);
            }
            InputMessage::Wheel { dx, dy } => {
                // DOM: +dy = scroll down. Windows: positive wheel delta = scroll up.
                let mut ev = Vec::new();
                if dy != 0 {
                    ev.push(mouse(0, 0, (-dy) as u32, MOUSEEVENTF_WHEEL));
                }
                if dx != 0 {
                    ev.push(mouse(0, 0, dx as u32, MOUSEEVENTF_HWHEEL));
                }
                send(&ev);
            }
            InputMessage::Key { code, down, .. } => {
                // Modifiers arrive as their own kb events (ControlLeft etc.), so
                // `mods` is not needed on Windows; the OS tracks modifier state.
                let Some((vk, ext)) = win_vk(&code) else { return };
                if down {
                    self.keys_down.insert((vk, ext));
                } else {
                    self.keys_down.remove(&(vk, ext));
                }
                send(&[key(vk, ext, down)]);
            }
            InputMessage::Command(name) if name == "ctrl-alt-del" => {
                // Best effort in user context; see module docs.
                eprintln!("ctrl-alt-del: sending combo (real SAS needs the later-phase SYSTEM service)");
                send(&[
                    key(VK_LCONTROL, false, true),
                    key(VK_LMENU, false, true),
                    key(VK_DELETE, true, true),
                    key(VK_DELETE, true, false),
                    key(VK_LMENU, false, false),
                    key(VK_LCONTROL, false, false),
                ]);
            }
            InputMessage::Command(name) if name == "release-all" => self.release_all(),
            _ => {}
        }
    }

    pub fn release_all(&mut self) {
        let keys: Vec<_> = self.keys_down.drain().map(|(vk, ext)| key(vk, ext, false)).collect();
        send(&keys);
        let buttons: Vec<_> = self
            .buttons_down
            .drain()
            .map(|b| {
                mouse(0, 0, 0, match b {
                    MouseButton::Left => MOUSEEVENTF_LEFTUP,
                    MouseButton::Right => MOUSEEVENTF_RIGHTUP,
                    MouseButton::Middle => MOUSEEVENTF_MIDDLEUP,
                })
            })
            .collect();
        send(&buttons);
    }
}

pub fn screen_size() -> (i32, i32) {
    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
}

fn mouse(dx: i32, dy: i32, data: u32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    let mut i: INPUT = unsafe { std::mem::zeroed() };
    i.r#type = INPUT_MOUSE;
    i.Anonymous.mi = MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 };
    i
}

fn key(vk: u16, extended: bool, down: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    let mut flags: KEYBD_EVENT_FLAGS = 0;
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    let mut i: INPUT = unsafe { std::mem::zeroed() };
    i.r#type = INPUT_KEYBOARD;
    i.Anonymous.ki = KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 };
    i
}

fn send(inputs: &[INPUT]) {
    if inputs.is_empty() {
        return;
    }
    let n = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
    if n as usize != inputs.len() {
        eprintln!("SendInput injected {n}/{} events (UIPI may be blocking an elevated window)", inputs.len());
    }
}
