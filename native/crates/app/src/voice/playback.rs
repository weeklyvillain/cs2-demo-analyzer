//! Voice Playback modal (Electron `VoicePlaybackModal`): extracts one player's voice
//! (compact: silence removed), then plays it with a scrolling waveform, skip, volume,
//! speed, keyboard shortcuts and "Show in folder".

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cs2da_core::voice::{self, Extraction, Mode};
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::{IconName, WindowExt as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_kit::component::scroll::ScrollableElement as _;

use super::audio::Track;
use super::waveform::{Wave, clock};
use crate::{theme, ui};

pub(super) struct AudioFile {
    pub path: PathBuf,
    pub steam_id: String,
    pub player_name: String,
}

enum Phase {
    Extracting,
    Playback,
}

pub struct VoicePlayback {
    phase: Phase,
    player_name: String,
    logs: Arc<Mutex<Vec<String>>>,
    extraction: Option<Extraction>,
    files: Vec<AudioFile>,
    error: Option<String>,
    selected: usize,
    track: Option<Track>,
    wave: Option<Wave>,
    load_error: Option<String>,
    skip: f64,
    volume: Entity<SliderState>,
    speed: Entity<SliderState>,
    seek: Entity<SliderState>,
    focus: FocusHandle,
    log_scroll: ScrollHandle,
    _subs: Vec<Subscription>,
    _task: Option<Task<()>>,
}

impl VoicePlayback {
    fn new(demo: PathBuf, steam_id: String, player_name: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let skip = cs2da_core::settings::Settings::open()
            .ok()
            .and_then(|s| s.get_or("voice_skip_time", "10").parse::<f64>().ok())
            .filter(|v| *v > 0.0)
            .unwrap_or(10.0);
        let volume = cx.new(|_| SliderState::new().min(0.0).max(2.0).step(0.05).default_value(1.0));
        let speed = cx.new(|_| SliderState::new().min(0.5).max(2.0).step(0.1).default_value(1.0));
        let seek = cx.new(|_| SliderState::new().min(0.0).max(1.0).step(0.001).default_value(0.0));
        let subs = vec![
            cx.subscribe(&volume, |this, _, e: &SliderEvent, cx| {
                let (SliderEvent::Change(v) | SliderEvent::Release(v)) = e;
                if let Some(t) = &this.track {
                    t.set_volume(v.start());
                }
                cx.notify();
            }),
            cx.subscribe(&speed, |this, _, e: &SliderEvent, cx| {
                let (SliderEvent::Change(v) | SliderEvent::Release(v)) = e;
                if let Some(t) = &this.track {
                    t.set_speed(v.start());
                }
                cx.notify();
            }),
            cx.subscribe_in(&seek, window, |this, _, e: &SliderEvent, _, cx| {
                let (SliderEvent::Change(v) | SliderEvent::Release(v)) = e;
                if let Some(t) = this.track.as_mut() {
                    let d = t.duration;
                    t.seek(f64::from(v.start()) * d);
                }
                cx.notify();
            }),
        ];
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        // Shortcuts work wherever focus is (Electron listens on the window), while the modal lives.
        // Intercept (not observe): the dialog would otherwise eat arrows and Space for focus moves.
        let weak = cx.entity().downgrade();
        let keys = cx.intercept_keystrokes(move |e, window, cx| {
            let key = e.keystroke.key.clone();
            if e.keystroke.modifiers.modified() {
                return;
            }
            weak.update(cx, |this, cx| this.on_key(&key, window, cx)).ok();
        });
        let mut subs = subs;
        subs.push(keys);

        let logs: Arc<Mutex<Vec<String>>> = Arc::default();
        let task_logs = logs.clone();
        let task = cx.spawn(async move |this, cx| {
            let ids = vec![steam_id.clone()];
            let job = cx.background_spawn(async move {
                voice::extract(&demo, Mode::SplitCompact, &ids, |line| {
                    let mut l = task_logs.lock().unwrap();
                    l.push(line);
                    let n = l.len();
                    if n > 51 {
                        l.drain(..n - 51);
                    }
                })
            });
            // Refresh the log view while the extractor runs.
            let poll = async {
                loop {
                    cx.background_executor().timer(Duration::from_millis(150)).await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        break;
                    }
                }
            };
            let result = select_with(job, poll).await;
            this.update(cx, |this, cx| {
                this.phase = Phase::Playback;
                match result {
                    Some(Ok(ex)) => {
                        this.files = ex
                            .files
                            .iter()
                            .map(|(id, path)| AudioFile { path: path.clone(), steam_id: id.clone(), player_name: this.player_name.clone() })
                            .collect();
                        this.extraction = Some(ex);
                        this.load_selected(cx);
                    }
                    Some(Err(e)) => {
                        let msg = e.to_string().to_lowercase();
                        let no_data = ["no voice", "no data", "no audio", "nothing to extract", "0 file", "no file"]
                            .iter()
                            .any(|k| msg.contains(k));
                        if !no_data {
                            this.error = Some("Voice extraction failed. Check the application logs for details.".into());
                        }
                    }
                    None => {}
                }
                cx.notify();
            })
            .ok();
        });

        Self {
            phase: Phase::Extracting,
            player_name,
            logs,
            extraction: None,
            files: Vec::new(),
            error: None,
            selected: 0,
            track: None,
            wave: None,
            load_error: None,
            skip,
            volume,
            speed,
            seek,
            focus,
            log_scroll: ScrollHandle::new(),
            _subs: subs,
            _task: Some(task),
        }
    }

    fn load_selected(&mut self, cx: &mut Context<Self>) {
        self.track = None;
        self.wave = None;
        self.load_error = None;
        let Some(file) = self.files.get(self.selected) else { return };
        match Track::open(&file.path) {
            Ok(track) => {
                let vol = self.volume.read(cx).value().start();
                let rate = self.speed.read(cx).value().start();
                track.set_volume(vol);
                track.set_speed(rate);
                self.wave = Some(Wave::new(track.ogg.clone()));
                self.track = Some(track);
            }
            Err(e) => self.load_error = Some(e.to_string()),
        }
    }

    fn toggle(&mut self, cx: &mut Context<Self>) {
        if let Some(t) = self.track.as_mut() {
            if t.is_playing() {
                t.pause();
            } else {
                t.play();
            }
        }
        cx.notify();
    }

    fn skip_by(&mut self, delta: f64, cx: &mut Context<Self>) {
        if let Some(t) = self.track.as_mut() {
            let to = (t.position() + delta).clamp(0.0, t.duration);
            t.seek(to);
        }
        cx.notify();
    }

    fn nudge_volume(&mut self, delta: f32, window: &mut Window, cx: &mut Context<Self>) {
        let v = ((self.volume.read(cx).value().start() + delta) * 100.0).round() / 100.0;
        let v = v.clamp(0.0, 2.0);
        self.volume.update(cx, |s, cx| s.set_value(v, window, cx));
        if let Some(t) = &self.track {
            t.set_volume(v);
        }
        cx.notify();
    }

    fn on_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(self.phase, Phase::Playback) || self.track.is_none() {
            return;
        }
        let skip = self.skip;
        match key {
            "space" => self.toggle(cx),
            "left" => self.skip_by(-skip, cx),
            "right" => self.skip_by(skip, cx),
            "up" => self.nudge_volume(0.05, window, cx),
            "down" => self.nudge_volume(-0.05, window, cx),
            _ => {}
        }
    }

    /// Closing stops playback and deletes the temp folder (Electron `handleClose`).
    pub fn close(&mut self) {
        self.track = None;
        if let Some(ex) = self.extraction.take() {
            voice::cleanup(&ex.output_dir);
        }
    }

    pub fn can_close(&self) -> bool {
        matches!(self.phase, Phase::Playback)
    }

    pub fn title(&self) -> &'static str {
        match self.phase {
            Phase::Extracting => "Extracting Voice...",
            Phase::Playback => "Voice Playback",
        }
    }

    fn extracting_view(&self) -> AnyElement {
        let logs = self.logs.lock().unwrap().clone();
        self.log_scroll.scroll_to_bottom();
        v_flex()
            .gap_4()
            .py_4()
            .items_center()
            .child(div().text_color(theme::accent()).child(IconName::LoaderCircle))
            .child(div().text_color(theme::text_soft()).child("Extracting voice data..."))
            .child(div().text_sm().text_color(theme::text_muted()).child("This may take a few moments."))
            .when(!logs.is_empty(), |d| {
                d.child(
                    div()
                        .relative()
                        .w_full()
                        .vertical_scrollbar(&self.log_scroll)
                        .child(v_flex()
                            .id("voice-extract-logs")
                            .track_scroll(&self.log_scroll)
                            .w_full()
                            .max_h(px(240.))
                            .overflow_y_scroll()
                            .p_3()
                            .rounded_md()
                            .bg(rgb(0x111214))
                            .font_family("Consolas")
                            .text_xs()
                            .text_color(theme::text_muted())
                            .children(logs.into_iter().map(|l| div().child(l)))),
                )
            })
            .into_any_element()
    }

    fn playback_view(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if let Some(e) = &self.error {
            return v_flex()
                .py_8()
                .items_center()
                .gap_2()
                .child(div().text_color(rgb(0xf87171)).child("Extraction failed"))
                .child(div().text_sm().text_color(theme::text_muted()).child(e.clone()))
                .into_any_element();
        }
        if self.files.is_empty() {
            return v_flex()
                .py_8()
                .items_center()
                .gap_2()
                .child(div().text_color(theme::text_soft()).child("No voice data found"))
                .child(
                    div()
                        .text_sm()
                        .text_color(theme::text_muted())
                        .child(format!("There was no audio found for: {}", self.player_name)),
                )
                .into_any_element();
        }
        if let Some(e) = &self.load_error {
            return ui::centered_note(format!("Couldn't load audio: {e}")).into_any_element();
        }
        let (Some(track), Some(wave)) = (self.track.as_mut(), self.wave.clone()) else {
            return ui::centered_note("Loading audio...").into_any_element();
        };

        if track.poll_ended() {
            self.seek.update(cx, |s, cx| s.set_value(0.0, window, cx));
        }
        let playing = track.is_playing();
        let (time, duration) = (track.position(), track.duration);
        if playing {
            window.request_animation_frame();
            let frac = if duration > 0.0 { (time / duration) as f32 } else { 0.0 };
            self.seek.update(cx, |s, cx| s.set_value(frac, window, cx));
        }
        let file = &self.files[self.selected];
        let skip = self.skip;
        let volume = self.volume.read(cx).value().start();
        let rate = self.speed.read(cx).value().start();
        let (steam_id, file_name, file_path) = (
            file.steam_id.clone(),
            file.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            file.path.clone(),
        );

        let transport = h_flex()
            .gap_2()
            .child(
                ui::button("voice-back", format!("-{skip}s"), false)
                    .on_click(cx.listener(move |this, _, _, cx| this.skip_by(-skip, cx))),
            )
            .child(
                div()
                    .id("voice-play")
                    .size(px(40.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .bg(theme::accent())
                    .hover(|s| s.bg(theme::accent_light()))
                    .cursor_pointer()
                    .child(if playing { IconName::Pause } else { IconName::Play })
                    .on_click(cx.listener(|this, _, _, cx| this.toggle(cx))),
            )
            .child(
                ui::button("voice-fwd", format!("+{skip}s"), false)
                    .on_click(cx.listener(move |this, _, _, cx| this.skip_by(skip, cx))),
            );

        let label_row = |label: &'static str, value: String| {
            h_flex()
                .justify_between()
                .text_xs()
                .child(div().text_color(theme::text_muted()).child(label))
                .child(div().text_color(theme::text_soft()).child(value))
        };

        let left = v_flex()
            .w(px(180.))
            .flex_shrink_0()
            .gap_4()
            .child(
                v_flex()
                    .gap_1()
                    .child(div().text_xs().text_color(theme::text_muted()).child("Player"))
                    .child(div().font_weight(FontWeight::SEMIBOLD).truncate().child(file.player_name.clone()))
                    .child(
                        div()
                            .id("voice-steam")
                            .text_xs()
                            .text_color(theme::accent())
                            .cursor_pointer()
                            .truncate()
                            .child(format!("{steam_id} →"))
                            .on_click(move |_, _, cx| cx.open_url(&format!("https://steamcommunity.com/profiles/{steam_id}"))),
                    ),
            )
            .child(
                h_flex()
                    .items_baseline()
                    .gap_1()
                    .text_xl()
                    .font_family("Consolas")
                    .child(clock(time))
                    .child(div().text_sm().text_color(theme::text_muted()).child(format!("/ {}", clock(duration)))),
            )
            .child(transport)
            .child(
                v_flex()
                    .gap_1()
                    .child(label_row("Volume", format!("{}%", (volume * 100.0).round())))
                    .child(Slider::new(&self.volume)),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(label_row("Speed", format!("{rate:.1}x")))
                    .child(Slider::new(&self.speed)),
            )
            .child(
                v_flex()
                    .gap_2()
                    .child(div().text_xs().text_color(theme::text_muted()).truncate().child(file_name))
                    .child(
                        ui::button("voice-show", "Show in folder", false)
                            .on_click(move |_, _, _| ui::show_in_folder(&file_path)),
                    ),
            );

        let wave_for_click = wave.clone();
        let right = v_flex()
            .flex_1()
            .min_w_0()
            .gap_3()
            .child(
                div()
                    .id("voice-wave")
                    .w_full()
                    .h(px(180.))
                    .rounded_md()
                    .bg(theme::secondary())
                    .cursor_pointer()
                    .child(wave.element(time, duration, px(180.)))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                            if let Some(t) = this.track.as_mut() {
                                if let Some(to) = wave_for_click.time_at(e.position.x, t.position(), t.duration) {
                                    t.seek(to);
                                }
                            }
                            cx.notify();
                        }),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        h_flex()
                            .justify_between()
                            .text_xs()
                            .text_color(theme::text_muted())
                            .child(clock(time))
                            .child(clock(duration)),
                    )
                    .child(Slider::new(&self.seek)),
            );

        let picker = (self.files.len() > 1).then(|| {
            h_flex()
                .gap_2()
                .child(div().text_sm().text_color(theme::text_muted()).child("Select Player Voice:"))
                .children(self.files.iter().enumerate().map(|(i, f)| {
                    let active = i == self.selected;
                    div()
                        .id(SharedString::from(format!("voice-file-{i}")))
                        .px_2()
                        .py_1()
                        .rounded_sm()
                        .text_xs()
                        .cursor_pointer()
                        .when(active, |d| d.bg(theme::accent()))
                        .when(!active, |d| d.bg(theme::surface()))
                        .child(f.player_name.clone())
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.selected = i;
                            this.load_selected(cx);
                            cx.notify();
                        }))
                }))
        });

        let kbd = |k: &'static str| {
            div().px_1p5().rounded_sm().bg(theme::surface()).border_1().border_color(theme::border()).font_family("Consolas").child(k)
        };
        let shortcuts = h_flex()
            .gap_3()
            .pt_3()
            .border_t_1()
            .border_color(theme::border())
            .text_xs()
            .text_color(theme::text_muted())
            .child("Shortcuts")
            .child(h_flex().gap_1().child(kbd("Space")).child("Play/Pause"))
            .child(h_flex().gap_1().child(kbd("← →")).child("Skip"))
            .child(h_flex().gap_1().child(kbd("↑ ↓")).child("Volume"));

        v_flex()
            .gap_4()
            .children(picker)
            .child(h_flex().items_start().gap_6().child(left).child(right))
            .child(shortcuts)
            .into_any_element()
    }
}

