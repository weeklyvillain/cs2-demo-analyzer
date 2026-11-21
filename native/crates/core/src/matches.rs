use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use crate::paths;

/// One row of the match list.
#[derive(Debug, Clone, Serialize)]
pub struct MatchInfo {
    pub id: String,
    pub map: String,
    pub started_at: Option<String>,
    pub player_count: u32,
    pub demo_path: Option<PathBuf>,
    pub is_missing_demo: bool,
    pub created_at_iso: Option<String>,
    pub source: Option<String>,
    pub build_num: Option<u32>,
    pub round_count: u32,
    /// First round start to last round end, in seconds (64 tick, like the Electron app).
    pub duration_secs: f64,
    /// Final score from the last round: `t_wins` / `ct_wins`, shown as Team A / Team B.
    pub team_a_wins: i64,
    pub team_b_wins: i64,
}

/// Match-wide totals, computed the same way as the Electron app's match stats.
#[derive(Debug, Clone, Default, Serialize)]
pub struct MatchTotals {
    pub team_kills: i64,
    /// Sum of `meta.damage` over TEAM_DAMAGE events.
    pub team_damage: f64,
    /// Sum of `meta.blind_duration` over TEAM_FLASH events.
    pub team_flash_seconds: f64,
    pub afk_seconds: f64,
    pub body_block_seconds: f64,
    pub disconnects: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerScore {
    pub steamid: String,
    pub name: String,
    pub team: Option<String>,
    pub team_kills: i64,
    pub team_damage: f64,
    pub team_flash_seconds: f64,
    pub afk_seconds: f64,
    pub body_block_seconds: f64,
    pub economy_grief_count: i64,
    pub grief_score: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Round {
    pub index: i64,
    pub start_tick: i64,
    pub freeze_end_tick: Option<i64>,
    pub end_tick: i64,
    pub t_wins: i64,
    pub ct_wins: i64,
    pub winner: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchSummary {
    pub info: MatchInfo,
    pub tick_rate: f64,
    pub players: Vec<PlayerScore>,
    pub rounds: Vec<Round>,
    /// Event count per event type (team_kill, team_flash, afk, ...).
    pub event_counts: Vec<(String, i64)>,
    pub totals: MatchTotals,
    pub roster: Vec<crate::RosterPlayer>,
    pub events: Vec<crate::MatchEvent>,
    pub chat: Vec<crate::ChatMessage>,
}

impl MatchSummary {
    pub fn player_name<'a>(&'a self, steamid: &'a str) -> &'a str {
        self.roster
            .iter()
            .find(|p| p.steamid == steamid)
            .map_or(steamid, |p| p.name.as_str())
    }
}

/// Open a match database read-only. Only the pages a query touches are read,
/// so this is cheap even for 100 MB files.
pub fn open_match(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("opening {}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_millis(500))?;
    Ok(conn)
}

fn meta_map(conn: &Connection) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT key, value FROM meta") {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            out.extend(rows.flatten());
        }
    }
    out
}

fn load_info(conn: &Connection, match_id: &str) -> Result<Option<MatchInfo>> {
    let meta = meta_map(conn);

    // `source` was added later; older databases don't have the column.
    let row = conn
        .query_row(
            "SELECT map, started_at, source FROM matches WHERE id = ?1",
            [match_id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .or_else(|_| {
            conn.query_row(
                "SELECT map, started_at, NULL FROM matches WHERE id = ?1",
                [match_id],
                |r| Ok((r.get::<_, Option<String>>(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
        })?;
    let Some((map, started_at, source)) = row else {
        return Ok(None);
    };

    let player_count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM players WHERE match_id = ?1",
        [match_id],
        |r| r.get(0),
    )?;

    let (round_count, first_start, last_end): (u32, Option<i64>, Option<i64>) = conn.query_row(
        "SELECT COUNT(*), MIN(start_tick), MAX(end_tick) FROM rounds WHERE match_id = ?1",
        [match_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let (team_a_wins, team_b_wins): (i64, i64) = conn
        .query_row(
            "SELECT t_wins, ct_wins FROM rounds WHERE match_id = ?1 ORDER BY round_index DESC LIMIT 1",
            [match_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .unwrap_or((0, 0));
    let duration_secs = match (first_start, last_end) {
        (Some(s), Some(e)) if e > s => (e - s) as f64 / 64.0,
        _ => 0.0,
    };

    let demo_path = meta.get("demo_path").filter(|p| !p.is_empty()).map(PathBuf::from);
    let is_missing_demo = demo_path.as_ref().is_none_or(|p| !p.exists());

    Ok(Some(MatchInfo {
        id: match_id.to_string(),
        map: map.unwrap_or_else(|| match_id.to_string()),
        started_at,
        player_count,
        demo_path,
        is_missing_demo,
        created_at_iso: meta.get("created_at_iso").cloned(),
        source,
        build_num: meta.get("build_num").and_then(|b| b.parse().ok()),
        round_count,
        duration_secs,
        team_a_wins,
        team_b_wins,
    }))
}

/// All parsed matches, newest first. Unreadable databases are skipped.
pub fn list_matches() -> Result<Vec<MatchInfo>> {
    list_matches_in(&paths::matches_dir())
}

pub fn list_matches_in(dir: &Path) -> Result<Vec<MatchInfo>> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(Vec::new());
    };
    let files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "sqlite"))
        .collect();

    // Opening a database and reading a few rows takes well under a millisecond,
    // but it's still I/O; spread it over a few threads for big libraries.
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let chunk = files.len().div_ceil(threads).max(1);
    let mut matches: Vec<MatchInfo> = std::thread::scope(|s| {
        let handles: Vec<_> = files
            .chunks(chunk)
            .map(|chunk| {
                s.spawn(move || {
                    chunk
                        .iter()
                        .filter_map(|path| {
                            let id = path.file_stem()?.to_str()?.to_string();
                            let conn = open_match(path).ok()?;
                            load_info(&conn, &id).ok().flatten()
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });

    matches.sort_by(|a, b| {
        let key = |m: &MatchInfo| m.created_at_iso.clone().or_else(|| m.started_at.clone());
        key(b).cmp(&key(a)).then_with(|| b.id.cmp(&a.id))
    });
    Ok(matches)
}

pub fn match_summary(match_id: &str) -> Result<MatchSummary> {
    let conn = open_match(&paths::match_db(match_id))?;
    let info = load_info(&conn, match_id)?.context("match row missing")?;
    let tick_rate: f64 = conn
        .query_row("SELECT tick_rate FROM matches WHERE id = ?1", [match_id], |r| r.get(0))
        .unwrap_or(64.0);

    let mut stmt = conn.prepare(
        "SELECT ps.steamid, COALESCE(p.name, ps.steamid), p.team, ps.team_kills, ps.team_damage,
                ps.team_flash_seconds, ps.afk_seconds, ps.body_block_seconds,
                ps.economy_grief_count, ps.grief_score
         FROM player_scores ps
         LEFT JOIN players p ON ps.match_id = p.match_id AND ps.steamid = p.steamid
         WHERE ps.match_id = ?1
         ORDER BY ps.grief_score DESC",
    )?;
    let players = stmt
        .query_map([match_id], |r| {
            Ok(PlayerScore {
                steamid: r.get(0)?,
                name: r.get(1)?,
                team: r.get(2)?,
                team_kills: r.get(3)?,
                team_damage: r.get(4)?,
                team_flash_seconds: r.get(5)?,
                afk_seconds: r.get(6)?,
                body_block_seconds: r.get(7)?,
                economy_grief_count: r.get(8)?,
                grief_score: r.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut stmt = conn.prepare(
        "SELECT round_index, start_tick, end_tick, t_wins, ct_wins, winner, freeze_end_tick
         FROM rounds WHERE match_id = ?1 ORDER BY round_index",
    )?;
    let rounds = stmt
        .query_map([match_id], |r| {
            Ok(Round {
                index: r.get(0)?,
                start_tick: r.get(1)?,
                freeze_end_tick: r.get(6)?,
                end_tick: r.get(2)?,
                t_wins: r.get(3)?,
                ct_wins: r.get(4)?,
                winner: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut stmt = conn.prepare(
        "SELECT type, COUNT(*) FROM events WHERE match_id = ?1 GROUP BY type ORDER BY 2 DESC",
    )?;
    let event_counts: Vec<(String, i64)> = stmt
        .query_map([match_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let count = |kind: &str| event_counts.iter().find(|(k, _)| k == kind).map_or(0, |(_, n)| *n);
    // `fields` are tried in order per event (parser versions used different keys).
    let meta_sum = |kind: &str, fields: &[&str]| -> f64 {
        let value = fields
            .iter()
            .map(|f| format!("json_extract(meta_json, '$.{f}')"))
            .collect::<Vec<_>>()
            .join(", ");
        conn.query_row(
            &format!(
                "SELECT COALESCE(SUM(COALESCE({value}, 0)), 0)
                 FROM events WHERE match_id = ?1 AND type = ?2 AND json_valid(meta_json)"
            ),
            [match_id, kind],
            |r| r.get(0),
        )
        .unwrap_or(0.0)
    };
    let totals = MatchTotals {
        team_kills: count("TEAM_KILL"),
        team_damage: meta_sum("TEAM_DAMAGE", &["total_damage", "damage"]),
        team_flash_seconds: meta_sum("TEAM_FLASH", &["blind_duration"]),
        afk_seconds: players.iter().map(|p| p.afk_seconds).sum(),
        body_block_seconds: players.iter().map(|p| p.body_block_seconds).sum(),
        disconnects: count("DISCONNECT"),
    };

    let roster = crate::details::roster(&conn, match_id)?;
    let events = crate::details::events(&conn, match_id)?;
    let chat = crate::details::chat(&conn, match_id, &events)?;

    Ok(MatchSummary { info, tick_rate, players, rounds, event_counts, totals, roster, events, chat })
}

/// Electron's `performStartupIntegrityCheck`: delete databases that can't be read, and (when
/// `auto_cleanup_missing_demos` is on, the default) ones whose demo file is gone.
/// Returns `(match_id, reason)` for each deleted database.
pub fn startup_integrity_check() -> Vec<(String, &'static str)> {
    let auto_cleanup = crate::settings::Settings::open()
        .map(|s| s.get_bool("auto_cleanup_missing_demos", true))
        .unwrap_or(true);
    let Ok(entries) = std::fs::read_dir(paths::matches_dir()) else { return Vec::new() };
    let mut deleted = Vec::new();
    for path in entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "sqlite")) {
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
        // Corrupt = SQLite can't read the file at all. A locked file (another app is writing
        // it) is skipped, and a missing `meta` table just means no demo path, like Electron.
        let readable = open_match(&path).map_err(|e| e.to_string()).and_then(|conn| {
            conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
                .map(|_| conn)
                .map_err(|e| e.to_string())
        });
        let reason = match readable {
            Err(e) if e.contains("locked") || e.contains("busy") => None,
            Err(_) => Some("corrupt database"),
            Ok(conn) => {
                let demo: Option<String> = conn
                    .query_row("SELECT value FROM meta WHERE key = 'demo_path'", [], |r| r.get(0))
                    .ok()
                    .filter(|d: &String| !d.is_empty());
                let missing = !demo.is_some_and(|d| Path::new(&d).exists());
                (auto_cleanup && missing).then_some("missing demo file")
            }
        };
        if let Some(reason) = reason {
            if std::fs::remove_file(&path).is_ok() {
                deleted.push((id, reason));
            }
        }
    }
    deleted
}

/// Delete these matches' databases (Electron `deleteMatches`). Returns how many were removed.
pub fn delete_matches(ids: &[String]) -> usize {
    ids.iter()
        .filter(|id| !id.contains(['/', '\\']) && !id.contains(".."))
        .filter(|id| std::fs::remove_file(paths::match_db(id)).is_ok())
        .count()
}

/// The parser output stored for a match (Electron `matches:parserLogs`).
pub fn parser_logs(match_id: &str) -> Result<Option<String>> {
    let conn = open_match(&paths::match_db(match_id))?;
    Ok(conn
        .query_row("SELECT logs FROM parser_logs WHERE match_id = ?1", [match_id], |r| r.get(0))
        .optional()?)
}

/// Delete every match database (and `demo_paths.json`), like Electron's `deleteAllMatches`.
/// Returns how many databases were deleted.
pub fn delete_all_matches() -> usize {
    let dir = paths::matches_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else { return 0 };
    let deleted = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "sqlite"))
        .filter(|p| std::fs::remove_file(p).is_ok())
        .count();
    let _ = std::fs::remove_file(dir.join("demo_paths.json"));
    deleted
}

/// Delete the oldest matches until at most `cap` remain (Electron `trimMatchesToCap`).
/// Returns the deleted match IDs.
pub fn trim_to_cap(cap: usize) -> Result<Vec<String>> {
    let mut matches = list_matches()?;
    if matches.len() <= cap {
        return Ok(Vec::new());
    }
    let key = |m: &MatchInfo| m.created_at_iso.clone().or_else(|| m.started_at.clone());
    matches.sort_by(|a, b| key(a).cmp(&key(b)).then_with(|| a.id.cmp(&b.id)));
    let excess = matches.len() - cap;
    Ok(matches
        .into_iter()
        .take(excess)
        .filter(|m| std::fs::remove_file(paths::match_db(&m.id)).is_ok())
        .map(|m| m.id)
        .collect())
}

/// Bytes used by match databases (and how many there are) and by settings.
pub struct StorageUsage {
    pub match_bytes: u64,
    pub match_count: usize,
    pub settings_bytes: u64,
}

pub fn storage_usage() -> StorageUsage {
    let mut usage = StorageUsage { match_bytes: 0, match_count: 0, settings_bytes: 0 };
    if let Ok(entries) = std::fs::read_dir(paths::matches_dir()) {
        for e in entries.flatten() {
            if e.path().extension().is_some_and(|x| x == "sqlite") {
                usage.match_count += 1;
                usage.match_bytes += e.metadata().map_or(0, |m| m.len());
            }
        }
    }
    usage.settings_bytes = std::fs::metadata(paths::settings_db()).map_or(0, |m| m.len());
    usage
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs against the real library when present: `cargo test -p cs2da-core -- --nocapture`.
    #[test]
    fn lists_local_matches_fast() {
        let dir = paths::matches_dir();
        if !dir.exists() {
            return;
        }
        let t = std::time::Instant::now();
        let matches = list_matches_in(&dir).unwrap();
        let list_ms = t.elapsed().as_millis();
        if let Some(first) = matches.first() {
            let t = std::time::Instant::now();
            let s = match_summary(&first.id).unwrap();
            println!(
                "listed {} matches in {list_ms} ms; summary of {} ({} players, {} rounds) in {} ms",
                matches.len(),
                first.id,
                s.players.len(),
                s.rounds.len(),
                t.elapsed().as_millis()
            );
        }
        for m in &matches {
            // Event-based totals agree with the per-player scores the parser wrote.
            let s = match_summary(&m.id).unwrap();
            let player_damage: f64 = s.players.iter().map(|p| p.team_damage).sum();
            assert!(
                (s.totals.team_damage - player_damage).abs() < 1.0,
                "{}: event damage {} vs player damage {player_damage}",
                m.id,
                s.totals.team_damage
            );
        }
    }
}
