//! 2D replay viewer (Electron `Viewer2D.tsx` and `viewer2d/*`): the radar with players,
//! utility, shots and grief markers drawn in a GPUI canvas, side rosters, a score bug and
//! kill feed, transport controls and a round timeline. Full-game mode, like Electron's
//! 2D tab: the playhead runs across every round, which stream in around it.

mod art;
mod data;
mod scene;

use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use cs2da_core::MatchEvent;
use cs2da_core::replay::{self, ReplayRound};
use gpui_kit::component::{IconName, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use art::RadarArt;
pub use data::has_radar_image;
use data::{
    Phase, PlayerFrame, RoundView, TEAM_CT, TEAM_T, TICKRATE, is_alive_at, level_index_at, mmss, phase_at,
    pretty_map_name, radar_for, resolve_tick, round_at, round_near, score_at, team_color, weapon_label,
};
use scene::{EventMark, Layers, MapBounds, RadarView, Scene, TOKEN_RADIUS, Transform};
use gpui_kit::component::scroll::ScrollableElement as _;

const SPEEDS: [f32; 5] = [0.5, 1.0, 2.0, 4.0, 8.0];
const SKIP_SECONDS: f64 = 5.0;
const CLICK_SLOP: f32 = 5.0;
const WHEEL_SPEED: f32 = 0.0016;
const BUTTON_STEP: f32 = 1.5;
const FOLLOW_ZOOM: f32 = 2.6;
const FEED_SECONDS: f64 = 5.0;
const EVENT_WINDOW: f64 = 96.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Menu {
    None,
    Layers,
    Help,
}

struct Drag {
    start: Point<Pixels>,
    last: Point<Pixels>,
    moved: bool,
}

pub struct Viewer2D {
    match_id: String,
    map: String,
    rounds: Vec<ReplayRound>,
    events: Vec<MatchEvent>,
    names: HashMap<String, String>,
    loaded: BTreeMap<i64, Arc<RoundView>>,
    loading: HashSet<i64>,
    tick: f64,
    playing: bool,
    speed: f32,
    layers: Layers,
    flat_style: bool,
    selected: Option<Arc<str>>,
    following: bool,
    hovered: Option<Arc<str>>,
    /// None = follow the selected player's floor.
    level_choice: Option<usize>,
    menu: Menu,
    transform: Transform,
    canvas: Rc<Cell<Bounds<Pixels>>>,
    drag: Option<Drag>,
    last_frame: Option<Instant>,
    last_art: Option<RadarArt>,
    art_loading: HashSet<String>,
    focus: FocusHandle,
    timeline: Rc<Cell<Bounds<Pixels>>>,
    scrubbing: bool,
    timeline_hover: Option<(f32, f64)>,
    fallback_bounds: Option<MapBounds>,
}

impl Viewer2D {
    pub fn new(match_id: String, map: String, events: Vec<MatchEvent>, names: HashMap<String, String>, cx: &mut Context<Self>) -> Self {
        let rounds = replay::rounds(&match_id).unwrap_or_default();
        let tick = rounds.first().map_or(0.0, |r| r.start_tick as f64);
        let mut this = Self {
            match_id,
            map,
            rounds,
            events,
            names,
            loaded: BTreeMap::new(),
            loading: HashSet::new(),
            tick,
            playing: false,
            speed: 1.0,
            layers: Layers::default(),
            flat_style: true,
            selected: None,
            following: false,
            hovered: None,
            level_choice: None,
            menu: Menu::None,
            transform: Transform::IDENTITY,
            canvas: Rc::new(Cell::new(Bounds::default())),
            drag: None,
            last_frame: None,
            last_art: None,
            art_loading: HashSet::new(),
            focus: cx.focus_handle(),
            timeline: Rc::new(Cell::new(Bounds::default())),
            scrubbing: false,
            timeline_hover: None,
            fallback_bounds: None,
        };
        this.ensure_around(cx);
        this
    }

    fn min_tick(&self) -> f64 {
        self.rounds.first().map_or(0.0, |r| r.start_tick as f64)
    }
    fn max_tick(&self) -> f64 {
        self.rounds.last().map_or(0.0, |r| r.end_tick as f64)
    }

    /// Jump the playhead (e.g. "View in 2D"), pausing playback.
    pub fn seek_to(&mut self, tick: i64, cx: &mut Context<Self>) {
        self.playing = false;
        self.seek(tick as f64, cx);
    }

    fn seek(&mut self, t: f64, cx: &mut Context<Self>) {
        self.tick = t.round().clamp(self.min_tick(), self.max_tick());
        self.ensure_around(cx);
        cx.notify();
    }

    /// Keep the round at the playhead and its neighbours loaded, dropping the rest.
    fn ensure_around(&mut self, cx: &mut Context<Self>) {
        let Some(current) = round_near(&self.rounds, self.tick) else { return };
        let i = self.rounds.iter().position(|r| r.index == current.index).unwrap_or(0);
        let keep: Vec<ReplayRound> = [i.checked_sub(1), Some(i), Some(i + 1)]
            .into_iter()
            .flatten()
            .filter_map(|j| self.rounds.get(j).cloned())
            .collect();
        let keep_ids: HashSet<i64> = keep.iter().map(|r| r.index).collect();
        self.loaded.retain(|k, _| keep_ids.contains(k));
        for r in keep {
            if self.loaded.contains_key(&r.index) || !self.loading.insert(r.index) {
                continue;
            }
            let id = self.match_id.clone();
            cx.spawn(async move |this, cx| {
                let index = r.index;
                let view = cx
                    .background_spawn(async move {
                        replay::round_data(&id, r.index, r.start_tick, r.end_tick)
                            .ok()
                            .map(|d| Arc::new(RoundView::build(d)))
                    })
                    .await;
                this.update(cx, |this, cx| {
                    this.loading.remove(&index);
                    if let Some(v) = view {
                        let wanted = round_near(&this.rounds, this.tick).map(|c| c.index);
                        if wanted.is_some_and(|w| (index - w).abs() <= 1) {
                            this.loaded.insert(index, v);
                        }
                    }
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
    }

    fn players_at(&self, raw: f64) -> Vec<PlayerFrame> {
        let (tick, snapped) = resolve_tick(&self.rounds, raw);
        let Some(view) = round_at(&self.rounds, tick).and_then(|r| self.loaded.get(&r.index)) else {
            return Vec::new();
        };
        (0..view.steamids.len() as u16)
            .filter_map(|i| view.position_at(i, tick, snapped))
            .map(|mut p| {
                p.alive = is_alive_at(&self.rounds, p.health, raw);
                p
            })
            .collect()
    }

    fn position_at(&self, steamid: &str, raw: f64, round_index: i64) -> Option<PlayerFrame> {
        let view = self.loaded.get(&round_index)?;
        let (tick, snapped) = resolve_tick(&self.rounds, raw);
        view.position_at(view.player_index(steamid)?, tick, snapped)
    }

    fn select(&mut self, id: Option<Arc<str>>) {
        self.following = id.is_some();
        self.selected = id;
    }

    fn toggle_play(&mut self, cx: &mut Context<Self>) {
        if !self.playing && self.tick >= self.max_tick() {
            self.tick = self.min_tick();
            self.ensure_around(cx);
        }
        self.playing = !self.playing;
        self.last_frame = None;
        cx.notify();
    }

    fn jump_round(&mut self, dir: i32, cx: &mut Context<Self>) {
        let Some(cur) = round_near(&self.rounds, self.tick).cloned() else { return };
        let live = cur.freeze_end_tick.filter(|f| *f > 0).unwrap_or(cur.start_tick) as f64;
        // "Previous" from well into a round restarts it, like a media player.
        if dir < 0 && self.tick - live > 2.0 * TICKRATE {
            self.seek(cur.start_tick as f64, cx);
            return;
        }
        let pos = self.rounds.iter().position(|r| r.index == cur.index).unwrap_or(0) as i32;
        let target = (pos + dir).clamp(0, self.rounds.len() as i32 - 1) as usize;
        let start = self.rounds[target].start_tick as f64;
        self.seek(start, cx);
    }

    fn canvas_size(&self) -> (f32, f32) {
        let b = self.canvas.get();
        (f32::from(b.size.width), f32::from(b.size.height))
    }

    fn map_bounds(&self) -> Option<MapBounds> {
        match radar_for(&self.map) {
            Some(info) => {
                let size = data::RADAR_PX * info.scale;
                Some(MapBounds { min_x: info.x, min_y: info.y - size, max_x: info.x + size, max_y: info.y })
            }
            None => self.fallback_bounds,
        }
    }

    fn view(&self) -> Option<RadarView> {
        let (w, h) = self.canvas_size();
        (w > 0.0).then_some(())?;
        Some(RadarView::fit(self.map_bounds()?, w, h, self.transform))
    }

    fn zoom_by(&mut self, factor: f32, cx: &mut Context<Self>) {
        let (w, h) = self.canvas_size();
        self.transform = self.transform.zoom_at(factor, w / 2.0, h / 2.0, w, h);
        cx.notify();
    }

    fn local(&self, p: Point<Pixels>) -> (f32, f32) {
        let o = self.canvas.get().origin;
        (f32::from(p.x - o.x), f32::from(p.y - o.y))
    }

    fn hit(&self, p: Point<Pixels>) -> Option<Arc<str>> {
        let view = self.view()?;
        let (x, y) = self.local(p);
        scene::hit_player(&self.players_at(self.tick), &view, x, y, TOKEN_RADIUS * 1.8)
    }

    fn on_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let m = &ev.keystroke.modifiers;
        if m.control || m.platform || m.alt {
            return;
        }
        match ev.keystroke.key.as_str() {
            "space" => self.toggle_play(cx),
            "left" if m.shift => self.jump_round(-1, cx),
            "right" if m.shift => self.jump_round(1, cx),
            "left" => self.seek(self.tick - SKIP_SECONDS * TICKRATE, cx),
            "right" => self.seek(self.tick + SKIP_SECONDS * TICKRATE, cx),
            "+" | "=" => self.zoom_by(1.5, cx),
            "-" => self.zoom_by(1.0 / 1.5, cx),
            "0" => {
                self.following = false;
                self.transform = Transform::IDENTITY;
            }
            "[" => {
                let i = SPEEDS.iter().position(|s| *s == self.speed).unwrap_or(1);
                self.speed = SPEEDS[i.saturating_sub(1)];
            }
            "]" => {
                let i = SPEEDS.iter().position(|s| *s == self.speed).unwrap_or(1);
                self.speed = SPEEDS[(i + 1).min(SPEEDS.len() - 1)];
            }
            "f" if self.selected.is_some() => self.following = !self.following,
            "escape" => {
                if self.menu != Menu::None {
                    self.menu = Menu::None;
                } else if self.selected.is_some() {
                    self.select(None);
                }
            }
            _ => return,
        }
        let _ = window;
        cx.stop_propagation();
        cx.notify();
    }

    /// Advance the playhead by wall-clock time while playing.
    fn advance(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.playing {
            self.last_frame = None;
            return;
        }
        let now = Instant::now();
        if let Some(last) = self.last_frame {
            let dt = (now - last).as_secs_f64().min(0.1);
            let next = self.tick + TICKRATE * self.speed as f64 * dt;
            let before = round_near(&self.rounds, self.tick).map(|r| r.index);
            if next >= self.max_tick() {
                self.tick = self.max_tick();
                self.playing = false;
            } else {
                self.tick = next;
            }
            if round_near(&self.rounds, self.tick).map(|r| r.index) != before {
                self.ensure_around(cx);
            }
        }
        self.last_frame = Some(now);
        if self.playing {
            window.request_animation_frame();
        }
    }

    /// Ease the camera towards the followed player.
    fn follow_camera(&mut self, players: &[PlayerFrame], window: &mut Window) {
        if !self.following {
            return;
        }
        let Some(sel) = &self.selected else { return };
        let Some(p) = players.iter().find(|p| &p.steamid == sel) else { return };
        let (w, h) = self.canvas_size();
        let Some(bounds) = self.map_bounds() else { return };
        if w <= 0.0 {
            window.request_animation_frame();
            return;
        }
        let fitted = RadarView::fit(bounds, w, h, Transform::IDENTITY);
        let (px_, py_) = fitted.to_fitted(p.x, p.y);
        let cur = self.transform;
        let target = Transform::centre_on(px_, py_, cur.zoom.max(FOLLOW_ZOOM), w, h);
        let k = 0.18;
        let next = Transform {
            zoom: cur.zoom + (target.zoom - cur.zoom) * k,
            x: cur.x + (target.x - cur.x) * k,
            y: cur.y + (target.y - cur.y) * k,
        }
        .clamped(w, h);
        let moving = (next.x - cur.x).abs() > 0.1 || (next.y - cur.y).abs() > 0.1 || (next.zoom - cur.zoom).abs() > 0.001;
        self.transform = next;
        if moving {
            window.request_animation_frame();
        }
    }

    /// The radar image for the floor in view, loading it in the background if needed.
    fn art_for(&mut self, image: &str, cx: &mut Context<Self>) -> Option<RadarArt> {
        match art::cached(image) {
            Some(Some(a)) => {
                self.last_art = Some(a.clone());
                Some(a)
            }
            Some(None) => None,
            None => {
                if self.art_loading.insert(image.to_string()) {
                    let image = image.to_string();
                    cx.spawn(async move |this, cx| {
                        let img = image.clone();
                        cx.background_spawn(async move { art::load(&img) }).await;
                        this.update(cx, |this, cx| {
                            this.art_loading.remove(&image);
                            cx.notify();
                        })
                        .ok();
                    })
                    .detach();
                }
                // Keep the last floor on screen while the next one loads.
                self.last_art.clone()
            }
        }
    }
}

// ---------- small UI pieces ----------

fn hex(c: u32) -> Hsla {
    rgb(c).into()
}
fn hexa(c: u32, a: f32) -> Hsla {
    let mut h: Hsla = rgb(c).into();
    h.a = a;
    h
}

fn header_button(id: &'static str, active: bool) -> Stateful<Div> {
    h_flex()
        .id(id)
        .h(px(32.))
        .gap_1p5()
        .px_2p5()
        .rounded_md()
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer()
        .when(active, |d| d.bg(hexa(0xffffff, 0.15)).text_color(hex(0xffffff)))
        .when(!active, |d| {
            d.text_color(hex(0x9ca3af)).hover(|s| s.bg(hexa(0xffffff, 0.08)).text_color(hex(0xffffff)))
        })
}

fn transport_button(id: &'static str, icon: IconName) -> Stateful<Div> {
    div()
        .id(id)
        .size(px(32.))
        .flex()
        .items_center()
        .justify_center()
        .rounded_md()
        .cursor_pointer()
        .text_color(hex(0xd1d5db))
        .hover(|s| s.bg(hexa(0xffffff, 0.08)).text_color(hex(0xffffff)))
        .child(icon)
}

fn label_caps(text: &'static str) -> Div {
    div().text_size(px(10.)).font_weight(FontWeight::SEMIBOLD).text_color(hex(0x6b7280)).child(text.to_uppercase())
}

fn swatch(c: u32) -> Div {
    div().size(px(12.)).rounded_full().bg(hex(c))
}

fn hp_color(hp: i32) -> u32 {
    if hp > 60 {
        0x5fd08a
    } else if hp > 30 {
        0xe8b04a
    } else {
        0xff4d5e
    }
}

impl Viewer2D {
    fn roster(&self, team: &'static str, players: &[PlayerFrame], score: i64, left: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let color = if team == "T" { TEAM_T } else { TEAM_CT };
        let mut list: Vec<&PlayerFrame> = players.iter().filter(|p| p.team.as_deref() == Some(team)).collect();
        let alive = list.iter().filter(|p| p.alive).count();
        list.sort_by(|a, b| b.alive.cmp(&a.alive).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        let slots = list.len().max(5);
        v_flex()
            .w(px(240.))
            .flex_shrink_0()
            .bg(hex(0x1b1d21))
            .when(left, |d| d.border_r_1())
            .when(!left, |d| d.border_l_1())
            .border_color(hexa(0xffffff, 0.06))
            .child(
                v_flex()
                    .relative()
                    .px_3()
                    .pt_3()
                    .pb_2p5()
                    .child(div().absolute().top_0().left_0().right_0().h(px(2.)).bg(hex(color)))
                    .child(
                        h_flex()
                            .justify_between()
                            .items_end()
                            .child(
                                v_flex()
                                    .child(div().text_size(px(10.)).font_weight(FontWeight::SEMIBOLD).text_color(hex(color)).child(team))
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(hex(0xf3f4f6))
                                            .child(if team == "T" { "Terrorists" } else { "Counter-Terrorists" }),
                                    ),
                            )
                            .child(div().text_2xl().font_weight(FontWeight::BOLD).font_family("Consolas").child(score.to_string())),
                    )
                    .child(h_flex().mt_2().gap_1().children((0..slots).map(|i| {
                        div().h(px(4.)).flex_1().rounded_full().bg(if i < alive { hex(color) } else { hexa(0xffffff, 0.08) })
                    }))),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .id(SharedString::from(format!("roster-{team}")))
                    .px_2()
                    .pb_2()
                    .gap_1()
                    .when(list.is_empty(), |d| {
                        d.child(div().px_2p5().py_6().text_center().text_xs().text_color(hex(0x6b7280)).child("No players yet"))
                    })
                    .children(list.into_iter().map(|p| {
                        let hp = if p.alive { p.health.unwrap_or(100).max(0) } else { 0 };
                        let is_sel = self.selected.as_deref() == Some(&*p.steamid);
                        let is_hov = self.hovered.as_deref() == Some(&*p.steamid);
                        let (id_click, id_hover) = (p.steamid.clone(), p.steamid.clone());
                        v_flex()
                            .id(SharedString::from(format!("roster-{}", p.steamid)))
                            .px_2p5()
                            .py_2()
                            .rounded_md()
                            .cursor_pointer()
                            .when(is_sel, |d| d.bg(hexa(0xffffff, 0.09)).border_1().border_color(hexa(0xffffff, 0.25)))
                            .when(!is_sel && is_hov, |d| d.bg(hexa(0xffffff, 0.06)))
                            .when(!is_sel && !is_hov, |d| d.hover(|s| s.bg(hexa(0xffffff, 0.04))))
                            .when(!p.alive, |d| d.opacity(0.45))
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(if p.alive {
                                        div().size(px(8.)).flex_shrink_0().rounded_full().bg(hex(color)).into_any_element()
                                    } else {
                                        div().text_size(px(10.)).text_color(hex(0x6b7280)).child("✕").into_any_element()
                                    })
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .truncate()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(if p.alive { hex(0xf3f4f6) } else { hex(0x9ca3af) })
                                            .when(!p.alive, |d| d.line_through())
                                            .child(p.name.to_string()),
                                    )
                                    .when(is_sel && self.following, |d| d.child(div().text_xs().child("◎")))
                                    .when(p.alive, |d| {
                                        d.child(div().text_size(px(11.)).font_family("Consolas").text_color(hex(0xd1d5db)).child(hp.to_string()))
                                    }),
                            )
                            .child(
                                div()
                                    .mt_1p5()
                                    .h(px(4.))
                                    .rounded_full()
                                    .bg(hexa(0xffffff, 0.07))
                                    .child(div().h_full().rounded_full().w(relative(hp as f32 / 100.0)).bg(hex(hp_color(hp)))),
                            )
                            .when(p.alive, |d| {
                                d.child(
                                    h_flex()
                                        .mt_1p5()
                                        .gap_2()
                                        .text_size(px(10.5))
                                        .text_color(hex(0x9ca3af))
                                        .child(
                                            h_flex()
                                                .gap_0p5()
                                                .child(div().text_color(if p.armor.unwrap_or(0) > 0 { hexa(0x7dd3fc, 0.8) } else { hex(0x4b5563) }).child("⛨"))
                                                .child(p.armor.unwrap_or(0).to_string()),
                                        )
                                        .child(
                                            div()
                                                .truncate()
                                                .font_family("Consolas")
                                                .text_color(hex(0xd1d5db))
                                                .child(weapon_label(p.weapon.as_deref())),
                                        ),
                                )
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let next = if this.selected.as_deref() == Some(&*id_click) { None } else { Some(id_click.clone()) };
                                this.select(next);
                                cx.notify();
                            }))
                            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                                this.hovered = if *hovered { Some(id_hover.clone()) } else { None };
                                cx.notify();
                            }))
                    })),
            )
    }

    fn timeline_view(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let (min, max) = (self.min_tick(), self.max_tick());
        let span = (max - min).max(1.0);
        let pct = move |t: f64| ((t - min) / span) as f32;
        let tick = self.tick;
        let current = round_at(&self.rounds, tick).map(|r| r.index);
        let bar = self.timeline.clone();
        let tick_from_x = {
            let bar = bar.clone();
            move |x: Pixels| {
                let b = bar.get();
                let k = (f32::from(x - b.origin.x) / f32::from(b.size.width).max(1.0)).clamp(0.0, 1.0);
                (min + k as f64 * span).round()
            }
        };
        let (down_tfx, move_tfx) = (tick_from_x.clone(), tick_from_x);

        let segments = self.rounds.iter().map(|r| {
            let left = pct(r.start_tick as f64);
            let width = (pct(r.end_tick as f64) - left).max(0.0015);
            let is_cur = current == Some(r.index);
            let won = match r.winner.as_deref() {
                Some("T") => Some(TEAM_T),
                Some("CT") => Some(TEAM_CT),
                _ => None,
            };
            let bg = match won {
                Some(c) => hexa(c, if is_cur { 0.33 } else { 0.18 }),
                None => hexa(0xffffff, if is_cur { 0.15 } else { 0.07 }),
            };
            let freeze = match r.freeze_end_tick {
                Some(f) if f > r.start_tick => (f - r.start_tick) as f32 / (r.end_tick - r.start_tick).max(1) as f32,
                _ => 0.0,
            };
            div()
                .absolute()
                .top_0()
                .h(px(28.))
                .left(relative(left))
                .w(relative(width))
                .px(px(1.))
                .child(
                    div()
                        .relative()
                        .size_full()
                        .rounded(px(3.))
                        .overflow_hidden()
                        .bg(bg)
                        .when(is_cur, |d| d.border_1().border_color(hexa(0xffffff, 0.6)))
                        .when(freeze > 0.0, |d| {
                            d.child(div().absolute().top_0().bottom_0().left_0().w(relative(freeze)).bg(hexa(0x000000, 0.25)))
                        })
                        .when_some(won, |d, c| d.child(div().absolute().left_0().right_0().bottom_0().h(px(3.)).bg(hex(c))))
                        .child(
                            div()
                                .absolute()
                                .left(px(4.))
                                .top(px(3.))
                                .text_size(px(10.))
                                .font_family("Consolas")
                                .when(is_cur, |d| d.font_weight(FontWeight::BOLD).text_color(hex(0xffffff)))
                                .when(!is_cur, |d| d.text_color(hex(0x9ca3af)))
                                .child((r.index + 1).to_string()),
                        ),
                )
        });

        let pips = self
            .events
            .iter()
            .filter(|e| (e.start_tick as f64) >= min && (e.start_tick as f64) <= max)
            .enumerate()
            .map(|(i, e)| {
                let c = match e.kind.to_lowercase().as_str() {
                    "team_kill" => 0xff4d5e,
                    "team_damage" => 0xff9a3d,
                    "team_flash" => 0xffe066,
                    _ => 0x9aa0a8,
                };
                let target = (e.start_tick as f64 - 3.0 * TICKRATE).max(min);
                div()
                    .id(SharedString::from(format!("pip-{i}")))
                    .absolute()
                    .top_0()
                    .left(relative(pct(e.start_tick as f64)))
                    .ml(px(-3.))
                    .w(px(6.))
                    .h(px(10.))
                    .rounded_sm()
                    .bg(hex(c))
                    .cursor_pointer()
                    .hover(|s| s.bg(hex(0xffffff)))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _: &MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                            this.seek(target, cx);
                        }),
                    )
            });

        let hover_label = self.timeline_hover.map(|(x, t)| {
            let label = match round_at(&self.rounds, t) {
                Some(r) => {
                    let live = r.freeze_end_tick.filter(|f| *f > 0).unwrap_or(r.start_tick) as f64;
                    let clock = if t < live { format!("freeze {}", mmss((live - t) / TICKRATE)) } else { mmss((t - live) / TICKRATE) };
                    format!("R{} · {clock}", r.index + 1)
                }
                None => mmss((t - min) / TICKRATE),
            };
            div()
                .absolute()
                .top(px(-26.))
                .left(px(x))
                .ml(px(-40.))
                .w(px(80.))
                .flex()
                .justify_center()
                .child(
                    div()
                        .px_1p5()
                        .py_0p5()
                        .rounded_sm()
                        .bg(hexa(0x000000, 0.85))
                        .text_size(px(10.))
                        .font_family("Consolas")
                        .text_color(hex(0xe5e7eb))
                        .child(label),
                )
        });

        div()
            .id("timeline")
            .relative()
            .h(px(40.))
            .cursor_pointer()
            .child(canvas(move |b, _, _| bar.set(b), |_, _, _, _| {}).absolute().inset_0())
            .children(segments)
            .child(div().absolute().left_0().right_0().bottom_0().h(px(10.)).children(pips))
            .child(
                div()
                    .absolute()
                    .top(px(-4.))
                    .bottom(px(10.))
                    .left(relative(pct(tick)))
                    .ml(px(-1.))
                    .w(px(2.))
                    .bg(hex(0xffffff))
                    .child(div().absolute().top(px(-3.)).left(px(-4.)).size(px(10.)).rounded(px(2.)).bg(hex(0xffffff))),
            )
            .children(hover_label)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                    this.scrubbing = true;
                    this.seek(down_tfx(ev.position.x), cx);
                }),
            )
            .on_mouse_move(cx.listener(move |this, ev: &MouseMoveEvent, _, cx| {
                let t = move_tfx(ev.position.x);
                let x = f32::from(ev.position.x - this.timeline.get().origin.x);
                this.timeline_hover = Some((x, t));
                if this.scrubbing && ev.pressed_button == Some(MouseButton::Left) {
                    this.seek(t, cx);
                }
                cx.notify();
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _: &MouseUpEvent, _, cx| {
                    this.scrubbing = false;
                    cx.notify();
                }),
            )
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !*hovered && !this.scrubbing {
                    this.timeline_hover = None;
                    cx.notify();
                }
            }))
    }

    fn layers_popover(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let row = |id: &'static str, label: &'static str, on: bool, set: fn(&mut Layers, bool), cx: &mut Context<Self>| {
            h_flex()
                .id(id)
                .justify_between()
                .gap_6()
                .px_1()
                .py_1p5()
                .rounded_sm()
                .text_sm()
                .cursor_pointer()
                .hover(|s| s.bg(hexa(0xffffff, 0.05)))
                .child(label)
                .child(
                    div()
                        .relative()
                        .w(px(32.))
                        .h(px(18.))
                        .rounded_full()
                        .bg(if on { crate::theme::accent().into() } else { hexa(0xffffff, 0.15) })
                        .child(div().absolute().top(px(2.)).left(px(if on { 16. } else { 2. })).size(px(14.)).rounded_full().bg(hex(0xffffff))),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    set(&mut this.layers, !on);
                    cx.notify();
                }))
        };
        let l = self.layers;
        v_flex()
            .w(px(288.))
            .p_3()
            .rounded_lg()
            .bg(hex(0x1f2226))
            .border_1()
            .border_color(hexa(0xffffff, 0.1))
            .text_color(hex(0xe5e7eb))
            .child(label_caps("Show").mb_2())
            .child(row("layer-names", "Player names", l.names, |l, v| l.names = v, cx))
            .child(row("layer-trails", "Movement trails", l.trails, |l, v| l.trails = v, cx))
            .child(row("layer-utility", "Grenades & utility", l.utility, |l, v| l.utility = v, cx))
            .child(row("layer-shots", "Shot tracers", l.shots, |l, v| l.shots = v, cx))
            .child(row("layer-events", "Grief event markers", l.events, |l, v| l.events = v, cx))
            .child(label_caps("Map style").mt_3().mb_2())
            .child(segmented(
                "style",
                &[("flat", "Flat"), ("original", "Original radar")],
                if self.flat_style { "flat" } else { "original" },
                |this, v| this.flat_style = v == "flat",
                cx,
            ))
    }
}

