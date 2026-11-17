//! Game-state tracking on top of `source2-demo`.
//!
//! The old Go parser was built on demoinfocs-golang, whose derived events
//! (round start/end from game rules, flashes from pawn props, projectile
//! lifetimes, connect/disconnect from controllers, ...) define what ends up in
//! the database. This module reproduces those semantics so the Rust extractor
//! emits the same rows:
//!
//! * a "frame" is one demo command; game events of a frame are handled after
//!   its entity updates, and frame-end work runs in demoinfocs' order
//! * property handlers of newly created entities run after the whole packet
//! * players live in an arena so projectiles keep referring to their thrower

use crate::equipment as eq;
use crate::equipment::Eq;
use crate::util::*;
use source2_demo::prelude::*;
use std::collections::{BTreeMap, HashMap};

pub const TEAM_UNASSIGNED: u8 = 0;
pub const TEAM_SPECTATORS: u8 = 1;
pub const TEAM_T: u8 = 2;
pub const TEAM_CT: u8 = 3;

#[derive(Clone, Debug, Default)]
pub struct GPlayer {
    pub steam_id: u64,
    pub name: String,
    pub user_id: i32,
    pub is_bot: bool,
    pub is_connected: bool,
    pub team: u8,
    pub entity_id: u32,
    pub has_entity: bool,
    pub flash_duration: f32,
    pub flash_tick: i32,
}

#[derive(Clone, Debug)]
pub struct RawPlayer {
    pub xuid: u64,
    pub name: String,
    pub user_id: i32,
    pub fake: bool,
}

#[derive(Clone, Debug)]
pub struct Proj {
    pub uid: u64,
    pub ent: u32,
    pub thrower: Option<usize>,
    pub owner: Option<usize>,
    pub wep: Eq,
    last_thrower_h: Option<u64>,
    last_owner_h: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct Inferno {
    pub uid: u64,
    pub ent: u32,
    pub thrower: Option<usize>,
}

struct Flying {
    proj: usize,
    flashed: Vec<u32>,
    exploded_frame: i64,
}

#[derive(Clone, Debug)]
pub enum EV {
    S(String),
    F(f32),
    I(i64),
    B(bool),
}

/// A game event copied out of the packet so it can be handled at frame end.
#[derive(Clone, Debug)]
pub struct QEvent {
    pub name: String,
    pub data: Vec<(String, EV)>,
}

impl QEvent {
    fn get(&self, key: &str) -> Option<&EV> {
        self.data.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    pub fn num(&self, key: &str) -> i64 {
        match self.get(key) {
            Some(EV::I(i)) => *i,
            Some(EV::B(b)) => *b as i64,
            Some(EV::F(f)) => *f as i64,
            _ => 0,
        }
    }
    pub fn text(&self, key: &str) -> &str {
        match self.get(key) {
            Some(EV::S(s)) => s.as_str(),
            _ => "",
        }
    }
    pub fn flag(&self, key: &str) -> bool {
        match self.get(key) {
            Some(EV::B(b)) => *b,
            Some(EV::I(i)) => *i != 0,
            _ => false,
        }
    }
    pub fn raw(&self, key: &str) -> Option<&EV> {
        self.get(key)
    }
}

/// Derived events, in the order demoinfocs would have dispatched them.
#[derive(Clone, Debug)]
pub enum Sig {
    RoundStart,
    RoundEnd { winner: u8 },
    FreezeEnd,
    PlayerConnect { pid: usize, team: u8 },
    PlayerDisconnected(usize),
    NameChange(usize),
    Kill { killer: Option<usize>, victim: Option<usize>, weapon: Option<Eq>, headshot: bool },
    Hurt {
        victim: Option<usize>,
        attacker: Option<usize>,
        health_damage: i64,
        armor_damage: i64,
        hitgroup: i64,
        weapon: Option<Eq>,
    },
    Flashed { player: usize, attacker: Option<usize> },
    ProjectileDestroy { proj: usize, pos: [f64; 3] },
    InfernoStart { uid: u64, thrower: Option<usize> },
    InfernoExpired { uid: u64, thrower: Option<usize> },
    DecoyExpired { thrower: Option<usize>, entity: i64 },
    SmokeExpired { thrower: Option<usize>, entity: i64 },
    /// Raw `weapon_fire` / `player_disconnect` events (GenericGameEvent).
    Generic(QEvent),
}

const K_OTHER: u8 = 1;
const K_CTL: u8 = 2;
const K_PAWN: u8 = 3;
const K_RULES: u8 = 4;
const K_PROJ: u8 = 5;
const K_INFERNO: u8 = 6;
const K_C4: u8 = 7;

enum Created {
    Controller(u32),
    Pawn(u32),
    Rules(u32),
    Proj(u32),
}

#[derive(Default)]
struct CtlState {
    connected: Option<u64>,
    team: Option<u64>,
}

#[derive(Default)]
pub struct State {
    pub players: Vec<GPlayer>,
    pub by_entity: HashMap<u32, usize>,
    pub by_userid: BTreeMap<i32, usize>,
    pub raw_players: HashMap<i32, RawPlayer>,

