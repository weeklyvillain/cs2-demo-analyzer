//! The in-game overlay (Electron `createOverlayWindow`, `OverlayScreen`, `overlayHoverController`,
//! `cs2OverlayTracker`, the overlay hotkey and `overlay:*` actions), Windows only.
//!
//! A second GPUI window: transparent, borderless, always on top, not in the taskbar, never
//! activated, and click-through except while the cursor is over one of its panels. While a
//! CS2 window is tracked it sits exactly over CS2's client area and follows it.
//!
//! Entry points for the rest of the app:
//! - [`start_tracking`]: attach to CS2 (the "Watch in CS2" launcher calls this with the PID).
//! - [`send_incident`]: show the events list / perspective panel for a match (or clear it).
//! - [`send_commands`]: send console commands to CS2 through netcon, logged for the debug panel.
//! - [`set_enabled`] / [`set_debug_mode`] / [`hotkey_settings`]: used by Settings.

mod hotkey_settings;
mod tracker;
mod view;
pub mod win32;

use std::cell::{Cell, RefCell};
use std::collections::{HashMap};
use std::rc::Rc;
use std::time::{Duration, Instant};

use cs2da_core::settings::Settings;
use cs2da_core::{MatchEvent, RosterPlayer};
use gpui_kit::*;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

pub use hotkey_settings::HotkeySettings;
use tracker::TrackerHandle;
use view::OverlayView;
use win32::HotkeyThread;

pub const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+O";
const HOVER_GRACE: Duration = Duration::from_millis(300);
const CLICK_THROUGH_DELAY: Duration = Duration::from_millis(80);
const FRAME: Duration = Duration::from_millis(16);

/// The process the overlay follows. `CS2DA_OVERLAY_PROCESS` overrides it for testing
/// against another window (e.g. `notepad.exe`).
pub fn target_process() -> String {
    std::env::var("CS2DA_OVERLAY_PROCESS").unwrap_or_else(|_| "cs2.exe".into())
}

/// A player in an incident (Electron `Incident.offender` / `.victim`).
#[derive(Clone, Debug, Default)]
pub struct Person {
    pub name: String,
    // Part of Electron's Incident shape; filled in from events, not needed to spectate.
    #[allow(dead_code)]
    pub steam_id: Option<String>,
    pub user_id: Option<i64>,
    pub entity_index: Option<i64>,
}

/// What the overlay is showing (Electron `Incident`).
#[derive(Clone, Debug, Default)]
pub struct Incident {
    pub match_id: Option<String>,
    pub tick: i64,
    pub event_type: Option<String>,
    pub offender: Person,
    pub victim: Person,
    pub meta: serde_json::Value,
    pub end_tick: Option<i64>,
}

/// Result of a View offender / View victim action, shown as the panel's toast.
#[derive(Clone, Debug)]
pub enum ActionStatus {
    Loading,
    Success(String),
    Error(String),
}

/// The match behind the events list.
pub enum MatchData {
    Loading,
    Ready { events: Vec<MatchEvent>, roster: Vec<RosterPlayer> },
    Failed(String),
}

pub struct Overlay {
    window: Option<WindowHandle<OverlayView>>,
    hwnd: Option<isize>,
    tracker: Option<TrackerHandle>,
    pub incident: Option<Incident>,
    pub match_data: Option<MatchData>,
    /// Events list (true) or the perspective panel (false).
    pub show_events_list: bool,
    pub player_filter: Option<String>,
    pub interactive: bool,
    /// Hotkey state: `Some(true)` shown, `Some(false)` hidden, `None` automatic (follow CS2).
    user_visibility: Option<bool>,
    pub debug_mode: bool,
    pub hotkey: String,
    hotkey_thread: Option<HotkeyThread>,
    hotkey_rx: Option<std::sync::mpsc::Receiver<()>>,
    pub action: Option<ActionStatus>,
    pub spectating: Option<String>,
    pause_timer: Option<Task<()>>,
    /// Interactive panel rects from the last frame, in window coordinates, by panel.
    pub regions: Rc<RefCell<HashMap<&'static str, Bounds<Pixels>>>>,
    /// The overlay window's scale factor (physical px per logical px), set while drawing.
    pub scale: Rc<Cell<f32>>,
    pub hovered: bool,
    hover_left_at: Option<Instant>,
    hover_grace_until: Option<Instant>,
    hotkey_settings: Option<Entity<HotkeySettings>>,
    _loop: Option<Task<()>>,
}

