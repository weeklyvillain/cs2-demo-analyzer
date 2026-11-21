//! Win32 window tracking, in Rust in place of Electron's C++ addon
//! (`electron/native-addon/src/cs2_window_tracker.cpp`): finding the CS2 process and
//! window, client bounds on screen, minimized / foreground state, force-activation,
//! `SetWinEventHook` events on a message-loop thread, and the overlay window styles
//! (click-through, opacity, topmost placement) plus global hotkeys via `RegisterHotKey`.
//!
//! Window handles are passed around as `isize` so they can cross threads.

use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};

use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, RegisterHotKey, UnregisterHotKey,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, DispatchMessageW, EnumWindows, GWL_EXSTYLE, GetClientRect, GetCursorPos, GetForegroundWindow,
    GetMessageW, GetWindowLongPtrW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, HWND_TOPMOST, IsIconic,
    IsWindow, IsWindowVisible, LWA_ALPHA, MSG, PostThreadMessageW, SW_HIDE, SW_RESTORE, SW_SHOWNOACTIVATE,
    SWP_ASYNCWINDOWPOS, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetForegroundWindow, SetLayeredWindowAttributes, SetWindowLongPtrW,
    GWL_STYLE, SetWindowPos, ShowWindow, ShowWindowAsync, TranslateMessage, WM_HOTKEY, WM_QUIT, WS_BORDER, WS_CAPTION,
    WS_DLGFRAME, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
};
use windows::core::BOOL;

const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
const EVENT_SYSTEM_MOVESIZESTART: u32 = 0x000A;
const EVENT_SYSTEM_MOVESIZEEND: u32 = 0x000B;
const EVENT_SYSTEM_MINIMIZESTART: u32 = 0x0016;
const EVENT_SYSTEM_MINIMIZEEND: u32 = 0x0017;
const EVENT_OBJECT_DESTROY: u32 = 0x8001;
const EVENT_OBJECT_LOCATIONCHANGE: u32 = 0x800B;
const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;
const WINEVENT_SKIPOWNPROCESS: u32 = 0x0002;
const OBJID_WINDOW: i32 = 0;
const CHILDID_SELF: i32 = 0;

fn hwnd(h: isize) -> HWND {
    HWND(h as *mut core::ffi::c_void)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

// ---------- processes & windows ----------

/// PID of the first running process with this executable name (case-insensitive).
pub fn find_process_id_by_name(name: &str) -> Option<u32> {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = None;
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case(name) {
                    found = Some(entry.th32ProcessID);
                    break;
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

struct EnumData {
    pid: u32,
    best: isize,
    best_area: i64,
}

unsafe extern "system" fn enum_proc(h: HWND, lparam: LPARAM) -> BOOL {
    let data = unsafe { &mut *(lparam.0 as *mut EnumData) };
    unsafe {
        if !IsWindowVisible(h).as_bool() {
            return true.into();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        if pid != data.pid {
            return true.into();
        }
        if GetWindowLongPtrW(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW.0 as isize != 0 {
            return true.into();
        }
        let mut title = [0u16; 256];
        if GetWindowTextW(h, &mut title) == 0 {
            return true.into();
        }
        let mut r = RECT::default();
        let area = if GetWindowRect(h, &mut r).is_ok() {
            (r.right - r.left) as i64 * (r.bottom - r.top) as i64
        } else {
            0
        };
        if area > data.best_area {
            data.best = h.0 as isize;
            data.best_area = area;
        }
    }
    true.into()
}

/// The process's main window: the largest visible, titled, non-tool window (addon `FindWindowByPid`).
pub fn find_window_by_pid(pid: u32) -> Option<isize> {
    let mut data = EnumData { pid, best: 0, best_area: 0 };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut data as *mut EnumData as isize));
    }
    (data.best != 0).then_some(data.best)
}

/// Client area in physical screen pixels (excludes title bar and borders); falls back to
/// the window rect like the addon.
pub fn client_bounds_on_screen(h: isize) -> Option<Bounds> {
    unsafe {
        let mut r = RECT::default();
        if GetClientRect(hwnd(h), &mut r).is_ok() {
            let mut origin = POINT { x: 0, y: 0 };
            if ClientToScreen(hwnd(h), &mut origin).as_bool() {
                return Some(Bounds { x: origin.x, y: origin.y, width: r.right - r.left, height: r.bottom - r.top });
            }
        }
        let mut w = RECT::default();
        GetWindowRect(hwnd(h), &mut w)
            .ok()
            .map(|_| Bounds { x: w.left, y: w.top, width: w.right - w.left, height: w.bottom - w.top })
    }
}

pub fn is_window(h: isize) -> bool {
    unsafe { IsWindow(Some(hwnd(h))).as_bool() }
}

pub fn is_minimized(h: isize) -> bool {
    unsafe { IsIconic(hwnd(h)).as_bool() }
}

pub fn foreground_pid() -> Option<u32> {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        (pid != 0).then_some(pid)
    }
}

/// Bring a window to the front even from a background process (addon `ForceActivateWindow`:
/// attach to the foreground thread's input, restore if minimized, activate).
pub fn force_activate(h: isize) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let me = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
        if IsIconic(hwnd(h)).as_bool() {
            let _ = ShowWindow(hwnd(h), SW_RESTORE);
        }
        let ok = SetForegroundWindow(hwnd(h)).as_bool();
        let _ = BringWindowToTop(hwnd(h));
        if attached {
            let _ = AttachThreadInput(me, fg_thread, false);
        }
        ok
    }
}

