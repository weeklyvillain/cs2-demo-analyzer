//! Data for the 2D replay (Electron `matches:positionsForRound`, `grenadePositionsForRound`,
//! `grenadeEventsForRound`, `infernoPositionsForRound`, `shotsForRound`): one round at a
//! time, read-only, through the `(match_id, round_index, tick)` indexes.

use std::sync::Arc;

use anyhow::Result;
use rusqlite::Connection;

use crate::matches::open_match;
use crate::paths;

/// A round with its freeze-time end (the summary's `Round` leaves it out).
#[derive(Debug, Clone)]
pub struct ReplayRound {
    pub index: i64,
    pub start_tick: i64,
    pub freeze_end_tick: Option<i64>,
    pub end_tick: i64,
    pub t_wins: i64,
    pub ct_wins: i64,
    pub winner: Option<String>,
}

/// One player sample. `player` indexes [`RoundData::players`]; strings are shared.
#[derive(Debug, Clone)]
pub struct PositionSample {
    pub tick: i64,
    pub player: u16,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: Option<f32>,
    /// Side this sample: `T`, `CT` or none.
    pub team: Option<Arc<str>>,
    pub health: Option<i32>,
    pub armor: Option<i32>,
    pub weapon: Option<Arc<str>>,
}

#[derive(Debug, Clone)]
pub struct ReplayPlayer {
    pub steamid: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GrenadePosition {
    pub tick: i64,
    pub projectile_id: i64,
    pub grenade_name: Arc<str>,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub thrower_steamid: Option<Arc<str>>,
    pub thrower_team: Option<Arc<str>>,
}

#[derive(Debug, Clone)]
pub struct GrenadeEvent {
    pub tick: i64,
    pub event_type: String,
    pub projectile_id: i64,
    pub grenade_name: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub thrower_steamid: Option<String>,
    pub thrower_team: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InfernoSample {
    pub tick: i64,
    pub entity_id: i64,
    pub polygon: Vec<(f32, f32)>,
}

#[derive(Debug, Clone)]
pub struct Shot {
    pub tick: i64,
    pub steamid: String,
    pub x: f32,
    pub y: f32,
    pub yaw: f32,
}

/// Everything the replay draws for one round.
#[derive(Debug, Clone, Default)]
pub struct RoundData {
    pub round_index: i64,
    pub players: Vec<ReplayPlayer>,
    /// Sorted by tick.
    pub positions: Vec<PositionSample>,
    pub grenade_positions: Vec<GrenadePosition>,
    pub grenade_events: Vec<GrenadeEvent>,
    pub infernos: Vec<InfernoSample>,
    pub shots: Vec<Shot>,
}

pub fn rounds(match_id: &str) -> Result<Vec<ReplayRound>> {
    let conn = open_match(&paths::match_db(match_id))?;
    let mut stmt = conn.prepare(
        "SELECT round_index, start_tick, freeze_end_tick, end_tick, t_wins, ct_wins, winner
         FROM rounds WHERE match_id = ?1 ORDER BY round_index",
    )?;
    let rows = stmt
        .query_map([match_id], |r| {
            Ok(ReplayRound {
                index: r.get(0)?,
                start_tick: r.get(1)?,
                freeze_end_tick: r.get(2)?,
                end_tick: r.get(3)?,
                t_wins: r.get(4)?,
                ct_wins: r.get(5)?,
                winner: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Interns repeated strings (teams, weapons, grenade names) so samples share them.
#[derive(Default)]
struct Interner(std::collections::HashMap<String, Arc<str>>);

impl Interner {
    fn get(&mut self, s: Option<String>) -> Option<Arc<str>> {
        let s = s?;
        if let Some(a) = self.0.get(&s) {
            return Some(a.clone());
        }
        let a: Arc<str> = Arc::from(s.as_str());
        self.0.insert(s, a.clone());
        Some(a)
    }
}

/// Load one round. `start_tick..=end_tick` bounds the inferno query, which has no round column.
pub fn round_data(match_id: &str, round_index: i64, start_tick: i64, end_tick: i64) -> Result<RoundData> {
    let conn = open_match(&paths::match_db(match_id))?;
    load(&conn, match_id, round_index, start_tick, end_tick)
}

fn load(conn: &Connection, match_id: &str, round: i64, start: i64, end: i64) -> Result<RoundData> {
    let mut strings = Interner::default();
    let mut players: Vec<ReplayPlayer> = Vec::new();
    let mut player_index: std::collections::HashMap<String, u16> = std::collections::HashMap::new();

    let mut positions = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT pp.tick, pp.steamid, pp.x, pp.y, pp.z, pp.yaw, pp.team, pp.health, pp.armor, pp.weapon, p.name
         FROM player_positions pp
         LEFT JOIN players p ON pp.match_id = p.match_id AND pp.steamid = p.steamid
         WHERE pp.match_id = ?1 AND pp.round_index = ?2
         ORDER BY pp.tick ASC, pp.steamid ASC",
    )?;
    let mut rows = stmt.query(rusqlite::params![match_id, round])?;
    while let Some(r) = rows.next()? {
        let steamid: String = r.get(1)?;
        let player = match player_index.get(&steamid) {
            Some(i) => *i,
            None => {
                let i = players.len() as u16;
                players.push(ReplayPlayer { steamid: steamid.clone(), name: r.get(10)? });
                player_index.insert(steamid, i);
                i
            }
        };
        positions.push(PositionSample {
            tick: r.get(0)?,
            player,
            x: r.get::<_, f64>(2)? as f32,
            y: r.get::<_, f64>(3)? as f32,
            z: r.get::<_, f64>(4)? as f32,
            yaw: r.get::<_, Option<f64>>(5)?.map(|v| v as f32),
            team: strings.get(r.get(6)?),
            health: r.get(7)?,
            armor: r.get(8)?,
            weapon: strings.get(r.get(9)?),
        });
    }
    drop(rows);
    drop(stmt);

    let mut stmt = conn.prepare(
        "SELECT tick, projectile_id, grenade_name, x, y, z, thrower_steamid, thrower_team
         FROM grenade_positions WHERE match_id = ?1 AND round_index = ?2
         ORDER BY tick ASC, projectile_id ASC",
    )?;
    let mut grenade_positions = Vec::new();
    let mut rows = stmt.query(rusqlite::params![match_id, round])?;
    while let Some(r) = rows.next()? {
        grenade_positions.push(GrenadePosition {
            tick: r.get(0)?,
            projectile_id: r.get(1)?,
            grenade_name: strings.get(r.get(2)?).unwrap_or_else(|| Arc::from("")),
            x: r.get::<_, f64>(3)? as f32,
            y: r.get::<_, f64>(4)? as f32,
            z: r.get::<_, f64>(5)? as f32,
            thrower_steamid: strings.get(r.get(6)?),
            thrower_team: strings.get(r.get(7)?),
        });
    }
    drop(rows);
    drop(stmt);

    let mut stmt = conn.prepare(
        "SELECT tick, event_type, projectile_id, grenade_name, x, y, z, thrower_steamid, thrower_team
         FROM grenade_events WHERE match_id = ?1 AND round_index = ?2 ORDER BY tick ASC",
    )?;
    let grenade_events = stmt
        .query_map(rusqlite::params![match_id, round], |r| {
            Ok(GrenadeEvent {
                tick: r.get(0)?,
                event_type: r.get(1)?,
                projectile_id: r.get(2)?,
                grenade_name: r.get(3)?,
                x: r.get::<_, f64>(4)? as f32,
                y: r.get::<_, f64>(5)? as f32,
                z: r.get::<_, f64>(6)? as f32,
                thrower_steamid: r.get(7)?,
                thrower_team: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    // Older databases have no inferno table; that just means no fire polygons.
    let infernos = conn
        .prepare(
            "SELECT tick, entity_id, polygon FROM inferno_positions
             WHERE tick BETWEEN ?1 AND ?2 ORDER BY tick, entity_id",
        )
        .and_then(|mut stmt| {
            stmt.query_map(rusqlite::params![start, end], |r| {
                let polygon: String = r.get(2)?;
                let points: Vec<[f64; 2]> = serde_json::from_str(&polygon).unwrap_or_default();
                Ok(InfernoSample {
                    tick: r.get(0)?,
                    entity_id: r.get(1)?,
                    polygon: points.into_iter().map(|[x, y]| (x as f32, y as f32)).collect(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default();

    let shots = conn
        .prepare(
            "SELECT tick, steamid, x, y, yaw FROM shots
             WHERE match_id = ?1 AND round_index = ?2 ORDER BY tick ASC",
        )
        .and_then(|mut stmt| {
            stmt.query_map(rusqlite::params![match_id, round], |r| {
                Ok(Shot {
                    tick: r.get(0)?,
                    steamid: r.get(1)?,
                    x: r.get::<_, f64>(2)? as f32,
                    y: r.get::<_, f64>(3)? as f32,
                    yaw: r.get::<_, f64>(4)? as f32,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default();

    Ok(RoundData {
        round_index: round,
        players,
        positions,
        grenade_positions,
        grenade_events,
        infernos,
        shots,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_a_round_from_a_real_match() {
        let Ok(matches) = crate::matches::list_matches() else { return };
        let Some(m) = matches.iter().find(|m| m.player_count >= 10) else { return };
        let rounds = rounds(&m.id).unwrap();
        assert!(!rounds.is_empty());
        let r = &rounds[rounds.len() / 2];
        let t = std::time::Instant::now();
        let data = round_data(&m.id, r.index, r.start_tick, r.end_tick).unwrap();
        println!(
            "{} round {}: {} samples, {} players, {} grenade pts, {} grenade events, {} inferno, {} shots in {} ms",
            m.id,
            r.index,
            data.positions.len(),
            data.players.len(),
            data.grenade_positions.len(),
            data.grenade_events.len(),
            data.infernos.len(),
            data.shots.len(),
            t.elapsed().as_millis()
        );
        assert!(!data.positions.is_empty());
        assert!(data.positions.windows(2).all(|w| w[0].tick <= w[1].tick));
        assert!(data.players.len() >= 2);
    }
}
