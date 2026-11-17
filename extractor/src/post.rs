//! Detectors that run over the sampled positions after parsing (AFK and
//! head-stacking) and the per-player grief score.
//!
//! The Go parser ran these as SQL queries against the freshly written
//! database; here they work on the in-memory rows, which is where most of the
//! post-parse time used to go.

use crate::model::*;
use crate::util::J;
use std::collections::{BTreeMap, HashMap};

const TICK_RATE: f64 = 64.0;

/// Positions as the database stores them: one row per (round, tick, player),
/// the last write winning, ordered by that key.
pub fn dedup_positions(positions: &mut Vec<Position>) {
    positions.sort_by(|a, b| (a.round, a.tick, a.steamid).cmp(&(b.round, b.tick, b.steamid)));
    let mut out: Vec<Position> = Vec::with_capacity(positions.len());
    for p in positions.drain(..) {
        match out.last_mut() {
            Some(l) if (l.round, l.tick, l.steamid) == (p.round, p.tick, p.steamid) => *l = p,
            _ => out.push(p),
        }
    }
    *positions = out;
}

fn round_slices<'a>(positions: &'a [Position]) -> HashMap<i32, &'a [Position]> {
    let mut out = HashMap::new();
    let mut start = 0;
    while start < positions.len() {
        let r = positions[start].round;
        let mut end = start;
        while end < positions.len() && positions[end].round == r {
            end += 1;
        }
        out.insert(r, &positions[start..end]);
        start = end;
    }
    out
}

struct AfkState {
    last: [f64; 3],
    moved_during_grace: bool,
    afk_start: Option<i32>,
    first_move: Option<i32>,
    complete: bool,
}

fn afk_event(round: i32, steamid: u64, start: i32, end: i32, ended_by: &str, first_move: Option<i32>) -> Event {
    let seconds = (end - start) as f64 / TICK_RATE;
    let mut meta = J::obj();
    meta.insert("seconds".into(), J::F(seconds));
    meta.insert("afkDuration".into(), J::F(seconds));
    meta.insert("start_tick".into(), J::Int(start as i64));
    meta.insert("end_tick".into(), J::Int(end as i64));
    meta.insert("state".into(), J::S("AFK".into()));
    meta.insert("endedBy".into(), J::S(ended_by.into()));
    meta.insert("diedWhileAFK".into(), J::Bool(false));
    if let Some(m) = first_move {
        meta.insert("timeToFirstMovement".into(), J::F((m - start) as f64 / TICK_RATE));
    }
    Event {
        typ: "AFK_STILLNESS",
        round,
        start,
        end: Some(end),
        actor: Some(steamid.to_string()),
        victim: None,
        severity: 1.0,
        confidence: 1.0,
        meta: Some(J::O(meta).encode()),
    }
}

