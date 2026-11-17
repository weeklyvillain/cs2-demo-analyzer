//! The extractor proper: turns game-state signals into the rows the app
//! stores (rounds, players, events, positions, grenades, shots, chat).
//! This is a port of the old Go `internal/parser` package and its extractors.

use crate::db::Msg;
use crate::equipment as eq;
use crate::equipment::Eq;
use crate::hull;
use crate::model::*;
use crate::state::*;
use crate::util::*;
use source2_demo::prelude::*;
use source2_demo::proto::{CDemoFileHeader, CMsgPlayerInfo, CSvcMsgServerInfo, CUserMessageSayText2};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::mpsc::SyncSender;

/// Rows are handed to the database writer in chunks of about this size.
const STREAM_CHUNK: usize = 4096;

pub struct Options {
    pub position_interval: i32,
    /// JSON mode only needs events: positions, grenades and shots are skipped.
    pub events_only: bool,
    pub steam_ids: Option<HashSet<String>>,
    /// Attribute shots the way the Go parser did (see `on_weapon_fire`).
    pub legacy_shots: bool,
}

pub type Progress = Box<dyn FnMut(&str, i32, i32, f64)>;
pub type Sink = SyncSender<Msg>;

const TICK_RATE: f64 = 64.0;
const PARSING_PCT: f64 = 0.85;

struct PendingDamage {
    round: i32,
    attacker: String,
    victim: String,
    start: i32,
    last: i32,
    health: i64,
    armor: i64,
    hits: i64,
    hitgroups: BTreeMap<String, i64>,
    weapons: Vec<&'static str>,
    utility: bool,
}

struct EconSnapshot {
    steamid: String,
    money: i64,
    spent: i64,
    start_money: i64,
    primary: &'static str,
    weapons: Vec<&'static str>,
}

pub struct Extractor {
    pub st: State,
    opts: Options,
    progress: Option<Progress>,
    sink: Option<Sink>,
    positions_sent: usize,
    grenade_position_count: usize,

    pub map_name: String,
    pub build_num: i32,
    stopped: bool,

    cur_round: Option<Round>,
    rounds: Vec<Round>,
    freeze_end: Option<i32>,
    round_number: i32,
    t_wins: i32,
    ct_wins: i32,

    player_map: HashMap<u64, PlayerData>,
    player_order: Vec<u64>,
    team_map: HashMap<u64, &'static str>,
    first_round_processed: bool,
    t_assign: &'static str,
    ct_assign: &'static str,
    first_connect_round: HashMap<u64, i32>,
    disconnected: HashMap<u64, bool>,
    disconnect_tick: HashMap<u64, i32>,
    disconnect_round: HashMap<u64, i32>,
    round_end_ticks: HashMap<i32, i32>,

    ev_team_kill: Vec<Event>,
    ev_kill: Vec<Event>,
    ev_team_damage: Vec<Event>,
    ev_team_flash: Vec<Event>,
    ev_disconnect: Vec<Event>,
    ev_economy: Vec<Event>,
    pending_damage: BTreeMap<String, PendingDamage>,
    pending_disconnects: HashMap<String, i32>,
    disconnect_reasons: BTreeMap<i32, J>,

    last_position_tick: i32,
    max_tick: i32,
    estimated_total: i64,
    last_pct: f64,

    chat: Vec<Chat>,
    positions: Vec<Position>,
    grenade_positions: Vec<GrenadePos>,
    grenade_events: Vec<GrenadeEvent>,
    infernos: Vec<InfernoPos>,
    shots: Vec<Shot>,
}

fn team_str(t: u8) -> &'static str {
    match t {
        TEAM_T => "T",
        TEAM_CT => "CT",
        _ => "",
    }
}

fn color_name(c: i64) -> &'static str {
    match c {
        0 => "yellow",
        1 => "purple",
        2 => "green",
        3 => "blue",
        4 => "orange",
        _ => "",
    }
}

fn is_rifle(w: &str) -> bool {
    matches!(w, "AK-47" | "M4A4" | "M4A1" | "AUG" | "SG 553" | "AWP" | "SSG 08")
}
fn is_smg(w: &str) -> bool {
    matches!(w, "MAC-10" | "MP9" | "MP7" | "UMP-45" | "P90" | "PP-Bizon" | "MP5-SD")
}
fn is_pistol(w: &str) -> bool {
    matches!(
        w,
        "Glock-18"
            | "USP-S"
            | "P2000"
            | "P250"
            | "Five-SeveN"
            | "Tec-9"
            | "CZ75-Auto"
            | "Desert Eagle"
            | "Dual Berettas"
            | "R8 Revolver"
    )
}
fn is_relevant_weapon(w: &str) -> bool {
    !matches!(w, "C4" | "Knife" | "Glock-18" | "USP-S" | "P2000" | "")
}

fn grenade_name(wep: Eq) -> Option<&'static str> {
    match wep {
        eq::HE => Some("hegrenade"),
        eq::SMOKE => Some("smokegrenade"),
        eq::FLASH => Some("flashbang"),
        eq::MOLOTOV | eq::INCENDIARY => Some("incendiary"),
        eq::DECOY => Some("decoy"),
        _ => None,
    }
}

impl Extractor {
    pub fn new(opts: Options, progress: Option<Progress>, sink: Option<Sink>) -> Self {
        Extractor {
            st: State::new(),
            opts,
            progress,
            sink,
            positions_sent: 0,
            grenade_position_count: 0,
            map_name: String::new(),
            build_num: 0,
            stopped: false,
            cur_round: None,
            rounds: Vec::new(),
            freeze_end: None,
            round_number: 0,
            t_wins: 0,
            ct_wins: 0,
            player_map: HashMap::new(),
            player_order: Vec::new(),
            team_map: HashMap::new(),
            first_round_processed: false,
            t_assign: "",
            ct_assign: "",
            first_connect_round: HashMap::new(),
            disconnected: HashMap::new(),
            disconnect_tick: HashMap::new(),
            disconnect_round: HashMap::new(),
            round_end_ticks: HashMap::new(),
            ev_team_kill: Vec::new(),
            ev_kill: Vec::new(),
            ev_team_damage: Vec::new(),
            ev_team_flash: Vec::new(),
            ev_disconnect: Vec::new(),
            ev_economy: Vec::new(),
            pending_damage: BTreeMap::new(),
            pending_disconnects: HashMap::new(),
            disconnect_reasons: BTreeMap::new(),
            last_position_tick: 0,
            max_tick: 0,
            estimated_total: 10_000_000,
            last_pct: 0.0,
            chat: Vec::new(),
            positions: Vec::new(),
            grenade_positions: Vec::new(),
            grenade_events: Vec::new(),
            infernos: Vec::new(),
            shots: Vec::new(),
        }
    }

    fn in_set(&self, steamid: &str) -> bool {
        self.opts.steam_ids.as_ref().map_or(true, |s| s.contains(steamid))
    }

