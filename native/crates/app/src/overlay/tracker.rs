//! Keeps the overlay window over the CS2 window (Electron `cs2OverlayTracker.ts`).
//!
//! Same rules as Electron: the overlay shows when CS2 isn't minimized and either the user
//! toggled it on, CS2 is in front and not being dragged, the overlay itself is in front, or
//! we're in the 500 ms hand-back after leaving interactive mode. It hides while CS2 is being
//! moved/resized (like Discord) and when CS2 is minimized. Bounds updates are throttled
//! (location changes ~10/s, moves 60/s, never more than 20 SetWindowPos/s for small changes).

use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use super::win32::{self, Bounds, HookThread, WinEvent};

const UPDATE_THROTTLE: Duration = Duration::from_millis(8);
const UPDATE_THROTTLE_ACTIVE: Duration = Duration::from_millis(16);
const LOCATION_CHANGE_THROTTLE: Duration = Duration::from_millis(100);
const MIN_SETBOUNDS_INTERVAL: Duration = Duration::from_millis(50);
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const HANDOFF: Duration = Duration::from_millis(500);

pub struct Tracker {
    pub pid: u32,
    pub cs2: isize,
    overlay: isize,
    own_pid: u32,
    moving: bool,
    pub cs2_foreground: bool,
    pub minimized: bool,
    interactive: bool,
    explicitly_shown: bool,
    /// Hidden with the hotkey: stays hidden even while CS2 is in front (Electron re-showed
    /// it on the next location change, so the hotkey couldn't hide it in-game).
    hidden_by_user: bool,
    handoff_until: Option<Instant>,
    last_bounds: Option<Bounds>,
    last_update: Instant,
    last_set_bounds: Instant,
    /// A coalesced bounds update waiting until this time.
    pending: Option<Instant>,
    last_health: Instant,
    /// Set when the overlay was moved/resized or shown since the last `take_moved`.
    moved: bool,
    _hook: HookThread,
    events: Receiver<WinEvent>,
}

/// What the overlay should do after a tick.
#[derive(Debug, PartialEq, Eq)]
pub enum TickResult {
    Tracking,
    /// CS2's window or process is gone: stop tracking and hide.
    Lost,
}

impl Tracker {
    /// Start tracking an already-found CS2 window (`startTrackingCs2ForDemo` after the wait).
    pub fn start(pid: u32, cs2: isize, overlay: isize, interactive: bool, explicitly_shown: bool) -> Tracker {
        let (hook, events) = HookThread::start(pid);
        let past = Instant::now() - Duration::from_secs(1);
        let mut t = Tracker {
            pid,
            cs2,
            overlay,
            own_pid: std::process::id(),
            moving: false,
            cs2_foreground: win32::foreground_pid() == Some(pid),
            minimized: win32::is_minimized(cs2),
            interactive,
            explicitly_shown,
            hidden_by_user: false,
            handoff_until: None,
            last_bounds: None,
            last_update: past,
            last_set_bounds: past,
            pending: None,
            last_health: Instant::now(),
            moved: false,
            _hook: hook,
            events,
        };
        t.sync_bounds();
        // Electron re-checks foreground 100 ms later in case it changed during hook setup.
        t.pending = Some(Instant::now() + Duration::from_millis(100));
        t
    }

    /// Whether the overlay window moved, resized or appeared since the last call.
    pub fn take_moved(&mut self) -> bool {
        std::mem::take(&mut self.moved)
    }

    /// `Some(true)` forced on, `Some(false)` hidden by the user, `None` automatic.
    pub fn set_user_visibility(&mut self, v: Option<bool>) {
        self.explicitly_shown = v == Some(true);
        self.hidden_by_user = v == Some(false);
        if self.hidden_by_user {
            win32::hide(self.overlay);
        } else {
            self.sync_bounds();
        }
    }

    /// Leaving interactive mode hands focus back to CS2 with a 500 ms grace period
    /// (`setOverlayInteractive`); entering it just makes sure the overlay is up.
    pub fn set_interactive(&mut self, interactive: bool) {
        if self.interactive && !interactive {
            self.handoff_until = Some(Instant::now() + HANDOFF);
            win32::force_activate(self.cs2);
        }
        self.interactive = interactive;
        if interactive && self.cs2_foreground && !self.minimized && !self.moving {
            self.sync_bounds();
            if !win32::is_visible(self.overlay) {
                win32::show_inactive(self.overlay);
            }
        }
    }

