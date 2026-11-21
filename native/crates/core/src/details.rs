//! Per-match detail rows: roster, events and chat (the Players, Rounds and Chat tabs).

use rusqlite::Connection;
use serde::Serialize;

use crate::disconnect;

/// A player from the `players` table joined with their scores (zeros when unscored),
/// like the Electron Players tab's `allPlayersWithScores`.
#[derive(Debug, Clone, Serialize)]
pub struct RosterPlayer {
    pub steamid: String,
    pub name: String,
    /// Stable team, `A` or `B` (not the side).
    pub team: Option<String>,
    /// In-game color name (yellow, purple, green, blue, orange).
    pub color: Option<String>,
    pub connected_midgame: bool,
    pub permanent_disconnect: bool,
    pub first_connect_round: Option<i64>,
    pub disconnect_round: Option<i64>,
    pub team_kills: i64,
    pub team_damage: f64,
    pub team_flash_seconds: f64,
    pub afk_seconds: f64,
    pub grief_score: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchEvent {
    pub round_index: i64,
    pub kind: String,
    pub start_tick: i64,
    pub end_tick: Option<i64>,
    pub actor: Option<String>,
    pub victim: Option<String>,
    pub meta: serde_json::Value,
}

impl MatchEvent {
    /// A numeric meta field. Like JS `meta.x || …`, zero counts as missing.
    pub fn meta_num(&self, key: &str) -> Option<f64> {
        self.meta.get(key).and_then(|v| v.as_f64()).filter(|v| *v != 0.0)
    }

    pub fn meta_str(&self, key: &str) -> Option<&str> {
        self.meta.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
    }

    pub fn meta_bool(&self, key: &str) -> bool {
        self.meta.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
    }

    /// `meta.weapon` as text; arrays are joined with ", ".
    pub fn weapon(&self) -> Option<String> {
        match self.meta.get("weapon")? {
            serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
            serde_json::Value::Array(a) if !a.is_empty() => Some(
                a.iter()
                    .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string))
                    .collect::<Vec<_>>()
                    .join(", "),
            ),
            _ => None,
        }
    }

    /// AFK length in seconds: `meta.seconds`, `meta.afkDuration`, else the tick span.
    pub fn afk_seconds(&self, tick_rate: f64) -> f64 {
        self.meta_num("seconds")
            .or_else(|| self.meta_num("afkDuration"))
            .unwrap_or_else(|| match self.end_tick {
                Some(end) if end != 0 && self.start_tick != 0 => (end - self.start_tick) as f64 / tick_rate,
                _ => 0.0,
            })
    }

    /// Damage of a TEAM_DAMAGE event (`total_damage`, older parsers wrote `damage`).
    pub fn damage(&self) -> f64 {
        self.meta
            .get("total_damage")
            .or_else(|| self.meta.get("damage"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub round_index: i64,
    pub tick: i64,
    pub steamid: String,
    pub name: Option<String>,
    pub team: Option<String>,
    /// Disconnect messages get the reason appended, as in the Electron app.
    pub message: String,
    pub is_team_chat: bool,
}

pub fn roster(conn: &Connection, match_id: &str) -> rusqlite::Result<Vec<RosterPlayer>> {
    let mut stmt = conn.prepare(
        "SELECT p.steamid, COALESCE(NULLIF(p.name, ''), p.steamid), p.team, p.color,
                COALESCE(p.connected_midgame, 0), COALESCE(p.permanent_disconnect, 0),
                p.first_connect_round, p.disconnect_round,
                COALESCE(ps.team_kills, 0), COALESCE(ps.team_damage, 0),
                COALESCE(ps.team_flash_seconds, 0), COALESCE(ps.afk_seconds, 0),
                COALESCE(ps.grief_score, 0)
         FROM players p
         LEFT JOIN player_scores ps ON ps.match_id = p.match_id AND ps.steamid = p.steamid
         WHERE p.match_id = ?1",
    )?;
    stmt.query_map([match_id], |r| {
        Ok(RosterPlayer {
            steamid: r.get(0)?,
            name: r.get(1)?,
            team: r.get(2)?,
            color: r.get(3)?,
            connected_midgame: r.get::<_, i64>(4)? != 0,
            permanent_disconnect: r.get::<_, i64>(5)? != 0,
            first_connect_round: r.get(6)?,
            disconnect_round: r.get(7)?,
            team_kills: r.get(8)?,
            team_damage: r.get(9)?,
            team_flash_seconds: r.get(10)?,
            afk_seconds: r.get(11)?,
            grief_score: r.get(12)?,
        })
    })?
    .collect()
}

pub fn events(conn: &Connection, match_id: &str) -> rusqlite::Result<Vec<MatchEvent>> {
    let mut stmt = conn.prepare(
        "SELECT round_index, type, start_tick, end_tick, actor_steamid, victim_steamid, meta_json
         FROM events WHERE match_id = ?1 ORDER BY start_tick",
    )?;
    stmt.query_map([match_id], |r| {
        let meta: Option<String> = r.get(6)?;
        Ok(MatchEvent {
            round_index: r.get(0)?,
            kind: r.get(1)?,
            start_tick: r.get(2)?,
            end_tick: r.get(3)?,
            actor: r.get(4)?,
            victim: r.get(5)?,
            meta: meta
                .and_then(|m| serde_json::from_str(&m).ok())
                .unwrap_or(serde_json::Value::Null),
        })
    })?
    .collect()
}

pub fn chat(conn: &Connection, match_id: &str, events: &[MatchEvent]) -> rusqlite::Result<Vec<ChatMessage>> {
    let mut stmt = conn.prepare(
        "SELECT round_index, tick, steamid, name, team, message, is_team_chat
         FROM chat_messages WHERE match_id = ?1 ORDER BY tick",
    )?;
    let mut messages = stmt
        .query_map([match_id], |r| {
            Ok(ChatMessage {
                round_index: r.get(0)?,
                tick: r.get(1)?,
                steamid: r.get(2)?,
                name: r.get(3)?,
                team: r.get(4)?,
                message: r.get(5)?,
                is_team_chat: r.get::<_, i64>(6)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for msg in &mut messages {
        enrich_disconnect(msg, events);
    }
    Ok(messages)
}

/// Append the reason of the closest DISCONNECT event (same player, within 500 ticks)
/// to "left the game" / "disconnected" messages.
fn enrich_disconnect(msg: &mut ChatMessage, events: &[MatchEvent]) {
    let lower = msg.message.to_lowercase();
    if !(lower.contains("left the game") || lower.contains("disconnect")) || msg.steamid.is_empty() {
        return;
    }
    let closest = events
        .iter()
        .filter(|e| e.kind == "DISCONNECT" && e.actor.as_deref() == Some(msg.steamid.as_str()))
        .map(|e| ((e.start_tick - msg.tick).abs(), e))
        .filter(|(diff, _)| *diff <= 500)
        .min_by_key(|(diff, _)| *diff);
    if let Some((_, event)) = closest {
        if let Some(reason) = event.meta.get("reason").filter(|r| !r.is_null()) {
            msg.message = format!("{} ({})", msg.message, disconnect::format_reason(reason));
        }
    }
}