fn segmented(
    id: &'static str,
    options: &[(&'static str, &'static str)],
    value: &str,
    set: fn(&mut Viewer2D, &str),
    cx: &mut Context<Viewer2D>,
) -> impl IntoElement {
    h_flex().p(px(2.)).rounded_md().bg(hexa(0x000000, 0.3)).children(options.iter().map(|(v, label)| {
        let active = *v == value;
        let v = *v;
        div()
            .id(SharedString::from(format!("{id}-{v}")))
            .px_2()
            .py_1()
            .rounded_sm()
            .text_size(px(11.))
            .font_family("Consolas")
            .cursor_pointer()
            .when(active, |d| d.bg(hexa(0xffffff, 0.15)).text_color(hex(0xffffff)))
            .when(!active, |d| d.text_color(hex(0x9ca3af)).hover(|s| s.text_color(hex(0xe5e7eb))))
            .child(*label)
            .on_click(cx.listener(move |this, _, _, cx| {
                set(this, v);
                cx.notify();
            }))
    }))
}

fn help_popover() -> impl IntoElement {
    let keys: [(&str, String); 8] = [
        ("Space", "Play / pause".into()),
        ("← / →", format!("Back / forward {}s", SKIP_SECONDS as i64)),
        ("Shift + ← / →", "Previous / next round".into()),
        ("[ / ]", "Slower / faster".into()),
        ("+ / − / 0", "Zoom in / out / fit".into()),
        ("Click player", "Select and follow".into()),
        ("F", "Toggle follow".into()),
        ("Esc", "Deselect / close".into()),
    ];
    let legend: [(AnyElement, &str); 10] = [
        (swatch(TEAM_T).into_any_element(), "Terrorist (points where they look)"),
        (swatch(TEAM_CT).into_any_element(), "Counter-Terrorist"),
        (div().size(px(12.)).rounded_full().border_2().border_color(hex(0xff4d5e)).into_any_element(), "Inner ring: health (red at 30 or less)"),
        (div().text_xs().font_weight(FontWeight::BOLD).text_color(hex(0xd1d5db)).child("✕").into_any_element(), "Dead player"),
        (swatch(0xc3c7ce).into_any_element(), "Smoke (edge ring counts down)"),
        (swatch(0xff7a3d).into_any_element(), "Molotov / incendiary"),
        (swatch(0x5fd08a).into_any_element(), "HE grenade"),
        (swatch(0xfff3a8).into_any_element(), "Flashbang"),
        (swatch(0xb48cff).into_any_element(), "Decoy"),
        (
            div().px_1().rounded_sm().bg(hex(0xff4d5e)).text_size(px(9.)).font_weight(FontWeight::BOLD).text_color(hex(0x16181b)).child("TK").into_any_element(),
            "Team kill / damage / flash marker",
        ),
    ];
    h_flex()
        .items_start()
        .w(px(420.))
        .gap_4()
        .p_3()
        .rounded_lg()
        .bg(hex(0x1f2226))
        .border_1()
        .border_color(hexa(0xffffff, 0.1))
        .text_color(hex(0xe5e7eb))
        .child(
            v_flex().flex_1().gap_1p5().child(label_caps("Shortcuts").mb_1()).children(keys.into_iter().map(|(k, v)| {
                h_flex()
                    .justify_between()
                    .gap_2()
                    .text_xs()
                    .child(div().text_color(hex(0x9ca3af)).child(v))
                    .child(
                        div()
                            .px_1p5()
                            .py_0p5()
                            .rounded_sm()
                            .border_1()
                            .border_color(hexa(0xffffff, 0.15))
                            .bg(hexa(0x000000, 0.3))
                            .text_size(px(10.))
                            .font_family("Consolas")
                            .child(k),
                    )
            })),
        )
        .child(
            v_flex().flex_1().gap_1p5().child(label_caps("Legend").mb_1()).children(legend.into_iter().map(|(icon, label)| {
                h_flex()
                    .gap_2()
                    .text_xs()
                    .text_color(hex(0x9ca3af))
                    .child(div().w(px(20.)).flex().justify_center().child(icon))
                    .child(label)
            })),
        )
}

