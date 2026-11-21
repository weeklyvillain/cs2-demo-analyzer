//! The replay model: radar calibration (Electron `radarMaps.ts`) and one round's
//! indexes, interpolation and derived utility (Electron `useMatchReplay.ts`).

use std::collections::HashMap;
use std::sync::Arc;

use cs2da_core::replay::{GrenadeEvent, InfernoSample, PositionSample, ReplayRound, RoundData, Shot};

pub const TICKRATE: f64 = 64.0;

// ---------- radar maps ----------

/// One floor of a map: the heights it covers and its radar image (resources/radars, no extension).
pub struct MapLevel {
    pub name: &'static str,
    pub min: f32,
    pub max: f32,
    pub image: &'static str,
}

/// A radar's calibration: the image's top-left corner in game units and units per image pixel.
pub struct RadarInfo {
    pub x: f32,
    pub y: f32,
    pub scale: f32,
    pub levels: Vec<MapLevel>,
}

/// The radar images are 1024 × 1024.
pub const RADAR_PX: f32 = 1024.0;

fn one(image: &'static str) -> Vec<MapLevel> {
    vec![MapLevel { name: "", min: f32::NEG_INFINITY, max: f32::INFINITY, image }]
}

/// Calibrations from cs-demo-manager's CS2 table, as in Electron. Nuke and Vertigo split into two floors.
pub fn radar_for(map: &str) -> Option<RadarInfo> {
    let lower = map.to_lowercase();
    let key = if lower.starts_with("de_") || lower.starts_with("cs_") || lower.starts_with("ar_") {
        lower
    } else {
        format!("de_{lower}")
    };
    let info = |x: f32, y: f32, scale: f32, levels: Vec<MapLevel>| Some(RadarInfo { x, y, scale, levels });
    match key.as_str() {
        "de_ancient" => info(-2953., 2164., 5., one("de_ancient")),
        "de_anubis" => info(-2796., 3328., 5.22, one("de_anubis")),
        "de_cache" => info(-2000., 3250., 5.5, one("de_cache")),
        "de_cache_b" => info(-2000., 3250., 5.5, one("de_cache_b")),
        "de_cbble_d" => info(-3800., 3050., 6.2, one("de_cbble_d")),
        "de_dust2" => info(-2476., 3239., 4.4, one("de_dust2")),
        "de_inferno" => info(-2087., 3870., 4.9, one("de_inferno")),
        "de_mirage" => info(-3230., 1713., 5., one("de_mirage")),
        "de_nuke" => info(
            -3453.,
            2887.,
            7.,
            vec![
                MapLevel { name: "Upper", min: -495., max: f32::INFINITY, image: "de_nuke" },
                MapLevel { name: "Lower", min: f32::NEG_INFINITY, max: -495., image: "de_nuke_lower" },
            ],
        ),
        "de_overpass" => info(-4831., 1781., 5.2, one("de_overpass")),
        "de_train" => info(-2308., 2078., 4.082077, one("de_train")),
        "de_vertigo" => info(
            -3168.,
            1762.,
            4.,
            vec![
                MapLevel { name: "Upper", min: 11700., max: f32::INFINITY, image: "de_vertigo" },
                MapLevel { name: "Lower", min: f32::NEG_INFINITY, max: 11700., image: "de_vertigo_lower" },
            ],
        ),
        _ => None,
    }
}

/// The level a height is on (the nearest one when it's between them).
pub fn level_index_at(levels: &[MapLevel], z: f32) -> usize {
    if let Some(i) = levels.iter().position(|l| z >= l.min && z < l.max) {
        return i;
    }
    levels
        .iter()
        .enumerate()
        .map(|(i, l)| (i, if z < l.min { l.min - z } else { z - l.max }))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map_or(0, |(i, _)| i)
}

