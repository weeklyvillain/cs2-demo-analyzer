//! Usage statistics in `stats.sqlite` (key/value, integer values), same file and
//! update rules as the Electron app's `electron/stats.ts`.

use std::collections::BTreeMap;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};

use crate::paths;

const DEFAULT_KEYS: &[&str] = &[
    "total_demos_parsed",
    "total_voices_extracted",
    "largest_demo_parsed",
    "smallest_demo_parsed",
    "total_demo_size",
    "total_parsing_time_ms",
    "fastest_parsing_time_ms",
    "slowest_parsing_time_ms",
    "total_voice_extraction_ms",
    "shortest_voice_extraction_ms",
    "longest_voice_extraction_ms",
    "voice_files_generated",
];

pub struct Stats {
    conn: Connection,
}

impl Stats {
    pub fn open() -> Result<Self> {
        let path = paths::data_dir().join("stats.sqlite");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute("CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value TEXT NOT NULL)", [])?;
        for key in ["total_demos_parsed", "total_voices_extracted"] {
            conn.execute("INSERT OR IGNORE INTO stats (key, value) VALUES (?1, '0')", [key])?;
        }
        Ok(Self { conn })
    }

    pub fn get(&self, key: &str) -> i64 {
        self.conn
            .query_row("SELECT value FROM stats WHERE key = ?1", [key], |r| r.get::<_, String>(0))
            .optional()
            .ok()
            .flatten()
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0)
    }

    /// Every stat; unparsable values read as 0, like Electron's `getAllStats`.
    pub fn all(&self) -> BTreeMap<String, i64> {
        let mut out = BTreeMap::new();
        if let Ok(mut stmt) = self.conn.prepare("SELECT key, value FROM stats") {
            if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                for (k, v) in rows.flatten() {
                    out.insert(k, v.trim().parse().unwrap_or(0));
                }
            }
        }
        out
    }

    fn set(&self, key: &str, value: i64) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO stats (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value.to_string()],
        )?;
        Ok(())
    }

    pub fn increment(&self, key: &str, amount: i64) -> Result<()> {
        self.set(key, self.get(key) + amount)
    }

    pub fn increment_map_parse_count(&self, map: &str) -> Result<()> {
        if map.is_empty() {
            return Ok(());
        }
        self.increment(&format!("map_parsed_{}", map.to_lowercase()), 1)
    }

    pub fn track_demo_parsed(&self, size_bytes: i64, parse_ms: i64) -> Result<()> {
        self.increment("total_demos_parsed", 1)?;
        if size_bytes > self.get("largest_demo_parsed") {
            self.set("largest_demo_parsed", size_bytes)?;
        }
        let smallest = self.get("smallest_demo_parsed");
        if smallest == 0 || size_bytes < smallest {
            self.set("smallest_demo_parsed", size_bytes)?;
        }
        self.increment("total_demo_size", size_bytes)?;
        self.increment("total_parsing_time_ms", parse_ms)?;
        let fastest = self.get("fastest_parsing_time_ms");
        if fastest == 0 || parse_ms < fastest {
            self.set("fastest_parsing_time_ms", parse_ms)?;
        }
        if parse_ms > self.get("slowest_parsing_time_ms") {
            self.set("slowest_parsing_time_ms", parse_ms)?;
        }
        Ok(())
    }

    pub fn track_voice_extracted(&self, duration_ms: i64, file_count: i64) -> Result<()> {
        self.increment("voice_files_generated", file_count)?;
        self.increment("total_voice_extraction_ms", duration_ms)?;
        self.increment("total_voices_extracted", file_count)?;
        let shortest = self.get("shortest_voice_extraction_ms");
        if shortest == 0 || duration_ms < shortest {
            self.set("shortest_voice_extraction_ms", duration_ms)?;
        }
        if duration_ms > self.get("longest_voice_extraction_ms") {
            self.set("longest_voice_extraction_ms", duration_ms)?;
        }
        Ok(())
    }

    /// Clear everything (map counts too) and put the default keys back at 0.
    pub fn reset(&self) -> Result<()> {
        self.conn.execute("DELETE FROM stats", [])?;
        for key in DEFAULT_KEYS {
            self.set(key, 0)?;
        }
        Ok(())
    }
}
