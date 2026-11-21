//! The app-wide parse queue: Electron's `ParsingModal` queue logic plus
//! `ParsingStatusContext` (sidebar progress, background parsing) in one entity.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Duration;

use cs2da_core::parser::{self, ParseEvent, ParseJob};
use cs2da_core::settings::Settings;
use gpui_kit::component::progress::ProgressCircle;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::i18n::{t, tf};
use crate::theme;
use crate::ui;
use gpui_kit::component::scroll::ScrollableElement as _;

const MAX_LOGS: usize = 200;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
    Progress,
}

pub struct LogEntry {
    pub time: String,
    pub level: Level,
    pub message: String,
}

#[derive(Clone, Default)]
pub struct Progress {
    pub stage: String,
    pub round: i64,
    pub tick: i64,
    pub pct: f64,
}

/// Emitted so screens can refresh: the matches grid after a parse, the unparsed list after the queue.
pub enum ParseQueueEvent {
    MatchParsed,
    QueueFinished,
}

pub struct ParseQueue {
    pending: VecDeque<PathBuf>,
    jobs: Vec<ParseJob>,
    total: usize,
    finished: usize,
    pub progress: Option<Progress>,
    pub current_file: Option<String>,
    pub logs: VecDeque<LogEntry>,
    pub error: Option<String>,
    /// The parsing dialog is showing (false = "Run in background" or nothing queued).
    pub dialog_open: bool,
    pub confirm_abort: bool,
    parallel: usize,
    /// Keeps the console log pinned to the newest line, like Electron's scrollIntoView.
    log_scroll: ScrollHandle,
    _poll: Option<Task<()>>,
}

impl EventEmitter<ParseQueueEvent> for ParseQueue {}

struct GlobalQueue(Entity<ParseQueue>);
impl Global for GlobalQueue {}

pub fn init(cx: &mut App) {
    let queue = cx.new(|_| ParseQueue {
        pending: VecDeque::new(),
        jobs: Vec::new(),
        total: 0,
        finished: 0,
        progress: None,
        current_file: None,
        logs: VecDeque::new(),
        error: None,
        dialog_open: false,
        confirm_abort: false,
        parallel: 1,
        log_scroll: ScrollHandle::new(),
        _poll: None,
    });
    cx.set_global(GlobalQueue(queue));
}

pub fn queue(cx: &App) -> Entity<ParseQueue> {
    cx.global::<GlobalQueue>().0.clone()
}

/// Queue demos for parsing and show the parsing dialog.
pub fn parse_demos(paths: Vec<PathBuf>, cx: &mut App) {
    queue(cx).update(cx, |q, cx| q.enqueue(paths, cx));
}

fn now() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

impl ParseQueue {
    pub fn is_active(&self) -> bool {
        !self.jobs.is_empty() || !self.pending.is_empty()
    }

    /// Demos left in the queue, counting the ones running (Electron's "{count} remaining").
    pub fn remaining(&self) -> usize {
        self.total.saturating_sub(self.finished)
    }

    fn log(&mut self, level: Level, message: impl Into<String>) {
        self.logs.push_back(LogEntry { time: now(), level, message: message.into() });
        while self.logs.len() > MAX_LOGS {
            self.logs.pop_front();
        }
        self.log_scroll.scroll_to_bottom();
    }

    pub fn enqueue(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if paths.is_empty() {
            return;
        }
        if !self.is_active() {
            self.total = 0;
            self.finished = 0;
            self.logs.clear();
            self.error = None;
            self.progress = None;
            let settings = Settings::open().ok();
            let enabled = settings.as_ref().is_some_and(|s| s.get_bool("parallel_parsing_enabled", false));
            let count: usize = settings
                .as_ref()
                .map(|s| s.get_or("parallel_parsing_count", "2"))
                .and_then(|c| c.parse().ok())
                .unwrap_or(2);
            self.parallel = if enabled { count.clamp(1, 8) } else { 1 };
        }
        self.total += paths.len();
        if paths.len() > 1 && self.parallel > 1 {
            self.log(Level::Info, format!("Starting parallel parse of {} demos (max {} at a time)", paths.len(), self.parallel));
        } else if paths.len() > 1 {
            self.log(Level::Info, format!("Starting parse of {} demos", paths.len()));
        }
        self.pending.extend(paths);
        self.dialog_open = true;
        self.start_next(cx);
        self.ensure_polling(cx);
        cx.notify();
    }