/// Whether the 2D tab is offered: Electron checks that a radar image exists for the map
/// (`de_cache_b` uses `de_cache`'s).
pub fn has_radar_image(map: &str) -> bool {
    let mut name = map.to_lowercase();
    if name.is_empty() {
        return false;
    }
    if name == "de_cache_b" {
        name = "de_cache".into();
    }
    let dir = cs2da_core::paths::resources_dir().join("radars");
    dir.join(format!("{name}.png")).exists()
        || dir.join(format!("{}.png", name.trim_start_matches("de_"))).exists()
}

/// "de_mirage" → "Mirage".
pub fn pretty_map_name(map: &str) -> String {
    let lower = map.to_lowercase();
    let base = lower
        .strip_prefix("de_")
        .or_else(|| lower.strip_prefix("cs_"))
        .or_else(|| lower.strip_prefix("ar_"))
        .unwrap_or(&lower)
        .replace('_', " ");
    base.split(' ')
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------- kinds and labels ----------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GrenadeKind {
    He,
    Smoke,
    Flash,
    Fire,
    Decoy,
    Other,
}

pub fn grenade_kind(name: &str) -> GrenadeKind {
    let n = name.to_lowercase();
    if n.contains("smoke") {
        GrenadeKind::Smoke
    } else if n.contains("flash") {
        GrenadeKind::Flash
    } else if n.contains("molotov") || n.contains("incendiary") || n.contains("inferno") {
        GrenadeKind::Fire
    } else if n.contains("decoy") {
        GrenadeKind::Decoy
    } else if n.contains("he") {
        GrenadeKind::He
    } else {
        GrenadeKind::Other
    }
}

pub fn grenade_color(kind: GrenadeKind) -> u32 {
    match kind {
        GrenadeKind::He => 0x5fd08a,
        GrenadeKind::Smoke => 0xc3c7ce,
        GrenadeKind::Flash => 0xfff3a8,
        GrenadeKind::Fire => 0xff7a3d,
        GrenadeKind::Decoy => 0xb48cff,
        GrenadeKind::Other => 0xffffff,
    }
}

pub const TEAM_T: u32 = 0xe8b04a;
pub const TEAM_CT: u32 = 0x5fa8ff;
pub const TEAM_NONE: u32 = 0x9aa0a8;

pub fn team_color(team: Option<&str>) -> u32 {
    match team {
        Some("T") => TEAM_T,
        Some("CT") => TEAM_CT,
        _ => TEAM_NONE,
    }
}

/// "weapon_ak47" → "AK47".
pub fn weapon_label(weapon: Option<&str>) -> String {
    match weapon {
        Some(w) if !w.is_empty() => w.trim_start_matches("weapon_").replace('_', " ").to_uppercase(),
        _ => "—".into(),
    }
}

pub fn is_utility(weapon: Option<&str>) -> bool {
    let w = weapon.unwrap_or("").to_lowercase();
    ["grenade", "flashbang", "molotov", "incendiary", "decoy", "smoke"].iter().any(|k| w.contains(k))
}

pub fn is_knife(weapon: Option<&str>) -> bool {
    let w = weapon.unwrap_or("").to_lowercase();
    w.contains("knife") || w.contains("bayonet")
}

// ---------- a player at a moment ----------

#[derive(Clone, Debug)]
pub struct PlayerFrame {
    pub steamid: Arc<str>,
    pub name: Arc<str>,
    pub team: Option<Arc<str>>,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: Option<f32>,
    pub health: Option<i32>,
    pub armor: Option<i32>,
    pub weapon: Option<Arc<str>>,
    pub alive: bool,
}

// ---------- derived utility ----------

pub struct GrenadeTrack {
    pub kind: GrenadeKind,
    /// (tick, x, y, z), by tick.
    pub path: Vec<(i64, f32, f32, f32)>,
    /// When it went off (i64::MAX when it never did in the data).
    pub detonate: i64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AreaKind {
    Smoke,
    Fire,
    Decoy,
}

pub struct AreaEffect {
    pub kind: AreaKind,
    pub start: i64,
    pub end: i64,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub team: Option<String>,
    pub entity_id: Option<i64>,
}

pub struct Blast {
    pub he: bool,
    pub tick: i64,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

const DEFAULT_SMOKE_SECONDS: i64 = 20;
const DEFAULT_DECOY_SECONDS: i64 = 15;
const DEFAULT_FIRE_SECONDS: i64 = 7;

/// One loaded round with its lookup structures, built off the UI thread.
pub struct RoundView {
    pub steamids: Vec<Arc<str>>,
    pub names: Vec<Arc<str>>,
    pub positions: Vec<PositionSample>,
    /// Distinct sample ticks, ascending, and where each tick's samples sit in `positions`.
    pub ticks: Vec<i64>,
    pub spans: Vec<(usize, usize)>,
    pub tracks: Vec<GrenadeTrack>,
    pub effects: Vec<AreaEffect>,
    pub blasts: Vec<Blast>,
    pub infernos: HashMap<i64, Vec<InfernoSample>>,
    /// Sorted by tick.
    pub shots: Vec<Shot>,
}

/// Largest index i with arr[i] <= v.
fn floor_index(arr: &[i64], v: i64) -> Option<usize> {
    match arr.binary_search(&v) {
        Ok(i) => Some(i),
        Err(0) => None,
        Err(i) => Some(i - 1),
    }
}

fn lerp_angle(a: f32, b: f32, t: f32) -> f32 {
    let d = ((b - a + 540.0).rem_euclid(360.0)) - 180.0;
    a + d * t
}

impl RoundView {
    pub fn build(data: RoundData) -> Self {
        let steamids: Vec<Arc<str>> = data.players.iter().map(|p| Arc::from(p.steamid.as_str())).collect();
        let names: Vec<Arc<str>> = data
            .players
            .iter()
            .map(|p| Arc::from(p.name.as_deref().filter(|n| !n.is_empty()).unwrap_or(&p.steamid)))
            .collect();

        let mut ticks = Vec::new();
        let mut spans = Vec::new();
        let mut i = 0;
        while i < data.positions.len() {
            let t = data.positions[i].tick;
            let start = i;
            while i < data.positions.len() && data.positions[i].tick == t {
                i += 1;
            }
            ticks.push(t);
            spans.push((start, i));
        }

        // Grenade flight paths, keyed by projectile.
        let mut by_id: HashMap<i64, Vec<&cs2da_core::replay::GrenadePosition>> = HashMap::new();
        for g in &data.grenade_positions {
            by_id.entry(g.projectile_id).or_default().push(g);
        }
        let mut ev_by_projectile: HashMap<i64, Vec<&GrenadeEvent>> = HashMap::new();
        let mut inferno_starts: Vec<&GrenadeEvent> = Vec::new();
        for e in &data.grenade_events {
            if e.event_type == "inferno_start" {
                inferno_starts.push(e);
            }
            ev_by_projectile.entry(e.projectile_id).or_default().push(e);
        }
        let mut tracks = Vec::new();
        for (id, mut path) in by_id {
            path.sort_by_key(|g| g.tick);
            let first = path[0];
            let kind = grenade_kind(&first.grenade_name);
            let mut detonate = i64::MAX;
            if kind == GrenadeKind::Fire {
                // Inferno events carry the fire's own id: match on thrower and time.
                for e in &inferno_starts {
                    if e.thrower_steamid.as_deref() == first.thrower_steamid.as_deref()
                        && e.tick >= first.tick
                        && e.tick < detonate
                    {
                        detonate = e.tick;
                    }
                }
            } else {
                let types: &[&str] = match kind {
                    GrenadeKind::Smoke => &["smoke_start", "smoke_end"],
                    GrenadeKind::He => &["he_explode"],
                    GrenadeKind::Flash => &["flash_explode"],
                    GrenadeKind::Decoy => &["decoy_start"],
                    _ => &[],
                };
                for e in ev_by_projectile.get(&id).into_iter().flatten() {
                    if types.contains(&e.event_type.as_str()) && e.tick < detonate {
                        detonate = e.tick;
                    }
                }
            }
            tracks.push(GrenadeTrack {
                kind,
                path: path.iter().map(|g| (g.tick, g.x, g.y, g.z)).collect(),
                detonate,
            });
        }

        // Lingering smokes, fires and decoys.
        let mut sorted: Vec<&GrenadeEvent> = data.grenade_events.iter().collect();
        sorted.sort_by_key(|e| e.tick);
        let mut used = vec![false; sorted.len()];
        let mut effects = Vec::new();
        let mut find_end = |start: &GrenadeEvent, ty: &str, matches: &dyn Fn(&GrenadeEvent) -> bool| -> Option<i64> {
            for (i, e) in sorted.iter().enumerate() {
                if !used[i] && e.event_type == ty && e.tick >= start.tick && matches(e) {
                    used[i] = true;
                    return Some(e.tick);
                }
            }
            None
        };
        for e in sorted.clone() {
            let (kind, end_type, seconds) = match e.event_type.as_str() {
                "smoke_start" => (AreaKind::Smoke, "smoke_expire", DEFAULT_SMOKE_SECONDS),
                "inferno_start" => (AreaKind::Fire, "inferno_expire", DEFAULT_FIRE_SECONDS),
                "decoy_start" => (AreaKind::Decoy, "decoy_expire", DEFAULT_DECOY_SECONDS),
                _ => continue,
            };
            let end = if kind == AreaKind::Fire {
                find_end(e, end_type, &|x| x.projectile_id == e.projectile_id)
            } else {
                find_end(e, end_type, &|x| x.projectile_id == e.projectile_id || x.thrower_steamid == e.thrower_steamid)
            };
            effects.push(AreaEffect {
                kind,
                start: e.tick,
                end: end.unwrap_or(e.tick + seconds * TICKRATE as i64),
                x: e.x,
                y: e.y,
                z: e.z,
                team: e.thrower_team.clone(),
                entity_id: (kind == AreaKind::Fire).then_some(e.projectile_id),
            });
        }

        let blasts = data
            .grenade_events
            .iter()
            .filter(|e| e.event_type == "he_explode" || e.event_type == "flash_explode")
            .map(|e| Blast { he: e.event_type == "he_explode", tick: e.tick, x: e.x, y: e.y, z: e.z })
            .collect();

        let mut infernos: HashMap<i64, Vec<InfernoSample>> = HashMap::new();
        for s in data.infernos {
            infernos.entry(s.entity_id).or_default().push(s);
        }
        for v in infernos.values_mut() {
            v.sort_by_key(|s| s.tick);
        }
        let mut shots = data.shots;
        shots.sort_by_key(|s| s.tick);

        Self {
            steamids,
            names,
            positions: data.positions,
            ticks,
            spans,
            tracks,
            effects,
            blasts,
            infernos,
            shots,
        }
    }

    fn sample(&self, tick_index: usize, player: u16) -> Option<&PositionSample> {
        let (a, b) = self.spans[tick_index];
        self.positions[a..b].iter().find(|p| p.player == player)
    }

    pub fn player_index(&self, steamid: &str) -> Option<u16> {
        self.steamids.iter().position(|s| &**s == steamid).map(|i| i as u16)
    }

    /// One player's interpolated position (Electron `positionAt`). `tick` is already resolved.
    pub fn position_at(&self, player: u16, tick: f64, snapped: bool) -> Option<PlayerFrame> {
        if self.ticks.is_empty() {
            return None;
        }
        let ti = tick.floor() as i64;
        let li = floor_index(&self.ticks, ti);
        let lower = li.and_then(|i| self.sample(i, player));
        let exact = li.is_some_and(|i| self.ticks[i] as f64 == tick);
        let ui = match li {
            Some(i) if exact => Some(i),
            Some(i) => (i + 1 < self.ticks.len()).then_some(i + 1),
            None => Some(0),
        };
        let upper = ui.and_then(|i| self.sample(i, player));
        let frame = |p: &PositionSample| self.frame(p);
        if exact {
            if let Some(l) = lower {
                return Some(frame(l));
            }
        }
        if snapped {
            return upper.or(lower).map(frame);
        }
        let (Some(l), Some(u)) = (lower, upper) else {
            return lower.or(upper).map(frame);
        };
        let span = (u.tick - l.tick) as f64;
        if span <= 0.0 {
            return Some(frame(l));
        }
        let t = ((tick - l.tick as f64) / span).clamp(0.0, 1.0) as f32;
        let near = if t < 0.5 { l } else { u };
        let mut f = frame(near);
        f.x = l.x + (u.x - l.x) * t;
        f.y = l.y + (u.y - l.y) * t;
        f.z = l.z + (u.z - l.z) * t;
        f.yaw = match (l.yaw, u.yaw) {
            (Some(a), Some(b)) => Some(lerp_angle(a, b, t)),
            _ => near.yaw,
        };
        f.team = l.team.clone().or_else(|| u.team.clone());
        Some(f)
    }

    fn frame(&self, p: &PositionSample) -> PlayerFrame {
        PlayerFrame {
            steamid: self.steamids[p.player as usize].clone(),
            name: self.names[p.player as usize].clone(),
            team: p.team.clone(),
            x: p.x,
            y: p.y,
            z: p.z,
            yaw: p.yaw,
            health: p.health,
            armor: p.armor,
            weapon: p.weapon.clone(),
            alive: true,
        }
    }

    /// A player's samples over [from, to] as (tick, x, y).
    pub fn path_between(&self, player: u16, from: f64, to: f64) -> Vec<(i64, f32, f32)> {
        let start = floor_index(&self.ticks, from.floor() as i64).unwrap_or(0);
        let mut out = Vec::new();
        for i in start..self.ticks.len() {
            if self.ticks[i] as f64 > to {
                break;
            }
            if let Some(p) = self.sample(i, player) {
                out.push((p.tick, p.x, p.y));
            }
        }
        out
    }

    /// Shots fired in (from, to].
    pub fn shots_between(&self, from: f64, to: f64) -> impl Iterator<Item = &Shot> {
        let start = self.shots.partition_point(|s| s.tick as f64 <= from);
        self.shots[start..].iter().take_while(move |s| s.tick as f64 <= to)
    }
}

// ---------- the match timeline ----------

/// The round a tick is in.
pub fn round_at(rounds: &[ReplayRound], tick: f64) -> Option<&ReplayRound> {
    rounds.iter().find(|r| tick >= r.start_tick as f64 && tick <= r.end_tick as f64)
}

/// The round a tick belongs to, or the last one that started before it.
pub fn round_near(rounds: &[ReplayRound], tick: f64) -> Option<&ReplayRound> {
    round_at(rounds, tick).or_else(|| rounds.iter().rev().find(|r| r.start_tick as f64 <= tick)).or(rounds.first())
}

fn live_tick(r: &ReplayRound) -> i64 {
    r.freeze_end_tick.filter(|f| *f > 0).unwrap_or(r.start_tick)
}

/// The tick to sample at: freeze time and gaps snap to spawn / end positions (full-game mode).
pub fn resolve_tick(rounds: &[ReplayRound], tick: f64) -> (f64, bool) {
    if let Some(r) = round_at(rounds, tick) {
        if tick < live_tick(r) as f64 {
            return (r.start_tick as f64, true);
        }
        if tick >= r.end_tick as f64 {
            return (r.end_tick as f64, true);
        }
        return (tick, false);
    }
    if let Some(next) = rounds.iter().find(|r| r.start_tick as f64 > tick) {
        return (next.start_tick as f64, true);
    }
    rounds.last().map_or((tick, true), |r| (r.end_tick as f64, true))
}

/// Dead unless health reads above 0, with a grace period around spawns (health reads 0 there).
pub fn is_alive_at(rounds: &[ReplayRound], health: Option<i32>, tick: f64) -> bool {
    if health.is_some_and(|h| h > 0) {
        return true;
    }
    if let Some(r) = round_at(rounds, tick) {
        return tick - (live_tick(r) as f64) < 320.0;
    }
    rounds
        .iter()
        .find(|r| tick < r.start_tick as f64)
        .is_some_and(|next| (live_tick(next) as f64) - tick < 320.0)
}

/// Score at the playhead: the previous round's tally while a round runs, this one's once it ends.
pub fn score_at(rounds: &[ReplayRound], tick: f64) -> (i64, i64) {
    match rounds.iter().position(|r| tick >= r.start_tick as f64 && tick <= r.end_tick as f64) {
        None => rounds
            .iter()
            .filter(|r| (r.end_tick as f64) < tick)
            .last()
            .map_or((0, 0), |r| (r.t_wins, r.ct_wins)),
        Some(i) => {
            let r = &rounds[i];
            if tick >= r.end_tick as f64 {
                (r.t_wins, r.ct_wins)
            } else {
                i.checked_sub(1).map_or((0, 0), |p| (rounds[p].t_wins, rounds[p].ct_wins))
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Freeze,
    Live,
    Over,
}

/// `m:ss`.
pub fn mmss(seconds: f64) -> String {
    let s = seconds.max(0.0).floor() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

pub fn phase_at(round: Option<&ReplayRound>, tick: f64) -> (Phase, String) {
    let Some(r) = round else { return (Phase::Over, "0:00".into()) };
    let live = match r.freeze_end_tick {
        Some(f) if f > r.start_tick => f,
        _ => r.start_tick,
    } as f64;
    if tick < live {
        (Phase::Freeze, mmss((live - tick) / TICKRATE))
    } else if tick >= r.end_tick as f64 {
        (Phase::Over, mmss((r.end_tick as f64 - live) / TICKRATE))
    } else {
        (Phase::Live, mmss((tick - live) / TICKRATE))
    }
}

#[cfg(test)]
mod tests {
    use super::{level_index_at, pretty_map_name, radar_for, resolve_tick, score_at, weapon_label};
    use cs2da_core::replay::ReplayRound;

    fn round(index: i64, start: i64, freeze: i64, end: i64, t: i64, ct: i64) -> ReplayRound {
        ReplayRound { index, start_tick: start, freeze_end_tick: Some(freeze), end_tick: end, t_wins: t, ct_wins: ct, winner: None }
    }

    #[test]
    fn maps_and_labels() {
        assert!(radar_for("mirage").is_some());
        assert!(radar_for("DE_DUST2").is_some());
        let nuke = radar_for("de_nuke").unwrap();
        assert_eq!(level_index_at(&nuke.levels, -600.0), 1);
        assert_eq!(level_index_at(&nuke.levels, 0.0), 0);
        assert_eq!(pretty_map_name("de_dust2"), "Dust2");
        assert_eq!(weapon_label(Some("weapon_m4a1_silencer")), "M4A1 SILENCER");
    }

    #[test]
    fn timeline_rules() {
        let rounds = vec![round(0, 100, 200, 1000, 1, 0), round(1, 1100, 1200, 2000, 1, 1)];
        assert_eq!(resolve_tick(&rounds, 150.0), (100.0, true));
        assert_eq!(resolve_tick(&rounds, 500.0), (500.0, false));
        assert_eq!(resolve_tick(&rounds, 1050.0), (1100.0, true));
        assert_eq!(score_at(&rounds, 500.0), (0, 0));
        assert_eq!(score_at(&rounds, 1000.0), (1, 0));
        assert_eq!(score_at(&rounds, 1500.0), (1, 0));
    }
}