    /// Process hook events, run due updates and the health check. Call every frame.
    pub fn tick(&mut self, now: Instant) -> TickResult {
        while let Ok(ev) = self.events.try_recv() {
            if self.handle(ev, now) == TickResult::Lost {
                return TickResult::Lost;
            }
        }
        if self.pending.is_some_and(|at| now >= at) {
            self.pending = None;
            self.sync_bounds();
        }
        if now.duration_since(self.last_health) >= HEALTH_CHECK_INTERVAL {
            self.last_health = now;
            // Electron: the window must still exist and still be the process's main window.
            if !win32::is_window(self.cs2) || win32::find_window_by_pid(self.pid) != Some(self.cs2) {
                return TickResult::Lost;
            }
            // Not in Electron: re-apply the show/hide rules once a second, so a foreground
            // change that was read mid-switch can't leave the overlay hidden (or shown).
            if !self.moving {
                self.sync_bounds();
            }
        }
        TickResult::Tracking
    }

    fn handle(&mut self, ev: WinEvent, now: Instant) -> TickResult {
        match ev {
            WinEvent::Foreground(pid) => {
                let cs2_fg = pid == self.pid;
                let overlay_fg = pid == self.own_pid;
                self.cs2_foreground = cs2_fg;
                self.minimized = win32::is_minimized(self.cs2);
                if cs2_fg {
                    if !self.minimized && !self.moving {
                        self.sync_bounds();
                    } else if !self.explicitly_shown {
                        win32::hide(self.overlay);
                    }
                } else if overlay_fg {
                    if self.minimized && !self.explicitly_shown {
                        win32::hide(self.overlay);
                    } else {
                        self.sync_bounds();
                    }
                } else if self.minimized || !self.explicitly_shown {
                    win32::hide(self.overlay);
                } else {
                    self.sync_bounds();
                }
            }
            WinEvent::Destroy(_) => {
                // The addon reports destroys for any window of the process; only ours matters.
                if !win32::is_window(self.cs2) {
                    return TickResult::Lost;
                }
            }
            WinEvent::LocationChange(h) if h == self.cs2 => {
                if !self.moving && self.cs2_foreground && !self.minimized {
                    let since = now.duration_since(self.last_update);
                    if since >= LOCATION_CHANGE_THROTTLE {
                        self.schedule(now);
                    } else if self.pending.is_none() {
                        self.pending = Some(now + (LOCATION_CHANGE_THROTTLE - since));
                    }
                }
            }
            WinEvent::MoveStart(h) if h == self.cs2 => {
                self.moving = true;
                win32::hide(self.overlay);
            }
            WinEvent::MoveEnd(h) if h == self.cs2 => {
                self.moving = false;
                if self.cs2_foreground && !self.minimized {
                    self.sync_bounds();
                }
            }
            WinEvent::MinimizeStart(h) if h == self.cs2 => {
                self.minimized = true;
                win32::hide(self.overlay);
            }
            WinEvent::MinimizeEnd(h) if h == self.cs2 => {
                self.minimized = false;
                if (self.cs2_foreground && !self.moving) || self.explicitly_shown {
                    self.sync_bounds();
                }
            }
            _ => {}
        }
        TickResult::Tracking
    }

    /// `scheduleBoundsUpdate`: coalesce updates to 60 fps while CS2 is active, 120 otherwise.
    fn schedule(&mut self, now: Instant) {
        if self.moving {
            self.sync_bounds();
            return;
        }
        if self.pending.is_some() {
            return;
        }
        let throttle = if self.cs2_foreground && !self.minimized { UPDATE_THROTTLE_ACTIVE } else { UPDATE_THROTTLE };
        let since = now.duration_since(self.last_update);
        if since >= throttle {
            self.sync_bounds();
        } else {
            self.pending = Some(now + (throttle - since));
        }
    }