    fn sid(&self, pid: usize) -> u64 {
        self.st.players[pid].steam_id
    }

    fn sid_str(&self, pid: usize) -> String {
        self.st.players[pid].steam_id.to_string()
    }

    fn thrower(&self, p: Option<usize>) -> Thrower {
        match p {
            Some(pid) => {
                let pl = &self.st.players[pid];
                Thrower {
                    steamid: Some(pl.steam_id.to_string()),
                    name: Some(pl.name.clone()),
                    team: Some(team_str(pl.team).to_string()),
                }
            }
            None => Thrower::default(),
        }
    }

    fn thrower_in_set(&self, t: &Thrower) -> bool {
        match &self.opts.steam_ids {
            None => true,
            Some(set) => t.steamid.as_ref().map_or(false, |s| set.contains(s)),
        }
    }

    fn color_of(&self, ctx: &Context, pid: usize) -> Option<&'static str> {
        let ctl = self.st.controller(ctx, pid)?;
        Some(color_name(p_i64(ctl, "m_iCompTeammateColor").unwrap_or(-1)))
    }

    fn player_name(&self, pid: usize) -> String {
        let p = &self.st.players[pid];
        if p.name.is_empty() {
            format!("Player_{}", p.steam_id)
        } else {
            p.name.clone()
        }
    }

    fn ensure_player(&mut self, sid: u64, name: String) -> bool {
        if self.player_map.contains_key(&sid) {
            return false;
        }
        self.player_map
            .insert(sid, PlayerData { steamid: sid.to_string(), name, ..Default::default() });
        self.player_order.push(sid);
        true
    }

    fn assign_for_side(&mut self, team: u8) -> &'static str {
        match team {
            TEAM_T => {
                if self.t_assign.is_empty() {
                    self.t_assign = "A";
                    self.ct_assign = "B";
                }
                self.t_assign
            }
            TEAM_CT => {
                if self.ct_assign.is_empty() {
                    self.ct_assign = "B";
                    self.t_assign = "A";
                }
                self.ct_assign
            }
            _ => "",
        }
    }

    fn report_progress(&mut self, tick: i32) {
        if tick > self.max_tick {
            self.max_tick = tick;
            let mult = if self.max_tick > 100_000 {
                2.0
            } else if self.max_tick > 50_000 {
                2.5
            } else if self.max_tick > 10_000 {
                5.0
            } else {
                10.0
            };
            let est = (self.max_tick as f64 * mult) as i64;
            if est < self.estimated_total {
                self.estimated_total = est;
            }
        }
        let mut pct = 0.0;
        if self.estimated_total > 0 && self.max_tick > 0 {
            pct = (tick as f64 / self.estimated_total as f64 * PARSING_PCT).min(PARSING_PCT);
            if pct < self.last_pct {
                pct = self.last_pct;
            }
            self.last_pct = pct;
        }
        let round = self.round_number;
        if let Some(cb) = self.progress.as_mut() {
            cb("parsing", tick, round, pct);
        }
    }

    // -- rounds ------------------------------------------------------------

    fn finalize_damage_round(&mut self, round: i32) {
        let keys: Vec<String> = self
            .pending_damage
            .iter()
            .filter(|(_, p)| p.round == round)
            .map(|(k, _)| k.clone())
            .collect();
        for k in keys {
            if let Some(p) = self.pending_damage.remove(&k) {
                self.finalize_damage(p);
            }
        }
    }

    fn on_round_start(&mut self, ctx: &Context) {
        let tick = self.st.tick;
        if let Some(mut r) = self.cur_round.take() {
            r.end = tick;
            let idx = r.index;
            self.rounds.push(r);
            self.finalize_damage_round(idx);
        }
        self.round_number += 1;
        self.freeze_end = None;
        self.cur_round = Some(Round {
            index: self.round_number - 1,
            start: tick,
            freeze_end: None,
            end: 0,
            t_wins: self.t_wins,
            ct_wins: self.ct_wins,
            winner: None,
        });

        if !self.first_round_processed && self.round_number == 1 {
            self.first_round_processed = true;
            for pid in self.st.all() {
                let team = self.st.players[pid].team;
                if team == TEAM_SPECTATORS || team == TEAM_UNASSIGNED {
                    continue;
                }
                let assigned = self.assign_for_side(team);
                if assigned.is_empty() {
                    continue;
                }
                let sid = self.sid(pid);
                self.team_map.insert(sid, assigned);
                let name = self.player_name(pid);
                self.ensure_player(sid, name);
                let color = self.color_of(ctx, pid);
                let pd = self.player_map.get_mut(&sid).unwrap();
                pd.team = assigned.to_string();
                if let Some(c) = color {
                    if !c.is_empty() && pd.color != c {
                        pd.color = c.to_string();
                    }
                }
            }
        }
        self.report_progress(tick);
    }

    fn is_disconnected_at(&self, sid: u64, round: i32, tick: i32) -> bool {
        if !self.disconnected.get(&sid).copied().unwrap_or(false) {
            return false;
        }
        let dc_tick = self.disconnect_tick.get(&sid).copied().unwrap_or(0);
        let dc_round = self.disconnect_round.get(&sid).copied().unwrap_or(0);
        (dc_round == round && dc_tick <= tick) || dc_round < round
    }

    fn on_freeze_end(&mut self, ctx: &Context) {
        let tick = self.st.tick;
        self.freeze_end = Some(tick);
        let Some(round) = self.cur_round.as_mut() else { return };
        round.freeze_end = Some(tick);
        let round_index = round.index;

        let players: Vec<usize> = self
            .st
            .all()
            .into_iter()
            .filter(|&pid| !self.is_disconnected_at(self.sid(pid), round_index, tick))
            .collect();
        self.economy_freeze_end(ctx, round_index, tick, &players);
    }

    fn on_round_end(&mut self, winner: u8) {
        if self.cur_round.is_none() {
            return;
        }
        let tick = self.st.tick;
        let w = match winner {
            TEAM_T => {
                self.t_wins += 1;
                Some("T")
            }
            TEAM_CT => {
                self.ct_wins += 1;
                Some("CT")
            }
            _ => None,
        };
        let (t, ct) = (self.t_wins, self.ct_wins);
        let r = self.cur_round.as_mut().unwrap();
        r.end = tick;
        r.winner = w;
        r.t_wins = t;
        r.ct_wins = ct;
        let idx = r.index;
        self.round_end_ticks.insert(idx, tick);
        self.report_progress(tick);
    }

    // -- players -----------------------------------------------------------

    fn on_player_connect(&mut self, ctx: &Context, pid: usize, team: u8) {
        let round_index = self.cur_round.as_ref().map_or(-1, |r| r.index);
        let tick = self.st.tick;
        let sid = self.sid(pid);
        let steam = sid.to_string();
        if !self.in_set(&steam) {
            return;
        }
        self.disconnect_reconnected(&steam, round_index, tick);

        let name = self.player_name(pid);
        if self.ensure_player(sid, name) {
            self.first_connect_round.insert(sid, round_index);
        }
        self.disconnected.insert(sid, false);

        if let Some(&assigned) = self.team_map.get(&sid) {
            self.player_map.get_mut(&sid).unwrap().team = assigned.to_string();
        } else if self.first_round_processed && round_index >= 0 {
            // Use the assignment of a teammate; the Go code then always fell
            // through to the side-based assignment as well.
            for other in self.st.all() {
                let o = &self.st.players[other];
                if o.steam_id == sid || o.team != team {
                    continue;
                }
                if let Some(&a) = self.team_map.get(&o.steam_id) {
                    self.team_map.insert(sid, a);
                    let pd = self.player_map.get_mut(&sid).unwrap();
                    pd.team = a.to_string();
                    if round_index > 0 {
                        pd.connected_midgame = true;
                    }
                    break;
                }
            }
            let assigned = self.assign_for_side(team);
            if !assigned.is_empty() {
                self.team_map.insert(sid, assigned);
                let pd = self.player_map.get_mut(&sid).unwrap();
                pd.team = assigned.to_string();
                if round_index > 0 {
                    pd.connected_midgame = true;
                }
            }
        } else if !self.first_round_processed {
            let assigned = self.assign_for_side(team);
            if !assigned.is_empty() {
                self.team_map.insert(sid, assigned);
                self.player_map.get_mut(&sid).unwrap().team = assigned.to_string();
            }
        }

        if self.player_map[&sid].color.is_empty() {
            if let Some(c) = self.color_of(ctx, pid) {
                if !c.is_empty() {
                    self.player_map.get_mut(&sid).unwrap().color = c.to_string();
                }
            }
        }
    }

    fn on_player_disconnected(&mut self, pid: usize) {
        let round_index = self.cur_round.as_ref().map_or(-1, |r| r.index);
        let sid = self.sid(pid);
        if sid == 0 || round_index < 0 {
            return;
        }
        let steam = sid.to_string();
        if !self.in_set(&steam) {
            return;
        }
        let tick = self.st.tick;

        // Reason comes from a player_disconnect game event stored within 10 ticks.
        let key = self
            .disconnect_reasons
            .range(tick - 10..=tick + 10)
            .next()
            .map(|(k, _)| *k);
        let reason = key.and_then(|k| self.disconnect_reasons.remove(&k)).unwrap_or(J::Null);
        let mut meta = J::obj();
        meta.insert("reason".into(), reason);
        meta.insert("disconnect_time".into(), J::F(tick as f64 / TICK_RATE));
        self.pending_disconnects.insert(steam.clone(), tick);
        self.ev_disconnect.push(Event {
            typ: "DISCONNECT",
            round: round_index,
            start: tick,
            end: None,
            actor: Some(steam),
            victim: None,
            severity: 0.4,
            confidence: 0.9,
            meta: Some(J::O(meta).encode()),
        });

        self.disconnected.insert(sid, true);
        self.disconnect_tick.insert(sid, tick);
        self.disconnect_round.insert(sid, round_index);
        self.first_connect_round.remove(&sid);
    }

    fn disconnect_reconnected(&mut self, steam: &str, round_index: i32, tick: i32) {
        let Some(&dc_tick) = self.pending_disconnects.get(steam) else { return };
        for ev in self.ev_disconnect.iter_mut() {
            if ev.actor.as_deref() == Some(steam) && ev.end.is_none() {
                ev.end = Some(tick);
                let mut meta = ev.meta.as_deref().map(parse_flat_object).unwrap_or_default();
                meta.insert("reconnected".into(), J::Bool(true));
                meta.insert("reconnect_time".into(), J::F(tick as f64 / TICK_RATE));
                meta.insert("reconnect_round".into(), J::Int(round_index as i64));
                meta.insert(
                    "disconnect_duration".into(),
                    J::F((tick - dc_tick) as f64 / TICK_RATE),
                );
                ev.meta = Some(J::O(meta).encode());
                self.pending_disconnects.remove(steam);
                break;
            }
        }
    }

    fn on_name_change(&mut self, pid: usize) {
        let sid = self.sid(pid);
        let name = self.st.players[pid].name.clone();
        if let Some(pd) = self.player_map.get_mut(&sid) {
            if !name.is_empty() {
                pd.name = name;
            }
        } else {
            let name = self.player_name(pid);
            self.ensure_player(sid, name);
        }
    }

    // -- kills / damage / flashes -----------------------------------------

    fn pair_in_set(&self, a: Option<usize>, b: Option<usize>) -> bool {
        if self.opts.steam_ids.is_none() {
            return true;
        }
        let hit = |p: Option<usize>| p.map_or(false, |pid| self.in_set(&self.sid_str(pid)));
        hit(a) || hit(b)
    }

    fn kill_meta(
        &self,
        ctx: &Context,
        killer: usize,
        victim: usize,
        weapon: Option<Eq>,
        headshot: bool,
    ) -> String {
        let mut meta = J::obj();
        if let Some(w) = weapon {
            meta.insert("weapon".into(), J::S(eq::name(w).to_string()));
        }
        if headshot {
            meta.insert("headshot".into(), J::Bool(true));
        }
        let a = self.st.position(ctx, killer);
        let v = self.st.position(ctx, victim);
        let nz = |p: &[f64; 3]| p[0] != 0.0 || p[1] != 0.0 || p[2] != 0.0;
        if nz(&a) && nz(&v) {
            let (dx, dy, dz) = (a[0] - v[0], a[1] - v[1], a[2] - v[2]);
            meta.insert("distance".into(), J::F((dx * dx + dy * dy + dz * dz).sqrt()));
        }
        J::O(meta).encode()
    }

    fn on_kill(
        &mut self,
        ctx: &Context,
        killer: Option<usize>,
        victim: Option<usize>,
        weapon: Option<Eq>,
        headshot: bool,
    ) {
        let Some(round) = self.cur_round.as_ref().map(|r| r.index) else { return };
        if !self.pair_in_set(killer, victim) {
            return;
        }
        let tick = self.st.tick;
        let Some(killer) = killer else { return };
        let kteam = self.st.players[killer].team;
        let ksid = self.sid(killer);
        let teams: Vec<u8> = self.st.players.iter().map(|p| p.team).collect();
        let sids: Vec<u64> = self.st.players.iter().map(|p| p.steam_id).collect();
        let same_team = |v: usize| kteam == teams[v];
        let same_player = |v: usize| ksid == sids[v];

        // Team kill extractor (also records suicides).
        'tk: {
            if let Some(&end) = self.round_end_ticks.get(&round) {
                let before = end - tick;
                if before >= 0 && (before as f64 / TICK_RATE) < 10.0 {
                    break 'tk;
                }
            }
            let Some(v) = victim else { break 'tk };
            if self.is_disconnected_at(self.sid(v), round, tick) {
                break 'tk;
            }
            if !same_player(v) && !same_team(v) {
                break 'tk;
            }
            let meta = self.kill_meta(ctx, killer, v, weapon, headshot);
            self.ev_team_kill.push(Event {
                typ: "TEAM_KILL",
                round,
                start: tick,
                end: None,
                actor: Some(self.sid_str(killer)),
                victim: Some(self.sid_str(v)),
                severity: 0.8,
                confidence: 1.0,
                meta: Some(meta),
            });
        }

        // Regular kill extractor.
        let Some(v) = victim else { return };
        if same_player(v) || same_team(v) {
            return;
        }
        let meta = self.kill_meta(ctx, killer, v, weapon, headshot);
        self.ev_kill.push(Event {
            typ: "KILL",
            round,
            start: tick,
            end: None,
            actor: Some(self.sid_str(killer)),
            victim: Some(self.sid_str(v)),
            severity: 0.8,
            confidence: 1.0,
            meta: Some(meta),
        });
    }

    fn on_hurt(
        &mut self,
        victim: Option<usize>,
        attacker: Option<usize>,
        health_damage: i64,
        armor_damage: i64,
        hitgroup: i64,
        weapon: Option<Eq>,
    ) {
        let Some(round) = self.cur_round.as_ref().map(|r| r.index) else { return };
        if !self.pair_in_set(attacker, victim) {
            return;
        }
        let tick = self.st.tick;
        let (Some(a), Some(v)) = (attacker, victim) else { return };
        if self.sid(a) == self.sid(v) || self.st.players[a].team != self.st.players[v].team {
            return;
        }
        let attacker_id = self.sid_str(a);
        let victim_id = self.sid_str(v);
        let key = format!("{}_{}_{}", round, attacker_id, victim_id);
        let weapon_name = weapon.map(eq::name);
        let utility = matches!(
            weapon_name,
            Some("HE Grenade" | "Flashbang" | "Smoke Grenade" | "Molotov" | "Incendiary Grenade")
        );
        let window = (TICK_RATE * 2.0) as i32;

        if let Some(p) = self.pending_damage.get_mut(&key) {
            if tick - p.last <= window {
                p.last = tick;
                p.health += health_damage;
                p.armor += armor_damage;
                p.hits += 1;
                if hitgroup != 0 {
                    *p.hitgroups.entry(hitgroup.to_string()).or_default() += 1;
                }
                if let Some(w) = weapon_name {
                    if !p.weapons.contains(&w) {
                        p.weapons.push(w);
                    }
                }
                if utility {
                    p.utility = true;
                }
                return;
            }
        }
        if let Some(old) = self.pending_damage.remove(&key) {
            self.finalize_damage(old);
        }
        let mut hitgroups = BTreeMap::new();
        if hitgroup != 0 {
            hitgroups.insert(hitgroup.to_string(), 1);
        }
        self.pending_damage.insert(
            key,
            PendingDamage {
                round,
                attacker: attacker_id,
                victim: victim_id,
                start: tick,
                last: tick,
                health: health_damage,
                armor: armor_damage,
                hits: 1,
                hitgroups,
                weapons: weapon_name.into_iter().collect(),
                utility,
            },
        );
    }

    fn finalize_damage(&mut self, p: PendingDamage) {
        let total = (p.health + p.armor) as f64;
        let mut meta = J::obj();
        meta.insert("dmg_health".into(), J::Int(p.health));
        meta.insert("dmg_armor".into(), J::Int(p.armor));
        meta.insert("total_damage".into(), J::F(total));
        meta.insert("hit_count".into(), J::Int(p.hits));
        meta.insert("is_utility".into(), J::Bool(p.utility));
        if !p.hitgroups.is_empty() {
            meta.insert(
                "hitgroups".into(),
                J::O(p.hitgroups.iter().map(|(k, v)| (k.clone(), J::Int(*v))).collect()),
            );
        }
        if !p.weapons.is_empty() {
            meta.insert(
                "weapon".into(),
                J::A(p.weapons.iter().map(|w| J::S(w.to_string())).collect()),
            );
        }
        self.ev_team_damage.push(Event {
            typ: "TEAM_DAMAGE",
            round: p.round,
            start: p.start,
            end: Some(p.last),
            actor: Some(p.attacker),
            victim: Some(p.victim),
            severity: (total / 100.0).min(1.0),
            confidence: 1.0,
            meta: Some(J::O(meta).encode()),
        });
    }

    fn on_flashed(&mut self, player: usize, attacker: Option<usize>) {
        let Some(round) = self.cur_round.as_ref().map(|r| r.index) else { return };
        if !self.pair_in_set(attacker, Some(player)) {
            return;
        }
        let tick = self.st.tick;
        let Some(a) = attacker else { return };
        if self.st.players[a].team != self.st.players[player].team
            || self.sid(a) == self.sid(player)
        {
            return;
        }
        let mut duration = self.st.flash_duration_seconds(player);
        if duration <= 0.0 {
            duration = 3.0;
        }
        if duration < 1.0 {
            return;
        }
        let mut meta = J::obj();
        meta.insert("blind_duration".into(), J::F(duration));
        self.ev_team_flash.push(Event {
            typ: "TEAM_FLASH",
            round,
            start: tick,
            end: None,
            actor: Some(self.sid_str(a)),
            victim: Some(self.sid_str(player)),
            severity: (duration / 5.0).min(1.0),
            confidence: 1.0,
            meta: Some(J::O(meta).encode()),
        });
    }

    // -- economy -----------------------------------------------------------

    fn economy_freeze_end(&mut self, ctx: &Context, round: i32, tick: i32, players: &[usize]) {
        let mut teams: BTreeMap<u8, Vec<EconSnapshot>> = BTreeMap::new();
        for &pid in players {
            let team = self.st.players[pid].team;
            if team == TEAM_SPECTATORS || team == TEAM_UNASSIGNED {
                continue;
            }
            let mut primary = "";
            let mut weapons = Vec::new();
            for w in self.st.inventory(ctx, pid) {
                let n = eq::name(w);
                weapons.push(n);
                let c = eq::class(w);
                if c == eq::CLASS_RIFLE || c == eq::CLASS_SMG || c == eq::CLASS_HEAVY {
                    primary = n;
                }
            }
            let ctl = self.st.controller(ctx, pid);
            let money =
                ctl.and_then(|c| p_i64(c, "m_pInGameMoneyServices.m_iAccount")).unwrap_or(0);
            let spent = ctl
                .and_then(|c| p_i64(c, "m_pInGameMoneyServices.m_iCashSpentThisRound"))
                .unwrap_or(0);
            teams.entry(team).or_default().push(EconSnapshot {
                steamid: self.sid_str(pid),
                money,
                spent,
                start_money: money + spent,
                primary,
                weapons,
            });
        }
        for snaps in teams.values() {
            self.detect_economy(round, tick, snaps);
        }
    }

    fn detect_economy(&mut self, round: i32, tick: i32, snaps: &[EconSnapshot]) {
        if snaps.is_empty() {
            return;
        }
        let n = snaps.len() as f64;
        let (mut total_start, mut total_spent, mut total_remaining) = (0i64, 0i64, 0i64);
        let (mut rifles, mut smgs, mut pistols) = (0, 0, 0);
        for s in snaps {
            total_start += s.start_money;
            total_spent += s.spent;
            total_remaining += s.money;
            if is_rifle(s.primary) {
                rifles += 1;
            } else if is_smg(s.primary) {
                smgs += 1;
            } else if s.primary.is_empty() || is_pistol(s.primary) {
                pistols += 1;
            }
        }
        let avg_start = total_start as f64 / n;
        let avg_spent = total_spent as f64 / n;
        let team_spend_pct = avg_spent / avg_start;
        let avg_remaining = total_remaining as f64 / n;

        let mut majority = "other";
        let mut max = 0;
        if rifles > max {
            max = rifles;
            majority = "rifle";
        }
        if smgs > max {
            max = smgs;
            majority = "smg";
        }
        if pistols > max {
            majority = "pistol";
        }
        let value = |t: &str| match t {
            "rifle" => 3,
            "smg" => 2,
            "pistol" => 1,
            _ => 0,
        };

        for s in snaps {
            let spend_pct =
                if s.start_money > 0 { s.spent as f64 / s.start_money as f64 } else { 0.0 };
            let ptype = if is_rifle(s.primary) {
                "rifle"
            } else if is_smg(s.primary) {
                "smg"
            } else if is_pistol(s.primary) {
                "pistol"
            } else {
                "other"
            };
            let mut remaining_diff_pct = 0.0;
            if avg_remaining > 0.0 {
                remaining_diff_pct = (s.money as f64 - avg_remaining).abs() / avg_remaining;
            }
            let evened_out = avg_remaining > 0.0 && remaining_diff_pct < 0.15;
            let spend_diff = team_spend_pct - spend_pct;

            let mut grief: Option<(&str, f64, f64)> = None;
            if value(ptype) < value(majority)
                && ptype != "other"
                && majority != "other"
                && s.start_money > 3000
                && s.spent > 1500
                && spend_diff > 0.25
                && !evened_out
            {
                grief = Some(("equipment_mismatch", 0.75, 0.85));
            }

            let mut has_good = is_rifle(s.primary) || (is_smg(s.primary) && majority == "smg");
            if s.spent < 1000 && s.weapons.iter().any(|w| is_rifle(w) || is_smg(w)) {
                has_good = true;
            }
            if grief.is_none()
                && !has_good
                && team_spend_pct > 0.4
                && spend_pct < 0.25
                && s.start_money > 2000
                && spend_diff > 0.25
                && !evened_out
            {
                let severity = (s.start_money as f64 / 5000.0).min(1.0) * 0.7;
                let confidence = (spend_diff * 2.0).min(1.0) * 0.8;
                grief = Some(("no_buy_with_team", severity, confidence));
            }
            if grief.is_none() && s.money > 6000 && avg_start < 5000.0 && team_spend_pct > 0.25 {
                let severity = ((s.money - 3000) as f64 / 10000.0).min(1.0) * 0.6;
                let poverty = 1.0 - (avg_start / 8000.0);
                let confidence = (poverty * 1.5).min(1.0) * 0.7;
                grief = Some(("excessive_saving", severity, confidence));
            }
            if grief.is_none()
                && s.start_money > 8000
                && s.spent < 800
                && team_spend_pct > 0.5
                && !has_good
            {
                grief = Some(("full_save_high_money", 0.8, 0.85));
            }
            let Some((grief_type, severity, confidence)) = grief else { continue };

            let mut details = Vec::new();
            for w in s.weapons.iter().filter(|w| is_relevant_weapon(w)) {
                let purchase = if s.spent > 2000 && (is_rifle(w) || *w == "AWP") {
                    "bought"
                } else if s.spent < 800 && (is_rifle(w) || is_smg(w)) {
                    "saved"
                } else if s.spent < 1000 {
                    "saved"
                } else {
                    "likely_bought"
                };
                let mut d = J::obj();
                d.insert("name".into(), J::S(w.to_string()));
                d.insert("purchase".into(), J::S(purchase.into()));
                details.push(J::O(d));
            }
            let mut others = Vec::new();
            for o in snaps.iter().filter(|o| o.steamid != s.steamid) {
                let mut d = J::obj();
                d.insert("steamid".into(), J::S(o.steamid.clone()));
                d.insert("money".into(), J::Int(o.money));
                d.insert("primary".into(), J::S(o.primary.to_string()));
                d.insert(
                    "weapons".into(),
                    J::A(o
                        .weapons
                        .iter()
                        .filter(|w| is_relevant_weapon(w))
                        .map(|w| J::S(w.to_string()))
                        .collect()),
                );
                others.push(J::O(d));
            }
            let mut meta = J::obj();
            meta.insert("grief_type".into(), J::S(grief_type.into()));
            meta.insert("start_money".into(), J::Int(s.start_money));
            meta.insert("money_spent".into(), J::Int(s.spent));
            meta.insert("remaining_money".into(), J::Int(s.money));
            meta.insert("spend_pct".into(), J::F(spend_pct * 100.0));
            meta.insert("team_avg_spend".into(), J::F(avg_spent));
            meta.insert("team_avg_money".into(), J::F(avg_start));
            meta.insert("team_avg_remaining".into(), J::F(avg_remaining));
            meta.insert("team_spend_pct".into(), J::F(team_spend_pct * 100.0));
            meta.insert("primary_weapon".into(), J::S(s.primary.to_string()));
            meta.insert(
                "all_weapons".into(),
                if s.weapons.is_empty() {
                    J::Null
                } else {
                    J::A(s.weapons.iter().map(|w| J::S(w.to_string())).collect())
                },
            );
            meta.insert("weapon_details".into(), J::A(details));
            meta.insert("majority_weapon_type".into(), J::S(majority.into()));
            meta.insert("other_players".into(), J::A(others));
            self.ev_economy.push(Event {
                typ: "ECONOMY_GRIEF",
                round,
                start: tick,
                end: None,
                actor: Some(s.steamid.clone()),
                victim: None,
                severity,
                confidence,
                meta: Some(J::O(meta).encode()),
            });
        }
    }

    // -- grenades / shots --------------------------------------------------

    fn push_grenade_event(
        &mut self,
        kind: &'static str,
        name: &'static str,
        projectile: u64,
        pos: [f64; 3],
        thrower: Option<usize>,
        filter: bool,
    ) {
        if self.opts.events_only {
            return;
        }
        let Some(round) = self.cur_round.as_ref().map(|r| r.index) else { return };
        let thrower = self.thrower(thrower);
        if filter && !self.thrower_in_set(&thrower) {
            return;
        }
        self.grenade_events.push(GrenadeEvent {
            round,
            tick: self.st.tick,
            kind,
            projectile,
            name,
            x: pos[0],
            y: pos[1],
            z: pos[2],
            thrower,
        });
    }

    fn on_projectile_destroy(&mut self, proj: usize, pos: [f64; 3]) {
        let p = self.st.projs[proj].clone();
        let (kind, name, filter) = match p.wep {
            eq::SMOKE => ("smoke_start", "smokegrenade", false),
            eq::HE => ("he_explode", "hegrenade", true),
            eq::FLASH => ("flash_explode", "flashbang", true),
            eq::DECOY => ("decoy_start", "decoy", true),
            _ => return,
        };
        self.push_grenade_event(kind, name, p.uid, pos, p.thrower, filter);
    }

    fn on_generic(&mut self, ctx: &Context, ev: &QEvent) {
        match ev.name.as_str() {
            "player_disconnect" => {
                let userid = ev.num("userid");
                if userid == 0 {
                    return;
                }
                let reason = match ev.raw("reason") {
                    Some(EV::I(i)) => Some(J::Int(*i)),
                    Some(EV::S(s)) => Some(match s.parse::<i64>() {
                        Ok(i) => J::Int(i),
                        Err(_) => J::S(s.clone()),
                    }),
                    _ => None,
                };
                if let Some(r) = reason {
                    self.disconnect_reasons.insert(self.st.tick, r);
                }
            }
            "weapon_fire" => self.on_weapon_fire(ctx, ev),
            _ => {}
        }
    }

    fn on_weapon_fire(&mut self, ctx: &Context, ev: &QEvent) {
        if self.opts.events_only {
            return;
        }
        let Some(round) = self.cur_round.as_ref().map(|r| r.index) else { return };
        let tick = self.st.tick;
        match self.freeze_end {
            Some(f) if tick >= f => {}
            _ => return,
        }
        let userid = ev.num("userid");
        let weapon = match ev.raw("weapon") {
            Some(EV::S(s)) => s.as_str(),
            _ => "unknown",
        };
        if ["knife", "grenade", "flashbang", "smoke", "molotov", "incendiary", "decoy", "c4"]
            .iter()
            .any(|k| weapon.contains(k))
        {
            return;
        }
        // The Go parser matched the event's user id against controller entity
        // ids, which are off by one: every shot was attributed to the player in
        // the neighbouring slot and slot 0's shots were dropped. The default
        // here resolves the user id properly; `legacy_shots` keeps the old
        // behaviour so outputs can be compared row for row.
        let player = if self.opts.legacy_shots {
            if userid == 0 {
                return;
            }
            self.st.player_by_entity_id(userid)
        } else {
            self.st.player_by_userid(userid)
        };
        let Some(pid) = player else { return };
        let team = match self.st.players[pid].team {
            TEAM_T => "T",
            TEAM_CT => "CT",
            _ => return,
        };
        let steamid = self.sid_str(pid);
        if !self.in_set(&steamid) {
            return;
        }
        let pos = self.st.position(ctx, pid);
        let yaw = self.st.pawn(ctx, pid).map_or(0.0, |p| eye_angles(p)[1] as f64);
        self.shots.push(Shot {
            round,
            tick,
            steamid,
            weapon: weapon.to_string(),
            x: pos[0],
            y: pos[1],
            z: pos[2],
            yaw,
            team,
        });
    }

    // -- chat --------------------------------------------------------------

    fn on_chat(&mut self, ctx: &Context, msg: CUserMessageSayText2) {
        let mut player_name = msg.param1().to_string();
        let text = msg.param2().to_string();
        if text.is_empty() {
            return;
        }
        let team_chat = msg.messagename().to_lowercase().contains("team");
        let tick = self.st.tick;
        let ent_idx = msg.entityindex();

        let mut player: Option<usize> = None;
        if ent_idx > 0 {
            for pid in self.st.all() {
                let p = &self.st.players[pid];
                if p.has_entity && p.entity_id as i32 == ent_idx {
                    player = Some(pid);
                    if !p.name.is_empty() {
                        player_name = p.name.clone();
                    }
                    break;
                }
            }
        }
        let lower = player_name.to_lowercase();
        if player.is_none() {
            player = self
                .st
                .all()
                .into_iter()
                .find(|&pid| self.st.players[pid].name.to_lowercase() == lower);
        }
        let mut steamid = String::new();
        if player.is_none() {
            let hit = self
                .player_order
                .iter()
                .find(|sid| self.player_map[*sid].name.to_lowercase() == lower)
                .copied();
            if let Some(sid) = hit {
                steamid = sid.to_string();
                player = self.st.all().into_iter().find(|&pid| self.sid(pid) == sid);
            }
        }
        match player {
            Some(pid) => steamid = self.sid_str(pid),
            None => {
                if steamid.is_empty() {
                    steamid = player_name.clone();
                }
            }
        }

        let team: String = if team_chat {
            match player {
                Some(pid) => match self.team_map.get(&self.sid(pid)) {
                    Some(a) => a.to_string(),
                    None => match self.st.players[pid].team {
                        TEAM_T => {
                            if self.t_assign.is_empty() { "A" } else { self.t_assign }.to_string()
                        }
                        TEAM_CT => {
                            if self.ct_assign.is_empty() { "B" } else { self.ct_assign }.to_string()
                        }
                        _ => String::new(),
                    },
                },
                None => steamid
                    .parse::<u64>()
                    .ok()
                    .and_then(|sid| self.team_map.get(&sid))
                    .map(|a| a.to_string())
                    .unwrap_or_default(),
            }
        } else {
            player.map_or("", |pid| team_str(self.st.players[pid].team)).to_string()
        };

        let round = self.cur_round.as_ref().map_or(-1, |r| r.index);
        if self.opts.steam_ids.is_some() && !steamid.is_empty() && !self.in_set(&steamid) {
            return;
        }
        if self.opts.events_only {
            return;
        }
        // Only known match participants can be stored (the table references players).
        let Ok(sid64) = steamid.parse::<u64>() else { return };
        if sid64 == 0 {
            return;
        }
        if !self.player_map.contains_key(&sid64) {
            let Some(pid) = player else { return };
            let name = if player_name.is_empty() {
                format!("Player_{}", sid64)
            } else {
                player_name.clone()
            };
            let color = self.color_of(ctx, pid).unwrap_or("").to_string();
            self.player_map.insert(
                sid64,
                PlayerData { steamid: steamid.clone(), name, color, ..Default::default() },
            );
            self.player_order.push(sid64);
        }
        self.chat.push(Chat {
            round,
            tick,
            steamid,
            name: if player_name.is_empty() { None } else { Some(player_name) },
            team: if team.is_empty() { None } else { Some(team) },
            message: text,
            team_chat,
        });
    }

    // -- per-frame sampling ------------------------------------------------

    fn frame_done(&mut self, ctx: &Context) {
        let Some(round) = self.cur_round.as_ref().map(|r| r.index) else { return };
        let tick = self.st.tick;
        match self.freeze_end {
            Some(f) if tick >= f => {}
            _ => return,
        }
        if self.opts.events_only {
            return;
        }
        if tick - self.last_position_tick < self.opts.position_interval {
            return;
        }
        self.last_position_tick = tick;

        for pid in self.st.all() {
            let side = self.st.players[pid].team;
            let team = match side {
                TEAM_T => "T",
                TEAM_CT => "CT",
                _ => continue,
            };
            let sid = self.sid(pid);
            if self.opts.steam_ids.is_some() && !self.in_set(&sid.to_string()) {
                continue;
            }
            let name = self.player_name(pid);
            let mut needs_insert = self.ensure_player(sid, name);
            if needs_insert {
                self.first_connect_round.entry(sid).or_insert(round);
            }
            if self.player_map[&sid].team.is_empty() && self.first_round_processed {
                let mut assigned = "";
                for other in self.st.all() {
                    let o = &self.st.players[other];
                    if o.steam_id == sid || o.team != side {
                        continue;
                    }
                    if let Some(&a) = self.team_map.get(&o.steam_id) {
                        assigned = a;
                        break;
                    }
                }
                if assigned.is_empty() {
                    assigned = self.assign_for_side(side);
                }
                if !assigned.is_empty() {
                    self.team_map.insert(sid, assigned);
                    let fcr = self.first_connect_round.get(&sid).copied();
                    let pd = self.player_map.get_mut(&sid).unwrap();
                    pd.team = assigned.to_string();
                    if let Some(r) = fcr {
                        if r > 0 {
                            pd.connected_midgame = true;
                            pd.first_connect_round = Some(r);
                        }
                    }
                    needs_insert = true;
                }
            }
            if needs_insert && self.player_map[&sid].color.is_empty() {
                if let Some(c) = self.color_of(ctx, pid) {
                    self.player_map.get_mut(&sid).unwrap().color = c.to_string();
                }
            }

            let pawn = self.st.pawn(ctx, pid);
            let pos = pawn.map_or([0.0; 3], position);
            let health = pawn.and_then(|p| p_i64(p, "m_iHealth")).unwrap_or(0) as i32;
            let armor = pawn.and_then(|p| p_i64(p, "m_ArmorValue")).unwrap_or(0) as i32;
            let weapon = self
                .st
                .active_weapon(ctx, pid)
                .filter(|w| *w != eq::UNKNOWN)
                .map(eq::name)
                .filter(|n| !n.is_empty());
            let angles = pawn.map_or([0.0; 3], eye_angles);
            let (vx, vy) = (angles[1] as f64, angles[0] as f64);
            let has_view = vx != 0.0 || vy != 0.0;
            self.positions.push(Position {
                round,
                tick,
                steamid: sid,
                x: pos[0],
                y: pos[1],
                z: pos[2],
                view_x: has_view.then_some(vx),
                view_y: has_view.then_some(vy),
                team,
                health: (health > 0).then_some(health),
                armor: (armor > 0).then_some(armor),
                weapon,
            });
        }

        let projs: Vec<usize> = self.st.active_projs.values().copied().collect();
        for pid in projs {
            let p = &self.st.projs[pid];
            let Some(e) = ent_by_index(ctx, p.ent) else { continue };
            let pos = position(e);
            if pos == [0.0; 3] {
                continue;
            }
            let Some(name) = grenade_name(p.wep) else { continue };
            let thrower = self.thrower(p.thrower);
            if !self.thrower_in_set(&thrower) {
                continue;
            }
            self.grenade_positions.push(GrenadePos {
                round,
                tick,
                projectile: p.uid,
                name,
                x: pos[0],
                y: pos[1],
                z: pos[2],
                thrower,
            });
        }

        let infs: Vec<Inferno> = self.st.infernos.values().cloned().collect();
        for inf in infs {
            let Some(e) = ent_by_index(ctx, inf.ent) else { continue };
            let points = hull::inferno_hull(e);
            if points.is_empty() {
                continue;
            }
            let polygon = J::A(
                points.iter().map(|p| J::A(vec![J::F(p[0]), J::F(p[1])])).collect(),
            )
            .encode();
            let thrower = self.thrower(self.st.inferno_thrower(ctx, &inf));
            if !self.thrower_in_set(&thrower) {
                continue;
            }
            self.infernos.push(InfernoPos { tick, entity: inf.uid, polygon, thrower });
        }
        self.stream(false);
    }

    /// Passes finished rows on to the database writer. Positions stay in
    /// memory as well because the AFK and body-block detectors need them.
    fn stream(&mut self, all: bool) {
        let Some(sink) = &self.sink else {
            // Nothing stores these without a database.
            self.grenade_position_count += self.grenade_positions.len();
            self.grenade_positions.clear();
            self.infernos.clear();
            return;
        };
        let limit = if all { 1 } else { STREAM_CHUNK };
        // A failed send means the writer stopped; it reports why at the end.
        if self.positions.len() - self.positions_sent >= limit {
            let _ = sink.send(Msg::Positions(self.positions[self.positions_sent..].to_vec()));
            self.positions_sent = self.positions.len();
        }
        if self.grenade_positions.len() >= limit {
            self.grenade_position_count += self.grenade_positions.len();
            let _ = sink.send(Msg::Grenades(std::mem::take(&mut self.grenade_positions)));
        }
        if self.infernos.len() >= limit {
            let _ = sink.send(Msg::Infernos(std::mem::take(&mut self.infernos)));
        }
    }

    /// Handles the derived events produced since the last call.
    fn pump(&mut self, ctx: &Context) {
        if self.st.signals.is_empty() {
            return;
        }
        for sig in std::mem::take(&mut self.st.signals) {
            self.handle(ctx, sig);
        }
    }

    fn handle(&mut self, ctx: &Context, sig: Sig) {
        match sig {
            Sig::RoundStart => self.on_round_start(ctx),
            Sig::RoundEnd { winner } => self.on_round_end(winner),
            Sig::FreezeEnd => self.on_freeze_end(ctx),
            Sig::PlayerConnect { pid, team } => self.on_player_connect(ctx, pid, team),
            Sig::PlayerDisconnected(pid) => self.on_player_disconnected(pid),
            Sig::NameChange(pid) => self.on_name_change(pid),
            Sig::Kill { killer, victim, weapon, headshot } => {
                self.on_kill(ctx, killer, victim, weapon, headshot)
            }
            Sig::Hurt { victim, attacker, health_damage, armor_damage, hitgroup, weapon } => {
                self.on_hurt(victim, attacker, health_damage, armor_damage, hitgroup, weapon)
            }
            Sig::Flashed { player, attacker } => self.on_flashed(player, attacker),
            Sig::ProjectileDestroy { proj, pos } => self.on_projectile_destroy(proj, pos),
            Sig::InfernoStart { uid, thrower } => {
                self.push_grenade_event("inferno_start", "incendiary", uid, [0.0; 3], thrower, true)
            }
            Sig::InfernoExpired { uid, thrower } => {
                self.push_grenade_event("inferno_expire", "incendiary", uid, [0.0; 3], thrower, true)
            }
            Sig::DecoyExpired { thrower, entity } => self.push_grenade_event(
                "decoy_expire",
                "decoy",
                entity as u64,
                [0.0; 3],
                thrower,
                true,
            ),
            Sig::SmokeExpired { thrower, entity } => self.push_grenade_event(
                "smoke_expire",
                "smokegrenade",
                entity as u64,
                [0.0; 3],
                thrower,
                true,
            ),
            Sig::Generic(ev) => self.on_generic(ctx, &ev),
        }
    }

    /// Builds the final match data once the demo has been read to the end.
    pub fn finish(mut self, demo_file_name: &str) -> MatchData {
        self.stream(true);
        let final_tick = self.st.tick;
        if final_tick > self.max_tick {
            self.max_tick = final_tick;
        }
        let round_number = self.round_number;
        if let Some(cb) = self.progress.as_mut() {
            cb("parsing", final_tick, round_number, PARSING_PCT);
        }
        if let Some(mut r) = self.cur_round.take() {
            r.end = final_tick;
            let idx = r.index;
            self.rounds.push(r);
            self.finalize_damage_round(idx);
        }
        if let Some(cb) = self.progress.as_mut() {
            cb("extracting_events", final_tick, round_number, PARSING_PCT);
        }

        let mut events = Vec::new();
        events.append(&mut self.ev_team_kill);
        events.append(&mut self.ev_kill);
        events.append(&mut self.ev_team_damage);
        events.append(&mut self.ev_team_flash);
        events.append(&mut self.ev_disconnect);
        events.append(&mut self.ev_economy);

        let mut players = Vec::new();
        for sid in &self.player_order {
            let mut p = self.player_map[sid].clone();
            if p.team.is_empty() {
                if let Some(t) = self.team_map.get(sid) {
                    p.team = t.to_string();
                }
            }
            if self.disconnected.get(sid).copied().unwrap_or(false) {
                let dc_tick = self.disconnect_tick.get(sid).copied().unwrap_or(0);
                if self.max_tick > 0 {
                    if (self.max_tick - dc_tick) as f64 / TICK_RATE > 20.0 {
                        p.permanent_disconnect = true;
                    }
                } else {
                    p.permanent_disconnect = true;
                }
                if let Some(r) = self.disconnect_round.get(sid) {
                    p.disconnect_round = Some(*r);
                }
            }
            if let Some(&r) = self.first_connect_round.get(sid) {
                if r > 0 {
                    p.connected_midgame = true;
                }
                p.first_connect_round = Some(r);
            }
            if self.in_set(&p.steamid) {
                players.push(p);
            }
        }

        let est_freeze = (TICK_RATE * 15.0) as i32;
        for r in self.rounds.iter_mut() {
            if r.freeze_end.is_none() {
                r.freeze_end = Some(r.start + est_freeze);
            }
        }

        MatchData {
            map: self.map_name,
            tick_rate: TICK_RATE,
            source: crate::source::demo_source("", demo_file_name),
            build_num: self.build_num,
            players,
            rounds: self.rounds,
            events,
            chat: self.chat,
            positions: self.positions,
            grenade_events: self.grenade_events,
            shots: self.shots,
            grenade_position_count: self.grenade_position_count,
        }
    }
}