impl Render for Viewer2D {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.advance(window, cx);
        let tick = self.tick;
        let players = self.players_at(tick);

        // Without a radar calibration, frame the players once.
        if radar_for(&self.map).is_none() && self.fallback_bounds.is_none() && !players.is_empty() {
            let pad = 1500.0;
            let fold = |f: fn(f32, f32) -> f32, init: f32, g: fn(&PlayerFrame) -> f32| players.iter().map(g).fold(init, f);
            self.fallback_bounds = Some(MapBounds {
                min_x: fold(f32::min, f32::INFINITY, |p| p.x) - pad,
                min_y: fold(f32::min, f32::INFINITY, |p| p.y) - pad,
                max_x: fold(f32::max, f32::NEG_INFINITY, |p| p.x) + pad,
                max_y: fold(f32::max, f32::NEG_INFINITY, |p| p.y) + pad,
            });
        }
        self.follow_camera(&players, window);

        let current = round_near(&self.rounds, tick).cloned();
        let round_number = current.as_ref().map_or(1, |r| r.index + 1);
        let total_rounds = self.rounds.len();
        let (t_score, ct_score) = score_at(&self.rounds, tick);
        let (phase, clock) = phase_at(current.as_ref(), tick);

        // Floors.
        let info = radar_for(&self.map);
        let levels: Vec<(f32, f32, &'static str, &'static str)> =
            info.as_ref().map(|i| i.levels.iter().map(|l| (l.min, l.max, l.image, l.name)).collect()).unwrap_or_default();
        let selected_player = self.selected.as_ref().and_then(|s| players.iter().find(|p| &p.steamid == s)).cloned();
        let auto_level = match (&selected_player, &info) {
            (Some(p), Some(i)) if i.levels.len() > 1 => level_index_at(&i.levels, p.z),
            _ => 0,
        };
        let shown_level = self.level_choice.map_or(auto_level, |c| c.min(levels.len().saturating_sub(1)));
        let art = levels.get(shown_level).map(|l| l.2).and_then(|img| self.art_for(img, cx));