    pub projs: Vec<Proj>,
    pub active_projs: BTreeMap<u32, usize>,
    pub infernos: BTreeMap<u32, Inferno>,
    flying: Vec<Flying>,
    thrown: HashMap<usize, HashMap<Eq, u32>>,
    next_uid: u64,

    kinds: Vec<u8>,
    ctl_state: HashMap<u32, CtlState>,
    pawn_flash: HashMap<u32, f32>,
    c4_ticking: HashMap<u32, bool>,
    rules_reason: Option<i64>,
    rules_started: Option<bool>,
    rules_first_update: bool,
    created: Vec<Created>,

    pending_round_start: bool,
    pending_round_end: Option<u8>,
    known: HashMap<u32, u32>,
    entities_this_frame: bool,
    pub late_events: u64,
    delayed: Vec<Delayed>,
    fall_damage_frame: HashMap<i64, i64>,
    bomb_exploded_frame: i64,

    pub frame: i64,
    pub tick: i32,
    pub tick_rate: f64,
    pub signals: Vec<Sig>,
}

enum Delayed {
    Death(QEvent),
    Hurt(QEvent),
    Fire(QEvent),
    DeleteDecoy(Option<usize>),
}

fn is_handled_event(name: &str) -> bool {
    matches!(
        name,
        "round_freeze_end"
            | "player_death"
            | "player_hurt"
            | "player_falldamage"
            | "player_disconnect"
            | "weapon_fire"
            | "decoy_detonate"
            | "smokegrenade_expired"
    )
}

impl State {
    pub fn new() -> Self {
        State { bomb_exploded_frame: -1, tick_rate: 64.0, next_uid: 1, ..Default::default() }
    }

    pub fn update_tick(&mut self, ctx: &Context) {
        let t = ctx.tick();
        if t != u32::MAX && t > 0 {
            self.tick = t as i32;
        }
    }

    fn kind_of(&mut self, e: &Entity) -> u8 {
        let id = e.class().id() as usize;
        if id >= self.kinds.len() {
            self.kinds.resize(id + 1, 0);
        }
        if self.kinds[id] == 0 {
            let n = e.class().name();
            self.kinds[id] = match n {
                "CCSPlayerController" => K_CTL,
                "CCSPlayerPawn" => K_PAWN,
                "CCSGameRulesProxy" => K_RULES,
                "CInferno" => K_INFERNO,
                "CPlantedC4" => K_C4,
                _ if n.ends_with("Projectile") => K_PROJ,
                _ => K_OTHER,
            };
        }
        self.kinds[id]
    }

    // -- player lookups ----------------------------------------------------

    /// `Participants().All()`: every player known by user id.
    pub fn all(&self) -> Vec<usize> {
        self.by_userid.values().copied().collect()
    }

    pub fn controller<'a>(&self, ctx: &'a Context, pid: usize) -> Option<&'a Entity> {
        let p = &self.players[pid];
        if !p.has_entity {
            return None;
        }
        let e = ent_by_index(ctx, p.entity_id)?;
        if e.class().name() == "CCSPlayerController" {
            Some(e)
        } else {
            None
        }
    }

