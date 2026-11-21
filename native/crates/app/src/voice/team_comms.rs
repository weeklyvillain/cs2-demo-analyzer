//! Team Voice modal (Electron `TeamCommsModal`): every teammate's voice extracted
//! full-length so the tracks line up, played together with per-player mute/volume,
//! a "Speaking" indicator and one waveform row per player.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cs2da_core::voice::{self, Extraction, Mode};
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::{IconName, WindowExt as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::audio::Track;
use super::waveform::{Wave, clock};
use crate::{theme, ui};
use gpui_kit::component::scroll::ScrollableElement as _;

/// Electron's team modal skips a fixed 5 s (the single-player modal uses the setting).
const SKIP_SECONDS: f64 = 5.0;
/// Height of a player row; the waveform fills it like Electron's canvas.
const ROW_HEIGHT: f32 = 106.0;

struct PlayerTrack {
    track: Track,
    wave: Wave,
    volume: Entity<SliderState>,
    muted: bool,
}

struct Row {
    steam_id: String,
    name: String,
    track: Option<PlayerTrack>,
}

enum Phase {
    Extracting,
    Ready,
    Error(String),
}

pub struct TeamComms {
    team: String,
    phase: Phase,
    logs: Arc<Mutex<Vec<String>>>,
    rows: Vec<Row>,
    extraction: Option<Extraction>,
    speed: Entity<SliderState>,
    seek: Entity<SliderState>,
    playing: bool,
    /// Position while paused (players report their own while playing).
    time: f64,
    log_scroll: ScrollHandle,
    _subs: Vec<Subscription>,
    _task: Option<Task<()>>,
}

impl TeamComms {
    fn new(demo: PathBuf, team: String, players: Vec<(String, String)>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let speed = cx.new(|_| SliderState::new().min(0.5).max(2.0).step(0.1).default_value(1.0));
        let seek = cx.new(|_| SliderState::new().min(0.0).max(1.0).step(0.0005).default_value(0.0));
        let subs = vec![
            cx.subscribe(&speed, |this, _, e: &SliderEvent, cx| {
                let (SliderEvent::Change(v) | SliderEvent::Release(v)) = e;
                for row in &this.rows {
                    if let Some(t) = &row.track {
                        t.track.set_speed(v.start());
                    }
                }
                cx.notify();
            }),
            cx.subscribe_in(&seek, window, |this, _, e: &SliderEvent, _, cx| {
                let (SliderEvent::Change(v) | SliderEvent::Release(v)) = e;
                let to = f64::from(v.start()) * this.duration();
                this.seek_all(to, cx);
            }),
        ];

        let rows = players
            .iter()
            .map(|(id, name)| Row { steam_id: id.clone(), name: if name.is_empty() { id.clone() } else { name.clone() }, track: None })
            .collect();
        let logs: Arc<Mutex<Vec<String>>> = Arc::default();
        let task_logs = logs.clone();
        let ids: Vec<String> = players.iter().map(|(id, _)| id.clone()).collect();
        let task = cx.spawn_in(window, async move |this, cx| {
            let job = cx.background_spawn(async move {
                voice::extract(&demo, Mode::SplitFull, &ids, |line| {
                    let mut l = task_logs.lock().unwrap();
                    l.push(line);
                    let n = l.len();
                    if n > 51 {
                        l.drain(..n - 51);
                    }
                })
            });
            let poll = async {
                loop {
                    cx.background_executor().timer(Duration::from_millis(150)).await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        break;
                    }
                }
            };
            let result = super::playback::select_with(job, poll).await;
            this.update_in(cx, |this, window, cx| {
                match result {
                    Some(Ok(ex)) => {
                        this.attach_tracks(&ex, window, cx);
                        this.extraction = Some(ex);
                        this.phase = Phase::Ready;
                    }
                    Some(Err(e)) => this.phase = Phase::Error(e.to_string()),
                    None => {}
                }
                cx.notify();
            })
            .ok();
        });

        Self {
            team,
            phase: Phase::Extracting,
            logs,
            rows,
            extraction: None,
            speed,
            seek,
            playing: false,
            time: 0.0,
            log_scroll: ScrollHandle::new(),
            _subs: subs,
            _task: Some(task),
        }
    }

    fn attach_tracks(&mut self, ex: &Extraction, window: &mut Window, cx: &mut Context<Self>) {
        for row in &mut self.rows {
            // Files are named <demo>_<steamid>.ogg; match on the SteamID like Electron.
            let Some((_, path)) = ex.files.iter().find(|(id, p)| *id == row.steam_id || p.to_string_lossy().contains(&row.steam_id))
            else {
                continue;
            };
            let Ok(track) = Track::open(path) else { continue };
            let volume = cx.new(|_| SliderState::new().min(0.0).max(2.0).step(0.05).default_value(1.0));
            let id = row.steam_id.clone();
            self._subs.push(cx.subscribe_in(&volume, window, move |this, _, e: &SliderEvent, _, cx| {
                let (SliderEvent::Change(v) | SliderEvent::Release(v)) = e;
                if let Some(t) = this.rows.iter().find(|r| r.steam_id == id).and_then(|r| r.track.as_ref()) {
                    t.track.set_volume(if t.muted { 0.0 } else { v.start() });
                }
                cx.notify();
            }));
            let wave = Wave::new(track.ogg.clone());
            row.track = Some(PlayerTrack { track, wave, volume, muted: false });
        }
    }

    /// Longest track: its clock drives the shared playhead (Electron's anchor track).
    fn anchor(&self) -> Option<&PlayerTrack> {
        self.rows
            .iter()
            .filter_map(|r| r.track.as_ref())
            .max_by(|a, b| a.track.duration.total_cmp(&b.track.duration))
    }

    fn duration(&self) -> f64 {
        self.anchor().map_or(0.0, |t| t.track.duration)
    }

    fn now(&self) -> f64 {
        if self.playing { self.anchor().map_or(self.time, |t| t.track.position()) } else { self.time }
    }

    fn tracks_mut(&mut self) -> impl Iterator<Item = &mut PlayerTrack> {
        self.rows.iter_mut().filter_map(|r| r.track.as_mut())
    }

    fn play_pause(&mut self, cx: &mut Context<Self>) {
        if self.playing {
            self.time = self.now();
            for t in self.tracks_mut() {
                t.track.pause();
            }
            self.playing = false;
        } else {
            let at = self.time;
            for t in self.tracks_mut() {
                t.track.seek(at);
                t.track.play();
            }
            self.playing = true;
        }
        cx.notify();
    }

    fn seek_all(&mut self, to: f64, cx: &mut Context<Self>) {
        let to = to.clamp(0.0, self.duration());
        self.time = to;
        for t in self.tracks_mut() {
            t.track.seek(to);
        }
        cx.notify();
    }

    pub fn close(&mut self) {
        for row in &mut self.rows {
            row.track = None;
        }
        if let Some(ex) = self.extraction.take() {
            voice::cleanup(&ex.output_dir);
        }
    }

    fn row(&self, i: usize, row: &Row, time: f64, duration: f64, cx: &mut Context<Self>) -> impl IntoElement {
        let track = row.track.as_ref();
        let speaking = track.is_some_and(|t| self.playing && !t.muted && t.track.ogg.is_voiced_at(time));
        let status = match track {
            None => "No audio",
            Some(_) if speaking => "Speaking",
            Some(_) => "Silent",
        };
        let mic_color = if speaking {
            rgb(0x4ade80)
        } else if track.is_some() {
            rgb(0x6b7280)
        } else {
            rgb(0xf87171)
        };
        let muted = track.is_some_and(|t| t.muted);
        let volume = track.map(|t| t.volume.read(cx).value().start()).unwrap_or(1.0);

        let controls = v_flex()
            .w(px(220.))
            .flex_shrink_0()
            .gap_2()
            .px_3()
            .py_3()
            .border_r_1()
            .border_color(theme::border())
            .child(
                h_flex()
                    .gap_2()
                    .child(div().text_color(mic_color).child(IconName::Mic))
                    .child(div().flex_1().truncate().font_weight(FontWeight::MEDIUM).child(row.name.clone()))
                    .child(div().text_xs().text_color(if speaking { rgb(0x4ade80) } else { theme::text_muted() }).child(status)),
            )
            .when_some(track, |d, t| {
                d.child(
                    h_flex()
                        .gap_2()
                        .child(
                            div()
                                .id(SharedString::from(format!("mute-{i}")))
                                .size(px(32.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded_sm()
                                .border_1()
                                .border_color(theme::border())
                                .bg(theme::secondary())
                                .cursor_pointer()
                                .hover(|s| s.bg(theme::surface()))
                                .child(if muted { super::icons::volume_x() } else { super::icons::volume_2() })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Some(t) = this.rows.get_mut(i).and_then(|r| r.track.as_mut()) {
                                        t.muted = !t.muted;
                                        let v = t.volume.read(cx).value().start();
                                        t.track.set_volume(if t.muted { 0.0 } else { v });
                                    }
                                    cx.notify();
                                })),
                        )
                        .child(
                            v_flex()
                                .flex_1()
                                .gap_1()
                                .child(div().text_xs().text_color(theme::text_muted()).child(format!("{}%", (volume * 100.0).round())))
                                .child(Slider::new(&t.volume)),
                        ),
                )
            });

        let wave = match track {
            None => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_xs()
                .text_color(theme::text_muted())
                .child("No audio available")
                .into_any_element(),
            Some(t) => {
                let click_wave = t.wave.clone();
                div()
                    .id(SharedString::from(format!("team-wave-{i}")))
                    .size_full()
                    .cursor_pointer()
                    .child(t.wave.element(time, duration, px(ROW_HEIGHT)))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                            let (now, d) = (this.now(), this.duration());
                            if let Some(to) = click_wave.time_at(e.position.x, now, d) {
                                this.seek_all(to, cx);
                            }
                        }),
                    )
                    .into_any_element()
            }
        };

        h_flex()
            .items_stretch()
            .border_t_1()
            .border_color(theme::border())
            .child(controls)
            .child(div().flex_1().min_w_0().h(px(ROW_HEIGHT)).bg(if track.is_some() { theme::secondary() } else { rgba(0x282b3066) }).child(wave))
    }
}