impl Observer for Extractor {
    fn interests(&self) -> Interests {
        Interests::ENTITY_STATE
            | Interests::ENTITY_EVENTS
            | Interests::BASE_GAME_EVENT
            | Interests::BASE_USER_MESSAGE
            | Interests::STRING_TABLE_STATE
            | Interests::STRING_TABLE_ENTRIES
            | Interests::DEMO_MESSAGE
            | Interests::SVC_MESSAGE
    }

    fn on_entity(&mut self, ctx: &Context, ev: EntityEvents, e: &Entity) -> ObserverResult {
        if !self.stopped {
            self.st.on_entity(ctx, ev, e);
            self.pump(ctx);
        }
        Ok(())
    }

    fn on_game_event(&mut self, ctx: &Context, ge: &GameEvent) -> ObserverResult {
        if !self.stopped {
            self.st.on_game_event(ctx, ge);
            self.pump(ctx);
        }
        Ok(())
    }

    fn on_base_user_message(
        &mut self,
        ctx: &Context,
        msg_type: EBaseUserMessages,
        msg: &[u8],
    ) -> ObserverResult {
        if !self.stopped && msg_type == EBaseUserMessages::UmSayText2 {
            if let Ok(m) = CUserMessageSayText2::decode(msg) {
                self.st.update_tick(ctx);
                self.on_chat(ctx, m);
            }
        }
        Ok(())
    }