impl Render for VoicePlayback {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = match self.phase {
            Phase::Extracting => self.extracting_view(),
            Phase::Playback => self.playback_view(window, cx),
        };
        div()
            .track_focus(&self.focus)
            .child(body)
    }
}

/// Open the modal for one player; extraction starts right away.
pub fn open(demo: PathBuf, steam_id: String, player_name: String, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| VoicePlayback::new(demo, steam_id, player_name, window, cx));
    let on_close = view.clone();
    window.open_dialog(cx, move |dialog, _, cx| {
        let v = view.read(cx);
        let closable = v.can_close();
        let close_view = on_close.clone();
        dialog
            .w(px(960.))
            .title(v.title())
            .close_button(closable)
            .overlay_closable(closable)
            .keyboard(closable)
            .child(view.clone())
            .on_close(move |_, _, cx| close_view.update(cx, |v, _| v.close()))
    });
}

/// Wait for `job`, keeping `tick` running alongside; `None` if the job was dropped.
pub(super) async fn select_with<T: 'static>(job: Task<T>, tick: impl std::future::Future<Output = ()>) -> Option<T> {
    futures_lite_select::select(job, tick).await
}

mod futures_lite_select {
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    pub struct Select<A, B> {
        a: Pin<Box<A>>,
        b: Pin<Box<B>>,
    }

    pub fn select<A: Future, B: Future<Output = ()>>(a: A, b: B) -> Select<A, B> {
        Select { a: Box::pin(a), b: Box::pin(b) }
    }

    impl<A: Future, B: Future<Output = ()>> Future for Select<A, B> {
        type Output = Option<A::Output>;
        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            if let Poll::Ready(v) = self.a.as_mut().poll(cx) {
                return Poll::Ready(Some(v));
            }
            if let Poll::Ready(()) = self.b.as_mut().poll(cx) {
                return Poll::Ready(None);
            }
            Poll::Pending
        }
    }
}