impl EventEmitter<()> for Overlay {}

struct GlobalOverlay(Entity<Overlay>);
impl Global for GlobalOverlay {}

pub fn entity(cx: &App) -> Entity<Overlay> {
    cx.global::<GlobalOverlay>().0.clone()
}

/// Register the overlay hotkey and start the overlay's frame loop.
pub fn init(cx: &mut App) {
    let settings = Settings::open().ok();
    let hotkey = settings
        .as_ref()
        .map(|s| normalize_accelerator(&s.get_or("overlay_hotkey", DEFAULT_HOTKEY)))
        .unwrap_or_else(|| DEFAULT_HOTKEY.into());
    let debug_mode = settings.as_ref().is_some_and(|s| s.get_bool("debugMode", false));
    let overlay = cx.new(|cx| {
        let mut o = Overlay {
            window: None,
            hwnd: None,
            tracker: None,
            incident: None,
            match_data: None,
            show_events_list: false,
            player_filter: None,
            interactive: false,
            user_visibility: None,
            debug_mode,
            hotkey: hotkey.clone(),
            hotkey_thread: None,
            hotkey_rx: None,
            action: None,
            spectating: None,
            pause_timer: None,
            regions: Rc::new(RefCell::new(HashMap::new())),
            scale: Rc::new(Cell::new(1.0)),
            hovered: false,
            hover_left_at: None,
            hover_grace_until: None,
            hotkey_settings: None,
            _loop: None,
        };
        // Electron falls back to the default hotkey when the saved one can't be registered.
        if o.register_hotkey(&hotkey).is_err() && hotkey != DEFAULT_HOTKEY {
            let _ = o.register_hotkey(DEFAULT_HOTKEY);
            o.hotkey = DEFAULT_HOTKEY.into();
            if let Some(s) = &settings {
                let _ = s.set("overlay_hotkey", DEFAULT_HOTKEY);
            }
        }
        o._loop = Some(cx.spawn(async move |this: WeakEntity<Overlay>, cx: &mut AsyncApp| {
            loop {
                cx.background_executor().timer(FRAME).await;
                match this.update(cx, |o, cx| o.frame(cx)) {
                    Ok(true) => cx.update(toggle),
                    Ok(false) => {}
                    Err(_) => break,
                }
            }
        }));
        o
    });
    cx.set_global(GlobalOverlay(overlay));
}

/// Attach to the CS2 process (`pid`, or found by name) and follow its window
/// (`startTrackingCs2ForDemo`: waits up to 15 s for the window, polling every 200 ms).
pub fn start_tracking(pid: Option<u32>, cx: &mut App) {
    let overlay = entity(cx);
    ensure_window(cx);
    cx.spawn(async move |cx: &mut AsyncApp| {
        let process = target_process();
        let deadline = Instant::now() + Duration::from_secs(15);
        let found = loop {
            let pid = pid.or_else(|| win32::find_process_id_by_name(&process));
            if let Some(pid) = pid {
                if let Some(h) = win32::find_window_by_pid(pid) {
                    break Some((pid, h));
                }
            }
            if Instant::now() > deadline {
                break None;
            }
            cx.background_executor().timer(Duration::from_millis(200)).await;
        };
        if let Some((pid, cs2)) = found {
            overlay
                .update(cx, |o, cx| {
                    if let Some(h) = o.hwnd {
                        o.tracker = Some(TrackerHandle::start(pid, cs2, h, o.interactive, o.user_visibility));
                        cx.notify();
                    }
                });
        }
    })
    .detach();
}

/// Show an incident (or clear it with `None`). Showing one makes the overlay interactive
/// and opens the events list, like Electron's `sendIncidentToOverlay`.
// Called by the "Watch in CS2" launcher (cs2:launch sends the match as an incident).
#[allow(dead_code)]
pub fn send_incident(incident: Option<Incident>, cx: &mut App) {
    if incident.is_some() {
        ensure_window(cx);
    }
    entity(cx).update(cx, |o, cx| o.set_incident(incident, cx));
}