impl Render for TeamComms {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        match &self.phase {
            Phase::Extracting => {
                let logs = self.logs.lock().unwrap().clone();
                self.log_scroll.scroll_to_bottom();
                return v_flex()
                    .gap_3()
                    .child(h_flex().gap_2().text_color(theme::text_soft()).child(div().text_color(theme::accent()).child(IconName::LoaderCircle)).child("Extracting team voice..."))
                    .child(
                        div()
                        .relative()
                        .w_full()
                        .vertical_scrollbar(&self.log_scroll)
                        .child(v_flex()
                                .id("team-logs")
                                .track_scroll(&self.log_scroll)
                                .h(px(200.))
                                .overflow_y_scroll()
                                .p_3()
                                .rounded_md()
                                .bg(rgb(0x111214))
                                .font_family("Consolas")
                                .text_xs()
                                .text_color(theme::text_muted())
                                .when(logs.is_empty(), |d| d.child("Waiting for extractor..."))
                                .children(logs.into_iter().map(|l| div().child(l)))),
                )
                    .into_any_element();
            }
            Phase::Error(e) => {
                return v_flex()
                    .py_8()
                    .items_center()
                    .gap_2()
                    .child(div().text_color(rgb(0xf87171)).child("Failed to extract team voice"))
                    .child(div().text_sm().text_color(theme::text_muted()).child(e.clone()))
                    .into_any_element();
            }
            Phase::Ready => {}
        }

