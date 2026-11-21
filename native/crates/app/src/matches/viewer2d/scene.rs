//! Drawing the replay (Electron `renderScene.ts` + `radarMath.ts`) with GPUI paths,
//! images and shaped text inside a `canvas()`.

use std::sync::Arc;

use gpui_kit::*;

use super::data::{
    AreaKind, GrenadeKind, PlayerFrame, RADAR_PX, RoundView, TICKRATE, grenade_color, grenade_kind, is_knife,
    is_utility, team_color,
};

pub const TOKEN_RADIUS: f32 = 9.0;
const OFF_LEVEL_ALPHA: f32 = 0.25;
const TRAIL_SECONDS: f64 = 3.0;
const SHOT_TICKS: f64 = 8.0;
const BLAST_TICKS: f64 = 28.0;
const SMOKE_R: f32 = 144.0;
const FIRE_R: f32 = 120.0;
pub const PAD_SHARE: f32 = 0.03;
pub const MIN_ZOOM: f32 = 1.0;
pub const MAX_ZOOM: f32 = 8.0;

/// A box of the game world: (min x, min y, max x, max y).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct MapBounds {
    pub min_x: f32,
    pub min_y: f32,
    pub max_x: f32,
    pub max_y: f32,
}

/// Zoom and pan over the fitted view, in canvas pixels: screen = fitted * zoom + (x, y).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Transform {
    pub zoom: f32,
    pub x: f32,
    pub y: f32,
}

impl Transform {
    pub const IDENTITY: Self = Self { zoom: 1.0, x: 0.0, y: 0.0 };

    /// Keeps the zoom in range and the zoomed canvas covering the viewport.
    pub fn clamped(self, w: f32, h: f32) -> Self {
        let zoom = self.zoom.clamp(MIN_ZOOM, MAX_ZOOM);
        let clamp = |v: f32, size: f32| v.clamp(size - size * zoom, 0.0);
        Self { zoom, x: clamp(self.x, w), y: clamp(self.y, h) }
    }