    /// Whether the overlay should be up right now (Electron's `shouldShow`).
    fn should_show(&mut self, overlay_fg: bool, now: Instant) -> bool {
        let in_handoff = self.handoff_until.is_some_and(|t| now < t);
        if self.handoff_until.is_some_and(|t| now >= t) {
            self.handoff_until = None;
        }
        !self.minimized
            && !self.hidden_by_user
            && (self.explicitly_shown || (self.cs2_foreground && !self.moving) || overlay_fg || in_handoff)
    }

    pub fn sync_bounds(&mut self) {
        let now = Instant::now();
        self.minimized = win32::is_minimized(self.cs2);
        let fg = win32::foreground_pid();
        self.cs2_foreground = fg == Some(self.pid);
        let overlay_fg = fg == Some(self.own_pid);
        if !self.should_show(overlay_fg, now) {
            if win32::is_visible(self.overlay) {
                win32::hide(self.overlay);
            }
            return;
        }
        if !win32::is_visible(self.overlay) {
            win32::show_inactive(self.overlay);
            self.moved = true;
        }
        let Some(b) = win32::client_bounds_on_screen(self.cs2) else { return };
        let tolerance = if self.cs2_foreground && !self.minimized { 8 } else { 1 };
        let diff = |a: &Bounds| {
            [(a.x - b.x).abs(), (a.y - b.y).abs(), (a.width - b.width).abs(), (a.height - b.height).abs()]
                .into_iter()
                .max()
                .unwrap_or(0)
        };
        let last_diff = self.last_bounds.as_ref().map(diff);
        if last_diff.is_some_and(|d| d < tolerance) {
            return;
        }
        let big_change = last_diff.is_none_or(|d| d >= 16);
        if !big_change && now.duration_since(self.last_set_bounds) < MIN_SETBOUNDS_INTERVAL {
            return;
        }
        // Physical pixels straight through; Electron converted to DIPs for setBounds.
        win32::set_bounds(self.overlay, b);
        self.moved = true;
        self.last_bounds = Some(b);
        self.last_update = now;
        self.last_set_bounds = now;
    }
}

// ---------- running on its own thread ----------

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};

enum Cmd {
    Interactive(bool),
    UserVisibility(Option<bool>),
    Stop,
}

/// The tracker on its own thread (like Electron's main-process tracker): window changes are
/// made from off the GPUI thread, so they're posted to the overlay window instead of being
/// applied in the middle of a GPUI update.
pub struct TrackerHandle {
    cmds: Sender<Cmd>,
    moved: Arc<AtomicBool>,
    lost: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl TrackerHandle {
    pub fn start(pid: u32, cs2: isize, overlay: isize, interactive: bool, user: Option<bool>) -> TrackerHandle {
        let (cmds, rx) = channel::<Cmd>();
        let moved = Arc::new(AtomicBool::new(false));
        let lost = Arc::new(AtomicBool::new(false));
        let (m, l) = (moved.clone(), lost.clone());
        let join = std::thread::spawn(move || {
            let mut t = Tracker::start(pid, cs2, overlay, interactive, user == Some(true));
            if user == Some(false) {
                t.set_user_visibility(user);
            }
            loop {
                for cmd in rx.try_iter() {
                    match cmd {
                        Cmd::Interactive(v) => t.set_interactive(v),
                        Cmd::UserVisibility(v) => t.set_user_visibility(v),
                        Cmd::Stop => return,
                    }
                }
                if t.tick(Instant::now()) == TickResult::Lost {
                    win32::hide(overlay);
                    l.store(true, Ordering::Release);
                    return;
                }
                if t.take_moved() {
                    m.store(true, Ordering::Release);
                }
                std::thread::sleep(Duration::from_millis(8));
            }
        });
        TrackerHandle { cmds, moved, lost, join: Some(join) }
    }

    pub fn set_interactive(&self, v: bool) {
        let _ = self.cmds.send(Cmd::Interactive(v));
    }

    pub fn set_user_visibility(&self, v: Option<bool>) {
        let _ = self.cmds.send(Cmd::UserVisibility(v));
    }

    /// The overlay moved/resized/appeared since the last call (GPUI should redraw).
    pub fn take_moved(&self) -> bool {
        self.moved.swap(false, Ordering::AcqRel)
    }

    /// CS2's window or process went away; tracking has stopped.
    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::Acquire)
    }
}

impl Drop for TrackerHandle {
    fn drop(&mut self) {
        let _ = self.cmds.send(Cmd::Stop);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}
