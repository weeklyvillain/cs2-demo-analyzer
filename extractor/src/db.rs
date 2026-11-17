//! SQLite output. The schema is the one the Electron app already reads, so
//! existing match databases and all reader code keep working unchanged.
//!
//! Everything is written in a single transaction with secondary indexes built
//! afterwards; the many small transactions of the Go parser, through a pure-Go
//! SQLite driver, were its largest cost. Writing happens on its own thread so
//! the bulky tables (positions, grenade paths, fire outlines) are stored while
//! the demo is still being parsed.

use crate::model::*;
use crate::post::Score;
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::thread::JoinHandle;

const TABLES: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
	id TEXT PRIMARY KEY,
	map TEXT NOT NULL,
	tick_rate REAL NOT NULL,
	started_at TEXT,
	source TEXT
);
CREATE TABLE IF NOT EXISTS players (
	match_id TEXT NOT NULL,
	steamid TEXT NOT NULL,
	name TEXT NOT NULL,
	team TEXT,
	color TEXT,
	connected_midgame INTEGER DEFAULT 0,
	permanent_disconnect INTEGER DEFAULT 0,
	first_connect_round INTEGER,
	disconnect_round INTEGER,
	PRIMARY KEY(match_id, steamid),
	FOREIGN KEY(match_id) REFERENCES matches(id)
);
CREATE TABLE IF NOT EXISTS rounds (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	start_tick INTEGER NOT NULL,
	freeze_end_tick INTEGER,
	end_tick INTEGER NOT NULL,
	t_wins INTEGER NOT NULL DEFAULT 0,
	ct_wins INTEGER NOT NULL DEFAULT 0,
	winner TEXT,
	PRIMARY KEY(match_id, round_index),
	FOREIGN KEY(match_id) REFERENCES matches(id)
);
CREATE TABLE IF NOT EXISTS events (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	type TEXT NOT NULL,
	start_tick INTEGER NOT NULL,
	end_tick INTEGER,
	actor_steamid TEXT,
	victim_steamid TEXT,
	severity REAL,
	confidence REAL,
	meta_json TEXT,
	FOREIGN KEY(match_id) REFERENCES matches(id)
);
CREATE TABLE IF NOT EXISTS player_scores (
	match_id TEXT NOT NULL,
	steamid TEXT NOT NULL,
	team_kills INTEGER NOT NULL DEFAULT 0,
	team_damage REAL NOT NULL DEFAULT 0,
	team_flash_seconds REAL NOT NULL DEFAULT 0,
	afk_seconds REAL NOT NULL DEFAULT 0,
	body_block_seconds REAL NOT NULL DEFAULT 0,
	economy_grief_count INTEGER NOT NULL DEFAULT 0,
	grief_score REAL NOT NULL DEFAULT 0,
	PRIMARY KEY(match_id, steamid),
	FOREIGN KEY(match_id) REFERENCES matches(id)
);
CREATE TABLE IF NOT EXISTS chat_messages (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	tick INTEGER NOT NULL,
	steamid TEXT NOT NULL,
	name TEXT,
	team TEXT,
	message TEXT NOT NULL,
	is_team_chat INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY(match_id, tick, steamid, message),
	FOREIGN KEY(match_id) REFERENCES matches(id),
	FOREIGN KEY(match_id, steamid) REFERENCES players(match_id, steamid)
);
CREATE TABLE IF NOT EXISTS player_positions (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	tick INTEGER NOT NULL,
	steamid TEXT NOT NULL,
	x REAL NOT NULL,
	y REAL NOT NULL,
	z REAL NOT NULL,
	yaw REAL,
	view_dir_x REAL,
	view_dir_y REAL,
	team TEXT,
	health INTEGER,
	armor INTEGER,
	weapon TEXT,
	PRIMARY KEY(match_id, round_index, tick, steamid),
	FOREIGN KEY(match_id) REFERENCES matches(id),
	FOREIGN KEY(match_id, steamid) REFERENCES players(match_id, steamid)
);
CREATE TABLE IF NOT EXISTS grenade_positions (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	tick INTEGER NOT NULL,
	projectile_id INTEGER NOT NULL,
	grenade_name TEXT NOT NULL,
	x REAL NOT NULL,
	y REAL NOT NULL,
	z REAL NOT NULL,
	thrower_steamid TEXT,
	thrower_name TEXT,
	thrower_team TEXT,
	PRIMARY KEY(match_id, round_index, tick, projectile_id),
	FOREIGN KEY(match_id) REFERENCES matches(id)
);
CREATE TABLE IF NOT EXISTS grenade_events (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	tick INTEGER NOT NULL,
	event_type TEXT NOT NULL,
	projectile_id INTEGER NOT NULL,
	grenade_name TEXT NOT NULL,
	x REAL NOT NULL,
	y REAL NOT NULL,
	z REAL NOT NULL,
	thrower_steamid TEXT,
	thrower_name TEXT,
	thrower_team TEXT,
	FOREIGN KEY(match_id) REFERENCES matches(id)
);
CREATE TABLE IF NOT EXISTS shots (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	tick INTEGER NOT NULL,
	steamid TEXT NOT NULL,
	weapon_name TEXT NOT NULL,
	x REAL NOT NULL,
	y REAL NOT NULL,
	z REAL NOT NULL,
	yaw REAL NOT NULL,
	pitch REAL,
	team TEXT,
	FOREIGN KEY(match_id) REFERENCES matches(id),
	FOREIGN KEY(match_id, steamid) REFERENCES players(match_id, steamid)
);
CREATE TABLE IF NOT EXISTS parser_logs (
	match_id TEXT PRIMARY KEY,
	logs TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY(match_id) REFERENCES matches(id)
);
CREATE TABLE IF NOT EXISTS inferno_positions (
	tick INTEGER NOT NULL,
	entity_id INTEGER NOT NULL,
	polygon TEXT NOT NULL,
	thrower_steam_id TEXT,
	thrower_name TEXT,
	thrower_team TEXT,
	PRIMARY KEY(tick, entity_id)
);
"#;

const INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_rounds_match_round ON rounds(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_steamid);
CREATE INDEX IF NOT EXISTS idx_events_victim ON events(victim_steamid);
CREATE INDEX IF NOT EXISTS idx_events_start_tick ON events(start_tick);
CREATE INDEX IF NOT EXISTS idx_events_match_round ON events(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_player_scores_match ON player_scores(match_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_match ON chat_messages(match_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_steamid ON chat_messages(match_id, steamid);
CREATE INDEX IF NOT EXISTS idx_chat_messages_round ON chat_messages(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_chat_messages_tick ON chat_messages(match_id, tick);
CREATE INDEX IF NOT EXISTS idx_player_positions_match_round ON player_positions(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_player_positions_tick ON player_positions(match_id, round_index, tick);
CREATE INDEX IF NOT EXISTS idx_grenade_positions_match_round ON grenade_positions(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_grenade_positions_tick ON grenade_positions(match_id, round_index, tick);
CREATE INDEX IF NOT EXISTS idx_grenade_events_match_round ON grenade_events(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_grenade_events_tick ON grenade_events(match_id, round_index, tick);
CREATE INDEX IF NOT EXISTS idx_grenade_events_type ON grenade_events(event_type);
CREATE INDEX IF NOT EXISTS idx_shots_match_round ON shots(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_shots_tick ON shots(match_id, round_index, tick);
CREATE INDEX IF NOT EXISTS idx_shots_steamid ON shots(match_id, steamid);
CREATE INDEX IF NOT EXISTS idx_parser_logs_match ON parser_logs(match_id);
CREATE INDEX IF NOT EXISTS idx_inferno_positions_tick ON inferno_positions(tick);
CREATE INDEX IF NOT EXISTS idx_inferno_positions_entity ON inferno_positions(entity_id);
"#;

/// Rows handed to the writer thread.
pub enum Msg {
    Positions(Vec<Position>),
    Grenades(Vec<GrenadePos>),
    Infernos(Vec<InfernoPos>),
    /// Everything that is only known once parsing is done; ends the stream.
    Finish(Box<Final>),
}

pub struct Final {
    pub data: MatchData,
    pub scores: Vec<Score>,
    pub demo_path: String,
    pub created_at: String,
}

/// Handle to the writer thread.
pub struct Writer {
    tx: SyncSender<Msg>,
    handle: JoinHandle<Result<()>>,
    path: String,
    created: bool,
}

impl Writer {
    pub fn start(path: &str, match_id: &str) -> Writer {
        let created = !std::path::Path::new(path).exists();
        let (tx, rx) = sync_channel::<Msg>(64);
        let (p, m) = (path.to_string(), match_id.to_string());
        let handle = std::thread::spawn(move || run(&p, &m, rx));
        Writer { tx, handle, path: path.to_string(), created }
    }

    pub fn sender(&self) -> SyncSender<Msg> {
        self.tx.clone()
    }

    /// Sends the final rows and waits for the database to be committed.
    pub fn finish(self, fin: Final) -> Result<()> {
        // A send error means the thread already stopped; its result says why.
        let _ = self.tx.send(Msg::Finish(Box::new(fin)));
        drop(self.tx);
        let result = match self.handle.join() {
            Ok(r) => r,
            Err(_) => Err(anyhow!("database writer crashed")),
        };
        if result.is_err() && self.created {
            let _ = std::fs::remove_file(&self.path);
        }
        result
    }

    /// Stops the writer after a failed parse and removes the half-written
    /// file if this run created it (there is no journal to roll back to).
    pub fn abort(self) {
        drop(self.tx);
        let _ = self.handle.join();
        if self.created {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn run(path: &str, match_id: &str, rx: Receiver<Msg>) -> Result<()> {
    let mut conn = Connection::open(path)?;
    // The file is only useful once the whole match is in it, so durability of
    // intermediate states is not needed: no journal, no fsync per page.
    // Foreign keys are not enforced during the load because the big tables
    // arrive before the match and player rows they refer to; every row is
    // produced for a player that ends up in `players`.
    conn.execute_batch(
        "PRAGMA foreign_keys = OFF;
         PRAGMA journal_mode = OFF;
         PRAGMA synchronous = OFF;
         PRAGMA locking_mode = EXCLUSIVE;
         PRAGMA cache_size = -131072;
         PRAGMA temp_store = MEMORY;",
    )?;
    let tx = conn.transaction()?;
    tx.execute_batch(TABLES)?;

    let fin = {
        let mut positions = tx.prepare(
            "INSERT OR REPLACE INTO player_positions (match_id, round_index, tick, steamid, x, y, z, yaw, view_dir_x, view_dir_y, team, health, armor, weapon) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
        )?;
        let mut grenades = tx.prepare(
            "INSERT OR REPLACE INTO grenade_positions (match_id, round_index, tick, projectile_id, grenade_name, x, y, z, thrower_steamid, thrower_name, thrower_team) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )?;
        let mut infernos = tx.prepare(
            "INSERT OR REPLACE INTO inferno_positions (tick, entity_id, polygon, thrower_steam_id, thrower_name, thrower_team) VALUES (?, ?, ?, ?, ?, ?)",
        )?;
        let mut sids: HashMap<u64, String> = HashMap::new();
        let mut fin = None;
        for msg in rx {
            match msg {
                Msg::Positions(rows) => {
                    for p in &rows {
                        let sid: &String =
                            sids.entry(p.steamid).or_insert_with(|| p.steamid.to_string());
                        positions.execute(params![
                            match_id, p.round, p.tick, sid, p.x, p.y, p.z, p.view_x, p.view_y,
                            p.team, p.health, p.armor, p.weapon
                        ])?;
                    }
                }
                Msg::Grenades(rows) => {
                    for g in &rows {
                        grenades.execute(params![
                            match_id,
                            g.round,
                            g.tick,
                            g.projectile as i64,
                            g.name,
                            g.x,
                            g.y,
                            g.z,
                            g.thrower.steamid,
                            g.thrower.name,
                            g.thrower.team
                        ])?;
                    }
                }
                Msg::Infernos(rows) => {
                    for i in &rows {
                        infernos.execute(params![
                            i.tick,
                            i.entity as i64,
                            i.polygon,
                            i.thrower.steamid,
                            i.thrower.name,
                            i.thrower.team
                        ])?;
                    }
                }
                Msg::Finish(f) => {
                    fin = Some(f);
                    break;
                }
            }
        }
        fin
    };
    let Some(fin) = fin else { bail!("parsing ended before the match was complete") };
    write_final(&tx, match_id, &fin)?;
    tx.execute_batch(INDEXES)?;
    tx.commit()?;
    Ok(())
}

fn write_final(tx: &rusqlite::Transaction, match_id: &str, fin: &Final) -> Result<()> {
    let data = &fin.data;
    tx.execute(
        "INSERT OR REPLACE INTO matches (id, map, tick_rate, started_at, source) VALUES (?, ?, ?, NULL, ?)",
        params![match_id, data.map, data.tick_rate, data.source],
    )?;

    let mut st = tx.prepare(
        "INSERT OR REPLACE INTO players (match_id, steamid, name, team, color, connected_midgame, permanent_disconnect, first_connect_round, disconnect_round) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )?;
    for p in &data.players {
        st.execute(params![
            match_id,
            p.steamid,
            p.name,
            p.team,
            p.color,
            p.connected_midgame as i32,
            p.permanent_disconnect as i32,
            p.first_connect_round,
            p.disconnect_round
        ])?;
    }

    let mut st = tx.prepare(
        "INSERT OR REPLACE INTO rounds (match_id, round_index, start_tick, freeze_end_tick, end_tick, t_wins, ct_wins, winner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )?;
    for r in &data.rounds {
        st.execute(params![
            match_id, r.index, r.start, r.freeze_end, r.end, r.t_wins, r.ct_wins, r.winner
        ])?;
    }

    let mut st = tx.prepare(
        "INSERT INTO events (match_id, round_index, type, start_tick, end_tick, actor_steamid, victim_steamid, severity, confidence, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )?;
    for e in &data.events {
        st.execute(params![
            match_id, e.round, e.typ, e.start, e.end, e.actor, e.victim, e.severity,
            e.confidence, e.meta
        ])?;
    }

    let mut st = tx.prepare(
        "INSERT OR IGNORE INTO chat_messages (match_id, round_index, tick, steamid, name, team, message, is_team_chat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )?;
    for c in &data.chat {
        st.execute(params![
            match_id, c.round, c.tick, c.steamid, c.name, c.team, c.message, c.team_chat as i32
        ])?;
    }

    let mut st = tx.prepare(
        "INSERT INTO grenade_events (match_id, round_index, tick, event_type, projectile_id, grenade_name, x, y, z, thrower_steamid, thrower_name, thrower_team) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )?;
    for g in &data.grenade_events {
        st.execute(params![
            match_id,
            g.round,
            g.tick,
            g.kind,
            g.projectile as i64,
            g.name,
            g.x,
            g.y,
            g.z,
            g.thrower.steamid,
            g.thrower.name,
            g.thrower.team
        ])?;
    }

    let mut st = tx.prepare(
        "INSERT INTO shots (match_id, round_index, tick, steamid, weapon_name, x, y, z, yaw, pitch, team) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    )?;
    for s in &data.shots {
        st.execute(params![
            match_id, s.round, s.tick, s.steamid, s.weapon, s.x, s.y, s.z, s.yaw, s.team
        ])?;
    }

    let mut st = tx.prepare(
        "INSERT OR REPLACE INTO player_scores (match_id, steamid, team_kills, team_damage, team_flash_seconds, afk_seconds, body_block_seconds, economy_grief_count, grief_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )?;
    for s in &fin.scores {
        st.execute(params![
            match_id,
            s.steamid,
            s.team_kills,
            s.team_damage,
            s.team_flash_seconds,
            s.afk_seconds,
            s.body_block_seconds,
            s.economy_grief_count,
            s.grief_score
        ])?;
    }

    let mut st = tx.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")?;
    st.execute(params!["demo_path", fin.demo_path])?;
    if data.build_num > 0 {
        st.execute(params!["build_num", data.build_num.to_string()])?;
    }
    st.execute(params!["created_at_iso", fin.created_at])?;
    st.execute(params!["parsed_at", fin.created_at])?;
    Ok(())
}