/// Send console commands to CS2 over netcon in order, on a background thread. In debug mode
/// each command is added to the overlay's command log (Electron `pushCommand`).
#[allow(dead_code)] // for the "Watch in CS2" launcher, so its commands show in the debug log
pub fn send_commands(cmds: Vec<String>, cx: &mut App) -> Task<anyhow::Result<()>> {
    entity(cx).update(cx, |o, cx| o.send_commands(cmds, cx))
}

/// Settings → Enable overlay. Turning it off closes the overlay (Electron `overlay:close`).
pub fn set_enabled(enabled: bool, cx: &mut App) {
    if !enabled {
        entity(cx).update(cx, |o, cx| o.close(cx));
    }
}

/// Settings → Debug mode: shows the command log panel.
pub fn set_debug_mode(on: bool, cx: &mut App) {
    entity(cx).update(cx, |o, cx| {
        o.debug_mode = on;
        o.refresh_window(cx);
    });
}

/// The hotkey recorder shown in Settings → Overlay.
pub fn hotkey_settings(cx: &mut App) -> Entity<HotkeySettings> {
    let overlay = entity(cx);
    if let Some(e) = overlay.read(cx).hotkey_settings.clone() {
        return e;
    }
    let e = cx.new(HotkeySettings::new);
    overlay.update(cx, |o, _| o.hotkey_settings = Some(e.clone()));
    e
}

/// Open the overlay window if it isn't open yet; returns its HWND. Must run outside any
/// `Overlay` update: GPUI draws a new window right away and the view reads the `Overlay`.
fn ensure_window(cx: &mut App) -> Option<isize> {
    // Electron `createOverlayWindow`: nothing is created while the overlay is off (the default).
    let enabled = cs2da_core::settings::Settings::open().is_ok_and(|s| s.get_or("overlayEnabled", "false") != "false");
    if !enabled {
        return None;
    }
    let overlay = entity(cx);
    if let Some(h) = overlay.read(cx).hwnd {
        return Some(h);
    }
    let bounds = cx.primary_display().map_or_else(
        || Bounds::new(point(px(0.), px(0.)), size(px(1280.), px(720.))),
        |d| d.bounds(),
    );
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: None,
        focus: false,
        show: false,
        kind: WindowKind::PopUp,
        is_movable: false,
        is_resizable: false,
        is_minimizable: false,
        window_background: WindowBackgroundAppearance::Transparent,
        ..Default::default()
    };
    let view_overlay = overlay.clone();
    let handle = cx
        .open_window(options, |window, cx| {
            window.set_window_title("CS2 Demo Analyzer Overlay");
            cx.new(|cx| OverlayView::new(view_overlay, cx))
        })
        .ok()?;
    let raw = handle
        .update(cx, |_, window, _| match window.window_handle().map(|h| h.as_raw()) {
            Ok(RawWindowHandle::Win32(w)) => Some(w.hwnd.get()),
            _ => None,
        })
        .ok()
        .flatten();
    overlay.update(cx, |o, _| {
        o.window = Some(handle);
        o.hwnd = raw;
        if let Some(h) = raw {
            // Frameless, click-through by default; opacity set before the first show so it
            // never flashes.
            win32::make_frameless(h);
            win32::set_click_through(h, true);
            win32::set_opacity(h, o.opacity());
        }
    });
    raw
}

/// The global hotkey (Electron: only while CS2 runs; creates the overlay the first time,
/// then toggles it shown/hidden).
fn toggle(cx: &mut App) {
    if win32::find_process_id_by_name(&target_process()).is_none() {
        return;
    }
    let overlay = entity(cx);
    let created = overlay.read(cx).window.is_none();
    ensure_window(cx);
    let tracking = overlay.update(cx, |o, cx| {
        // First press shows it; after that each press flips shown ↔ hidden.
        let shown = created || o.user_visibility != Some(true);
        o.user_visibility = Some(shown);
        if let Some(h) = o.hwnd {
            if shown { win32::show_inactive(h) } else { win32::hide(h) }
        }
        if let Some(t) = &o.tracker {
            t.set_user_visibility(Some(shown));
        }
        cx.notify();
        o.tracker.is_some()
    });
    if !tracking {
        // Electron only tracked once a demo was launched from the app; following a CS2
        // that was started by hand too keeps the overlay over the game instead of the desktop.
        start_tracking(None, cx);
    }
}