        // Grief markers on the map.
        let mut marks = Vec::new();
        for e in &self.events {
            let (c, label) = match e.kind.to_lowercase().as_str() {
                "team_kill" => (0xff4d5e, "TK"),
                "team_damage" => (0xff9a3d, "TD"),
                "team_flash" => (0xffe066, "TF"),
                _ => continue,
            };
            let d = tick - e.start_tick as f64;
            if d < -EVENT_WINDOW / 3.0 || d > EVENT_WINDOW {
                continue;
            }
            let Some(who) = e.victim.as_deref().or(e.actor.as_deref()) else { continue };
            if let Some(p) = self.position_at(who, e.start_tick as f64, e.round_index) {
                marks.push(EventMark { x: p.x, y: p.y, alpha: (1.0 - d.abs() / EVENT_WINDOW).max(0.0) as f32, color: c, label });
            }
        }

        let scene_round = round_at(&self.rounds, resolve_tick(&self.rounds, tick).0).and_then(|r| self.loaded.get(&r.index)).cloned();
        let waiting = scene_round.is_none() && !self.loading.is_empty();
        let no_data = scene_round.as_ref().is_some_and(|r| r.positions.is_empty());
        let scene = self.map_bounds().map(|bounds| Scene {
            bounds,
            transform: self.transform,
            art: art.as_ref().zip(info.as_ref()).map(|(a, i)| {
                (if self.flat_style { a.flat.clone() } else { a.original.clone() }, i.x, i.y, i.scale)
            }),
            tick,
            players: players.clone(),
            layers: self.layers,
            selected: self.selected.clone(),
            hovered: self.hovered.clone(),
            round_start: current.as_ref().map_or(0.0, |r| r.start_tick as f64),
            round_end: current.as_ref().map_or(0.0, |r| r.end_tick as f64),
            round: scene_round.clone(),
            events: marks,
            levels: (levels.len() > 1).then(|| (levels.iter().map(|l| (l.0, l.1)).collect(), shown_level)),
        });