pub fn cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok().map(|_| (p.x, p.y)) }
}

// ---------- the overlay window itself ----------

/// Layered + tool + no-activate always; `WS_EX_TRANSPARENT` toggles click-through
/// (Electron `setIgnoreMouseEvents`). Layered also gives the window-wide opacity.
pub fn set_click_through(h: isize, click_through: bool) {
    unsafe {
        let mut ex = GetWindowLongPtrW(hwnd(h), GWL_EXSTYLE);
        ex |= (WS_EX_LAYERED.0 | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) as isize;
        if click_through {
            ex |= WS_EX_TRANSPARENT.0 as isize;
        } else {
            ex &= !(WS_EX_TRANSPARENT.0 as isize);
        }
        SetWindowLongPtrW(hwnd(h), GWL_EXSTYLE, ex);
    }
}

/// Window-wide opacity 0..=1 (Electron `setOpacity`). Needs the layered style.
pub fn set_opacity(h: isize, opacity: f32) {
    let alpha = (opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
    unsafe {
        let _ = SetLayeredWindowAttributes(hwnd(h), windows::Win32::Foundation::COLORREF(0), alpha, LWA_ALPHA);
    }
}

// Changes to the overlay's own window are posted to its thread (async variants) instead of
// applied in place: the overlay window belongs to GPUI's thread, and a synchronous
// SetWindowPos/ShowWindow from inside a GPUI update delivers WM_SIZE / WM_SHOWWINDOW while
// GPUI's app state is in use, so GPUI drops the new size. Posted, they arrive from GPUI's
// message loop like any user resize.

/// Place the overlay over `b` (physical pixels), topmost, without activating it. Call from
/// a thread other than the window's (the tracker thread) so the request is posted.
pub fn set_bounds(h: isize, b: Bounds) {
    unsafe {
        let _ = SetWindowPos(hwnd(h), Some(HWND_TOPMOST), b.x, b.y, b.width, b.height, SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
    }
}

pub fn show_inactive(h: isize) {
    unsafe {
        let _ = ShowWindowAsync(hwnd(h), SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(
            hwnd(h),
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_ASYNCWINDOWPOS,
        );
    }
}

pub fn hide(h: isize) {
    unsafe {
        let _ = ShowWindowAsync(hwnd(h), SW_HIDE);
    }
}

/// Make the overlay a bare popup (no border or caption) so its client area is the whole
/// window, like Electron's `frame: false`. The frame change itself is applied from a
/// short-lived thread so it is posted rather than handled inside a GPUI update.
pub fn make_frameless(h: isize) {
    unsafe {
        let style = GetWindowLongPtrW(hwnd(h), GWL_STYLE);
        let strip = (WS_CAPTION.0 | WS_THICKFRAME.0 | WS_BORDER.0 | WS_DLGFRAME.0 | WS_SYSMENU.0) as isize;
        SetWindowLongPtrW(hwnd(h), GWL_STYLE, (style & !strip) | WS_POPUP.0 as isize);
    }
    std::thread::spawn(move || unsafe {
        let _ = SetWindowPos(
            hwnd(h),
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        );
    });
}

pub fn is_visible(h: isize) -> bool {
    unsafe { IsWindowVisible(hwnd(h)).as_bool() }
}

pub fn client_origin(h: isize) -> Option<(i32, i32)> {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { ClientToScreen(hwnd(h), &mut p).as_bool().then_some((p.x, p.y)) }
}

// ---------- WinEvent hooks ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WinEvent {
    LocationChange(isize),
    MoveStart(isize),
    MoveEnd(isize),
    MinimizeStart(isize),
    MinimizeEnd(isize),
    Destroy(isize),
    /// Some window became foreground; its process id.
    Foreground(u32),
}

/// Where the hook callback delivers events, and which process it filters on.
static HOOK_SINK: Mutex<Option<(u32, Sender<WinEvent>)>> = Mutex::new(None);

unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    h: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if id_object != OBJID_WINDOW || id_child != CHILDID_SELF {
        return;
    }
    let Ok(guard) = HOOK_SINK.lock() else { return };
    let Some((target, tx)) = guard.as_ref() else { return };
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    let raw = h.0 as isize;
    let ev = match event {
        EVENT_SYSTEM_FOREGROUND => WinEvent::Foreground(pid),
        _ if pid != *target => return,
        EVENT_OBJECT_LOCATIONCHANGE => WinEvent::LocationChange(raw),
        EVENT_SYSTEM_MOVESIZESTART => WinEvent::MoveStart(raw),
        EVENT_SYSTEM_MOVESIZEEND => WinEvent::MoveEnd(raw),
        EVENT_SYSTEM_MINIMIZESTART => WinEvent::MinimizeStart(raw),
        EVENT_SYSTEM_MINIMIZEEND => WinEvent::MinimizeEnd(raw),
        EVENT_OBJECT_DESTROY => WinEvent::Destroy(raw),
        _ => return,
    };
    let _ = tx.send(ev);
}

/// A thread running the four WinEvent hooks of the addon with its own message loop.
/// Dropping it unhooks and ends the thread.
pub struct HookThread {
    thread_id: u32,
    join: Option<std::thread::JoinHandle<()>>,
}

impl HookThread {
    pub fn start(pid: u32) -> (HookThread, Receiver<WinEvent>) {
        let (tx, rx) = channel();
        *HOOK_SINK.lock().unwrap() = Some((pid, tx));
        let (id_tx, id_rx) = channel();
        let join = std::thread::spawn(move || unsafe {
            let _ = id_tx.send(GetCurrentThreadId());
            let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
            // The C++ addon registered LOCATIONCHANGE..DESTROY (0x800B..0x8001), a backwards
            // range Windows ignores, so it never saw location changes. Here each event gets its
            // own hook, scoped to the target process except foreground (needs every process).
            let hook = |min: u32, max: u32, process: u32| SetWinEventHook(min, max, None, Some(win_event_proc), process, 0, flags);
            let hooks = [
                hook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, pid),
                hook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY, pid),
                hook(EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND, pid),
                hook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, pid),
                hook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0),
            ];
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            for h in hooks {
                if !h.0.is_null() {
                    let _ = UnhookWinEvent(h);
                }
            }
        });
        let thread_id = id_rx.recv().unwrap_or(0);
        (HookThread { thread_id, join: Some(join) }, rx)
    }
}

