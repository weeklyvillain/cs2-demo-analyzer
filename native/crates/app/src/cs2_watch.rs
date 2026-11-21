//! "Watch in CS2" and "Watch POV" buttons (Electron `MatchesScreen` handlers): run the
//! launcher (`cs2da_core::cs2_launch`) off the UI thread, copy the console commands to the
//! clipboard, show Electron's toasts, and ask before switching CS2 to another demo.

use std::path::PathBuf;

use cs2da_core::MatchSummary;
use cs2da_core::cs2_launch::{self, Outcome, Started};
use gpui_kit::component::{WindowExt as _, h_flex, v_flex};
use gpui_kit::*;

use crate::i18n::t;
use crate::theme;
use crate::toast::{self, Kind};
use crate::ui;

#[derive(Clone)]
enum Request {
    /// Header button: the demo from the start.
    Match { demo: PathBuf },
    /// An event: 5 s before `tick`, spectating `player`.
    Event { demo: PathBuf, tick: i64, player: String },
    Pov { demo: PathBuf, player: String, rounds: Vec<(i64, i64)>, deaths: Vec<(i64, i64)>, tick_rate: f64 },
}

impl Request {
    fn run(&self, confirmed: bool) -> anyhow::Result<Outcome> {
        match self {
            Request::Match { demo } => cs2_launch::start_watch(demo, None, None, confirmed),
            Request::Event { demo, tick, player } => {
                cs2_launch::start_watch(demo, Some(*tick), Some(player).filter(|p| !p.is_empty()).map(String::as_str), confirmed)
            }
            Request::Pov { demo, player, rounds, deaths, tick_rate } => {
                cs2_launch::start_pov(demo, player, rounds.clone(), deaths.clone(), *tick_rate, confirmed)
            }
        }
    }

    fn demo(&self) -> &PathBuf {
        match self {
            Request::Match { demo } | Request::Event { demo, .. } | Request::Pov { demo, .. } => demo,
        }
    }

    /// Electron's success toast for each case.
    fn message(&self, how: &Started, confirmed: bool) -> String {
        match (self, how) {
            (Request::Pov { .. }, _) if confirmed => "Loading demo and starting POV playback...".into(),
            (Request::Pov { .. }, _) => "Starting POV playback (2x, jump on death)...".into(),
            (_, Started::Launched) => t("matches.launchingCS2"),
            (Request::Match { .. }, Started::SameDemo) => t("matches.loadingDemo"),
            (Request::Match { .. }, Started::NewDemo) => "Loading new demo from start...".into(),
            (Request::Event { .. }, Started::SameDemo) => t("matches.jumpingToEvent"),
            (Request::Event { .. }, Started::NewDemo) => "Loading new demo and jumping to event...".into(),
        }
    }
}

/// Header "Watch in CS2": play the match's demo from the start.
pub fn watch_match(demo: PathBuf, window: &mut Window, cx: &mut App) {
    start(Request::Match { demo }, false, window, cx);
}

/// "Watch this event in CS2". `tick` is what Electron passed for that button; the launcher
/// backs up another 5 s from it.
pub fn watch_event(demo: Option<PathBuf>, tick: i64, player: String, window: &mut Window, cx: &mut App) {
    let Some(demo) = demo else {
        toast::push(Kind::Error, t("matches.demoFileRequired"), 3000, cx);
        return;
    };
    start(Request::Event { demo, tick, player }, false, window, cx);
}