    /// Zoom by `factor` keeping canvas point (px, py) where it is.
    pub fn zoom_at(self, factor: f32, px: f32, py: f32, w: f32, h: f32) -> Self {
        let zoom = (self.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        let k = zoom / self.zoom;
        Self { zoom, x: px - (px - self.x) * k, y: py - (py - self.y) * k }.clamped(w, h)
    }

    /// Puts fitted-canvas point (px, py) in the middle of the viewport at `zoom`.
    pub fn centre_on(px: f32, py: f32, zoom: f32, w: f32, h: f32) -> Self {
        Self { zoom, x: w / 2.0 - px * zoom, y: h / 2.0 - py * zoom }.clamped(w, h)
    }
}

/// Game x/y ↔ canvas pixels (north up, bounds fitted and centred), with a transform applied.
#[derive(Clone, Copy, Debug)]
pub struct RadarView {
    fit_scale: f32,
    ox: f32,
    oy: f32,
    min_x: f32,
    max_y: f32,
    t: Transform,
}

impl RadarView {
    pub fn fit(b: MapBounds, w: f32, h: f32, t: Transform) -> Self {
        let pad = w.min(h) * PAD_SHARE;
        let dx = (b.max_x - b.min_x).max(1.0);
        let dy = (b.max_y - b.min_y).max(1.0);
        let fit_scale = ((w - 2.0 * pad) / dx).min((h - 2.0 * pad) / dy).max(0.0);
        Self {
            fit_scale,
            ox: (w - dx * fit_scale) / 2.0,
            oy: (h - dy * fit_scale) / 2.0,
            min_x: b.min_x,
            max_y: b.max_y,
            t,
        }
    }
    /// Canvas pixels per game unit.
    pub fn scale(&self) -> f32 {
        self.fit_scale * self.t.zoom
    }
    /// Without the zoom/pan (for camera follow).
    pub fn to_fitted(&self, x: f32, y: f32) -> (f32, f32) {
        (self.ox + (x - self.min_x) * self.fit_scale, self.oy + (self.max_y - y) * self.fit_scale)
    }
    pub fn to_canvas(&self, x: f32, y: f32) -> (f32, f32) {
        let (px, py) = self.to_fitted(x, y);
        (px * self.t.zoom + self.t.x, py * self.t.zoom + self.t.y)
    }
}

/// A game yaw (degrees, 0 = +x, 90 = +y) as a canvas angle (radians, y down).
fn yaw_to_canvas(yaw: f32) -> f32 {
    -yaw.to_radians()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Layers {
    pub names: bool,
    pub trails: bool,
    pub utility: bool,
    pub shots: bool,
    pub events: bool,
}

impl Default for Layers {
    fn default() -> Self {
        Self { names: true, trails: true, utility: true, shots: true, events: true }
    }
}

/// A grief-event marker resolved to a spot (`drawEvents`).
pub struct EventMark {
    pub x: f32,
    pub y: f32,
    pub alpha: f32,
    pub color: u32,
    pub label: &'static str,
}

/// Everything the canvas needs for one frame.
pub struct Scene {
    pub bounds: MapBounds,
    pub transform: Transform,
    /// Radar image and its calibration (top-left x, y, units per pixel).
    pub art: Option<(Arc<RenderImage>, f32, f32, f32)>,
    pub tick: f64,
    pub players: Vec<PlayerFrame>,
    pub layers: Layers,
    pub selected: Option<Arc<str>>,
    pub hovered: Option<Arc<str>>,
    pub round_start: f64,
    pub round_end: f64,
    pub round: Option<Arc<RoundView>>,
    pub events: Vec<EventMark>,
    /// Floor ranges and the one shown; None = single floor.
    pub levels: Option<(Vec<(f32, f32)>, usize)>,
}

impl Scene {
    fn on_level(&self, z: f32) -> bool {
        match &self.levels {
            None => true,
            Some((levels, shown)) => {
                let i = levels.iter().position(|(min, max)| z >= *min && z < *max).unwrap_or_else(|| {
                    levels
                        .iter()
                        .enumerate()
                        .map(|(i, (min, max))| (i, if z < *min { min - z } else { z - max }))
                        .min_by(|a, b| a.1.total_cmp(&b.1))
                        .map_or(0, |(i, _)| i)
                });
                i == *shown
            }
        }
    }
    fn in_round(&self, tick: i64) -> bool {
        tick as f64 >= self.round_start && tick as f64 <= self.round_end
    }
}

fn color(hex: u32, alpha: f32) -> Hsla {
    let mut c: Hsla = rgb(hex).into();
    c.a = alpha.clamp(0.0, 1.0);
    c
}

/// Paints a scene into canvas `bounds`.
pub struct Painter<'a> {
    window: &'a mut Window,
    cx: &'a mut App,
    origin: Point<Pixels>,
}

impl Painter<'_> {
    fn pt(&self, x: f32, y: f32) -> Point<Pixels> {
        point(self.origin.x + px(x), self.origin.y + px(y))
    }

    fn polygon(&mut self, pts: &[(f32, f32)], fill: Option<Hsla>, stroke: Option<(Hsla, f32)>) {
        if pts.len() < 2 {
            return;
        }
        let points: Vec<Point<Pixels>> = pts.iter().map(|(x, y)| self.pt(*x, *y)).collect();
        if let Some(c) = fill {
            let mut b = PathBuilder::fill();
            b.add_polygon(&points, true);
            if let Ok(p) = b.build() {
                self.window.paint_path(p, c);
            }
        }
        if let Some((c, w)) = stroke {
            let mut b = PathBuilder::stroke(px(w));
            b.add_polygon(&points, true);
            if let Ok(p) = b.build() {
                self.window.paint_path(p, c);
            }
        }
    }

    fn polyline(&mut self, pts: &[(f32, f32)], c: Hsla, width: f32, dash: Option<&[f32]>) {
        if pts.len() < 2 {
            return;
        }
        let mut b = PathBuilder::stroke(px(width));
        if let Some(d) = dash {
            let d: Vec<Pixels> = d.iter().map(|v| px(*v)).collect();
            b = b.dash_array(&d);
        }
        b.move_to(self.pt(pts[0].0, pts[0].1));
        for (x, y) in &pts[1..] {
            b.line_to(self.pt(*x, *y));
        }
        if let Ok(p) = b.build() {
            self.window.paint_path(p, c);
        }
    }