impl Drop for HookThread {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
        if let Ok(mut sink) = HOOK_SINK.lock() {
            *sink = None;
        }
    }
}

// ---------- global hotkey ----------

/// Electron accelerator (`CommandOrControl+Shift+O`) → `RegisterHotKey` modifiers + virtual key.
pub fn parse_accelerator(acc: &str) -> Option<(HOT_KEY_MODIFIERS, u32)> {
    let mut mods = MOD_NOREPEAT;
    let mut key = None;
    for part in acc.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" | "control" | "ctrl" | "command" | "cmd" => mods |= MOD_CONTROL,
            "alt" | "option" => mods |= MOD_ALT,
            "shift" => mods |= MOD_SHIFT,
            "super" | "meta" | "win" => mods |= MOD_WIN,
            other => key = Some(vk_for(other)?),
        }
    }
    Some((mods, key?))
}

fn vk_for(key: &str) -> Option<u32> {
    let k = key.to_ascii_lowercase();
    if k.len() == 1 {
        let c = k.as_bytes()[0];
        return match c {
            b'a'..=b'z' => Some((c - b'a' + 0x41) as u32),
            b'0'..=b'9' => Some((c - b'0' + 0x30) as u32),
            _ => None,
        };
    }
    if let Some(n) = k.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
        return (1..=24).contains(&n).then_some(0x70 + n - 1);
    }
    Some(match k.as_str() {
        "space" => 0x20,
        "tab" => 0x09,
        "enter" | "return" => 0x0D,
        "escape" | "esc" => 0x1B,
        "backspace" => 0x08,
        "delete" => 0x2E,
        "insert" => 0x2D,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "up" | "arrowup" => 0x26,
        "down" | "arrowdown" => 0x28,
        "left" | "arrowleft" => 0x25,
        "right" | "arrowright" => 0x27,
        _ => return None,
    })
}

