//! Plain data rows produced by the extractor. Field sets match the SQLite
//! schema the Electron app reads.

#[derive(Clone, Debug)]
pub struct Event {
    pub typ: &'static str,
    pub round: i32,
    pub start: i32,
    pub end: Option<i32>,
    pub actor: Option<String>,
    pub victim: Option<String>,
    pub severity: f64,
    pub confidence: f64,
    pub meta: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct PlayerData {
    pub steamid: String,
    pub name: String,
    pub team: String,
    pub color: String,
    pub connected_midgame: bool,
    pub permanent_disconnect: bool,
    pub first_connect_round: Option<i32>,
    pub disconnect_round: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct Round {
    pub index: i32,
    pub start: i32,
    pub freeze_end: Option<i32>,
    pub end: i32,
    pub t_wins: i32,
    pub ct_wins: i32,
    pub winner: Option<&'static str>,
}

#[derive(Clone, Debug)]
pub struct Position {
    pub round: i32,
    pub tick: i32,
    pub steamid: u64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub view_x: Option<f64>,
    pub view_y: Option<f64>,
    pub team: &'static str,
    pub health: Option<i32>,
    pub armor: Option<i32>,
    pub weapon: Option<&'static str>,
}

#[derive(Clone, Debug)]
pub struct Chat {
    pub round: i32,
    pub tick: i32,
    pub steamid: String,
    pub name: Option<String>,
    pub team: Option<String>,
    pub message: String,
    pub team_chat: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Thrower {
    pub steamid: Option<String>,
    pub name: Option<String>,
    pub team: Option<String>,
}

#[derive(Clone, Debug)]
pub struct GrenadePos {
    pub round: i32,
    pub tick: i32,
    pub projectile: u64,
    pub name: &'static str,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub thrower: Thrower,
}

#[derive(Clone, Debug)]
pub struct GrenadeEvent {
    pub round: i32,
    pub tick: i32,
    pub kind: &'static str,
    pub projectile: u64,
    pub name: &'static str,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub thrower: Thrower,
}

#[derive(Clone, Debug)]
pub struct InfernoPos {
    pub tick: i32,
    pub entity: u64,
    pub polygon: String,
    pub thrower: Thrower,
}

#[derive(Clone, Debug)]
pub struct Shot {
    pub round: i32,
    pub tick: i32,
    pub steamid: String,
    pub weapon: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: f64,
    pub team: &'static str,
}

/// Everything extracted from one demo.
#[derive(Default)]
pub struct MatchData {
    pub map: String,
    pub tick_rate: f64,
    pub source: String,
    pub build_num: i32,
    pub players: Vec<PlayerData>,
    pub rounds: Vec<Round>,
    pub events: Vec<Event>,
    pub chat: Vec<Chat>,
    pub positions: Vec<Position>,
    pub grenade_events: Vec<GrenadeEvent>,
    pub shots: Vec<Shot>,
    /// Grenade path samples; like fire outlines these are streamed to the
    /// database writer while parsing, so only their number is kept.
    pub grenade_position_count: usize,
}