/// AFK detection: a player who does not move for the first five seconds after
/// freeze time is AFK until they move, get kicked, or the round ends.
pub fn detect_afk(data: &MatchData) -> Vec<Event> {
    let mut out = Vec::new();
    let by_round = round_slices(&data.positions);

    let mut intervals: HashMap<u64, Vec<(i32, i32)>> = HashMap::new();
    let mut dcs: Vec<&Event> = data.events.iter().filter(|e| e.typ == "DISCONNECT").collect();
    dcs.sort_by_key(|e| e.start);
    for e in dcs {
        if let Some(sid) = e.actor.as_ref().and_then(|a| a.parse::<u64>().ok()) {
            intervals.entry(sid).or_default().push((e.start, e.end.unwrap_or(i32::MAX)));
        }
    }

    let grace_ticks = (5.0 * TICK_RATE).ceil() as i32;
    for round in &data.rounds {
        let Some(freeze_end) = round.freeze_end else { continue };
        let round_end = round.end;
        let grace_end = freeze_end + grace_ticks;

        // Earliest tick in this round at which a player was the victim of any event.
        let mut death: HashMap<u64, i32> = HashMap::new();
        for e in data.events.iter().filter(|e| e.round == round.index) {
            if let Some(sid) = e.victim.as_ref().and_then(|v| v.parse::<u64>().ok()) {
                let t = death.entry(sid).or_insert(e.start);
                if e.start < *t {
                    *t = e.start;
                }
            }
        }
        let gone = |sid: u64, tick: i32| -> bool {
            if death.get(&sid).map_or(false, |d| tick >= *d) {
                return true;
            }
            intervals
                .get(&sid)
                .map_or(false, |iv| iv.iter().any(|(s, e)| tick >= *s && tick <= *e))
        };

        let rows = by_round.get(&round.index).copied().unwrap_or(&[]);
        let mut states: BTreeMap<u64, AfkState> = BTreeMap::new();
        let new_state = |p: &Position| AfkState {
            last: [p.x, p.y, p.z],
            moved_during_grace: false,
            afk_start: None,
            first_move: None,
            complete: false,
        };
        for p in rows.iter().filter(|p| p.tick >= freeze_end) {
            if !states.contains_key(&p.steamid) && !gone(p.steamid, freeze_end) {
                states.insert(p.steamid, new_state(p));
            }
        }
        // Players already gone at freeze end never get a state and are skipped.
        for p in rows.iter().filter(|p| p.tick >= freeze_end && p.tick <= round_end) {
            if gone(p.steamid, p.tick) {
                continue;
            }
            let Some(s) = states.get_mut(&p.steamid) else { continue };
            let cur = [p.x, p.y, p.z];
            let (dx, dy, dz) = (cur[0] - s.last[0], cur[1] - s.last[1], cur[2] - s.last[2]);
            let dist = (dx * dx + dy * dy + dz * dz).sqrt();
            if dist > 3.0 {
                if s.first_move.is_none() {
                    s.first_move = Some(p.tick);
                }
                if p.tick < grace_end {
                    s.moved_during_grace = true;
                    s.afk_start = None;
                } else if let Some(start) = s.afk_start.take() {
                    out.push(afk_event(round.index, p.steamid, start, p.tick, "MOVED", s.first_move));
                }
                s.complete = true;
            } else if !s.moved_during_grace && p.tick <= grace_end && s.afk_start.is_none() {
                s.afk_start = Some(freeze_end);
            }
            s.last = cur;
        }

        for (sid, s) in states.iter() {
            if s.complete || s.moved_during_grace {
                continue;
            }
            let Some(start) = s.afk_start else { continue };
            let kicked = intervals.get(sid).and_then(|iv| {
                iv.iter().map(|(s, _)| *s).filter(|t| *t >= start && *t <= round_end).min()
            });
            match kicked {
                Some(t) => out.push(afk_event(round.index, *sid, start, t, "KICKED", s.first_move)),
                None => out.push(afk_event(round.index, *sid, start, round_end, "ROUND_END", s.first_move)),
            }
        }
    }
    out
}

struct Stack {
    start: i32,
    last: i32,
    ticks: i64,
    sum_xy: f64,
    sum_z: f64,
    min_xy: f64,
}

fn body_block_event(round: i32, key: (u64, u64), s: &Stack) -> Option<Event> {
    if s.ticks <= 0 {
        return None;
    }
    let seconds = s.ticks as f64 / TICK_RATE;
    if seconds < 0.5 {
        return None;
    }
    let mut meta = J::obj();
    meta.insert("seconds".into(), J::F(seconds));
    meta.insert("stacked_ticks".into(), J::Int(s.ticks));
    meta.insert("min_xy_distance".into(), J::F(s.min_xy));
    meta.insert("avg_xy_distance".into(), J::F(s.sum_xy / s.ticks as f64));
    meta.insert("avg_z_delta".into(), J::F(s.sum_z / s.ticks as f64));
    Some(Event {
        typ: "BODY_BLOCK",
        round,
        start: s.start,
        end: Some(s.last),
        actor: Some(key.0.to_string()),
        victim: Some(key.1.to_string()),
        severity: (seconds / 5.0).min(1.0),
        confidence: (0.5 + seconds / 5.0).min(1.0),
        meta: Some(J::O(meta).encode()),
    })
}