/// Electron stores arrows as `Up`/`Down`/…; older values used `ArrowUp`.
fn normalize_accelerator(acc: &str) -> String {
    acc.replace("ArrowUp", "Up").replace("ArrowDown", "Down").replace("ArrowLeft", "Left").replace("ArrowRight", "Right")
}

impl Overlay {
    /// `send_commands` for code already inside an `Overlay` update.
    fn send_commands(&mut self, cmds: Vec<String>, cx: &mut Context<Self>) -> Task<anyhow::Result<()>> {
        if self.debug_mode {
            // The same log Watch in CS2 writes to (Electron's single `pushCommand` log).
            for c in &cmds {
                cs2da_core::cs2_launch::push_command(c);
            }
            self.refresh_window(cx);
        }
        let port = cs2da_core::netcon::port();
        cx.background_spawn(async move { cs2da_core::netcon::send_batch(port, &cmds, 150, |_| {}) })
    }

    pub fn hotkey(&self) -> &str {
        &self.hotkey
    }

    /// Register `accelerator` as the global toggle (replacing the old one) and save it.
    pub fn set_hotkey(&mut self, accelerator: &str, cx: &mut Context<Self>) -> Result<(), String> {
        let acc = normalize_accelerator(accelerator);
        let old = self.hotkey.clone();
        // Release the old registration first so re-registering the same keys works.
        self.hotkey_thread = None;
        self.hotkey_rx = None;
        if let Err(e) = self.register_hotkey(&acc) {
            let _ = self.register_hotkey(&old);
            return Err(e);
        }
        self.hotkey = acc.clone();
        if let Ok(s) = Settings::open() {
            let _ = s.set("overlay_hotkey", &acc);
        }
        self.refresh_window(cx);
        Ok(())
    }

    fn register_hotkey(&mut self, acc: &str) -> Result<(), String> {
        let (thread, rx) = HotkeyThread::start(acc)?;
        self.hotkey_thread = Some(thread);
        self.hotkey_rx = Some(rx);
        Ok(())
    }

    /// Electron: 0.95 while click-through, 0.85 while interactive.
    fn opacity(&self) -> f32 {
        if self.interactive { 0.85 } else { 0.95 }
    }

    fn refresh_window(&mut self, cx: &mut Context<Self>) {
        if let Some(w) = self.window {
            let _ = w.update(cx, |_, window, _| window.refresh());
        }
        cx.notify();
    }

    fn set_incident(&mut self, incident: Option<Incident>, cx: &mut Context<Self>) {
        let new_match = incident.as_ref().and_then(|i| i.match_id.clone());
        let old_match = self.incident.as_ref().and_then(|i| i.match_id.clone());
        self.show_events_list = incident.is_some();
        self.incident = incident;
        if new_match != old_match {
            self.load_match(new_match, cx);
        }
        if self.incident.is_some() {
            // A new incident brings a hotkey-hidden overlay back (Electron shows it).
            if self.user_visibility == Some(false) {
                self.user_visibility = None;
                if let Some(t) = &self.tracker {
                    t.set_user_visibility(None);
                }
            }
            if !self.interactive {
                self.set_interactive(true);
            }
            if let Some(h) = self.hwnd {
                if !win32::is_visible(h) {
                    win32::show_inactive(h);
                }
            }
        }
        self.refresh_window(cx);
    }

    fn set_interactive(&mut self, value: bool) {
        if let Some(t) = &self.tracker {
            t.set_interactive(value);
        }
        self.interactive = value;
        if let Some(h) = self.hwnd {
            win32::set_opacity(h, self.opacity());
        }
    }

    fn load_match(&mut self, match_id: Option<String>, cx: &mut Context<Self>) {
        let Some(id) = match_id else {
            self.match_data = Some(MatchData::Failed("Match ID not available".into()));
            return;
        };
        self.match_data = Some(MatchData::Loading);
        cx.spawn(async move |this, cx| {
            let result = cx.background_spawn(async move { cs2da_core::matches::match_summary(&id) }).await;
            this.update(cx, |o, cx| {
                o.match_data = Some(match result {
                    Ok(s) => MatchData::Ready { events: overlay_events(s.events), roster: s.roster },
                    Err(e) => MatchData::Failed(e.to_string()),
                });
                o.refresh_window(cx);
            })
            .ok();
        })
        .detach();
    }

