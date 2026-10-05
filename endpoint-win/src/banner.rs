//! Non-suppressible session banner for Windows (spec §8.5 step 7, acceptance
//! criterion 4). The macOS equivalent is endpoint-mac/.../Banner.swift.
//!
//! A red, always-on-top tool window pinned to the top-centre of the primary
//! display, showing who is connected, whether they have control, and an
//! "End session" button. "Non-suppressible" in practice:
//!   * it is a tool window (not in the taskbar or Alt-Tab) with no close box;
//!   * WM_CLOSE is ignored, so Alt-F4 cannot dismiss it;
//!   * it re-asserts HWND_TOPMOST every second so nothing stays above it;
//!   * the only ways it goes away are the End session button (which ends the
//!     session) or killing the process (which drops the broker link and so
//!     also ends the session).
//!
//! The window lives on its own thread with its own message loop. Other threads
//! only ever talk to it with PostMessage, which is safe cross-thread; all UI
//! mutation happens inside the window procedure on the UI thread.
use crate::protocol::Scope;
use crate::SessionIndicator;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;
use tokio::sync::mpsc::UnboundedSender;
use windows_sys::core::PCWSTR;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{CreateSolidBrush, SetBkMode, SetTextColor, HBRUSH, HDC, TRANSPARENT};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const WIDTH: i32 = 580;
const HEIGHT: i32 = 40;
const ID_END: usize = 1001;
const ID_LABEL: usize = 1002;
const WM_APP_UPDATE: u32 = WM_APP + 1; // re-read LABEL and apply it
const WM_APP_CLOSE: u32 = WM_APP + 2; // tear the window down
const RED: u32 = 0x0033_29D9; // COLORREF is 0x00BBGGRR  (= #D92933)
// Static-control style not exported by windows-sys 0.61; vertically centres the
// label text within the control. Fixed Win32 value (winuser.h).
const SS_CENTERIMAGE: u32 = 0x0000_0200;

// One banner exists at a time, so shared UI state lives in module statics that
// only the window procedure (on the UI thread) reads and writes.
static END_TX: Mutex<Option<UnboundedSender<()>>> = Mutex::new(None);
static LABEL: Mutex<String> = Mutex::new(String::new());
static RED_BRUSH: OnceLock<isize> = OnceLock::new();

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn label_text(operator: &str, scope: Scope) -> String {
    match scope {
        Scope::Control => format!("●  REMOTE SESSION   ·   {operator} can see and control this screen"),
        Scope::View => format!("●  REMOTE SESSION   ·   {operator} can see this screen"),
    }
}

pub struct WindowsBanner {
    on_end: Option<UnboundedSender<()>>,
    hwnd: isize,
    thread: Option<JoinHandle<()>>,
}

impl WindowsBanner {
    pub fn new(on_end: UnboundedSender<()>) -> Self {
        WindowsBanner { on_end: Some(on_end), hwnd: 0, thread: None }
    }

    fn post(&self, msg: u32) {
        if self.hwnd != 0 {
            unsafe { PostMessageW(self.hwnd as HWND, msg, 0, 0) };
        }
    }
}

impl SessionIndicator for WindowsBanner {
    fn show(&mut self, operator: &str, scope: Scope) {
        if self.hwnd != 0 {
            return self.update(operator, scope);
        }
        *END_TX.lock().unwrap() = self.on_end.take();
        *LABEL.lock().unwrap() = label_text(operator, scope);

        // Create the window on its own thread and get its handle back.
        let (tx, rx) = mpsc::channel::<isize>();
        self.thread = Some(std::thread::spawn(move || unsafe { run_window(tx) }));
        self.hwnd = rx.recv().unwrap_or(0);
    }

    fn update(&mut self, operator: &str, scope: Scope) {
        *LABEL.lock().unwrap() = label_text(operator, scope);
        self.post(WM_APP_UPDATE);
    }