    pub fn pawn<'a>(&self, ctx: &'a Context, pid: usize) -> Option<&'a Entity> {
        let ctl = self.controller(ctx, pid)?;
        let h = p_u64(ctl, "m_hPawn")?;
        if h == INVALID_HANDLE {
            return None;
        }
        let pp = p_u64(ctl, "m_hPlayerPawn")?;
        ent_by_handle(ctx, pp)
    }

    pub fn find_by_pawn_handle(&self, ctx: &Context, handle: u64) -> Option<usize> {
        if handle == INVALID_HANDLE {
            return None;
        }
        let idx = (handle & INDEX_MASK) as u32;
        self.by_userid
            .values()
            .copied()
            .find(|&pid| self.pawn(ctx, pid).map_or(false, |e| e.index() == idx))
    }

    fn player_by_userid32(&self, raw: i64) -> Option<usize> {
        let uid = if raw <= 0xffff { raw & 0xff } else { raw } as i32;
        if let Some(p) = self.by_userid.get(&uid) {
            return Some(*p);
        }
        let r = self.raw_players.get(&uid)?;
        self.by_userid.get(&r.user_id).copied()
    }

    pub fn position(&self, ctx: &Context, pid: usize) -> [f64; 3] {
        self.pawn(ctx, pid).map_or([0.0; 3], position)
    }

    /// Weapon type of the entity at `index`, if it is an equipment entity.
    fn weapon_type_at(ctx: &Context, index: u32) -> Option<Eq> {
        let e = ent_by_index(ctx, index)?;
        let item = p_u64(e, "m_iItemDefinitionIndex")?;
        Some(eq::from_item_index(item))
    }

    pub fn active_weapon(&self, ctx: &Context, pid: usize) -> Option<Eq> {
        let pawn = self.pawn(ctx, pid)?;
        let h = p_u64(pawn, "m_pWeaponServices.m_hActiveWeapon")?;
        Self::weapon_type_at(ctx, (h & INDEX_MASK) as u32)
    }

    /// The player's inventory as weapon types, in slot order.
    pub fn inventory(&self, ctx: &Context, pid: usize) -> Vec<Eq> {
        let mut out = Vec::new();
        let Some(pawn) = self.pawn(ctx, pid) else { return out };
        let n = p_u64(pawn, "m_pWeaponServices.m_hMyWeapons").unwrap_or(0).min(64);
        let mut seen: Vec<u64> = Vec::new();
        for i in 0..n {
            let name = format!("m_pWeaponServices.m_hMyWeapons.{:04}", i);
            let Some(h) = p_u64(pawn, &name) else { continue };
            let idx = h & INDEX_MASK;
            if seen.contains(&idx) {
                continue;
            }
            seen.push(idx);
            out.push(Self::weapon_type_at(ctx, idx as u32).unwrap_or(eq::UNKNOWN));
        }
        out
    }

    fn player_weapon(&self, ctx: &Context, player: Option<usize>, wep: Eq) -> Eq {
        if let Some(pid) = player {
            let alt = eq::alternative(wep);
            for w in self.inventory(ctx, pid) {
                if w == wep || (alt != eq::UNKNOWN && w == alt) {
                    return w;
                }
            }
        }
        wep
    }

    fn equipment_instance(&self, ctx: &Context, player: Option<usize>, wep: Eq) -> Option<Eq> {
        if eq::class(wep) == eq::CLASS_GRENADE {
            return self.get_thrown(player, wep);
        }
        Some(self.player_weapon(ctx, player, wep))
    }

    // -- thrown grenade bookkeeping ----------------------------------------

    fn add_thrown(&mut self, player: Option<usize>, wep: Eq) {
        if let Some(p) = player {
            *self.thrown.entry(p).or_default().entry(wep).or_default() += 1;
        }
    }

    fn get_thrown(&self, player: Option<usize>, wep: Eq) -> Option<Eq> {
        let g = self.thrown.get(&player?)?;
        let has = |t: Eq| g.get(&t).copied().unwrap_or(0) > 0;
        if has(wep) {
            return Some(wep);
        }
        match wep {
            eq::INCENDIARY if has(eq::MOLOTOV) => Some(eq::MOLOTOV),
            eq::MOLOTOV if has(eq::INCENDIARY) => Some(eq::INCENDIARY),
            _ => None,
        }
    }

    fn delete_thrown(&mut self, player: Option<usize>, wep: Eq) {
        let Some(p) = player else { return };
        if let Some(g) = self.thrown.get_mut(&p) {
            if let Some(c) = g.get_mut(&wep) {
                if *c > 0 {
                    *c -= 1;
                }
                if *c == 0 {
                    g.remove(&wep);
                }
            }
        }
    }

    // -- players -----------------------------------------------------------

    fn get_or_create(&mut self, entity_id: u32, rp: Option<RawPlayer>) -> usize {
        let mut user_id = rp.as_ref().map_or(-1, |r| r.user_id);
        if user_id <= 0xffff {
            user_id &= 0xff;
        }
        let pid = match self.by_entity.get(&entity_id).copied() {
            Some(p) => p,
            None => match &rp {
                Some(r) => match self.by_userid.get(&user_id).copied() {
                    Some(p) => p,
                    None => {
                        self.players.push(GPlayer {
                            name: r.name.clone(),
                            steam_id: r.xuid,
                            is_bot: r.fake,
                            user_id,
                            ..Default::default()
                        });
                        self.players.len() - 1
                    }
                },
                None => {
                    self.players.push(GPlayer { name: "unknown".into(), ..Default::default() });
                    self.players.len() - 1
                }
            },
        };
        self.by_entity.insert(entity_id, pid);
        if rp.is_some() {
            self.by_userid.insert(user_id, pid);
        }
        pid
    }

    fn get_or_create_from_controller(&mut self, e: &Entity) -> usize {
        let id = e.index();
        let rp = self.raw_players.get(&(id as i32 - 1)).cloned();
        let pid = self.get_or_create(id, rp);
        let is_bot = p_u64(e, "m_steamID") == Some(0);
        let p = &mut self.players[pid];
        p.has_entity = true;
        p.entity_id = id;
        p.is_bot = is_bot;
        if is_bot {
            p.name = p_str(e, "m_iszPlayerName").unwrap_or_default();
        }
        pid
    }

    /// `setRawPlayer`: a userinfo string-table entry was created or changed.
    pub fn set_raw_player(&mut self, index: i32, mut info: RawPlayer) {
        if info.user_id == 0xffff {
            if let Some(old) = self.raw_players.get(&index) {
                info.user_id = old.user_id;
            }
        }
        self.raw_players.insert(index, info.clone());
        if let Some(&pid) = self.by_entity.get(&((index + 1) as u32)) {
            let p = &mut self.players[pid];
            let changed = !p.is_bot && !info.fake && p.name != info.name;
            p.name = info.name;
            p.steam_id = info.xuid;
            p.is_bot = info.fake;
            if changed {
                self.signals.push(Sig::NameChange(pid));
            }
        }
    }

    fn on_connected_changed(&mut self, e: &Entity, state: u64) {
        let pid = self.get_or_create_from_controller(e);
        let was = self.players[pid].is_connected;
        self.players[pid].is_connected = state == 0;
        if state == 8 {
            let sid = self.players[pid].steam_id;
            self.raw_players.retain(|_, v| v.xuid != sid);
            self.signals.push(Sig::PlayerDisconnected(pid));
            return;
        }
        if !was && self.players[pid].is_connected && self.players[pid].steam_id != 0 {
            let team = self.players[pid].team;
            self.signals.push(Sig::PlayerConnect { pid, team });
        }
    }

    fn on_flash_duration(&mut self, pawn: &Entity, val: f32) {
        let Some(h) = p_u64(pawn, "m_hController") else { return };
        if h == INVALID_HANDLE {
            return;
        }
        let Some(&pid) = self.by_entity.get(&((h & INDEX_MASK) as u32)) else { return };
        let tick = self.tick;
        let p = &mut self.players[pid];
        p.flash_tick = if val == 0.0 { 0 } else { tick };
        p.flash_duration = val;
        if val > 0.0 {
            let ent = p.entity_id;
            if let Some(f) = self.flying.first_mut() {
                f.flashed.push(ent);
            }
        }
    }

    // -- projectiles / infernos --------------------------------------------

    fn projectile_type(e: &Entity) -> Eq {
        match e.class().name() {
            "CSmokeGrenadeProjectile" => eq::SMOKE,
            "CHEGrenadeProjectile" => eq::HE,
            "CFlashbangProjectile" => eq::FLASH,
            "CDecoyProjectile" => eq::DECOY,
            "CMolotovProjectile" => {
                if p_bool(e, "m_bIsIncGrenade").unwrap_or(false) {
                    eq::INCENDIARY
                } else {
                    eq::MOLOTOV
                }
            }
            _ => eq::UNKNOWN,
        }
    }

    fn nade_destroyed(&mut self, ctx: &Context, pid: usize) {
        let ent = self.projs[pid].ent;
        if !self.active_projs.contains_key(&ent) {
            return;
        }
        let pos = ent_by_index(ctx, ent).map_or([0.0; 3], position);
        self.signals.push(Sig::ProjectileDestroy { proj: pid, pos });
        self.active_projs.remove(&ent);
        let wep = self.projs[pid].wep;
        let keeps = matches!(wep, eq::MOLOTOV | eq::INCENDIARY | eq::SMOKE | eq::DECOY);
        if !keeps {
            let thrower = self.projs[pid].thrower;
            self.delete_thrown(thrower, wep);
        }
    }

    pub fn inferno_thrower(&self, ctx: &Context, inf: &Inferno) -> Option<usize> {
        if inf.thrower.is_some() {
            return inf.thrower;
        }
        let e = ent_by_index(ctx, inf.ent)?;
        self.find_by_pawn_handle(ctx, p_u64(e, "m_hOwnerEntity")?)
    }

    fn inferno_expired(&mut self, ctx: &Context, ent: u32) {
        let Some(inf) = self.infernos.get(&ent).cloned() else { return };
        let thrower = self.inferno_thrower(ctx, &inf);
        self.signals.push(Sig::InfernoExpired { uid: inf.uid, thrower });
        self.infernos.remove(&ent);
        self.delete_thrown(thrower, eq::INCENDIARY);
    }

    fn clear_grenade_projectiles(&mut self, ctx: &Context) {
        let projs: Vec<usize> = self.active_projs.values().copied().collect();
        for p in projs {
            self.nade_destroyed(ctx, p);
        }
        let infs: Vec<u32> = self.infernos.keys().copied().collect();
        for i in infs {
            self.inferno_expired(ctx, i);
        }
        self.thrown.clear();
        self.flying.clear();
    }

    fn dispatch_round_start(&mut self, ctx: &Context) {
        self.clear_grenade_projectiles(ctx);
        self.pending_round_start = true;
    }

    fn on_match_started(&mut self, ctx: &Context, rules: &Entity, started: bool) {
        if started && p_i64(rules, "m_pGameRules.m_eRoundWinReason").unwrap_or(0) == 0 {
            self.dispatch_round_start(ctx);
        }
    }

    fn on_win_reason(&mut self, ctx: &Context, reason: i64) {
        if !self.rules_first_update {
            self.rules_first_update = true;
            return;
        }
        if reason == 0 {
            self.dispatch_round_start(ctx);
            return;
        }
        let winner = match reason {
            1 | 4 | 9 | 13 | 19 | 18 => TEAM_T,
            20 | 5 | 6 | 7 | 8 | 11 | 12 | 14 | 17 => TEAM_CT,
            16 | 10 => TEAM_SPECTATORS,
            _ => TEAM_UNASSIGNED,
        };
        self.pending_round_end = Some(winner);
    }

    // -- entity callback ---------------------------------------------------

    pub fn on_entity(&mut self, ctx: &Context, ev: EntityEvents, e: &Entity) {
        let kind = self.kind_of(e);
        if kind == K_OTHER {
            return;
        }
        self.update_tick(ctx);
        self.entities_this_frame = true;
        let idx = e.index();
        // A full snapshot announces live entities again; demoinfocs ignores
        // those, so a repeated create of the same entity is just an update.
        let ev = match ev {
            EntityEvents::Created => {
                if self.known.insert(idx, e.serial()) == Some(e.serial()) {
                    EntityEvents::Updated
                } else {
                    EntityEvents::Created
                }
            }
            EntityEvents::Deleted => {
                self.known.remove(&idx);
                EntityEvents::Deleted
            }
            other => other,
        };
        match (kind, ev) {
            (K_CTL, EntityEvents::Created) => {
                self.get_or_create_from_controller(e);
                self.ctl_state.insert(idx, CtlState::default());
                self.created.push(Created::Controller(idx));
            }
            (K_CTL, EntityEvents::Updated) => {
                let conn = p_u64(e, "m_iConnected");
                let team = p_u64(e, "m_iTeamNum");
                let st = self.ctl_state.entry(idx).or_default();
                let conn_changed = st.connected != conn;
                let team_changed = st.team != team;
                st.connected = conn;
                st.team = team;
                if conn_changed {
                    if let Some(c) = conn {
                        self.on_connected_changed(e, c);
                    }
                }
                if team_changed {
                    if let (Some(t), Some(&pid)) = (team, self.by_entity.get(&idx)) {
                        self.players[pid].team = t as u8;
                    }
                }
            }
            (K_CTL, EntityEvents::Deleted) => {
                if let Some(pid) = self.by_entity.remove(&idx) {
                    self.players[pid].is_connected = false;
                    let uid = self.players[pid].user_id;
                    self.by_userid.remove(&uid);
                }
                self.ctl_state.remove(&idx);
            }
            (K_PAWN, EntityEvents::Created) => {
                self.created.push(Created::Pawn(idx));
            }
            (K_PAWN, EntityEvents::Updated) => {
                if let Some(v) = p_f32(e, "m_flFlashDuration") {
                    let last = self.pawn_flash.insert(idx, v);
                    if last != Some(v) {
                        self.on_flash_duration(e, v);
                    }
                }
            }
            (K_PAWN, EntityEvents::Deleted) => {
                self.pawn_flash.remove(&idx);
            }
            (K_RULES, EntityEvents::Created) => {
                self.rules_first_update = false;
                self.created.push(Created::Rules(idx));
            }
            (K_RULES, EntityEvents::Updated) => {
                let started = p_bool(e, "m_pGameRules.m_bHasMatchStarted");
                let reason = p_i64(e, "m_pGameRules.m_eRoundWinReason");
                if started != self.rules_started {
                    self.rules_started = started;
                    if let Some(s) = started {
                        self.on_match_started(ctx, e, s);
                    }
                }
                if reason != self.rules_reason {
                    self.rules_reason = reason;
                    if let Some(r) = reason {
                        self.on_win_reason(ctx, r);
                    }
                }
            }
            (K_PROJ, EntityEvents::Created) => {
                let owner_h = p_u64(e, "m_hOwnerEntity");
                let player = owner_h.and_then(|h| self.find_by_pawn_handle(ctx, h));
                let wep = Self::projectile_type(e);
                let uid = self.next_uid;
                self.next_uid += 1;
                self.projs.push(Proj {
                    uid,
                    ent: idx,
                    thrower: player,
                    owner: player,
                    wep,
                    last_thrower_h: p_u64(e, "m_hThrower"),
                    last_owner_h: owner_h,
                });
                let pid = self.projs.len() - 1;
                self.active_projs.insert(idx, pid);
                self.add_thrown(player, wep);
                if wep == eq::FLASH {
                    self.flying.push(Flying { proj: pid, flashed: Vec::new(), exploded_frame: 0 });
                }
                self.created.push(Created::Proj(idx));
            }
            (K_PROJ, EntityEvents::Updated) => {
                let Some(&pid) = self.active_projs.get(&idx) else { return };
                let th = p_u64(e, "m_hThrower");
                let oh = p_u64(e, "m_hOwnerEntity");
                if oh != self.projs[pid].last_owner_h {
                    self.projs[pid].last_owner_h = oh;
                    if let Some(h) = oh {
                        self.projs[pid].owner = self.find_by_pawn_handle(ctx, h);
                    }
                }
                if th != self.projs[pid].last_thrower_h {
                    self.projs[pid].last_thrower_h = th;
                    if let Some(h) = th {
                        self.projs[pid].thrower = self.find_by_pawn_handle(ctx, h);
                    }
                }
            }
            (K_PROJ, EntityEvents::Deleted) => {
                // The entity may have been replaced in the map by a newer one
                // at the same index; resolve the projectile that owns it.
                let Some(pid) = self.projs.iter().rposition(|p| p.ent == idx) else { return };
                if self.projs[pid].wep == eq::FLASH {
                    match self.flying.first_mut() {
                        Some(f) => f.exploded_frame = self.frame,
                        None => return,
                    }
                }
                self.nade_destroyed(ctx, pid);
            }
            (K_INFERNO, EntityEvents::Created) => {
                let Some(h) = p_u64(e, "m_hOwnerEntity") else { return };
                let thrower = self.find_by_pawn_handle(ctx, h);
                let uid = self.next_uid;
                self.next_uid += 1;
                let inf = Inferno { uid, ent: idx, thrower };
                let t = self.inferno_thrower(ctx, &inf);
                self.infernos.insert(idx, inf);
                self.signals.push(Sig::InfernoStart { uid, thrower: t });
            }
            (K_INFERNO, EntityEvents::Deleted) => {
                self.inferno_expired(ctx, idx);
            }
            (K_C4, EntityEvents::Created) => {
                self.c4_ticking.insert(idx, p_bool(e, "m_bBombTicking").unwrap_or(true));
            }
            (K_C4, EntityEvents::Updated) => {
                let ticking = p_bool(e, "m_bBombTicking").unwrap_or(true);
                let was = self.c4_ticking.insert(idx, ticking).unwrap_or(true);
                if was && !ticking {
                    let defusing = p_u64(e, "m_hBombDefuser")
                        .and_then(|h| self.find_by_pawn_handle(ctx, h))
                        .is_some();
                    if !defusing {
                        self.bomb_exploded_frame = self.frame;
                    }
                }
            }
            (K_C4, EntityEvents::Deleted) => {
                self.c4_ticking.remove(&idx);
            }
            _ => {}
        }
    }

    /// Handles a game event on arrival. demoinfocs processes the game events
    /// of a packet before its entity updates, so handlers see the entity state
    /// of the previous tick; in the demo stream they also come first.
    pub fn on_game_event(&mut self, ctx: &Context, ge: &GameEvent) {
        let name = ge.name();
        if !is_handled_event(name) {
            return;
        }
        self.update_tick(ctx);
        if self.entities_this_frame {
            self.late_events += 1;
        }
        let data = ge
            .iter()
            .map(|(k, v)| {
                let v = match v {
                    EventValue::String(s) => EV::S(s.clone()),
                    EventValue::Float(f) => EV::F(*f),
                    EventValue::Int(i) => EV::I(*i as i64),
                    EventValue::Bool(b) => EV::B(*b),
                    EventValue::Byte(b) => EV::I(*b as i64),
                    EventValue::U64(u) => EV::I(*u as i64),
                };
                (k.to_string(), v)
            })
            .collect();
        let ev = QEvent { name: name.to_string(), data };
        let no_players = self.by_userid.is_empty();
        match ev.name.as_str() {
            "round_freeze_end" => self.signals.push(Sig::FreezeEnd),
            "player_falldamage" => {
                self.fall_damage_frame.insert(ev.num("userid"), self.frame);
            }
            "player_death" => {
                if no_players {
                    self.delayed.push(Delayed::Death(ev));
                } else {
                    self.handle_death(ctx, &ev);
                }
            }
            "player_hurt" => self.handle_hurt(ctx, &ev, false),
            "decoy_detonate" => {
                let thrower = self.nade_thrower(ctx, &ev);
                self.signals.push(Sig::DecoyExpired { thrower, entity: ev.num("entityid") });
                self.delayed.push(Delayed::DeleteDecoy(thrower));
            }
            "smokegrenade_expired" => {
                let thrower = self.nade_thrower(ctx, &ev);
                self.signals.push(Sig::SmokeExpired { thrower, entity: ev.num("entityid") });
                self.delete_thrown(thrower, eq::SMOKE);
            }
            "weapon_fire" | "player_disconnect" => {
                if ev.name == "weapon_fire" && no_players {
                    self.delayed.push(Delayed::Fire(ev));
                } else {
                    self.signals.push(Sig::Generic(ev));
                }
            }
            _ => {}
        }
    }

    // -- frame end ---------------------------------------------------------

    fn run_created(&mut self, ctx: &Context) {
        let created = std::mem::take(&mut self.created);
        for c in created {
            match c {
                Created::Controller(idx) => {
                    let Some(e) = ent_by_index(ctx, idx) else { continue };
                    if e.class().name() != "CCSPlayerController" {
                        continue;
                    }
                    let conn = p_u64(e, "m_iConnected");
                    let team = p_u64(e, "m_iTeamNum");
                    let st = self.ctl_state.entry(idx).or_default();
                    st.connected = conn;
                    st.team = team;
                    self.on_connected_changed(e, conn.unwrap_or(0));
                    if let (Some(t), Some(&pid)) = (team, self.by_entity.get(&idx)) {
                        self.players[pid].team = t as u8;
                    }
                }
                Created::Pawn(idx) => {
                    let Some(e) = ent_by_index(ctx, idx) else { continue };
                    if let Some(v) = p_f32(e, "m_flFlashDuration") {
                        self.pawn_flash.insert(idx, v);
                        self.on_flash_duration(e, v);
                    }
                }
                Created::Rules(idx) => {
                    let Some(e) = ent_by_index(ctx, idx) else { continue };
                    let started = p_bool(e, "m_pGameRules.m_bHasMatchStarted");
                    let reason = p_i64(e, "m_pGameRules.m_eRoundWinReason");
                    self.rules_started = started;
                    self.rules_reason = reason;
                    if let Some(s) = started {
                        self.on_match_started(ctx, e, s);
                    }
                    self.on_win_reason(ctx, reason.unwrap_or(0));
                }
                Created::Proj(idx) => {
                    let Some(&pid) = self.active_projs.get(&idx) else { continue };
                    let Some(e) = ent_by_index(ctx, idx) else { continue };
                    if let Some(h) = p_u64(e, "m_hOwnerEntity") {
                        self.projs[pid].owner = self.find_by_pawn_handle(ctx, h);
                    }
                    if let Some(h) = p_u64(e, "m_hThrower") {
                        self.projs[pid].thrower = self.find_by_pawn_handle(ctx, h);
                    }
                }
            }
        }
    }

    fn attacker_weapon_type(&self, wep: Eq, victim_uid: i64) -> Eq {
        if wep == eq::UNKNOWN
            && self.fall_damage_frame.get(&victim_uid).copied().unwrap_or(0) == self.frame
        {
            return eq::WORLD;
        }
        wep
    }

    fn handle_death(&mut self, ctx: &Context, ev: &QEvent) {
        let mut killer = self.player_by_userid32(ev.num("attacker"));
        let victim_uid = ev.num("userid");
        let wep = self.attacker_weapon_type(eq::map_equipment(ev.text("weapon")), victim_uid);
        if killer.is_none() && ev.has("attacker_pawn") {
            killer = self.find_by_pawn_handle(ctx, ev.num("attacker_pawn") as u32 as u64);
        }
        let victim = self.player_by_userid32(victim_uid);
        let weapon = self.equipment_instance(ctx, killer, wep);
        self.signals.push(Sig::Kill { killer, victim, weapon, headshot: ev.flag("headshot") });
    }

    fn handle_hurt(&mut self, ctx: &Context, ev: &QEvent, delayed: bool) {
        let uid = ev.num("userid");
        let victim = self.player_by_userid32(uid);
        let attacker = self.player_by_userid32(ev.num("attacker"));
        let raw = ev.text("weapon");
        let mut wep = eq::map_equipment(raw);
        if !delayed && raw.is_empty() && wep == eq::UNKNOWN {
            self.delayed.push(Delayed::Hurt(ev.clone()));
            return;
        }
        wep = self.attacker_weapon_type(wep, uid);
        if delayed && wep == eq::UNKNOWN {
            wep = if self.bomb_exploded_frame == self.frame { eq::BOMB } else { eq::WORLD };
        }
        let weapon = self.equipment_instance(ctx, attacker, wep);
        self.signals.push(Sig::Hurt {
            victim,
            attacker,
            health_damage: ev.num("dmg_health"),
            armor_damage: ev.num("dmg_armor"),
            hitgroup: ev.num("hitgroup"),
            weapon,
        });
    }

    fn nade_thrower(&self, ctx: &Context, ev: &QEvent) -> Option<usize> {
        let mut t = if ev.has("userid") { self.player_by_userid32(ev.num("userid")) } else { None };
        if t.is_none() && ev.has("userid_pawn") {
            t = self.find_by_pawn_handle(ctx, ev.num("userid_pawn") as u32 as u64);
        }
        t
    }

    /// Runs everything demoinfocs does once a demo command has been handled;
    /// the derived events are appended to `signals` in dispatch order.
    pub fn end_frame(&mut self, ctx: &Context) {
        self.update_tick(ctx);
        self.entities_this_frame = false;
        self.run_created(ctx);

        // processFlyingFlashbangs
        if !self.flying.is_empty() {
            if self.flying[0].flashed.is_empty() {
                let f = self.flying[0].exploded_frame;
                if f > 0 && f < self.frame {
                    self.flying.remove(0);
                }
            } else {
                let fl = self.flying.remove(0);
                let attacker = self.projs[fl.proj].thrower;
                for ent in fl.flashed {
                    if let Some(&pid) = self.by_entity.get(&ent) {
                        self.signals.push(Sig::Flashed { player: pid, attacker });
                    }
                }
            }
        }

        // processRoundProgressEvents
        if self.pending_round_start {
            self.pending_round_start = false;
            self.signals.push(Sig::RoundStart);
        }
        if let Some(winner) = self.pending_round_end.take() {
            self.signals.push(Sig::RoundEnd { winner });
        }

        let delayed = std::mem::take(&mut self.delayed);
        for d in delayed {
            match d {
                Delayed::Death(ev) => self.handle_death(ctx, &ev),
                Delayed::Hurt(ev) => self.handle_hurt(ctx, &ev, true),
                Delayed::Fire(ev) => self.signals.push(Sig::Generic(ev)),
                Delayed::DeleteDecoy(t) => self.delete_thrown(t, eq::DECOY),
            }
        }

        self.frame += 1;
    }

    /// Flash duration as `PlayerFlashed.FlashDuration()` reports it, in seconds.
    pub fn flash_duration_seconds(&self, pid: usize) -> f64 {
        let p = &self.players[pid];
        let full = (1_000_000_000f32 * p.flash_duration) as i64;
        let remaining = if self.tick_rate == 0.0 {
            full
        } else {
            let since =
                ((self.tick - p.flash_tick) as f64 / self.tick_rate * 1_000_000_000f64) as i64;
            (full - since).max(0)
        };
        if remaining <= 0 {
            return 0.0;
        }
        (full / 1_000_000_000) as f64 + (full % 1_000_000_000) as f64 / 1e9
    }

    /// Player whose controller entity id equals `id` (the lookup the old Go
    /// parser used for `weapon_fire`).
    pub fn player_by_entity_id(&self, id: i64) -> Option<usize> {
        self.by_userid
            .values()
            .copied()
            .find(|&pid| self.players[pid].has_entity && self.players[pid].entity_id as i64 == id)
    }

    pub fn player_by_userid(&self, raw: i64) -> Option<usize> {
        self.player_by_userid32(raw)
    }
}