/// A registered global hotkey on its own message-loop thread. Each press sends `()`.
pub struct HotkeyThread {
    thread_id: u32,
    join: Option<std::thread::JoinHandle<()>>,
}

impl HotkeyThread {
    /// Register `accelerator`; `Err` when it can't be parsed or Windows refuses it (taken).
    pub fn start(accelerator: &str) -> Result<(HotkeyThread, Receiver<()>), String> {
        let (mods, vk) = parse_accelerator(accelerator).ok_or_else(|| format!("Unsupported hotkey: {accelerator}"))?;
        let (tx, rx) = channel();
        let (ready_tx, ready_rx) = channel::<Result<u32, String>>();
        let acc = accelerator.to_string();
        let join = std::thread::spawn(move || unsafe {
            if RegisterHotKey(None, 1, mods, vk).is_err() {
                let _ = ready_tx.send(Err(format!("Failed to register hotkey: {acc}")));
                return;
            }
            let _ = ready_tx.send(Ok(GetCurrentThreadId()));
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.message == WM_HOTKEY && tx.send(()).is_err() {
                    break;
                }
            }
            let _ = UnregisterHotKey(None, 1);
        });
        match ready_rx.recv() {
            Ok(Ok(thread_id)) => Ok((HotkeyThread { thread_id, join: Some(join) }, rx)),
            Ok(Err(e)) => {
                let _ = join.join();
                Err(e)
            }
            Err(_) => Err("hotkey thread failed".into()),
        }
    }
}

impl Drop for HotkeyThread {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{find_process_id_by_name, parse_accelerator, vk_for};
    use windows::Win32::UI::Input::KeyboardAndMouse::{MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT};

    #[test]
    fn parses_electron_accelerators() {
        assert_eq!(parse_accelerator("CommandOrControl+Shift+O"), Some((MOD_NOREPEAT | MOD_CONTROL | MOD_SHIFT, 0x4F)));
        assert_eq!(vk_for("F10"), Some(0x79));
        assert_eq!(vk_for("Up"), Some(0x26));
        assert_eq!(parse_accelerator("Control+Shift"), None);
    }

    #[test]
    fn finds_own_process() {
        let me = std::env::current_exe().unwrap();
        let name = me.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(find_process_id_by_name(&name), Some(std::process::id()));
    }
}