    fn hide(&mut self) {
        self.post(WM_APP_CLOSE);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        self.hwnd = 0;
        *END_TX.lock().unwrap() = None;
    }
}

impl Drop for WindowsBanner {
    fn drop(&mut self) {
        if self.hwnd != 0 {
            self.hide();
        }
    }
}

/// Creates the banner window and pumps its message loop until the window is
/// destroyed. Sends the created HWND (or 0 on failure) back to the caller.
unsafe fn run_window(hwnd_tx: mpsc::Sender<isize>) {
    let hinstance = GetModuleHandleW(std::ptr::null());
    let class_name = wide("RemoteAccessBanner");
    RED_BRUSH.get_or_init(|| CreateSolidBrush(RED) as isize);
    let red_brush = *RED_BRUSH.get().unwrap() as HBRUSH;

    let wc = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(wndproc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: hinstance,
        hIcon: std::ptr::null_mut(),
        hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
        hbrBackground: red_brush,
        lpszMenuName: std::ptr::null(),
        lpszClassName: class_name.as_ptr(),
    };
    RegisterClassW(&wc); // harmless if already registered from a previous session

    let screen_w = GetSystemMetrics(SM_CXSCREEN);
    let x = (screen_w - WIDTH) / 2;
    let title = wide("Remote Access");
    let hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        class_name.as_ptr(),
        title.as_ptr(),
        WS_POPUP,
        x,
        8,
        WIDTH,
        HEIGHT,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        hinstance,
        std::ptr::null(),
    );
    if hwnd.is_null() {
        let _ = hwnd_tx.send(0);
        return;
    }

    // Label (left) and End-session button (right), as child controls.
    let static_class = wide("STATIC");
    let button_class = wide("BUTTON");
    let label = LABEL.lock().unwrap().clone();
    create_child(&static_class, &wide(&label), WS_VISIBLE | WS_CHILD | SS_CENTERIMAGE as u32, 14, 8, WIDTH - 150, 24, ID_LABEL, hwnd, hinstance);
    create_child(&button_class, &wide("End session"), WS_VISIBLE | WS_CHILD | BS_PUSHBUTTON as u32, WIDTH - 126, 7, 112, 26, ID_END, hwnd, hinstance);

    SetTimer(hwnd, 1, 1000, None); // re-assert topmost every second
    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    let _ = hwnd_tx.send(hwnd as isize);

    let mut msg: MSG = std::mem::zeroed();
    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn create_child(class: &[u16], text: &[u16], style: u32, x: i32, y: i32, w: i32, h: i32, id: usize, parent: HWND, hinstance: windows_sys::Win32::Foundation::HINSTANCE) {
    CreateWindowExW(
        0,
        class.as_ptr(),
        text.as_ptr(),
        style,
        x,
        y,
        w,
        h,
        parent,
        id as isize as _,
        hinstance,
        std::ptr::null(),
    );
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_COMMAND => {
            if (wparam & 0xFFFF) == ID_END {
                if let Some(tx) = END_TX.lock().unwrap().as_ref() {
                    let _ = tx.send(()); // user ended the session from the banner
                }
            }
            0
        }
        WM_CTLCOLORSTATIC => {
            // White text on the red banner background.
            let hdc = wparam as HDC;
            SetTextColor(hdc, 0x00FF_FFFF);
            SetBkMode(hdc, TRANSPARENT as i32);
            *RED_BRUSH.get().unwrap() as LRESULT
        }
        WM_TIMER => {
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            0
        }
        WM_APP_UPDATE => {
            let label = LABEL.lock().unwrap().clone();
            let child = GetDlgItem(hwnd, ID_LABEL as i32);
            if !child.is_null() {
                SetWindowTextW(child, wide(&label).as_ptr() as PCWSTR);
            }
            0
        }
        WM_CLOSE => 0, // ignore Alt-F4 / any close attempt: non-suppressible
        WM_APP_CLOSE => {
            DestroyWindow(hwnd);
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