        // Kill feed: kills in the last 5 s, newest first.
        let team_of = |id: Option<&str>| id.and_then(|id| players.iter().find(|p| &*p.steamid == id)).and_then(|p| p.team.clone());
        let name_of = |id: Option<&str>| {
            id.map(|id| {
                players
                    .iter()
                    .find(|p| &*p.steamid == id)
                    .map(|p| p.name.to_string())
                    .or_else(|| self.names.get(id).cloned())
                    .unwrap_or_else(|| "Unknown".into())
            })
            .unwrap_or_else(|| "Unknown".into())
        };
        let mut kills: Vec<&MatchEvent> = self
            .events
            .iter()
            .filter(|e| {
                let k = e.kind.to_uppercase();
                (k == "TEAM_KILL" || k == "KILL" || k == "KILLS")
                    && e.actor.is_some()
                    && e.victim.is_some()
                    && (0.0..FEED_SECONDS).contains(&((tick - e.start_tick as f64) / TICKRATE))
            })
            .collect();
        kills.sort_by(|a, b| b.start_tick.cmp(&a.start_tick));
        kills.truncate(5);
        let feed = v_flex().absolute().top_3().right_3().items_end().gap_1().children(kills.into_iter().map(|k| {
            let age = (tick - k.start_tick as f64) / TICKRATE;
            let tk = k.kind.eq_ignore_ascii_case("team_kill");
            let weapon = k
                .meta
                .get("weapon")
                .and_then(|w| w.as_str().map(str::to_string).or_else(|| w.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).map(str::to_string)))
                .map(|w| w.trim_start_matches("weapon_").to_uppercase())
                .unwrap_or_else(|| "✕".into());
            h_flex()
                .gap_2()
                .px_2p5()
                .py_1()
                .rounded_md()
                .border_1()
                .text_xs()
                .opacity((1.0 - age / FEED_SECONDS).max(0.35) as f32)
                .when(tk, |d| d.border_color(hexa(0xff4d5e, 0.6)).bg(hexa(0x3a1418, 0.85)))
                .when(!tk, |d| d.border_color(hexa(0xffffff, 0.1)).bg(hexa(0x121417, 0.85)))
                .child(div().font_weight(FontWeight::SEMIBOLD).text_color(hex(team_color(team_of(k.actor.as_deref()).as_deref()))).child(name_of(k.actor.as_deref())))
                .child(div().text_size(px(10.)).font_family("Consolas").text_color(hex(0x9ca3af)).child(weapon))
                .child(div().font_weight(FontWeight::SEMIBOLD).text_color(hex(team_color(team_of(k.victim.as_deref()).as_deref()))).child(name_of(k.victim.as_deref())))
                .when(tk, |d| d.child(div().px_1().rounded_sm().bg(hex(0xff4d5e)).text_size(px(9.)).font_weight(FontWeight::BOLD).text_color(hex(0x16181b)).child("TK")))
        }));

        let score_bug = div().absolute().top_3().left_0().right_0().flex().justify_center().child(
            h_flex()
                .items_stretch()
                .rounded_lg()
                .overflow_hidden()
                .border_1()
                .border_color(hexa(0xffffff, 0.1))
                .bg(hexa(0x121417, 0.9))
                .child(
                    h_flex()
                        .gap_2()
                        .px_3()
                        .py_1p5()
                        .child(div().text_size(px(10.)).font_weight(FontWeight::BOLD).text_color(hex(TEAM_T)).child("T"))
                        .child(div().text_lg().font_weight(FontWeight::BOLD).font_family("Consolas").child(t_score.to_string())),
                )
                .child(
                    v_flex()
                        .min_w(px(84.))
                        .items_center()
                        .justify_center()
                        .px_3()
                        .border_l_1()
                        .border_r_1()
                        .border_color(hexa(0xffffff, 0.1))
                        .bg(hexa(0xffffff, 0.03))
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::SEMIBOLD)
                                .font_family("Consolas")
                                .text_color(if phase == Phase::Freeze { hex(0x7dd3fc) } else { hex(0xffffff) })
                                .child(clock.clone()),
                        )
                        .child(div().text_size(px(9.)).font_weight(FontWeight::SEMIBOLD).text_color(hex(0x9ca3af)).child(match phase {
                            Phase::Freeze => "FREEZE".to_string(),
                            Phase::Over => "ROUND OVER".to_string(),
                            Phase::Live => format!("ROUND {round_number} / {total_rounds}"),
                        })),
                )
                .child(
                    h_flex()
                        .gap_2()
                        .px_3()
                        .py_1p5()
                        .child(div().text_lg().font_weight(FontWeight::BOLD).font_family("Consolas").child(ct_score.to_string()))
                        .child(div().text_size(px(10.)).font_weight(FontWeight::BOLD).text_color(hex(TEAM_CT)).child("CT")),
                ),
        );

        let follow_chip = selected_player.as_ref().map(|p| {
            h_flex()
                .absolute()
                .left_3()
                .top_3()
                .gap_2()
                .py_1()
                .pl_2p5()
                .pr_1()
                .rounded_lg()
                .border_1()
                .border_color(hexa(0xffffff, 0.1))
                .bg(hexa(0x16181b, 0.9))
                .text_xs()
                .child(div().size(px(8.)).rounded_full().bg(hex(team_color(p.team.as_deref()))))
                .child(div().max_w(px(160.)).truncate().font_weight(FontWeight::MEDIUM).child(p.name.to_string()))
                .child(
                    div()
                        .id("follow-toggle")
                        .px_1p5()
                        .py_0p5()
                        .rounded_sm()
                        .cursor_pointer()
                        .when(self.following, |d| d.bg(hexa(0xffffff, 0.15)).text_color(hex(0xffffff)))
                        .when(!self.following, |d| d.text_color(hex(0x9ca3af)).hover(|s| s.text_color(hex(0xffffff))))
                        .child(if self.following { "◎ Following" } else { "◎ Follow" })
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.following = !this.following;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .id("deselect")
                        .p_0p5()
                        .rounded_sm()
                        .cursor_pointer()
                        .text_color(hex(0x9ca3af))
                        .hover(|s| s.bg(hexa(0xffffff, 0.1)).text_color(hex(0xffffff)))
                        .child(IconName::Close)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.select(None);
                            cx.notify();
                        })),
                )
        });

        let level_buttons = (levels.len() > 1).then(|| {
            let button = |id: SharedString, label: String, active: bool, dim: bool, choice: Option<usize>, cx: &mut Context<Self>| {
                div()
                    .id(id)
                    .px_2p5()
                    .py_1()
                    .rounded_md()
                    .text_size(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .cursor_pointer()
                    .when(active, |d| d.bg(hexa(0xffffff, 0.15)).text_color(hex(0xffffff)))
                    .when(!active && dim, |d| d.text_color(hex(0xe5e7eb)).border_1().border_color(hexa(0xffffff, 0.15)))
                    .when(!active && !dim, |d| d.text_color(hex(0x9ca3af)).hover(|s| s.bg(hexa(0xffffff, 0.08))))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.level_choice = choice;
                        cx.notify();
                    }))
            };
            let mut col = v_flex()
                .absolute()
                .bottom_3()
                .left_3()
                .gap_1()
                .p_1()
                .rounded_lg()
                .border_1()
                .border_color(hexa(0xffffff, 0.1))
                .bg(hexa(0x16181b, 0.85))
                .child(button("level-auto".into(), "Auto".into(), self.level_choice.is_none(), false, None, cx));
            for (i, l) in levels.iter().enumerate() {
                col = col.child(button(
                    SharedString::from(format!("level-{i}")),
                    l.3.to_string(),
                    self.level_choice == Some(i),
                    self.level_choice.is_none() && shown_level == i,
                    Some(i),
                    cx,
                ));
            }
            col
        });

        let zoomed = self.transform.zoom > 1.01;
        let zoom_controls = v_flex()
            .absolute()
            .bottom_3()
            .right_3()
            .rounded_lg()
            .overflow_hidden()
            .border_1()
            .border_color(hexa(0xffffff, 0.1))
            .bg(hexa(0x16181b, 0.85))
            .child(transport_button("zoom-in", IconName::Plus).rounded_none().on_click(cx.listener(|this, _, _, cx| this.zoom_by(BUTTON_STEP, cx))))
            .child(
                div()
                    .py_1()
                    .border_t_1()
                    .border_b_1()
                    .border_color(hexa(0xffffff, 0.1))
                    .text_center()
                    .text_size(px(10.))
                    .font_family("Consolas")
                    .text_color(hex(0x9ca3af))
                    .child(format!("{}%", (self.transform.zoom * 100.0).round())),
            )
            .child(
                transport_button("zoom-out", IconName::Minus)
                    .rounded_none()
                    .when(!zoomed, |d| d.opacity(0.35))
                    .on_click(cx.listener(|this, _, _, cx| this.zoom_by(1.0 / BUTTON_STEP, cx))),
            )
            .child(
                transport_button("zoom-fit", IconName::Maximize)
                    .rounded_none()
                    .border_t_1()
                    .border_color(hexa(0xffffff, 0.1))
                    .when(!zoomed, |d| d.opacity(0.35))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.following = false;
                        this.transform = Transform::IDENTITY;
                        cx.notify();
                    })),
            );

        let canvas_cell = self.canvas.clone();
        let map_area = div()
            .id("radar")
            .relative()
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_hidden()
            .bg(hex(0x16191c))
            .when(self.hovered.is_some() && self.drag.is_none(), |d| d.cursor_pointer())
            .when(self.drag.as_ref().is_some_and(|d| d.moved), |d| d.cursor_grabbing())
            .child(
                canvas(
                    move |b, _, _| canvas_cell.set(b),
                    move |b, _, window, cx| {
                        if let Some(scene) = scene {
                            window.with_content_mask(Some(ContentMask { bounds: b }), |window| scene::draw(&scene, b, window, cx));
                        }
                    },
                )
                .absolute()
                .inset_0(),
            )
            .child(score_bug)
            .child(feed)
            .children(level_buttons)
            .children(follow_chip)
            .child(zoom_controls)
            .when(waiting, |d| {
                d.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(hexa(0x121417, 0.7))
                        .text_sm()
                        .text_color(hex(0xd1d5db))
                        .child("Loading positions…"),
                )
            })
            .when(no_data, |d| {
                d.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_sm()
                        .text_color(hex(0x6b7280))
                        .child("No position data for this round"),
                )
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                    window.focus(&this.focus, cx);
                    this.drag = Some(Drag { start: ev.position, last: ev.position, moved: false });
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, _, cx| {
                match &mut this.drag {
                    Some(d) if ev.pressed_button == Some(MouseButton::Left) => {
                        let delta = ev.position - d.start;
                        let dist = (f32::from(delta.x).powi(2) + f32::from(delta.y).powi(2)).sqrt();
                        if !d.moved && dist < CLICK_SLOP {
                            return;
                        }
                        if !d.moved {
                            d.moved = true;
                            this.following = false;
                        }
                        let (dx, dy) = (f32::from(ev.position.x - d.last.x), f32::from(ev.position.y - d.last.y));
                        d.last = ev.position;
                        let (w, h) = {
                            let b = this.canvas.get();
                            (f32::from(b.size.width), f32::from(b.size.height))
                        };
                        let t = this.transform;
                        this.transform = Transform { zoom: t.zoom, x: t.x + dx, y: t.y + dy }.clamped(w, h);
                    }
                    _ => {
                        this.drag = None;
                        let hit = this.hit(ev.position);
                        if hit != this.hovered {
                            this.hovered = hit;
                        } else {
                            return;
                        }
                    }
                }
                cx.notify();
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseUpEvent, _, cx| {
                    if let Some(d) = this.drag.take() {
                        if !d.moved {
                            let hit = this.hit(ev.position);
                            let next = if hit.is_some() && hit == this.selected { None } else { hit };
                            this.select(next);
                        }
                    }
                    cx.notify();
                }),
            )
            .on_scroll(cx.listener(|this, ev: &ScrollEvent, _, cx| {
                // GPUI scrolls up with a positive delta; Electron zooms in on a negative deltaY.
                let dy = match ev.delta {
                    ScrollDelta::Pixels(p) => f32::from(p.y),
                    ScrollDelta::Lines(l) => l.y * 100.0,
                };
                let (x, y) = this.local(ev.position);
                let (w, h) = this.canvas_size();
                this.transform = this.transform.zoom_at((dy * WHEEL_SPEED).exp(), x, y, w, h);
                if this.following {
                    this.following = false;
                }
                cx.stop_propagation();
                cx.notify();
            }))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !*hovered && this.hovered.is_some() {
                    this.hovered = None;
                    cx.notify();
                }
            }));

        let phase_pill = {
            let (bg, fg, label) = match phase {
                Phase::Freeze => (hexa(0x38bdf8, 0.15), hex(0x7dd3fc), "FREEZE TIME"),
                Phase::Live => (hexa(0x34d399, 0.15), hex(0x6ee7b7), "LIVE"),
                Phase::Over => (hexa(0xffffff, 0.1), hex(0x9ca3af), "ROUND OVER"),
            };
            div().px_2().py_0p5().rounded_full().bg(bg).text_color(fg).text_size(px(10.)).font_weight(FontWeight::SEMIBOLD).child(label)
        };
        let menu = self.menu;
        let top_bar = h_flex()
            .h(px(48.))
            .flex_shrink_0()
            .gap_3()
            .px_4()
            .bg(hex(0x1b1d21))
            .border_b_1()
            .border_color(hexa(0xffffff, 0.06))
            .child(
                h_flex()
                    .gap_2()
                    .items_baseline()
                    .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(hex(0xffffff)).child(pretty_map_name(if self.map.is_empty() { "Unknown map" } else { &self.map })))
                    .child(div().text_size(px(11.)).font_family("Consolas").text_color(hex(0x6b7280)).child(self.map.clone())),
            )
            .child(div().w(px(1.)).h(px(16.)).bg(hexa(0xffffff, 0.1)))
            .child(
                h_flex()
                    .gap_1()
                    .text_xs()
                    .text_color(hex(0x9ca3af))
                    .child("Round")
                    .child(div().font_weight(FontWeight::SEMIBOLD).text_color(hex(0xf3f4f6)).child(round_number.to_string()))
                    .when(total_rounds > 0, |d| d.child(div().text_color(hex(0x6b7280)).child(format!("of {total_rounds}")))),
            )
            .child(phase_pill)
            .when(!self.loading.is_empty(), |d| d.child(div().text_size(px(11.)).text_color(hex(0x6b7280)).child("Loading rounds…")))
            .child(div().flex_1())
            .child(
                header_button("menu-layers", menu == Menu::Layers)
                    .child(IconName::Settings2)
                    .child("Layers")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.menu = if this.menu == Menu::Layers { Menu::None } else { Menu::Layers };
                        cx.notify();
                    })),
            )
            .child(
                header_button("menu-help", menu == Menu::Help)
                    .child(IconName::Info)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.menu = if this.menu == Menu::Help { Menu::None } else { Menu::Help };
                        cx.notify();
                    })),
            );

        let (min, max) = (self.min_tick(), self.max_tick());
        let transport = v_flex()
            .flex_shrink_0()
            .px_4()
            .pt_2p5()
            .pb_3()
            .bg(hex(0x1b1d21))
            .border_t_1()
            .border_color(hexa(0xffffff, 0.06))
            .child(
                h_flex()
                    .mb_2p5()
                    .gap_3()
                    .child(
                        h_flex()
                            .gap_0p5()
                            .child(transport_button("prev-round", IconName::ChevronLeft).on_click(cx.listener(|this, _, _, cx| this.jump_round(-1, cx))))
                            .child(transport_button("back-5", IconName::Undo2).on_click(cx.listener(|this, _, _, cx| {
                                this.seek(this.tick - SKIP_SECONDS * TICKRATE, cx)
                            })))
                            .child(
                                div()
                                    .id("play")
                                    .mx_1()
                                    .size(px(36.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .bg(crate::theme::accent())
                                    .text_color(hex(0xffffff))
                                    .cursor_pointer()
                                    .hover(|s| s.bg(crate::theme::accent_light()))
                                    .child(if self.playing { IconName::Pause } else { IconName::Play })
                                    .on_click(cx.listener(|this, _, _, cx| this.toggle_play(cx))),
                            )
                            .child(transport_button("fwd-5", IconName::Redo2).on_click(cx.listener(|this, _, _, cx| {
                                this.seek(this.tick + SKIP_SECONDS * TICKRATE, cx)
                            })))
                            .child(transport_button("next-round", IconName::ChevronRight).on_click(cx.listener(|this, _, _, cx| this.jump_round(1, cx)))),
                    )
                    .child(
                        h_flex()
                            .text_xs()
                            .font_family("Consolas")
                            .text_color(hex(0x9ca3af))
                            .child(div().text_color(hex(0xf3f4f6)).child(mmss((tick - min) / TICKRATE)))
                            .child(format!(" / {}", mmss((max - min) / TICKRATE))),
                    )
                    .child(div().flex_1())
                    .child(
                        h_flex()
                            .gap_2()
                            .child(label_caps("Speed"))
                            .child(segmented(
                                "speed",
                                &[("0.5", "0.5×"), ("1", "1×"), ("2", "2×"), ("4", "4×"), ("8", "8×")],
                                &format!("{}", self.speed),
                                |this, v| this.speed = v.parse().unwrap_or(1.0),
                                cx,
                            )),
                    ),
            )
            .child(self.timeline_view(cx));

        let popover = match menu {
            Menu::None => None,
            Menu::Layers => Some(self.layers_popover(cx).into_any_element()),
            Menu::Help => Some(help_popover().into_any_element()),
        };

        v_flex()
            .id("viewer2d")
            .key_context("Viewer2D")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .relative()
            .size_full()
            .min_h_0()
            .overflow_hidden()
            .bg(hex(0x141619))
            .text_color(hex(0xe5e7eb))
            .child(top_bar)
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .items_stretch()
                    .child(self.roster("T", &players, t_score, true, cx))
                    .child(map_area)
                    .child(self.roster("CT", &players, ct_score, false, cx)),
            )
            .child(transport)
            .when_some(popover, |d, pop| {
                d.child(
                    div()
                        .id("popover-backdrop")
                        .absolute()
                        .inset_0()
                        // Clicking outside only closes the menu (no select/seek underneath).
                        .occlude()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _: &MouseDownEvent, _, cx| {
                                this.menu = Menu::None;
                                cx.notify();
                            }),
                        ),
                )
                .child(div().absolute().top(px(44.)).right_3().occlude().child(pop))
            })
    }
}

impl Focusable for Viewer2D {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