/// Head-stacking detection: a player standing on top of a teammate.
pub fn detect_body_block(data: &MatchData) -> Vec<Event> {
    const MAX_XY_SQ: f64 = 24.0 * 24.0;
    let mut out = Vec::new();
    let by_round = round_slices(&data.positions);

    for round in &data.rounds {
        let rows = by_round.get(&round.index).copied().unwrap_or(&[]);
        let rows: Vec<&Position> =
            rows.iter().filter(|p| p.tick >= round.start && p.tick <= round.end).collect();
        let mut active: BTreeMap<(u64, u64), Stack> = BTreeMap::new();
        let mut i = 0;
        while i < rows.len() {
            let tick = rows[i].tick;
            let mut j = i;
            while j < rows.len() && rows[j].tick == tick {
                j += 1;
            }
            let group = &rows[i..j];
            i = j;
            if group.len() < 2 {
                continue;
            }
            let mut present: BTreeMap<(u64, u64), (f64, f64)> = BTreeMap::new();
            for a in 0..group.len() {
                for b in a + 1..group.len() {
                    let (p1, p2) = (group[a], group[b]);
                    if p1.steamid == p2.steamid || p1.team != p2.team {
                        continue;
                    }
                    let (dx, dy) = (p1.x - p2.x, p1.y - p2.y);
                    let dist_sq = dx * dx + dy * dy;
                    if dist_sq > MAX_XY_SQ {
                        continue;
                    }
                    let z = p1.z - p2.z;
                    if z.abs() < 40.0 || z.abs() > 90.0 {
                        continue;
                    }
                    let (top, bottom) = if z > 0.0 { (p1, p2) } else { (p2, p1) };
                    if bottom.health.map_or(false, |h| h <= 0) {
                        continue;
                    }
                    present.insert((top.steamid, bottom.steamid), (dist_sq.sqrt(), z.abs()));
                }
            }
            let keys: Vec<(u64, u64)> = active.keys().copied().collect();
            for k in keys {
                match present.remove(&k) {
                    Some((xy, z)) => {
                        let s = active.get_mut(&k).unwrap();
                        s.last = tick;
                        s.ticks += 1;
                        s.sum_xy += xy;
                        s.sum_z += z;
                        if xy < s.min_xy {
                            s.min_xy = xy;
                        }
                    }
                    None => {
                        let s = active.remove(&k).unwrap();
                        out.extend(body_block_event(round.index, k, &s));
                    }
                }
            }
            for (k, (xy, z)) in present {
                active.insert(
                    k,
                    Stack { start: tick, last: tick, ticks: 1, sum_xy: xy, sum_z: z, min_xy: xy },
                );
            }
        }
        for (k, s) in active {
            out.extend(body_block_event(round.index, k, &s));
        }
    }
    out
}

#[derive(Default, Clone, Debug)]
pub struct Score {
    pub steamid: String,
    pub team_kills: i64,
    pub team_damage: f64,
    pub team_flash_seconds: f64,
    pub afk_seconds: f64,
    pub body_block_seconds: f64,
    pub economy_grief_count: i64,
    pub grief_score: f64,
}

fn meta_number(meta: &Option<String>, key: &str) -> Option<f64> {
    let v: serde_json::Value = serde_json::from_str(meta.as_deref()?).ok()?;
    v.get(key)?.as_f64()
}

pub fn compute_scores(events: &[Event]) -> Vec<Score> {
    let mut scores: BTreeMap<String, Score> = BTreeMap::new();
    for e in events {
        let Some(actor) = &e.actor else { continue };
        let s = scores
            .entry(actor.clone())
            .or_insert_with(|| Score { steamid: actor.clone(), ..Default::default() });
        match e.typ {
            "TEAM_KILL" => s.team_kills += 1,
            "TEAM_DAMAGE" => {
                if let Some(d) = meta_number(&e.meta, "total_damage") {
                    s.team_damage += d;
                }
            }
            // The Go scorer read "total_blind_seconds", which team flash events
            // never carry, so flashes have never counted towards the score.
            "TEAM_FLASH" => {
                if let Some(d) = meta_number(&e.meta, "total_blind_seconds") {
                    s.team_flash_seconds += d;
                }
            }
            "AFK_STILLNESS" => {
                if let Some(d) = meta_number(&e.meta, "seconds") {
                    s.afk_seconds += d;
                }
            }
            "BODY_BLOCK" => {
                if let Some(d) = meta_number(&e.meta, "seconds") {
                    s.body_block_seconds += d;
                }
            }
            "ECONOMY_GRIEF" => s.economy_grief_count += 1,
            _ => {}
        }
    }
    let mut out: Vec<Score> = scores.into_values().collect();
    for s in out.iter_mut() {
        let total = (s.team_kills as f64 / 5.0).tanh() * 100.0 * 0.25
            + (s.team_damage / 200.0).tanh() * 100.0 * 0.20
            + (s.team_flash_seconds / 30.0).tanh() * 100.0 * 0.15
            + (s.afk_seconds / 60.0).tanh() * 100.0 * 0.15
            + (s.body_block_seconds / 30.0).tanh() * 100.0 * 0.10
            + (s.economy_grief_count as f64 / 5.0).tanh() * 100.0 * 0.15;
        s.grief_score = total.clamp(0.0, 100.0);
    }
    out
}