    fn on_svc_message(&mut self, _ctx: &Context, msg_type: SvcMessages, msg: &[u8]) -> ObserverResult {
        if msg_type == SvcMessages::SvcServerInfo {
            if let Ok(m) = CSvcMsgServerInfo::decode(msg) {
                self.map_name = m.map_name().to_string();
                let interval = m.tick_interval();
                if interval != 0.0 {
                    self.st.tick_rate = 1.0 / interval as f64;
                }
            }
        }
        Ok(())
    }

    fn on_string_table(
        &mut self,
        ctx: &Context,
        table: &StringTable,
        modified: &[i32],
    ) -> ObserverResult {
        if self.stopped || table.name() != "userinfo" {
            return Ok(());
        }
        for &i in modified {
            let Ok(row) = table.get_row(i as usize) else { continue };
            let Ok(index) = row.key().parse::<i32>() else { continue };
            let Some(data) = row.value() else { continue };
            let Ok(info) = CMsgPlayerInfo::decode(data) else { continue };
            if info.xuid() == 0 && info.name().is_empty() {
                continue;
            }
            self.st.set_raw_player(
                index,
                RawPlayer {
                    xuid: info.xuid(),
                    name: info.name().to_string(),
                    user_id: info.userid(),
                    fake: info.fakeplayer(),
                },
            );
        }
        self.pump(ctx);
        Ok(())
    }

    fn on_demo_command(
        &mut self,
        ctx: &Context,
        msg_type: EDemoCommands,
        msg: &[u8],
    ) -> ObserverResult {
        if self.stopped {
            return Ok(());
        }
        if msg_type == EDemoCommands::DemFileHeader {
            if let Ok(h) = CDemoFileHeader::decode(msg) {
                self.build_num = h.patch_version();
            }
        }
        self.st.end_frame(ctx);
        self.pump(ctx);
        self.frame_done(ctx);
        if msg_type == EDemoCommands::DemStop {
            self.stopped = true;
        }
        Ok(())
    }
}