        // Every track reaching its end stops the team playback.
        let mut all_ended = self.playing;
        for t in self.tracks_mut() {
            let ended = t.track.poll_ended() || !t.track.is_playing();
            all_ended &= ended;
        }
        if self.playing && all_ended {
            self.playing = false;
            self.time = 0.0;
        }
        let (time, duration) = (self.now(), self.duration());
        if self.playing {
            window.request_animation_frame();
            let frac = if duration > 0.0 { (time / duration) as f32 } else { 0.0 };
            self.seek.update(cx, |s, cx| s.set_value(frac, window, cx));
        }
        let rate = self.speed.read(cx).value().start();

        let transport = h_flex()
            .gap_3()
            .items_center()
            .child(
                ui::button("team-back", format!("-{SKIP_SECONDS}s"), false)
                    .on_click(cx.listener(|this, _, _, cx| {
                        let to = this.now() - SKIP_SECONDS;
                        this.seek_all(to, cx)
                    })),
            )
            .child(
                div()
                    .id("team-play")
                    .size(px(40.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .bg(theme::accent())
                    .hover(|s| s.bg(theme::accent_light()))
                    .cursor_pointer()
                    .child(if self.playing { IconName::Pause } else { IconName::Play })
                    .on_click(cx.listener(|this, _, _, cx| this.play_pause(cx))),
            )
            .child(
                ui::button("team-fwd", format!("+{SKIP_SECONDS}s"), false)
                    .on_click(cx.listener(|this, _, _, cx| {
                        let to = this.now() + SKIP_SECONDS;
                        this.seek_all(to, cx)
                    })),
            )
            .child(
                h_flex()
                    .ml_4()
                    .gap_2()
                    .items_center()
                    .child(div().text_color(theme::text_muted()).child(super::icons::gauge()))
                    .child(div().w(px(40.)).text_sm().child(format!("{rate:.1}x")))
                    .child(div().w(px(160.)).child(Slider::new(&self.speed))),
            );

        let rows: Vec<AnyElement> = (0..self.rows.len())
            .map(|i| {
                let row = &self.rows[i];
                let el = self.row(i, row, time, duration, cx);
                el.into_any_element()
            })
            .collect();

        v_flex()
            .gap_4()
            .child(transport)
            .child(
                v_flex()
                    .gap_1()
                    .child(h_flex().justify_between().text_xs().text_color(theme::text_muted()).child(clock(time)).child(clock(duration)))
                    .child(Slider::new(&self.seek)),
            )
            .child(
                v_flex()
                    .id("team-rows")
                    .max_h(px(520.))
                    .overflow_y_scrollbar()
                    .rounded_md()
                    .border_1()
                    .border_color(theme::border())
                    .children(rows),
            )
            .into_any_element()
    }
}

/// Open Team Voice for `players` ((SteamID64, name) pairs) of `team`.
pub fn open(demo: PathBuf, team: String, players: Vec<(String, String)>, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| TeamComms::new(demo, team, players, window, cx));
    window.open_dialog(cx, move |dialog, _, cx| {
        let title = format!("Team Voice - {}", view.read(cx).team);
        let close_view = view.clone();
        dialog
            .w(px(1040.))
            .title(title)
            .overlay_closable(true)
            .child(view.clone())
            .on_close(move |_, _, cx| close_view.update(cx, |v, _| v.close()))
    });
}