    fn circle(&mut self, x: f32, y: f32, r: f32, fill: Option<Hsla>, stroke: Option<(Hsla, f32)>) {
        if r <= 0.0 {
            return;
        }
        self.polygon(&arc_points(x, y, r, 0.0, std::f32::consts::TAU), fill, stroke);
    }

    fn arc(&mut self, x: f32, y: f32, r: f32, from: f32, to: f32, c: Hsla, width: f32) {
        self.polyline(&arc_points(x, y, r, from, to), c, width, None);
    }

    /// Centred text with a dark outline (canvas `strokeText` + `fillText`).
    fn text(&mut self, s: &str, cx_: f32, top: f32, size: f32, weight: FontWeight, fill: Hsla, outline: Option<Hsla>) {
        let font = Font { weight, ..font(".SystemUIFont") };
        let shape = |c: Hsla, window: &mut Window| {
            window.text_system().shape_line(
                SharedString::from(s.to_string()),
                px(size),
                &[TextRun { len: s.len(), font: font.clone(), color: c, background_color: None, underline: None, strikethrough: None }],
                None,
            )
        };
        let main = shape(fill, self.window);
        let w = f32::from(main.width);
        let x0 = cx_ - w / 2.0;
        let lh = px(size * 1.25);
        if let Some(o) = outline {
            let shadow = shape(o, self.window);
            for (dx, dy) in [(-1.0, 0.0), (1.0, 0.0), (0.0, -1.0), (0.0, 1.0), (-1.0, -1.0), (1.0, 1.0), (-1.0, 1.0), (1.0, -1.0)] {
                let _ = shadow.paint(self.pt(x0 + dx, top + dy), lh, TextAlign::Left, None, self.window, self.cx);
            }
        }
        let _ = main.paint(self.pt(x0, top), lh, TextAlign::Left, None, self.window, self.cx);
    }

    fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, c: Hsla) {
        self.window.paint_quad(fill(Bounds::new(self.pt(x, y), size(px(w), px(h))), c));
    }
}

fn arc_points(x: f32, y: f32, r: f32, from: f32, to: f32) -> Vec<(f32, f32)> {
    let sweep = to - from;
    let n = ((sweep.abs() / std::f32::consts::TAU) * 48.0).ceil().max(6.0) as usize;
    (0..=n)
        .map(|i| {
            let a = from + sweep * i as f32 / n as f32;
            (x + a.cos() * r, y + a.sin() * r)
        })
        .collect()
}