    fn start_next(&mut self, cx: &mut Context<Self>) {
        while self.jobs.len() < self.parallel {
            let Some(path) = self.pending.pop_front() else { break };
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let index = self.finished + self.jobs.len() + 1;
            if self.total > 1 {
                self.log(Level::Info, format!("Starting parse {index} of {}: {name}", self.total));
            } else {
                self.log(Level::Info, format!("Starting parse: {}", path.display()));
            }
            match parser::start(&path) {
                Ok(job) => {
                    self.log(Level::Info, format!("Match ID: {}, DB: {}", job.match_id, job.db_path.display()));
                    self.current_file = Some(name);
                    self.progress = None;
                    self.jobs.push(job);
                }
                Err(e) => {
                    let msg = format!("Failed to start parser: {e:#}");
                    self.log(Level::Error, msg.clone());
                    self.error = Some(msg);
                    self.finished += 1;
                }
            }
        }
        cx.notify();
    }

    fn ensure_polling(&mut self, cx: &mut Context<Self>) {
        if self._poll.is_some() {
            return;
        }
        self._poll = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(50)).await;
                let keep_going = this.update(cx, |q, cx| q.drain(cx)).unwrap_or(false);
                if !keep_going {
                    break;
                }
            }
        }));
    }

    /// Pull parser events; returns whether to keep polling.
    fn drain(&mut self, cx: &mut Context<Self>) -> bool {
        let mut done: Vec<(usize, bool, Option<String>)> = Vec::new();
        let mut events = Vec::new();
        for (i, job) in self.jobs.iter().enumerate() {
            while let Ok(ev) = job.events.try_recv() {
                if let ParseEvent::Done { success, error } = &ev {
                    done.push((i, *success, error.clone()));
                }
                events.push(ev);
            }
        }
        let changed = !events.is_empty();
        for ev in events {
            match ev {
                ParseEvent::Progress { stage, round, tick, pct } => {
                    self.log(Level::Progress, format!("Progress: {stage} - Round {round}, Tick {tick}"));
                    self.progress = Some(Progress { stage, round, tick, pct });
                }
                ParseEvent::Log { level, msg } => {
                    let level = match level.as_str() {
                        "warn" => Level::Warn,
                        "error" => Level::Error,
                        _ => Level::Info,
                    };
                    self.log(level, msg);
                }
                ParseEvent::Error(msg) => {
                    self.log(Level::Error, msg.clone());
                    self.error = Some(msg);
                }
                ParseEvent::Done { .. } => {}
            }
        }
        for (i, success, error) in done.into_iter().rev() {
            let job = self.jobs.remove(i);
            self.finished += 1;
            // Electron's App-level toasts, shown whether or not the dialog is open.
            let name = job
                .demo_path
                .file_name()
                .map_or_else(|| job.match_id.clone(), |n| n.to_string_lossy().into_owned());
            if success {
                self.log(Level::Info, "Parsing completed successfully");
                cx.emit(ParseQueueEvent::MatchParsed);
                crate::toast::push(crate::toast::Kind::Success, tf("toast.demoParsed", &[("name", &name)]), 5000, cx);
            } else if let Some(e) = error {
                self.log(Level::Error, e.clone());
                if e != "Parser stopped by user" {
                    let msg = format!("{} — {e}", tf("toast.demoParseFailed", &[("name", &name)]));
                    crate::toast::push(crate::toast::Kind::Error, msg, 7000, cx);
                }
                self.error.get_or_insert(e);
            }
        }
        if changed {
            self.start_next(cx);
            if !self.is_active() {
                self.on_queue_finished(cx);
            }
            cx.notify();
        }
        if !self.is_active() {
            self._poll = None;
            return false;
        }
        true
    }

    fn on_queue_finished(&mut self, cx: &mut Context<Self>) {
        cx.emit(ParseQueueEvent::QueueFinished);
        if self.error.is_none() {
            self.log(Level::Info, "All demos parsed successfully");
            // Electron closes the dialog a second after a clean finish; errors keep it open.
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                this.update(cx, |q, cx| {
                    if !q.is_active() && q.error.is_none() {
                        q.dialog_open = false;
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        }
    }

    /// Stop every running parse, drop the queue and delete incomplete databases.
    pub fn stop(&mut self, cx: &mut Context<Self>) {
        for job in &self.jobs {
            job.stop();
        }
        self.jobs.clear();
        self.pending.clear();
        self.finished = self.total;
        self.confirm_abort = false;
        self.dialog_open = false;
        self.log(Level::Info, "Parser stopped by user");
        cx.emit(ParseQueueEvent::QueueFinished);
        cx.notify();
    }
}

// ---------- UI ----------

/// Bottom-of-sidebar status while parsing (Electron `Sidebar` progress ring).
pub fn sidebar_status(cx: &mut App) -> Option<AnyElement> {
    let entity = queue(cx);
    let q = entity.read(cx);
    if !q.is_active() {
        return None;
    }
    let pct = q.progress.as_ref().map_or(0.0, |p| p.pct.clamp(0.0, 1.0));
    let file = q.current_file.clone().map(|f| format!(": {f}")).unwrap_or_default();
    let remaining = q.remaining().max(1);
    let (open_q, stop_q) = (entity.clone(), entity.clone());
    Some(
        v_flex()
            .gap_2()
            .m_3()
            .p_3()
            .rounded_md()
            .bg(theme::surface())
            .border_1()
            .border_color(theme::border())
            .child(
                h_flex()
                    .gap_3()
                    .child(
                        div()
                            .relative()
                            .size(px(44.))
                            .flex_shrink_0()
                            .child(ProgressCircle::new("parse-ring").value((pct * 100.0) as f32).color(theme::accent()).size_full())
                            .child(
                                div()
                                    .absolute()
                                    .inset_0()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .text_xs()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(format!("{}%", (pct * 100.0).round())),
                            ),
                    )
                    .child(
                        v_flex()
                            .min_w_0()
                            .text_xs()
                            .child(div().truncate().child(format!("{}{file}", t("sidebar.parsing"))))
                            .child(
                                div()
                                    .text_color(theme::text_muted())
                                    .child(tf("sidebar.parsingRemaining", &[("count", &remaining.to_string())])),
                            ),
                    ),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(ui::button("parse-open", t("sidebar.openParsing"), false).flex_1().justify_center().on_click(
                        move |_, _, cx| {
                            open_q.update(cx, |q, cx| {
                                q.dialog_open = true;
                                cx.notify();
                            })
                        },
                    ))
                    .child(
                        ui::button("parse-stop", t("sidebar.stopParsing"), false)
                            .flex_1()
                            .justify_center()
                            .on_click(move |_, _, cx| stop_q.update(cx, |q, cx| q.stop(cx))),
                    ),
            )
            .into_any_element(),
    )
}

/// The parsing dialog (Electron `ParsingModal`), drawn over the whole window.
pub fn dialog(cx: &mut App) -> Option<AnyElement> {
    let entity = queue(cx);
    let q = entity.read(cx);
    if !q.dialog_open {
        return None;
    }
    let active = q.is_active();
    let title = if q.total > 1 && q.parallel > 1 {
        format!("Parsing {} demos (parallel)", q.total)
    } else if q.total > 1 {
        format!("Parsing Demo ({} of {})", (q.finished + 1).min(q.total), q.total)
    } else {
        "Parsing Demo".to_string()
    };
    let pct = q.progress.as_ref().map(|p| (p.pct * 100.0).clamp(0.0, 100.0));

    let (bg_q, stop_q, close_q, cancel_q, abort_q) =
        (entity.clone(), entity.clone(), entity.clone(), entity.clone(), entity.clone());

    let logs = v_flex()
        .id("parse-logs")
        .h(px(300.))
        .overflow_y_scroll()
        .track_scroll(&q.log_scroll)
        .p_3()
        .rounded_md()
        .bg(rgb(0x111214))
        .font_family("Consolas")
        .text_xs()
        .when(q.logs.is_empty(), |d| d.child(div().text_color(theme::text_muted()).child("Starting parser...")))
        // Electron shows the last 100.
        .children(q.logs.iter().skip(q.logs.len().saturating_sub(100)).map(|l| {
            let (color, name) = match l.level {
                Level::Error => (rgb(0xf87171), "error"),
                Level::Warn => (rgb(0xfacc15), "warn"),
                Level::Progress => (theme::accent(), "progress"),
                Level::Info => (theme::text_soft(), "info"),
            };
            div().mb_1().text_color(color).child(format!("[{}] {name}: {}", l.time, l.message))
        }));
    // The box follows the newest line through its own handle; the scrollbar sits on a wrapper.
    let logs = div().relative().child(logs).vertical_scrollbar(&q.log_scroll);

    let panel = v_flex()
        .w(px(720.))
        .gap_4()
        .p_6()
        .rounded_lg()
        .bg(theme::secondary())
        .border_1()
        .border_color(theme::border())
        .child(
            h_flex()
                .justify_between()
                .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(title))
                .when(!active, |d| {
                    d.child(ui::icon_button("parse-close", gpui_kit::component::IconName::Close).on_click(move |_, _, cx| {
                        close_q.update(cx, |q, cx| {
                            q.dialog_open = false;
                            cx.notify();
                        })
                    }))
                }),
        )
        .child(
            v_flex()
                .gap_1()
                .child(div().text_sm().text_color(theme::text_muted()).child("Demo File:"))
                .child(div().text_sm().truncate().child(q.current_file.clone().unwrap_or_else(|| "N/A".into()))),
        )
        .when_some(q.progress.clone().zip(pct), |d, (p, pct)| {
            d.child(
                v_flex()
                    .gap_2()
                    .child(
                        h_flex()
                            .justify_between()
                            .text_sm()
                            .child(format!("{} - Round {} - Tick {}", p.stage, p.round, p.tick))
                            .child(div().text_color(theme::accent()).child(format!("{pct:.1}%"))),
                    )
                    .child(
                        div()
                            .h_2()
                            .w_full()
                            .rounded_full()
                            .bg(theme::surface())
                            .child(div().h_full().rounded_full().bg(theme::accent()).w(relative(pct as f32 / 100.0))),
                    ),
            )
        })
        .when_some(q.error.clone(), |d, e| {
            d.child(
                div()
                    .px_4()
                    .py_3()
                    .rounded_md()
                    .border_1()
                    .border_color(rgb(0xb91c1c))
                    .bg(rgba(0x7f1d1d33))
                    .text_sm()
                    .text_color(rgb(0xfca5a5))
                    .child(e),
            )
        })
        .child(
            v_flex()
                .gap_2()
                .child(
                    h_flex()
                        .justify_between()
                        .child(div().font_weight(FontWeight::SEMIBOLD).child("Console Log"))
                        .when(active, |d| {
                            d.child(
                                h_flex()
                                    .gap_2()
                                    .child(ui::button("parse-bg", t("parsing.runInBackground"), false).on_click(move |_, _, cx| {
                                        bg_q.update(cx, |q, cx| {
                                            q.dialog_open = false;
                                            cx.notify();
                                        })
                                    }))
                                    .child(
                                        div()
                                            .id("parse-stop-dialog")
                                            .px_3()
                                            .py_1p5()
                                            .rounded_md()
                                            .bg(rgb(0xdc2626))
                                            .hover(|s| s.bg(rgb(0xb91c1c)))
                                            .text_sm()
                                            .cursor_pointer()
                                            .child("Stop")
                                            .on_click(move |_, _, cx| {
                                                stop_q.update(cx, |q, cx| {
                                                    q.confirm_abort = true;
                                                    cx.notify();
                                                })
                                            }),
                                    ),
                            )
                        }),
                )
                .child(logs),
        );

    let confirm = q.confirm_abort.then(|| {
        div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .bg(rgba(0x00000066))
            .child(
                v_flex()
                    .w(px(440.))
                    .gap_4()
                    .p_6()
                    .rounded_lg()
                    .bg(theme::secondary())
                    .border_1()
                    .border_color(theme::border())
                    .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child("Abort Parsing?"))
                    .child(div().font_weight(FontWeight::MEDIUM).child("Are you sure you want to abort parsing?"))
                    .child(div().text_sm().text_color(theme::text_soft()).child(
                        "This will stop the parser and delete the incomplete match database. This action cannot be undone.",
                    ))
                    .child(
                        h_flex()
                            .justify_end()
                            .gap_2()
                            .child(ui::button("abort-cancel", "Cancel", false).on_click(move |_, _, cx| {
                                cancel_q.update(cx, |q, cx| {
                                    q.confirm_abort = false;
                                    cx.notify();
                                })
                            }))
                            .child(
                                div()
                                    .id("abort-confirm")
                                    .px_3()
                                    .py_1p5()
                                    .rounded_md()
                                    .bg(rgb(0xdc2626))
                                    .hover(|s| s.bg(rgb(0xb91c1c)))
                                    .text_sm()
                                    .cursor_pointer()
                                    .child("Abort & Delete")
                                    .on_click(move |_, _, cx| abort_q.update(cx, |q, cx| q.stop(cx))),
                            ),
                    ),
            )
    });

    Some(
        div()
            .id("parse-dialog-backdrop")
            .absolute()
            .inset_0()
            .bg(rgba(0x000000aa))
            .occlude()
            .flex()
            .items_center()
            .justify_center()
            .child(panel)
            .children(confirm)
            .into_any_element(),
    )
}