    pub fn player_name(&self, steamid: Option<&str>) -> String {
        let Some(id) = steamid else { return "Unknown".into() };
        match &self.match_data {
            Some(MatchData::Ready { roster, .. }) => {
                roster.iter().find(|p| p.steamid == id).map_or_else(|| id.to_string(), |p| p.name.clone())
            }
            _ => id.to_string(),
        }
    }

    /// Events list click: focus that event, switch to the perspective panel and spectate
    /// the offender (Electron `handleEventSelect`).
    pub fn select_event(&mut self, e: &MatchEvent, cx: &mut Context<Self>) {
        let Some(inc) = self.incident.clone() else { return };
        let person = |id: &Option<String>, prev: &Person, name: String| match id {
            Some(sid) => Person { name, steam_id: Some(sid.clone()), user_id: prev.user_id, entity_index: prev.entity_index },
            None => prev.clone(),
        };
        let offender_name = self.player_name(e.actor.as_deref());
        let victim_name = self.player_name(e.victim.as_deref());
        self.incident = Some(Incident {
            tick: e.start_tick,
            event_type: Some(e.kind.clone()),
            end_tick: e.end_tick,
            meta: e.meta.clone(),
            offender: person(&e.actor, &inc.offender, offender_name),
            victim: person(&e.victim, &inc.victim, victim_name),
            ..inc
        });
        self.show_events_list = false;
        self.view_player(true, cx);
    }

    /// View offender / View victim: pause, jump 5 s before the event, spectate, resume if
    /// `autoplayAfterSpectate`, then pause again after the event (Electron
    /// `overlay:actions:viewOffender` / `viewVictim`).
    pub fn view_player(&mut self, offender: bool, cx: &mut Context<Self>) {
        let Some(inc) = self.incident.clone() else {
            self.action = Some(ActionStatus::Error("No incident available".into()));
            return;
        };
        self.pause_timer = None;
        let who = if offender { &inc.offender } else { &inc.victim };
        let target = match (who.user_id, who.entity_index) {
            (Some(uid), _) => uid.to_string(),
            (None, Some(idx)) => idx.to_string(),
            _ if !who.name.is_empty() => format!("\"{}\"", who.name),
            _ => {
                self.action = Some(ActionStatus::Error(format!(
                    "No valid identifier for {}",
                    if offender { "offender" } else { "victim" }
                )));
                return;
            }
        };
        let name = who.name.clone();
        let target_tick = if inc.tick > 0 { (inc.tick - 5 * 64).max(0) } else { 0 };
        let mut cmds = vec!["demo_pause".to_string()];
        if target_tick > 0 {
            cmds.push(format!("demo_gototick {target_tick}"));
        }
        cmds.push(format!("spec_player {target}"));
        let autoplay = Settings::open().map(|s| s.get_bool("autoplayAfterSpectate", true)).unwrap_or(true);
        if autoplay {
            cmds.push("demo_resume".into());
        }
        // AFK: wait until 5 s after the AFK period ends; others: 5 s after the event.
        let wait_secs = if inc.event_type.as_deref() == Some("AFK_STILLNESS") {
            let afk = ["seconds", "afkDuration"]
                .iter()
                .find_map(|k| inc.meta.get(*k).and_then(|v| v.as_f64()))
                .or_else(|| inc.end_tick.map(|end| (end - inc.tick) as f64 / 64.0))
                .unwrap_or(5.0);
            5.0 + afk + 5.0
        } else {
            10.0
        };
        self.action = Some(ActionStatus::Loading);
        self.refresh_window(cx);
        let send = self.send_commands(cmds, cx);
        cx.spawn(async move |this, cx| {
            let result = send.await;
            this.update(cx, |o, cx| {
                match &result {
                    Ok(()) if autoplay => o.action = Some(ActionStatus::Success("Playing event".into())),
                    Ok(()) => {
                        o.spectating = Some(name.clone());
                        o.action = None;
                    }
                    Err(e) => o.action = Some(ActionStatus::Error(e.to_string())),
                }
                if result.is_ok() {
                    o.pause_timer = Some(cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(Duration::from_secs_f64(wait_secs)).await;
                        let Ok(pause) = this.update(cx, |o, cx| o.send_commands(vec!["demo_pause".into()], cx)) else {
                            return;
                        };
                        let _ = pause.await;
                        this.update(cx, |o, cx| {
                            o.action = Some(ActionStatus::Success("Event playback successful".into()));
                            o.refresh_window(cx);
                        })
                        .ok();
                    }));
                }
                o.refresh_window(cx);
            })
            .ok();
        })
        .detach();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.tracker = None;
        self.pause_timer = None;
        if let Some(h) = self.hwnd.take() {
            win32::set_click_through(h, true);
        }
        if let Some(w) = self.window.take() {
            let _ = w.update(cx, |_, window, _| window.remove_window());
        }
        self.user_visibility = None;
        cx.notify();
    }

    /// One frame: tracker events and hover → click-through. Returns whether the hotkey was
    /// pressed (the toggle runs outside this update because it may open the window).
    fn frame(&mut self, cx: &mut Context<Self>) -> bool {
        let pressed = self.hotkey_rx.as_ref().is_some_and(|rx| rx.try_iter().count() > 0);
        let now = Instant::now();
        // The tracker moves the HWND from its own thread; have GPUI draw the new size.
        let (moved, lost) = self.tracker.as_ref().map_or((false, false), |t| (t.take_moved(), t.is_lost()));
        if moved {
            self.refresh_window(cx);
        }
        if lost {
            self.tracker = None;
        }
        self.update_hover(now);
        pressed
    }

    /// `overlayHoverController`: the window takes the mouse while the cursor is over a panel
    /// and goes back to click-through 80 ms after it leaves. A click-through window gets no
    /// mouse events, so the cursor is polled against the panels' last drawn rects.
    fn update_hover(&mut self, now: Instant) {
        let Some(h) = self.hwnd else { return };
        if !win32::is_visible(h) {
            return;
        }
        let (Some((cx_, cy)), Some((ox, oy))) = (win32::cursor_pos(), win32::client_origin(h)) else { return };
        let scale = self.scale.get().max(0.5);
        let (x, y) = ((cx_ - ox) as f32 / scale, (cy - oy) as f32 / scale);
        let over = self.regions.borrow().values().any(|b| {
            let (l, t) = (f32::from(b.origin.x), f32::from(b.origin.y));
            x >= l && y >= t && x <= l + f32::from(b.size.width) && y <= t + f32::from(b.size.height)
        });
        if over && !self.hovered {
            self.hovered = true;
            self.hover_left_at = None;
            self.hover_grace_until = Some(now + HOVER_GRACE);
            win32::set_click_through(h, false);
        } else if !over && self.hovered {
            self.hovered = false;
            self.hover_left_at = Some(now);
        }
        if !self.hovered && self.hover_left_at.is_some_and(|t| now.duration_since(t) >= CLICK_THROUGH_DELAY) {
            self.hover_left_at = None;
            win32::set_click_through(h, true);
        }
    }
}