/// "Watch POV": every round from `steam_id`'s view at 2×, skipping ahead after they die.
pub fn watch_pov(s: &MatchSummary, steam_id: &str, name: &str, window: &mut Window, cx: &mut App) {
    let Some(demo) = s.info.demo_path.clone() else {
        toast::push(Kind::Error, "Demo file path is required to watch POV", 3000, cx);
        return;
    };
    let mut rounds: Vec<(i64, i64, i64)> = s.rounds.iter().map(|r| (r.index, r.start_tick, r.end_tick)).collect();
    rounds.sort_by_key(|r| r.0);
    // Electron `matches:playerDeathTicks`: KILL / TEAM_KILL with this victim, by round and tick.
    let mut deaths: Vec<(i64, i64)> = s
        .events
        .iter()
        .filter(|e| e.victim.as_deref() == Some(steam_id) && matches!(e.kind.as_str(), "KILL" | "TEAM_KILL"))
        .map(|e| (e.round_index, e.start_tick))
        .collect();
    deaths.sort();
    let player = if name.is_empty() { steam_id.to_string() } else { name.to_string() };
    let tick_rate = if s.tick_rate > 0.0 { s.tick_rate } else { 64.0 };
    let rounds = rounds.into_iter().map(|(_, a, b)| (a, b)).collect();
    start(Request::Pov { demo, player, rounds, deaths, tick_rate }, false, window, cx);
}

fn start(req: Request, confirmed: bool, window: &mut Window, cx: &mut App) {
    window
        .spawn(cx, async move |cx| {
            let job = req.clone();
            let result = cx.background_executor().spawn(async move { job.run(confirmed) }).await;
            cx.update(|window, cx| finish(req, confirmed, result, window, cx)).ok();
        })
        .detach();
}

fn finish(req: Request, confirmed: bool, result: anyhow::Result<Outcome>, window: &mut Window, cx: &mut App) {
    match result {
        Err(e) => toast::push(Kind::Error, format!("{e:#}"), 5000, cx),
        Ok(Outcome::NeedsConfirm { .. }) => confirm_load(req, window, cx),
        Ok(Outcome::Started { how, commands }) => {
            // Electron copies the commands too, as a fallback if netcon doesn't get through.
            ui::copy_to_clipboard(commands, cx);
            toast::push(Kind::Success, req.message(&how, confirmed), 3000, cx);
            attach_overlay(&req, cx);
        }
    }
}

/// Electron's "Load Different Demo?" modal.
fn confirm_load(req: Request, window: &mut Window, cx: &mut App) {
    let file = req
        .demo()
        .file_name()
        .map_or_else(|| req.demo().display().to_string(), |n| n.to_string_lossy().into_owned());
    window.open_dialog(cx, move |dialog, _, _| {
        let load = req.clone();
        dialog
            .w(px(448.))
            .overlay_closable(true)
            .title("Load Different Demo?")
            .child(
                v_flex()
                    .gap_3()
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme::text_soft())
                            .child("CS2 is currently playing a different demo. Do you want to load the new demo?"),
                    )
                    .child(
                        v_flex()
                            .gap_1()
                            .p_3()
                            .rounded_md()
                            .bg(theme::primary())
                            .child(div().text_xs().text_color(theme::text_muted()).child("New demo:"))
                            .child(div().text_sm().font_family("Consolas").child(file.clone())),
                    ),
            )
            .footer(
                h_flex()
                    .w_full()
                    .justify_end()
                    .gap_2()
                    .child(ui::button("demo-load-cancel", "Cancel", false).on_click(|_, window, cx| window.close_dialog(cx)))
                    .child(ui::button("demo-load-confirm", "Load Demo", true).on_click(move |_, window, cx| {
                        window.close_dialog(cx);
                        start(load.clone(), true, window, cx);
                    })),
            )
    });
}

/// Electron `cs2:launch`: follow the CS2 window with the overlay and show this match's
/// events in it (placeholder offender/victim until one is picked). Does nothing while
/// Settings → Enable overlay is off.
#[cfg(windows)]
fn attach_overlay(req: &Request, cx: &mut App) {
    use crate::overlay::{self, Incident, Person};
    let match_id = req.demo().file_stem().map(|s| s.to_string_lossy().into_owned());
    let tick = match req {
        Request::Event { tick, .. } => cs2_launch::target_tick(Some(*tick)),
        _ => 0,
    };
    let unknown = || Person { name: "Unknown".into(), ..Default::default() };
    overlay::start_tracking(None, cx);
    overlay::send_incident(Some(Incident { match_id, tick, offender: unknown(), victim: unknown(), ..Default::default() }), cx);
}

#[cfg(not(windows))]
fn attach_overlay(_: &Request, _: &mut App) {}
