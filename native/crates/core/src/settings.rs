use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};

use crate::paths;

/// Key/value settings, stored in the same `settings.sqlite` the Electron app uses.
pub struct Settings {
    conn: Connection,
}

impl Settings {
    pub fn open() -> Result<Self> {
        let path = paths::settings_db();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )?;
        Ok(Self { conn })
    }

    pub fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn get_or(&self, key: &str, default: &str) -> String {
        self.get(key).ok().flatten().unwrap_or_else(|| default.to_string())
    }

    pub fn get_bool(&self, key: &str, default: bool) -> bool {
        self.get(key).ok().flatten().map_or(default, |v| v == "true")
    }

    /// Watched demo folders (`demo_folders`, `|`-separated, like Electron).
    pub fn demo_folders(&self) -> Vec<String> {
        self.get_or("demo_folders", "")
            .split('|')
            .map(str::trim)
            .filter(|f| !f.is_empty())
            .map(str::to_string)
            .collect()
    }

    pub fn set_demo_folders(&self, folders: &[String]) -> Result<()> {
        self.set("demo_folders", &folders.join("|"))
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }
}