/// Events list contents: no plain kills, one entry per (tick, type, actor), oldest first.
fn overlay_events(mut events: Vec<MatchEvent>) -> Vec<MatchEvent> {
    events.retain(|e| e.kind != "KILL");
    let mut seen = std::collections::HashSet::new();
    events.retain(|e| seen.insert((e.start_tick, e.kind.clone(), e.actor.clone())));
    events.sort_by_key(|e| e.start_tick);
    events
}

#[cfg(test)]
mod tests {
    use super::{normalize_accelerator, overlay_events};
    use cs2da_core::MatchEvent;

    fn ev(kind: &str, tick: i64, actor: &str) -> MatchEvent {
        MatchEvent {
            round_index: 0,
            kind: kind.into(),
            start_tick: tick,
            end_tick: None,
            actor: Some(actor.into()),
            victim: None,
            meta: serde_json::Value::Null,
        }
    }

    #[test]
    fn events_list_matches_electron_filtering() {
        let out = overlay_events(vec![ev("KILL", 5, "a"), ev("TEAM_FLASH", 9, "a"), ev("TEAM_FLASH", 9, "a"), ev("AFK_STILLNESS", 3, "b")]);
        let kinds: Vec<_> = out.iter().map(|e| (e.kind.as_str(), e.start_tick)).collect();
        assert_eq!(kinds, vec![("AFK_STILLNESS", 3), ("TEAM_FLASH", 9)]);
    }

    #[test]
    fn normalizes_arrow_names() {
        assert_eq!(normalize_accelerator("Control+ArrowUp"), "Control+Up");
    }
}