pub fn draw(scene: &Scene, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
    let (w, h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
    let view = RadarView::fit(scene.bounds, w, h, scene.transform);
    let mut p = Painter { window, cx, origin: bounds.origin };

    // Map: the radar image, or a faint grid without one.
    match &scene.art {
        Some((img, ix, iy, iscale)) => {
            let (x0, y0) = view.to_canvas(*ix, *iy);
            let s = RADAR_PX * iscale * view.scale();
            let image_bounds = Bounds::new(p.pt(x0, y0), size(px(s), px(s)));
            let _ = p.window.paint_image(bounds, image_bounds, Corners::default(), img.clone(), 0, false);
        }
        None => draw_grid(&mut p, &view, w, h),
    }
    if let Some(round) = &scene.round {
        if scene.layers.utility {
            draw_utility(&mut p, scene, round, &view);
        }
        if scene.layers.trails {
            draw_trails(&mut p, scene, round, &view);
        }
        if scene.layers.shots {
            draw_shots(&mut p, scene, round, &view);
        }
    }
    if scene.layers.events {
        draw_events(&mut p, scene, &view);
    }
    draw_players(&mut p, scene, &view);
}

fn draw_grid(p: &mut Painter, view: &RadarView, w: f32, h: f32) {
    let c = color(0xffffff, 0.05);
    let step = 512.0 * view.scale();
    if step < 4.0 {
        return;
    }
    let (ox, oy) = view.to_canvas(0.0, 0.0);
    let mut x = ox.rem_euclid(step);
    while x < w {
        p.polyline(&[(x, 0.0), (x, h)], c, 1.0, None);
        x += step;
    }
    let mut y = oy.rem_euclid(step);
    while y < h {
        p.polyline(&[(0.0, y), (w, y)], c, 1.0, None);
        y += step;
    }
}

fn draw_utility(p: &mut Painter, s: &Scene, round: &RoundView, view: &RadarView) {
    let tick = s.tick;
    let units = |u: f32| u * view.scale();

    for e in &round.effects {
        if tick < e.start as f64 || tick >= e.end as f64 || !s.in_round(e.start) {
            continue;
        }
        let level_alpha = if s.on_level(e.z) { 1.0 } else { OFF_LEVEL_ALPHA };
        let (x, y) = view.to_canvas(e.x, e.y);
        let age = ((tick - e.start as f64) / TICKRATE) as f32;
        let left = ((e.end as f64 - tick) / TICKRATE) as f32;
        match e.kind {
            AreaKind::Smoke => {
                let grow = (0.4 + age * 1.1).min(1.0);
                let fade = (left / 1.2).min(1.0);
                let r = units(SMOKE_R) * grow;
                // Electron's radial gradient: a lighter core over a darker rim.
                p.circle(x, y, r, Some(color(0xaaafb8, 0.35 * fade * level_alpha)), None);
                p.circle(x, y, r * 0.6, Some(color(0xcdd1d8, 0.22 * fade * level_alpha)), None);
                let frac = ((e.end as f64 - tick) / ((e.end - e.start).max(1) as f64)).clamp(0.0, 1.0) as f32;
                let start = -std::f32::consts::FRAC_PI_2;
                p.arc(x, y, r, start, start + std::f32::consts::TAU * frac, color(team_color(e.team.as_deref()), 0.85 * fade * level_alpha), 2.0);
            }
            AreaKind::Fire => {
                let fade = (left / 0.8).min(1.0);
                let poly = e.entity_id.and_then(|id| round.infernos.get(&id)).and_then(|samples| {
                    samples.iter().take_while(|smp| smp.tick as f64 <= tick).last().map(|smp| &smp.polygon)
                });
                let fill_c = color(0xff6a28, 0.35 * fade * level_alpha);
                let stroke_c = color(0xff9646, 0.9 * fade * level_alpha);
                match poly {
                    Some(poly) if poly.len() >= 3 => {
                        let pts: Vec<(f32, f32)> = poly.iter().map(|(gx, gy)| view.to_canvas(*gx, *gy)).collect();
                        p.polygon(&pts, Some(fill_c), Some((stroke_c, 1.5)));
                    }
                    _ => p.circle(x, y, units(FIRE_R) * (0.4 + age * 1.5).min(1.0), Some(fill_c), Some((stroke_c, 1.5))),
                }
            }
            AreaKind::Decoy => {
                let pulse = 0.6 + 0.4 * (age * 8.0).sin();
                let c = grenade_color(GrenadeKind::Decoy);
                p.circle(x, y, 3.5, Some(color(c, 0.9 * level_alpha)), None);
                p.circle(x, y, 6.0 + 4.0 * pulse, None, Some((color(c, 0.5 * pulse * level_alpha), 1.5)));
            }
        }
    }

    // HE and flash pops.
    for b in &round.blasts {
        let age = tick - b.tick as f64;
        if !(0.0..=BLAST_TICKS).contains(&age) {
            continue;
        }
        let k = (age / BLAST_TICKS) as f32;
        let (x, y) = view.to_canvas(b.x, b.y);
        let a = (if s.on_level(b.z) { 1.0 } else { OFF_LEVEL_ALPHA }) * (1.0 - k);
        let c = grenade_color(if b.he { GrenadeKind::He } else { GrenadeKind::Flash });
        let r = units(if b.he { 260.0 } else { 180.0 }) * (0.25 + 0.75 * k);
        p.circle(x, y, r, Some(color(c, 0.25 * a)), Some((color(c, a), 2.0)));
    }

    // Grenades in the air.
    for g in &round.tracks {
        let Some(first) = g.path.first() else { continue };
        if tick < first.0 as f64 || tick >= g.detonate as f64 || !s.in_round(first.0) {
            continue;
        }
        let last = g.path.last().unwrap();
        if tick > last.0 as f64 + TICKRATE / 2.0 && g.detonate == i64::MAX {
            continue;
        }
        let c = grenade_color(g.kind);
        let flown: Vec<&(i64, f32, f32, f32)> = g.path.iter().take_while(|pt| pt.0 as f64 <= tick).collect();
        let pts: Vec<(f32, f32)> = flown.iter().map(|pt| view.to_canvas(pt.1, pt.2)).collect();
        p.polyline(&pts, color(c, 0.7), 1.5, Some(&[2.0, 3.0]));
        if let (Some(head), Some(hp)) = (flown.last(), pts.last()) {
            let a = if s.on_level(head.3) { 1.0 } else { OFF_LEVEL_ALPHA };
            p.circle(hp.0, hp.1, 3.5, Some(color(c, a)), Some((color(0x111316, a), 1.5)));
        }
    }
}

fn draw_trails(p: &mut Painter, s: &Scene, round: &RoundView, view: &RadarView) {
    let from = s.round_start.max(s.tick - TRAIL_SECONDS * TICKRATE);
    for pl in &s.players {
        if !pl.alive || !s.on_level(pl.z) {
            continue;
        }
        let Some(idx) = round.player_index(&pl.steamid) else { continue };
        let path = round.path_between(idx, from, s.tick);
        if path.len() < 2 {
            continue;
        }
        let c = team_color(pl.team.as_deref());
        let emph = s.selected.as_deref() == Some(&*pl.steamid);
        let mut prev: Option<(f32, f32)> = None;
        for (t, x, y) in path {
            let cur = view.to_canvas(x, y);
            if let Some(pv) = prev {
                if ((cur.0 - pv.0).powi(2) + (cur.1 - pv.1).powi(2)).sqrt() < 400.0 * view.scale() {
                    let k = ((t as f64 - from) / (s.tick - from).max(1.0)) as f32;
                    p.polyline(&[pv, cur], color(c, (if emph { 0.85 } else { 0.5 }) * k), if emph { 3.0 } else { 2.0 }, None);
                }
            }
            prev = Some(cur);
        }
    }
}

fn draw_shots(p: &mut Painter, s: &Scene, round: &RoundView, view: &RadarView) {
    let len = 650.0 * view.scale();
    for shot in round.shots_between(s.tick - SHOT_TICKS, s.tick) {
        let age = ((s.tick - shot.tick as f64) / SHOT_TICKS) as f32;
        let a = yaw_to_canvas(shot.yaw);
        let (x, y) = view.to_canvas(shot.x, shot.y);
        let (sx, sy) = (x + a.cos() * TOKEN_RADIUS, y + a.sin() * TOKEN_RADIUS);
        let reach = len * (0.35 + age * 1.3).min(1.0);
        // The fading tracer, as a few segments of falling opacity.
        const N: usize = 6;
        for i in 0..N {
            let (f0, f1) = (i as f32 / N as f32, (i + 1) as f32 / N as f32);
            let alpha = 0.9 * (1.0 - age) * (1.0 - f0);
            p.polyline(
                &[(sx + a.cos() * reach * f0, sy + a.sin() * reach * f0), (sx + a.cos() * reach * f1, sy + a.sin() * reach * f1)],
                color(0xfff4d6, alpha),
                1.5,
                None,
            );
        }
    }
}

fn draw_events(p: &mut Painter, s: &Scene, view: &RadarView) {
    let pulse = ((s.tick.rem_euclid(32.0)) / 32.0) as f32;
    for e in &s.events {
        let (x, y) = view.to_canvas(e.x, e.y);
        p.circle(x, y, TOKEN_RADIUS + 6.0 + pulse * 10.0, None, Some((color(e.color, e.alpha), 2.0)));
        let ty = y - (TOKEN_RADIUS + 22.0);
        let w = 22.0;
        p.rect(x - w / 2.0, ty - 7.0, w, 14.0, color(e.color, e.alpha));
        p.text(e.label, x, ty - 6.5, 10.0, FontWeight::BOLD, color(0x16181b, e.alpha), None);
    }
}

fn draw_players(p: &mut Painter, s: &Scene, view: &RadarView) {
    let r = TOKEN_RADIUS;
    // The dead first, as faint crosses.
    for pl in s.players.iter().filter(|pl| !pl.alive && pl.team.is_some()) {
        let (x, y) = view.to_canvas(pl.x, pl.y);
        let a = if s.on_level(pl.z) { 0.75 } else { OFF_LEVEL_ALPHA * 0.75 };
        let k = 4.5;
        for (c, wdt) in [(color(0x111316, a), 4.5), (color(team_color(pl.team.as_deref()), a), 2.2)] {
            p.polyline(&[(x - k, y - k), (x + k, y + k)], c, wdt, None);
            p.polyline(&[(x + k, y - k), (x - k, y + k)], c, wdt, None);
        }
    }

    let rank = |pl: &PlayerFrame| {
        if s.selected.as_deref() == Some(&*pl.steamid) {
            3
        } else if s.hovered.as_deref() == Some(&*pl.steamid) {
            2
        } else if s.on_level(pl.z) {
            1
        } else {
            0
        }
    };
    let mut alive: Vec<&PlayerFrame> = s.players.iter().filter(|pl| pl.alive && pl.team.is_some()).collect();
    alive.sort_by_key(|pl| rank(pl));
    for pl in alive {
        let (x, y) = view.to_canvas(pl.x, pl.y);
        let c = team_color(pl.team.as_deref());
        let here = s.on_level(pl.z);
        let sel = s.selected.as_deref() == Some(&*pl.steamid);
        let hov = s.hovered.as_deref() == Some(&*pl.steamid);
        let a = if here || sel { 1.0 } else { OFF_LEVEL_ALPHA };

        // Teardrop body pointing where they look.
        let body: Vec<(f32, f32)> = match pl.yaw.map(yaw_to_canvas) {
            Some(ang) => {
                let tip = r * 1.75;
                let spread = 0.62;
                let mut pts = vec![(x + ang.cos() * tip, y + ang.sin() * tip)];
                pts.extend(arc_points(x, y, r, ang + spread, ang - spread + std::f32::consts::TAU));
                pts
            }
            None => arc_points(x, y, r, 0.0, std::f32::consts::TAU),
        };
        p.polygon(&body, Some(color(c, a)), Some((color(0x111316, a), 2.0)));

        // Health ring inside the body.
        let hp = pl.health.unwrap_or(100).clamp(0, 100) as f32;
        p.circle(x, y, r * 0.58, None, Some((color(0x111316, 0.55 * a), 2.2)));
        if hp > 0.0 {
            let start = -std::f32::consts::FRAC_PI_2;
            let hc = if hp <= 30.0 { 0xff4d5e } else { 0x16181b };
            p.arc(x, y, r * 0.58, start, start + std::f32::consts::TAU * hp / 100.0, color(hc, a), 2.2);
        }
        // What's in hand: utility shows its colour in the middle, a knife a white dot.
        let weapon = pl.weapon.as_deref();
        if is_utility(weapon) {
            p.circle(x, y, r * 0.3, Some(color(grenade_color(grenade_kind(weapon.unwrap_or(""))), a)), None);
        } else if is_knife(weapon) {
            p.circle(x, y, r * 0.18, Some(color(0xffffff, a)), None);
        }
        if sel || hov {
            let ring = arc_points(x, y, r + 5.0, 0.0, std::f32::consts::TAU);
            if sel {
                p.polyline(&ring, color(0xffffff, 1.0), 1.5, None);
            } else {
                p.polyline(&ring, color(0xffffff, 0.6), 1.5, Some(&[3.0, 3.0]));
            }
        }
        if (s.layers.names && here) || sel || hov {
            p.text(
                &pl.name,
                x,
                y + r + 4.0,
                11.0,
                if sel { FontWeight::BOLD } else { FontWeight::SEMIBOLD },
                color(if sel { 0xffffff } else { 0xdfe2e7 }, a),
                Some(color(0x0e0f11, 0.9 * a)),
            );
        }
    }
}

/// The living player under a canvas point, if any.
pub fn hit_player(players: &[PlayerFrame], view: &RadarView, x: f32, y: f32, reach: f32) -> Option<Arc<str>> {
    let mut best = None;
    let mut best_d = reach;
    for pl in players.iter().filter(|pl| pl.alive && pl.team.is_some()) {
        let (px_, py_) = view.to_canvas(pl.x, pl.y);
        let d = ((px_ - x).powi(2) + (py_ - y).powi(2)).sqrt();
        if d <= best_d {
            best_d = d;
            best = Some(pl.steamid.clone());
        }
    }
    best
}
